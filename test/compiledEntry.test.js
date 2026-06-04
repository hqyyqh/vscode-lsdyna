'use strict';

const assert = require('assert');
require('./helpers');

describe('compiled extension entry', () => {
    it('loads activate and deactivate from out/extension.js', () => {
        const extension = require('../out/extension');
        assert.equal(typeof extension.activate, 'function');
        assert.equal(typeof extension.deactivate, 'function');
    });
});
