'use strict';

const assert = require('assert');
const path = require('path');
const { validateProjectContracts } = require('../scripts/validate-project-contracts.cjs');

describe('project contracts', () => {
    it('keeps manifest, documentation, localization, activation, and UTF-8 contracts valid', () => {
        const errors = validateProjectContracts(path.resolve(__dirname, '..'));
        assert.deepEqual(errors, []);
    });
});
