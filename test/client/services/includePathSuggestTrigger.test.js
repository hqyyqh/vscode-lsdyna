'use strict';

const assert = require('assert');
const {
    changeLooksLikeIncludePathTyping,
    createIncludePathSuggestTrigger,
} = require('../../../src/client/services/includePathSuggestTrigger');

describe('includePathSuggestTrigger', () => {
    describe('changeLooksLikeIncludePathTyping', () => {
        it('accepts one typed path character and rejects paste or multi-cursor batches', () => {
            assert.strictEqual(changeLooksLikeIncludePathTyping([{ text: 'm' }]), true);
            assert.strictEqual(changeLooksLikeIncludePathTyping([{ text: '/' }]), true);
            assert.strictEqual(changeLooksLikeIncludePathTyping([{ text: 'sub/' }]), false);
            assert.strictEqual(changeLooksLikeIncludePathTyping([{ text: 'a' }, { text: 'a' }]), false);
            assert.strictEqual(changeLooksLikeIncludePathTyping([{ text: 'a', rangeLength: 1 }]), false);
            assert.strictEqual(changeLooksLikeIncludePathTyping([{ text: '' }]), false);
            assert.strictEqual(changeLooksLikeIncludePathTyping([]), false);
        });
    });

    describe('createIncludePathSuggestTrigger', () => {
        it('fires triggerSuggest after debounce on include filename card', (done) => {
            const commands = [];
            let scheduled = null;
            const doc = {
                uri: { fsPath: '/x/main.k' },
                languageId: 'lsdyna',
                lineAt: () => ({ text: 'ma' }),
            };
            const trigger = createIncludePathSuggestTrigger({
                debounceMs: 10,
                schedule: (fn) => {
                    scheduled = fn;
                    return 1;
                },
                cancel: () => {},
                isLsdynaDocument: () => true,
                isIncludeFilenameContext: () => true,
                getActiveEditor: () => ({
                    document: doc,
                    selection: { active: { line: 1, character: 2 } },
                }),
                executeCommand: (cmd) => {
                    commands.push(cmd);
                },
            });

            trigger.onDidChangeTextDocument({
                document: doc,
                contentChanges: [{ text: 'a' }],
            });
            assert.strictEqual(typeof scheduled, 'function');
            scheduled();
            assert.deepStrictEqual(commands, ['editor.action.triggerSuggest']);
            trigger.dispose();
            done();
        });

        it('waits for two effective path characters before opening suggestions', () => {
            let scheduled = null;
            const doc = {
                uri: { fsPath: '/x/main.k' },
                languageId: 'lsdyna',
                lineAt: () => ({ text: 'm' }),
            };
            const trigger = createIncludePathSuggestTrigger({
                schedule: fn => { scheduled = fn; return 1; },
                cancel: () => {},
                isLsdynaDocument: () => true,
                isIncludeFilenameContext: () => true,
                getActiveEditor: () => ({
                    document: doc,
                    selection: { active: { line: 1, character: 1 } },
                }),
                executeCommand: () => { throw new Error('should not fire'); },
            });

            trigger.onDidChangeTextDocument({ document: doc, contentChanges: [{ text: 'm' }] });
            assert.strictEqual(scheduled, null);
            trigger.dispose();
        });

        it('does not fire on non-include context', () => {
            const commands = [];
            let scheduled = null;
            const doc = { uri: { fsPath: '/x/main.k' }, languageId: 'lsdyna' };
            const trigger = createIncludePathSuggestTrigger({
                debounceMs: 10,
                schedule: (fn) => {
                    scheduled = fn;
                    return 1;
                },
                cancel: () => {},
                isLsdynaDocument: () => true,
                isIncludeFilenameContext: () => false,
                getActiveEditor: () => ({
                    document: doc,
                    selection: { active: { line: 2, character: 1 } },
                }),
                executeCommand: (cmd) => commands.push(cmd),
            });

            trigger.onDidChangeTextDocument({
                document: doc,
                contentChanges: [{ text: '1' }],
            });
            assert.strictEqual(scheduled, null);
            assert.deepStrictEqual(commands, []);
            trigger.dispose();
        });

        it('skips when suggest already visible', () => {
            let scheduled = null;
            const doc = { uri: { fsPath: '/x/main.k' }, languageId: 'lsdyna' };
            const trigger = createIncludePathSuggestTrigger({
                debounceMs: 10,
                schedule: (fn) => {
                    scheduled = fn;
                    return 1;
                },
                cancel: () => {},
                isLsdynaDocument: () => true,
                isIncludeFilenameContext: () => true,
                isSuggestVisible: () => true,
                getActiveEditor: () => ({
                    document: doc,
                    selection: { active: { line: 1, character: 1 } },
                }),
                executeCommand: () => {
                    throw new Error('should not fire');
                },
            });

            trigger.onDidChangeTextDocument({
                document: doc,
                contentChanges: [{ text: 'a' }],
            });
            assert.strictEqual(scheduled, null);
            trigger.dispose();
        });
    });
});
