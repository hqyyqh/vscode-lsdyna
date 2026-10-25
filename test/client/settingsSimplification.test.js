'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { shouldShowHealthNotice } = require('../../out/client/services/healthService');

describe('simplified settings behavior', () => {
    it('persists notice dismissal across changed setup issues and honors the old opt-out', async () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');
        const tree = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
        let notice;
        const visit = node => {
            if (ts.isFunctionExpression(node) && node.name?.text === 'maybeShowHealthNotice') notice = node;
            ts.forEachChild(node, visit);
        };
        visit(tree);
        assert.ok(notice);
        const state = new Map(), calls = [];
        let issue = 'language', enabled = true, choice = 'healthNoticeDoNotRemind';
        const context = { globalState: {
            get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
            update: async (key, value) => { state.set(key, value); },
        } };
        const vscode = { window: { showInformationMessage: async (...args) => { calls.push(args); return choice; } } };
        const run = new Function('context', 'vscode', 'isLsdynaFile', 'getLsdynaConfigurationValue',
            'getHealthReportForEditor', 'shouldShowHealthNotice', 'i18n', 'logDebug',
            'HEALTH_NOTICE_SIGNATURE_KEY', 'HEALTH_NOTICE_DISMISSED_KEY',
            ts.transpileModule(`const run = (${notice.getText(tree)});`, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText + '; return run;')(context, vscode, () => true, () => enabled,
                () => ({ items: [{ id: issue, state: 'warning' }] }), shouldShowHealthNotice,
                { get: key => key }, error => { throw error; }, 'signature', 'dismissed');
        const editor = { document: { uri: 'file:///model.k' } };
        run(editor);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(state.get('dismissed'), true);
        assert.ok(calls[0].includes('healthNoticeDoNotRemind'));
        issue = 'another-issue';
        run(editor);
        assert.equal(calls.length, 1);
        state.delete('dismissed');
        enabled = false;
        run(editor);
        assert.equal(calls.length, 1);
        enabled = true;
        choice = 'healthNoticeLater';
        run(editor);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls.length, 2);
        assert.equal(state.has('dismissed'), false);
    });

    it('does not enable unaudited forms through a retired user setting', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../../src/client/services/keywordManager.ts'), 'utf8');
        const tree = ts.createSourceFile('keywordManager.ts', source, ts.ScriptTarget.Latest, true);
        let gate;
        const visit = node => {
            if (ts.isFunctionDeclaration(node) && node.name?.text === 'isKeywordManagerUnauditedCatalogAllowed') gate = node;
            ts.forEachChild(node, visit);
        };
        visit(tree);
        assert.ok(gate);
        const evaluate = new Function('process', 'vscode', ts.transpileModule(gate.getText(tree), {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText + '; return isKeywordManagerUnauditedCatalogAllowed();');
        const vscode = { workspace: { getConfiguration: () => ({ get: () => true }) } };
        assert.equal(evaluate({ env: {} }, vscode), false);
        assert.equal(evaluate({ env: { DYNASENSE_ALLOW_UNAUDITED_CATALOG: '1' } }, vscode), true);
    });
});
