'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve } = require("../../../out/extension")._internals;
const { getCatalogInputFormCatalogV4: catalog } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
const { formattedFields } = require("../../../out/core/edit/keywordRecordSerializer");
const cases = require("../../fixtures/public-behavior/dynamic-file-layout-cases.json");

function source(c, { format = 'standard', title = false, comments = [] } = {}) {
    const form = catalog().formForKeyword(c.keyword);
    const cards = form.rules[form.reference.formRuleIds[0]].cards;
    const values = { MID: c.id, SECID: c.id, ...c.values };
    const rows = c.cards.map(i => {
        const fields = cards[i - 1].fields;
        if (format === 'comma') return fields.map(f => values[f.name] ?? '').join(',');
        return formattedFields(fields, '', format).map((f, j) => {
            const value = String(values[f.name] ?? '');
            if (f.name === 'FTYPE' && format === 'long') return value.padStart(10).padEnd(f.width);
            return Number(fields[j].type) === 0 ? value.padEnd(f.width) : value.padStart(f.width);
        }).join('');
    });
    const lines = ['*' + c.keyword + (title ? '_TITLE' : '') + (format === 'long' ? ' +' : format === 'i10' ? ' %' : '')];
    if (title) lines.push('native title');
    const positions = [];
    rows.forEach(row => { lines.push(...comments); positions.push(lines.length); lines.push(row); });
    return { doc: fakeDoc([...lines, '*END'].join('\n')), positions, cards, lines };
}
const label = value => /^[\s_-]*$/.test(value) ? 'UNUSED' : value.toUpperCase();

