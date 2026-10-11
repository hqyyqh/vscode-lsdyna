import { getCatalogInputFormCatalogV4 } from "../semantics/catalogInputFormCatalogV4";
import { hasNativeFileReader, nativeFieldDisplayOnly } from '../semantics/nativeFieldResolution';
import { nativeFileReadContext } from '../semantics/nativeFileReadContext';
import { nativeFileCatalogKeyword, nativeOrdinalBinding, nativeBatchFixedBinding, nativeCompositePrefix, nativeFieldlessBinding, NATIVE_FILE_SOURCE } from "../semantics/catalogNativeFileLayout";
import { recordTemplate, nativeWindowRecordTemplate } from './recordTemplate';

/** Projection for new standard-format input; never edits an existing document. */
export function nativeKeywordTemplate(keyword: string) {
    keyword = keyword.replace(/^\*/, '').toUpperCase();
    if (nativeFieldlessBinding(keyword)) return { status: 'native-header-only' as const,
        body: ['*' + keyword, '$0'], source: NATIVE_FILE_SOURCE };
    
    // CHECK's obsolete key differs from CHECK_SHELL; do not rewrite it as an alias.
    if (['CONTROL_CHECK', 'ICFD_DATABASE_VOL', 'EM_EP_EKG'].includes(keyword)) {
        return { status: 'rejected-spelling' as const, source: NATIVE_FILE_SOURCE };
    }
    if (/_TITLE$/.test(keyword) && nativeOrdinalBinding(keyword)?.titleSpelling === 'rejected') {
        return { status: 'rejected-spelling' as const, source: NATIVE_FILE_SOURCE };
    }
    const pending = (reason: string) => ({ status: 'retained-unverified' as const, reason });
    if (nativeFieldDisplayOnly(keyword)) return pending('native-edit-binding-unverified');
    if (!hasNativeFileReader(keyword)) return pending('file-rule-unconfirmed');
    const form = getCatalogInputFormCatalogV4().formForKeyword(nativeFileCatalogKeyword(keyword), false);
    const ruleIds = nativeBatchFixedBinding(keyword) ? [nativeBatchFixedBinding(keyword).ruleId] : form?.reference.formRuleIds;
    if (form?.source?.datasetSha256 !== NATIVE_FILE_SOURCE || form.source.isUnauditedDiagnostic ||
        ruleIds?.length !== 1 || !form.rules[ruleIds[0]]) return pending('file-rule-association-unconfirmed');
    const raw = form.rules[ruleIds[0]];
    const rule = { ...raw, catalogSource: form.source, cards: raw.recordSelection?.cards || raw.cards };
    const initial = nativeFileReadContext(rule, '*' + keyword, [], 'standard');
    if (initial.kind?.startsWith('unsupported')) return pending('file-rule-source-unconfirmed');
    const cards = new Map(initial.cards);
    if (/_TITLE$/.test(keyword)) cards.set(0, { cardIndex: 0,
        fields: [{ name: 'TITLE', type: 0, position: 0, width: 80, defaultValue: '' }] });
    const ordered = [...cards.values()].sort((a, b) => a.cardIndex - b.cardIndex);
    const templateFor = (card: any, tab = 1) => nativeBatchFixedBinding(keyword)?.readWindows
        ? nativeWindowRecordTemplate(card, NATIVE_FILE_SOURCE, tab) : recordTemplate(card.fields, tab);
    const seed = ordered.map(card => templateFor(card));
    if (seed.some(row => !row)) return pending('default-or-record-geometry-unconfirmed');
    let rows = seed.map(row => row.text);
    if (initial.kind === 'element-composite') {
        const prefix = nativeCompositePrefix(cards.size, [6, 7, 8, 9].map(field => Number(initial.read(rows[0], 1, field))));
        if (!prefix) return pending('initial-branch-unconfirmed');
        // A new template offers one layer slot. Inactive descriptor cards must
        // not be mistaken for source layers or a following entity header.
        rows = [...prefix, cards.size].map(index => templateFor(cards.get(index)).text);
    }
    const selection = nativeFileReadContext(rule, '*' + keyword, rows, 'standard').select(true);
    const records = selection?.current?.filter(record => record.instanceStart === 0);
    if (!records?.length || !records.some(record => record.cardIndex !== 0)) return pending('initial-branch-unconfirmed');
    // Require the selected prefix to form a complete instance on its own.
    const selectedRows = records.map(record => templateFor(cards.get(record.cardIndex))?.text);
    const complete = nativeFileReadContext(rule, '*' + keyword, selectedRows, 'standard').select(false);
    if (!complete?.current || complete.current.length !== records.length ||
        complete.current.some((record, index) => record.cardIndex !== records[index].cardIndex)) return pending('initial-instance-incomplete');
    const body = ['*' + keyword];
    let tab = 1;
    for (const record of records) {
        const template = templateFor(cards.get(record.cardIndex), tab);
        if (!template) return pending('selected-record-geometry-unconfirmed');
        if (template.header) body.push(template.header);
        body.push(template.snippet);
        tab = template.nextTab;
    }
    body.push('$0');
    return { status: 'native-layout' as const, body, source: NATIVE_FILE_SOURCE,
        ruleId: ruleIds[0], cardSetId: rule.cardSetId,
        cardIndexes: records.map(record => record.cardIndex) };
}
