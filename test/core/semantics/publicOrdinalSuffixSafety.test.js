'use strict';
require("../../support/register-out");
const assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib');
const {fakeDoc}=require("../../support/helpers");
const assertReadonlyReader=require('../../support/keyword-manager/readonly-reader.cjs');
const fixtures=JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve("../../fixtures/public-behavior/mixed-reader-safety.json.gz"))));
const schema=require("../../../out/core/keywordSchema");
const {buildKeywordOptionViewModel,buildKeywordOptionsViewState,getCardFieldsForLine,LsdynaFieldCompletionProvider}=require("../../../out/extension")._internals;
const archive={plan:{tasks:fixtures.ordinal}};
describe('ordinal suffix manager and invalidation boundaries',function(){this.timeout(30000);
it('uses actual source branches in manager and retains operation restrictions for every input format', async () => {
        for (const task of archive.plan.tasks) {
            const document = { ...fakeDoc(task.lines.join('\n')), version: 1 };
            for (const expected of task.expectedRecords) {
                const line = expected.lineOffset;
                const result = schema.resolveCardForDocumentLine(document, line);
                assert.equal(result.status, 'resolved', task.id + ':' + line);
                assert.equal(result.cardInfo.nativeCardIndex, expected.cardIndex);
                assert.deepEqual(result.cardInfo.card.map(f => f.nativeIdentity.fieldRecordId), expected.fields.map(f => f.address));
                assert.equal(getCardFieldsForLine(document, line), null);
            }
            if (task.controls.length !== 1 || task.expectedRecords.length !== 2) continue;
            const view = buildKeywordOptionViewModel({ document, selection: { active: { line: 1, character: 0 } } }, 1, {});
            assert.deepEqual(view.managerCards.map(c => c.fields.map(f => f.name)), task.expectedRecords.map(r => r.fields.map(f => f.name)));
            assertReadonlyReader(document, 1);
            assert.equal(buildKeywordOptionsViewState(view).canApply, false);
            assert.deepEqual(await new LsdynaFieldCompletionProvider().provideCompletionItems(document, { line: 1, character: 0 }, null, {}), []);
        }
    });
it('invalidates branch choices after control edits and keeps unknown controls uncertain', () => {
        for (const keyword of ['BOUNDARY_AMBIENT_ID', 'DATABASE_FREQUENCY_BINARY_D3SPCM_ID']) {
            const ambient = keyword.startsWith('BOUNDARY');
            const rows = ['*' + keyword, ambient ? '1,2,4,0' : '3', ambient ? '7,8' : '1,probe.dat'];
            const document = { ...fakeDoc(rows.join('\n')), version: 1 };
            const original = document.lineAt.bind(document);
            let head = rows[1];
            document.lineAt = line => line === 1 ? { ...original(line), text: head } : original(line);
            const tail = () => schema.resolveCardForDocumentLine(document, 2);
            assert.equal(tail().cardInfo.nativeCardIndex, 2);
            head = ambient ? '1,2,0,0' : '0'; document.version++;
            assert.equal(tail().cardInfo.nativeCardIndex, 1);
            head = rows[1]; document.version++;
            assert.equal(tail().cardInfo.nativeCardIndex, 2);
            head = ambient ? '1,2,&UNKNOWN,0' : '&UNKNOWN'; document.version++;
            assert.equal(schema.resolveCardForDocumentLine(document, 1).status, 'resolved');
            assert.equal(tail().status, 'unresolved');
        }
    });
});
