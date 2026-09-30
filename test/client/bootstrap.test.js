'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

describe('activation dependency preparation', () => {
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
