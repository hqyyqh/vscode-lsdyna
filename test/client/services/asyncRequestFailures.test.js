'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.cwd();
const { vscodeMock: vscode } = require(path.join(root, 'test/support/helpers'));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
    const name = process.argv[2], failure = Error('fixture async request failed');
    const fail = () => name.endsWith('-throw') ? (() => { throw failure; })() : Promise.reject(failure);
    if (name.startsWith('invalidation-')) {
        const { createManifestDrivenInvalidator, createBatchedManifestInvalidator } = require(path.join(root, 'out/extension'))._internals;
        const roots = ['/project/main.k', '/project/other.k'], attempted = [], errors = [], completed = [];
        const laterFailure = Error('later synchronous invalidation failed');
        let scheduled;
        const options = {
            indexClient: { getManifestEntries: () => [], invalidate: rootFile => {
                attempted.push(rootFile);
                if (rootFile === roots[0]) return Promise.reject(failure);
                throw laterFailure;
            } }, findAffectedRoots: () => roots,
            schedule: callback => { scheduled = callback; },
            onError: error => errors.push(error), onInvalidatedRoots: values => completed.push(values),
        };
        if (name === 'invalidation-batched') {
            createBatchedManifestInvalidator(options)('/project/child.k');
            scheduled();
        } else await assert.rejects(async () => createManifestDrivenInvalidator(options)('/project/child.k'),
            error => error === failure || error === laterFailure);
        await tick(); await tick();
        assert.deepEqual(attempted, roots);
        assert.deepEqual(completed, []);
        if (name === 'invalidation-batched') {
            assert.equal(errors.length, 1);
            assert.ok(errors[0] === failure || errors[0] === laterFailure);
        }
    } else if (name.startsWith('suggest-')) {
        const { createIncludePathSuggestTrigger } = require(path.join(root, 'out/client/services/includePathSuggestTrigger'));
        const document = { lineAt: () => ({ text: 'ma' }) };
        let scheduled;
        const trigger = createIncludePathSuggestTrigger({
            isIncludeFilenameContext: () => true,
            getActiveEditor: () => ({ document, selection: { active: { line: 0, character: 2 } } }),
            executeCommand: fail, schedule: callback => { scheduled = callback; return 1; }, cancel() {},
        });
        trigger.onDidChangeTextDocument({ document, contentChanges: [{ text: 'a' }] });
        scheduled();
        await tick(); await tick(); trigger.dispose();
    } else if (name.startsWith('layout-') || name.startsWith('context-')) {
        const { LsdynaKeywordIndexProvider } = require(path.join(root, 'out/client/providers/keywordIndexProvider'));
        if (name.startsWith('context-')) vscode.commands.executeCommand = fail;
        const provider = new LsdynaKeywordIndexProvider({ workspaceState: { update: name.startsWith('layout-') ? fail : undefined } });
        assert.equal(provider.setLayout('order'), true);
        assert.equal(provider._layout, 'order');
        await tick(); await tick(); provider.stopAutomaticWork();
    } else if (name.startsWith('discovery-') || name.startsWith('plan-')) {
        const { createActiveFieldChoiceController } = require(path.join(root, 'out/client/services/activeFieldChoiceController'));
        const document = { version: 3, lineCount: 1, lineAt: () => ({ text: '1' }) };
        const editor = { document, selection: { active: { line: 0, character: 0 } } };
        const item = { show() {}, hide() {} };
        const plan = { status: 'ready', documentVersion: 3, domainKind: 'closed', choices: [{}], fieldName: 'FLAG', fieldRange: { line: 0 }, evidence: [] };
        if (name === 'plan-throw') Object.defineProperty(item, 'text', { set() { throw failure; } });
        const controller = createActiveFieldChoiceController({
            statusBarItem: item, getActiveEditor: () => editor,
            isLsdynaDocument: () => true, documentIdentity: () => 'file:///model.k',
            getStatusBarLevel: () => 'simple', setContext() {}, translate: key => key,
            plan: () => name === 'plan-reject' ? Promise.reject(failure) : name === 'plan-throw' ? Promise.resolve(plan) : plan,
            showInformationMessage: async () => 'officialFieldChoiceDiscoveryView', executeCommand: fail,
        });
        const initial = controller.refreshNow();
        if (name.startsWith('discovery-')) assert.ok(initial);
        else assert.equal(initial, null);
        await tick(); await tick(); controller.dispose();
    } else if (['english-', 'fallback-', 'evidence-'].some(prefix => name.startsWith(prefix))) {
        const { createOfficialFieldChoicePicker } = require(path.join(root, 'out/client/services/officialFieldChoicePicker'));
        let onButton, onHide;
        const quickPick = { onDidAccept() { return { dispose() {} }; }, onDidHide(callback) { onHide = callback; return { dispose() {} }; },
            onDidTriggerItemButton(callback) { onButton = callback; return { dispose() {} }; }, show() {}, dispose() {} };
        const document = { version: 3, lineCount: 1, uri: vscode.Uri.file('model.k'), lineAt: () => ({ text: '1' }) };
        const editor = { document, selection: { active: { line: 0, character: 0 } } };
        const picker = createOfficialFieldChoicePicker({ vscode: { ...vscode, window: { ...vscode.window, createQuickPick: () => quickPick, showInformationMessage: fail } },
            getActiveEditor: () => editor, isLsdynaDocument: () => true, documentIdentity: () => document.uri.toString(),
            plan: () => ({ status: 'ready', documentVersion: 3, fieldName: 'FLAG', fieldWidth: 1, fieldRange: { line: 0, startCharacter: 0, endCharacter: 1 }, domainKind: 'closed', evidence: [], choices: [{ id: 'one', valueText: '1', replacementText: '1' }] }),
            translate: key => key, openEnglish: name.startsWith('english-') ? fail : undefined, openEvidence: fail,
        });
        const pending = picker.pick();
        for (let turn = 0; !onButton && turn < 100; turn++) await tick();
        assert.equal(typeof onButton, 'function');
        onButton({ button: name.startsWith('evidence-') ? { evidence: { evidenceId: 'manual-field' } } : { englishOriginal: 'Original field description.' } });
        await tick(); await tick(); onHide(); assert.equal(await pending, null);
    } else throw Error('Unknown probe: ' + name);
    console.log(name + ': handled');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
else describe('best-effort UI request failures', () => {
    for (const name of ['invalidation-batched', 'invalidation-manifest']) it(`observes mixed async/sync failures from ${name}`, () => {
        const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', __filename, name], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(`${name}: handled`));
    });
    for (const surface of ['suggest', 'layout', 'context', 'discovery', 'english', 'fallback', 'evidence', 'plan']) for (const failure of ['reject', 'throw']) {
        it(`observes ${failure} from ${surface} without an unhandled process rejection`, () => {
            const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', __filename, `${surface}-${failure}`], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            assert.ok(result.stdout.includes(`${surface}-${failure}: handled`));
        });
    }
});
