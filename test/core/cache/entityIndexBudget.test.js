'use strict';
const assert = require('node:assert/strict');
const { entityIndexBudget } = require('../../../out/core/cache/entityIndexBudget');
const MiB = 1024 ** 2, GiB = 1024 ** 3;
const memory = (available = 8 * GiB, total = 16 * GiB) => ({ available: () => available, free: () => 4 * GiB, total: () => total });
describe('Shared entity index budget', () => {
    it('selects each automatic ceiling and rounds down to MiB', () => {
        for (const [available, total, expected] of [[4 * GiB,16 * GiB,409],[16 * GiB,16 * GiB,819],[64 * GiB,64 * GiB,2048]]) {
            const budget = entityIndexBudget('auto', undefined, memory(available,total));
            assert.equal(budget.memoryBytes, expected * MiB); assert.equal(budget.mode,'auto');
            assert.equal(budget.hostBytes + budget.liveBytes + budget.resultBytes + budget.workerBytes,budget.memoryBytes);
        }
    });
    it('preserves explicit numeric budgets without consulting available memory', () => {
        let reads = 0; const fail = () => { reads++; throw Error('must not sample'); };
        for (const [value,expected] of [[128,128],[512,512],[2048,2048],[4096,4096],[0,128],[9999,4096]]) {
            const budget = entityIndexBudget(value,2048,{available:fail,free:fail,total:fail});
            assert.equal(budget.memoryBytes,expected * MiB); assert.equal(budget.mode,'manual');
            assert.equal(budget.blocked,false); assert.equal(budget.diskBytes,2 * GiB);
        }
        assert.equal(reads,0);
    });
    it('falls back if the process API is unavailable or invalid but honors zero', () => {
        for (const available of [() => undefined,() => {throw Error('unavailable');},() => NaN]) {
            const budget = entityIndexBudget('auto',undefined,{...memory(),available});
            assert.equal(budget.memoryBytes,409 * MiB); assert.equal(budget.memorySource,'os.freemem');
        }
        assert.equal(entityIndexBudget('auto',undefined,memory(0)).calculatedBytes,0);
    });
    it('blocks below 128 MiB without inflating low or unknown budgets', () => {
        for (const available of [0,1279 * MiB]) {
            const budget = entityIndexBudget('auto',undefined,memory(available));
            assert.equal(budget.blocked,true); assert.equal(budget.memoryBytes,0);
            assert.equal(budget.workerBytes,0); assert.equal(budget.hostBytes,0);
        }
        assert.equal(entityIndexBudget('auto',undefined,memory(1280 * MiB)).memoryBytes,128 * MiB);
        assert.equal(entityIndexBudget('auto',undefined,memory(8 * GiB,NaN)).blocked,true);
    });
    it('samples once and keeps the budget when memory pressure changes', () => {
        let available = 8 * GiB,reads = 0;
        const budget = entityIndexBudget(undefined,undefined,{...memory(),available:()=>{reads++;return available;}});
        available=0;
        assert.equal(budget.memoryBytes,819 * MiB); assert.equal(reads,1); assert(Object.isFrozen(budget));
    });
    it('keeps numeric settings and changes only the default to auto', () => {
        const setting = require('../../../package.json').contributes.configuration.properties['lsdyna.cache.entityIndexMemoryMaxMiB'];
        assert.equal(setting.default,'auto'); assert.deepEqual(setting.type,['number','string']);
        assert.equal(setting.minimum,128); assert.equal(setting.maximum,4096); assert.equal(setting.pattern,'^auto$');
    });
});
