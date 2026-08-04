'use strict';

const assert = require('assert');
const path = require('path');

const { fakeDoc, vscodeMock } = require('../helpers');
const i18n = require('../../src/core/i18n');

describe('keyword aliases and default valid keywords', () => {
    it('does not warn for lowercase keywords by default, but does when opted in', () => {
        const keywordValidator = require('../../src/core/parser/keywordValidator');
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        keywordValidator.init(new Set(['NODE']));

        try {
            // Default: lowercase keywords are valid LS-DYNA, so no warning.
            const offDiagnostics = keywordValidator.collectKeywordValidationDiagnostics(fakeDoc(' \t*node\n'));
            assert.equal(offDiagnostics.filter(d => /lowercase/i.test(d.message)).length, 0);

            // Opt-in: warnLowercaseKeyword = true restores the warning, indent and all.
            vscodeMock.workspace.getConfiguration = () => ({
                get: (key, defaultValue) => (key === 'warnLowercaseKeyword' ? true : defaultValue),
            });
            const onDiagnostics = keywordValidator.collectKeywordValidationDiagnostics(fakeDoc(' \t*node\n'));
            const lowercaseWarnings = onDiagnostics.filter(d => /lowercase/i.test(d.message));
            assert.equal(lowercaseWarnings.length, 1);
            assert.match(lowercaseWarnings[0].message, /lowercase/i);
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

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

    it('supplies every retired hardcoded alias from generated schema metadata', () => {
        const { getAliases } = require('../../src/core/keywordUtils');
        const retiredPairs = [
            ['CONTROL_TIMESTEP', 'CONTROL_TIME_STEP'],
            ['MAT_034', 'MAT_FABRIC'],
            ['MAT_058', 'MAT_LAMINATED_COMPOSITE_FABRIC'],
            ['MAT_058_SOLID', 'MAT_LAMINATED_COMPOSITE_FABRIC_SOLID'],
            ['MAT_077_H', 'MAT_HYPERELASTIC_RUBBER'],
            ['MAT_077_O', 'MAT_OGDEN_RUBBER'],
            ['MAT_MODIFIED_JOHNSON_COOK', 'MAT_107'],
            ['MAT_124', 'MAT_PLASTICITY_COMPRESSION_TENSION'],
            ['MAT_181', 'MAT_SIMPLIFIED_RUBBER/FOAM'],
            ['MAT_138', 'MAT_COHESIVE_MIXED_MODE'],
            ['MAT_196', 'MAT_GENERAL_SPRING_DISCRETE_BEAM'],
            ['MAT_023', 'MAT_TEMPERATURE_DEPENDENT_ORTHOTROPIC'],
            ['MAT_295', 'MAT_ANISOTROPIC_HYPERELASTIC'],
            ['SET_NODE_LIST', 'SET_NODE'],
            ['SET_PART_LIST', 'SET_PART'],
        ];

        for (const [left, right] of retiredPairs) {
            assert.ok(getAliases(left).includes(right), `${left} should resolve to ${right}`);
            assert.ok(getAliases(right).includes(left), `${right} should resolve to ${left}`);
        }
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
            get: (key, defaultValue) => {
                if (key === 'customValidKeywords') return undefined;
                if (key === 'unknownKeywordSeverity') return defaultValue || 'error';
                return defaultValue;
            },
        });

        try {
            keywordValidator.init(new Set(['KEYWORD']));
            const doc = fakeDoc('*TITLE\n*CASE_BEGIN\n*CASE_END\n*CASE_BEGIN_1\n*CASE_END_2\n*UNKNOWN_CASE_TOKEN\n');
            const diagnostics = keywordValidator.collectKeywordValidationDiagnostics(doc);

            assert.equal(diagnostics.length, 1);
            assert.equal(diagnostics[0].code, 'unknown-keyword');
            assert.equal(diagnostics[0].unknownKeyword, 'UNKNOWN_CASE_TOKEN');
            assert.match(diagnostics[0].message, /UNKNOWN_CASE_TOKEN/);
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('marks unknown keywords with stable diagnostic code for quick fixes', () => {
        const keywordValidator = require('../../src/core/parser/keywordValidator');
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;

        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => {
                if (key === 'customValidKeywords') return ['*END'];
                if (key === 'unknownKeywordSeverity') return defaultValue || 'error';
                return defaultValue;
            },
        });

        try {
            keywordValidator.init(new Set(['NODE']));
            const doc = fakeDoc('*NODE\n*NOT_IN_LIBRARY\n');
            const diagnostics = keywordValidator.collectKeywordValidationDiagnostics(doc);
            assert.equal(diagnostics.length, 1);
            assert.equal(diagnostics[0].code, 'unknown-keyword');
            assert.equal(diagnostics[0].unknownKeyword, 'NOT_IN_LIBRARY');
            assert.equal(diagnostics[0].source, 'lsdyna');
            assert.equal(diagnostics[0].message, i18n.get('unknownKeyword', 'NOT_IN_LIBRARY'));
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('accepts keywords covered by custom valid list without unknown diagnostic', () => {
        const keywordValidator = require('../../src/core/parser/keywordValidator');
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;

        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => {
                if (key === 'customValidKeywords') return ['*END', '*NOT_IN_LIBRARY'];
                if (key === 'unknownKeywordSeverity') return defaultValue;
                return defaultValue;
            },
        });

        try {
            keywordValidator.init(new Set(['NODE']));
            const doc = fakeDoc('*NOT_IN_LIBRARY\n');
            const diagnostics = keywordValidator.collectKeywordValidationDiagnostics(doc);
            assert.equal(diagnostics.length, 0);
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('maps unknownKeywordSeverity to diagnostic severity and supports off', () => {
        const keywordValidator = require('../../src/core/parser/keywordValidator');
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;

        assert.equal(
            keywordValidator.resolveUnknownKeywordSeverity('warning'),
            vscodeMock.DiagnosticSeverity.Warning
        );
        assert.equal(
            keywordValidator.resolveUnknownKeywordSeverity('hint'),
            vscodeMock.DiagnosticSeverity.Hint
        );
        assert.equal(keywordValidator.resolveUnknownKeywordSeverity('off'), null);
        assert.equal(
            keywordValidator.resolveUnknownKeywordSeverity('nope'),
            vscodeMock.DiagnosticSeverity.Error
        );

        const runWith = (severityMode) => {
            vscodeMock.workspace.getConfiguration = () => ({
                get: (key, defaultValue) => {
                    if (key === 'customValidKeywords') return ['*END'];
                    if (key === 'unknownKeywordSeverity') return severityMode;
                    return defaultValue;
                },
            });
            keywordValidator.init(new Set(['NODE']));
            return keywordValidator.collectKeywordValidationDiagnostics(
                fakeDoc('*NOT_IN_LIBRARY\n**BAD\n')
            );
        };

        try {
            const asWarning = runWith('warning');
            const unknown = asWarning.find(d => d.code === 'unknown-keyword');
            assert.ok(unknown);
            assert.equal(unknown.severity, vscodeMock.DiagnosticSeverity.Warning);

            const asOff = runWith('off');
            assert.equal(asOff.filter(d => d.code === 'unknown-keyword').length, 0);
            // ** format errors are independent of unknownKeywordSeverity
            assert.ok(asOff.some(d => /invalid|无效|format/i.test(d.message)));
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('validates generated title variants and aliases without accepting CONTACT option prefixes', () => {
        const keywordValidator = require('../../src/core/parser/keywordValidator');
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;

        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => {
                if (key === 'customValidKeywords') return undefined;
                if (key === 'unknownKeywordSeverity') return defaultValue || 'error';
                return defaultValue;
            },
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

            assert.equal(diagnostics.length, 1);
            assert.equal(diagnostics[0].code, 'unknown-keyword');
            assert.equal(diagnostics[0].unknownKeyword, 'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_F');
            assert.match(diagnostics[0].message, /CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_F/);
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

    it('routes LS-DYNA cell navigation safely in snippets and with multiple selections', () => {
        const packageJson = require(path.join('..', '..', 'package.json'));
        const keybindings = packageJson.contributes.keybindings;

        for (const command of [
            'extension.lsdynaTab',
            'extension.lsdynaShiftTab',
            'extension.lsdynaSelectCell',
        ]) {
            const binding = keybindings.find(item => item.command === command);
            assert.ok(binding, `${command} keybinding should exist`);
            assert.ok(!binding.when.includes('!inSnippetMode'));
            assert.ok(binding.when.includes('lsdyna.shouldAlignTab'));
            if (command === 'extension.lsdynaSelectCell') {
                assert.ok(!binding.when.includes('!editorHasMultipleSelections'));
            } else {
                assert.ok(binding.when.includes('!editorHasMultipleSelections'));
            }
        }
    });
});
