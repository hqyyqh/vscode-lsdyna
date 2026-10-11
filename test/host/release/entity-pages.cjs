'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');
const { fetchJson, openSocket, createCdp } = require('../../support/devtools.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.check = async (root, checks) => {
    const file = path.join(root, 'workspace', 'entity-pages.k');
    const source = '*KEYWORD\n*DEFINE_CURVE\n1\n0,0\n1,1\n' +
        '*LOAD_BODY_Z\n1,1.0\n'.repeat(450) + '*END\n';
    fs.writeFileSync(file, source);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    const info = await fetchJson(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/json/version`);
    const socket = await openSocket(info.webSocketDebuggerUrl), cdp = createCdp(socket);
    const contexts = new Map(), attached = new Set();
    socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        if (message.method === 'Runtime.executionContextCreated') contexts.set(`${message.sessionId}:${message.params.context.id}`,
            { contextId: message.params.context.id, sessionId: message.sessionId });
        if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(`${message.sessionId}:${message.params.executionContextId}`);
    });
    const evaluate = async (context, expression) => {
        const value = await cdp.call('Runtime.evaluate', { ...context, expression, returnByValue: true, awaitPromise: true }, context.sessionId);
        if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails));
        return value.result.value;
    };
    async function findView() {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            const { targetInfos } = await cdp.call('Target.getTargets');
            for (const target of targetInfos.filter(target => ['page', 'iframe'].includes(target.type))) {
                if (attached.has(target.targetId)) continue;
                const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                attached.add(target.targetId); await cdp.call('Runtime.enable', {}, sessionId);
            }
            for (const context of contexts.values()) {
                try { if (await evaluate(context, '!!document.querySelector(".result-row")')) return context; } catch {}
            }
            await delay(50);
        }
        throw Error('Entity references webview did not render');
    }
    try {
        for (const language of ['zh-cn', 'en']) {
            await vscode.workspace.getConfiguration('lsdyna').update('language', language, vscode.ConfigurationTarget.Global);
            await vscode.window.showTextDocument(document);
            const result = await vscode.commands.executeCommand('extension.queryLsdynaEntityId', { targetKind: 'curve', id: 1 });
            assert.equal(result.locations.filter(item => item.role === 'reference').length, 200);
            assert.equal(result.page.counts.reference, 450);
            assert.ok(result.page.next.reference, 'Installed sidebar must use worker pagination');
            const nextPage = await result.loadPage(result.page.next.reference);
            assert.equal(nextPage.status, 'ready');
            assert.equal(nextPage.result.locations.length, 200);
            const context = await findView();
            for (const count of [200, 400, 450]) {
                const deadline = Date.now() + 10000;
                while (await evaluate(context, 'document.querySelectorAll(".result-row").length') !== count) {
                    if (Date.now() > deadline) throw Error(`Expected ${count} reference rows: ` + JSON.stringify({
                        session: { state: result.querySession.state, reasons: result.querySession.reasons,
                            rows: result.querySession.locations.length, next: result.querySession.page?.next },
                        dom: await evaluate(context, 'document.body.innerText'),
                    }));
                    await delay(50);
                }
                if (count !== 450) assert.equal(await evaluate(context, `(() => {
                    const button = [...document.querySelectorAll('button')].find(button => /加载更多|Load more/i.test(button.textContent));
                    if (!button) return false; button.click(); return true;
                })()`), true);
            }
            const targets = await cdp.call('Target.getTargets');
            const workbench = targets.targetInfos.find(target => target.type === 'page' && target.url.includes('workbench'));
            const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: workbench.targetId, flatten: true });
            const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' }, sessionId);
            fs.writeFileSync(path.join(root, `entity-pages-${language}.png`), Buffer.from(screenshot.data, 'base64'));
            checks.push(`entity-pages ${language}: 200/400/450 real rendered rows`);
        }
        assert.equal(document.getText(), source); assert.equal(fs.readFileSync(file, 'utf8'), source);
    } finally { cdp.close(); }
};
