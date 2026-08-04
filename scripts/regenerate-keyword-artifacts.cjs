'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const childProcess = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANUAL_KEYWORD_CLASSES = path.join(
    'src', 'ansys', 'dyna', 'core', 'keywords', 'keyword_classes', 'manual'
);
const ARTIFACTS = [
    { staging: 'lsdyna.json', destination: path.join('snippets', 'lsdyna.json') },
    { staging: 'field_data.json', destination: path.join('keywords', 'field_data.json') },
    { staging: 'field_reference_index.json', destination: path.join('keywords', 'field_reference_index.json') },
    { staging: 'pydyna-source.json', destination: path.join('keywords', 'pydyna-source.json') },
];
const GENERATION_TOOLS = [
    path.join('scripts', 'regenerate-keyword-artifacts.cjs'),
    path.join('keywords', 'generate_from_pydyna.py'),
    path.join('keywords', 'pydyna_schema_adapter.py'),
    path.join('scripts', 'patch-mat-add-erosion-damage-fields.cjs'),
    path.join('scripts', 'generate-field-reference-index.cjs'),
];
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const EXPECTED_UPSTREAM_REPOSITORY = 'ansys/pydyna';
const COMPATIBILITY_ALIASES = {
    retained: [],
    removed: [
        'CONTROL_TIMESTEP:CONTROL_TIME_STEP',
        'MAT_034:MAT_FABRIC',
        'MAT_058:MAT_LAMINATED_COMPOSITE_FABRIC',
        'MAT_058_SOLID:MAT_LAMINATED_COMPOSITE_FABRIC_SOLID',
        'MAT_077_H:MAT_HYPERELASTIC_RUBBER',
        'MAT_077_O:MAT_OGDEN_RUBBER',
        'MAT_MODIFIED_JOHNSON_COOK:MAT_107',
        'MAT_124:MAT_PLASTICITY_COMPRESSION_TENSION',
        'MAT_181:MAT_SIMPLIFIED_RUBBER/FOAM',
        'MAT_138:MAT_COHESIVE_MIXED_MODE',
        'MAT_196:MAT_GENERAL_SPRING_DISCRETE_BEAM',
        'MAT_023:MAT_TEMPERATURE_DEPENDENT_ORTHOTROPIC',
        'MAT_295:MAT_ANISOTROPIC_HYPERELASTIC',
        'SET_NODE_LIST:SET_NODE',
        'SET_PART_LIST:SET_PART',
    ].sort(),
};

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Directory(directory) {
    const files = [];
    function visit(current) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                visit(entryPath);
            } else if (entry.isFile()) {
                files.push(path.relative(directory, entryPath).split(path.sep).join('/'));
            }
        }
    }
    visit(directory);
    const digest = crypto.createHash('sha256');
    for (const relativePath of files.sort()) {
        digest.update(relativePath);
        digest.update('\0');
        digest.update(sha256File(path.join(directory, relativePath)));
        digest.update('\n');
    }
    return digest.digest('hex');
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`Invalid JSON at ${filePath}: ${error.message}`);
    }
}

function validateField(field, context) {
    if (!field || typeof field !== 'object' ||
        typeof field.n !== 'string' || typeof field.p !== 'number' ||
        typeof field.w !== 'number' || field.w < 0 || typeof field.t !== 'string') {
        throw new Error(`Invalid field schema at ${context}`);
    }
}

function fieldsMatch(left, right) {
    return left.n === right.n && left.p === right.p && left.w === right.w && left.t === right.t;
}

function validateSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new Error('English field data must be an object');
    }
    let textCards = 0;
    let overlappingFixedWidthFields = 0;
    for (const [keyword, entry] of Object.entries(schema)) {
        if (!entry || !Array.isArray(entry.c)) {
            throw new Error(`Invalid cards for ${keyword}`);
        }
        const textCardSignatures = entry.tc || [];
        if (!Array.isArray(textCardSignatures)) {
            throw new Error(`Invalid text-card metadata for ${keyword}`);
        }
        for (const signature of textCardSignatures) {
            if (!signature || typeof signature.name !== 'string' || !signature.name.trim() ||
                !Array.isArray(signature.f) || !signature.f.length) {
                throw new Error(`Invalid text-card signature for ${keyword}`);
            }
            for (const field of signature.f) {
                validateField(field, `${keyword}.tc`);
            }
            const matchingCards = entry.c.filter(card =>
                Array.isArray(card) && card.length === signature.f.length &&
                signature.f.every((signatureField, index) => fieldsMatch(card[index], signatureField))
            );
            if (matchingCards.length !== 1) {
                throw new Error(`Text-card signature does not uniquely match cards for ${keyword}`);
            }
            textCards++;
        }
        for (const [cardIndex, card] of entry.c.entries()) {
            if (!Array.isArray(card)) {
                throw new Error(`Invalid card ${cardIndex + 1} for ${keyword}`);
            }
            const isTextCard = textCardSignatures.some(signature =>
                card.length === signature.f.length &&
                signature.f.every((signatureField, index) => fieldsMatch(card[index], signatureField))
            );
            const ranges = [];
            for (const field of card) {
                validateField(field, `${keyword}.c[${cardIndex}]`);
                if (!isTextCard && field.w > 0) {
                    ranges.push([field.p, field.p + field.w]);
                }
            }
            ranges.sort((left, right) => left[0] - right[0]);
            for (let index = 1; index < ranges.length; index++) {
                if (ranges[index][0] < ranges[index - 1][1]) {
                    overlappingFixedWidthFields++;
                }
            }
        }
    }
    return { fieldEntries: Object.keys(schema).length, textCards, overlappingFixedWidthFields };
}

function validateSnippets(snippets, schema) {
    if (!snippets || typeof snippets !== 'object' || Array.isArray(snippets)) {
        throw new Error('Snippets must be an object');
    }
    for (const keyword of Object.keys(schema)) {
        if (!Object.hasOwn(snippets, `*${keyword}`)) {
            throw new Error(`Missing canonical snippet for ${keyword}`);
        }
    }
    for (const [key, snippet] of Object.entries(snippets)) {
        const prefixes = Array.isArray(snippet && snippet.prefix)
            ? snippet.prefix
            : [snippet && snippet.prefix];
        if (!key.startsWith('*') || !snippet || !Array.isArray(snippet.body) ||
            snippet.body.length === 0 || !prefixes.includes(snippet.body[0])) {
            throw new Error(`Invalid snippet for ${key}`);
        }
        for (const line of snippet.body) {
            if (typeof line !== 'string') {
                throw new Error(`Invalid snippet line for ${key}`);
            }
            const placeholders = line.match(/\$\{(?:0|[1-9]\d*)(?::[^}]*)?\}/g) || [];
            const placeholderStarts = line.match(/\$\{/g) || [];
            if (placeholders.length !== placeholderStarts.length) {
                throw new Error(`Invalid snippet placeholder syntax for ${key}`);
            }
        }
    }
    return { snippets: Object.keys(snippets).length };
}

function validateReferenceIndex(index, schema) {
    if (!index || index.schemaVersion !== 1 ||
        !index.generatedFrom || index.generatedFrom.fieldData !== 'keywords/field_data.json' ||
        !index.references || typeof index.references !== 'object' ||
        !index.definitionKeywords || typeof index.definitionKeywords !== 'object') {
        throw new Error('Invalid field reference index');
    }
    const generic = index.definitionKeywords.generic || {};
    const safeTargets = new Set();
    for (const [keyword, descriptor] of Object.entries(generic)) {
        const entry = schema[keyword];
        const targetEntry = descriptor && schema[descriptor.target];
        const canonical = entry && String(entry.x || keyword).toUpperCase();
        if (!entry || !targetEntry || canonical !== descriptor.target ||
            !Number.isInteger(descriptor.cardIndex) || descriptor.cardIndex < 1 ||
            !Number.isInteger(descriptor.fieldIndex) || descriptor.fieldIndex < 0 ||
            typeof descriptor.fieldName !== 'string' || descriptor.fieldType !== 'integer' ||
            typeof descriptor.position !== 'number' || typeof descriptor.width !== 'number') {
            throw new Error(`Invalid generic definition descriptor for ${keyword}`);
        }
        safeTargets.add(descriptor.target);
    }
    for (const [keyword, rules] of Object.entries(index.references)) {
        if (!rules || typeof rules !== 'object') {
            throw new Error(`Invalid reference rules for ${keyword}`);
        }
        for (const rule of Object.values(rules)) {
            for (const target of rule.targetDefinitions || []) {
                if (!safeTargets.has(target)) {
                    throw new Error(`Unsafe generic definition target ${target} in ${keyword}`);
                }
            }
        }
    }
    return { referenceKeywords: Object.keys(index.references).length };
}

