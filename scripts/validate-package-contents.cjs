'use strict';

const childProcess = require('child_process');
const path = require('path');
const { releasePath, authoringPath } = require('./release-resource-paths.cjs');

const REQUIRED_FILES = [
    'package.json',
    'out/extension.js',
    'out/runtime/field_schema.runtime.json.gz',
    'out/runtime/field_help/manifest.json',
    'out/runtime/field_help/text-index.json.gz',
    'keywords/field_reference_index.json',
    'keywords/lspp_reference_blockers.runtime.json.gz',
    'keywords/keyword_category_crosswalk.json',
    'keywords/lspp_keyword_categories.runtime.json',
    'out/runtime/lspp-input-form/manifest.json',
    'keywords/keyword_prefix_layouts.json',
    'keywords/lspp-section-fixed-readers.json',
    'keywords/lspp-generic-file-readers.json',
    'keywords/lspp-conditional-layout-readers.json',
    'keywords/lspp-optional-form-header-readers.json',
    'keywords/lspp-single-card-readers.json',
    'keywords/lspp-standard-repeat-readers.json',
    'keywords/lspp-tail-repeat-readers.json',
    'keywords/lspp-occurrence-readers.json',
    'keywords/lspp-optional-tail-readers.json',
    'keywords/lspp-eos-special-readers.json',
    'keywords/lspp-ordinal-file-readers.json',
    'keywords/lspp-batch-fixed-readers.json',
    'keywords/lspp-suffix-fixed-readers.json',
    'keywords/lspp-spelling-file-readers.json',
    'keywords/lspp-contact-id-mpp-fixed-readers.json',
    'keywords/lspp-contact-mpp-tail-readers.json',
    'keywords/lspp-element-readers.json',
    'keywords/lspp-node-readers.json',
    'keywords/lspp-part-composite-readers.json',
    'keywords/lspp-part-standalone-readers.json',
    'keywords/lspp-part-modular-readers.json',
    'keywords/lspp-ordinal-conditional-readers.json',
    'keywords/lspp-field-help/manifest.json',
    'keywords/semantic_runtime_v2/manifest.json',
    'keywords/keyword-structure-v2/manifest.json',
    'keywords/manual_semantics/manifest.json',
    'out/core/theme/extensionTheme.js',
    'out/core/runtimeTableLayoutCorrections.json',
    'out/webview/manual-reader/index.html',
    'out/webview/manual-reader/manifest.json',
    'out/webview/entity-references/index.html',
    'out/webview/entity-references/manifest.json',
    'out/webview/large-file-viewer/index.html',
    'out/webview/large-file-viewer/manifest.json',
    'out/webview/keyword-options/manifest.json',
];
const FORBIDDEN_FILES = new Set([
    'keywords/semantic_runtime_v2/authority-lock.json',
    'keywords/semantic_runtime_v2/build-report.json',
    'keywords/semantic_runtime_v2/proof-report.json',
    'DEVELOPMENT.md',
    'lspost.db',
    'lspost1.db',
    'keywords/field_data.json',
    'keywords/field_data_zh.json',
    'keywords/native_field_help_zh.json',
    'keywords/manual_semantics_zh.json',
    'keywords/definition_registry.json',
    'keywords/keyword_option_grammar.runtime.json.gz',
    'keywords/family_definition_scanner.runtime.json.gz',
    'keywords/definition_registry.authority-lock.json',
    'keywords/definition_registry.build-report.json',
    'keywords/definition_registry.proof-report.json',
    'keywords/family_definition_scanner.runtime-approval.json',
    'keywords/family_definition_scanner.runtime-report.json',
    'keywords/pydyna-source.json',
    'keywords/manual_semantics.build-report.json',
    'keywords/manual_semantics.authority-lock.json',
    'keywords/keyword_option_grammar.authority-lock.json',
    'keywords/keyword_option_grammar.build-report.json',
    'keywords/keyword_structure_profile_approvals.json',
    'keywords/keyword_structure_profiles.schema.json',
    'keywords/keyword_structure_profiles.verification.json',
    'keywords/keyword_structure_profiles.json',
    'out/runtime/field_help_en.runtime.json.gz',
    'out/runtime/field_help_zh.delta.json.gz',
    'DATA_REGENERATION.md',
    'keywords/lspp-input-form/manifest.json',
]);
const FORBIDDEN_PREFIXES = [
    '.artifacts/',
    '.github/',
    '.pytest_cache/',
    '.tmp-worktree-admin/',
    '.tmp-worktrees/',
    '.uv-cache/',
    'dist/',
    'docs/',
    'scripts/',
    'src/',
    'test/',
    'tmp/',
    'webview/',
    'keywords/tests/',
    'keywords/source-data/',
    'keywords/schemas/',
    'keywords/verification/',
    'release-audit/',
];
const RELEASE_ROOT_FILES = new Set(['package.json', 'package.nls.json', 'package.nls.zh-cn.json',
    'readme.md', 'readme_zh.md', 'changelog.md', 'support.md', 'license', 'license.txt',
    'language-configuration.json', 'language-configuration-lspp-cfile.json']);
