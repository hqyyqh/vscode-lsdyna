'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { fakeDoc } = require("../../support/helpers");
const { getCardInfoForDocumentLineWithSuggest: resolve } = require("../../../out/extension")._internals;

const TEST_SPECIMENS = [
    // ISPG (1)
    {
        keyword: 'ISPG_TO_ISPG_CONTACT',
        category: 'ISPG',
        standard: [
            '*ISPG_TO_ISPG_CONTACT',
            '         1       100       200'
        ],
        comma: [
            '*ISPG_TO_ISPG_CONTACT',
            '1,100,200'
        ],
        long: [
            '*ISPG_TO_ISPG_CONTACT+',
            '                   1                 100                 200'
        ],
        i10: [
            '*ISPG_TO_ISPG_CONTACT%',
            '         1       100       200'
        ],
        expectedFields: ['CID', 'PID1', 'PID2']
    },
    // DELETE (3)
    {
        keyword: 'DELETE_DEFORMABLE_CONTROL',
        category: 'DELETE',
        standard: [
            '*DELETE_DEFORMABLE_CONTROL',
            '         1         2       1.0       0.1'
        ],
        comma: [
            '*DELETE_DEFORMABLE_CONTROL',
            '1,2,1.0,0.1'
        ],
        long: [
            '*DELETE_DEFORMABLE_CONTROL+',
            '                   1                   2                 1.0                 0.1'
        ],
        i10: [
            '*DELETE_DEFORMABLE_CONTROL%',
            '         1         2       1.0       0.1'
        ],
        expectedFields: ['NRBF', 'NCSF', 'RWF', 'DTMAX']
    },
    {
        keyword: 'DELETE_DEFORMABLE_D2R',
        category: 'DELETE',
        standard: [
            '*DELETE_DEFORMABLE_D2R',
            '         1         0'
        ],
        comma: [
            '*DELETE_DEFORMABLE_D2R',
            '1,0'
        ],
        long: [
            '*DELETE_DEFORMABLE_D2R+',
            '                   1                   0'
        ],
        i10: [
            '*DELETE_DEFORMABLE_D2R%',
            '         1         0'
        ],
        expectedFields: ['PID', 'LRB']
    },
    {
        keyword: 'DELETE_DEFORMABLE_R2D',
        category: 'DELETE',
        standard: [
            '*DELETE_DEFORMABLE_R2D',
            '         1'
        ],
        comma: [
            '*DELETE_DEFORMABLE_R2D',
            '1,'
        ],
        long: [
            '*DELETE_DEFORMABLE_R2D+',
            '                   1'
        ],
        i10: [
            '*DELETE_DEFORMABLE_R2D%',
            '         1'
        ],
        expectedFields: ['PID']
    },
    // DAMPING (5)
    {
        keyword: 'DAMPING_FREQUENCY_RANGE_DEFORM',
        category: 'DAMPING',
        standard: [
            '*DAMPING_FREQUENCY_RANGE_DEFORM',
            '       0.1       0.1      10.0         1         0         1         0         0',
            '       0.2         0'
        ],
        comma: [
            '*DAMPING_FREQUENCY_RANGE_DEFORM',
            '0.1,0.1,10.0,1,0,1,0,0',
            '0.2,0'
        ],
        long: [
            '*DAMPING_FREQUENCY_RANGE_DEFORM+',
            '                 0.1                 0.1                10.0                   1                   0                   1                   0                   0',
            '                 0.2                   0'
        ],
        i10: [
            '*DAMPING_FREQUENCY_RANGE_DEFORM%',
            '       0.1       0.1      10.0         1         0         1         0         0',
            '       0.2         0'
        ],
        expectedFields: ['CDAMP', 'FLOW', 'FHIGH', 'PSID', 'UNUSED', 'PIDREL', 'IFLG', 'ICARD2']
    },
    {
        keyword: 'DAMPING_FREQUENCY_RANGE_DEFORM_DMIG',
        category: 'DAMPING',
        standard: [
            '*DAMPING_FREQUENCY_RANGE_DEFORM_DMIG',
            '       0.1       0.1      10.0         1         0         1         0         0',
            '       0.2         0'
        ],
        comma: [
            '*DAMPING_FREQUENCY_RANGE_DEFORM_DMIG',
            '0.1,0.1,10.0,1,0,1,0,0',
            '0.2,0'
        ],
        long: [
            '*DAMPING_FREQUENCY_RANGE_DEFORM_DMIG+',
            '                 0.1                 0.1                10.0                   1                   0                   1                   0                   0',
            '                 0.2                   0'
        ],
        i10: [
            '*DAMPING_FREQUENCY_RANGE_DEFORM_DMIG%',
            '       0.1       0.1      10.0         1         0         1         0         0',
            '       0.2         0'
        ],
        expectedFields: ['CDAMP', 'FLOW', 'FHIGH', 'PSID', 'UNUSED', 'PIDREL', 'IFLG', 'ICARD2']
    },
    {
        keyword: 'DAMPING_PART_MASS',
        category: 'DAMPING',
        standard: [
            '*DAMPING_PART_MASS',
            '         1         1       1.0         0         0',
            '       1.0       1.0       1.0       0.0       0.0       0.0'
        ],
        comma: [
            '*DAMPING_PART_MASS',
            '1,1,1.0,0,0',
            '1.0,1.0,1.0,0.0,0.0,0.0'
        ],
        long: [
            '*DAMPING_PART_MASS+',
            '                   1                   1                 1.0                   0                   0',
            '                 1.0                 1.0                 1.0                 0.0                 0.0                 0.0'
        ],
        i10: [
            '*DAMPING_PART_MASS%',
            '         1         1       1.0         0         0',
            '       1.0       1.0       1.0       0.0       0.0       0.0'
        ],
        expectedFields: ['PID', 'LCID', 'SF', 'FLAG', 'STRUC']
    },
    {
        keyword: 'DAMPING_PART_MASS_SET',
        category: 'DAMPING',
        standard: [
            '*DAMPING_PART_MASS_SET',
            '         1         1       1.0         0',
            '       1.0       1.0       1.0       0.0       0.0       0.0'
        ],
        comma: [
            '*DAMPING_PART_MASS_SET',
            '1,1,1.0,0',
            '1.0,1.0,1.0,0.0,0.0,0.0'
        ],
        long: [
            '*DAMPING_PART_MASS_SET+',
            '                   1                   1                 1.0                   0',
            '                 1.0                 1.0                 1.0                 0.0                 0.0                 0.0'
        ],
        i10: [
            '*DAMPING_PART_MASS_SET%',
            '         1         1       1.0         0',
            '       1.0       1.0       1.0       0.0       0.0       0.0'
        ],
        expectedFields: ['PSID', 'LCID', 'SF', 'FLAG']
    },
    {
        keyword: 'DAMPING_POROSITY',
        category: 'DAMPING',
        standard: [
            '*DAMPING_POROSITY',
            '         1         1       1.0         0         0',
            '       1.0       1.0       1.0       0.0       0.0       0.0'
        ],
        comma: [
            '*DAMPING_POROSITY',
            '1,1,1.0,0,0',
            '1.0,1.0,1.0,0.0,0.0,0.0'
        ],
        long: [
            '*DAMPING_POROSITY+',
            '                   1                   1                 1.0                   0                   0',
            '                 1.0                 1.0                 1.0                 0.0                 0.0                 0.0'
        ],
        i10: [
            '*DAMPING_POROSITY%',
            '         1         1       1.0         0         0',
            '       1.0       1.0       1.0       0.0       0.0       0.0'
        ],
        expectedFields: ['PID', 'LCID', 'SF', 'FLAG', 'STRUC']
    },
    // SECTION (6)
    {
        keyword: 'SECTION_BEAM_AISC',
        category: 'SECTION',
        standard: [
            '*SECTION_BEAM_AISC',
            '         1W14X90'
        ],
        comma: [
            '*SECTION_BEAM_AISC',
            '1,W14X90'
        ],
        long: [
            '*SECTION_BEAM_AISC+',
            '                   1W14X90'
        ],
        i10: [
            '*SECTION_BEAM_AISC%',
            '         1W14X90'
        ],
        expectedFields: ['SECID', 'LABEL']
    },
    {
        keyword: 'SECTION_SHELL_EFG',
        category: 'SECTION',
        standard: [
            '*SECTION_SHELL_EFG',
            '         1         2       1.0         2         0         0         0         0'
        ],
        comma: [
            '*SECTION_SHELL_EFG',
            '1,2,1.0,2,0,0,0,0'
        ],
        long: [
            '*SECTION_SHELL_EFG+',
            '                   1                   2                 1.0                   2                   0                   0                   0                   0'
        ],
        i10: [
            '*SECTION_SHELL_EFG%',
            '         1         2       1.0         2         0         0         0         0'
        ],
        expectedFields: ['SECID', 'ELFORM', 'SHRF', 'NIP', 'PROPT', 'QR/IRID', 'ICOMP', 'SETYP']
    },
    {
        keyword: 'SECTION_SHELL_MISC',
        category: 'SECTION',
        standard: [
            '*SECTION_SHELL_MISC',
            '         1         2       1.0         2         0         0         0         0'
        ],
        comma: [
            '*SECTION_SHELL_MISC',
            '1,2,1.0,2,0,0,0,0'
        ],
        long: [
            '*SECTION_SHELL_MISC+',
            '                   1                   2                 1.0                   2                   0                   0                   0                   0'
        ],
        i10: [
            '*SECTION_SHELL_MISC%',
            '         1         2       1.0         2         0         0         0         0'
        ],
        expectedFields: ['SECID', 'ELFORM', 'SHRF', 'NIP', 'PROPT', 'QR/IRID', 'ICOMP', 'SETYP']
    },
    {
        keyword: 'SECTION_SHELL_THERMAL',
        category: 'SECTION',
        standard: [
            '*SECTION_SHELL_THERMAL',
            '         1         2       1.0         2         0         0         0         0'
        ],
        comma: [
            '*SECTION_SHELL_THERMAL',
            '1,2,1.0,2,0,0,0,0'
        ],
        long: [
            '*SECTION_SHELL_THERMAL+',
            '                   1                   2                 1.0                   2                   0                   0                   0                   0'
        ],
        i10: [
            '*SECTION_SHELL_THERMAL%',
            '         1         2       1.0         2         0         0         0         0'
        ],
        expectedFields: ['SECID', 'ELFORM', 'SHRF', 'NIP', 'PROPT', 'QR/IRID', 'ICOMP', 'SETYP']
    },
    {
        keyword: 'SECTION_SHELL_XFEM',
        category: 'SECTION',
        standard: [
            '*SECTION_SHELL_XFEM',
            '         1         2       1.0         2         0         0         0         0'
        ],
        comma: [
            '*SECTION_SHELL_XFEM',
            '1,2,1.0,2,0,0,0,0'
        ],
        long: [
            '*SECTION_SHELL_XFEM+',
            '                   1                   2                 1.0                   2                   0                   0                   0                   0'
        ],
        i10: [
            '*SECTION_SHELL_XFEM%',
            '         1         2       1.0         2         0         0         0         0'
        ],
        expectedFields: ['SECID', 'ELFORM', 'SHRF', 'NIP', 'PROPT', 'QR/IRID', 'ICOMP', 'SETYP']
    },
    {
        keyword: 'SECTION_SOLID_MISC',
        category: 'SECTION',
        standard: [
            '*SECTION_SOLID_MISC',
            '         1         1         0                                                 0.1       0.2'
        ],
        comma: [
            '*SECTION_SOLID_MISC',
            '1,1,0,,,,0.1,0.2'
        ],
        long: [
            '*SECTION_SOLID_MISC+',
            '                   1                   1                   0                                                                               0.1                 0.2'
        ],
        i10: [
            '*SECTION_SOLID_MISC%',
            '         1         1         0                                                 0.1       0.2'
        ],
        expectedFields: ['SECID', 'ELFORM', 'AET', 'UNUSED', 'UNUSED', 'UNUSED', 'COHOFF', 'GASKETT']
    }
];

