'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib'), crypto = require('node:crypto');
const { recordTemplate } = require("../../../out/core/completion/recordTemplate");
const { nativeKeywordTemplate } = require("../../../out/core/completion/nativeKeywordTemplate");
const { generate } = require("../../../scripts/build/generate-native-keyword-templates.cjs");
const schema = require("../../../out/core/keywordSchema");
const { fakeDoc } = require("../../support/helpers");
const { LsdynaKeywordCompletionProvider, LsdynaFieldCompletionProvider, getCardFieldsForLine } = require("../../../out/extension")._internals;
const expand = text => text.replace(/\$\{\d+:((?:\\.|[^\\}])*)\}/g,
    (_, value) => value.replace(/\\([\\$}])/g, '$1')).replace(/\$0/g, '');

describe('shared native keyword templates', () => {
    it('ships blank missing values while preserving genuine text defaults and title widths', () => {
        const input = JSON.parse(fs.readFileSync('snippets/lsdyna.json', 'utf8'));
        const rows = key => input[key].body.map(expand).filter(line => !line.startsWith('*') && !line.startsWith('$'));
        assert.equal(rows('*MAT_ELASTIC')[0], ' '.repeat(80));
        assert.equal(rows('*MAT_ELASTIC')[1].slice(0, 10).trim(), 'P');
        assert.equal(rows('*MAT_ELASTIC_TITLE')[0], ' '.repeat(80));
        assert.equal(rows('*AIRBAG_CPG')[0].slice(0, 10), ' '.repeat(10));
        assert.equal(rows('*AIRBAG_CPG')[0].slice(10, 20).trim(), '0');
        for (const [key, value] of [['*DUALCESE_D3PLOT', 'DENSITY'], ['*DUALCESE_ENSIGHT_REGION', 'BOX'],
            ['*LSO_VARIABLE_GROUP', 'NODE']]) assert.ok(rows(key).some(row => row.trim() === value), key);
    });
    it('uses declared defaults or width-preserving blanks for individual and row completions', async () => {
        for (const keyword of ['*NODE', '*MAT_ELASTIC', '*SECTION_SHELL']) {
            const doc = fakeDoc(keyword + '\n' + ' '.repeat(80));
            const fields = getCardFieldsForLine(doc, 1);
            assert.ok(fields?.length, keyword);
            const items = await new LsdynaFieldCompletionProvider().provideCompletionItems(doc, { line: 1, character: 0 });
            const row = items.find(item => item.sortText?.startsWith('0_'));
            assert.ok(row, keyword);
            for (const field of fields) {
                const item = items.find(item => item.sortText === '1_' + String(field.p).padStart(3, '0'));
                assert.ok(item, keyword + '/' + field.n);
                const value = expand(item.insertText.value);
                assert.equal(value.length, field.p + field.w);
                assert.equal(value.slice(field.p).trim(), field.d == null ? '' : String(field.d).trim());
                assert.equal(expand(row.insertText.value).slice(field.p, field.p + field.w), value.slice(field.p));
                assert.deepEqual([...item.insertText.value.matchAll(/\$\{(\d+):/g)].map(m => m[1]), ['1']);
            }
        }
    });
    it('excludes native-rejected descriptor aliases while retaining their accepted spellings', () => {
        const input = JSON.parse(fs.readFileSync('snippets/lsdyna.json', 'utf8'));
        for (const [rejected, accepted] of [['CONTROL_CHECK', 'CONTROL_CHECK_SHELL'],
            ['ICFD_DATABASE_VOL', 'ICFD_DATABASE_VOLUME'], ['EM_EP_EKG', 'EM_EP_ECG']]) {
            assert.equal(nativeKeywordTemplate(rejected).status, 'rejected-spelling');
            assert.equal(input['*' + rejected], undefined);
            assert.ok(input['*' + accepted]);
            assert.equal(generate({ ['*' + rejected]: { prefix: ['*' + rejected], body: ['*' + rejected] } }).snippets['*' + rejected], undefined);
        }
    });
    it('matches independently observed native field identities for all generated layouts', function () {
        this.timeout(20000);
        const archive=JSON.parse(zlib.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/template-reader-cases.json.gz')));
        const tasks=new Map(archive.tasks.map(task=>[task.id,task]));
        let checked=0;
        for(const job of archive.jobs){
            const proof={ observations: job.reads.map(read => ({ ...read, kind: 'fields' })) };
            let start=1;
            for(const id of job.tasks){
                const task=tasks.get(id),doc={...fakeDoc(task.lines.join('\n')),version:1};
                for(const record of task.expectedRecords){
                    const observed=proof.observations.find(o=>o.kind==='fields' && o.sourceLine===start+record.lineOffset);
                    assert.ok(observed);
                    const result=schema.resolveCardForDocumentLine(doc,record.lineOffset,undefined,{keywordLine:0,globalInputFormat:'standard'});
                    assert.equal(result.status,'resolved',task.keyword);
                    assert.deepEqual(result.cardInfo.card.map(f=>f.nativeIdentity.fieldRecordId),observed.fields.map(f=>f.descriptorAddress));
                }
                start+=task.lines.length;checked++;
            }
        }
        assert.equal(checked,180);
    });
    it('preserves string defaults, escapes snippet syntax and does not invent numeric defaults', () => {
        const result = recordTemplate([{ name: 'ID', type: 1, position: 0, width: 10 },
            { name: 'FILE', type: 0, position: 10, width: 30, defaultValue: 'x$y}\\file' }]);
        assert.equal(expand(result.snippet), result.text);
        assert.equal(result.text.slice(0, 10), ' '.repeat(10));
        assert.equal(result.text.slice(10).trim(), 'x$y}\\file');
        assert.equal(recordTemplate([{ name: 'ID', type: 1, position: 0, width: 2, defaultValue: '100' }]), null);
    });

    it('selects the LSPP initial BEAM branch without inserting the whole descriptor pool', () => {
        const result = nativeKeywordTemplate('SECTION_BEAM');
        assert.equal(result.status, 'native-layout');
        assert.deepEqual(result.cardIndexes, [1, 2]);
        const lines = result.body.map(expand).filter(line => !line.startsWith('$'));
        const doc = { ...fakeDoc(lines.join('\n')), version: 1 };
        const card = schema.resolveCardForDocumentLine(doc, 1, undefined, { keywordLine: 0, globalInputFormat: 'standard' });
        assert.equal(card.cardInfo.card.find(field => field.n === 'ELFORM').rawValue, '1');
        assert.equal(card.cardInfo.card.find(field => field.n === 'ELFORM').d, '1');
    });

    it('audits every built-in template, retains unknown rules and regenerates deterministically', function () {
        this.timeout(300000); // Two full generations plus every record; this is a correctness replay, not a latency gate.
        const input = JSON.parse(fs.readFileSync('snippets/lsdyna.json', 'utf8'));
        const first = generate(input), second = generate(first.snippets);
        assert.deepEqual(first.snippets, second.snippets);
        assert.equal(first.report.entries.length, Object.keys(input).length);
        let checked = 0;
        for (const entry of first.report.entries) {
            if (entry.status === 'retained-unverified') {
                assert.deepEqual(first.snippets[entry.keyword], input[entry.keyword]);
                continue;
            }
            if (entry.status !== 'native-layout') continue;
            const snippet = first.snippets[entry.keyword];
            const lines = snippet.body.slice(0, -1).map(expand).filter(line => !line.startsWith('$'));
            const doc = { ...fakeDoc(lines.join('\n')), version: 1 };
            for (let line = 1; line < lines.length; line++) {
                const result = schema.resolveCardForDocumentLine(doc, line, undefined,
                    { keywordLine: 0, globalInputFormat: 'standard' });
                assert.equal(result.status, 'resolved', `${entry.keyword}:${line}:${result.reason}`);
                assert.equal(result.cardInfo.nativeCardIndex, entry.cardIndexes[line - 1]);
            }
            checked++;
        }
        assert.ok(checked >= 100);
    });

    it('uses the same built-in body in keyword completion, including textual placeholders', () => {
        const input = JSON.parse(fs.readFileSync('snippets/lsdyna.json', 'utf8'));
        const byPrefix = new Map(Object.values(input).map(snippet => [snippet.prefix[0], snippet]));
        const doc = fakeDoc('*');
        const items = new LsdynaKeywordCompletionProvider().provideCompletionItems(doc, { line: 0, character: 1 });
        assert.ok(items.length > 100);
        for (const item of items) {
            const body = byPrefix.get(item.label).body.join('\n').replace(/\n\$0$/, '$0').replace(/^\*/, '');
            assert.equal(item.insertText.value, body, item.label);
        }
    });
});
