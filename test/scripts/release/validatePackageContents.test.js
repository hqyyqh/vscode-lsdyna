'use strict';

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    REQUIRED_FILES,
    listVsixFiles,
    validatePackageFiles,
    validateStaticRuntimeDependencies,
    validateRuntimeFileIdentity,
    validatePublicBoundaryFiles,
    validateSemanticRuntimeArtifacts,
} = require("../../../scripts/release/validate-package-contents.cjs");

describe('VSIX content contract', () => {
    const createTempDirectory = require('../../support/tempDirectories').trackTempDirectories();

    it('requires a complete blocker descriptor for a packaged reference index', () => {
        const { keywordDataPath } = require('../../../out/core/keywordDataPath');
        const root = createTempDirectory(path.join(os.tmpdir(), 'dynasense-blocker-package-'));
        const relative = 'keywords/runtime/references/field_reference_index.json';
        const blocker = 'keywords/runtime/references/lspp_reference_blockers.runtime.json.gz';
        const bytes = fs.readFileSync(keywordDataPath('references/lspp_reference_blockers.runtime.json.gz'));
        assert.equal(JSON.parse(require('node:zlib').gunzipSync(bytes)).kind, 'dynasense-lspp-reference-blockers');
        const index = { lsppBlockedReferences: { file: blocker,
            sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
            compressedBytes: bytes.length } };
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, blocker), bytes);
        fs.writeFileSync(path.join(root, relative), JSON.stringify(index));
        assert.deepEqual(validateStaticRuntimeDependencies([relative, blocker], root), []);
        for (const descriptor of [undefined, {}, { file: index.lsppBlockedReferences.file },
            { ...index.lsppBlockedReferences, sha256: 'bad' },
            { ...index.lsppBlockedReferences, sha256: '' },
            { ...index.lsppBlockedReferences, file: '' },
            { ...index.lsppBlockedReferences, file: 7 },
            ...[undefined, 0, -1, '1', 1.5].map(compressedBytes =>
                ({ ...index.lsppBlockedReferences, compressedBytes }))]) {
            fs.writeFileSync(path.join(root, relative), JSON.stringify({ ...index, lsppBlockedReferences: descriptor }));
            assert.ok(validateStaticRuntimeDependencies([relative, blocker], root).some(error =>
                /reference blocker descriptor.*missing or invalid/.test(error)));
        }
        fs.writeFileSync(path.join(root, relative), JSON.stringify(index));
        assert.deepEqual(validateStaticRuntimeDependencies([relative], root),
            [`VSIX is missing reference blocker resource: ${blocker}`]);
        for (const descriptor of [{ ...index.lsppBlockedReferences, sha256: '0'.repeat(64) },
            { ...index.lsppBlockedReferences, compressedBytes: bytes.length + 1 }]) {
            fs.writeFileSync(path.join(root, relative), JSON.stringify({ lsppBlockedReferences: descriptor }));
            assert.deepEqual(validateStaticRuntimeDependencies([relative, blocker], root),
                [`VSIX reference blocker resource identity mismatch: ${blocker}`]);
        }
        fs.writeFileSync(path.join(root, relative), JSON.stringify(index));
        const corrupted = Buffer.from(bytes);
        corrupted[0] ^= 0xff;
        assert.throws(() => require('node:zlib').gunzipSync(corrupted));
        fs.writeFileSync(path.join(root, blocker), corrupted);
        assert.deepEqual(validateStaticRuntimeDependencies([relative, blocker], root),
            [`VSIX reference blocker resource identity mismatch: ${blocker}`]);
        fs.writeFileSync(path.join(root, blocker), bytes);
        assert.deepEqual(validateStaticRuntimeDependencies([relative, blocker], root), []);
    });

    const inputFormManifestPath = 'out/runtime/lspp-input-form/manifest.json';
    const inputFormManifest = JSON.parse(fs.readFileSync(
        path.join(__dirname, "../../..", inputFormManifestPath), 'utf8'));
    const inputFormShards = Object.values(inputFormManifest.shards).map(descriptor =>
        `keywords/runtime/input-form/${path.basename(descriptor.file)}`);

    it('blocks private proof paths inside gzip and Brotli payloads without rejecting proof hashes', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-package-boundary-'));
        const zlib = require('node:zlib');
        try {
            fs.mkdirSync(path.join(root, 'keywords'));
            const proof = { rules: { sample: { occurrenceGrammar: { evidence: {
                path: ['D:', 'Project', 'vscode-lsdyna', 'out', 'remaining-lspp', 'verification.json'].join('\\'),
                sha256: 'a'.repeat(64), bytes: 1234,
            } } } } };
            for (const [suffix, encode] of [['gz', zlib.gzipSync], ['br', zlib.brotliCompressSync]]) {
                const file = `keywords/fixture.json.${suffix}`;
                fs.writeFileSync(path.join(root, file), encode(Buffer.from(JSON.stringify(proof))));
                const errors = validatePublicBoundaryFiles([file], root);
                assert.equal(errors.length, 1, suffix);
                assert.match(errors[0], /private production reference.*occurrenceGrammar\.evidence\.path/);
                assert.ok(!errors[0].includes(proof.rules.sample.occurrenceGrammar.evidence.path));
                const safe = structuredClone(proof);
                delete safe.rules.sample.occurrenceGrammar.evidence.path;
                fs.writeFileSync(path.join(root, file), encode(Buffer.from(JSON.stringify(safe))));
                assert.deepEqual(validatePublicBoundaryFiles([file], root), []);
            }
        } finally {
            assert.equal(path.dirname(root), os.tmpdir());
            assert.ok(path.basename(root).startsWith('public-package-boundary-'));
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects stale or missing packaged runtime code and rules', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hover-package-identity-'));
        const installed = path.join(directory, 'installed'), workspace = path.join(directory, 'workspace');
        const files = ['out/core/reader.js', 'keywords/runtime/native-readers/readers.json'];
        try {
            for (const root of [installed, workspace]) for (const file of files) {
                fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
                fs.writeFileSync(path.join(root, file), 'current');
            }
            assert.deepEqual(validateRuntimeFileIdentity(files, installed, workspace), []);
            fs.writeFileSync(path.join(installed, files[1]), 'old');
            assert.deepEqual(validateRuntimeFileIdentity(files, installed, workspace),
                [`VSIX runtime identity differs from the tested workspace: ${files[1]}`]);
            fs.unlinkSync(path.join(installed, files[0]));
            assert.equal(validateRuntimeFileIdentity(files, installed, workspace).length, 2);
        } finally {
            assert.ok(directory.startsWith(path.join(os.tmpdir(), 'hover-package-identity-')));
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    it('requires every shard referenced by the native field-help manifest', () => {
        const manifestPath = "keywords/runtime/native-help/manifest.json";
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../..", manifestPath), 'utf8'));
        const supplementManifest = "keywords/runtime/native-help/native-null-help.manifest.json";
        const supplement = "keywords/runtime/native-help/native-null-help.json.gz";
        assert.equal(validateStaticRuntimeDependencies([manifestPath]).length,
            Object.keys(manifest.shards).length + 1);
        assert.deepEqual(validateStaticRuntimeDependencies([manifestPath,
            ...Object.values(manifest.shards).map(shard => "keywords/runtime/native-help/" + shard.file),
            supplementManifest,
            supplement]), []);
    });
    it('requires every shard referenced by the LS-PrePost input-form manifest', () => {
        assert.deepEqual(validateStaticRuntimeDependencies([
            inputFormManifestPath,
            ...inputFormShards,
        ]), []);
        const omitted = inputFormShards[0];
        assert.deepEqual(validateStaticRuntimeDependencies([
            inputFormManifestPath,
            ...inputFormShards.slice(1),
        ]), [`VSIX is missing LS-PrePost Input Form shard: ${omitted}`]);
    });
    it('binds every LS-PrePost input-form shard to its manifest identity', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'input-form-package-identity-'));
        const contentHash = 'a'.repeat(64), shard = `${contentHash}.json.gz`;
        try {
            fs.mkdirSync(path.join(root, "keywords/runtime/input-form"), { recursive: true });
            fs.mkdirSync(path.join(root, 'out/runtime/lspp-input-form'), { recursive: true });
            fs.writeFileSync(path.join(root, 'out/runtime/lspp-input-form/manifest.json'), JSON.stringify({
                shards: {
                    [contentHash]: {
                        file: `card_conditions.v4/${shard}`,
                        compressedBytes: 7,
                        sha256: 'b'.repeat(64),
                        uncompressedSha256: contentHash,
                    },
                },
            }));
            fs.writeFileSync(path.join(root, "keywords/runtime/input-form", shard), 'altered');
            assert.deepEqual(validateStaticRuntimeDependencies([
                inputFormManifestPath,
                `keywords/runtime/input-form/${shard}`,
            ], root), [
                `VSIX LS-PrePost Input Form shard identity differs from manifest: keywords/runtime/input-form/${shard}`,
            ]);
        } finally {
            assert.ok(root.startsWith(path.join(os.tmpdir(), 'input-form-package-identity-')));
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    function completeFiles() {
        return [
            ...REQUIRED_FILES,
            "keywords/runtime/structure-v2/shards/00.a6f7d8eed63bfdb2.json",
            ...inputFormShards,
            "keywords/runtime/manual-semantics/shards/00.json.gz",
            "keywords/runtime/semantic-v2/references/0.json.gz",
            "keywords/runtime/semantic-v2/options/0.json.gz",
            'out/runtime/field_help/shards/0000.json.gz',
            'out/webview/manual-reader/assets/index.js',
            'out/webview/manual-reader/assets/index.css',
            'out/webview/keyword-options/assets/index.js',
            'out/webview/keyword-options/assets/index.css',
            'out/webview/entity-references/assets/index.js',
            'out/webview/entity-references/assets/index.css',
            'out/webview/large-file-viewer/index.html',
            'out/webview/large-file-viewer/manifest.json',
            'out/webview/large-file-viewer/assets/index.js',
            'out/webview/large-file-viewer/assets/index.css',
        ];
    }

    it('accepts required runtime files without authoring sources', () => {
        assert.deepEqual(validatePackageFiles(completeFiles()), []);
    });
    it('accepts the source license name and the packaged license name', () => {
        for (const name of ['LICENSE', 'LICENSE.txt'])
            assert.deepEqual(validatePackageFiles([...completeFiles(), name]), []);
    });

    it('excludes native experiments, configuration backups and ad-hoc scripts from out', () => {
        const probes = ['out/native-section-probes/run/config-before/lsppconf',
            'out/native-hover-verification/input.k', 'out/dynamic-repair/reader.txt', 'out/probe.cjs'];
        assert.deepEqual(validatePackageFiles([...completeFiles(), ...probes]),
            probes.map(file => `VSIX contains non-runtime build output: ${file}`).sort());
    });
    it('rejects temporary development probes and logs even when packaging ignores drift', () => {
        const probes = ['tmp/f5-probe-host.cjs', 'tmp/dev-release-review/nativeReaderBindings.test.py.log',
            'tmp/keyword-refresh-help-host.log'];
        assert.deepEqual(validatePackageFiles([...completeFiles(), ...probes]),
            probes.map(file => `VSIX contains forbidden authoring/process file: ${file}`).sort());
    });
    it('requires an explicit release location for newly added workspace artifacts', () => {
        const files = ['scratch/observations.json', 'local-reader.py', 'TMP/probe.log'];
        assert.deepEqual(validatePackageFiles([...completeFiles(), ...files]),
            files.map(file => `VSIX contains an undeclared release path: ${file}`).sort());
    });

    it('rejects authoring sources, process documents, and local caches', () => {
        const errors = validatePackageFiles([
            ...completeFiles(),
            '.artifacts/push-preparation/plan.md',
            '.pytest_cache/v/cache/nodeids',
            '.tmp-worktree-admin/state.json',
            '.tmp-worktrees/local-task/process.md',
            '.uv-cache/CACHEDIR.TAG',
            'dist/dynasense.vsix',
            "keywords/runtime/schema/field_data.json",
            "keywords/authoring/field_data_zh.json",
            "keywords/authoring/native_field_help_zh.json",
            "keywords/authoring/manual_semantics_zh.json",
            "keywords/provenance/definition-registry/definition_registry.authority-lock.json",
            "keywords/provenance/definition-registry/definition_registry.build-report.json",
            "test/evidence/historical/9c8eaef2471b/root/keywords/link_census/authoring_semantic_handoff/manifest.json",
            'out/runtime/field_help_en.runtime.json.gz',
            'out/runtime/field_help_zh.delta.json.gz',
            "keywords/provenance/manual-semantics/manual_semantics.build-report.json",
            "keywords/runtime/manual-semantics/audit/candidates.json",
            "test/evidence/historical/9c8eaef2471b/root/keywords/keyword_structure_profile_approvals.json",
            "test/evidence/historical/9c8eaef2471b/root/keywords/keyword_structure_profiles.schema.json",
            "test/evidence/historical/9c8eaef2471b/root/keywords/keyword_structure_profiles.json",
            "keywords/runtime/structure-v2/source-data/approvals.json",
            "keywords/runtime/structure-v2/shards/not-content-addressed.json",
            "keywords/provenance/verification/keyword-structure-profiles.json",
            'docs/plans/release.md',
            "test/scripts/build/keywords/__pycache__/test_schema.pyc",
        ]);
        assert.deepEqual(errors, [
            'VSIX contains forbidden authoring/process file: .artifacts/push-preparation/plan.md',
            'VSIX contains forbidden authoring/process file: .pytest_cache/v/cache/nodeids',
            'VSIX contains forbidden authoring/process file: .tmp-worktree-admin/state.json',
            'VSIX contains forbidden authoring/process file: .tmp-worktrees/local-task/process.md',
            'VSIX contains forbidden authoring/process file: .uv-cache/CACHEDIR.TAG',
            'VSIX contains forbidden authoring/process file: dist/dynasense.vsix',
            'VSIX contains forbidden authoring/process file: docs/plans/release.md',
            "VSIX contains forbidden authoring/process file: keywords/provenance/definition-registry/definition_registry.authority-lock.json",
            "VSIX contains forbidden authoring/process file: keywords/provenance/definition-registry/definition_registry.build-report.json",
            "VSIX contains forbidden authoring/process file: keywords/runtime/schema/field_data.json",
            "VSIX contains forbidden authoring/process file: keywords/authoring/field_data_zh.json",
            "VSIX contains forbidden authoring/process file: test/evidence/historical/9c8eaef2471b/root/keywords/keyword_structure_profile_approvals.json",
            "VSIX contains forbidden authoring/process file: test/evidence/historical/9c8eaef2471b/root/keywords/keyword_structure_profiles.json",
            "VSIX contains forbidden authoring/process file: test/evidence/historical/9c8eaef2471b/root/keywords/keyword_structure_profiles.schema.json",
            "VSIX contains forbidden authoring/process file: keywords/provenance/manual-semantics/manual_semantics.build-report.json",
            "VSIX contains forbidden authoring/process file: keywords/authoring/manual_semantics_zh.json",
            "VSIX contains forbidden authoring/process file: keywords/authoring/native_field_help_zh.json",
            "VSIX contains forbidden authoring/process file: test/scripts/build/keywords/__pycache__/test_schema.pyc",
            "VSIX contains forbidden authoring/process file: keywords/provenance/verification/keyword-structure-profiles.json",
            'VSIX contains forbidden authoring/process file: out/runtime/field_help_en.runtime.json.gz',
            'VSIX contains forbidden authoring/process file: out/runtime/field_help_zh.delta.json.gz',
            "VSIX contains full authoring census data: test/evidence/historical/9c8eaef2471b/root/keywords/link_census/authoring_semantic_handoff/manifest.json",
            "VSIX contains non-runtime keyword structure v2 data: keywords/runtime/structure-v2/shards/not-content-addressed.json",
            "VSIX contains non-runtime keyword structure v2 data: keywords/runtime/structure-v2/source-data/approvals.json",
            "VSIX contains non-runtime manual semantic data: keywords/runtime/manual-semantics/audit/candidates.json",
        ].sort());
    });

    it('requires at least one compressed manual semantic shard', () => {
        const files = completeFiles().filter(file => !file.includes('manual-semantics/shards/'));
        assert.deepEqual(validatePackageFiles(files), [
            'VSIX is missing the manual semantic runtime shards',
        ]);
    });

    it('requires at least one content-addressed keyword structure v2 shard', () => {
        const files = completeFiles().filter(file => !file.includes('structure-v2/shards/'));
        assert.deepEqual(validatePackageFiles(files), [
            'VSIX is missing the keyword structure v2 runtime shards',
        ]);
    });

    it('requires at least one compressed field-help shard', () => {
        const files = completeFiles().filter(file => !file.includes('field_help/shards/'));
        assert.deepEqual(validatePackageFiles(files), [
            'VSIX is missing the field-help runtime shards',
        ]);
    });

    it('rejects compiled relative imports omitted from the package', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-runtime-dependencies-'));
        fs.mkdirSync(path.join(root, 'out'), { recursive: true });
        fs.writeFileSync(path.join(root, 'out', 'extension.js'),
            "require('../test/evidence/historical/9c8eaef2471b/root/keywords/required-runtime.json');\n");
        assert.deepEqual(validateStaticRuntimeDependencies(['out/extension.js'], root), [
            "VSIX is missing static runtime dependency: ../test/evidence/historical/9c8eaef2471b/root/keywords/required-runtime.json from out/extension.js",
        ]);
        assert.deepEqual(validateStaticRuntimeDependencies([
            'out/extension.js',
            "test/evidence/historical/9c8eaef2471b/root/keywords/required-runtime.json",
        ], root), []);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('rejects data-path imports omitted from the package, including compiled TypeScript calls', () => {
        const root = createTempDirectory(path.join(os.tmpdir(), 'package-data-dependencies-'));
        fs.mkdirSync(path.join(root, 'out'));
        for (const call of ['keywordDataPath', '(0, keywordDataPath_1.keywordDataPath)']) {
            fs.writeFileSync(path.join(root, 'out/extension.js'),
                `require(${call}('engineering/contactThermal.json'));`);
            assert.deepEqual(validateStaticRuntimeDependencies(['out/extension.js'], root), [
                'VSIX is missing keyword runtime dependency: engineering/contactThermal.json from out/extension.js',
            ]);
            assert.deepEqual(validateStaticRuntimeDependencies([
                'out/extension.js', 'keywords/runtime/engineering/contactThermal.json',
            ], root), []);
        }
    });

    it('fully validates every semantic runtime shard before packaging', function () {
        this.timeout(15_000);
        const source = path.resolve(__dirname, '../../../keywords/runtime/semantic-v2');
        assert.deepEqual(validateSemanticRuntimeArtifacts(source), []);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-package-validation-'));
        fs.cpSync(source, root, { recursive: true });
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
        const file = path.join(root, manifest.optionShards.at(-1).path);
        const corrupted = fs.readFileSync(file);
        corrupted[0] ^= 0xff;
        fs.writeFileSync(file, corrupted);
        const errors = validateSemanticRuntimeArtifacts(root);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /semantic runtime validation failed:.*compressed drift/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    it('checks entries of the actual ZIP, including a leaked temporary sentinel', function () {
        this.timeout(10000);
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-vsix-'));
        try {
            const vsix = path.join(dir, 'fixture.vsix');
            require('child_process').execFileSync(process.env.PYTHON || 'python', [
                '-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); [z.writestr("extension/"+p, "") for p in json.loads(sys.argv[2])]; z.close()',
                vsix, JSON.stringify([...completeFiles(), 'tmp/release-sentinel.cjs']),
            ], { windowsHide: true });
            assert.deepEqual(validatePackageFiles(listVsixFiles(vsix)), [
                'VSIX contains forbidden authoring/process file: tmp/release-sentinel.cjs',
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
