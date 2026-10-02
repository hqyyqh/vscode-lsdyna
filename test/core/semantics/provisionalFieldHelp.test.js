'use strict';

const assert = require('node:assert/strict');
const {
    resolveProvisionalFieldHelp,
} = require('../../../out/core/semantics/provisionalFieldHelp');

describe('provisional field help fallback', () => {
    const field = { n: 'PID', t: 'integer', p: 10, w: 10 };

    it('keeps strict help authoritative and unmarked', () => {
        const result = resolveProvisionalFieldHelp({ field, strictText: 'Part identifier' });
        assert.deepEqual(result, {
            text: 'Part identifier',
            source: 'strict',
            provisional: false,
            identity: 'strict:unknown:PID',
        });
    });

    it('localizes only generated fallback prose, preserving supplied source text', () => {
        const generated = resolveProvisionalFieldHelp({ field, keyword: '*PART', cardIndex: 1, language: 'zh-cn' });
        assert.equal(generated.text, '*PART 第 1 张卡片的字段 PID（类型：整数，第 11—20 列）。完整定义请查阅已配置的手册。');
        assert.equal(generated.provisional, true);
        assert.equal(resolveProvisionalFieldHelp({ field, language: 'zh-cn', schemaText: 'Untranslated source' }).text,
            'Untranslated source');
    });

    it('uses relaxed records before manual context', () => {
        const result = resolveProvisionalFieldHelp({
            field,
            relaxedRecord: {
                finalPhysicalFieldId: 'global-manual-physical-field:abc',
                officialDescriptionText: 'Relaxed description',
            },
            manualContext: 'Manual chapter',
        });
        assert.equal(result.source, 'relaxed-model');
        assert.equal(result.provisional, true);
        assert.equal(result.identity, 'global-manual-physical-field:abc');
    });

    it('falls through manual, schema and finally a geometry-aware name', () => {
        assert.equal(resolveProvisionalFieldHelp({ field, manualContext: 'Manual chapter' }).source, 'manual-context');
        assert.equal(resolveProvisionalFieldHelp({ field, schemaText: 'LS-PrePost help' }).source, 'lspp-schema');
        const result = resolveProvisionalFieldHelp({ field, keyword: '*PART', cardIndex: 1 });
        assert.equal(result.source, 'field-name');
        assert.match(result.text, /\*PART Card 1 field PID/);
        assert.match(result.text, /columns 11-20/);
    });
});
