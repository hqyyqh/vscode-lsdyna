'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');
const ts = require('typescript');

const PINNED_PYDYNA_COMMIT = '367fea6c13ca7c8d2e28bd290d943395d84e77a3';

const FORBIDDEN_TRACKED_PREFIXES = [
    '.github/analysis/',
    '.github/doc/',
    'docs/plans/',
    'docs/reports/',
    'docs/translation/',
    'docs/superpowers/',
];
const ALLOWED_GITHUB_TRACKED_FILES = new Set([
    '.github/release-appendix.md',
    '.github/scripts/marketplace-release.cjs',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    '.github/workflows/verify-marketplace.yml',
]);
const ALLOWED_DOCS_TRACKED_FILES = new Set([
    'docs/public-source-boundary.md',
    'docs/release-compression.md',
    'docs/dynamic-hover-certificate-integration-audit.md',
    'docs/dynamic-hover-checkpoint-2026-09-19.md',
    'docs/dynamic-hover-coverage.json',
    'docs/dynamic-hover-global-status.md',
    'docs/dynamic-hover-handoff-2026-09-20.md',
    'docs/dynamic-hover-name-record.md',
    'docs/dynamic-hover-no-field-certificate-audit.md',
    'docs/dynamic-hover-occurrence-standard-mismatch-analysis.md',
    'docs/dynamic-hover-occurrence-terminal-failure-analysis.md',
    'docs/dynamic-hover-reopen-failure-analysis.md',
    'docs/dynamic-hover-set-list.md',
    'docs/dynamic-hover-stale-scope-plan.json',
    'docs/dynamic-hover-static-format-gap-design.md',
    'docs/dynamic-hover-static-formats-qualification.json',
    'docs/dynamic-hover-suffix-remaining.md',
    'docs/dynamic-hover-suffix.md',

    'docs/field-data-zh-translation-guide.md',
    'docs/keyword-field-semantics/FIELD_REFERENCE_ZERO_OMISSION_TODO.zh-CN.md',
    // Source-locked native census inputs replayed by test/scripts/*.test.py.
    'docs/lspp-native-reader-bindings.json.gz',
    'docs/lspp-file-reader-coverage.json',
    'docs/lspp-native-reader-bindings-summary.json',
    'docs/lspp-native-dispatch-closure.json.gz',
]);
const FORBIDDEN_TRACKED_FILES = new Set([
    'AGENTS.md',
    'GEMINI.md',
    'keywords/field_data_translation_inventory.py',
    'keywords/field_data_translation_ledger.py',
    'keywords/field_data_translation_review.py',
    'keywords/manage_field_data_translation.py',
    'keywords/prepare_field_data_translation_wave.py',
    'keywords/process_field_data_translation_wave.py',
    'scripts/apply-field-data-zh-manual-translations.cjs',
    'scripts/data/field-data-zh-manual-translations.json',
    'scripts/patch_manual_row_loop_r.py',
]);
const GENERATION_TOOL_PATHS = [
    'scripts/regenerate-keyword-artifacts.cjs',
    'keywords/generate_from_pydyna.py',
    'keywords/pydyna_schema_adapter.py',
    'keywords/text_sanitization.py',
    'keywords/compatibility/mat_add_erosion_legacy_fields.json',
    'keywords/compatibility/component_joint_did_official_float.json',
    'keywords/compatibility/mat_072_card8_manual_layout.json',
    'keywords/compatibility/cese_mat_002_card1_manual_layout.json',
    'keywords/compatibility/define_control_volume_flow_area_card1_manual_layout.json',
    'keywords/compatibility/em_solver_fembem_monolithic_card2_3_manual_layout.json',
    'keywords/compatibility/icfd_control_dem_coupling_card2_manual_layout.json',
    'keywords/compatibility/constrained_soil_pile_card2_manual_layout.json',
    'scripts/generate-field-reference-index.cjs',
    'scripts/generate-lspp-reference-handoff.cjs',
];

const INTERNAL_COMMANDS = new Set([
    'extension.keywordOptions.apply',
    'extension.keywordOptions.openEvidence',
    'extension.keywordOptions.refresh',
    'extension.keywordOptions.reset',
    'extension.keywordOptions.stage',
    'extension.keywordOptions.togglePin',
    'extension.rebuildCardComments',
    'extension.insertVerifiedMissingRecords',
    'extension.lsdynaApplyInlineEditChoice',
    'extension.lsdynaCancelInlineEditChoice',
    'extension.openSemanticEvidence',
    'extension.goToKeywordUsage',
    'extension.setLsdynaTablePreviewView',
    'extension.openIncludeFolder',
    'extension.openIncludeNewTab',
    'extension.openIncludeSplit',
    'extension.manual.openPackChapter',
    'extension.manual.pickPackChapter',
    'extension.manual.pickPdfLocation',
    // Overrides VS Code built-in type for card cell edit protect (not contributed).
    'type',
]);

function decodeUtf8Strict(filePath) {
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filePath));
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256CanonicalTextFile(filePath) {
    const text = decodeUtf8Strict(filePath).replace(/\r\n?/g, '\n');
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function collectFiles(rootDir, predicate) {
    const result = [];
    if (!fs.existsSync(rootDir)) return result;
    const stack = [rootDir];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.worktrees') continue;
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(fullPath);
            else if (predicate(fullPath)) result.push(fullPath);
        }
    }
    return result.sort();
}

function flatJsonKeysWithoutDuplicates(filePath) {
    const text = decodeUtf8Strict(filePath);
    const keys = [...text.matchAll(/^\s*"([^"]+)"\s*:/gm)].map(match => match[1]);
    const seen = new Set();
    const duplicates = new Set();
    for (const key of keys) {
        if (seen.has(key)) duplicates.add(key);
        seen.add(key);
    }
    return { text, values: JSON.parse(text), keys: seen, duplicates: [...duplicates].sort() };
}

function propertyName(node, sourceFile) {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
    return node.getText(sourceFile);
}

function unwrapExpression(node) {
    let current = node;
    while (
        current && (
            ts.isAsExpression(current) ||
            ts.isTypeAssertionExpression(current) ||
            ts.isParenthesizedExpression(current) ||
            (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))
        )
    ) {
        current = current.expression;
    }
    return current;
}

function objectEntries(node, sourceFile) {
    const entries = new Map();
    const duplicates = new Set();
    for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = propertyName(property.name, sourceFile);
        if (entries.has(key)) duplicates.add(key);
        entries.set(key, property.initializer);
    }
    return { entries, duplicates: [...duplicates].sort() };
}

function objectVariable(filePath, variableName) {
    const text = decodeUtf8Strict(filePath);
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let result;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName) {
            const initializer = unwrapExpression(node.initializer);
            if (initializer && ts.isObjectLiteralExpression(initializer)) result = initializer;
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    if (!result) throw new Error(`${path.basename(filePath)} is missing object variable ${variableName}`);
    return { text, sourceFile, node: result };
}

function stringObject(node, sourceFile, label, errors) {
    if (!node || !ts.isObjectLiteralExpression(node)) {
        errors.push(`${label} is not an object literal`);
        return new Map();
    }
    const { entries, duplicates } = objectEntries(node, sourceFile);
    for (const key of duplicates) errors.push(`${label} contains duplicate key ${key}`);
    const values = new Map();
    for (const [key, value] of entries) {
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) values.set(key, value.text);
        else errors.push(`${label}.${key} must be a static string`);
    }
    return values;
}