describe('First Echelon Native Reader Closure (ISPG, DELETE, DAMPING, SECTION)', () => {
    for (const specimen of TEST_SPECIMENS) {
        describe(`Keyword: *${specimen.keyword} (${specimen.category})`, () => {
            it('resolves in standard format with exact field schema', () => {
                const doc = fakeDoc(specimen.standard.join('\n'));
                const res = resolve(doc, 1);
                assert.ok(res?.cardInfo, `Expected cardInfo for ${specimen.keyword}`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.nativeCardIndex, 1);
                assert.deepEqual(res.cardInfo.card.map(f => f.n), specimen.expectedFields);
            });

            it('resolves in comma format', () => {
                const doc = fakeDoc(specimen.comma.join('\n'));
                const res = resolve(doc, 1);
                assert.ok(res?.cardInfo, `Expected cardInfo for ${specimen.keyword} comma`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.inputFormat, 'comma');
                assert.deepEqual(res.cardInfo.card.map(f => f.n), specimen.expectedFields);
            });

            it('resolves in long format (+)', () => {
                const doc = fakeDoc(specimen.long.join('\n'));
                const res = resolve(doc, 1);
                assert.ok(res?.cardInfo, `Expected cardInfo for ${specimen.keyword} long`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.inputFormat, 'long');
                assert.deepEqual(res.cardInfo.card.map(f => f.n), specimen.expectedFields);
            });

            it('resolves in i10 format (%)', () => {
                const doc = fakeDoc(specimen.i10.join('\n'));
                const res = resolve(doc, 1);
                assert.ok(res?.cardInfo, `Expected cardInfo for ${specimen.keyword} i10`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.inputFormat, 'i10');
                assert.deepEqual(res.cardInfo.card.map(f => f.n), specimen.expectedFields);
            });
        });
    }

    it('achieves 100.0% native closure across all 4 registered keyword categories', function() {
        this.timeout(15000);
        const data = { registrations: require("../../fixtures/public-behavior/category-registration-keywords.json") };
        const categories = ['ISPG', 'DELETE', 'DAMPING', 'SECTION'];

        for (const cat of categories) {
            const regs = data.registrations.filter(r => r.category === cat);
            assert.ok(regs.length > 0, `Category ${cat} should have registrations`);
            let resolved = 0;
            const failures = [];
            for (const reg of regs) {
                const kw = cat + (reg.name ? '_' + reg.name : '');
                const doc = fakeDoc(['*' + kw, '         1         2         3         4'].join('\n'));
                const res = resolve(doc, 1);
                if (res?.cardInfo?.resolutionSource === 'native-file-reader') {
                    resolved++;
                } else {
                    failures.push({ kw, source: res?.cardInfo?.resolutionSource });
                }
            }
            assert.equal(failures.length, 0, `Category ${cat} had unresolved keywords: ${JSON.stringify(failures)}`);
            assert.equal(resolved, regs.length, `Category ${cat} closure ${resolved}/${regs.length} is not 100%`);
        }
    });
});
