'use strict';
const assert = require('node:assert/strict');
const plan=require("../../fixtures/public-behavior/particle-pending-tails.json");
const bindings=require("../../../keywords/runtime/native-readers/lspp-optional-form-header-readers.json");

describe('AIRBAG_PARTICLE realigned native cohort', () => {
    it('keeps control-dependent tails pending rather than publishing an unconditional reader', () => {
        assert.ok(plan.tasks.every(task => task.unverifiedMechanisms.includes('particle-control-dependent-tail')));
        const text = JSON.stringify(bindings);
        for (const keyword of new Set(plan.tasks.map(task => task.keyword)))
            assert.equal(text.includes(`\"${keyword}\"`), false, keyword);
    });
});
