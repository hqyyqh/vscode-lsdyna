'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require("../support/helpers");
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve } = require('../../out/extension')._internals;
const { nativeFileReadContext } = require('../../out/core/semantics/nativeFileReadContext');
const { getCatalogInputFormCatalogV4, reloadCatalogInputFormCatalogV4 } = require("../../out/core/semantics/catalogInputFormCatalogV4");
const row = values => values.map(value => String(value).padStart(10)).join('');
function barlat(a = 1, fit = 1, hard = 3) {
    return ['*MAT_BARLAT_YLD2000', '$# mid ro e pr fit beta iter iscale', row([1, '', '', '', fit, '', 0, 0]),
        '$# k e0 n c p hard a', row(['', '', '', '', '', hard, a]),
        ...(Number(a) < 0 ? ['$# CRC1 CRA1 CRC2 CRA2 CRC3 CRA3 CRC4 CRA4', ''] : []),
        '$# ' + (Number(fit) === 0 ? 'ALPHA1 ALPHA2' : 'SIG00 SIG45 SIG90 R00 R45 R90'), '',
        ...(Number(fit) === 1 ? ['$# SIGXX SIGYY SIGXY DXX DYY DXY', ''] : []),
        ...(Number(hard) === 3 ? ['$# CP T0 TREF TA0', '', '$# A B C D P Q E0MART VM0', '', '$# AHS BHS M N EPS0 HMART K1 K2', ''] : []),
        '$# AOPT OFFANG P4 HTFLAG HTA HTB HTC HTD', row(['', '', '', 0, '', '', '', '']),
        '$# UNUSED UNUSED UNUSED A1 A2 A3', '', '$# V1 V2 V3 D1 D2 D3 USRFAIL', row(['', '', '', '', '', '', 0]), '*END'];
}
function sourceRule(keyword) {
    const form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
    return { ...form.rules[form.reference.formRuleIds[0]], catalogSource: form.source };
}
const keywords = ['MAT_BARLAT_YLD2000', 'MAT_FABRIC', 'MAT_CABLE_DISCRETE_BEAM', 'MAT_HYSTERETIC_SOIL',
        'MAT_ANISOTROPIC_ELASTIC_PLASTIC', 'MAT_MOMENT_CURVATURE_BEAM', 'MAT_LOU-YOON_ANISOTROPIC_PLASTICTIY'];
