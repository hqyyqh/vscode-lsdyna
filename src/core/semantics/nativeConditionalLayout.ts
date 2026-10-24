import { keywordDataPath } from "../keywordDataPath";
import type { NativeFileRecord } from "./catalogNativeFileLayout";

/** Sequential file-reader branches. These rules are transcribed from native file
 * functions and checked against archived reads, not GUI visibility snapshots. */
const data = require(keywordDataPath("native-readers/lspp-conditional-layout-readers.json"));
const optionalFormHeaders = require(keywordDataPath("native-readers/lspp-optional-form-header-readers.json"));
const singleCardReaders = require(keywordDataPath("native-readers/lspp-single-card-readers.json"));
const standardRepeatReaders = require(keywordDataPath("native-readers/lspp-standard-repeat-readers.json"));
const tailRepeatReaders = require(keywordDataPath("native-readers/lspp-tail-repeat-readers.json"));
if (optionalFormHeaders.sourceSha256 !== data.sourceSha256) throw new Error('Optional form header source mismatch');
if (singleCardReaders.sourceSha256 !== data.sourceSha256) throw new Error('Single-card reader source mismatch');
if (tailRepeatReaders.sourceSha256 !== data.sourceSha256) throw new Error('Tail-repeat reader source mismatch');
if (standardRepeatReaders.sourceSha256 !== data.sourceSha256) throw new Error('Standard-repeat reader source mismatch');
const controlBits = new DataView(new ArrayBuffer(4));
const dmnBinding = {
    kind: 'conditional-sequence',
    cardSetId: "record:4b406e2a862b77b1bf7aac6a:2f24343f37e52eaaea02be91",
    cardCount: 8,
    controls: {
        ISO: { card: 3, field: 2, storage: 'int32' },
        ITC: { card: 5, field: 6, storage: 'int32' },
        DAM: { card: 3, field: 3, storage: 'int32' },
    },
    steps: [
        1, 2, 3,
        { control: 'ISO', op: 'eq', value: 1, then: [4] },
        5,
        { control: 'ITC', op: 'in', values: [1, 3], then: [6] },
        { control: 'DAM', op: 'in', values: [1, 2], then: [7] },
        8,
    ],
    displayOnly: true,
};
const dmnBindings: Record<string, any> = {
    MAT_DMN_COMPOSITE_FRC: dmnBinding,
    MAT_DMN_COMPOSITE_FRC_TITLE: dmnBinding,
    MAT_303: dmnBinding,
    MAT_303_TITLE: dmnBinding,
};
export function nativeConditionalBinding(keyword: string): any {
    const name = keyword.replace(/^\*/, '');
    // Original 4.14 reads: two repeated records in each format, including the
    // SBRID field and all eight numeric values. The old standard-only proof
    // scope must not reject the independently verified formats.
    const seatbelt = standardRepeatReaders.bindings[name];
    if (name === 'ELEMENT_SEATBELT' && standardRepeatReaders.sourceSha256 ===
        "a88ab2e74e93a959971f487c72fa62bec157a3c762c37718e5571738a3ce50b5" &&
        seatbelt?.kind === 'fixed-instances' && seatbelt.cardSetId === "record:1786cdc8dc093e114e364515:d23a0768da66a245c955bbc9" && seatbelt.cardCount === 1)
        return { ...seatbelt, supportedFormats: ['standard', 'comma', 'long', 'i10'] };
    
    // formats, including TITLE. Reuse the two exact registration pools.
    const listAlias = { SET_NODE_LIST: 'SET_NODES', SET_PART_LIST: 'SET_PART_COLLECTION' }[name.replace(/_TITLE$/, '')];
    if (listAlias) return data.bindings[listAlias];
    return dmnBindings[name] || data.bindings[name] || optionalFormHeaders.bindings[name] || singleCardReaders.bindings[name] || tailRepeatReaders.bindings[name] || standardRepeatReaders.bindings[name];
}
export function nativeConditionalSource(): string { return data.sourceSha256; }

/** Finite branch grammars can be recovered with a bounded prefix. Count the
 * longest branch; counted/repeated/module tails still require their own reader. */
