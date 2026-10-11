'use strict';

export const OPTION_SWITCH_MAX_BYTES = 8 * 1024 * 1024;

export type OptionFieldLayout = {
    fieldMigrationId: string;
    name: string;
    type: 'integer' | 'float' | 'string' | string;
    position: number;
    width: number;
    canonicalFieldIdentity?: string;
    columnOrdinal?: number;
    fieldOrdinal?: number;
    removalDisposition?: 'official-target-absent';
};

export type OptionRecordLayout = {
    recordMigrationId: string;
    recordMarker?: { kind: 'column-one'; value: '&'; fieldIndex: number; evidenceIds: string[] };
    occurrence?: { kind: 'exactly-once' | 'repeat' | 'conditional'; [key: string]: unknown };
    fields: OptionFieldLayout[];
    sharedByteEditing?: 'native-shared-bytes-v1';
    removalDisposition?: 'official-target-absent';
};

export type OptionLayoutProfile = {
    profileId: string;
    keyword: string;
    records: OptionRecordLayout[];
};

export type FieldMigrationBinding = {
    sourceFieldMigrationId: string;
    targetFieldMigrationId: string;
    evidenceId: string;
};

export type OptionSwitchRecord = {
    text: string;
    comments: string[];
};

export type OptionSwitchPlannerInput = {
    currentKeyword: string;
    targetKeyword: string;
    currentLayout: OptionLayoutProfile;
    targetLayout: OptionLayoutProfile;
    records: OptionSwitchRecord[];
    documentVersion?: number | null;
    uri?: string | null;
    keywordLine?: number;
    sourceLockIdentity?: string | null;
    inputFormat?: string;
    maxBytes?: number;
    applicationMode?: 'layout-migration' | 'keyword-only-preserve-block';
    bindings?: FieldMigrationBinding[];
    allowOrdinalRecordMatch?: boolean;
    analyzeComment?: (text: string, records: OptionRecordLayout[]) => null | {
        recordIndex: number;
        style: string;
        labelCase: string;
        exactMatch?: boolean;
        possibleVersionDrift?: boolean;
    };
    generateComment?: (record: OptionRecordLayout, style: string, labelCase: string) => string;
    readField?: (text: string, record: OptionRecordLayout, fieldIndex: number) => string;
    /** Physical source ranges covered by a custom reader, including format separators. */
    readRecordRanges?: (text: string, record: OptionRecordLayout) => Array<{ start: number; end: number }> | null;
    writeField?: (text: string, record: OptionRecordLayout, fieldIndex: number, value: string) => string | null;
    createRecord?: (record: OptionRecordLayout) => string;
    /** Authoring-preview fallback. Never changes the strict planner default. */
    provisional?: boolean;
};

export type OptionSwitchPlan = {
    status: 'ready' | 'no-change' | 'blocked';
    reason: string;
    currentKeyword: string;
    targetKeyword: string;
    documentVersion: number | null;
    uri: string | null;
    keywordLine: number;
    sourceLockIdentity: string | null;
    replacementRecords: OptionSwitchRecord[];
    trailingComments: string[];
    migratedFields: Array<Record<string, unknown>>;
    emptyTargetFields: Array<Record<string, unknown>>;
    discardedFields: Array<Record<string, unknown>>;
    commentChanges: Array<Record<string, unknown>>;
    blockers: string[];
    estimatedBytes: number;
    applicationMode: 'layout-migration' | 'keyword-only-preserve-block';
    fallbackReason?: string;
    requiresLossConfirmation: boolean;
    provisional?: boolean;
    source?: string;
    unmatchedFields?: Array<Record<string, unknown>>;
    previewDiff?: Array<Record<string, unknown>>;
};

function blankPlan(input: OptionSwitchPlannerInput, status: OptionSwitchPlan['status'], reason: string): OptionSwitchPlan {
    return {
        status,
        reason,
        currentKeyword: input.currentKeyword,
        targetKeyword: input.targetKeyword,
        documentVersion: Number.isInteger(input.documentVersion) ? Number(input.documentVersion) : null,
        uri: input.uri || null,
        keywordLine: Number.isInteger(input.keywordLine) ? Number(input.keywordLine) : 0,
        sourceLockIdentity: input.sourceLockIdentity || null,
        replacementRecords: [],
        trailingComments: [],
        migratedFields: [],
        emptyTargetFields: [],
        discardedFields: [],
        commentChanges: [],
        blockers: reason ? [reason] : [],
        estimatedBytes: 0,
        applicationMode: input.applicationMode || 'layout-migration',
        requiresLossConfirmation: false,
    };
}

