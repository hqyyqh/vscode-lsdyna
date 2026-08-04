'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    regenerateKeywordArtifacts,
    validateSchema,
    verifyDeterminism,
} = require('../../scripts/regenerate-keyword-artifacts.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');

function makeFixtureRoot() {
    return fs.mkdtempSync(path.join(repoRoot, 'test', '.keyword-artifacts-'));
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

function writeArtifacts(stagingDir, matAddErosionState = 'upstream-complete') {
    const fieldData = {
        MAT_ADD_EROSION: {
            c: [[{ n: 'ID', p: 0, w: 10, t: 'integer', h: 'Identifier.' }]],
        },
        SAMPLE: {
            c: [[{ n: 'ID', p: 0, w: 10, t: 'integer', h: 'Identifier.' }]],
        },
    };
    const snippets = Object.fromEntries(Object.keys(fieldData).map(keyword => [
        `*${keyword}`,
        { prefix: `*${keyword}`, body: [`*${keyword}`, '${1:ID}', '$0'] },
    ]));
    writeJson(path.join(stagingDir, 'field_data.json'), fieldData);
    writeJson(path.join(stagingDir, 'lsdyna.json'), snippets);
    writeJson(path.join(stagingDir, 'field_reference_index.json'), {
        schemaVersion: 1,
        generatedFrom: { fieldData: 'keywords/field_data.json' },
        definitionKeywords: {},
        references: {},
    });
    writeJson(path.join(stagingDir, 'generator-stats.json'), {
        kwd_keywords: 1,
        items: 1,
        skipped: 0,
        aliases: 0,
        manual_overrides: 0,
        manual_row_loops: 3,
        option_enabled: 0,
        title_variants: 0,
        mat_add_erosion_compatibility: matAddErosionState,
        field_entries: Object.keys(fieldData).length,
        snippets: Object.keys(snippets).length,
    });
}

function createDependencies(calls, matAddErosionState, options = {}) {
    return {
        run(command, args) {
            calls.push(command);
            if (command === 'python') {
                const fields = args[args.indexOf('--output-fields') + 1];
                if (options.onStaging) options.onStaging(path.dirname(fields));
                writeArtifacts(path.dirname(fields), matAddErosionState);
                if (options.invalidGenerated) {
                    fs.writeFileSync(fields, '{', 'utf8');
                }
            }
        },
        pythonCommand: 'python',
        indexCommand: 'index',
        compileCommand: 'compile',
        versions: { python: 'Python fixture', node: 'vfixture' },
        inputHashes: {
            kwd: 'kwd',
            manifest: 'manifest',
            additionalCards: 'additional',
            manualKeywordClasses: 'manual',
        },
        toolHashes: {
            'scripts/regenerate-keyword-artifacts.cjs': 'orchestrator',
            'keywords/generate_from_pydyna.py': 'generator',
            'keywords/pydyna_schema_adapter.py': 'adapter',
            'keywords/compatibility/mat_add_erosion_legacy_fields.json': 'overlay',
            'scripts/generate-field-reference-index.cjs': 'index',
        },
        sourceMetadata(pipelineOptions) {
            return {
                root: path.resolve(pipelineOptions.codegenDir, '..'),
                head: options.sourceHead || pipelineOptions.pydynaCommit,
                status: options.sourceStatus || '',
                origin: options.sourceOrigin || 'https://github.com/ansys/pydyna.git',
            };
        },
    };
}

function makeOptions(root, stagingDir) {
    const codegenDir = path.join(root, 'source', 'codegen');
    fs.mkdirSync(codegenDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'source', 'src', 'ansys', 'dyna', 'core', 'keywords', 'keyword_classes', 'manual'), { recursive: true });
    for (const file of ['kwd.json', 'manifest.json', 'additional-cards.json']) {
        fs.writeFileSync(path.join(codegenDir, file), '{}', { encoding: 'utf8', flag: 'a' });
    }
    writeJson(
        path.join(root, 'published', 'keywords', 'compatibility', 'mat_add_erosion_legacy_fields.json'),
        { id: 'mat-add-erosion-legacy-damage-fields', version: 1 },
    );
    return {
        codegenDir,
        pydynaCommit: 'fixture-commit',
        stagingDir,
        repoRoot: path.join(root, 'published'),
    };
}