const RELEASE_DIRECTORIES = ['out/', 'keywords/', 'node_modules/', 'images/', 'snippets/', 'syntaxes/'];

function validatePackageFiles(rawFiles) {
    const released = rawFiles.includes('out/runtime/catalog-input-form/manifest.json');
    const files = rawFiles.map(file => file.trim().replace(/\\/g, '/')).filter(Boolean).map(file => released ? authoringPath(file) : file);
    const fileSet = new Set(files);
    const errors = [];
    if (released && fileSet.size !== new Set(rawFiles).size) errors.push('VSIX contains mixed authoring/release resource paths');
    for (const required of REQUIRED_FILES) {
        if (required === 'out/runtime/field_help/text-index.json.gz' && fileSet.has('out/runtime/field_help/text-index.json.br')) continue;
        if (required === 'out/core/theme/extensionTheme.js' && fileSet.has('out/runtime/release-code.json')) continue;
        if (!fileSet.has(required)) errors.push(`VSIX is missing required file: ${required}`);
    }
    if (!files.some(file => /^out\/webview\/manual-reader\/assets\/[^/]+\.js$/.test(file))) {
        errors.push('VSIX is missing the built manual-reader JavaScript asset');
    }
    if (!files.some(file => /^out\/webview\/manual-reader\/assets\/[^/]+\.css$/.test(file))) {
        errors.push('VSIX is missing the built manual-reader CSS asset');
    }
    if (!files.some(file => /^out\/webview\/entity-references\/assets\/[^/]+\.js$/.test(file))) {
        errors.push('VSIX is missing the built entity-references JavaScript asset');
    }
    if (!files.some(file => /^out\/webview\/entity-references\/assets\/[^/]+\.css$/.test(file))) {
        errors.push('VSIX is missing the built entity-references CSS asset');
    }
    if (!files.some(file => /^out\/webview\/large-file-viewer\/assets\/[^/]+\.js$/.test(file))) {
        errors.push('VSIX is missing the built large-file-viewer JavaScript asset');
    }
    if (!files.some(file => /^out\/webview\/large-file-viewer\/assets\/[^/]+\.css$/.test(file))) {
        errors.push('VSIX is missing the built large-file-viewer CSS asset');
    }
    if (!files.some(file => /^keywords\/manual_semantics\/shards\/[0-9a-f]+\.json\.gz$/.test(file))) {
        errors.push('VSIX is missing the manual semantic runtime shards');
    }
    if (!files.some(file => /^keywords\/keyword-structure-v2\/shards\/[0-9a-f]{2}\.[0-9a-f]{16}\.json$/.test(file))) {
        errors.push('VSIX is missing the keyword structure v2 runtime shards');
    }
    if (!files.some(file => /^keywords\/lspp-input-form\/[0-9a-f]{64}\.json\.(gz|br)$/.test(file))) {
        errors.push('VSIX is missing the LS-PrePost Input Form runtime shards');
    }
    if (!files.some(file => /^out\/runtime\/field_help\/shards\/\d{4}\.json\.(gz|br)$/.test(file))) {
        errors.push('VSIX is missing the field-help runtime shards');
    }
    if (!files.some(file => /^keywords\/semantic_runtime_v2\/references\/[0-9a-f]\.json\.gz$/.test(file)) ||
        !files.some(file => /^keywords\/semantic_runtime_v2\/options\/[0-9a-f]\.json\.gz$/.test(file))) {
        errors.push('VSIX is missing semantic runtime v2 shards');
    }
    for (const file of files) {
        if (file.startsWith('out/') && file !== 'out/extension.js' &&
            !/^out\/(?:client|core|manual|platform|server|shared|worker|runtime|webview)\//.test(file)) {
            errors.push(`VSIX contains non-runtime build output: ${file}`);
            continue;
        }
        if (file.startsWith('keywords/manual_semantics/') &&
            file !== 'keywords/manual_semantics/manifest.json' &&
            !/^keywords\/manual_semantics\/shards\/[0-9a-f]+\.json\.gz$/.test(file)) {
            errors.push(`VSIX contains non-runtime manual semantic data: ${file}`);
            continue;
        }
        if (/(?:^|\/)(?:authoring_semantic_handoff|link_census)(?:\/|$)/.test(file)) {
            errors.push(`VSIX contains full authoring census data: ${file}`);
            continue;
        }
        if (file.startsWith('keywords/keyword-structure-v2/') &&
            file !== 'keywords/keyword-structure-v2/manifest.json' &&
            !/^keywords\/keyword-structure-v2\/shards\/[0-9a-f]{2}\.[0-9a-f]{16}\.json$/.test(file)) {
            errors.push(`VSIX contains non-runtime keyword structure v2 data: ${file}`);
            continue;
        }
        if (file.startsWith('keywords/lspp-input-form/') &&
            file !== 'out/runtime/lspp-input-form/manifest.json' &&
            !/^keywords\/lspp-input-form\/[0-9a-f]{64}\.json\.(gz|br)$/.test(file)) {
            errors.push(`VSIX contains non-runtime LS-PrePost Input Form data: ${file}`);
            continue;
        }
        if (file.startsWith('out/runtime/field_help/')
            && file !== 'out/runtime/field_help/manifest.json'
            && file !== 'out/runtime/field_help/text-index.json.gz'
            && file !== 'out/runtime/field_help/text-index.json.br'
            && !/^out\/runtime\/field_help\/shards\/\d{4}\.json\.(gz|br)$/.test(file)) {
            errors.push(`VSIX contains non-runtime field-help data: ${file}`);
            continue;
        }
        if (FORBIDDEN_FILES.has(file) ||
            FORBIDDEN_PREFIXES.some(prefix => file.startsWith(prefix)) ||
            file.split('/').includes('__pycache__')) {
            errors.push(`VSIX contains forbidden authoring/process file: ${file}`);
        } else if (!RELEASE_ROOT_FILES.has(file.toLowerCase()) && !RELEASE_DIRECTORIES.some(prefix => file.startsWith(prefix))) {
            errors.push(`VSIX contains an undeclared release path: ${file}`);
        }
    }
    return errors.sort();
}

