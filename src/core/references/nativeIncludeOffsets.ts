/** Pinned LSPP 4.14 INCLUDE_TRANSFORM read/save: IDs use their native
 * namespace's offset; a negative reference keeps its sign after renumbering.
 * Evidence: entity-reference-closure-20261007/typed-offset-native-corrected.
 */
const { OFFSET_FIELDS } = require('../parser/includeTransformMetadata');
const { getReferenceRuleCatalog } = require('./referenceRuleCatalog');
export const INCLUDE_OFFSET_KEYS = [...OFFSET_FIELDS, 'idroff'];

function offsetKeys(targetKinds: string[], targetDefinitions: string[]): Set<string> {
    const nativeOffsets = getReferenceRuleCatalog().metadata('nativeIncludeOffsets') || {};
    const exactKeys = targetDefinitions.map(keyword => nativeOffsets.offsetKeyByKeyword?.[
        String(keyword).replace(/^\*/, '').split(/\s/)[0].replace(/[+%]$/, '').toUpperCase()]);
    return new Set(exactKeys.length && exactKeys.every(key => key !== undefined) ? exactKeys :
        targetKinds.map(kind => nativeOffsets.offsetKeyByKind?.[kind]));
}

export function initialIncludeOffsets(): Record<string, number> {
    return Object.fromEntries(INCLUDE_OFFSET_KEYS.map(key => [key, 0]));
}

/** Legacy callers without the typed context retain their existing IDFOFF
 * contract. Real project occurrences always carry includeOffsets. */
export function nativeOccurrenceOffset(context: any, targetKinds: string[], targetDefinitions: string[] = []): number | null {
    if (!context.includeOffsets) return context.idfoffOffset;
    const keys = offsetKeys(targetKinds, targetDefinitions);
    if (keys.size !== 1 || keys.has(undefined)) {
        return INCLUDE_OFFSET_KEYS.every(key => context.includeOffsets[key] === 0) ? 0 : null;
    }
    const key = [...keys][0];
    return key === 'none' ? 0 : context.includeOffsets[key] ?? null;
}

export function nativeSignedOffsetVerified(contexts: any[], targetKinds: string[], targetDefinitions: string[] = []): boolean {
    const keys = offsetKeys(targetKinds, targetDefinitions);
    return contexts.length > 0 && contexts.every(context => context.includeOffsets &&
        keys.size > 0 && !keys.has(undefined));
}

export function nativeOffsetReasons(context: any, targetKinds: string[], targetDefinitions: string[] = []): string[] {
    if (Number.isSafeInteger(nativeOccurrenceOffset(context, targetKinds, targetDefinitions))) return [];
    const reasons = ['transform-offset-unresolved'];
    if ([...offsetKeys(targetKinds, targetDefinitions)].some(key => context.offsetDepths?.[key] > 1))
        reasons.push('nested-transform-unsupported');
    return reasons;
}
