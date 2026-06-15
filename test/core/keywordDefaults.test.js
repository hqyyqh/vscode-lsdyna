'use strict';

const assert = require('assert');
const path = require('path');

const { fakeDoc, vscodeMock } = require('../helpers');

describe('keyword aliases and default valid keywords', () => {
    it('treats SET_PART and SET_PART_LIST as aliases in both directions', () => {
        const { getAliases } = require('../../src/core/keywordUtils');

        assert.ok(getAliases('SET_PART').includes('SET_PART_LIST'));
        assert.ok(getAliases('SET_PART_LIST').includes('SET_PART'));
        assert.ok(getAliases('*SET_PART').includes('*SET_PART_LIST'));
        assert.ok(getAliases('*SET_PART_LIST').includes('*SET_PART'));
    });

    it('allows CASE_BEGIN and CASE_END from fallback custom valid keywords', () => {
        const keywordValidator = require('../../src/core/parser/keywordValidator');
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;

        vscodeMock.workspace.getConfiguration = () => ({
            get: () => undefined,
        });

        try {
            keywordValidator.init(new Set(['KEYWORD']));
            const doc = fakeDoc('*CASE_BEGIN\n*CASE_END\n*UNKNOWN_CASE_TOKEN\n');
            const diagnostics = keywordValidator.collectKeywordValidationDiagnostics(doc);

            assert.deepEqual(
                diagnostics.map(diagnostic => diagnostic.message),
                ['Unknown or invalid keyword: *UNKNOWN_CASE_TOKEN']
            );
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('declares CASE_BEGIN and CASE_END in package custom valid keyword defaults', () => {
        const packageJson = require(path.join('..', '..', 'package.json'));
        const defaults = packageJson.contributes.configuration.properties['lsdyna.customValidKeywords'].default;

        assert.ok(defaults.includes('*END'));
        assert.ok(defaults.includes('*CASE_BEGIN'));
        assert.ok(defaults.includes('*CASE_END'));
    });

    it('disables cursor-leave auto formatting by default', () => {
        const packageJson = require(path.join('..', '..', 'package.json'));
        const autoFormat = packageJson.contributes.configuration.properties['lsdyna.autoFormat'];

        assert.equal(autoFormat.default, 'disabled');
    });
});