function validateStaticRuntimeDependencies(rawFiles, packageRoot = path.join(__dirname, '..')) {
    const disk = require('node:fs'), crypto = require('node:crypto');
    const released = rawFiles.includes('out/runtime/catalog-input-form/manifest.json');
    const fs = { ...disk, readFileSync(file, ...args) {
        const relative = path.relative(packageRoot, file).replace(/\\/g, '/');
        return disk.readFileSync(released ? path.join(packageRoot, releasePath(relative)) : file, ...args);
    } };
    const files = rawFiles.map(file => file.trim().replace(/\\/g, '/')).filter(Boolean).map(file => released ? authoringPath(file) : file);
    const fileSet = new Set(files);
    const errors = [];
    if (fileSet.has('out/runtime/release-code.json')) {
        const code = JSON.parse(fs.readFileSync(path.join(packageRoot, 'out/runtime/release-code.json')));
        for (const entry of ['out/extension.js', 'out/server/server.js', 'out/worker/scanWorker.js']) {
            if (!fileSet.has(entry) || crypto.createHash('sha256').update(fs.readFileSync(path.join(packageRoot, entry))).digest('hex') !== code.entries?.[entry])
                errors.push(`VSIX bundled entry identity mismatch: ${entry}`);
        }
    }
    const helpManifest = 'out/runtime/field_help/manifest.json';
    if (fileSet.has(helpManifest)) {
        const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, helpManifest)));
        const expected = new Set([helpManifest]);
        for (const descriptor of [...manifest.shards, manifest.textIndex].filter(Boolean)) {
            const name = descriptor === manifest.textIndex ? descriptor.file : `shards/${descriptor.file}`;
            const file = `out/runtime/field_help/${name}`; expected.add(file);
            if (!/^(?:shards\/\d{4}|text-index)\.json\.(?:gz|br)$/.test(name)) {
                errors.push(`VSIX field-help path is invalid: ${file}`); continue;
            }
            if (!fileSet.has(file)) { errors.push(`VSIX field-help payload is missing: ${file}`); continue; }
            const bytes = fs.readFileSync(path.join(packageRoot, file));
            if (crypto.createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256 ||
                (descriptor.compressedBytes !== undefined && bytes.length !== descriptor.compressedBytes))
                errors.push(`VSIX field-help identity mismatch: ${file}`);
        }
        for (const file of files) if (file.startsWith('out/runtime/field_help/') && !expected.has(file))
            errors.push(`VSIX contains unreferenced field-help payload: ${file}`);
    }
    const nativeHelpManifest = 'keywords/lspp-field-help/manifest.json';
    if (fileSet.has(nativeHelpManifest)) {
        const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, nativeHelpManifest), 'utf8'));
        for (const shard of Object.values(manifest.shards)) {
            const file = `keywords/lspp-field-help/${shard.file}`;
            if (!fileSet.has(file)) errors.push(`VSIX is missing native field-help shard: ${file}`);
        }
        const supplementManifest = 'keywords/lspp-field-help/native-null-help.manifest.json';
        if (!fileSet.has(supplementManifest))
            errors.push(`VSIX is missing native null-help manifest: ${supplementManifest}`);
        else {
            const supplement = JSON.parse(fs.readFileSync(path.join(packageRoot, supplementManifest), 'utf8'));
            const catalogBytes = fs.readFileSync(path.join(packageRoot, nativeHelpManifest));
            if (supplement.catalogSha256 !== crypto.createHash('sha256').update(catalogBytes).digest('hex'))
                errors.push(`VSIX native null-help catalog identity differs from manifest: ${supplementManifest}`);
            const file = `keywords/lspp-field-help/${supplement.file}`;
            if (!fileSet.has(file)) errors.push(`VSIX is missing native null-help supplement: ${file}`);
            else if (crypto.createHash('sha256').update(fs.readFileSync(path.join(packageRoot, file)))
                .digest('hex') !== supplement.sha256)
                errors.push(`VSIX native null-help supplement identity differs from manifest: ${file}`);
        }
    }
    const inputFormManifest = 'out/runtime/lspp-input-form/manifest.json';
    if (fileSet.has(inputFormManifest)) {
        const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, inputFormManifest), 'utf8'));
        const referenced = new Set(Object.values(manifest.shards || {}).map(descriptor =>
            `keywords/lspp-input-form/${path.basename(descriptor.file)}`));
        for (const file of files) if (file.startsWith('keywords/lspp-input-form/') &&
            /\.json\.(gz|br)$/.test(file) && !referenced.has(file))
            errors.push(`VSIX contains unreferenced Input Form shard: ${file}`);
        for (const [contentHash, descriptor] of Object.entries(manifest.shards || {})) {
            // The runtime intentionally flattens the producer's card_conditions.v4 path.
            const file = `keywords/lspp-input-form/${path.basename(descriptor.file)}`;
            if (!fileSet.has(file)) {
                errors.push(`VSIX is missing LS-PrePost Input Form shard: ${file}`);
                continue;
            }
            try {
                const bytes = fs.readFileSync(path.join(packageRoot, ...file.split('/')));
                const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
                if (bytes.length !== descriptor.compressedBytes || actualHash !== descriptor.sha256) {
                    errors.push(`VSIX LS-PrePost Input Form shard identity differs from manifest: ${file}`);
                }
                if (descriptor.uncompressedSha256 !== contentHash) {
                    errors.push(`VSIX LS-PrePost Input Form manifest has inconsistent shard identity: ${file}`);
                }
            } catch (_error) {
                errors.push(`VSIX cannot read LS-PrePost Input Form shard: ${file}`);
            }
        }
    }
    if (fileSet.has('keywords/field_reference_index.json')) {
        const reference = JSON.parse(fs.readFileSync(path.join(packageRoot, 'keywords/field_reference_index.json')));
        const descriptor = reference.lsppBlockedReferences;
        if (descriptor?.file) {
            const logical = released ? authoringPath(descriptor.file) : descriptor.file;
            if (!fileSet.has(logical)) errors.push(`VSIX is missing reference blocker resource: ${descriptor.file}`);
            else {
                const bytes = fs.readFileSync(path.join(packageRoot, logical));
                if (bytes.length !== descriptor.compressedBytes || crypto.createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256)
                    errors.push(`VSIX reference blocker resource identity mismatch: ${descriptor.file}`);
            }
        }
    }
    for (const file of files.filter(candidate => candidate.startsWith('out/') && candidate.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(packageRoot, ...file.split('/')), 'utf8');
        for (const match of source.matchAll(/require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g)) {
            const resolved = path.posix.resolve('/', path.posix.dirname(file), match[2]).slice(1);
            const candidates = path.posix.extname(resolved)
                ? [resolved]
                : [resolved, `${resolved}.js`, `${resolved}.json`, `${resolved}.node`,
                    `${resolved}/index.js`, `${resolved}/index.json`, `${resolved}/index.node`];
            if (!candidates.some(candidate => fileSet.has(released ? authoringPath(candidate) : candidate))) {
                errors.push(`VSIX is missing static runtime dependency: ${match[2]} from ${file}`);
            }
        }
    }
    return [...new Set(errors)].sort();
}