function validateLayout(layout: OptionLayoutProfile): string | null {
    if (!layout || !Array.isArray(layout.records) || !layout.profileId || !layout.keyword) return 'invalid-layout';
    const recordIds = new Set<string>();
    for (const record of layout.records) {
        if (!record?.recordMigrationId || recordIds.has(record.recordMigrationId) || !Array.isArray(record.fields)) {
            return 'ambiguous-record-migration';
        }
        recordIds.add(record.recordMigrationId);
        if (record.recordMarker && (record.recordMarker.kind !== 'column-one' || record.recordMarker.value !== '&' ||
            !record.recordMarker.evidenceIds?.length || record.recordMarker.fieldIndex !== 0 ||
            record.fields[0]?.position !== 0 || record.fields[0]?.type !== 'string')) return 'invalid-record-marker';
        if (record.occurrence && record.occurrence.kind !== 'exactly-once') {
            return 'repeat-or-conditional-occurrence-unresolved';
        }
        const fieldIds = new Set<string>();
        for (const field of record.fields) {
            if (!field?.fieldMigrationId || fieldIds.has(field.fieldMigrationId) ||
                !Number.isInteger(field.position) || !Number.isInteger(field.width) ||
                field.position < 0 || field.width < 1) return 'ambiguous-field-migration';
            fieldIds.add(field.fieldMigrationId);
        }
        for (let fieldIndex = 0; fieldIndex < record.fields.length; fieldIndex++) {
            const field = record.fields[fieldIndex];
            for (const other of record.fields.slice(fieldIndex + 1)) {
                if (Math.max(field.position, other.position) <
                    Math.min(field.position + field.width, other.position + other.width)) {
                    if (record.sharedByteEditing !== 'native-shared-bytes-v1') {
                        return 'overlapping-field-migration';
                    }
                }
            }
        }
    }
    return null;
}

function recordWidth(record: OptionRecordLayout): number {
    return record.fields.reduce((maximum, field) => Math.max(maximum, field.position + field.width), 0);
}

function extractCell(text: string, field: OptionFieldLayout): string {
    return String(text || '').slice(field.position, field.position + field.width).trim();
}

function sourceTextLossReason(input: OptionSwitchPlannerInput, text: string, record?: OptionRecordLayout, customReader = true): string | null {
    if (!text.trim()) return null;
    if (!record) return 'unmodeled-source-text';
    let ranges: Array<{ start: number; end: number }> | null;
    try {
        ranges = customReader && input.readRecordRanges ? input.readRecordRanges(text, record)
            : customReader && input.readField ? null
                : record.fields.map(field => ({ start: field.position, end: field.position + field.width }));
    } catch { return 'source-record-coverage-unproven'; }
    if (!Array.isArray(ranges) || ranges.some(range => !range || !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start)) {
        return 'source-record-coverage-unproven';
    }
    let end = 0;
    for (const range of ranges.slice().sort((left, right) => left.start - right.start)) {
        if (text.slice(end, range.start).trim()) return 'unmodeled-source-text';
        end = Math.max(end, range.end);
    }
    return text.slice(end).trim() ? 'unmodeled-source-text' : null;
}

function writeCell(characters: string[], field: OptionFieldLayout, value: string): boolean {
    if (value.length > field.width) return false;
    const stringLike = field.type === 'string' || /^a/i.test(field.type);
    const rendered = stringLike ? value.padEnd(field.width) : value.padStart(field.width);
    for (let index = 0; index < field.width; index++) characters[field.position + index] = rendered[index] || ' ';
    return true;
}

function dominant(values: string[], fallback: string): string {
    const counts = new Map<string, number>();
    for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
    return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || fallback;
}

