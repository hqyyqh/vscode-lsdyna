'use strict';

const fs = require('fs');
const path = require('path');

const INTERNAL_COMMANDS = new Set([
    'extension.goToKeywordUsage',
    'extension.openIncludeFolder',
    'extension.openIncludeNewTab',
    'extension.openIncludeSplit',
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
    return { text, keys: seen, duplicates: [...duplicates].sort() };
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

function validateProjectContracts(projectRoot = process.cwd()) {
    const root = path.resolve(projectRoot);
    const errors = [];
    const packagePath = path.join(root, 'package.json');
    const packageText = decodeUtf8Strict(packagePath);
    const manifest = JSON.parse(packageText);

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
    const referencedNlsKeys = new Set(
        [...packageText.matchAll(/"%([^%"\r\n]+)%"/g)].map(match => match[1])
    );
    for (const key of referencedNlsKeys) {
        if (!nlsResults[0].keys.has(key)) errors.push(`package.nls.json is missing referenced key ${key}`);
        if (!nlsResults[1].keys.has(key)) errors.push(`package.nls.zh-cn.json is missing referenced key ${key}`);
    }

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