function generatedAliases(schema) {
    const aliases = [];
    const addPair = (left, right) => {
        const normalizedLeft = String(left || '').toUpperCase();
        const normalizedRight = String(right || '').toUpperCase();
        if (normalizedLeft && normalizedRight && normalizedLeft !== normalizedRight) {
            aliases.push(`${normalizedLeft}:${normalizedRight}`);
        }
    };
    for (const [keyword, entry] of Object.entries(schema)) {
        const canonical = entry.x ? String(entry.x).toUpperCase() : keyword.toUpperCase();
        for (const alias of entry.a || []) {
            addPair(canonical, alias);
        }
        if (entry.x) {
            addPair(canonical, keyword);
        }
    }
    return [...new Set(aliases)].sort();
}

function aliasPairKey(pair) {
    return pair.split(':').map(value => value.toUpperCase()).sort().join(':');
}

function validateCompatibilityAliases(schema) {
    const generated = generatedAliases(schema);
    const generatedPairs = new Set(generated.map(aliasPairKey));
    const schemaNames = new Set(Object.keys(schema).map(keyword => keyword.toUpperCase()));
    for (const pair of COMPATIBILITY_ALIASES.removed) {
        const [left, right] = pair.split(':');
        if (!schemaNames.has(left) && !schemaNames.has(right)) {
            continue;
        }
        if (!generatedPairs.has(aliasPairKey(pair))) {
            throw new Error(`Removed compatibility alias is not supplied by generated schema: ${pair}`);
        }
    }
    for (const pair of COMPATIBILITY_ALIASES.retained) {
        const [left, right] = pair.split(':');
        const conflicting = generated.find(candidate => {
            const [generatedLeft, generatedRight] = candidate.split(':');
            return [generatedLeft, generatedRight].includes(left) &&
                ![generatedLeft, generatedRight].includes(right);
        });
        if (conflicting) {
            throw new Error(`Retained compatibility alias conflicts with generated schema: ${pair} vs ${conflicting}`);
        }
    }
    return {
        retained: [...COMPATIBILITY_ALIASES.retained],
        removed: [...COMPATIBILITY_ALIASES.removed],
        generated,
    };
}