export function planOptionSwitch(input: OptionSwitchPlannerInput): OptionSwitchPlan {
    if (input.applicationMode === 'keyword-only-preserve-block') {
        if (!Array.isArray(input.records)) return blankPlan(input, 'blocked', 'record-count-unresolved');
        const estimatedBytes = Buffer.byteLength(JSON.stringify(input.records), 'utf8');
        const maxBytes = Number.isFinite(input.maxBytes) ? Number(input.maxBytes) : OPTION_SWITCH_MAX_BYTES;
        if (estimatedBytes > maxBytes) return blankPlan(input, 'blocked', 'edit-budget-exceeded');
        const noChange = input.currentKeyword === input.targetKeyword;
        return {
            ...blankPlan(input, noChange ? 'no-change' : 'ready', noChange ? 'selection-current' : 'ready'),
            replacementRecords: input.records.map(record => ({ text: record.text, comments: [...(record.comments || [])] })),
            blockers: [],
            estimatedBytes,
            applicationMode: 'keyword-only-preserve-block',
            requiresLossConfirmation: false,
        };
    }
    if (input.inputFormat && input.inputFormat !== 'standard' &&
        (!input.readField || !input.writeField || !input.createRecord)) {
        return blankPlan(input, 'blocked', 'non-standard-input');
    }
    if (input.inputFormat && input.inputFormat !== 'standard' &&
        [...input.currentLayout.records, ...input.targetLayout.records].some(record => record.sharedByteEditing)) {
        return blankPlan(input, 'blocked', 'shared-byte-format-unproven');
    }
    const sourceError = validateLayout(input.currentLayout);
    const targetError = validateLayout(input.targetLayout);
    if (sourceError || targetError) return blankPlan(input, 'blocked', sourceError || targetError!);
    if (!Array.isArray(input.records) || input.records.length !== input.currentLayout.records.length) {
        return blankPlan(input, 'blocked', 'record-count-unresolved');
    }
    for (const [index, record] of input.currentLayout.records.entries()) {
        if (record.recordMarker && (!input.records[index].text.startsWith(record.recordMarker.value) ||
            (input.readField?.(input.records[index].text, record, record.recordMarker.fieldIndex) ??
                extractCell(input.records[index].text, record.fields[record.recordMarker.fieldIndex])) !== record.recordMarker.value)) {
            return blankPlan(input, 'blocked', 'source-record-marker-mismatch');
        }
    }
    const sourceBytes = Buffer.byteLength(JSON.stringify(input.records), 'utf8');
    const maxBytes = Number.isFinite(input.maxBytes) ? Number(input.maxBytes) : OPTION_SWITCH_MAX_BYTES;
    if (sourceBytes > maxBytes) return blankPlan(input, 'blocked', 'edit-budget-exceeded');

    const bindingTargets = new Set<string>();
    const bindingSources = new Set<string>();
    for (const binding of input.bindings || []) {
        if (!binding?.sourceFieldMigrationId || !binding.targetFieldMigrationId || !binding.evidenceId ||
            bindingTargets.has(binding.targetFieldMigrationId) || bindingSources.has(binding.sourceFieldMigrationId)) {
            return blankPlan(input, 'blocked', 'ambiguous-field-migration-binding');
        }
        bindingTargets.add(binding.targetFieldMigrationId);
        bindingSources.add(binding.sourceFieldMigrationId);
    }
    const sourceRecordById = new Map(input.currentLayout.records.map((record, index) => [record.recordMigrationId, { record, index }]));
    const targetRecordById = new Map(input.targetLayout.records.map((record, index) => [record.recordMigrationId, { record, index }]));
    const explicitBindings = new Map((input.bindings || []).map(binding => [binding.targetFieldMigrationId, binding.sourceFieldMigrationId]));
    const migratedFields: Array<Record<string, unknown>> = [];
    const emptyTargetFields: Array<Record<string, unknown>> = [];
    const discardedFields: Array<Record<string, unknown>> = [];
    const commentChanges: Array<Record<string, unknown>> = [];
    const consumedSourceFields = new Set<string>();
    const consumedSourceRecords = new Set<number>();
    const preservedSourceRecords = new Set<number>();
    const sourceFieldEntries = input.currentLayout.records.flatMap((record, recordIndex) =>
        record.fields.map((field, fieldIndex) => ({ record, recordIndex, field, fieldIndex,
            key: `${recordIndex}:${field.fieldMigrationId}` }))
            .filter(entry => entry.fieldIndex !== record.recordMarker?.fieldIndex));
    const normalizeName = (value: unknown) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const normalizeType = (value: unknown) => {
        const text = String(value || '').toLowerCase();
        return /int|^i$/.test(text) ? 'integer' : /float|real|^f$|^r$/.test(text) ? 'float' : 'string';
    };
    const reservedSourceFieldIds = new Set([
        ...input.targetLayout.records.flatMap(record => record.fields.map(field => field.fieldMigrationId)),
        ...(input.bindings || []).map(binding => binding.sourceFieldMigrationId),
    ]);
    const reservedSourceCanonicalIds = new Set(input.targetLayout.records.flatMap(record =>
        record.fields.map(field => field.canonicalFieldIdentity).filter(Boolean)));
    const reservedSourceRecordIds = new Set(input.targetLayout.records.map(record => record.recordMigrationId)
        .filter(id => sourceRecordById.has(id)));
    const uniqueAvailable = (entries: any[], allowReserved = false) => {
        const available = entries.filter(entry => !consumedSourceFields.has(entry.key) && (allowReserved ||
            (!reservedSourceFieldIds.has(entry.field.fieldMigrationId) &&
             !reservedSourceCanonicalIds.has(entry.field.canonicalFieldIdentity))));
        return available.length === 1 ? available[0] : null;
    };

    const analyzeSourceComment = (text: string, index: number) => {
        try {
            const analysis = input.analyzeComment?.(text, [input.currentLayout.records[index]]);
            return analysis?.exactMatch === true && analysis.recordIndex === 0
                ? { ...analysis, recordIndex: index } : null;
        } catch { return null; }
    };
    const generateComment = (record: OptionRecordLayout, style: string, labelCase: string): string => {
        try { return input.generateComment?.(record, style, labelCase) || ''; } catch { return ''; }
    };
    const analyses = input.records.flatMap((source, index) =>
        (source.comments || []).map(text => {
            const analysis = analyzeSourceComment(text, index);
            return analysis ? { text, ...analysis } : null;
        }));
    const recognized = analyses.filter(Boolean) as Array<{ text: string; recordIndex: number; style: string; labelCase: string }>;
    const dominantStyle = dominant(recognized.map(item => item.style), 'dollar-hash-fixed');
    const dominantCase = dominant(recognized.map(item => item.labelCase), 'lower');
    const blockUsesFieldHeaders = recognized.length > 0;

    const replacementRecords: OptionSwitchRecord[] = [];
    const sourceDestinations = new Map<number, number>();
    const trailingComments: string[] = [];
    for (let targetIndex = 0; targetIndex < input.targetLayout.records.length; targetIndex++) {
        const targetRecord = input.targetLayout.records[targetIndex];
        const ordinalSource = targetIndex < input.currentLayout.records.length
            ? { record: input.currentLayout.records[targetIndex], index: targetIndex } : null;
        const sourceMatch = sourceRecordById.get(targetRecord.recordMigrationId) ||
            (input.allowOrdinalRecordMatch !== false && ordinalSource && !reservedSourceRecordIds.has(ordinalSource.record.recordMigrationId)
                ? ordinalSource : null);
        if (sourceMatch) {
            consumedSourceRecords.add(sourceMatch.index);
            sourceDestinations.set(sourceMatch.index, targetIndex);
        }
        const sourceRecord = sourceMatch ? input.records[sourceMatch.index] : null;
        // Shared records migrate as bytes, never as independently formatted
        // cells. Reordering the same record is safe; reshaping it needs its own
        // proven conversion, which is outside this contract.
        if ((targetRecord.sharedByteEditing || sourceMatch?.record.sharedByteEditing) &&
            (!sourceMatch || JSON.stringify(sourceMatch.record.fields) !== JSON.stringify(targetRecord.fields))) {
            return blankPlan(input, 'blocked', 'shared-byte-layout-change');
        }
        const preserveSourceText = sourceMatch &&
            JSON.stringify(sourceMatch.record.fields) === JSON.stringify(targetRecord.fields);
        if (preserveSourceText) preservedSourceRecords.add(sourceMatch.index);
        let recordText = preserveSourceText ? sourceRecord!.text : input.createRecord?.(targetRecord) ??
            Array(recordWidth(targetRecord)).fill(' ').join('');
        if (targetRecord.recordMarker && !preserveSourceText) {
            if (input.writeField) {
                const written = input.writeField(recordText, targetRecord, targetRecord.recordMarker.fieldIndex, targetRecord.recordMarker.value);
                if (written === null) return blankPlan(input, 'blocked', 'target-record-marker-mismatch');
                recordText = written;
            } else recordText = targetRecord.recordMarker.value + recordText.slice(1);
        }
        for (let targetFieldIndex = 0; targetFieldIndex < targetRecord.fields.length; targetFieldIndex++) {
            if (targetFieldIndex === targetRecord.recordMarker?.fieldIndex) continue;
            const targetField = targetRecord.fields[targetFieldIndex];
            const explicitSourceId = explicitBindings.get(targetField.fieldMigrationId);
            let sourceEntry = explicitSourceId
                ? uniqueAvailable(sourceFieldEntries.filter(entry => entry.field.fieldMigrationId === explicitSourceId), true)
                : uniqueAvailable(sourceFieldEntries.filter(entry => entry.field.fieldMigrationId === targetField.fieldMigrationId), true);
            if (!sourceEntry && targetField.canonicalFieldIdentity) {
                sourceEntry = uniqueAvailable(sourceFieldEntries.filter(entry =>
                    entry.field.canonicalFieldIdentity === targetField.canonicalFieldIdentity), true);
            }
            const sameRecordEntries = sourceFieldEntries.filter(entry => entry.recordIndex === sourceMatch?.index);
            if (!sourceEntry) {
                sourceEntry = uniqueAvailable(sameRecordEntries.filter(entry =>
                    normalizeName(entry.field.name) === normalizeName(targetField.name)));
            }
            if (!sourceEntry) {
                const targetColumn = Number.isInteger(targetField.columnOrdinal)
                    ? Number(targetField.columnOrdinal) : Math.floor(targetField.position / Math.max(1, targetField.width)) + 1;
                sourceEntry = uniqueAvailable(sameRecordEntries.filter(entry => {
                    const sourceColumn = Number.isInteger(entry.field.columnOrdinal)
                        ? Number(entry.field.columnOrdinal) : Math.floor(entry.field.position / Math.max(1, entry.field.width)) + 1;
                    return normalizeType(entry.field.type) === normalizeType(targetField.type) && sourceColumn === targetColumn;
                }));
            }
            if (!sourceEntry) {
                const targetOrdinal = Number.isInteger(targetField.fieldOrdinal)
                    ? Number(targetField.fieldOrdinal) : targetFieldIndex + 1;
                sourceEntry = uniqueAvailable(sameRecordEntries.filter(entry =>
                    normalizeType(entry.field.type) === normalizeType(targetField.type) &&
                    (Number.isInteger(entry.field.fieldOrdinal) ? Number(entry.field.fieldOrdinal) : entry.fieldIndex + 1) === targetOrdinal));
            }
            const sourceField = sourceEntry?.field;
            const sourceValueRecord = sourceEntry ? input.records[sourceEntry.recordIndex] : null;
            const value = sourceField && sourceValueRecord
                ? input.readField?.(sourceValueRecord.text, sourceEntry.record, sourceEntry.fieldIndex) ??
                    extractCell(sourceValueRecord.text, sourceField)
                : '';
            if (targetRecord.sharedByteEditing && (sourceEntry?.recordIndex !== sourceMatch?.index ||
                sourceField?.fieldMigrationId !== targetField.fieldMigrationId)) {
                return blankPlan(input, 'blocked', 'shared-byte-layout-change');
            }
            if (sourceEntry) consumedSourceFields.add(sourceEntry.key);
            if (!value) {
                emptyTargetFields.push({ recordMigrationId: targetRecord.recordMigrationId, fieldMigrationId: targetField.fieldMigrationId, name: targetField.name });
                continue;
            }
            const samePhysicalField = sourceMatch?.index === sourceEntry?.recordIndex &&
                sourceField?.fieldMigrationId === targetField.fieldMigrationId &&
                sourceField?.position === targetField.position && sourceField?.width === targetField.width;
            if (preserveSourceText && samePhysicalField) {
                continue;
            } else if (input.writeField) {
                const written = input.writeField(recordText, targetRecord, targetFieldIndex, value);
                if (written === null) return blankPlan(input, 'blocked', 'target-field-width-overflow');
                recordText = written;
            } else {
                const characters = [...recordText.padEnd(recordWidth(targetRecord), ' ')];
                if (!writeCell(characters, targetField, value)) {
                    return blankPlan(input, 'blocked', 'target-field-width-overflow');
                }
                recordText = characters.join('');
            }
            migratedFields.push({
                sourceRecordMigrationId: sourceEntry?.record.recordMigrationId,
                targetRecordMigrationId: targetRecord.recordMigrationId,
                sourceFieldMigrationId: sourceField?.fieldMigrationId,
                targetFieldMigrationId: targetField.fieldMigrationId,
                value,
            });
        }

        if (targetRecord.recordMarker && (!recordText.startsWith(targetRecord.recordMarker.value) ||
            (input.readField?.(recordText, targetRecord, targetRecord.recordMarker.fieldIndex) ??
                extractCell(recordText, targetRecord.fields[targetRecord.recordMarker.fieldIndex])) !== targetRecord.recordMarker.value)) {
            return blankPlan(input, 'blocked', 'target-record-marker-mismatch');
        }
        let comments = sourceRecord ? [...(sourceRecord.comments || [])] : [];
        const recordChanged = !sourceMatch || JSON.stringify(sourceMatch.record.fields) !== JSON.stringify(targetRecord.fields);
        if (recordChanged && comments.length > 0) {
            comments = comments.map(comment => {
                const analysis = analyzeSourceComment(comment, sourceMatch!.index);
                if (!analysis) return comment;
                const replacement = generateComment(targetRecord, analysis.style, analysis.labelCase);
                if (!replacement) return comment;
                if (replacement !== comment) commentChanges.push({ kind: 'replace', source: comment, target: replacement, recordMigrationId: targetRecord.recordMigrationId });
                return replacement;
            });
        }
        if (!sourceRecord && blockUsesFieldHeaders) {
            const generated = generateComment(targetRecord, dominantStyle, dominantCase);
            if (generated) {
                comments.push(generated);
                commentChanges.push({ kind: 'insert', target: generated, recordMigrationId: targetRecord.recordMigrationId });
            }
        }
        replacementRecords.push({ text: recordText, comments });
    }

    const nextDestinations: Array<number | undefined> = [];
    let nextDestination: number | undefined;
    for (let index = input.records.length - 1; index >= 0; index--) {
        nextDestinations[index] = nextDestination;
        if (sourceDestinations.has(index)) nextDestination = sourceDestinations.get(index);
    }
    const carriedComments = new Map<number, string[]>();
    try {
        for (let sourceIndex = 0; sourceIndex < input.currentLayout.records.length; sourceIndex++) {
            const sourceLayout = input.currentLayout.records[sourceIndex];
            const sourceRecord = input.records[sourceIndex];
            if (!preservedSourceRecords.has(sourceIndex)) {
                const reason = sourceTextLossReason(input, sourceRecord.text, sourceLayout);
                if (reason) return blankPlan(input, 'blocked', reason);
            }
            for (const field of sourceLayout.fields) {
                if (sourceLayout.fields.indexOf(field) === sourceLayout.recordMarker?.fieldIndex) continue;
                const key = `${sourceIndex}:${field.fieldMigrationId}`;
                if (consumedSourceFields.has(key)) continue;
                const value = input.readField?.(sourceRecord.text, sourceLayout,
                    sourceLayout.fields.indexOf(field)) ?? extractCell(sourceRecord.text, field);
                if (!value) continue;
                discardedFields.push({ recordMigrationId: sourceLayout.recordMigrationId, fieldMigrationId: field.fieldMigrationId, name: field.name, value });
            }
            if (consumedSourceRecords.has(sourceIndex) || targetRecordById.has(sourceLayout.recordMigrationId)) continue;
            const ordinaryComments = (sourceRecord.comments || []).filter(comment => {
                const analysis = analyzeSourceComment(comment, sourceIndex);
                if (analysis?.recordIndex === sourceIndex) {
                    commentChanges.push({ kind: 'delete', source: comment, recordMigrationId: sourceLayout.recordMigrationId });
                    return false;
                }
                return true;
            });
            if (ordinaryComments.length) {
                const destination = nextDestinations[sourceIndex];
                if (destination === undefined) trailingComments.push(...ordinaryComments);
                else {
                    const carried = carriedComments.get(destination) || [];
                    carried.push(...ordinaryComments);
                    carriedComments.set(destination, carried);
                }
            }
        }
    } catch (error) {
        return blankPlan(input, 'blocked', error instanceof Error ? error.message : 'comment-migration-failed');
    }

    for (const [destination, comments] of carriedComments) {
        replacementRecords[destination].comments.unshift(...comments);
    }
    const estimatedBytes = Buffer.byteLength(JSON.stringify({ replacementRecords, trailingComments }), 'utf8');
    if (estimatedBytes > maxBytes) return blankPlan(input, 'blocked', 'edit-budget-exceeded');
    const noChange = input.currentKeyword === input.targetKeyword &&
        JSON.stringify(input.records) === JSON.stringify(replacementRecords);
    return {
        ...blankPlan(input, noChange ? 'no-change' : 'ready', noChange ? 'selection-current' : 'ready'),
        replacementRecords,
        trailingComments,
        migratedFields,
        emptyTargetFields,
        discardedFields,
        commentChanges,
        blockers: [],
        estimatedBytes,
        applicationMode: 'layout-migration',
        requiresLossConfirmation: discardedFields.length > 0,
    };
}