function literalObjectEntries(node, sourceFile, label, errors) {
    if (!node || !ts.isObjectLiteralExpression(node)) {
        errors.push(`${label} is not an object literal`);
        return { entries: new Map(), duplicates: [] };
    }
    return objectEntries(node, sourceFile);
}

function placeholderSignature(value) {
    return [...String(value).matchAll(/\{(\d+|[A-Za-z_][A-Za-z0-9_]*)\}/g)]
        .map(match => match[1])
        .sort()
        .join(',');
}

function validateParallelMessages(left, right, leftLabel, rightLabel, errors) {
    for (const key of setDifference(new Set(left.keys()), new Set(right.keys()))) {
        errors.push(`${rightLabel} is missing key ${key}`);
    }
    for (const key of setDifference(new Set(right.keys()), new Set(left.keys()))) {
        errors.push(`${leftLabel} is missing key ${key}`);
    }
    for (const [key, leftValue] of left) {
        if (!right.has(key)) continue;
        const leftSignature = placeholderSignature(leftValue);
        const rightSignature = placeholderSignature(right.get(key));
        if (leftSignature !== rightSignature) {
            errors.push(`${leftLabel}.${key} placeholders (${leftSignature}) differ from ${rightLabel} (${rightSignature})`);
        }
    }
}

