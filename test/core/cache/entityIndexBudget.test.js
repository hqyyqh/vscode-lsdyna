'use strict';
const assert = require('node:assert/strict');
const { entityIndexBudget } = require('../../../out/core/cache/entityIndexBudget');

describe('Shared entity index budget', () => {
    it('partitions the configured budget without adding separate host or worker allowances', () => {
        for (const value of [undefined, 128, 512, 2048, 4096, -1, Infinity, '512']) {
            const budget = entityIndexBudget(value);
            assert.equal(budget.hostBytes + budget.liveBytes + budget.resultBytes + budget.workerBytes,
                budget.memoryBytes);
            assert.ok(budget.workerBytes >= 64 * 1024 ** 2);
            assert.equal(budget.diskBytes, 4 * 1024 ** 3);
        }
        assert.equal(entityIndexBudget().memoryBytes, 512 * 1024 ** 2);
        assert.equal(entityIndexBudget(1024, 2048).diskBytes, 2 * 1024 ** 3);
        assert.equal(entityIndexBudget(0, NaN).memoryBytes, 128 * 1024 ** 2);
    });
});
