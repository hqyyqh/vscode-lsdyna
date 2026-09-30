'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require('./helpers');
const vscode = require('./vscode-mock');
const { lookupKeywordSchema, STANDARD_NUMBERED_ALIASES } = require('../out/core/keywordSchema');
const { LsdynaFieldHoverProvider } = require('../out/extension')._internals;

describe('standard numbered material and EOS aliases hover', function () {
    this.timeout(30000);

    it('contains all 31 high-value numbered material and EOS aliases', () => {
        const expectedAliases = [
            'MAT_041', 'MAT_042', 'MAT_043', 'MAT_044', 'MAT_045',
            'MAT_046', 'MAT_047', 'MAT_048', 'MAT_049', 'MAT_050',
            'MAT_054', 'MAT_055', 'MAT_084_REINF', 'MAT_122_3D',
            'MAT_122_TABULATED', 'MAT_135_PLC', 'MAT_160', 'MAT_230_FLUID',
            'MAT_BILKHU', 'MAT_BILKHU_DUBOIS_FOAM', 'MAT_CONSTRAINED',
            'EOS_022', 'EOS_023', 'EOS_024', 'EOS_025', 'EOS_026',
            'EOS_027', 'EOS_028', 'EOS_029', 'EOS_030', 'EOS_042',
        ];
        assert.equal(Object.keys(STANDARD_NUMBERED_ALIASES).length, expectedAliases.length);
        for (const alias of expectedAliases) {
            assert.ok(STANDARD_NUMBERED_ALIASES[alias], `Missing alias: ${alias}`);
        }
    });

    it('resolves schema lookups for all numbered aliases and their TITLE variants', () => {
        for (const [alias, canonical] of Object.entries(STANDARD_NUMBERED_ALIASES)) {
            const lookup = lookupKeywordSchema(alias);
            assert.ok(lookup, `lookup failed for ${alias}`);
            assert.equal(lookup.canonicalName, canonical, `canonical mismatch for ${alias}`);

            const titleLookup = lookupKeywordSchema(`${alias}_TITLE`);
            assert.ok(titleLookup, `TITLE lookup failed for ${alias}_TITLE`);
            assert.equal(titleLookup.canonicalName, canonical, `TITLE canonical mismatch for ${alias}`);
            assert.deepEqual(titleLookup.activeOptions, ['TITLE']);
        }
    });

    it('provides valid hover for all 31 aliases and TITLE variants', async () => {
        const hoverProvider = new LsdynaFieldHoverProvider();
        const { loadKeywordSchema } = require('../out/core/keywordSchema');
        const schema = loadKeywordSchema();

        for (const [alias, canonical] of Object.entries(STANDARD_NUMBERED_ALIASES)) {
            const expectedField = schema[canonical].c[0][0].n;

            // Test bare keyword
            const doc = fakeDoc([
                `*${alias}`,
                '         1' + ' '.repeat(70),
                '*END'
            ].join('\n'));
            const hover = await hoverProvider.provideHover(doc, new vscode.Position(1, 1));
            assert.ok(hover, `hover failed for ${alias}`);
            assert.match(hover.contents[0].value, new RegExp(`\\*\\*${expectedField}\\*\\*`),
                `hover for ${alias} should show ${expectedField}`);

            // Test lowercase
            const lowerDoc = fakeDoc([
                `*${alias.toLowerCase()}`,
                '         1' + ' '.repeat(70),
                '*END'
            ].join('\n'));
            const lowerHover = await hoverProvider.provideHover(lowerDoc, new vscode.Position(1, 1));
            assert.ok(lowerHover, `lowercase hover failed for ${alias.toLowerCase()}`);
            assert.match(lowerHover.contents[0].value, new RegExp(`\\*\\*${expectedField}\\*\\*`));

            // Test TITLE variant
            const titleDoc = fakeDoc([
                `*${alias}_TITLE`,
                'My Material Title Heading',
                '         1' + ' '.repeat(70),
                '*END'
            ].join('\n'));
            const titleHover = await hoverProvider.provideHover(titleDoc, new vscode.Position(1, 1));
            assert.ok(titleHover, `TITLE hover line 1 failed for ${alias}_TITLE`);
            assert.match(titleHover.contents[0].value, /\*\*TITLE\*\*/);

            const cardHover = await hoverProvider.provideHover(titleDoc, new vscode.Position(2, 1));
            assert.ok(cardHover, `TITLE card hover line 2 failed for ${alias}_TITLE`);
            assert.match(cardHover.contents[0].value, new RegExp(`\\*\\*${expectedField}\\*\\*`));
        }
    });
});