function validateRuntimeLocalization(root, errors) {
    const i18nPath = path.join(root, 'src', 'core', 'i18n.ts');
    const runtime = objectVariable(i18nPath, 'LOCALES');
    const runtimeLocales = objectEntries(runtime.node, runtime.sourceFile);
    for (const key of runtimeLocales.duplicates) errors.push(`LOCALES contains duplicate locale ${key}`);
    const localeObjects = runtimeLocales.entries;
    const zh = stringObject(localeObjects.get('zh-cn'), runtime.sourceFile, 'LOCALES.zh-cn', errors);
    const en = stringObject(localeObjects.get('en'), runtime.sourceFile, 'LOCALES.en', errors);
    validateParallelMessages(en, zh, 'LOCALES.en', 'LOCALES.zh-cn', errors);

    const referencedKeys = new Set();
    for (const filePath of collectFiles(path.join(root, 'src'), file => file.endsWith('.ts') || file.endsWith('.tsx'))) {
        const text = decodeUtf8Strict(filePath);
        for (const match of text.matchAll(/i18n\.get\(\s*['"]([^'"]+)['"]/g)) referencedKeys.add(match[1]);
    }
    for (const key of referencedKeys) {
        if (!en.has(key)) errors.push(`LOCALES is missing referenced key ${key}`);
    }

    const readerPath = path.join(root, 'webview', 'manual-reader', 'src', 'readerI18n.ts');
    const reader = objectVariable(readerPath, 'messages');
    const readerLocaleObjects = objectEntries(reader.node, reader.sourceFile);
    for (const key of readerLocaleObjects.duplicates) errors.push(`reader messages contains duplicate locale ${key}`);
    const readerLocales = readerLocaleObjects.entries;
    const readerEn = literalObjectEntries(readerLocales.get('en'), reader.sourceFile, 'reader messages.en', errors);
    const readerZh = literalObjectEntries(readerLocales.get('zh'), reader.sourceFile, 'reader messages.zh', errors);
    for (const key of readerEn.duplicates) errors.push(`reader messages.en contains duplicate key ${key}`);
    for (const key of readerZh.duplicates) errors.push(`reader messages.zh contains duplicate key ${key}`);
    for (const key of setDifference(new Set(readerEn.entries.keys()), new Set(readerZh.entries.keys()))) {
        errors.push(`reader messages.zh is missing key ${key}`);
    }
    for (const key of setDifference(new Set(readerZh.entries.keys()), new Set(readerEn.entries.keys()))) {
        errors.push(`reader messages.en is missing key ${key}`);
    }
}

function validateManifestLocalization(manifest, errors) {
    const isLocalized = value => typeof value === 'string' && /^%[^%]+%$/.test(value);
    const requireLocalized = (value, location) => {
        if (!isLocalized(value)) errors.push(`manifest user-facing text is not localized: ${location}`);
    };

    requireLocalized(manifest.description, 'description');
    for (const [index, command] of (manifest.contributes.commands || []).entries()) {
        requireLocalized(command.title, `contributes.commands[${index}].title`);
    }
    for (const [index, container] of (manifest.contributes.viewsContainers?.activitybar || []).entries()) {
        requireLocalized(container.title, `contributes.viewsContainers.activitybar[${index}].title`);
    }
    for (const [viewGroup, views] of Object.entries(manifest.contributes.views || {})) {
        for (const [index, view] of views.entries()) {
            requireLocalized(view.name, `contributes.views.${viewGroup}[${index}].name`);
        }
    }
    for (const [index, welcome] of (manifest.contributes.viewsWelcome || []).entries()) {
        requireLocalized(welcome.contents, `contributes.viewsWelcome[${index}].contents`);
    }
    for (const [name, property] of Object.entries(manifest.contributes.configuration?.properties || {})) {
        if (property.description !== undefined) requireLocalized(property.description, `${name}.description`);
        if (property.markdownDescription !== undefined) requireLocalized(property.markdownDescription, `${name}.markdownDescription`);
        for (const [index, description] of (property.enumDescriptions || []).entries()) {
            requireLocalized(description, `${name}.enumDescriptions[${index}]`);
        }
    }
    for (const [name, color] of Object.entries(manifest.contributes.colors || {})) {
        requireLocalized(color.description, `contributes.colors.${name}.description`);
    }
}

function setDifference(left, right) {
    return [...left].filter(value => !right.has(value)).sort();
}

function extractReadmeSettings(text) {
    const settings = new Map();
    for (const match of text.matchAll(/^\|\s*`(lsdyna\.[^`]+)`\s*\|\s*`([^`]*)`\s*\|/gm)) {
        settings.set(match[1], match[2]);
    }
    for (const match of text.matchAll(/^- `(lsdyna\.[^`]+)`\r?\n\r?\n  \*\*(?:Default:|默认值：)\*\* `([^`]*)`/gm)) {
        settings.set(match[1], match[2]);
    }
    return settings;
}

function validateReadmeSettings(filePath, properties, errors) {
    const settings = extractReadmeSettings(decodeUtf8Strict(filePath));
    const expectedNames = new Set(Object.keys(properties));
    const actualNames = new Set(settings.keys());
    for (const missing of setDifference(expectedNames, actualNames)) {
        errors.push(`${path.basename(filePath)} is missing setting ${missing}`);
    }
    for (const extra of setDifference(actualNames, expectedNames)) {
        errors.push(`${path.basename(filePath)} documents unknown setting ${extra}`);
    }
    for (const [name, property] of Object.entries(properties)) {
        if (!settings.has(name)) continue;
        const expectedDefault = JSON.stringify(property.default);
        if (settings.get(name) !== expectedDefault) {
            errors.push(`${path.basename(filePath)} default for ${name} is ${settings.get(name)}, expected ${expectedDefault}`);
        }
    }
}

function extractRegisteredCommands(projectRoot) {
    const commands = new Set();
    for (const filePath of collectFiles(path.join(projectRoot, 'src'), file => file.endsWith('.ts'))) {
        const text = decodeUtf8Strict(filePath);
        for (const match of text.matchAll(/registerCommand\(\s*['"]([^'"]+)['"]/g)) {
            commands.add(match[1]);
        }
    }
    return commands;
}

function validateWorkflowCoverage(root, errors) {
    const requiredCommands = [
        'npm run check:contracts',
        'npm test',
        'npm run test:webview',
        'python -m unittest discover -s keywords/tests',
        'python keywords/validate_field_data_translation.py --check-content',
        'python keywords/audit_field_data_quality.py',
        'npm run check:native-help-zh',
        'node scripts/package-hover-release.cjs',
        'run: npm audit\n',
        'npm run test:native-python',
        'node scripts/validate-package-contents.cjs --vsix',
    ];
    for (const workflowName of ['ci.yml', 'release.yml']) {
        const workflowPath = path.join(root, '.github', 'workflows', workflowName);
        const workflow = decodeUtf8Strict(workflowPath).replace(/\r\n/g, '\n');
        for (const command of requiredCommands) {
            if (!workflow.includes(command)) {
                errors.push(`${workflowName} does not run required check: ${command}`);
            }
        }
        for (const sourceLine of [
            'repository: ansys/pydyna',
            `ref: ${PINNED_PYDYNA_COMMIT}`,
            'path: pydyna',
        ]) {
            if (!workflow.includes(sourceLine)) {
                errors.push(`${workflowName} does not prepare pinned PyDYNA input: ${sourceLine}`);
            }
        }
    }

    const releaseWorkflow = decodeUtf8Strict(path.join(root, '.github', 'workflows', 'release.yml'));
    for (const releaseSetting of [
        'generate_release_notes: true',
        'append_body: true',
        'body_path: .github/release-appendix.md',
    ]) {
        if (!releaseWorkflow.includes(releaseSetting)) {
            errors.push(`release.yml does not publish stable usage guidance: ${releaseSetting}`);
        }
    }

    const releaseAppendixPath = path.join(root, '.github', 'release-appendix.md');
    if (!fs.existsSync(releaseAppendixPath)) {
        errors.push('release usage guidance is missing: .github/release-appendix.md');
        return;
    }
    const releaseAppendix = decodeUtf8Strict(releaseAppendixPath);
    for (const requiredText of [
        'Install from VSIX',
        'Developer: Reload Window',
        'lsdyna-manual-pack-en_20260804.zip',
        'lsdyna-manual-pack-bilingual_20260804.zip',
        'SumatraPDF is Windows-only',
        'Only the PDF manuals are the official, authoritative reference',
        '从 VSIX 安装',
        '只有 PDF 手册是官方权威资料',
    ]) {
        if (!releaseAppendix.includes(requiredText)) {
            errors.push(`release usage guidance is missing required text: ${requiredText}`);
        }
    }
}

function validateTrackedPaths(files, errors) {
    for (const rawPath of files) {
        const filePath = rawPath.replace(/\\/g, '/');
        if (FORBIDDEN_TRACKED_FILES.has(filePath) ||
            FORBIDDEN_TRACKED_PREFIXES.some(prefix => filePath.startsWith(prefix)) ||
            (filePath.startsWith('.github/') && !ALLOWED_GITHUB_TRACKED_FILES.has(filePath)) ||
            (filePath.startsWith('docs/') && !ALLOWED_DOCS_TRACKED_FILES.has(filePath))) {
            errors.push(`process artifact must not be tracked: ${filePath}`);
        }
    }
}

function validateTrackedSourceBoundaries(root, errors) {
    const result = childProcess.spawnSync('git', ['ls-files', '-z'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        throw new Error(`git ls-files failed: ${result.stderr || result.status}`);
    }
    const files = result.stdout.split('\0').filter(Boolean);
    validateTrackedPaths(files, errors);

    const textExtensions = new Set(['.cjs', '.js', '.json', '.md', '.py', '.ts', '.tsx', '.txt', '.yaml', '.yml']);
    const absoluteLocalPath = /(?:[A-Za-z]:[\\/](?:Project|Users)[\\/]|\/home\/[^/]+\/)/;
    for (const relativePath of files) {
        if (!textExtensions.has(path.extname(relativePath).toLowerCase())) continue;
        const text = decodeUtf8Strict(path.join(root, relativePath));
        if (absoluteLocalPath.test(text)) {
            errors.push(`tracked text contains a local absolute path: ${relativePath.replace(/\\/g, '/')}`);
        }
    }
}

function validatePydynaProvenance(root, errors) {
    const provenancePath = path.join(root, 'keywords', 'pydyna-source.json');
    const provenance = JSON.parse(decodeUtf8Strict(provenancePath));
    if (provenance.schemaVersion !== 3) {
        errors.push('pydyna-source.json must use provenance schemaVersion 3');
    }
    if (provenance.upstream?.repository !== 'ansys/pydyna') {
        errors.push('pydyna-source.json must identify ansys/pydyna');
    }
    if (!/^[0-9a-f]{40}$/.test(provenance.upstream?.commit || '')) {
        errors.push('pydyna-source.json must pin a full upstream commit');
    }
    if (provenance.upstream?.commit !== PINNED_PYDYNA_COMMIT) {
        errors.push(`pydyna-source.json must pin ${PINNED_PYDYNA_COMMIT}`);
    }
    if (Object.hasOwn(provenance.upstream || {}, 'branch')) {
        errors.push('pydyna-source.json must not use a mutable branch as provenance');
    }
    const command = String(provenance.generation?.command || '');
    if (!command.includes('<pydyna-root>/codegen') || /[A-Za-z]:[\\/]/.test(command)) {
        errors.push('pydyna-source.json generation command must be portable');
    }
    const toolHashes = provenance.integrity?.toolSha256 || {};
    for (const toolPath of GENERATION_TOOL_PATHS) {
        if (!/^[0-9a-f]{64}$/.test(toolHashes[toolPath] || '')) {
            errors.push(`pydyna-source.json is missing generation tool hash: ${toolPath}`);
        } else if (toolHashes[toolPath] !== sha256CanonicalTextFile(path.join(root, toolPath))) {
            errors.push(`pydyna-source.json generation tool hash is stale: ${toolPath}`);
        }
    }
    const overlays = provenance.generation?.compatibilityOverlays || [];
    const matOverlay = overlays.find(item => item?.id === 'mat-add-erosion-legacy-damage-fields');
    if (!matOverlay) {
        errors.push('pydyna-source.json is missing the MAT_ADD_EROSION compatibility overlay');
    } else if (!['compatibility-overlay', 'upstream-complete'].includes(matOverlay.state)) {
        errors.push('pydyna-source.json has an invalid MAT_ADD_EROSION compatibility state');
    }
    const componentOverlay = overlays.find(item =>
        item?.id === 'component-joint-did-official-float');
    if (!componentOverlay) {
        errors.push('pydyna-source.json is missing the COMPONENT joint DID type overlay');
    } else if (!['compatibility-overlay', 'upstream-complete'].includes(componentOverlay.state)) {
        errors.push('pydyna-source.json has an invalid COMPONENT joint DID compatibility state');
    }
    const mat072Overlay = overlays.find(item => item?.id === 'mat-072-card8-manual-layout');
    if (!mat072Overlay) {
        errors.push('pydyna-source.json is missing the MAT_072 Card 8 compatibility overlay');
    } else if (!['compatibility-overlay', 'upstream-complete'].includes(mat072Overlay.state)) {
        errors.push('pydyna-source.json has an invalid MAT_072 Card 8 compatibility state');
    }
    validateMat072Card8Overlay(root, errors);
    const ceseOverlay = overlays.find(item => item?.id === 'cese-mat-002-card1-manual-layout');
    if (!ceseOverlay) {
        errors.push('pydyna-source.json is missing the CESE_MAT_002 Card 1 compatibility overlay');
    } else if (!['compatibility-overlay', 'upstream-complete'].includes(ceseOverlay.state)) {
        errors.push('pydyna-source.json has an invalid CESE_MAT_002 Card 1 compatibility state');
    }
    const defineOverlay = overlays.find(item => item?.id === 'define-control-volume-flow-area-card1-manual-layout');
    if (!defineOverlay) {
        errors.push('pydyna-source.json is missing the DEFINE_CONTROL_VOLUME_FLOW_AREA Card 1 compatibility overlay');
    } else if (!['compatibility-overlay', 'inventory-only', 'upstream-complete'].includes(defineOverlay.state)) {
        errors.push('pydyna-source.json has an invalid DEFINE_CONTROL_VOLUME_FLOW_AREA Card 1 compatibility state');
    }
    const emOverlay = overlays.find(item => item?.id === 'em-solver-fembem-monolithic-card2-3-manual-layout');
    if (!emOverlay) {
        errors.push('pydyna-source.json is missing the EM_SOLVER_FEMBEM_MONOLITHIC Card 2/3 compatibility overlay');
    } else if (!['compatibility-overlay', 'upstream-complete'].includes(emOverlay.state)) {
        errors.push('pydyna-source.json has an invalid EM_SOLVER_FEMBEM_MONOLITHIC compatibility state');
    }
    const icfdCard2Overlay = overlays.find(item =>
        item?.id === 'icfd-control-dem-coupling-card2-manual-layout');
    if (!icfdCard2Overlay) {
        errors.push('pydyna-source.json is missing the ICFD_CONTROL_DEM_COUPLING Card 2 compatibility overlay');
    } else if (!['compatibility-overlay', 'upstream-complete'].includes(icfdCard2Overlay.state)) {
        errors.push('pydyna-source.json has an invalid ICFD_CONTROL_DEM_COUPLING Card 2 compatibility state');
    }
    validateIcfdControlDemCouplingCard2Overlay(root, errors);
    const constrainedSoilPileOverlay = overlays.find(item =>
        item?.id === 'constrained-soil-pile-card2-manual-layout');
    if (!constrainedSoilPileOverlay) {
        errors.push('pydyna-source.json is missing the CONSTRAINED_SOIL_PILE Card 2 compatibility overlay');
    } else if (!['compatibility-overlay', 'upstream-complete'].includes(constrainedSoilPileOverlay.state)) {
        errors.push('pydyna-source.json has an invalid CONSTRAINED_SOIL_PILE Card 2 compatibility state');
    }
    validateConstrainedSoilPileCard2Overlay(root, errors);
}

function validateFieldHelpPackaging(root, manifest, errors) {
    const ignorePath = path.join(root, '.vscodeignore');
    const ignoreLines = decodeUtf8Strict(ignorePath)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    if (!ignoreLines.includes('keywords/**')) {
        errors.push('.vscodeignore must exclude keywords/** before allowlisting runtime keyword artifacts');
    }
    if (ignoreLines.includes('!keywords/field_data.json')) {
        errors.push('.vscodeignore must not package the full keywords/field_data.json authoring source');
    }
    if (ignoreLines.includes('!keywords/field_data_zh.json')) {
        errors.push('.vscodeignore must not package the full keywords/field_data_zh.json authoring source');
    }
    if (!ignoreLines.includes('!keywords/field_reference_index.json')) {
        errors.push('.vscodeignore must include keywords/field_reference_index.json');
    }
    for (const required of ['!out/runtime/field_schema.runtime.json.gz', '!out/runtime/field_help/**']) {
        if (!ignoreLines.includes(required)) errors.push(`.vscodeignore must include ${required}`);
    }
    for (const obsolete of [
        'out/runtime/field_help_en.runtime.json.gz',
        'out/runtime/field_help_zh.delta.json.gz',
    ]) {
        if (!ignoreLines.includes(obsolete)) {
            errors.push(`.vscodeignore must exclude obsolete monolithic help artifact ${obsolete}`);
        }
    }

    const scripts = manifest.scripts || {};
    if (!String(scripts.compile || '').includes('npm run build:runtime-data')) {
        errors.push('package.json compile must generate compact field schema/help runtimes');
    }
    if (scripts['build:field-help-delta'] !== 'node scripts/generate-field-help-zh-delta.cjs') {
        errors.push('package.json build:field-help-delta must use the deterministic generator');
    }
    if (scripts['build:field-schema-runtime'] !== 'node scripts/generate-field-schema-runtime.cjs') {
        errors.push('package.json build:field-schema-runtime must use the deterministic generator');
    }
    if (scripts['build:field-help-runtime'] !== 'node scripts/generate-field-help-runtime.cjs') {
        errors.push('package.json build:field-help-runtime must use the deterministic sharded generator');
    }

    const schemaSource = decodeUtf8Strict(path.join(root, 'src', 'core', 'keywordSchema.ts'));
    if (schemaSource.includes('field_data_zh.json')) {
        errors.push('keywordSchema runtime must not load the full field_data_zh.json authoring source');
    }
    for (const requiredRuntimeName of ['field_schema.runtime.json.gz', 'field_help', 'manifest.json', 'shards']) {
        if (!schemaSource.includes(requiredRuntimeName)) {
            errors.push(`keywordSchema runtime is missing sharded help contract token ${requiredRuntimeName}`);
        }
    }
    for (const obsoleteRuntimeName of ['field_help_en.runtime.json.gz', 'field_help_zh.delta.json.gz']) {
        if (schemaSource.includes(obsoleteRuntimeName)) {
            errors.push(`keywordSchema runtime must not load obsolete monolithic artifact ${obsoleteRuntimeName}`);
        }
    }
}

function validateProjectContracts(projectRoot = process.cwd(), { publicSource = false } = {}) {
    const root = path.resolve(projectRoot);
    const errors = [];
    const packagePath = path.join(root, 'package.json');
    const packageText = decodeUtf8Strict(packagePath);
    const manifest = JSON.parse(packageText);
    validateManifestLocalization(manifest, errors);
    if (!publicSource) validateWorkflowCoverage(root, errors);
    validateFieldHelpPackaging(root, manifest, errors);
    if (!publicSource) {
        validateTrackedSourceBoundaries(root, errors);
        validatePydynaProvenance(root, errors);
    } else {
        // Public final-data hashes replace producer replay; product checks below still run.
        require('./build-public-runtime-data.cjs').verifyPublicData(root);
    }
    validatePublishedFieldGeometry(root, errors);
    validateSemanticRuntimeV2(root, manifest, errors, publicSource);

    const markdownFiles = [
        ...collectFiles(path.join(root, 'docs'), file => file.endsWith('.md')),
        ...collectFiles(path.join(root, '.github'), file => file.endsWith('.md')),
        ...['README.md', 'README_zh.md', 'AGENTS.md']
            .map(file => path.join(root, file))
            .filter(file => fs.existsSync(file)),
    ];
    for (const filePath of [...new Set(markdownFiles)].sort()) {
        try {
            decodeUtf8Strict(filePath);
        } catch (error) {
            errors.push(`invalid UTF-8: ${path.relative(root, filePath)}`);
        }
    }

    const nlsPaths = [path.join(root, 'package.nls.json'), path.join(root, 'package.nls.zh-cn.json')];
    const nlsResults = nlsPaths.map(filePath => flatJsonKeysWithoutDuplicates(filePath));
    nlsResults.forEach((result, index) => {
        for (const duplicate of result.duplicates) {
            errors.push(`${path.basename(nlsPaths[index])} contains duplicate key ${duplicate}`);
        }
    });
    for (const key of setDifference(nlsResults[0].keys, nlsResults[1].keys)) {
        errors.push(`package.nls.zh-cn.json is missing key ${key}`);
    }
    for (const key of setDifference(nlsResults[1].keys, nlsResults[0].keys)) {
        errors.push(`package.nls.json is missing key ${key}`);
    }
    validateParallelMessages(
        new Map(Object.entries(nlsResults[0].values)),
        new Map(Object.entries(nlsResults[1].values)),
        'package.nls.json',
        'package.nls.zh-cn.json',
        errors
    );
    const referencedNlsKeys = new Set(
        [...packageText.matchAll(/"%([^%"\r\n]+)%"/g)].map(match => match[1])
    );
    for (const key of referencedNlsKeys) {
        if (!nlsResults[0].keys.has(key)) errors.push(`package.nls.json is missing referenced key ${key}`);
        if (!nlsResults[1].keys.has(key)) errors.push(`package.nls.zh-cn.json is missing referenced key ${key}`);
    }
    validateRuntimeLocalization(root, errors);

    const properties = manifest.contributes.configuration.properties;
    validateReadmeSettings(path.join(root, 'README.md'), properties, errors);
    validateReadmeSettings(path.join(root, 'README_zh.md'), properties, errors);

    const contributed = new Set(manifest.contributes.commands.map(command => command.command));
    const registered = extractRegisteredCommands(root);
    const activationEvents = new Set(manifest.activationEvents || []);
    for (const command of contributed) {
        if (!registered.has(command)) errors.push(`contributed command is not registered: ${command}`);
        if (!activationEvents.has(`onCommand:${command}`)) errors.push(`missing activation event onCommand:${command}`);
    }
    for (const command of registered) {
        if (!contributed.has(command) && !INTERNAL_COMMANDS.has(command)) {
            errors.push(`registered internal command is not allowlisted: ${command}`);
        }
    }

    return errors.sort();
}

module.exports = {
    INTERNAL_COMMANDS,
    decodeUtf8Strict,
    extractReadmeSettings,
    flatJsonKeysWithoutDuplicates,
    validateManifestLocalization,
    validateParallelMessages,
    validateFieldHelpPackaging,
    validateTrackedPaths,
    validateProjectContracts,
};

if (require.main === module) {
    try {
        const errors = validateProjectContracts(process.cwd());
        if (errors.length) {
            console.error(errors.join('\n'));
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(error && error.stack ? error.stack : String(error));
        process.exitCode = 1;
    }
}

function validateMat072Card8Overlay(root, errors) {
    const overlayPath = path.join(root, 'keywords', 'compatibility', 'mat_072_card8_manual_layout.json');
    if (!fs.existsSync(overlayPath)) {
        errors.push('MAT_072 Card 8 compatibility overlay file is missing');
        return;
    }
    let overlay;
    try {
        overlay = JSON.parse(decodeUtf8Strict(overlayPath));
    } catch (error) {
        errors.push(`MAT_072 Card 8 compatibility overlay is invalid JSON: ${error.message}`);
        return;
    }
    const expectedFields = Array.from({ length: 5 }, (_, offset) => ({
        name: `NU-${offset + 9}`,
        position: offset * 10,
        width: 10,
        type: 'real',
        english: 'Tabulated scale factor.',
        chinese: '表格形式的比例因子。',
    }));
    const expectedPages = [
        {
            physicalPage: 618,
            textSha256: '78bc41463cb6d9cea012819a708e8f5658b61951ab51cccf72aa2588dd4ae6f6',
            renderSha256: '89850cb48a36c689c2e56ab2ce7ca8b331e84c8fc75551efd1af4a7880c32756',
        },
        {
            physicalPage: 622,
            textSha256: '9297bc5a123672065b40d7dfe92e0d0d735b66a9e2aa6f8dd51bc1b20d325b3c',
            renderSha256: '816e5b9e29b758b8827d762f2654a8d968e22f01d5d89d90287273cbb77f5f53',
        },
    ];
    const expectedPermissions = {
        schemaCardAddition: true,
        schemaTypeCorrection: false,
        referenceApproval: false,
        optionMutation: false,
        automaticValueMutation: false,
    };
    if (overlay.schemaVersion !== 1 ||
        overlay.id !== 'mat-072-card8-manual-layout' ||
        overlay.version !== 1 ||
        overlay.policy !== 'official-pdf-required-card8-layout-v1' ||
        JSON.stringify(overlay.keywords) !== JSON.stringify(['MAT_072', 'MAT_072_TITLE']) ||
        JSON.stringify(canonicalJson(overlay.upstreamGap)) !== JSON.stringify(canonicalJson({
            expectedCardCount: 7,
            expectedFieldCount: 43,
            prefixSignatureSha256: 'd1185056b17a00b8d0795ce8b2951222eda4cd5c6f6bb06b88344ee30bc2d6d0',
        })) ||
        overlay.card?.physicalCardIndex !== 7 ||
        JSON.stringify(canonicalJson(overlay.card?.fields)) !== JSON.stringify(canonicalJson(expectedFields)) ||
        overlay.source?.manualId !== 'ls-dyna-dev-keyword-manual-vol-ii-material-models' ||
        overlay.source?.pdfSha256 !== '5538d1b8e32d5e6e743496a4c48575549ddb1854d424de559ed3f19fa772ccf3' ||
        overlay.source?.pdfSize !== 14842989 ||
        overlay.source?.toolVersion !== '24.03.0' ||
        overlay.source?.textCommand !== 'pdftotext -layout -enc UTF-8' ||
        overlay.source?.renderCommand !== 'pdftoppm -r 144 -png -singlefile' ||
        JSON.stringify(canonicalJson(overlay.source?.pages)) !== JSON.stringify(canonicalJson(expectedPages)) ||
        JSON.stringify(canonicalJson(overlay.evidence)) !== JSON.stringify(canonicalJson({
            requiredCardNumbers: [1, 2, 3, 4, 5, 6, 7, 8],
            card8FieldNames: ['NU-9', 'NU-10', 'NU-11', 'NU-12', 'NU-13'],
            card8Description: 'η1 - η13 Tabulated scale factor.',
            directFieldLayout: true,
            optionEvidence: false,
            inferenceUsed: false,
        })) ||
        JSON.stringify(canonicalJson(overlay.permissions)) !== JSON.stringify(canonicalJson(expectedPermissions))) {
        errors.push('MAT_072 Card 8 compatibility overlay source, layout, evidence, or permission contract drift');
    }
}

function validateIcfdControlDemCouplingCard2Overlay(root, errors) {
    const overlayPath = path.join(
        root,
        'keywords',
        'compatibility',
        'icfd_control_dem_coupling_card2_manual_layout.json',
    );
    if (!fs.existsSync(overlayPath)) {
        errors.push('ICFD_CONTROL_DEM_COUPLING Card 2 compatibility overlay file is missing');
        return;
    }
    let overlay;
    try {
        overlay = JSON.parse(decodeUtf8Strict(overlayPath));
    } catch (error) {
        errors.push(`ICFD_CONTROL_DEM_COUPLING Card 2 compatibility overlay is invalid JSON: ${error.message}`);
        return;
    }
    const expectedField = {
        name: 'NITBS',
        position: 0,
        width: 10,
        type: 'integer',
        english: 'Number of time steps between particle searches. The default is 50 in explicit analysis and 1 in implicit. Increasing this number can reduce the computational time at the expense of possible less accurate particle tracking.',
        chinese: '粒子搜索之间的时间步数。显式分析中的默认值为 50，隐式分析中的默认值为 1。增大该数值可以减少计算时间，但可能降低粒子跟踪的准确性。',
    };
    const expectedPages = [
        {
            physicalPage: 634,
            textSha256: '00488c691e65bb2da65b5960a786ff16ba125fc5b394238d3f9b7f9a1ff1b15a',
            renderSha256: '2eeba47ef6f7103c157be40ce19be5a156480ada39fadeef2bf2c55c9cf3aecc',
        },
        {
            physicalPage: 635,
            textSha256: '83fc88b3a9e3c50b7cd9dc0ac2da6f44bc328b8d29b46a1df93b88239c1312cd',
            renderSha256: '46ff7f1d69f94eca6891688bee9a65e0fcd1d1dec37f74192604cffa992e97dd',
        },
    ];
    const expectedPermissions = {
        schemaCardAddition: true,
        schemaTypeCorrection: false,
        referenceApproval: false,
        optionMutation: false,
        automaticValueMutation: false,
    };
    if (
        overlay.schemaVersion !== 1 ||
        overlay.id !== 'icfd-control-dem-coupling-card2-manual-layout' ||
        overlay.version !== 1 ||
        overlay.policy !== 'official-pdf-required-card2-layout-v1' ||
        JSON.stringify(overlay.keywords) !== JSON.stringify(['ICFD_CONTROL_DEM_COUPLING']) ||
        JSON.stringify(canonicalJson(overlay.upstreamGap)) !== JSON.stringify(canonicalJson({
            expectedCardCount: 1,
            expectedFieldCount: 8,
            prefixSignatureSha256: '1092834a29c36a6caeeecc39bd9406058e05cbc5fc6554c7e23ccbb0890e6945',
        })) ||
        overlay.card?.physicalCardIndex !== 1 ||
        JSON.stringify(canonicalJson(overlay.card?.fields)) !== JSON.stringify(canonicalJson([expectedField])) ||
        overlay.source?.manualId !== 'ls-dyna-dev-keyword-manual-vol-iii-multiphysics-solvers' ||
        overlay.source?.pdfSha256 !== '3f17ea1c4511030dbc24981af6e4ecd718d700b2b519021fa82c5d1a0ad0ef77' ||
        overlay.source?.pdfSize !== 4460313 ||
        overlay.source?.toolVersion !== '24.03.0' ||
        overlay.source?.textCommand !== 'pdftotext -layout -enc UTF-8' ||
        overlay.source?.renderCommand !== 'pdftoppm -r 144 -png -singlefile' ||
        JSON.stringify(canonicalJson(overlay.source?.pages)) !== JSON.stringify(canonicalJson(expectedPages)) ||
        JSON.stringify(canonicalJson(overlay.evidence)) !== JSON.stringify(canonicalJson({
            requiredCardNumbers: [1, 2],
            card2FieldNames: ['NITBS'],
            card2Description: expectedField.english,
            directFieldLayout: true,
            optionEvidence: false,
            inferenceUsed: false,
        })) ||
        JSON.stringify(canonicalJson(overlay.permissions)) !== JSON.stringify(canonicalJson(expectedPermissions))
    ) {
        errors.push('ICFD_CONTROL_DEM_COUPLING Card 2 compatibility overlay source, layout, evidence, or permission contract drift');
    }
}

function validateConstrainedSoilPileCard2Overlay(root, errors) {
    const overlayPath = path.join(
        root,
        'keywords',
        'compatibility',
        'constrained_soil_pile_card2_manual_layout.json',
    );
    if (!fs.existsSync(overlayPath)) {
        errors.push('CONSTRAINED_SOIL_PILE Card 2 compatibility overlay file is missing');
        return;
    }
    let overlay;
    try {
        overlay = JSON.parse(decodeUtf8Strict(overlayPath));
    } catch (error) {
        errors.push(`CONSTRAINED_SOIL_PILE Card 2 compatibility overlay is invalid JSON: ${error.message}`);
        return;
    }
    const expectedFields = [
        ['DAMP', 0, 10, 'real', 0.0, ['轴向耦合的可选阻尼系数。']],
        ['LOCAL', 10, 10, 'integer', 1, ['1', '2']],
        ['INSTRF', 20, 10, 'integer', 0, ['0', '1']],
        ['TIMSTR', 30, 10, 'real', 0.0, null],
        ['ICD7A', 40, 10, 'integer', 0, null],
        ['DAMPH', 50, 10, 'real', 0.0, null],
        ['UNUSED', 60, 10, 'integer', undefined, null],
        ['UNUSED', 70, 10, 'integer', undefined, null],
    ];
    const fields = Array.isArray(overlay.card?.fields) ? overlay.card.fields : [];
    const fieldGeometry = fields.map(field => [
        field?.name,
        field?.position,
        field?.width,
        field?.type,
    ]);
    const expectedGeometry = expectedFields.map(field => field.slice(0, 4));
    const permissions = {
        schemaCardAddition: false,
        schemaTypeCorrection: true,
        referenceApproval: false,
        optionMutation: false,
        automaticValueMutation: false,
    };
    const expectedSourcePages = [
        [1077, 'd2dca30fa671ae6fc0075d7f834ed8aa562f1c1e82963fd7ec63bf33b16214bd'],
        [1078, '6235e9bccd54e9121850a8117c0bede321d0605a90a6c2377e59ce4e104fb64f'],
        [1079, '58742428fc2d00b7c1ba1f472affebc4ba852f2d71addd6abf72047b05cc89d0'],
        [1080, 'e436d6ee0913a7bf5a539c8af0ef49806bc4999d20251dcba42edcf807879ac7'],
        [1085, '99d7031d3c712ee46f529bc5c5f075d08144afffceb6c289bcde89c39c92be43'],
    ];
    const actualSourcePages = (overlay.source?.pages || []).map(page => [
        page?.physicalPage,
        page?.textSha256,
    ]);
    if (
        overlay.schemaVersion !== 1 ||
        overlay.id !== 'constrained-soil-pile-card2-manual-layout' ||
        overlay.version !== 1 ||
        overlay.policy !== 'official-pdf-required-card2-layout-v1' ||
        JSON.stringify(overlay.keywords) !== JSON.stringify([
            'CONSTRAINED_SOIL_PILE_CONSTANTS',
            'CONSTRAINED_SOIL_PILE_CONSTANTS_SET',
            'CONSTRAINED_SOIL_PILE_CURVES',
            'CONSTRAINED_SOIL_PILE_CURVES_SET',
        ]) ||
        JSON.stringify(canonicalJson(overlay.upstreamGap)) !== JSON.stringify(canonicalJson({
            expectedCardCount: 6,
            expectedFieldCount: 2,
            cardSignatureSha256: 'b80fff2e5d1632e33ae107fc6e7baaa5d0b08e8b424cdbbc613880b88771e19c',
        })) ||
        JSON.stringify(canonicalJson(overlay.alternateExpectedCardCounts)) !== JSON.stringify(canonicalJson({
            CONSTRAINED_SOIL_PILE_CONSTANTS: 7,
            CONSTRAINED_SOIL_PILE_CONSTANTS_SET: 7,
        })) ||
        JSON.stringify(overlay.alternateCardSignatures) !== JSON.stringify([
            '1f76e40eb932538b5bb590a293927289c26d33935dc2a265c1cd94db0c14f640',
        ]) ||
        overlay.card?.physicalCardIndex !== 1 ||
        JSON.stringify(fieldGeometry) !== JSON.stringify(expectedGeometry) ||
        overlay.source?.manualId !== 'ls-dyna-dev-keyword-manual-vol-i' ||
        overlay.source?.pdfSha256 !== 'e6e6c696a98cab037dc7004590912c585811de53e727e469f4d01cca9046f302' ||
        overlay.source?.pdfSize !== 34763447 ||
        overlay.source?.toolVersion !== '24.03.0' ||
        overlay.source?.textCommand !== 'pdftotext -layout -enc UTF-8 (page form-feed split)' ||
        overlay.source?.renderCommand !== 'pdftoppm -r 144 -png -singlefile' ||
        JSON.stringify(actualSourcePages) !== JSON.stringify(expectedSourcePages) ||
        JSON.stringify(canonicalJson(overlay.evidence)) !== JSON.stringify(canonicalJson({
            requiredCardNumbers: [1, 2, 3, 4, 5, 6, 7],
            card2FieldNames: ['DAMP', 'LOCAL', 'INSTRF', 'TIMSTR', 'ICD7A', 'DAMPH', 'UNUSED', 'UNUSED'],
            card2Description: 'Include this card unless OPTION1 is unset (<BLANK>).',
            directFieldLayout: true,
            optionEvidence: false,
            inferenceUsed: false,
        })) ||
        JSON.stringify(canonicalJson(overlay.permissions)) !== JSON.stringify(canonicalJson(permissions))
    ) {
        errors.push('CONSTRAINED_SOIL_PILE Card 2 compatibility overlay source, layout, evidence, or permission contract drift');
    }
}

function fieldGeometryErrors(fieldData) {
    const errors = [];
    for (const [keyword, entry] of Object.entries(fieldData || {})) {
        for (const [cardIndex, card] of (entry.c || []).entries()) {
            for (const [fieldIndex, field] of (card || []).entries()) {
                if (!Number.isInteger(field?.p) || !Number.isInteger(field?.w) || field.p < 0 || field.w < 1) {
                    errors.push(`${keyword}/${cardIndex}/${fieldIndex} has invalid fixed-column geometry`);
                    continue;
                }
                for (const [otherOffset, other] of card.slice(fieldIndex + 1).entries()) {
                    if (Number.isInteger(other?.p) && Number.isInteger(other?.w) && other.w > 0 &&
                        Math.max(field.p, other.p) < Math.min(field.p + field.w, other.p + other.w)) {
                        errors.push(`${keyword}/${cardIndex}/${fieldIndex}-${fieldIndex + otherOffset + 1} overlaps`);
                    }
                }
            }
        }
    }
    return errors;
}

function storedOptionBindings(candidate) {
    const hasBindings = Object.prototype.hasOwnProperty.call(candidate || {}, 'bindings');
    const hasEncoding = Object.prototype.hasOwnProperty.call(candidate || {}, 'bindingEncoding');
    if (!hasEncoding) return hasBindings && Array.isArray(candidate.bindings) ? candidate.bindings : null;
    if (candidate.bindingEncoding !== 'identity-derived-v1' || hasBindings ||
        !candidate.layout?.profileId || !Array.isArray(candidate.layout.records)) return null;
    const fields = candidate.layout.records.flatMap(record => Array.isArray(record?.fields) ? record.fields : []);
    if (fields.some(field => !field?.fieldMigrationId)) return null;
    return fields.map(field => ({
        sourceFieldMigrationId: field.fieldMigrationId,
        targetFieldMigrationId: field.fieldMigrationId,
        evidenceId: `option-binding-evidence:${sha256CanonicalJson([
            candidate.layout.profileId, field.fieldMigrationId,
        ]).slice(0, 24)}`,
        ...(field.canonicalFieldIdentity ? { strategy: 'stable-physical-field-identity' } : {}),
    }));
}

function validatePublishedFieldGeometry(root, errors) {
    const fieldData = JSON.parse(decodeUtf8Strict(path.join(root, 'keywords', 'field_data.json')));
    for (const error of fieldGeometryErrors(fieldData)) errors.push(`field_data geometry: ${error}`);

    const provenance = JSON.parse(decodeUtf8Strict(path.join(root, 'keywords', 'pydyna-source.json')));
    if (provenance.stats?.overlappingFixedWidthFields !== 0) {
        errors.push('pydyna-source.json must report zero overlapping fixed-width fields');
    }

    const runtimeRoot = path.join(root, 'keywords', 'semantic_runtime_v2');
    const runtimeManifest = JSON.parse(decodeUtf8Strict(path.join(runtimeRoot, 'manifest.json')));
    let optionTargets = 0;
    let writableTargets = 0;
    let keywordOnlyTargets = 0;
    let optionMutationStates = 0;
    let editableOptionMutationEdges = 0;
    let blockedCrossCanonicalOptionMutationEdges = 0;
    for (const descriptor of runtimeManifest.optionShards || []) {
        const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(runtimeRoot, descriptor.path))));
        for (const grammar of shard.records || []) {
            const writableStates = [];
            for (const target of grammar.targets || []) {
                optionTargets++;
                if (target.applicationMode === 'keyword-only-preserve-block') {
                    keywordOnlyTargets++;
                }
                if (target.writePermission !== true) continue;
                writableTargets++;
                for (const candidate of target.layouts || []) {
                    const canonicalIdentity = String(
                        candidate.layout?.sourceIdentity?.canonicalKeyword ||
                        candidate.layout?.sourceIdentity?.canonicalSectionId || '',
                    ).toUpperCase();
                    writableStates.push({
                        stateId: `${target.targetId}:${candidate.postCount}`,
                        canonicalIdentity,
                    });
                    if (!canonicalIdentity) {
                        errors.push(`writable semantic option lacks canonical layout identity: ${target.spelling}`);
                    }
                    const targetFields = (candidate.layout?.records || []).flatMap(record => record.fields || []);
                    const bindings = storedOptionBindings(candidate);
                    if (!bindings) {
                        errors.push(`writable semantic option has invalid binding encoding: ${target.spelling}`);
                    }
                    const boundTargets = new Set((bindings || []).map(binding =>
                        binding.targetFieldMigrationId));
                    if (!targetFields.every(field => boundTargets.has(field.fieldMigrationId))) {
                        errors.push(`writable semantic option lacks explicit field binding closure: ${target.spelling}`);
                    }
                    const synthetic = { [target.spelling]: { c: candidate.layout?.records?.map(record =>
                        (record.fields || []).map(field => ({ p: field.position, w: field.width }))) || [] } };
                    for (const error of fieldGeometryErrors(synthetic)) {
                        errors.push(`writable semantic option geometry: ${error}`);
                    }
                }
            }
            optionMutationStates += writableStates.length;
            for (const source of writableStates) for (const target of writableStates) {
                if (source.stateId === target.stateId) continue;
                if (source.canonicalIdentity && source.canonicalIdentity === target.canonicalIdentity) {
                    editableOptionMutationEdges++;
                } else {
                    blockedCrossCanonicalOptionMutationEdges++;
                }
            }
        }
    }
    if (optionTargets !== 4475 || writableTargets !== 4475 || keywordOnlyTargets !== 73 ||
        optionMutationStates !== 4535 || editableOptionMutationEdges !== 130090 ||
        blockedCrossCanonicalOptionMutationEdges !== 77730 ||
        runtimeManifest.summary?.optionMutationStates !== optionMutationStates ||
        runtimeManifest.summary?.editableOptionMutationEdges !== editableOptionMutationEdges ||
        runtimeManifest.summary?.blockedCrossCanonicalOptionMutationEdges !==
            blockedCrossCanonicalOptionMutationEdges) {
        errors.push('semantic option mutation closure population drift');
    }
}

function canonicalJson(value) {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
    }
    return value;
}

