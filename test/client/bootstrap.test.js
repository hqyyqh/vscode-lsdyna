'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

describe('activation dependency preparation', () => {
    it('passes resource-scoped zero and nonzero change-mark delays through activation', () => {
        const root = path.resolve(__dirname, '../..');
        const entry = ts.createSourceFile('extension.ts', fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
        const getter = entry.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getLsdynaConfigurationValue');
        const mappings = [];
        const visit = node => {
            if (ts.isCallExpression(node) && node.expression.getText(entry) === 'createChangeMarksController') {
                const property = node.arguments[0].properties.find(item => item.name?.getText(entry) === 'getConfig');
                mappings.push(property.initializer);
            }
            ts.forEachChild(node, visit);
        };
        visit(entry);
        assert.ok(getter);
        assert.equal(mappings.length, 1);
        const { DEFAULT_CHANGE_MARKS_CUSTOM_COLORS } = require('../../src/core/theme/extensionTheme');
        let configured, resource, delayReads = 0;
        const vscode = { workspace: { getConfiguration(namespace, actualResource) {
            assert.equal(namespace, 'lsdyna');
            assert.equal(actualResource, resource);
            return { get(key, fallback) {
                if (key !== 'changeMarks.debounceMs') return fallback;
                delayReads++;
                assert.equal(fallback, 250);
                return configured === undefined ? fallback : configured;
            } };
        } } };
        const getConfig = new Function('vscode', 'DEFAULT_CHANGE_MARKS_CUSTOM_COLORS',
            `${getter.getText(entry)}; return (${mappings[0].getText(entry)});`)(vscode, DEFAULT_CHANGE_MARKS_CUSTOM_COLORS);
        for (const [value, scope, expected] of [
            [undefined, undefined, 250], [0, { scheme: 'file', fsPath: '/zero.k' }, 0],
            [40, { scheme: 'file', fsPath: '/other.k' }, 40], [5000, undefined, 5000],
            ['invalid', { scheme: 'file', fsPath: '/invalid.k' }, 250],
        ]) {
            configured = value;
            resource = scope;
            assert.equal(getConfig(resource).debounceMs, expected);
        }
        assert.equal(delayReads, 5);
    });

    it('resolves every prepared module in the development build used by F5', () => {
        const root = path.resolve(__dirname, '../..');
        const bootstrap = fs.readFileSync(path.join(root, 'src/client/bootstrap.ts'), 'utf8');
        const entryRequire = require('node:module').createRequire(path.join(root, 'out/extension.js'));
        for (const [, request] of bootstrap.matchAll(/["'](\.\/[^"']+)["']/g))
            assert.doesNotThrow(() => entryRequire.resolve(request), `Missing development module: ${request}`);
    });

    it('prepares every static entry dependency before the synchronous entry evaluation', () => {
        const root = path.resolve(__dirname, '../..');
        const entry = ts.createSourceFile('extension.ts', fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
        const bootstrap = fs.readFileSync(path.join(root, 'src/client/bootstrap.ts'), 'utf8');
        const prepared = new Set([...bootstrap.matchAll(/["'](\.\/[^"']+)["']/g)].map(match => match[1]));
        const visit = node => {
            if (ts.isCallExpression(node) && node.expression.getText(entry) === 'require' &&
                ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith('.'))
                assert.ok(prepared.has(node.arguments[0].text), `Prepare ${node.arguments[0].text} asynchronously in bootstrap`);
            ts.forEachChild(node, visit);
        };
        for (const statement of entry.statements) if (ts.isVariableStatement(statement))
            for (const declaration of statement.declarationList.declarations) if (declaration.initializer) visit(declaration.initializer);
    });
});
