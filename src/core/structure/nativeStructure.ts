import { hasNativeFileReader } from '../semantics/nativeFieldResolution';
import { nativeSpellingGap, NATIVE_FILE_SOURCE } from "../semantics/catalogNativeFileLayout";
import { nativeKeywordReadContext } from '../semantics/nativeFileReadContext';
import type { NativeParameterContext } from '../semantics/nativeParameterContext';
import type { KeywordInputFormatMode } from '../parser/inputFormat';
import { stripKeywordInputFormatMarker } from '../parser/inputFormat';
import type { ObservedKeywordBlock, StructureAnalysis } from './types';

/** A failed native read is uncertainty, never permission to reinterpret it with a manual grammar. */
export function analyzeNativeStructure(block: ObservedKeywordBlock, globalInputFormat: KeywordInputFormatMode = 'standard',
    parameters?: NativeParameterContext): StructureAnalysis | null {
    const keyword = stripKeywordInputFormatMarker(block.keyword.replace(/^\*/, ''));
    if (!hasNativeFileReader(keyword)) return null;
    const result: StructureAnalysis = {
        keyword: block.keyword, sourceProfileId: `lspp:${NATIVE_FILE_SOURCE}`,
        status: 'context-dependent', reason: 'native-record-layout-unresolved',
        observedDataRecords: block.records.length, records: [], diagnostics: [], dependencies: [], repairCandidates: [], block,
    };
    const gap = nativeSpellingGap(keyword);
    if (gap) return { ...result, status: gap.nativeRejected ? 'unsupported-input' : 'profile-unverified', reason: gap.reason };
    try {
        const reading = nativeKeywordReadContext(block.rawKeyword, block.records.map(record => record.text),
            globalInputFormat, block.records.map(record => record.line), parameters);
        if (!reading) return { ...result, status: 'profile-unverified', reason: 'native-file-source-unverified' };
        if (reading.kind?.startsWith('unsupported')) return { ...result, status: 'profile-unverified', reason: reading.kind };
        if (reading.readInputFailure) return { ...result, status: 'unsupported-input', reason: reading.readInputFailure };
        const selection = reading.select(false);
        if (!selection?.current || selection.current.length !== block.records.length ||
            'uncertainty' in selection && selection.uncertainty ||
            'reasons' in selection && Array.isArray(selection.reasons) && selection.reasons.length ||
            reading.controls.reasons.size) return result;
        // A selected physical descriptor proves read layout, not solver validity or repair authority.
        if (selection.current.some((record, index) => !record || !reading.cards.has(record.cardIndex) &&
            !(record.cardIndex === 0 && /_TITLE$/.test(keyword) && index === record.instanceStart))) return result;
        return { ...result, status: 'valid', reason: 'native-record-layout-verified',
            expectedDataRecords: selection.current.length,
            records: block.records.map((record, index) => ({ observedOrdinal: record.ordinal,
                observedLine: record.line, expectedIndex: index, cardNodeId: String(selection.current[index].cardIndex), status: 'matched' })) };
    } catch {
        return { ...result, status: 'profile-unverified', reason: 'native-file-source-unavailable' };
    }
}
