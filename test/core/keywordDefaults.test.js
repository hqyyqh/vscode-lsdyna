'use strict';

const assert = require('assert');
const path = require('path');

const { fakeDoc, vscodeMock } = require("../support/helpers");
const i18n = require('../../src/core/i18n');

describe('keyword aliases and default valid keywords', () => {
    it('retries failed alias sources after a bounded cooldown without caching partial aliases', () => {
        const fs = require('node:fs');
        const vm = require('node:vm');
        const filename = require.resolve('../../src/core/keywordUtils');
        const { keywordDataPath } = require('../../src/core/keywordDataPath');
        const spelling = require(keywordDataPath('engineering/keywordSpellingAliases.json'));
        let now = 0, reads = 0, unavailable = 'schema';
        const context = { module: { exports: {} }, exports: {}, performance: { now: () => now }, require(name) {
            if (name === 'fs') return { readFileSync(...args) {
                reads++;
                if (unavailable === 'schema') throw Object.assign(new Error('denied'), { code: 'EACCES' });
                return fs.readFileSync(...args);
            } };
            if (name === './keywordDataPath') return { keywordDataPath };
            if (name === keywordDataPath('engineering/keywordSpellingAliases.json')) {
                if (unavailable === 'spelling') throw new Error('spelling input unavailable');
                return spelling;
            }
            return require(name);
        } };
        context.exports = context.module.exports;
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
        const { getAliases } = context.module.exports;
        assert.equal(getAliases('SET_PART').length, 0);
        const validatorFile = require.resolve('../../src/core/parser/keywordValidator');
        const validatorRequire = require('node:module').createRequire(validatorFile);
        const validatorContext = { module: { exports: {} }, exports: {}, require(name) {
            if (name === 'vscode') return { ...vscodeMock, workspace: { ...vscodeMock.workspace,
                getConfiguration: () => ({ get: (_key, fallback) => fallback }),
            } };
            return name === '../keywordUtils' ? { getAliases } : validatorRequire(name);
        } };
        validatorContext.exports = validatorContext.module.exports;
        vm.runInNewContext(fs.readFileSync(validatorFile, 'utf8'), validatorContext, { filename: validatorFile });
        const validator = validatorContext.module.exports;
        const manualFile = require.resolve('../../src/core/manualIndexer');
        const manualRequire = require('node:module').createRequire(manualFile);
        const manualContext = vm.createContext({ module: { exports: {} }, exports: {}, require(name) {
            return name === './keywordUtils' ? context.module.exports : manualRequire(name);
        } });
        manualContext.exports = manualContext.module.exports;
        vm.runInContext(fs.readFileSync(manualFile, 'utf8'), manualContext, { filename: manualFile });
        // Seed a previously indexed bookmark; execute the actual navigation function with the same failing alias loader.
        vm.runInContext("keywordMap.set('*IGA_MASS_SETPOINT_UVW', [{ file: '/fixture/manual.pdf', page: 42 }]);", manualContext);
        const manualLocations = () => manualContext.module.exports.getManualLocations('*IGA_MASS_SET_POINT_UVW');
        validator.init(new Set(Object.keys(require('../../snippets/lsdyna.json')).map(name => name.replace(/^\*/, ''))));
        const document = fakeDoc('*IGA_MASS_SET_POINT_UVW\n*IGA_MASS_SET_FACE_XYZ\n*IGA_MASS_SET_EDGE_UVW\n*DEFINE_STOCHASTIC_ELEMENT_SHELL_VARIATION\n*DEFINE_STOCHASTIC_ELEMENT_SOLID_VARIATION');
        const unknowns = () => validator.collectKeywordValidationDiagnostics(document).filter(item => item.code === 'unknown-keyword');
        // Shared schema recognition remains available while the legacy alias loader retries.
        assert.equal(unknowns().length, 0);
        assert.equal(manualLocations().length, 1);
        for (let index = 0; index < 1000; index++) getAliases('SET_PART');
        assert.equal(reads, 1);
        unavailable = 'spelling'; now = 1000;
        assert.equal(getAliases('SET_PART').length, 0);
        assert.equal(reads, 2);
        unavailable = ''; now = 1999;
        assert.equal(getAliases('SET_PART').length, 0);
        now = 2000;
        assert.ok(getAliases('SET_PART').includes('SET_PART_LIST'));
        assert.ok(getAliases('*IGA_MASS_SET_POINT_UVW').length > 0);
        assert.equal(unknowns().length, 0);
        const locations = manualLocations();
        assert.equal(locations.length, 1);
        assert.equal(locations[0].matchedKeyword, '*IGA_MASS_SETPOINT_UVW');
        assert.equal(locations[0].requestedKeyword, '*IGA_MASS_SET_POINT_UVW');
        assert.equal(locations[0].matchKind, 'exact');
        assert.equal(locations[0].page, 42);
        assert.equal(reads, 3);
        now = 3000; unavailable = 'schema';
        assert.ok(getAliases('SET_PART').includes('SET_PART_LIST'));
        assert.equal(reads, 3);
    });
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

    it('accepts exact manual spellings backed by the locked LS-PrePost card layout', () => {
        const { getAliases } = require('../../src/core/keywordUtils');
        const source = require("../../keywords/authoring/engineering/keywordSpellingAliases.json");
        for (const item of source.aliases) {
            assert.ok(getAliases(item.manualKeyword).includes(item.schemaKeyword), item.manualKeyword);
            assert.ok(getAliases(item.schemaKeyword).includes(item.manualKeyword), item.schemaKeyword);
        }
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
        }
    });

    it('leaves Tab to snippets/inline suggestions and rejects multiple-cursor cell navigation', () => {
        const packageJson = require(path.join('..', '..', 'package.json'));
        const keybindings = packageJson.contributes.keybindings;

        for (const command of [
            'extension.lsdynaTab',
            'extension.lsdynaShiftTab',
            'extension.lsdynaSelectCell',
        ]) {
            const binding = keybindings.find(item => item.command === command);
            assert.ok(binding, `${command} keybinding should exist`);
            assert.ok(binding.when.includes('lsdyna.shouldAlignTab'));
            if (command === 'extension.lsdynaSelectCell') {
                assert.ok(!binding.when.includes('!inSnippetMode'));
                assert.ok(!binding.when.includes('!editorHasMultipleSelections'));
            } else {
                assert.ok(binding.when.includes('!inSnippetMode'));
                assert.ok(binding.when.includes('!inlineSuggestionVisible'));
                assert.ok(binding.when.includes('!inlineEditIsVisible'));
                assert.ok(binding.when.includes('!isComposing'));
                assert.ok(binding.when.includes('!editorTabMovesFocus'));
                assert.ok(binding.when.includes('!editorHasMultipleSelections'));
            }
        }

        for (const command of [
            'extension.lsdynaCellDeleteLeft',
            'extension.lsdynaCellDeleteRight',
        ]) {
            const binding = keybindings.find(item => item.command === command);
            assert.ok(binding);
            assert.ok(!binding.when.includes('!suggestWidgetVisible'));
            assert.ok(binding.when.includes('!lsdyna.inlineEditChoiceActive'));
        }

        const choiceBindings = keybindings.filter(item =>
            item.when && item.when.includes('lsdyna.inlineEditChoiceActive')
        );
        assert.ok(choiceBindings.some(item => item.key === 'enter' && item.command === 'acceptSelectedSuggestion'));
        assert.ok(choiceBindings.some(item => item.key === 'tab' && item.command === 'selectNextSuggestion'));
        assert.ok(choiceBindings.some(item => item.key === 'backspace' && item.command === 'extension.lsdynaCancelInlineEditChoice'));
    });
});
