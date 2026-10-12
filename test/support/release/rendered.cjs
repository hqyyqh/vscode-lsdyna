'use strict';
const { fetchJson, openSocket, createCdp } = require('../devtools.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Observe the real Webview; command completion alone does not mean it is usable.
async function connect(port, { offline = false } = {}) {
    const info = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const socket = await openSocket(info.webSocketDebuggerUrl), cdp = createCdp(socket);
    const contexts = new Map(), attached = new Set();
    socket.addEventListener('message', event => {
        const m = JSON.parse(String(event.data));
        if (m.method === 'Runtime.executionContextCreated') contexts.set(`${m.sessionId}:${m.params.context.id}`,
            { sessionId: m.sessionId, contextId: m.params.context.id });
        if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(`${m.sessionId}:${m.params.executionContextId}`);
        if (m.method === 'Runtime.executionContextsCleared')
            for (const [key, value] of contexts) if (value.sessionId === m.sessionId) contexts.delete(key);
    });
    const evaluate = async (context, expression) => {
        const result = await cdp.call('Runtime.evaluate', { contextId: context.contextId, expression,
            returnByValue: true, awaitPromise: true }, context.sessionId);
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    return { close: () => cdp.close(), evaluate,
        async wait(expression) {
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                const { targetInfos } = await cdp.call('Target.getTargets');
                for (const target of targetInfos.filter(t => ['page', 'iframe'].includes(t.type))) {
                    if (attached.has(target.targetId)) continue;
                    try {
                        const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                        await cdp.call('Runtime.enable', {}, sessionId);
                        if (offline) {
                            await cdp.call('Network.enable', {}, sessionId);
                            await cdp.call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);
                        }
                        attached.add(target.targetId);
                    } catch { /* Navigation may replace the target. */ }
                }
                // A busy unrelated frame must not delay observing the ready view.
                try {
                    return await Promise.any([...contexts.values()].map(async context => {
                        if (await evaluate(context, expression)) return context;
                        throw Error('Other or unready context');
                    }));
                } catch { /* No current context is ready; navigation may replace it. */ }
                await delay(20);
            }
            throw Error('Rendered view did not become ready: ' + expression);
        },
    };
}
module.exports = { connect };
