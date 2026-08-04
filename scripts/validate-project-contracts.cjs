'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const ts = require('typescript');

const FORBIDDEN_TRACKED_PREFIXES = [
    '.github/analysis/',
    '.github/doc/',
    'docs/plans/',
    'docs/reports/',
    'docs/translation/',
    'docs/superpowers/',
];
const ALLOWED_GITHUB_TRACKED_FILES = new Set([
    '.github/scripts/marketplace-release.cjs',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    '.github/workflows/verify-marketplace.yml',
]);
const ALLOWED_DOCS_TRACKED_FILES = new Set([
    'docs/field-data-zh-translation-guide.md',
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
    'scripts/patch-mat-add-erosion-damage-fields.cjs',
    'scripts/generate-field-reference-index.cjs',
];

const INTERNAL_COMMANDS = new Set([
    'extension.goToKeywordUsage',
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
    return [...String(value).matchAll(/\{(\d+)\}/g)]
        .map(match => Number(match[1]))
        .sort((left, right) => left - right)
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
        'npm audit --omit=dev',
        'npm run check:package-contents',
    ];
    for (const workflowName of ['ci.yml', 'release.yml']) {
        const workflowPath = path.join(root, '.github', 'workflows', workflowName);
        const workflow = decodeUtf8Strict(workflowPath);
        for (const command of requiredCommands) {
            if (!workflow.includes(command)) {
                errors.push(`${workflowName} does not run required check: ${command}`);
            }
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
    if (provenance.schemaVersion !== 2) {
        errors.push('pydyna-source.json must use provenance schemaVersion 2');
    }
    if (provenance.upstream?.repository !== 'ansys/pydyna') {
        errors.push('pydyna-source.json must identify ansys/pydyna');
    }
    if (!/^[0-9a-f]{40}$/.test(provenance.upstream?.commit || '')) {
        errors.push('pydyna-source.json must pin a full upstream commit');
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
        }
    }
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
    if (!ignoreLines.includes('!keywords/field_data.json')) {
        errors.push('.vscodeignore must include keywords/field_data.json');
    }
    if (ignoreLines.includes('!keywords/field_data_zh.json')) {
        errors.push('.vscodeignore must not package the full keywords/field_data_zh.json authoring source');
    }
    if (!ignoreLines.includes('!keywords/field_reference_index.json')) {
        errors.push('.vscodeignore must include keywords/field_reference_index.json');
    }
    if (ignoreLines.some(line => ['out', 'out/', 'out/**'].includes(line))) {
        errors.push('.vscodeignore must not exclude generated out/runtime field-help artifacts');
    }

    const scripts = manifest.scripts || {};
    if (!String(scripts.compile || '').includes('npm run build:field-help-delta')) {
        errors.push('package.json compile must generate the Chinese field-help delta');
    }
    if (scripts['build:field-help-delta'] !== 'node scripts/generate-field-help-zh-delta.cjs') {
        errors.push('package.json build:field-help-delta must use the deterministic generator');
    }

    const schemaSource = decodeUtf8Strict(path.join(root, 'src', 'core', 'keywordSchema.ts'));
    if (schemaSource.includes('field_data_zh.json')) {
        errors.push('keywordSchema runtime must not load the full field_data_zh.json authoring source');
    }
    if (!schemaSource.includes('field_help_zh.delta.json.gz')) {
        errors.push('keywordSchema runtime must load the generated Chinese field-help delta');
    }
}

function validateProjectContracts(projectRoot = process.cwd()) {
    const root = path.resolve(projectRoot);
    const errors = [];
    const packagePath = path.join(root, 'package.json');
    const packageText = decodeUtf8Strict(packagePath);
    const manifest = JSON.parse(packageText);
    validateManifestLocalization(manifest, errors);
    validateWorkflowCoverage(root, errors);
    validateFieldHelpPackaging(root, manifest, errors);
    validateTrackedSourceBoundaries(root, errors);
    validatePydynaProvenance(root, errors);

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
