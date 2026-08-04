'use strict';

const assert = require('assert');
const {
    changeLooksLikeIncludePathTyping,
    createIncludePathSuggestTrigger,
} = require('../../../src/client/services/includePathSuggestTrigger');

describe('includePathSuggestTrigger', () => {
    describe('changeLooksLikeIncludePathTyping', () => {
        it('accepts path-ish inserts and rejects pure deletes', () => {
            assert.strictEqual(changeLooksLikeIncludePathTyping([{ text: 'm' }]), true);
            assert.strictEqual(changeLooksLikeIncludePathTyping([{ text: 'sub/' }]), true);
            assert.strictEqual(changeLooksLikeIncludePathTyping([{ text: '' }]), false);
            assert.strictEqual(changeLooksLikeIncludePathTyping([]), false);
        });
    });

    describe('createIncludePathSuggestTrigger', () => {
        it('fires triggerSuggest after debounce on include filename card', (done) => {
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
                isIncludeFilenameContext: () => true,
                getActiveEditor: () => ({
                    document: doc,
                    selection: { active: { line: 1, character: 3 } },
                }),
                executeCommand: (cmd) => {
                    commands.push(cmd);
                },
            });

            trigger.onDidChangeTextDocument({
                document: doc,
                contentChanges: [{ text: 'mat' }],
            });
            assert.strictEqual(typeof scheduled, 'function');
            scheduled();
            assert.deepStrictEqual(commands, ['editor.action.triggerSuggest']);
            trigger.dispose();
            done();
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