function defaultRun(command, args, cwd) {
    const result = childProcess.spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        stdio: 'inherit',
        shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} failed with exit code ${result.status}`);
    }
}

function defaultOutput(command, args, cwd) {
    const result = childProcess.spawnSync(command, args, { cwd, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        throw new Error(`Unable to run ${command} ${args.join(' ')}`);
    }
    return `${result.stdout}${result.stderr}`.trim();
}

function normalizeRepositoryIdentity(remoteUrl) {
    const normalized = String(remoteUrl || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\.git\/?$/i, '')
        .replace(/^git@github\.com:/i, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/');
    const match = normalized.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/?$/i);
    return match ? match[1].toLowerCase() : '';
}

function inspectSource(options, dependencies) {
    if (dependencies.sourceMetadata) {
        return typeof dependencies.sourceMetadata === 'function'
            ? dependencies.sourceMetadata(options)
            : dependencies.sourceMetadata;
    }
    const output = dependencies.gitOutput || defaultOutput;
    const expectedRoot = path.resolve(options.codegenDir, '..');
    return {
        root: path.resolve(output('git', ['rev-parse', '--show-toplevel'], expectedRoot)),
        head: output('git', ['rev-parse', 'HEAD'], expectedRoot),
        status: output('git', ['status', '--porcelain'], expectedRoot),
        origin: output('git', ['remote', 'get-url', 'origin'], expectedRoot),
    };
}

function validateSource(options, dependencies) {
    const source = inspectSource(options, dependencies);
    const expectedRoot = path.resolve(options.codegenDir, '..');
    if (path.resolve(source.root) !== expectedRoot) {
        throw new Error(`PyDYNA codegen directory is not directly inside its Git root: ${options.codegenDir}`);
    }
    if (String(source.head).trim().toLowerCase() !== options.pydynaCommit.toLowerCase()) {
        throw new Error(
            `PyDYNA HEAD ${String(source.head).trim()} does not match --pydyna-commit ${options.pydynaCommit}`
        );
    }
    if (String(source.status).trim()) {
        throw new Error('PyDYNA source worktree is not clean');
    }
    if (normalizeRepositoryIdentity(source.origin) !== EXPECTED_UPSTREAM_REPOSITORY) {
        throw new Error(`Unexpected PyDYNA origin: ${source.origin}`);
    }
    return source;
}

function ensureSourceInputs(codegenDir) {
    const required = [
        path.join(codegenDir, 'kwd.json'),
        path.join(codegenDir, 'manifest.json'),
        path.join(codegenDir, 'additional-cards.json'),
        path.join(codegenDir, '..', MANUAL_KEYWORD_CLASSES),
    ];
    for (const requiredPath of required) {
        if (!fs.existsSync(requiredPath)) {
            throw new Error(`Missing required PyDYNA input: ${path.resolve(requiredPath)}`);
        }
    }
}

function stagePaths(stagingDir) {
    return {
        snippets: path.join(stagingDir, 'lsdyna.json'),
        fields: path.join(stagingDir, 'field_data.json'),
        referenceIndex: path.join(stagingDir, 'field_reference_index.json'),
        stats: path.join(stagingDir, 'generator-stats.json'),
        provenance: path.join(stagingDir, 'pydyna-source.json'),
    };
}

function inputHashes(codegenDir) {
    return {
        kwd: sha256File(path.join(codegenDir, 'kwd.json')),
        manifest: sha256File(path.join(codegenDir, 'manifest.json')),
        additionalCards: sha256File(path.join(codegenDir, 'additional-cards.json')),
        manualKeywordClasses: sha256Directory(path.resolve(codegenDir, '..', MANUAL_KEYWORD_CLASSES)),
    };
}

function generationToolHashes(repoRoot) {
    return Object.fromEntries(GENERATION_TOOLS.map(relativePath => [
        relativePath.split(path.sep).join('/'),
        sha256File(path.join(repoRoot, relativePath)),
    ]));
}

function buildProvenance(options, sourceHashes, toolHashes, environment, stats, schema, snippets, referenceIndex, matAddErosionSource) {
    const compatibilityAliases = validateCompatibilityAliases(schema);
    return {
        schemaVersion: 2,
        upstream: {
            repository: 'ansys/pydyna',
            reference: 'origin/feat/new-kwd',
            commit: options.pydynaCommit,
        },
        inputs: {
            codegenDir: 'codegen',
            kwd: 'codegen/kwd.json',
            manifest: 'codegen/manifest.json',
            additionalCards: 'codegen/additional-cards.json',
            manualKeywordClasses: MANUAL_KEYWORD_CLASSES.split(path.sep).join('/'),
        },
        generation: {
            command: `node scripts/regenerate-keyword-artifacts.cjs --codegen-dir <pydyna-root>/codegen --pydyna-commit ${options.pydynaCommit}`,
            orchestrator: 'scripts/regenerate-keyword-artifacts.cjs',
            generator: 'keywords/generate_from_pydyna.py',
            matAddErosionSource,
        },
        stats: {
            kwdKeywords: stats.kwd_keywords,
            items: stats.items,
            skipped: stats.skipped,
            aliases: stats.aliases,
            manualOverrides: stats.manual_overrides,
            manualRowLoops: stats.manual_row_loops ?? 0,
            optionEnabled: stats.option_enabled,
            titleVariants: stats.title_variants,
            fieldEntries: Object.keys(schema).length,
            snippets: Object.keys(snippets).length,
            textCards: validateSchema(schema).textCards,
            overlappingFixedWidthFields: validateSchema(schema).overlappingFixedWidthFields,
            referenceKeywords: Object.keys(referenceIndex.references).length,
        },
        compatibilityAliases,
        integrity: {
            pythonVersion: environment.python,
            nodeVersion: environment.node,
            inputSha256: sourceHashes,
            toolSha256: toolHashes,
            artifactSha256: {},
        },
    };
}

function validateStaging(stagingDir, options, dependencies, matAddErosionSource) {
    const files = stagePaths(stagingDir);
    const schema = readJson(files.fields);
    const snippets = readJson(files.snippets);
    const referenceIndex = readJson(files.referenceIndex);
    const stats = readJson(files.stats);
    const schemaStats = validateSchema(schema);
    const snippetStats = validateSnippets(snippets, schema);
    const referenceStats = validateReferenceIndex(referenceIndex, schema);
    const sourceHashes = dependencies.inputHashes || inputHashes(options.codegenDir);
    const toolHashes = dependencies.toolHashes || generationToolHashes(options.repoRoot);
    const environment = dependencies.versions || {
        python: (dependencies.output || defaultOutput)(dependencies.pythonCommand || process.env.PYTHON || 'python', ['--version'], options.repoRoot),
        node: (dependencies.output || defaultOutput)(process.execPath, ['--version'], options.repoRoot),
    };
    const provenance = buildProvenance(
        options, sourceHashes, toolHashes, environment, stats, schema, snippets, referenceIndex, matAddErosionSource
    );
    provenance.integrity.artifactSha256 = {
        'snippets/lsdyna.json': sha256File(files.snippets),
        'keywords/field_data.json': sha256File(files.fields),
        'keywords/field_reference_index.json': sha256File(files.referenceIndex),
    };
    fs.writeFileSync(files.provenance, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
    return {
        hashes: provenance.integrity.artifactSha256,
        stats: { ...provenance.stats, ...schemaStats, ...snippetStats, ...referenceStats },
        provenance,
    };
}

function runPipeline(options, dependencies, stagingDir) {
    fs.mkdirSync(stagingDir, { recursive: true });
    const files = stagePaths(stagingDir);
    const run = dependencies.run || defaultRun;
    const python = dependencies.pythonCommand || process.env.PYTHON || 'python';
    run(python, [
        path.join(options.repoRoot, 'keywords', 'generate_from_pydyna.py'),
        '--codegen-dir', options.codegenDir,
        '--output-snippets', files.snippets,
        '--output-fields', files.fields,
        '--stats-file', files.stats,
    ], options.repoRoot);

    const rawSchema = readJson(files.fields);
    const matAddErosionSource = Object.hasOwn(rawSchema, 'MAT_ADD_EROSION')
        ? 'upstream'
        : 'compatibility-patch';
    if (matAddErosionSource === 'compatibility-patch') {
        run(dependencies.patchCommand || process.execPath, [
            ...(dependencies.patchCommand ? [] : [path.join(options.repoRoot, 'scripts', 'patch-mat-add-erosion-damage-fields.cjs')]),
            '--field-data', files.fields,
            '--snippets', files.snippets,
        ], options.repoRoot);
    }

    run(
        dependencies.compileCommand || NPM_COMMAND,
        dependencies.compileCommand ? [] : ['exec', '--', 'tsc', '-p', '.'],
        options.repoRoot
    );
    run(dependencies.indexCommand || process.execPath, [
        ...(dependencies.indexCommand ? [] : [path.join(options.repoRoot, 'scripts', 'generate-field-reference-index.cjs')]),
        '--field-data', files.fields,
        '--output', files.referenceIndex,
    ], options.repoRoot);
    return validateStaging(stagingDir, options, dependencies, matAddErosionSource);
}

function replaceFile(source, destination) {
    const temporary = `${destination}.pydyna-publish-${process.pid}`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
        fs.copyFileSync(source, temporary);
        fs.renameSync(temporary, destination);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function publish(stagingDir, repoRoot) {
    const backups = [];
    try {
        for (const artifact of ARTIFACTS) {
            const destination = path.join(repoRoot, artifact.destination);
            const backup = `${destination}.pydyna-backup-${process.pid}`;
            const existed = fs.existsSync(destination);
            if (existed) {
                fs.copyFileSync(destination, backup);
            }
            backups.push({ destination, backup, existed });
            replaceFile(path.join(stagingDir, artifact.staging), destination);
        }
    } catch (error) {
        for (const { destination, backup, existed } of backups.reverse()) {
            if (existed && fs.existsSync(backup)) {
                replaceFile(backup, destination);
            } else if (!existed) {
                fs.rmSync(destination, { force: true });
            }
        }
        throw new Error(`Artifact publish failed and restored previous files: ${error.message}`);
    } finally {
        for (const { backup } of backups) {
            fs.rmSync(backup, { force: true });
        }
    }
    return ARTIFACTS.map(artifact => path.join(repoRoot, artifact.destination));
}

function normalizeOptions(rawOptions) {
    if (!rawOptions.codegenDir) {
        throw new Error('--codegen-dir is required');
    }
    if (!rawOptions.pydynaCommit) {
        throw new Error('--pydyna-commit is required');
    }
    return {
        repoRoot: path.resolve(rawOptions.repoRoot || REPO_ROOT),
        codegenDir: path.resolve(rawOptions.codegenDir),
        pydynaCommit: rawOptions.pydynaCommit,
        stagingDir: rawOptions.stagingDir
            ? path.resolve(rawOptions.stagingDir)
            : fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-lsdyna-keyword-artifacts-')),
        cleanupStaging: !rawOptions.stagingDir,
    };
}

function regenerateKeywordArtifacts(rawOptions, dependencies = {}) {
    const options = normalizeOptions(rawOptions);
    try {
        ensureSourceInputs(options.codegenDir);
        validateSource(options, dependencies);
        const report = runPipeline(options, dependencies, options.stagingDir);
        const published = publish(options.stagingDir, options.repoRoot);
        return { ...report, published };
    } finally {
        if (options.cleanupStaging) {
            fs.rmSync(options.stagingDir, { recursive: true, force: true });
        }
    }
}

function verifyDeterminism(rawOptions, dependencies = {}) {
    const options = normalizeOptions(rawOptions);
    try {
        ensureSourceInputs(options.codegenDir);
        validateSource(options, dependencies);
        const first = runPipeline(options, dependencies, path.join(options.stagingDir, 'first'));
        const second = runPipeline(options, dependencies, path.join(options.stagingDir, 'second'));
        if (JSON.stringify(first.hashes) !== JSON.stringify(second.hashes) ||
            JSON.stringify(first.stats) !== JSON.stringify(second.stats) ||
            JSON.stringify(first.provenance) !== JSON.stringify(second.provenance)) {
            throw new Error('Determinism verification failed; staged artifacts were not published');
        }
        return first;
    } finally {
        if (options.cleanupStaging) {
            fs.rmSync(options.stagingDir, { recursive: true, force: true });
        }
    }
}

function main() {
    const { values } = parseArgs({
        options: {
            'codegen-dir': { type: 'string' },
            'pydyna-commit': { type: 'string' },
            'staging-dir': { type: 'string' },
            'verify-determinism': { type: 'boolean', default: false },
        },
    });
    if (!values['codegen-dir']) {
        throw new Error('--codegen-dir is required');
    }
    const options = {
        codegenDir: values['codegen-dir'],
        pydynaCommit: values['pydyna-commit'],
        stagingDir: values['staging-dir'],
    };
    const report = values['verify-determinism']
        ? verifyDeterminism(options)
        : regenerateKeywordArtifacts(options);
    console.log(`MAT_ADD_EROSION source: ${report.provenance.generation.matAddErosionSource}`);
    console.log(`Generated ${report.stats.fieldEntries} English schema entries, ${report.stats.snippets} snippets, and ${report.stats.referenceKeywords} reference keywords.`);
}

if (require.main === module) {
    main();
}

module.exports = {
    regenerateKeywordArtifacts,
    verifyDeterminism,
    validateSchema,
    validateSnippets,
};
