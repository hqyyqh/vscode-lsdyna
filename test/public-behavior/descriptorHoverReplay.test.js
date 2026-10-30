'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const { fakeDoc } = require("../support/helpers");
const assertReadonlyReader = require('../support/keyword-manager/readonly-reader.cjs');
const schema = require('../../out/core/keywordSchema');
const { LsdynaFieldHoverProvider, getCardFieldsForLine, buildKeywordOptionViewModel,
    buildKeywordOptionsViewState, LsdynaFieldCompletionProvider } = require('../../out/extension')._internals;
const plain = value => String(value || '').replace(/<\/?(?:span|br|wbr|p|em|strong|code)(?:\s[^<>]*)?\/?>/g, '')
    .replace(/\\([*_`])/g, '$1').replace(/\s+/g, ' ').trim();

describe('descriptor reader provider replay and editing boundaries', function () {
    this.timeout(120000); // Each document has at most 12,880 queries; keep per-document failures visible.
    const file = path.join(__dirname, '../fixtures/public-behavior/conditional-hover-replay.json.gz');
    let payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.fixtures.length, payload.coverage.documents);
    const provider = new LsdynaFieldHoverProvider();
    let count = 0;
    after(() => { payload = null; });
    for (let index = 0; index < payload.fixtures.length; index++) {
        it(`[full-corpus] replays retained input ${index + 1} with complete field help and physical ranges`, async () => {
            const fixture = payload.fixtures[index];
            const document = { ...fakeDoc(fixture.text, `/test/descriptor-replay-${index}.k`), version: 1 };
            for (const query of fixture.queries) {
                const hover = await provider.provideDetailedHover(document, { line: query.line, character: query.character },
                    { isCancellationRequested: false });
                assert.ok(hover, `${query.line}:${query.character} ${query.name}`);
                assert.ok(hover.contents.some(content => content.value?.toUpperCase().includes(`**${query.name.toUpperCase()}**`)), query.name);
                if (query.help) assert.ok(hover.contents.some(content => plain(content.value).includes(plain(query.help))), query.name);
                assert.deepEqual({ start: hover.range.start.character, end: hover.range.end.character }, query.range, query.name);
                count++;
            }
        });
    }
    it('[full-corpus] retains the complete replay query count', () => {
        assert.equal(count, payload.coverage.queries);
        assert.ok(count > 200000, 'Full branch/format replay coverage must remain present');
    });

    it('preserves signed count arithmetic without granting writes to unobserved branches', () => {
        const { selectConditionalLayout } = require('../../out/core/semantics/nativeConditionalLayout');
        const binding = { controls: { NF: { card: 1, field: 0, storage: 'int32' } }, steps: [1,
            { control: 'NF', maxCount: 256, nonPositive: 'empty', countFormula: 'native-int32-packed-pairs', repeat: [2] }] };
        for (const [nf, count] of [[-4, 2], [-3, 2], [-2, 1], [-1, 1], [0, 0], [1, 0], [2, 0], [3, 1], [4, 1], [5, 3], [8, 6]]) {
            const selected = selectConditionalLayout(binding, Array(count + 1).fill(''), false, () => String(nf),
                value => value, (_record, _field, value) => value, false, true);
            assert.equal(selected.complete, true, String(nf));
            assert.deepEqual(selected.current.map(record => record.cardIndex), [1, ...Array(count).fill(2)]);
        }
        const unseen = { controls: { X: { card: 1, field: 0, storage: 'int32' } },
            steps: [1, { control: 'X', op: 'eq', value: 1, then: [{ repeatToEnd: 2 }] }] };
        assert.equal(selectConditionalLayout(unseen, ['0'], false, () => '0', value => value,
            () => '1', false, false), null);
    });

    it('protects read-only conditional branches and retains completion restrictions', async () => {
        for (const [keyword, head, tail] of [['BOUNDARY_AMBIENT_ID', '1,2,4,0', '7,8'],
            ['DATABASE_FREQUENCY_BINARY_D3SPCM_ID', '3', '1,probe.dat']]) {
            const document = { ...fakeDoc(['*' + keyword, head, tail, '*END'].join('\n')), version: 1 };
            assert.equal(schema.resolveCardForDocumentLine(document, 2).status, 'resolved');
            assert.equal(getCardFieldsForLine(document, 2), null);
            const view = buildKeywordOptionViewModel({ document, selection: { active: { line: 1, character: 0 } } }, 1, {});
            assertReadonlyReader(document, 1);
            assert.equal(buildKeywordOptionsViewState(view).canApply, false);
            assert.deepEqual(await new LsdynaFieldCompletionProvider().provideCompletionItems(document,
                { line: 1, character: 0 }, null, {}), []);
        }
    });

    it('invalidates edited branch controls and keeps unknown controls uncertain', () => {
        for (const keyword of ['BOUNDARY_AMBIENT_ID', 'DATABASE_FREQUENCY_BINARY_D3SPCM_ID']) {
            const ambient = keyword.startsWith('BOUNDARY');
            const rows = ['*' + keyword, ambient ? '1,2,4,0' : '3', ambient ? '7,8' : '1,probe.dat'];
            const document = { ...fakeDoc(rows.join('\n')), version: 1 }, original = document.lineAt.bind(document);
            let head = rows[1];
            document.lineAt = line => line === 1 ? { ...original(line), text: head } : original(line);
            const tail = () => schema.resolveCardForDocumentLine(document, 2);
            assert.equal(tail().cardInfo.nativeCardIndex, 2);
            head = ambient ? '1,2,0,0' : '0'; document.version++; assert.equal(tail().cardInfo.nativeCardIndex, 1);
            head = rows[1]; document.version++; assert.equal(tail().cardInfo.nativeCardIndex, 2);
            head = ambient ? '1,2,&UNKNOWN,0' : '&UNKNOWN'; document.version++;
            assert.equal(schema.resolveCardForDocumentLine(document, 1).status, 'resolved');
            assert.equal(tail().status, 'unresolved');
        }
    });
});
