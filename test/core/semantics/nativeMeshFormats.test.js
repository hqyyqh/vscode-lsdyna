'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fakeDoc } = require("../../support/helpers");
const { getCardInfoForDocumentLineWithSuggest: resolve, LsdynaFieldHoverProvider,
    buildKeywordOptionViewModel: model, keywordManagerEditField: edit } = require("../../../out/extension")._internals;
const fixtures = {
    standard: "test/fixtures/public-behavior/native-formats/native-standard.k",
    long: "test/fixtures/public-behavior/native-formats/native-long.k",
    i10: "test/fixtures/public-behavior/native-formats/native-i10.k",
    free: "test/fixtures/public-behavior/native-formats/native-free.k",
};

describe('native PART/NODE format consumers', () => {
    it('matches native saved field windows, values, instance identities and actual hover without comments', async function () {
        this.timeout(30000);
        const hover = new LsdynaFieldHoverProvider();
        for (const format of ['standard', 'long', 'i10', 'free']) {
            const bytes = fs.readFileSync(fixtures[format]);
            for (const comments of [false, true]) {
                const lines = bytes.toString().split(/\r?\n/).filter(line => !line.startsWith('$'))
                    .flatMap(line => comments ? ['$# WRONG FIELD NAMES', line] : [line]);
                const doc = { ...fakeDoc(lines.join('\n'), '/mesh/' + format + comments + '.k'), version: 1 };
                let keyword = '', ordinal = 0;
                for (const [line, text] of lines.entries()) {
                    if (text.startsWith('*')) { keyword = text.split(/\s/)[0]; ordinal = 0; continue; }
                    if (!text || text.startsWith('$') || !['*PART', '*NODE'].includes(keyword)) continue;
                    ordinal++;
                    const info = resolve(doc, line).cardInfo;
                    assert.ok(info, format + keyword);
                    if (keyword === '*PART' && ordinal === 1) {
                        assert.equal(info.card[0].n, 'TITLE'); assert.equal(info.card[0].rawValue, 'format plate'); continue;
                    }
                    const node = keyword === '*NODE';
                    const names = node ? ['NID', 'X', 'Y', 'Z', 'TC', 'RC'] : ['PID', 'SECID', 'MID', 'EOSID', 'HGID', 'GRAV', 'ADPOPT', 'TMID'];
                    const widths = format === 'long' ? names.map(() => 20) : node ?
                        (format === 'i10' ? [10,16,16,16,10,10] : [8,16,16,16,8,8]) : names.map(() => 10);
                    let start = 0;
                    const values = format === 'free' ? text.split(',') : widths.map(width => { const value = text.slice(start, start + width).trim(); start += width; return value; });
                    assert.deepEqual(info.card.map(field => field.n), names);
                    assert.deepEqual(info.card.map(field => field.t), names.map(name => ['X','Y','Z'].includes(name) ? 'real' : 'integer'));
                    assert.deepEqual(info.card.map(field => field.rawValue), names.map((_, index) => values[index] || ''));
                    if (node && info.nativeInstanceStart === undefined) {
                        assert.equal(info.observedDataLineOrdinal, undefined);
                        assert.ok(info.card.every(field => field.nativeIdentity.sourceLine === line));
                    } else assert.equal(info.nativeInstanceStart, node ? ordinal - 1 : 0);
                    assert.equal(info.cardIndex, node ? 1 : 2);
                    assert.equal(Number(info.card[0].rawValue), node ? 87654320 + ordinal : 301);
                    const editor = { document: doc, selection: { active: { line, character: 0 } } };
                    const view = model(editor, line, {});
                    const card = view.managerCards.find(card => card.line === line);
                    assert.ok(card, format + keyword + ' manager');
                    assert.deepEqual(card.fields.map(field => field.value), info.card.map(field => field.rawValue));
                    for (const field of info.card.filter(field => field.nativeRange.end > field.nativeRange.start)) {
                        const result = await hover.provideHover(doc, { line, character: field.p }, undefined, true);
                        assert.ok(result?.contents[0].value.includes('**' + field.n + '**'), field.n);
                        assert.equal(result.range.start.character, field.nativeRange.start);
                        assert.equal(result.range.end.character, field.nativeRange.end);
                    }
                    assert.ok(info.card.every(field => Boolean(field.nativeStaticBinding) ===
                        (format === 'standard' || !node && format === 'i10')));
                }
            }
        }
    });

    it('keeps edits on the selected NODE and invalidates values on document version changes', () => {
        let lines = ['*NODE', '       1             0.0             0.0             0.0       0       0',
            '       2             0.0             0.0             0.0       0       0', '*END'];
        const doc = { ...fakeDoc(''), version: 1, lineAt: line => ({ text: lines[line] }), getText: () => lines.join('\n') };
        Object.defineProperty(doc, 'lineCount', { get: () => lines.length });
        const editor = { document: doc, selection: { active: { line: 2, character: 0 } } };
        const view = model(editor, 2, {}), card = view.managerCards.find(card => card.line === 2);
        const staged = edit(view, card.fields[1].fieldId, '1.25');
        assert.ok(staged);
        const after = model(editor, 2, staged);
        assert.equal(after.plan.status, 'ready');
        assert.equal(after.plan.replacementRecords[0].text, lines[1]);
        assert.equal(after.plan.replacementRecords[1].text.slice(8,24).trim(), '1.25');
        const old = lines[2]; lines[2] = after.plan.replacementRecords[1].text; doc.version++;
        assert.equal(resolve(doc,2).cardInfo.card[1].rawValue,'1.25');
        lines[2] = old; doc.version++;
        assert.equal(resolve(doc,2).cardInfo.card[1].rawValue,'0.0');
    });
});
