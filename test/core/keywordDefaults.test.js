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

    it('reads generated aliases from field_data metadata', () => {
        const { getAliases } = require('../../src/core/keywordUtils');

        assert.ok(getAliases('ALE_STRUCTURED_MULTI-MATERIAL_GROUP').includes('ALE_STRUCTURED_MULTI_MATERIAL_GROUP'));
        assert.ok(getAliases('ALE_STRUCTURED_MULTI_MATERIAL_GROUP').includes('ALE_STRUCTURED_MULTI-MATERIAL_GROUP'));
    });

    it('keeps title suffix stripping scoped to manual keyword normalization', () => {
        const keywordUtils = require('../../src/core/keywordUtils');

        assert.equal(typeof keywordUtils.stripTitleSuffix, 'function');
        assert.equal(Object.prototype.hasOwnProperty.call(keywordUtils, 'hasTitleSuffix'), false);
    });

    it('allows TITLE, CASE_BEGIN, and CASE_END from fallback custom valid keywords', () => {
        const keywordValidator = require('../../src/core/parser/keywordValidator');
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;

        vscodeMock.workspace.getConfiguration = () => ({
            get: () => undefined,
        });

        try {
            keywordValidator.init(new Set(['KEYWORD']));
            const doc = fakeDoc('*TITLE\n*CASE_BEGIN\n*CASE_END\n*UNKNOWN_CASE_TOKEN\n');
            const diagnostics = keywordValidator.collectKeywordValidationDiagnostics(doc);

            assert.deepEqual(
                diagnostics.map(diagnostic => diagnostic.message),
                ['Unknown or invalid keyword: *UNKNOWN_CASE_TOKEN']
            );
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('validates generated title variants and aliases without accepting CONTACT option prefixes', () => {
        const keywordValidator = require('../../src/core/parser/keywordValidator');
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;

        vscodeMock.workspace.getConfiguration = () => ({
            get: () => undefined,
        });

        try {
            keywordValidator.init(new Set([
                'MAT_001',
                'SET_NODE_LIST',
                'SET_PART_LIST',
                'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE'
            ]));
            const doc = fakeDoc([
                '*MAT_001_TITLE',
                '*SET_NODE',
                '*SET_NODE_TITLE',
                '*SET_PART',
                '*SET_PART_TITLE',
                '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_F'
            ].join('\n'));
            const diagnostics = keywordValidator.collectKeywordValidationDiagnostics(doc);

            assert.deepEqual(
                diagnostics.map(diagnostic => diagnostic.message),
                ['Unknown or invalid keyword: *CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_F']
            );
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('declares TITLE, CASE_BEGIN, and CASE_END in package custom valid keyword defaults', () => {
        const packageJson = require(path.join('..', '..', 'package.json'));
        const defaults = packageJson.contributes.configuration.properties['lsdyna.customValidKeywords'].default;

        assert.ok(defaults.includes('*END'));
        assert.ok(defaults.includes('*TITLE'));
        assert.ok(defaults.includes('*CASE_BEGIN'));
        assert.ok(defaults.includes('*CASE_END'));
    });

    it('disables cursor-leave auto formatting by default and marks it experimental', () => {
        const packageJson = require(path.join('..', '..', 'package.json'));
        const autoFormat = packageJson.contributes.configuration.properties['lsdyna.autoFormat'];

        assert.equal(autoFormat.default, 'disabled');
        assert.deepEqual(autoFormat.tags, ['experimental']);
    });

    it('generates SET aliases and title snippets that keep the alias keyword line', () => {
        const snippets = require(path.join('..', '..', 'snippets', 'lsdyna.json'));

        for (const keyword of ['*SET_NODE_TITLE', '*SET_PART', '*SET_PART_TITLE']) {
            assert.ok(snippets[keyword], `${keyword} snippet should exist`);
            assert.equal(snippets[keyword].body[0], keyword);
        }
    });

    it('keeps INCLUDE_PATH snippet comment headers within 80 columns', () => {
        const snippets = require(path.join('..', '..', 'snippets', 'lsdyna.json'));

        for (const keyword of ['*INCLUDE_PATH', '*INCLUDE_PATH_RELATIVE']) {
            assert.ok(snippets[keyword], `${keyword} snippet should exist`);
            assert.equal(snippets[keyword].body[1], '$# path');
            assert.ok(snippets[keyword].body[1].length <= 80);
        }
    });

    it('allows LS-DYNA tab alignment while keyword snippets are active', () => {
        const packageJson = require(path.join('..', '..', 'package.json'));
        const keybindings = packageJson.contributes.keybindings;

        for (const command of ['extension.lsdynaTab', 'extension.lsdynaShiftTab']) {
            const binding = keybindings.find(item => item.command === command);
            assert.ok(binding, `${command} keybinding should exist`);
            assert.ok(!binding.when.includes('!inSnippetMode'));
            assert.ok(binding.when.includes('lsdyna.shouldAlignTab'));
        }
    });
});
