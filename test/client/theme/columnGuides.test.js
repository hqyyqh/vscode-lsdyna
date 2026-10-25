'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { createColumnGuideController } = require('../../../src/client/services/columnGuides');

describe('Column guide text boundaries', () => {
    it('leaves blank and short-line tails empty while keeping aligned text separators', async () => {
        const previousEditors = vscode.window.visibleTextEditors;
        const previousEvent = vscode.window.onDidChangeTextEditorVisibleRanges;
        const previousChange = vscode.workspace.onDidChangeTextDocument;
        const lines = ['', '12345', 'x'.repeat(25), 'x'.repeat(80), '\t1234567890', '中文1234567890', '$12345678901234567890', '*PART', '1,2,3,4,5,6,7'];
        let decorations;
        vscode.window.onDidChangeTextEditorVisibleRanges = () => ({ dispose() {} });
        vscode.workspace.onDidChangeTextDocument = () => ({ dispose() {} });
        vscode.window.visibleTextEditors = [{
            document: { languageId: 'lsdyna', lineCount: lines.length, lineAt: line => ({ text: lines[line] }) },
            visibleRanges: [new vscode.Range(0, 0, 8, 0)],
            setDecorations: (_, values) => { decorations = values; },
        }];
        const controller = createColumnGuideController((_document, line) => line === 2 ? [10, 20] : line === 3 ? [10, 20, 30, 40, 50, 60, 70, 80] : []);
        try {
            await new Promise(resolve => setTimeout(resolve, 80));
            assert.deepEqual(decorations.map(d => [d.range.start.line, d.range.start.character]),
                [[2, 10], [2, 20], ...[10, 20, 30, 40, 50, 60, 70, 80].map(column => [3, column])]);
            for (const decoration of decorations) {
                assert.equal(decoration.renderOptions.after, undefined);
                assert.equal(decoration.renderOptions.before.width, '0px');
                assert.equal(decoration.renderOptions.before.margin, '0 0.5ch 0 -0.5ch');
            }
        } finally {
            controller.dispose();
            vscode.window.visibleTextEditors = previousEditors;
            vscode.window.onDidChangeTextEditorVisibleRanges = previousEvent;
            vscode.workspace.onDidChangeTextDocument = previousChange;
        }
    });
    it('does not restore guides when an obsolete preparation finishes after disabling the setting', async () => {
        const editors = vscode.window.visibleTextEditors, event = vscode.window.onDidChangeTextEditorVisibleRanges;
        const configuration = vscode.workspace.getConfiguration, change = vscode.workspace.onDidChangeTextDocument;
        vscode.workspace.onDidChangeTextDocument = () => ({dispose(){}});
        let enabled = true, finish, decorations = [];
        vscode.workspace.getConfiguration = () => ({ get: () => enabled });
        vscode.window.onDidChangeTextEditorVisibleRanges = () => ({dispose(){}});
        vscode.window.visibleTextEditors = [{ document: {languageId:'lsdyna',version:1,lineCount:1,lineAt:()=>({text:'1234567890'})},
            visibleRanges:[new vscode.Range(0,0,0,10)],setDecorations:(_,values)=>{decorations.push(values);} }];
        const controller = createColumnGuideController(() => [10], () => new Promise(resolve => {finish=resolve;}));
        try {
            await new Promise(resolve => setTimeout(resolve, 80));
            enabled = false; controller.scheduleRefresh(); finish(true);
            await new Promise(resolve => setTimeout(resolve, 80));
            assert.ok(decorations.length > 0);
            assert.ok(decorations.every(values => values.length === 0));
        } finally {controller.dispose();vscode.window.visibleTextEditors=editors;
            vscode.window.onDidChangeTextEditorVisibleRanges=event;vscode.workspace.getConfiguration=configuration;vscode.workspace.onDidChangeTextDocument=change;}
    });

});