function validateRuntimeFileIdentity(files, packageRoot, workspaceRoot = path.join(__dirname, '..')) {
    const fs = require('node:fs'), crypto = require('node:crypto');
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return files.filter(file => /^(out|keywords)\//.test(file)).flatMap(file => {
        const installed = path.join(packageRoot, file), source = path.join(workspaceRoot, file);
        return !fs.existsSync(source) || !fs.existsSync(installed) || hash(source) !== hash(installed)
            ? [`VSIX runtime identity differs from the tested workspace: ${file}`] : [];
    });
}

function validatePublicBoundaryFiles(files, packageRoot) {
    const result = require('./validate-public-source-boundary.cjs').scanPublicSourceBoundary(packageRoot, files);
    return result.findings.map(item => `Public package contains a private production reference: ${item.file}#${item.location}`);
}

function listPackageFiles() {
    const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
    const result = childProcess.spawnSync(process.execPath, [vsce, 'ls'], {
        encoding: 'utf8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        throw new Error(`vsce ls failed: ${result.error?.message || result.stderr || result.status}`);
    }
    return result.stdout.split(/\r?\n/);
}

function validateSemanticRuntimeArtifacts(runtimeRoot = path.join(__dirname, '..', 'keywords',
    'semantic_runtime_v2')) {
    try {
        const { SemanticRuntimeCatalogV2 } = require('../out/core/semantics/semanticRuntimeV2');
        const catalog = new SemanticRuntimeCatalogV2(runtimeRoot);
        const manifest = catalog.manifest();
        const references = catalog.allReferenceRecords();
        const scanners = catalog.allDefinitionScanners();
        const grammars = catalog.allOptionGrammars();
        const status = catalog.status();
        const optionTargets = grammars.reduce((sum, grammar) => sum + (grammar.targets || []).length, 0);
        if (!status.ready || references.length !== manifest.summary.referenceRelations ||
            scanners.length !== manifest.summary.definitionScanners ||
            grammars.length !== manifest.summary.optionGrammars ||
            optionTargets !== manifest.summary.optionTargets) {
            return [`VSIX semantic runtime validation failed: ${status.failureReason || 'population drift'}`];
        }
        return [];
    } catch (error) {
        return [`VSIX semantic runtime validation failed: ${error?.message || String(error)}`];
    }
}

function listVsixFiles(vsixPath) {
    const result = childProcess.execFileSync(process.env.PYTHON || 'python', [
        '-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps(z.namelist()))',
        path.resolve(vsixPath),
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(result).filter(file => file.startsWith('extension/') && !file.endsWith('/'))
        .map(file => file.slice('extension/'.length));
}

function validateVsix(vsixPath) {
    const fs = require('node:fs'), os = require('node:os');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-vsix-check-'));
    try {
        childProcess.execFileSync(process.env.PYTHON || 'python', ['-c', [
            'import pathlib,sys,zipfile',
            'root=pathlib.Path(sys.argv[2]).resolve()',
            'with zipfile.ZipFile(sys.argv[1]) as z:',
            ' assert len(z.namelist()) == len(set(z.namelist())), "Duplicate archive paths"',
            ' for i in z.infolist():',
            '  assert (root/i.filename).resolve().is_relative_to(root), "Unsafe archive path"',
            ' z.extractall(root)',
        ].join('\n'), path.resolve(vsixPath), directory], { windowsHide: true });
        const root = path.join(directory, 'extension'), files = listVsixFiles(vsixPath);
        return [...validatePackageFiles(files), ...validateStaticRuntimeDependencies(files, root),
            ...validatePublicBoundaryFiles(files, root),
            ...validateSemanticRuntimeArtifacts(path.join(root, 'keywords/semantic_runtime_v2'))].sort();
    } finally {
        if (path.dirname(directory) !== require('node:os').tmpdir() || !path.basename(directory).startsWith('dynasense-vsix-check-'))
            throw Error('Unexpected archive verification directory');
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args.length && (args.length !== 2 || args[0] !== '--vsix')) {
            throw new Error('Usage: node scripts/validate-package-contents.cjs [--vsix <file>]');
        }
        const files = args.length ? listVsixFiles(args[1]) : listPackageFiles();
        const errors = args.length ? validateVsix(args[1]) : [
            ...validatePackageFiles(files),
            ...validateStaticRuntimeDependencies(files),
            ...validateSemanticRuntimeArtifacts(),
        ].sort();
        if (errors.length) {
            console.error(errors.join('\n'));
            process.exitCode = 1;
        } else {
            console.log(`VSIX content contract PASS (${files.filter(Boolean).length} files)`);
        }
    } catch (error) {
        console.error(error && error.stack ? error.stack : String(error));
        process.exitCode = 1;
    }
}

module.exports = {
    validateVsix,
    REQUIRED_FILES,
    listVsixFiles,
    validatePackageFiles,
    validateStaticRuntimeDependencies,
    validateRuntimeFileIdentity,
    validatePublicBoundaryFiles,
    validateSemanticRuntimeArtifacts,
};
