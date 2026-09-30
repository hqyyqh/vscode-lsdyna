'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require('./helpers');
const { getEnglishFieldHelp } = require('../out/core/keywordSchema');
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve } = require('../out/extension')._internals;
const readers = require('../keywords/lspp-contact-id-mpp-fixed-readers.json');
const {specimens,evidence}=require('./fixtures/public-behavior/contact-id-mpp.json');

describe('native CID/TITLE-only CONTACT_ID_MPP aliases', function () {
    this.timeout(120000);
    it('binds 60 single-form aliases in all four formats to every observed native field', async () => {
        assert.equal(Object.keys(readers.bindings).length, 60);
        assert.equal(specimens.tasks.length, 240);
        const provider = new LsdynaFieldHoverProvider();
        for (const task of specimens.tasks) {
            const doc = fakeDoc([...task.lines, '*END'].join('\n'));
            for (const expected of task.expectedRecords) {
                const info = resolve(doc, expected.lineOffset).cardInfo;
                assert.ok(info, `${task.id} card ${expected.cardIndex}`);
                assert.equal(info.nativeCardIndex, expected.cardIndex, task.id);
                assert.deepEqual(info.card.map(field => field.nativeIdentity?.fieldRecordId),
                    expected.fields.map(field => field.address), task.id);
                assert.deepEqual(info.card.map(field => field.n), expected.fields.map(field => field.name), task.id);
                for (const field of info.card) {
                    const descriptor = evidence.nativeDescriptors[field.nativeIdentity.fieldRecordId];
                    assert.ok(descriptor, `${task.id}: ${field.n} native descriptor`);
                    assert.equal(getEnglishFieldHelp(field)?.trim() || '', descriptor.help?.trim() || '',
                        `${task.id}: ${field.n} help`);
                    assert.equal(field.t, [0, -2].includes(descriptor.type) ? 'string' :
                        Math.abs(descriptor.type) === 1 ? 'integer' : 'real', `${task.id}: ${field.n} type`);
                }
                const first = info.card.find(field => field.nativeRange.end > field.nativeRange.start);
                if (first) {
                    const hover = await provider.provideHover(doc,
                        { line: expected.lineOffset, character: first.nativeRange.start });
                    assert.ok(hover, `${task.id} card ${expected.cardIndex}`);
                    assert.ok(hover.contents[0].value.includes(`**${first.n}**`), task.id);
                    assert.equal(hover.range.start.character, first.nativeRange.start, task.id);
                    assert.equal(hover.range.end.character, first.nativeRange.end, task.id);
                }
            }
        }
    });
});