describe("conditional layout reading, editing and uncertainty boundaries", function () {
    this.timeout(120000);
    it("preserves source tail identities when a title is added or removed", () => {
        const { selectConditionalLayout } = require('../../out/core/semantics/nativeConditionalLayout');
        const binding = { controls: {}, steps: [1, { repeatToEnd: 2 }] };
        for (const title of [false, true]) for (const count of [0, 1, 3, 100]) {
            const rows = [...(title ? ['title'] : []), 'header', ...Array(count).fill('tail')];
            const result = selectConditionalLayout(binding, rows, title, () => '', value => value,
                (_record, _field, raw) => raw, !title, false);
            assert.ok(result);
            assert.equal(result.target.length, 1 + Number(!title) + count);
            assert.deepEqual(result.current.filter(record => record.cardIndex === 2),
                result.target.filter(record => record.cardIndex === 2));
        }
    });
    it("does not invent a tail count when a draft enables an unobserved branch", () => {
        const { selectConditionalLayout } = require('../../out/core/semantics/nativeConditionalLayout');
        const binding = { controls: { X: { card: 1, field: 0, storage: 'int32' } },
            steps: [1, { control: 'X', op: 'eq', value: 1, then: [{ repeatToEnd: 2 }] }] };
        assert.equal(selectConditionalLayout(binding, ['0'], false, () => '0', value => value,
            () => '1', false, false), null);
    });
    it("preserves observed finite and counted tails across title changes", () => {
        const { selectConditionalLayout } = require('../../out/core/semantics/nativeConditionalLayout');
        for (const step of [{ sequenceToEnd: [2, 3, 4] },
            { repeatToEnd: 2, control: 'N', fieldsPerRecord: 8, maxRecords: 10, minimumValue: 1 }])
            for (const title of [false, true]) for (const count of [1, 2, 3]) {
                const binding = { controls: { N: { card: 1, field: 0, storage: 'int32' } }, steps: [1, step] };
                const rows = [...(title ? ['title'] : []), '1', ...Array(count).fill('')];
                const result = selectConditionalLayout(binding, rows, title, () => '1', value => value,
                    (_record, _field, raw) => raw, !title, false);
                assert.ok(result);
                assert.deepEqual(result.current.filter(record => record.cardIndex > 1),
                    result.target.filter(record => record.cardIndex > 1));
            }
    });
    it("binds the native direction fields after NF=2 in every spelling and format", async () => {
        const provider = new LsdynaFieldHoverProvider();
        for (const keyword of ['MAT_295', 'MAT_295_TITLE', 'MAT_ANISOTROPIC_HYPERELASTIC', 'MAT_ANISOTROPIC_HYPERELASTIC_TITLE'])
            for (const format of ['standard', 'comma', 'long', 'i10']) for (const ftype of [1, 2]) {
                const values = [[1, 1, 0], ['ISO', -3, 0, 0.49], [1, 1], ['ANISO', 1, 1, 2],
                    [0, 1, 1], [ftype, 0, 1, 1, ...(ftype === 2 ? [1] : [])],
                    [0, 1, 1], [ftype, 0, 1, 1, ...(ftype === 2 ? [1] : [])], [3, 4]];
                const width = format === 'long' ? 20 : 10, title = keyword.endsWith('_TITLE');
                const lines = ['*' + keyword + (format === 'long' ? ' +' : format === 'i10' ? ' %' : ''),
                    ...(title ? ['manual coupling identity'] : []), ...values.map(row => format === 'comma' ? row.join(',') : row.map(value => String(value).padStart(width)).join('')), '*END'];
                const doc = fakeDoc(lines.join('\n')), line = 9 + Number(title);
                const info = resolve(doc, line).cardInfo;
                assert.equal(info.nativeCardIndex, 20);
                assert.deepEqual(info.card.slice(0,2).map(field => field.nativeIdentity.fieldRecordId), ["record:6a5b1cfb809915f7ecb2078b:8c137e370f3bb85166c6d211", "record:6a5b1cfb809915f7ecb2078b:1fd0b4a3c2ce752cb4e710a8"]);
                for (const [index, name, help] of [[0, 'XP', 'Coordinates of point'], [1, 'YP', 'Coordinates of point']]) {
                    const start = format === 'comma' ? index * 2 : index * width;
                    const end = start + (format === 'comma' ? 1 : width);
                    const hover = await provider.provideHover(doc, { line, character: start }, { isCancellationRequested: false });
                    assert.ok(hover.contents.some(content => content.value?.includes(`**${name}**`) && content.value.includes(help)));
                    assert.equal(hover.range.start.character, start);
                    assert.equal(hover.range.end.character, end);
                }
            }
    });
    it("resolves full LONG ACTIVE records and following modules without the native reader overflow", async () => {
        const provider = new LsdynaFieldHoverProvider();
        const orders = [['ISO','ANISO','ACTIVE'], ['ISO','ACTIVE','ANISO'], ['ANISO','ISO','ACTIVE'],
            ['ANISO','ACTIVE','ISO'], ['ACTIVE','ISO','ANISO'], ['ACTIVE','ANISO','ISO']];
        for (const keyword of ['MAT_295', 'MAT_295_TITLE', 'MAT_ANISOTROPIC_HYPERELASTIC', 'MAT_ANISOTROPIC_HYPERELASTIC_TITLE'])
            for (const active of [1, 2, 3, 4, 5]) for (const order of orders) {
                // Fixed manual pp. 2027–2029 and 2035. Expected card identities
                // and the last three ranges are literal, not parser-generated.
                const modules = { ISO: [2, 6], ANISO: [7, 8, 9], ACTIVE: [12,
                    ...({1:[13,14],2:[13,15],3:[16],4:[17,18],5:[19]}[active])] };
                const cards = [1, ...order.flatMap(tag => modules[tag])];
                const values = { 1:[1,1,0], 2:['ISO',-3,0,0.49], 6:[1,1], 7:['ANISO',1,0,1], 8:[0,1,1],
                    9:[1,0,1,1], 12:['ACTIVE',active,0,0,0,1,2,3], 13:Array(8).fill(1), 14:Array(4).fill(1),
                    15:[1,1], 16:Array(8).fill(1), 17:Array(8).fill(1), 18:[1,1], 19:[1,2,3,4] };
                const title = keyword.endsWith('_TITLE'), rows = cards.map(card => values[card].map(value => String(value).padStart(20)).join(''));
                const lines = ['*' + keyword + ' +', ...(title ? ['manual full LONG ACTIVE'] : []), ...rows, '*END'];
                const doc = fakeDoc(lines.join('\n'));
                for (const [index, card] of cards.entries()) assert.equal(resolve(doc, index + 1 + Number(title)).cardInfo.nativeCardIndex, card);
                const line = cards.indexOf(12) + 1 + Number(title);
                for (const [index, name, direction, address] of [[5,'SF','fiber',"record:6a5b1cfb809915f7ecb2078b:a5f72f432ecedbe108969a73"],
                    [6,'SS','transverse sheet',"record:6a5b1cfb809915f7ecb2078b:4daabefea43b75d5c63bf897"], [7,'SN','transverse normal',"record:6a5b1cfb809915f7ecb2078b:e4c6c9dde3660931a97d039b"]]) {
                    assert.equal(resolve(doc, line).cardInfo.card[index].nativeIdentity.fieldRecordId, address);
                    const hover = await provider.provideHover(doc, { line, character: index * 20 }, { isCancellationRequested: false });
                    assert.ok(hover.contents.some(content => content.value?.includes(`**${name}**`) && content.value.includes(direction)));
                    assert.equal(hover.range.start.character, index * 20);
                    assert.equal(hover.range.end.character, (index + 1) * 20);
                }
            }
    });
    it("preserves phase signed-zero branches and requires complete counted records", async function () {
        const binding = require("../../keywords/runtime/native-readers/lspp-conditional-layout-readers.json").bindings.MAT_254;
        assert.equal(binding.steps.at(-1).maxRecords, 10);
        for (const [end, cards] of [['0', [1, 2, 3, 4, 5, 6, 8]], ['-0', [1, 2, 4, 5, 6, 8]]]) {
            const rows = cards.map(card => card === 1 ? row([1, 1, 8, 1, 0.3]) : card === 2 ? row([1, end]) : row(Array(8).fill(0)));
            const selected = nativeFileReadContext(sourceRule('MAT_254'), '*MAT_254', rows, 'standard').select(false);
            assert.equal(selected.complete, true);
            assert.deepEqual(selected.current.map(record => record.cardIndex), cards);
            const missing = nativeFileReadContext(sourceRule('MAT_254'), '*MAT_254', rows.slice(0, -1), 'standard').select(true);
            assert.equal(missing.complete, false);
            assert.deepEqual(missing.current.map(record => record.cardIndex), cards.slice(0, -1));
        }
    });
    it("checks counted tails at instance boundaries without inventing missing records", () => {
        const { selectConditionalLayout } = require('../../out/core/semantics/nativeConditionalLayout');
        const binding = { controls: { N: { card: 1, field: 0, storage: 'int32' } },
            steps: [1, { repeatToEnd: 2, control: 'N', fieldsPerRecord: 8, maxRecords: 10, minimumValue: 1 }] };
        for (const [raw, count, complete] of [['1', 1, true], ['8', 1, true], ['9', 1, false], ['9', 2, true],
            ['24', 3, true], ['80', 10, true], ['81', 10, false], ['1', 11, false], ['1', 0, false],
            ['0', 0, false], ['&unknown', 1, false]]) {
            const result = selectConditionalLayout(binding, [raw, ...Array(count).fill('')], false, () => raw,
                value => value, (_record, _field, value) => value, false, true);
            assert.equal(result.complete, complete, `${raw}/${count}`);
            const knownCount = Number(raw);
            assert.equal(result.current.length, Number.isInteger(knownCount) && knownCount >= 1 && knownCount <= 80 ? Math.min(count, 10) + 1 : 1);
            if (complete) assert.equal(new Set(result.current.map(record => record.key)).size, count + 1);
            else assert.equal(result.failureKind, 'input-uncertain');
        }
    });
    it("retains only the certain prefix of an exact counted tail", () => {
        const { selectConditionalLayout } = require('../../out/core/semantics/nativeConditionalLayout');
        const binding = { controls: { N: { card: 1, field: 0, storage: 'int32' } },
            steps: [1, { repeatToEnd: 2, control: 'N', fieldsPerRecord: 1, maxRecords: 6, minimumValue: 0, exactCount: true }] };
        for (let n = 0; n <= 6; n++) for (let count = 0; count <= 7; count++) {
            const result = selectConditionalLayout(binding, [String(n), ...Array(count).fill('')], false,
                () => String(n), value => value, (_record, _field, value) => value, false, true);
            assert.equal(result.complete, count === n, `${n}/${count}`);
            assert.equal(result.current.length, 1 + Math.min(count, n), `${n}/${count}`);
        }
        for (const targetCount of [0, 1, 6]) {
            const result = selectConditionalLayout(binding, ['2', '', ''], false,
                () => '2', value => value, () => String(targetCount), false, false);
            assert.equal(result.complete, true);
            assert.deepEqual(result.current.map(record => record.cardIndex), [1, 2, 2]);
            assert.equal(result.target.length, 1 + targetCount);
        }
    });
    it("scopes reordered tagged modules and repeated lookahead controllers", () => {
        const { selectConditionalLayout } = require('../../out/core/semantics/nativeConditionalLayout');
        const binding = { controls: { N: { card: 2, field: 1, storage: 'int32' },
            TYPE: { card: 3, sourceCards: [3, 4], field: 0, storage: 'int32', atNextRecord: true } },
            steps: [1, { tagged: { ISO: [5], ANISO: [2, { control: 'N', maxCount: 3,
                repeat: [{ control: 'TYPE', op: 'eq', value: 1, then: [3], else: [4] }] }] }, required: ['ISO'] }] };
        for (const [rows, cards] of [
            [['1', 'ISO', 'ANISO,2', '1', '2'], [1, 5, 2, 3, 4]],
            [['1', 'ANISO,2', '1', '2', 'ISO'], [1, 2, 3, 4, 5]],
        ]) {
            const result = selectConditionalLayout(binding, rows, false, (row, _card, field) => rows[row].split(',')[field] || '',
                value => value, (_record, _field, value) => value, false, false);
            assert.ok(result);
            assert.equal(result.complete, true);
            assert.deepEqual(result.current.map(record => record.cardIndex), cards);
            assert.deepEqual(result.target, result.current);
            assert.equal(new Set(result.current.map(record => record.key)).size, rows.length);
        }
        for (const rows of [['1', 'ISO', 'ISO'], ['1', 'OTHER'], ['1', 'ISO123'], ['1', 'ISO', '&UNKNOWN'], ['1', 'ANISO,1', '&UNKNOWN']]) {
            const result = selectConditionalLayout(binding, rows, false, (row, _card, field) => rows[row].split(',')[field] || '',
                value => value, (_record, _field, value) => value, false, true);
            assert.equal(result.complete, false);
            assert.equal(result.failureKind, 'input-uncertain');
        }
    });
    it("preserves signed zero for native integer comparisons of float storage", () => {
        const { selectConditionalLayout } = require('../../out/core/semantics/nativeConditionalLayout');
        const binding = { controls: { X: { card: 1, field: 0, storage: 'float32', comparison: 'int32-bits' } },
            steps: [1, { control: 'X', op: 'eq', value: 0, then: [2], else: [3] }] };
        for (const [raw, expected] of [['0', 2], ['-0', 3], ['1e-45', 3], ['-1e-45', 3]]) {
            const result = selectConditionalLayout(binding, [raw, ''], false, () => raw, value => value,
                (_record, _field, value) => value, false, false);
            assert.equal(result.complete, true);
            assert.deepEqual(result.current.map(record => record.cardIndex), [1, expected]);
        }
    });
    it("selects damage hardening enum branches from source controls", async () => {
        for (const name of ['MAT_DAMAGE_3', 'MAT_153']) for (const flag of [0, 1, 2, 3, 4]) {
            const selected = nativeFileReadContext(sourceRule(name), '*' + name,
                [row([1, 1, 1, 0.3]), row([0]), row([0, 0, 0, 0, 0, 0, 0, flag]), row([0, 0])], 'standard').select(false);
            assert.equal(selected.complete, true);
            assert.deepEqual(selected.current.map(record => record.cardIndex), [1, 2, 3, flag === 0 ? 4 : 5]);
        }
    });
    it("selects elastic sign branches and FLUID suffixes while retaining uncertain controls", async () => {
        for (const name of ['MAT_ELASTIC', 'MAT_001', 'MAT_ELASTIC_FLUID', 'MAT_001_FLUID']) {
            const rule = sourceRule(name);
            for (const e of [-1, 0, 1]) {
                const indices = [1, ...(e < 0 ? [2] : []), ...(name.endsWith('_FLUID') ? [3] : [])];
                const lines = [row([1, 1, e, 0.3]), ...indices.slice(1).map(() => row([0, 0, 0]))];
                const selected = nativeFileReadContext(rule, '*' + name, lines, 'standard').select(false);
                assert.equal(selected.complete, true);
                assert.deepEqual(selected.current.map(record => record.cardIndex), indices);
                const unresolved = nativeFileReadContext(rule, '*' + name, [row([1, 1, '&unknown', 0.3])], 'standard').select(true);
                assert.equal(unresolved.complete, false);
                assert.deepEqual(unresolved.current.map(record => record.cardIndex), [1]);
            }
        }
    });
    it("preserves curing zero, one and many tails without inventing absent records", async function () {
        const rule = sourceRule('MAT_307');
        const prefix = [row([1, 1]), row([0]), ...Array(10).fill(row(Array(8).fill(0)))];
        for (const repeats of [0, 1, 3]) {
            const selection = nativeFileReadContext(rule, '*MAT_307', [...prefix, ...Array(repeats).fill(row(Array(8).fill(0)))], 'standard').select(true);
            assert.equal(selection.complete, true);
            assert.deepEqual(selection.current.map(r => r.cardIndex), [1, 2, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, ...Array(repeats).fill(17)]);
            assert.equal(new Set(selection.current.map(r => r.key)).size, prefix.length + repeats);
        }
        const missing = nativeFileReadContext(rule, '*MAT_307', prefix.slice(0, 1), 'standard').select(true);
        assert.equal(missing.complete, false);
        assert.equal(missing.failureKind, 'input-uncertain');
    });
    it("keeps all 28 aliases bound to their reviewed conditional readers", async () => {
        const runtime = require("../../keywords/runtime/native-readers/lspp-conditional-layout-readers.json").bindings;
        const cards = new Set(keywords.map(keyword => runtime[keyword].cardSetId));
        const bindings = Object.keys(runtime).filter(keyword => cards.has(runtime[keyword].cardSetId));
        const expected = require('../fixtures/public-behavior/conditional-alias-bindings.json').bindings;
        assert.equal(bindings.length, 28);
        assert.deepEqual(bindings, Object.keys(expected));
        for (const keyword of bindings) assert.deepEqual(Object.fromEntries(
            Object.keys(expected[keyword]).map(key => [key, runtime[keyword][key]])), expected[keyword]);
    });
    it("selects control reader substitutions from source controls", async () => {
        const rule = sourceRule('CONTROL_THERMAL_SOLVER');
        for (const solver of [11, 17]) {
            const head = row([0, 0, solver, 0, 8, 1, 1, 0]);
            const reading = nativeFileReadContext(rule, '*CONTROL_THERMAL_SOLVER', [head], 'standard');
            assert.equal(reading.select(false).complete, true);
            assert.deepEqual(reading.select(false).target.map(r => r.cardIndex), [1, solver === 17 ? 4 : 2, 3]);
        }
    });
    it("reads repeated tails with distinct occurrences", async () => {
        const rule = sourceRule('CONTROL_FORMING_TIPPING');
        for (const count of [0, 1, 3]) {
            const rows = [row([1, 0, 0, 0, 0, 0, 0, 0]), ...Array(count).fill(row([1, 0, 0, 0, 0, 0, 0, 0]))];
            const selection = nativeFileReadContext(rule, '*CONTROL_FORMING_TIPPING', rows, 'standard').select(false);
            assert.equal(selection.complete, true);
            assert.deepEqual(selection.current.map(r => r.cardIndex), [1, ...Array(count).fill(2)]);
            assert.equal(new Set(selection.current.map(r => r.key)).size, count + 1);
        }
    });
    it("selects nested file branches without reading inactive controllers", async function () {
        const rule = sourceRule('MAT_CONCRETE_EC2');
        const rows = [row([1, 1, 1, -1, 6, 0, 0, 0]), row(Array(8).fill(0)), row(Array(8).fill(0)),
            row([0, 0, 0, 0, 0, 0, 0, 0]), row(Array(4).fill(0)), row(Array(6).fill(0))];
        const reading = nativeFileReadContext(rule, '*MAT_CONCRETE_EC2', rows, 'standard');
        assert.deepEqual(reading.select(false).current.map(r => r.cardIndex), [1, 2, 3, 4, 9, 10]);
    });
    it("keeps optional tails separate from conditionally required records", () => {
        const rule = sourceRule('MAT_240');
        const rows = [row([1, 1, 0, 1, 1, 1, 1, 0]), row(Array(8).fill(0)), row(Array(8).fill(0))];
        const select = rows => nativeFileReadContext(rule, '*MAT_240', rows, 'standard').select(true);
        assert.equal(select(rows).complete, true);
        assert.equal(select(rows.slice(0, 2)).complete, false);
        assert.equal(select([...rows, row([0, 0, 0, 0, 0, 0])]).complete, true);
        const required = [...rows, row([0, 0, 0, 0, 0, 1])];
        assert.equal(select(required).complete, false);
        assert.equal(select([...required, row(Array(8).fill(0)), row(Array(8).fill(0))]).complete, true);
    });
    it("selects residual-vector branches from source controls", async () => {
        const rule = sourceRule('CONTROL_IMPLICIT_RESIDUAL_VECTOR');
        for (const [iresvec, format, expected] of [[0, 0, [1]], [0, 1, [1, 2]], [1, 0, [1, 2]], [1, 1, [1, 2]]]) {
            const selection = nativeFileReadContext(rule, '*CONTROL_IMPLICIT_RESIDUAL_VECTOR',
                [row([iresvec, 0, format]), ...(expected.length === 2 ? ['eigenvectors.eig'] : [])], 'standard').select(false);
            assert.equal(selection.complete, true);
            assert.deepEqual(selection.target.map(record => record.cardIndex), expected);
        }
    });
    it("keeps both user examples aligned through blank cards and same-name A help", async () => {
        const provider = new LsdynaFieldHoverProvider();
        for (const a of [1, -1]) {
            const lines = barlat(a), doc = { ...fakeDoc(lines.join('\n')), version: 1 };
            const expected = [1, 2, ...(a < 0 ? [3] : []), 5, 6, 10, 11, 12, 7, 8, 9];
            const data = lines.flatMap((line, i) => !line.startsWith('$') && !line.startsWith('*') ? [i] : []);
            assert.deepEqual(data.map(line => resolve(doc, line).cardInfo?.nativeCardIndex), expected);
            const controlA = await provider.provideHover(doc, { line: 4, character: 65 });
            const thermal = lines.indexOf('$# A B C D P Q E0MART VM0') + 1;
            // Give the blank A cell a physical range so the provider can be called.
            lines[thermal] = row([2]);
            const next = { ...fakeDoc(lines.join('\n')), version: 2 };
            const thermalA = await provider.provideHover(next, { line: thermal, character: 5 });
            assert.ok(controlA.contents[0].value.includes('**A**'));
            assert.ok(thermalA.contents[0].value.includes('**A**'));
            const left = resolve(doc, 4).cardInfo.card[6], right = resolve(next, thermal).cardInfo.card[0];
            assert.notEqual(left.nativeIdentity.fieldRecordId, right.nativeIdentity.fieldRecordId);
            assert.notEqual(left.hi, right.hi);
        }
    });
    it("invalidates same-document edits, undo/redo and catalog reloads", async () => {
        const doc = { ...fakeDoc(''), version: 0 }, provider = new LsdynaFieldHoverProvider();
        for (const a of [1, -1, 1, -1]) {
            Object.assign(doc, fakeDoc(barlat(a).join('\n')), { version: doc.version + 1 });
            const card = resolve(doc, 6).cardInfo;
            assert.equal(card.nativeCardIndex, a < 0 ? 3 : 5);
            const before = card.card[0].nativeIdentity;
            reloadCatalogInputFormCatalogV4();
            assert.deepEqual(resolve(doc, 6).cardInfo.card[0].nativeIdentity, before);
            assert.ok(await provider.provideHover(doc, { line: 4, character: 65 }));
        }
    });
    it("uses declared defaults only for present blank controller cells", () => {
        const witnesses = [
            ['MAT_BARLAT_YLD2000', [row([1, '', '', '', '', '', 0, 0]), row(['', '', '', '', '', '', 1]), '', '', '', ''], [1, 2, 4, 7, 8, 9]],
            ['MAT_CABLE_DISCRETE_BEAM', [row([1, '', '', '', '', '', '', ''])], [1]],
            ['CONTROL_IMPLICIT_EIGENVALUE', [row(Array(8).fill('')), '', '', ''], [1, 2, 3, 8]],
            ['CONTROL_THERMAL_SOLVER', [row(Array(8).fill('')), '', ''], [1, 2, 3]],
        ];
        for (const [keyword, rows, expected] of witnesses) {
            const rule = sourceRule(keyword);
            const selection = nativeFileReadContext(rule, '*' + keyword, rows, 'standard').select(true);
            assert.equal(selection.complete, true, keyword + ': ' + selection.reasons);
            assert.deepEqual(selection.current.map(record => record.cardIndex), expected, keyword);
        }
        const rule = sourceRule('MAT_CABLE_DISCRETE_BEAM');
        for (const rows of [[], [row([1, '', '', '', '', '', '', '&UNKNOWN'])]]) {
            const selection = nativeFileReadContext(rule, '*MAT_CABLE_DISCRETE_BEAM', rows, 'standard').select(true);
            assert.equal(selection.complete, false);
            assert.equal(selection.failureKind, 'input-uncertain');
        }
    });
    it("accepts complete optional card groups and rejects partial groups in the common selector", () => {
        for (const keyword of ['MAT_119', 'MAT_119_TITLE', 'MAT_GENERAL_NONLINEAR_6DOF_DISCRETE_BEAM', 'MAT_GENERAL_NONLINEAR_6DOF_DISCRETE_BEAM_TITLE']) {
            const rule = sourceRule(keyword), title = keyword.endsWith('_TITLE');
            for (const flag of [0, 1, 2]) for (const unload of [0, 1, 2, 3]) for (let count = 7; count <= 15; count++) {
                const rows = [...(title ? ['six dof'] : []), row([1, 1, 1, 1, unload, 0, 0, flag]), ...Array(count - 1).fill(row(Array(8).fill(0)))];
                const selection = nativeFileReadContext(rule, '*' + keyword, rows, 'standard').select(true);
                const valid = (flag === 2 ? [8, 11, 14] : unload === 2 ? [8, 9] : [8]).includes(count);
                assert.equal(selection.complete, valid, `${keyword}: IFLAG=${flag}, IUNLD=${unload}, rows=${count}`);
                if (!valid) assert.equal(selection.failureKind, 'input-uncertain');
                if (valid) {
                    assert.equal(selection.target.length, rows.length, 'No draft may add an omitted tail');
                    const retitled = nativeFileReadContext(rule, '*' + keyword, rows, 'standard').select(true, undefined, !title);
                    assert.equal(retitled.target.length, count + Number(!title), 'TITLE changes preserve optional group count');
                }
                if (valid && flag !== 2 && count === 9) assert.equal(selection.current.at(-1).cardIndex, 15);
            }
        }
    });
    it("selects rubber coefficient cards and keeps repeated viscoelastic records distinct", () => {
        for (const [keyword, tail, coefficients] of [['MAT_077_O', 6, [4, 5]], ['MAT_077_H', 5, [4]]]) {
            const rule = sourceRule(keyword);
            for (const pr of [-0.3, 0, 0.3]) for (const n of [0, 1, 2]) for (const repeats of [0, 1, 3]) {
                const expected = [1, ...(pr < 0 ? [2] : []), ...(n ? [3] : coefficients), ...Array(repeats).fill(tail)];
                const rows = [row([1, 1, pr, n, 0, 0, 0, 0]), ...Array(expected.length - 1).fill('')];
                const selection = nativeFileReadContext(rule, '*' + keyword, rows, 'standard').select(true);
                assert.equal(selection.complete, true);
                assert.deepEqual(selection.current.map(record => record.cardIndex), expected);
                assert.equal(new Set(selection.current.map(record => record.key)).size, expected.length);
            }
            const uncertain = nativeFileReadContext(rule, '*' + keyword, [row([1, 1, '&PR', 0])], 'standard').select(true);
            assert.equal(uncertain.failureKind, 'input-uncertain');
            assert.deepEqual(uncertain.current.map(record => record.cardIndex), [1]);
        }
    });
    it("stops at uncertain controls and uses source records for manager drafts", () => {
        const rule = sourceRule('MAT_BARLAT_YLD2000');
        const rows = barlat(1).filter(line => !line.startsWith('$') && !line.startsWith('*'));
        const context = nativeFileReadContext(rule, '*MAT_BARLAT_YLD2000', rows, 'standard');
        const initial = context.select(false);
        const changed = context.select(false, (record, field, raw) => record.cardIndex === 2 && field === 6 ? '-1' : raw);
        assert.deepEqual(changed.current, initial.current);
        assert.deepEqual(changed.target.map(r => r.cardIndex), [1, 2, 3, 5, 6, 10, 11, 12, 7, 8, 9]);
        for (const value of ['', '&UNKNOWN', 'bad']) {
            const broken = [...rows]; broken[1] = row(['', '', '', '', '', 3, value]);
            const selection = nativeFileReadContext(rule, '*MAT_BARLAT_YLD2000', broken, 'standard').select(true);
            assert.deepEqual(selection.current.map(r => r.cardIndex), [1, 2]);
            assert.ok(selection.reasons.length);
            assert.equal(selection.failureKind, 'input-uncertain');
            const document = fakeDoc(barlat(value).join('\n'));
            const resolution = require('../../out/core/keywordSchema').resolveCardForDocumentLine(document, 6, undefined, { keywordLine: 0 });
            assert.equal(resolution.status, 'unresolved');
            assert.equal(resolution.failureKind, 'input-uncertain');
        }
        const extra = nativeFileReadContext(rule, '*MAT_BARLAT_YLD2000', [...rows, '0'], 'standard').select(true);
        assert.equal(extra.failureKind, 'input-uncertain');
        assert.ok(extra.reasons.includes('record-count-mismatch'));
        const { selectConditionalLayout } = require('../../out/core/semantics/nativeConditionalLayout');
        const gap = selectConditionalLayout({ controls: { X: { card: 1, field: 0, storage: 'int32' } },
            steps: [1, { control: 'X', op: 'unknown', value: 0, then: [2] }] }, ['0'], false,
            () => '0', raw => raw, (_record, _field, raw) => raw, false, true);
        assert.equal(gap.failureKind, 'implementation-gap');
        assert.deepEqual(gap.current.map(r => r.cardIndex), [1]);
        const parameterRows = [...rows];
        parameterRows[1] = row(['', '', '', '', '', 3, '&A']);
        for (const value of [-0.5, 0.5]) {
            const reading = nativeFileReadContext(rule, '*MAT_BARLAT_YLD2000', parameterRows, 'standard', [1, 2],
                { documentVersion: 1, resolve: () => ({ resolved: true, value }) });
            assert.equal(reading.select(true).current[2].cardIndex, value < 0 ? 3 : 5);
        }
    });
    it("resolves standard solver manual semantics for MAT_DMN_COMPOSITE_FRC and MAT_303 without native tool defect reproduction", async () => {
        const provider = new LsdynaFieldHoverProvider();
        for (const keyword of ['MAT_DMN_COMPOSITE_FRC', 'MAT_DMN_COMPOSITE_FRC_TITLE', 'MAT_303', 'MAT_303_TITLE']) {
            const isTitle = keyword.endsWith('_TITLE');
            const rule = sourceRule(keyword);
            for (const iso of [0, 1]) for (const itc of [0, 1, 2, 3]) for (const dam of [0, 1, 2]) {
                const expected = [
                    ...(isTitle ? [0] : []),
                    1, 2, 3,
                    ...(iso === 1 ? [4] : []),
                    5,
                    ...(itc === 1 || itc === 3 ? [6] : []),
                    ...(dam === 1 || dam === 2 ? [7] : []),
                    8,
                ];
                const rows = [
                    ...(isTitle ? ['Title line'] : []),
                    row([1]),
                    row([0.5, 1.0, 1.0, 1.0, 1.0, 1.0]),
                    row([1.0, 0.3, iso, dam]),
                    ...(iso === 1 ? [row([1.0, 1.0, 0.3, 0.3, 1.0])] : []),
                    row([1.0, 0.3, 1.0, 1.0, 1.0, 1.0, itc]),
                    ...(itc === 1 || itc === 3 ? [row([1.0, 0.3, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0])] : []),
                    ...(dam === 1 || dam === 2 ? [row([0.1, '', '', '', 0.9])] : []),
                    row([100, 101]),
                ];
                const selection = nativeFileReadContext(rule, '*' + keyword, rows, 'standard').select(true);
                assert.equal(selection.complete, true);
                assert.deepEqual(selection.current.map(r => r.cardIndex), expected);
            }

            const doc = fakeDoc([
                '*' + keyword,
                ...(isTitle ? ['Test Title'] : []),
                row([1]),
                row([0.5, 1.0, 1.0, 1.0, 1.0, 1.0]),
                row([1.0, 0.3, 0, 1]),
                row([1.0, 0.3, 1.0, 1.0, 1.0, 1.0, 0]),
                row([0.1, '', '', '', 0.9]),
                row([100, 101]),
            ].join('\n'));
            const damLine = (isTitle ? 1 : 0) + 5;
            const hover = await provider.provideHover(doc, { line: damLine, character: 5 });
            assert.ok(hover?.contents[0]?.value?.includes('D_C'), `Expected D_C hover on line ${damLine} for ${keyword}`);
        }
    });
});