function sha256CanonicalJson(value) {
    return crypto.createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

function validateSemanticRuntimeV2(root, manifest, errors, publicSource = false) {
    const runtimeRoot = path.join(root, 'keywords', 'semantic_runtime_v2');
    const manifestPath = path.join(runtimeRoot, 'manifest.json');
    const required = publicSource ? ['manifest.json'] : ['manifest.json', 'authority-lock.json', 'build-report.json', 'proof-report.json'];
    for (const relative of required) {
        if (!fs.existsSync(path.join(runtimeRoot, relative))) errors.push(`semantic runtime v2 artifact missing: ${relative}`);
    }
    if (!fs.existsSync(manifestPath)) return;
    const ignore = decodeUtf8Strict(path.join(root, '.vscodeignore')).split(/\r?\n/).map(line => line.trim());
    if (!ignore.includes('!keywords/semantic_runtime_v2/**')) errors.push('.vscodeignore must package semantic runtime v2');
    if (ignore.includes('!keywords/definition_registry.json') ||
        ignore.includes('!keywords/keyword_option_grammar.runtime.json.gz')) {
        errors.push('.vscodeignore must not package semantic runtime v1 artifacts');
    }
    try {
        const runtime = JSON.parse(decodeUtf8Strict(manifestPath));
        const { contentSha256, ...core } = runtime;
        if (runtime.schemaVersion !== 2 || runtime.kind !== 'dynasense-semantic-runtime-catalog-v2' ||
            contentSha256 !== sha256CanonicalJson(core)) errors.push('semantic runtime v2 manifest identity drift');
        if (runtime.permissions?.referenceNavigation !== true ||
            runtime.permissions?.reverseReferenceNavigation !== true ||
            runtime.permissions?.optionDisplay !== true ||
            runtime.permissions?.optionMutationByTarget !== true ||
            runtime.permissions?.completenessClaim !== false) errors.push('semantic runtime v2 permission drift');
        if (runtime.summary?.sourceManualRelations !== 4021 ||
            runtime.summary?.distinctManualRelations !== runtime.summary.sourceManualRelations ||
            runtime.summary?.referenceRelations < runtime.summary.sourceManualRelations ||
            runtime.summary?.referenceCoordinates < runtime.summary.sourceManualRelations ||
            runtime.summary?.referenceKeywords < 1000 || runtime.summary?.definitionScanners !== 1678 ||
            runtime.summary?.optionTargets !== 4475 ||
            runtime.summary?.editableOptionTargets !== 4475 ||
            runtime.summary?.optionMutationStates !== 4535 ||
            runtime.summary?.editableOptionMutationEdges !== 130090 ||
            runtime.summary?.blockedCrossCanonicalOptionMutationEdges !== 77730) {
            errors.push('semantic runtime v2 population drift');
        }
        for (const [domain, descriptors] of [['references', runtime.referenceShards], ['options', runtime.optionShards]]) {
            if (!Array.isArray(descriptors) || descriptors.length !== 16 ||
                new Set((descriptors || []).map(item => item.prefix)).size !== 16) {
                errors.push(`semantic runtime v2 ${domain} shard set drift`);
                continue;
            }
            for (const descriptor of descriptors) {
                const file = path.join(runtimeRoot, descriptor.path);
                const compressed = fs.readFileSync(file);
                const raw = zlib.gunzipSync(compressed);
                if (compressed.length !== descriptor.compressedBytes || raw.length !== descriptor.uncompressedBytes ||
                    crypto.createHash('sha256').update(compressed).digest('hex') !== descriptor.sha256 ||
                    crypto.createHash('sha256').update(raw).digest('hex') !== descriptor.contentSha256) {
                    errors.push(`semantic runtime v2 shard drift: ${descriptor.path}`);
                }
            }
        }
        for (const artifact of publicSource ? [] : ['authority-lock.json', 'build-report.json', 'proof-report.json']) {
            const payload = JSON.parse(decodeUtf8Strict(path.join(runtimeRoot, artifact)));
            if (payload.datasetReleaseId !== runtime.datasetReleaseId) errors.push(`semantic runtime v2 ${artifact} release drift`);
        }
        if (!publicSource && (manifest.scripts?.['build:semantic-runtime-v2'] !== 'node scripts/generate-semantic-runtime-v2.cjs' ||
            manifest.scripts?.['rebuild:semantic-data'] !== 'node scripts/rebuild-semantic-data.cjs')) {
            errors.push('package.json semantic runtime v2 commands drift');
        }
        const consumer = decodeUtf8Strict(path.join(root, 'src', 'core', 'semantics', 'semanticRuntimeV2.ts'));
        if (!consumer.includes('SemanticRuntimeCatalogV2') || !consumer.includes('lruUncompressedBytes') ||
            /[0-9a-f]{64}/.test(consumer)) errors.push('semantic runtime v2 consumer contract drift');
    } catch (error) {
        errors.push(`semantic runtime v2 validation failed: ${error.message}`);
    }
}