describe('native file field hover without GUI', function () {
    // These tests load native catalog shards and replay many real provider calls.
    // Latency budgets are asserted by the dedicated large-file benchmarks.
    this.timeout(30000);
    it('agrees with the observed BEAM read across indented comments and manager source positions', async () => {
        const fs = require('node:fs'), path = require('node:path');
        const proof = JSON.parse(fs.readFileSync(path.join(__dirname, "../../fixtures/public-behavior/mixed-field-records.json")));
        const native = proof.observations.filter(o => o.kind === 'fields').at(-1);
        const text = fs.readFileSync(path.join(__dirname, "../../fixtures/public-behavior/mixed-field-input.k"), 'utf8');
        const provider = new LsdynaFieldHoverProvider();
        const { collectOptionSwitchBlock, buildKeywordOptionViewModel } = require("../../../out/extension")._internals;
        const { buildSemanticDocumentContext } = require("../../../out/core/semantics/semanticDocumentContext");
        const { loadKeywordSchema } = require("../../../out/core/keywordSchema");
        for (const source of [text, text.split(/\r?\n/).filter(line => !/^ *\$/.test(line)).join('\n')]) {
            const doc = { ...fakeDoc(source), version: 1 };
            const lines = source.split(/\r?\n/), keywordLine = lines.indexOf('*SECTION_BEAM');
            const line = lines.indexOf(native.text), info = resolve(doc, line).cardInfo;
            assert.deepEqual(info.card.map(f => f.n), native.fields.map(f => f.name));
            assert.equal(info.nativeInstanceStart, 0);
            for (let i = 0; i < 5; i++) {
                const field = info.card[i], hover = await provider.provideHover(doc, { line, character: field.p });
                assert.equal(Number(field.rawValue), native.fields[i].value);
                assert.ok(hover.contents[0].value.includes(`**${field.n}**`));
                assert.equal(hover.range.start.line, line);
                assert.equal(hover.range.start.character, field.nativeRange.start);
                assert.equal(hover.range.end.character, field.nativeRange.end);
            }
            const block = collectOptionSwitchBlock(doc, keywordLine, {});
            assert.deepEqual(block.records.map(r => r.text), ['1000,2', native.text]);
            assert.deepEqual(block.records[1].comments, source === text ? ['   $ indented ordinary comment'] : []);
            const model = buildKeywordOptionViewModel({ document: doc, selection: { active: { line, character: 0 } } }, line, {});
            const card = model.managerCards.find(card => card.fields.some(f => f.name === 'A'));
            assert.equal(card.line, line);
            assert.equal(card.fields.find(f => f.name === 'A').value, '1');
            const semantic = buildSemanticDocumentContext(doc, keywordLine, loadKeywordSchema(), ['ELFORM', 'A']);
            assert.equal(semantic.context.fields.get('ELFORM'), '2');
            assert.equal(semantic.context.fields.get('A'), '1');
        }
        const doc = fakeDoc(text);
        assert.equal(resolve(doc, native.sourceLine - 1).cardInfo, null);
        assert.equal(await provider.provideHover(doc, { line: native.sourceLine - 1, character: 8 }), null);
    });
    it('resolves all 888 native SOLID/EFG/SPG samples through the actual provider', async function () {
        this.timeout(60000); // 34,336 individual field hovers across independently saved cases.
        const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
        const proof = require("../../fixtures/public-behavior/section-solid-verification.json");
        const probes = require("../../fixtures/public-behavior/section-solid-cases.json");
        const bytes = fs.readFileSync(path.join(__dirname, "../../fixtures/public-behavior/native-inputs/section-solid-input.k"));
        const saved = fs.readFileSync(path.join(__dirname, "../../fixtures/public-behavior/native-inputs/section-solid-saved.k"));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), proof.inputSha256);
        assert.equal(crypto.createHash('sha256').update(saved).digest('hex'), proof.outputSha256);
        assert.equal(proof.complete, true);
        const doc = { ...fakeDoc(bytes.toString()), version: 1 }, provider = new LsdynaFieldHoverProvider();
        for (const probe of probes) for (const record of probe.records) {
            const info = resolve(doc, record.line).cardInfo;
            assert.ok(info, `${probe.keyword} ${probe.format} ${probe.id}`);
            assert.equal(info.nativeCardIndex, record.cardIndex);
            assert.equal(info.nativeInstanceStart, 0);
            assert.ok(info.nativeConditions.includes(`ELFORM=${probe.controls.ELFORM}`));
            assert.deepEqual(info.card.map(f => label(f.n)), record.fields.map(f => label(f.name)));
            for (const [index, expected] of record.fields.entries()) {
                const field = info.card[index];
                assert.equal(Number(field.rawValue), Number(expected.value));
                const hover = await provider.provideHover(doc, { line: record.line, character: field.p });
                assert.ok(hover?.contents[0].value.toUpperCase().includes(`**${label(expected.name)}**`));
                assert.equal(hover.range.start.character, field.nativeRange.start);
                assert.equal(hover.range.end.character, field.nativeRange.end);
            }
        }
    });
    it('retains SOLID controller identity when its value is unknown and stops the affected tail', () => {
        for (const comments of [[], ['$# WRONG HEADER'], ['$ ordinary note', '$HMNAME metadata']]) {
            const lines = ['*SECTION_SOLID', '91,101', ...comments, '&UNRESOLVED,0,0,0,9', '1,2,3,4', '*END'];
            const doc = fakeDoc(lines.join('\n')), controller = 2 + comments.length;
            assert.deepEqual(resolve(doc, controller).cardInfo.card.map(f => f.n), ['NIP','NXDOF','IHGF','ITAJ','LMC','NHSV','XNOD','UNUSED']);
            assert.equal(resolve(doc, controller + 1).cardInfo, null);
        }
        const doc = fakeDoc('*SECTION_SOLID\n91,101\n1,0,0,0,0\n1,2,3,4\n92,1\n*END');
        assert.equal(resolve(doc, 3).cardInfo.card[0].n, 'XI');
        assert.equal(resolve(doc, 4).cardInfo.nativeInstanceStart, 3);
        assert.equal(resolve(doc, 4).cardInfo.card[0].n, 'SECID');
    });
    it('resolves native TSHELL, POINT_SOURCE and IGA tails through the actual provider', async function () {
        this.timeout(10000); // Thousands of independent provider calls, not a per-hover budget.
        const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
        const proof = require("../../fixtures/public-behavior/section-tail-verification.json");
        const probes = require("../../fixtures/public-behavior/section-tail-cases.json");
        const bytes = fs.readFileSync(path.join(__dirname, "../../fixtures/public-behavior/native-inputs/section-tail-input.k"));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), proof.inputSha256);
        const saved = fs.readFileSync(path.join(__dirname, "../../fixtures/public-behavior/native-inputs/section-tail-saved.k"));
        assert.equal(crypto.createHash('sha256').update(saved).digest('hex'), proof.outputSha256);
        const doc = { ...fakeDoc(bytes.toString()), version: 1 }, provider = new LsdynaFieldHoverProvider();
        for (const probe of probes) for (const record of probe.records) {
            const info = resolve(doc, record.line).cardInfo;
            assert.ok(info, `${probe.keyword} ${probe.format} ${probe.id}`);
            assert.equal(info.nativeCardIndex, record.cardIndex);
            assert.equal(info.nativeInstanceStart, 0);
            assert.deepEqual(info.card.map(f => label(f.n)), record.fields.map(f => label(f.name)));
            for (const [index, expected] of record.fields.entries()) {
                const field = info.card[index];
                assert.equal(Number(field.rawValue), Number(expected.value));
                const hover = await provider.provideHover(doc, { line: record.line, character: field.p });
                assert.ok(hover?.contents[0].value.toUpperCase().includes(`**${label(expected.name)}**`));
                assert.equal(hover.range.start.character, field.nativeRange.start);
                assert.equal(hover.range.end.character, field.nativeRange.end);
            }
        }
        for (const value of ['&UNRESOLVED', '2', '-1']) {
            const incomplete = fakeDoc(`*SECTION_TSHELL\n1,1,1,9,1,0,${value}\n1,1,1,1,1,1,1,1\n*END`);
            assert.ok(resolve(incomplete, 1).cardInfo, 'keep the proven head');
            assert.equal(resolve(incomplete, 2).cardInfo, null, 'pending native boundary evidence');
        }
    });
    it('resolves the 240 native SECTION instances and their actual provider ranges', async () => {
        const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
        const proof = require("../../../keywords/runtime/native-readers/lspp-section-fixed-readers.json");
        const probes = require("../../fixtures/public-behavior/section-fixed-cases.json");
        const bytes = fs.readFileSync(path.join(__dirname, "../../fixtures/public-behavior/native-inputs/section-fixed-input.k"));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), proof.evidence.inputSha256);
        const saved = fs.readFileSync(path.join(__dirname, "../../fixtures/public-behavior/native-inputs/section-fixed-saved.k"));
        assert.equal(crypto.createHash('sha256').update(saved).digest('hex'), proof.evidence.outputSha256);
        const doc = { ...fakeDoc(bytes.toString()), version: 1 }, provider = new LsdynaFieldHoverProvider();
        for (const probe of probes) for (const record of probe.records) {
            const info = resolve(doc, record.line).cardInfo;
            assert.ok(info, `${probe.keyword} ${probe.format} ${probe.id} ${record.cardIndex}`);
            assert.equal(info.nativeCardIndex, record.cardIndex);
            assert.equal(info.nativeInstanceStart, probe.instance * (probe.records.length + Number(probe.keyword.endsWith('_TITLE'))));
            assert.deepEqual(info.card.map(f => label(f.n)), record.fields.map(f => label(f.name)));
            for (const [index, expected] of record.fields.entries()) {
                const field = info.card[index];
                assert.equal(Number(field.rawValue), Number(expected.value));
                const hover = await provider.provideHover(doc, { line: record.line, character: field.p });
                assert.ok(hover?.contents[0].value.toUpperCase().includes(`**${label(expected.name)}**`), `${probe.keyword} ${expected.name}`);
                assert.equal(hover.range.start.character, field.nativeRange.start);
                assert.equal(hover.range.end.character, field.nativeRange.end);
            }
        }
    });
    it('uses the six file-verified DATABASE grammars in all four formats', () => {
        const evidence = require("../../fixtures/public-behavior/database-records.json");
        for (const native of evidence.rows) for (const format of ['standard', 'long', 'i10', 'comma']) for (const suffix of ['', '_ID']) {
            const keyword = `DATABASE_${native.name}${suffix}`;
            if (suffix && native.name === 'BINARY_D3DAT') continue; // No native ID spelling registration.
            const c = { keyword, cards: Array.from({ length: native.card_count }, (_, i) => i + 1),
                values: { DT: 42, CYCL: 17 } };
            const { doc, positions } = source(c, { format });
            positions.forEach((line, i) => {
                const info = resolve(doc, line).cardInfo;
                assert.ok(info, `${keyword} ${format}`);
                assert.deepEqual(info.card.map(f => label(f.n)), native.cards[i].fields.map(f => label(f.name)));
                assert.equal(info.nativeCardIndex, i + 1);
            });
        }
    });

    it('uses resolved native fields for predicates and rejects ambiguous repeated instances', () => {
        const { buildSemanticDocumentContext } = require("../../../out/core/semantics/semanticDocumentContext");
        const { loadKeywordSchema } = require("../../../out/core/keywordSchema");
        const schema = loadKeywordSchema();
        const c = cases.find(c => c.keyword === 'SECTION_BEAM' && c.values.ELFORM === 2 && !c.values.STYPE);
        for (const format of ['standard', 'long', 'i10', 'comma']) {
            const { doc } = source(c, { format });
            const result = buildSemanticDocumentContext(doc, 0, schema, ['ELFORM', 'A']);
            assert.equal(result.unsupportedFormat, false);
            assert.equal(result.context.fields.get('ELFORM').trim(), '2');
            assert.ok(result.context.fields.has('A'));
            assert.deepEqual(result.unresolvedFields, []);
        }
        const repeated = fakeDoc('*SECTION_BEAM\n1,2\n3,4,5\n2,2\n6,7,8\n*END');
        const result = buildSemanticDocumentContext(repeated, 0, schema, ['ELFORM', 'A']);
        assert.deepEqual(result.unresolvedFields, ['A', 'ELFORM']);
        assert.equal(result.context.fields, undefined);
    });

    it('selects all twelve native ALE volume branches and stops after its two file records', () => {
        const keyword = 'ALE_STRUCTURED_MESH_VOLUME_FILLING';
        const form = catalog().formForKeyword(keyword), rule = form.rules[form.reference.formRuleIds[0]];
        for (const item of rule.recordSelection.cases) for (const format of ['standard', 'long', 'i10', 'comma']) {
            const fields = rule.recordSelection.cards.find(c => c.cardIndex === item.cardIndex).fields;
            const rows = format === 'comma' ? ['1,,,', `${item.value},1,23`] :
                ['1'.padStart(format === 'long' ? 20 : 10),
                    item.value.padEnd(10).padEnd(format === 'long' ? 20 : 10) + '1'.padStart(format === 'long' ? 20 : 10)];
            const marker = format === 'long' ? ' +' : format === 'i10' ? ' %' : '';
            const doc = fakeDoc([`*${keyword}${marker}`, ...rows, '*END'].join('\n'));
            const info = resolve(doc, 2).cardInfo;
            assert.ok(info, `${item.value} ${format}`);
            assert.deepEqual(info.card.map(f => label(f.n)), fields.map(f => label(f.name)));
            assert.equal(info.nativeCardIndex, item.cardIndex);
            assert.equal(info.card[0].rawValue, item.value);
            // The native GEOM selector reads ten bytes, but the observed LONG
            // field span is twenty (dynamic-hover-suffix-remaining-final).
            if (format === 'long') assert.equal(info.card[0].nativeRange.end, 20);
            const extra = fakeDoc([`*${keyword}${marker}`, ...rows, '99,PLANE', '*END'].join('\n'));
            assert.equal(resolve(extra, 3).cardInfo, null);
        }
    });

    it('maps every record in the 61 native-verified layouts without using comment headers', () => {
        for (const c of cases) {
            const { doc, positions, cards } = source(c);
            positions.forEach((line, i) => {
                const result = resolve(doc, line);
                assert.ok(result.cardInfo, `${c.keyword} ${c.id} ${i}: ${result.reason}`);
                assert.equal(result.cardInfo.nativeCardIndex, c.cards[i]);
                assert.deepEqual(result.cardInfo.card.map(f => label(f.n)), cards[c.cards[i] - 1].fields.map(f => label(f.name)));
            });
        }
    });

    it('shows the active name, help and range through the actual provider', async () => {
        for (const [keyword, match, record, field, expected] of [
            ['SECTION_BEAM', v => v.ELFORM === 2 && !v.STYPE, 1, 0, 'A'],
            ['SECTION_SHELL', v => v.ELFORM === 2 && v.NIP === 9 && v.ICOMP === 1, 3, 0, 'Bi'],
            ['MAT_213', v => v.FTYPE === 1, 7, 1, 'FV0'],
        ]) {
            const c = cases.find(c => c.keyword === keyword && match(c.values));
            for (const format of ['standard', 'comma', 'long', 'i10']) for (const title of [false, true]) {
                const { doc, positions } = source(c, { format, title });
                const info = resolve(doc, positions[record]).cardInfo;
                const target = info.card[field];
                assert.equal(target.n, expected);
                assert.equal(info.nativeInstanceStart, 0);
                const hover = await new LsdynaFieldHoverProvider().provideHover(doc,
                    { line: positions[record], character: target.p });
                assert.ok(hover, `${keyword} ${format} ${title}`);
                const markdown = hover.contents[0].value;
                assert.ok(markdown.includes(`**${expected}**`), markdown);
                assert.ok(!markdown.includes('**TS1**') && !markdown.includes('**NIPP**') && !markdown.includes('**UNUSED**'), markdown);
                assert.equal(hover.range.start.character, target.p);
                assert.equal(hover.range.end.character, target.nativeRange.end);
                assert.ok(!markdown.includes('extension.pickOfficialFieldValue'), 'no unverified write binding');
            }
        }
    });

    it('keeps identity and raw values invariant under stale and unrelated headers', () => {
        const c = cases.find(c => c.keyword === 'SECTION_BEAM' && c.values.ELFORM === 2 && !c.values.STYPE);
        let baseline;
        for (const comments of [[], ['$ note'], ['$#       TS1       TS2'], ['$#         A       ISS'], ['$HMNAME unrelated']]) {
            const { doc, positions } = source(c, { comments });
            const value = resolve(doc, positions[1]).cardInfo.card.map(f => [f.n, f.rawValue, f.nativeIdentity]);
            if (baseline) assert.deepEqual(value, baseline); else baseline = value;
        }
    });

    it('uses the same active fields in keyword overview and field hover', async () => {
        const doc = fakeDoc('*SECTION_BEAM\n1,2\n3,4,5\n*END');
        const hover = await new LsdynaFieldHoverProvider().provideHover(doc, { line: 0, character: 3 });
        assert.ok(hover.contents[0].value.includes('<sub>A</sub>'));
        assert.ok(!hover.contents[0].value.includes('<sub>TS1</sub>'));
        const invalid = fakeDoc('*SECTION_BEAM\n1,&FORM\n3,4,5\n*END');
        const unresolved = await new LsdynaFieldHoverProvider().provideHover(invalid, { line: 0, character: 3 });
        assert.ok(!unresolved.contents[0].value.includes('<sub>TS1</sub>') && !unresolved.contents[0].value.includes('<sub>A</sub>'));
    });

    it('reuses a current-version field result and does not let cancellation poison later reads', async () => {
        const { resolveCardForDocumentLine } = require("../../../out/core/keywordSchema");
        const doc = { ...fakeDoc('*SECTION_BEAM\n1,2\n3,4,5\n*END'), version: 1 };
        const first = resolveCardForDocumentLine(doc, 2, undefined, { keywordLine: 0 });
        assert.equal(resolveCardForDocumentLine(doc, 2, undefined, { keywordLine: 0 }).cardInfo, first.cardInfo);
        assert.equal(await new LsdynaFieldHoverProvider().provideHover(doc, { line: 2, character: 0 },
            { isCancellationRequested: true }), null);
        const cancelled = resolveCardForDocumentLine(doc, 2, undefined, { keywordLine: 0,
            cancellationToken: { isCancellationRequested: true } });
        assert.equal(cancelled.reason, 'field-context-cancelled');
        assert.ok(resolveCardForDocumentLine(doc, 2, undefined, { keywordLine: 0 }).cardInfo);
    });

    it('keeps a proven head when the controller or suffix is incomplete and never guesses the branch', () => {
        const doc = fakeDoc('*SECTION_BEAM\n         1    &FORM\n         9\n*END');
        assert.equal(resolve(doc, 1).cardInfo.card[0].n, 'SECID');
        assert.equal(resolve(doc, 2).cardInfo, null);
        const mat = fakeDoc('*MAT_213\n         1\n*END');
        assert.equal(resolve(mat, 1).cardInfo.card[0].n, 'MID');
    });

    it('tracks mixed instances after more than 32 rows and invalidates after controller edits', () => {
        const rows = Array.from({ length: 20 }, (_, i) => [`${i + 1},1`, '1,2,3,4']).flat();
        const doc = fakeDoc(['*SECTION_BEAM', ...rows, '*END'].join('\n'));
        assert.equal(resolve(doc, 40).cardInfo.nativeInstanceStart, 38);
        const c = cases.find(c => c.keyword === 'SECTION_BEAM' && c.values.ELFORM === 2 && !c.values.STYPE);
        const { lines } = source(c);
        const mutable = { ...fakeDoc([...lines, '*END'].join('\n')), version: 1,
            lineAt: line => ({ text: [...lines, '*END'][line] }) };
        assert.equal(resolve(mutable, 2).cardInfo.card[0].n, 'A');
        lines[1] = lines[1].slice(0, 10) + '1'.padStart(10) + lines[1].slice(20);
        mutable.version++;
        assert.equal(resolve(mutable, 2).cardInfo.card[0].n, 'TS1');
    });

    it('uses the native ten-column LONG dispatch without reinterpreting extra MAT records', () => {
        const c = cases.find(c => c.keyword === 'MAT_213' && c.values.FTYPE === 1);
        const { lines } = source(c, { format: 'long' });
        lines[8] = '1'.padStart(20) + lines[8].slice(20);
        const doc = fakeDoc([...lines, '*END'].join('\n'));
        assert.ok(resolve(doc, 7).cardInfo);
        assert.equal(resolve(doc, 8).cardInfo.nativeCardIndex, 8);
        assert.equal(resolve(doc, 8).cardInfo.card[1].n, 'UNUSED');
        const good = source(c);
        const extra = fakeDoc([...good.lines, '123', '*END'].join('\n'));
        assert.equal(resolve(extra, 12).cardInfo, null);
        assert.equal(resolve(extra, 11).cardInfo.nativeCardIndex, 11);
    });
    it('keeps the full LONG field range separate from the FTYPE branch prefix', async () => {
        const c = cases.find(c => c.keyword === 'MAT_213' && c.values.FTYPE === 1);
        const { lines } = source(c, { format: 'long' });
        const doc = fakeDoc([...lines, '*END'].join('\n'));
        const field = resolve(doc, 8).cardInfo.card[0];
        assert.equal(field.n, 'FTYPE');
        assert.equal(field.w, 20);
        assert.deepEqual(field.nativeRange, { start: 0, end: 20 });
        const hover = await new LsdynaFieldHoverProvider().provideHover(doc, { line: 8, character: 15 }, { isCancellationRequested: false });
        assert.ok(hover);
        assert.equal(hover.range.start.character, 0);
        assert.equal(hover.range.end.character, 20);
    });
});
