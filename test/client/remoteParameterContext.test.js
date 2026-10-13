const assert = require('node:assert/strict');
const { createRemoteParameterContext } = require('../../out/client/services/remoteParameterContext');
describe('bounded remote parameter values', () => {
    it('batches only requested positions and reuses values without importing an environment', async () => {
        const pages = [];
        const context = createRemoteParameterContext(1, async fields => {
            pages.push(fields); return { status: 'ready', results: fields.map(field => ({ resolved: true, value: field.line / 2 })) };
        }, () => true);
        for (let line = 0; line < 205; line++) assert.equal(context.resolve('&A', line, true).resolved, false);
        assert.equal(await context.flush(), true);
        assert.deepEqual(pages.map(page => page.length), [200,5]);
        assert.equal(context.resolve('&A', 3, true).value, 1.5);
        assert.equal(await context.flush(), false);
    });
    it('discards a late response and cancels its consumer after a version change', async () => {
        let valid = true, finish, token;
        const context = createRemoteParameterContext(1, async (_fields, currentToken) => {
            token = currentToken; await new Promise(resolve => { finish = resolve; });
            return { status:'ready', results:[{resolved:true,value:42}] };
        }, () => valid);
        context.resolve('&A', 1);
        const pending = context.flush(); valid = false;
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(token.isCancellationRequested, true); finish();
        assert.equal(await pending, false);
        assert.equal(context.resolve('&A',1).reasons[0], 'parameter-context-stale');
    });
    it('keeps oversized expressions and out-of-range controllers unresolved', async () => {
        const context = createRemoteParameterContext(1, async fields => ({ status:'ready',
            results: fields.map(()=>({resolved:true,value:2147483648})) }),()=>true);
        assert.equal(context.resolve('x'.repeat(16385),1).reasons[0], 'parameter-evaluation-budget');
        context.resolve('&A',1); await context.flush();
        assert.equal(context.resolve('&A',1).reasons[0], 'parameter-control-outside-int32');
    });
    it('preserves a backend resource limit rather than reporting an undefined parameter', async () => {
        const context = createRemoteParameterContext(1, async()=>({status:'limited',reasons:['source-analysis-budget']}),()=>true);
        context.resolve('&A',1); await context.flush();
        assert.deepEqual(context.resolve('&A',1),{resolved:false,reasons:['parameter-evaluation-budget']});
    });
});