describe('keyword artifact regeneration', () => {
    let root;

    beforeEach(() => {
        root = makeFixtureRoot();
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('records an upstream-complete MAT_ADD_EROSION schema', () => {
        const calls = [];
        const options = makeOptions(root, path.join(root, 'stage'));

        regenerateKeywordArtifacts(options, createDependencies(calls, 'upstream-complete'));

        assert.deepEqual(calls, ['python', 'compile', 'index']);
        const schema = JSON.parse(fs.readFileSync(path.join(options.repoRoot, 'keywords', 'field_data.json'), 'utf8'));
        assert.equal(schema.MAT_ADD_EROSION.c[0][0].h, 'Identifier.');
        const provenance = JSON.parse(fs.readFileSync(path.join(options.repoRoot, 'keywords', 'pydyna-source.json'), 'utf8'));
        assert.equal(provenance.generation.matAddErosionSource, 'upstream-complete');
        assert.equal(provenance.generation.compatibilityOverlays[0].state, 'upstream-complete');
        assert.equal(provenance.stats.manualRowLoops, 3);
        assert.equal(provenance.compatibilityAliases.retained.length, 0);
        assert.equal(provenance.compatibilityAliases.removed.length, 15);
        assert.equal(provenance.compatibilityAliases.generated.some(pair => {
            const [left, right] = pair.split(':');
            return left === right;
        }), false);
        assert.equal(provenance.schemaVersion, 3);
        assert.equal(provenance.upstream.reference, 'origin/feat/new-kwd');
        assert.equal(provenance.generation.command.includes(options.codegenDir), false);
        assert.equal(provenance.generation.command.includes('<pydyna-root>/codegen'), true);
        assert.equal(provenance.integrity.toolSha256['keywords/pydyna_schema_adapter.py'], 'adapter');
    });

    it('records a MAT_ADD_EROSION compatibility overlay applied by the schema generator', () => {
        const calls = [];
        const options = makeOptions(root, path.join(root, 'stage'));

        regenerateKeywordArtifacts(options, createDependencies(calls, 'compatibility-overlay'));

        assert.deepEqual(calls, ['python', 'compile', 'index']);
        const provenance = JSON.parse(fs.readFileSync(path.join(options.repoRoot, 'keywords', 'pydyna-source.json'), 'utf8'));
        assert.equal(provenance.generation.matAddErosionSource, 'compatibility-overlay');
        assert.equal(provenance.generation.compatibilityOverlays[0].state, 'compatibility-overlay');
    });

    it('does not publish staged artifacts when validation fails', () => {
        const calls = [];
        const options = makeOptions(root, path.join(root, 'stage'));
        const destination = path.join(options.repoRoot, 'keywords', 'field_data.json');
        writeJson(destination, { ORIGINAL: true });
        const dependencies = createDependencies(calls, 'upstream-complete', { invalidGenerated: true });

        assert.throws(() => regenerateKeywordArtifacts(options, dependencies), /Invalid JSON/);
        assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), { ORIGINAL: true });
    });

    it('does not publish artifacts while verifying determinism', () => {
        const calls = [];
        const options = makeOptions(root, path.join(root, 'stage'));

        verifyDeterminism(options, createDependencies(calls, 'upstream-complete'));

        assert.deepEqual(calls, ['python', 'compile', 'index', 'python', 'compile', 'index']);
        assert.equal(fs.existsSync(path.join(options.repoRoot, 'keywords', 'field_data.json')), false);
    });

    it('rejects a source whose HEAD, worktree, or origin does not match provenance', () => {
        for (const dependencyOptions of [
            { sourceHead: 'different-commit' },
            { sourceStatus: ' M codegen/kwd.json' },
            { sourceOrigin: 'https://github.com/example/pydyna.git' },
        ]) {
            const calls = [];
            const options = makeOptions(root, path.join(root, `stage-${calls.length}-${Object.keys(dependencyOptions)[0]}`));
            assert.throws(
                () => regenerateKeywordArtifacts(options, createDependencies(calls, 'upstream-complete', dependencyOptions)),
                /does not match|not clean|Unexpected PyDYNA origin/
            );
            assert.deepEqual(calls, []);
        }
    });

    it('cleans an automatically allocated staging directory', () => {
        const calls = [];
        const stagedDirectories = [];
        const options = makeOptions(root, path.join(root, 'unused-explicit-stage'));
        delete options.stagingDir;

        regenerateKeywordArtifacts(options, createDependencies(calls, 'upstream-complete', {
            onStaging: stagingDir => stagedDirectories.push(stagingDir),
        }));

        assert.equal(stagedDirectories.length, 1);
        assert.equal(fs.existsSync(stagedDirectories[0]), false);
    });

    it('removes newly published files when a later artifact cannot be published', () => {
        const calls = [];
        const options = makeOptions(root, path.join(root, 'stage'));
        const failingDestination = path.join(options.repoRoot, 'keywords', 'field_data.json');
        fs.mkdirSync(failingDestination, { recursive: true });

        assert.throws(
            () => regenerateKeywordArtifacts(options, createDependencies(calls, 'upstream-complete')),
            /Artifact publish failed and restored previous files/
        );
        assert.equal(fs.existsSync(path.join(options.repoRoot, 'snippets', 'lsdyna.json')), false);
    });

    it('requires text-card signatures to match an entire card in field order', () => {
        const field = { n: 'TEXT', p: 0, w: 80, t: 'string' };
        const schema = {
            COMMENT: {
                c: [[field, { n: 'EXTRA', p: 80, w: 1, t: 'string' }]],
                tc: [{ name: 'text', f: [field] }],
            },
        };

        assert.throws(() => validateSchema(schema), /Text-card signature does not uniquely match cards/);
    });
});