function provisionalFieldName(value: unknown): string {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function provisionalFieldType(value: unknown): string {
    const text = String(value || '').toLowerCase();
    return /int|^i$/.test(text) ? 'integer' : /float|real|double|^f$|^r$/.test(text) ? 'float' : 'string';
}

function provisionalFieldId(field: any, recordIndex: number, fieldIndex: number, side: string): string {
    return String(field?.fieldMigrationId || `${side}-field:${recordIndex}:${fieldIndex}`);
}

function provisionalRecordId(record: any, index: number, side: string): string {
    return String(record?.recordMigrationId || `${side}-record:${index}`);
}

function provisionalPosition(field: any): number | null {
    const value = Number(field?.position);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function provisionalWidth(field: any): number | null {
    const value = Number(field?.width);
    return Number.isInteger(value) && value > 0 ? value : null;
}

function provisionalColumn(field: any): number | null {
    if (Number.isInteger(field?.columnOrdinal)) return Number(field.columnOrdinal);
    const position = provisionalPosition(field);
    const width = provisionalWidth(field);
    return position === null || width === null ? null : Math.floor(position / width) + 1;
}

function provisionalRecordWidth(record: any): number {
    return (record?.fields || []).reduce((maximum: number, field: any) => {
        const position = provisionalPosition(field);
        const width = provisionalWidth(field);
        return position === null || width === null ? maximum : Math.max(maximum, position + width);
    }, 0);
}

function provisionalExtract(text: string, field: any): string {
    const position = provisionalPosition(field);
    const width = provisionalWidth(field);
    if (position === null || width === null) return '';
    return String(text || '').slice(position, position + width).trim();
}

function provisionalWrite(characters: string[], field: any, value: string): boolean {
    const position = provisionalPosition(field);
    const width = provisionalWidth(field);
    if (position === null || width === null || value.length > width) return false;
    const stringLike = provisionalFieldType(field?.type) === 'string';
    const rendered = stringLike ? value.padEnd(width) : value.padStart(width);
    for (let index = 0; index < width; index++) characters[position + index] = rendered[index] || ' ';
    return true;
}

/**
 * Lenient authoring preview planner.  It deliberately records every fallback
 * decision in unmatchedFields/previewDiff and never returns a strict binding or
 * runtime permission.  The strict planner above remains unchanged by default.
 */
export function planProvisionalOptionSwitch(input: OptionSwitchPlannerInput): OptionSwitchPlan {
    const base = {
        currentKeyword: input.currentKeyword,
        targetKeyword: input.targetKeyword,
        documentVersion: Number.isInteger(input.documentVersion) ? Number(input.documentVersion) : null,
        uri: input.uri || null,
        keywordLine: Number.isInteger(input.keywordLine) ? Number(input.keywordLine) : 0,
        sourceLockIdentity: input.sourceLockIdentity || `provisional-option-layout-v1:${input.currentKeyword}->${input.targetKeyword}`,
    };
    const unmatchedFields: Array<Record<string, unknown>> = [];
    const previewDiff: Array<Record<string, unknown>> = [];
    const records = Array.isArray(input.records) ? input.records : [];
    const maxBytes = Number.isFinite(input.maxBytes) ? Number(input.maxBytes) : OPTION_SWITCH_MAX_BYTES;
    const sourceLayout = input.currentLayout && Array.isArray(input.currentLayout.records)
        ? input.currentLayout : { profileId: `provisional:${input.currentKeyword}`, keyword: input.currentKeyword, records: [] };
    const targetLayout = input.targetLayout && Array.isArray(input.targetLayout.records)
        ? input.targetLayout : { profileId: `provisional:${input.targetKeyword}`, keyword: input.targetKeyword, records: [] };

    if (input.inputFormat && input.inputFormat !== 'standard') {
        return {
            ...blankPlan(input, 'blocked', 'non-standard-input'),
            provisional: true,
            source: 'provisional-option-layout-v1',
            unmatchedFields,
            previewDiff,
        };
    }
    const sourceRecords = sourceLayout.records;
    const targetRecords = targetLayout.records;
    if (Buffer.byteLength(JSON.stringify(records), 'utf8') > maxBytes) {
        return {
            ...blankPlan(input, 'blocked', 'edit-budget-exceeded'),
            provisional: true,
            source: 'provisional-option-layout-v1',
            unmatchedFields,
            previewDiff,
        };
    }
    if (sourceRecords.length === 0 || targetRecords.length === 0) {
        const estimatedBytes = Buffer.byteLength(JSON.stringify(records), 'utf8');
        const noChange = input.currentKeyword === input.targetKeyword;
        const diff = { kind: 'layout-unavailable', currentKeyword: input.currentKeyword, targetKeyword: input.targetKeyword };
        return {
            ...blankPlan(input, noChange ? 'no-change' : 'ready', noChange ? 'selection-current' : 'ready'),
            ...base,
            replacementRecords: records.map(record => ({ text: record.text, comments: [...(record.comments || [])] })),
            blockers: [],
            estimatedBytes,
            applicationMode: 'keyword-only-preserve-block',
            requiresLossConfirmation: false,
            provisional: true,
            source: 'provisional-keyword-only-v1',
            unmatchedFields: [diff],
            previewDiff: [diff],
        };
    }

    const sourceByRecordId = new Map(sourceRecords.map((record: any, index: number) =>
        [provisionalRecordId(record, index, 'source'), { record, index }]));
    const hasStableRecordMatches = targetRecords.some((record: any, index: number) =>
        sourceByRecordId.has(provisionalRecordId(record, index, 'source')));
    const consumedSourceFields = new Set<string>();
    const consumedSourceRecords = new Set<number>();
    const preservedSourceRecords = new Set<number>();
    const migratedFields: Array<Record<string, unknown>> = [];
    const emptyTargetFields: Array<Record<string, unknown>> = [];
    const discardedFields: Array<Record<string, unknown>> = [];
    const replacementRecords: OptionSwitchRecord[] = [];
    const sourceDestinations = new Map<number, number>();
    const trailingComments: string[] = [];

    for (let targetRecordIndex = 0; targetRecordIndex < targetRecords.length; targetRecordIndex++) {
        const targetRecord: any = targetRecords[targetRecordIndex];
        const sourceMatch = sourceByRecordId.get(provisionalRecordId(targetRecord, targetRecordIndex, 'source')) ||
            (!hasStableRecordMatches && sourceRecords[targetRecordIndex]
                ? { record: sourceRecords[targetRecordIndex], index: targetRecordIndex }
                : null);
        const sourceRecord: any = sourceMatch?.record || null;
        if (sourceMatch) {
            consumedSourceRecords.add(sourceMatch.index);
            sourceDestinations.set(sourceMatch.index, targetRecordIndex);
        }
        const sourceFields = (sourceRecord?.fields || []).map((field: any, fieldIndex: number) => ({
            field,
            fieldIndex,
            key: `${sourceMatch?.index ?? targetRecordIndex}:${provisionalFieldId(field, sourceMatch?.index ?? targetRecordIndex, fieldIndex, 'source')}`,
        }));
        const text = sourceRecord && records[sourceMatch.index] ? records[sourceMatch.index].text : '';
        const preserveSourceText = sourceMatch && JSON.stringify(sourceRecord.fields) === JSON.stringify(targetRecord.fields);
        if (preserveSourceText) preservedSourceRecords.add(sourceMatch.index);
        const characters = preserveSourceText ? text.split('')
            : Array(Math.max(provisionalRecordWidth(targetRecord), text.length)).fill(' ');
        for (let targetFieldIndex = 0; targetFieldIndex < (targetRecord.fields || []).length; targetFieldIndex++) {
            const targetField: any = targetRecord.fields[targetFieldIndex];
            const targetId = provisionalFieldId(targetField, targetRecordIndex, targetFieldIndex, 'target');
            const targetName = provisionalFieldName(targetField?.name);
            const targetType = provisionalFieldType(targetField?.type);
            const available = sourceFields.filter(entry => !consumedSourceFields.has(entry.key));
            const sameName = available.filter(entry =>
                provisionalFieldName(entry.field?.name) === targetName &&
                provisionalFieldType(entry.field?.type) === targetType);
            const targetColumn = provisionalColumn(targetField);
            const sameColumn = available.filter(entry =>
                targetColumn !== null && provisionalColumn(entry.field) === targetColumn &&
                provisionalFieldType(entry.field?.type) === targetType);
            const ordinal = available.find(entry => entry.fieldIndex === targetFieldIndex &&
                provisionalFieldType(entry.field?.type) === targetType) ||
                available.find(entry => entry.fieldIndex === targetFieldIndex);
            const sourceEntry = sameName.length === 1 ? sameName[0]
                : sameColumn.length === 1 ? sameColumn[0]
                    : ordinal || null;
            if (!sourceEntry) {
                const unmatched = {
                    kind: 'unmatched-field',
                    targetRecordMigrationId: provisionalRecordId(targetRecord, targetRecordIndex, 'target'),
                    targetFieldMigrationId: targetId,
                    name: targetField?.name,
                    reason: 'no-source-match',
                };
                unmatchedFields.push(unmatched);
                previewDiff.push(unmatched);
                emptyTargetFields.push(unmatched);
                continue;
            }
            consumedSourceFields.add(sourceEntry.key);
            const value = provisionalExtract(text, sourceEntry.field);
            if (!value) {
                const empty = {
                    recordMigrationId: provisionalRecordId(targetRecord, targetRecordIndex, 'target'),
                    fieldMigrationId: targetId,
                    name: targetField?.name,
                };
                emptyTargetFields.push(empty);
                continue;
            }
            if (!provisionalWrite(characters, targetField, value)) {
                const unmatched = {
                    kind: 'unmatched-field',
                    targetRecordMigrationId: provisionalRecordId(targetRecord, targetRecordIndex, 'target'),
                    targetFieldMigrationId: targetId,
                    name: targetField?.name,
                    value,
                    reason: 'target-field-width-overflow',
                };
                unmatchedFields.push(unmatched);
                previewDiff.push(unmatched);
                discardedFields.push(unmatched);
                continue;
            }
            migratedFields.push({
                sourceRecordMigrationId: provisionalRecordId(sourceRecord, sourceMatch?.index ?? targetRecordIndex, 'source'),
                targetRecordMigrationId: provisionalRecordId(targetRecord, targetRecordIndex, 'target'),
                sourceFieldMigrationId: provisionalFieldId(sourceEntry.field, sourceMatch?.index ?? targetRecordIndex, sourceEntry.fieldIndex, 'source'),
                targetFieldMigrationId: targetId,
                value,
                mapping: sameName.length === 1 ? 'name-type' : sameColumn.length === 1 ? 'card-slot' : 'ordinal',
            });
        }
        replacementRecords.push({
            text: characters.join(''),
            comments: sourceRecord && records[sourceMatch.index]
                ? [...(records[sourceMatch.index].comments || [])]
                : targetRecord.generatedComment ? [String(targetRecord.generatedComment)] : [],
        });
    }

    for (let sourceRecordIndex = 0; sourceRecordIndex < records.length; sourceRecordIndex++) {
        const sourceRecord: any = sourceRecords[sourceRecordIndex];
        const sourceText = records[sourceRecordIndex]?.text || '';
        if (!preservedSourceRecords.has(sourceRecordIndex)) {
            const reason = sourceTextLossReason(input, sourceText, sourceRecord, false);
            if (reason) return { ...blankPlan(input, 'blocked', reason), ...base, provisional: true,
                source: 'provisional-option-layout-v1', unmatchedFields, previewDiff };
        }
        if (!sourceRecord) continue;
        let sourceHasFieldValue = false;
        for (let sourceFieldIndex = 0; sourceFieldIndex < (sourceRecord.fields || []).length; sourceFieldIndex++) {
            const sourceField = sourceRecord.fields[sourceFieldIndex];
            const key = `${sourceRecordIndex}:${provisionalFieldId(sourceField, sourceRecordIndex, sourceFieldIndex, 'source')}`;
            const value = provisionalExtract(sourceText, sourceField);
            if (value) sourceHasFieldValue = true;
            if (value && !consumedSourceFields.has(key)) {
                const discarded = {
                    kind: 'unmatched-source-field',
                    sourceRecordMigrationId: provisionalRecordId(sourceRecord, sourceRecordIndex, 'source'),
                    sourceFieldMigrationId: provisionalFieldId(sourceField, sourceRecordIndex, sourceFieldIndex, 'source'),
                    name: sourceField?.name,
                    value,
                    reason: 'target-has-no-match',
                };
                discardedFields.push(discarded);
                unmatchedFields.push(discarded);
                previewDiff.push(discarded);
            }
        }
        if (!consumedSourceRecords.has(sourceRecordIndex) && sourceText) {
            const extra = { kind: 'unmatched-source-record', sourceRecordMigrationId: provisionalRecordId(sourceRecord, sourceRecordIndex, 'source'), reason: 'target-has-no-record' };
            unmatchedFields.push(extra);
            previewDiff.push(extra);
            if (sourceText.trim() && !sourceHasFieldValue) {
                discardedFields.push({ ...extra, value: sourceText.trim() });
            }

        }
    }

    let pendingComments: string[] = [];
    for (let index = 0; index < records.length; index++) {
        const destination = sourceDestinations.get(index);
        if (destination === undefined) pendingComments.push(...(records[index].comments || []));
        else {
            replacementRecords[destination].comments.unshift(...pendingComments);
            pendingComments = [];
        }
    }
    trailingComments.push(...pendingComments);
    const estimatedBytes = Buffer.byteLength(JSON.stringify({ replacementRecords, trailingComments }), 'utf8');
    if (estimatedBytes > maxBytes) {
        return {
            ...blankPlan(input, 'blocked', 'edit-budget-exceeded'),
            ...base,
            provisional: true,
            source: 'provisional-option-layout-v1',
            unmatchedFields,
            previewDiff,
        };
    }
    const noChange = input.currentKeyword === input.targetKeyword &&
        JSON.stringify(records) === JSON.stringify(replacementRecords);
    return {
        ...blankPlan(input, noChange ? 'no-change' : 'ready', noChange ? 'selection-current' : 'ready'),
        ...base,
        replacementRecords,
        trailingComments,
        migratedFields,
        emptyTargetFields,
        discardedFields,
        commentChanges: [],
        blockers: [],
        estimatedBytes,
        applicationMode: 'layout-migration',
        requiresLossConfirmation: discardedFields.length > 0,
        provisional: true,
        source: 'provisional-option-layout-v1',
        unmatchedFields,
        previewDiff,
    };
}

/** Stable public planner facade for callers that prefer an injectable object. */
export class OptionSwitchPlanner {
    plan(input: OptionSwitchPlannerInput): OptionSwitchPlan {
        return planOptionSwitch(input);
    }
}

module.exports = { OPTION_SWITCH_MAX_BYTES, OptionSwitchPlanner, planOptionSwitch, planProvisionalOptionSwitch };