export function nativeConditionalRecordBound(binding: any): number | null {
    const count = (steps: any[]): number => Array.isArray(steps) ? steps.reduce((total, step) => total +
        (Number.isInteger(step) && step > 0 ? 1 : step?.allowEnd === true ? 0 :
            step?.control && Array.isArray(step.then) ? Math.max(count(step.then), count(step.else || [])) : NaN), 0) : NaN;
    const bound = count(binding?.steps);
    return Number.isSafeInteger(bound) && bound > 0 && bound <= 256 ? bound : null;
}

export function selectConditionalLayout(binding: any, rows: string[], title: boolean,
    read: (row: number, card: number, field: number) => string,
    resolve: (raw: string, row: number) => string,
    draft: (record: NativeFileRecord, field: number, raw: string) => string,
    targetTitle: boolean, partial: boolean,
    normalize: (card: number, field: number, value: number) => number = (_card, _field, value) => value,
    blankDefault: (card: number, field: number) => string | undefined = () => undefined) {
    const sourcePositions = new Map<string, { row: number; record: NativeFileRecord }>();
    const sourceModules: {step: any; scope: string; row: number; raw: string; record: NativeFileRecord}[] = [];
    const sourceEnds: {step: any; scope: string}[] = [];
    const sourceTails: {step: any; scope: string; count: number}[] = [];
    const reasons = new Set<string>();
    let failureKind: 'input-uncertain' | 'implementation-gap' | undefined;
    const select = (edited: boolean, withTitle: boolean) => {
        const records: NativeFileRecord[] = [];
        const conditions: string[] = [];
        const occurrences = new Map<number, number>();
        let scope = '';
        let certain = true;
        let unboundedTail = false;
        let ended = false;
        let minimumRecords = binding.minimumRecords ?? 1;
        const allowedEnds = new Set<number>();
        const tailAvailable = (step: any) => {
            if (edited) return sourceTails.find(tail => tail.step === step && tail.scope === scope)?.count;
            const count = Math.max(0, rows.length - records.length);
            sourceTails.push({step, scope, count});
            return count;
        };
        const append = (cardIndex: number) => {
            const occurrence = occurrences.get(cardIndex) || 0;
            occurrences.set(cardIndex, occurrence + 1);
            const record = { cardIndex, instanceStart: 0,
                key: `instance:0:${scope ? `group:${scope}:` : ''}card:${cardIndex}${occurrence ? `:repeat:${occurrence}` : ''}`,
                branchIdentity: conditions.join(';') };
            const positionKey = `${scope}/${cardIndex}`;
            if (!edited && !sourcePositions.has(positionKey)) sourcePositions.set(positionKey, { row: records.length, record });
            records.push(record);
        };
        if (withTitle) append(binding.titleRecordCardIndex ?? 0);
        const visit = (steps: any[], terminal: boolean) => {
            for (const step of steps) {
                if (!certain || ended) break;
                if (typeof step === 'number') { append(step); continue; }
                if (typeof step.reject === 'string') {
                    reasons.add(step.reject); failureKind ||= 'input-uncertain'; certain = false; break;
                }
                if (step.tagged) {
                    const seen = new Set<string>();
                    const observed = edited ? sourceModules.filter(module => module.step === step && module.scope === scope) : [];
                    let moduleIndex = 0;
                    while (certain && !ended && (edited ? moduleIndex < observed.length : records.length < rows.length)) {
                        const prior = edited ? observed[moduleIndex++] : undefined;
                        const sourceRow = prior ? prior.row : records.length;
                        const token = prior ? draft(prior.record, 0, prior.raw).trim() :
                            rows[sourceRow].trimStart().match(/^[^\s,]+/)?.[0] || '';
                        const resolved = token.startsWith('&') ? resolve(token, sourceRow).trim() : token;
                        if (resolved.startsWith('&')) {
                            reasons.add('module-tag-unresolved-parameter'); failureKind ||= 'input-uncertain'; certain = false; break;
                        }
                        const tag = /^[A-Za-z]/.test(resolved) ? resolved.toUpperCase() : undefined;
                        if (!tag && resolved && !/^[+-]?(?:\d|\.\d)/.test(resolved)) {
                            reasons.add('module-tag-unrecognized'); failureKind ||= 'input-uncertain'; certain = false; break;
                        }
                        if (!tag) {
                            // Numeric source rows can begin the optional tail.
                            // A draft of an observed module header cannot turn
                            // that module into an implicit end of the file.
                            if (edited) {
                                reasons.add('module-tag-unrecognized'); failureKind ||= 'input-uncertain'; certain = false;
                            }
                            break;
                        }
                        const module = step.tagged[tag];
                        if (!Array.isArray(module) || seen.has(tag)) {
                            reasons.add(`tag-${tag}-${seen.has(tag) ? 'duplicate' : 'unknown'}`);
                            failureKind ||= 'input-uncertain'; certain = false; break;
                        }
                        seen.add(tag);
                        const previousScope = scope, before = records.length;
                        scope += `/tag:${tag}`;
                        conditions.push(`module=${tag}`);
                        visit(module, false);
                        if (!edited) {
                            const header = sourcePositions.get(`${scope}/${module[0]}`);
                            if (!header) { reasons.add('unimplemented-module-header'); failureKind = 'implementation-gap'; certain = false; }
                            else sourceModules.push({step, scope: previousScope, row: sourceRow, raw: token, record: header.record});
                        }
                        scope = previousScope;
                        if (records.length === before) {
                            reasons.add('unimplemented-empty-module'); failureKind = 'implementation-gap'; certain = false;
                        }
                    }
                    for (const tag of step.required || []) if (!seen.has(tag)) {
                        reasons.add(`tag-${tag}-missing`); failureKind ||= 'input-uncertain'; certain = false;
                    }
                    for (const [tag, dependencies] of Object.entries(step.requires || {}))
                        if (seen.has(tag)) for (const dependency of dependencies as string[]) if (!seen.has(dependency)) {
                            reasons.add(`tag-${tag}-requires-${dependency}`); failureKind ||= 'input-uncertain'; certain = false;
                        }
                    if (certain && !ended && step.tail && (step.tailRequires || []).every((tag: string) => seen.has(tag)))
                        visit(step.tail, terminal && step === steps[steps.length - 1]);
                    continue;
                }
                if (step.allowEnd === true) {
                    allowedEnds.add(records.length);
                    if (!edited && records.length === rows.length) sourceEnds.push({step, scope});
                    if (edited && sourceEnds.some(end => end.step === step && end.scope === scope)) ended = true;
                    continue;
                }
                if ('requireRecords' in step) {
                    if (!Number.isInteger(step.requireRecords) || step.requireRecords < 1) {
                        reasons.add('unimplemented-file-cardinality'); failureKind = 'implementation-gap'; certain = false; break;
                    }
                    minimumRecords = Math.max(minimumRecords, step.requireRecords); continue;
                }
                if (Array.isArray(step.sequenceToEnd)) {
                    if (!terminal || step !== steps[steps.length - 1] ||
                        !step.sequenceToEnd.length || step.sequenceToEnd.some((card: unknown) => !Number.isInteger(card))) {
                        reasons.add('unimplemented-file-repetition'); failureKind = 'implementation-gap'; certain = false; break;
                    }
                    const available = tailAvailable(step);
                    if (available === undefined) {
                        reasons.add('unresolved-tail-count'); failureKind ||= 'input-uncertain'; certain = false; break;
                    }
                    for (const card of step.sequenceToEnd.slice(0, Math.max(0, available))) append(card);
                    if (available > step.sequenceToEnd.length) {
                        reasons.add('record-count-mismatch'); failureKind ||= 'input-uncertain'; certain = false;
                    }
                    continue;
                }
                if ('repeatToEnd' in step && !step.control) {
                    if (!Number.isInteger(step.repeatToEnd) || !terminal || step !== steps[steps.length - 1]) {
                        reasons.add('unimplemented-file-repetition'); failureKind = 'implementation-gap'; certain = false; break;
                    }
                    unboundedTail = true;
                    const count = tailAvailable(step);
                    if (count === undefined) {
                        reasons.add('unresolved-tail-count'); failureKind ||= 'input-uncertain'; certain = false; break;
                    }
                    for (let index = 0; index < count; index++) append(step.repeatToEnd);
                    continue;
                }
                const control = binding.controls[step.control];
                if (!control) {
                    reasons.add('missing-file-controller'); failureKind = 'implementation-gap'; certain = false; break;
                }
                let position: { row: number; record: NativeFileRecord } | undefined;
                for (let parent: string | undefined = scope; parent !== undefined && !position;
                    parent = parent ? parent.slice(0, parent.lastIndexOf('/')) : undefined)
                    for (const card of control.sourceCards || [control.card]) {
                        position = sourcePositions.get(`${parent}/${card}`);
                        if (position) break;
                    }
                if (!edited && control.atNextRecord) position = { row: records.length,
                    record: { cardIndex: control.card, instanceStart: 0, key: `instance:0:group:${scope}:control:${step.control}` } };
                if (step.ifPresent && (!position || position.row >= rows.length)) continue;
                let raw = position && position.row < rows.length ? read(position.row, control.card, control.field) : undefined;
                if (raw !== undefined && edited) raw = draft(position.record, control.field, raw);
                // Only an existing blank cell can use its own declared native
                // default. Missing records and unresolved parameters stay unknown.
                if (raw !== undefined && !raw.trim()) raw = blankDefault(control.card, control.field) ?? raw;
                const text = raw === undefined ? undefined : resolve(raw, position.row).trim().replace(/[dD]/g, 'e');
                const numeric = text && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : NaN;
                let value = control.storage === 'float32' ? Math.fround(numeric) : numeric;
                if (!Number.isFinite(value) || control.storage === 'int32' &&
                    (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
                    reasons.add(`control-${step.control}-${raw === undefined ? 'missing' : !text ? 'blank' : 'unresolved'}`);
                    failureKind ||= 'input-uncertain';
                    certain = false; break;
                }
                if (control.allowed && !control.allowed.includes(value)) {
                    reasons.add(`control-${step.control}-outside-file-domain`); failureKind ||= 'input-uncertain'; certain = false; break;
                }
                // Display-only rule extensions do not authorize source or draft
                // values outside the previously verified write domain.
                if (!partial && control.editAllowed && !control.editAllowed.includes(value)) { certain = false; break; }
                if (control.minimum !== undefined && value < control.minimum ||
                    control.maximum !== undefined && value > control.maximum) {
                    reasons.add(`control-${step.control}-outside-file-domain`); failureKind ||= 'input-uncertain'; certain = false; break;
                }
                if (control.normalize !== false) value = normalize(control.card, control.field, value);
                if (control.comparison === 'int32-bits') {
                    // Some native readers compare a float field's stored bits as
                    // a signed integer. Preserve negative zero in that branch.
                    controlBits.setFloat32(0, value, true);
                    value = controlBits.getInt32(0, true);
                } else if (control.comparison !== undefined) {
                    reasons.add('unimplemented-control-comparison'); failureKind = 'implementation-gap'; certain = false; break;
                }
                if (step.repeat) {
                    if (!partial && (step.editMaxCount !== undefined && value > step.editMaxCount ||
                        step.editMinimum !== undefined && value < step.editMinimum)) { certain = false; break; }
                    if (!Array.isArray(step.repeat) || !Number.isInteger(step.maxCount) || step.maxCount < 0) {
                        reasons.add('unimplemented-file-repetition'); failureKind = 'implementation-gap'; certain = false; break;
                    }
                    if (step.countFormula !== undefined) {
                        // Pinned native grouped-pair packing; the final ceil is
                        // the imported libmmd ceil, not integer division.
                        if (step.countFormula !== 'native-int32-packed-pairs') {
                            reasons.add('unimplemented-repeat-count-formula'); failureKind = 'implementation-gap'; certain = false; break;
                        }
                        const half = Math.trunc(((value + 1) | 0) / 2);
                        value = Math.ceil(Math.imul(value, 2 * half - 2) / 8);
                    }
                    if (step.nonPositive === 'empty' && value <= 0) value = 0;
                    if (!Number.isInteger(value) || value < 0 || value > step.maxCount) {
                        reasons.add(`repeat-${step.control}-count-out-of-range`); failureKind ||= 'input-uncertain'; certain = false; break;
                    }
                    const parent = scope;
                    for (let instance = 0; instance < value && certain; instance++) {
                        scope = `${parent}/repeat:${step.control}:${instance}`;
                        visit(step.repeat, false);
                    }
                    scope = parent;
                    continue;
                }
                if ('repeatToEnd' in step) {
                    if (!Number.isInteger(step.repeatToEnd) || !terminal || step !== steps[steps.length - 1] ||
                        !Number.isInteger(step.fieldsPerRecord) || step.fieldsPerRecord < 1 ||
                        !Number.isInteger(step.maxRecords) || step.maxRecords < 1) {
                        reasons.add('unimplemented-file-repetition'); failureKind = 'implementation-gap'; certain = false; break;
                    }
                    // A changed prefix never changes the observed source tail.
                    // A newly enabled counted tail may create only its explicit
                    // required count; it cannot borrow unrelated source rows.
                    const available = tailAvailable(step) ?? 0;
                    const required = Math.ceil(value / step.fieldsPerRecord);
                    if (!Number.isInteger(value) || value < (step.minimumValue ?? 0) ||
                        required > step.maxRecords) {
                        reasons.add(`repeat-${step.control}-count-mismatch`); failureKind ||= 'input-uncertain'; certain = false; break;
                    }
                    const maximum = step.exactCount === true ? required : step.maxRecords;
                    conditions.push(`${step.control}=${value}: minimum ${required}, maximum ${maximum}`);
                    // A missing or surplus tail does not change the identities
                    // of the records within the independently known count.
                    const count = edited ? Math.max(required, Math.min(Math.max(available, 0), maximum))
                        : Math.min(Math.max(available, 0), maximum);
                    const end = records.length + count;
                    while (records.length < end) append(step.repeatToEnd);
                    if (!edited && (available < required || available > maximum)) {
                        reasons.add(`repeat-${step.control}-count-mismatch`); failureKind ||= 'input-uncertain'; certain = false; break;
                    }
                    continue;
                }
                const yes = step.op === 'lt' ? value < step.value : step.op === 'gt' ? value > step.value : step.op === 'eq' ? value === step.value :
                    step.op === 'ne' ? value !== step.value : step.op === 'in' ? step.values.includes(value) : undefined;
                if (yes === undefined) { reasons.add('unimplemented-file-predicate'); failureKind = 'implementation-gap'; certain = false; break; }
                const operator = { lt: '<', gt: '>', eq: '=', ne: '≠' }[step.op];
                conditions.push(`${step.control}${step.op === 'in' ? ' in ' + JSON.stringify(step.values) : operator + step.value}: ${yes ? 'yes' : 'no'}`);
                visit(yes ? step.then : step.else || [], terminal && step === steps[steps.length - 1]);
            }
        };
        visit(binding.steps, true);
        return { records, certain, conditions, minimumRecords, allowedEnds, unboundedTail };
    };
    const source = select(false, title);
    // Never use a draft to reinterpret existing records.
    const target = select(true, targetTitle);
    const sourceCountMatches = source.records.length === rows.length || source.allowedEnds.has(rows.length) || binding.optionalTail === true &&
        rows.length >= source.minimumRecords + Number(title) && rows.length < source.records.length;
    if (source.certain && !sourceCountMatches) {
        reasons.add('record-count-mismatch'); failureKind ||= 'input-uncertain';
    }
    if (!partial && (!source.certain || !target.certain || !sourceCountMatches)) return null;
    if (binding.optionalTail === true && source.certain && sourceCountMatches) {
        // Preserve omitted optional records unless the draft makes them required.
        const omitted = new Set(source.records.slice(rows.length).map(record => record.key));
        while (target.records.length > target.minimumRecords + Number(targetTitle) &&
            omitted.has(target.records[target.records.length - 1].key)) target.records.pop();
    }
    // Target EOF follows the verified source grammar endpoint, even when a
    // preceding draft changes record counts. It never follows a physical offset.
    return { current: source.records.slice(0, rows.length), target: target.records,
        ...(source.unboundedTail && source.certain ? { unboundedTail: true,
            minimumRecords: source.records.length - sourceTails.filter(tail =>
                'repeatToEnd' in tail.step && !tail.step.control).reduce((count, tail) => count + tail.count, 0) } : {}),
        counts: source.certain ? [sourceCountMatches ? rows.length : source.records.length] : [],
        conditions: source.conditions, reasons: [...reasons],
        failureKind,
        complete: source.certain && sourceCountMatches };
}
