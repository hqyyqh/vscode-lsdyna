export type NativeParameterContext = {
    readonly documentVersion: number;
    resolve(raw: string, line: number, allowReal?: boolean): { resolved: boolean; value?: number; reasons?: string[] };
};

/** Host validates snapshot freshness and root selection before constructing this context. */
export function createNativeParameterContext(referenceIndex: any, documentPath: string,
    documentVersion: number, unavailableReason?: string): NativeParameterContext {
    // Project reference readers themselves load the schema; defer this dependency.
    const { analyzeIntegerParameterValueAtLocation, analyzeNumericParameterValueAtLocation, parameterContextsForDocument } = require('../references/projectReferenceIndex');
    // Retain only this document's parameter timelines, not the entire entity index.
    const parameterIndex = referenceIndex ? { parameterContextsByFile: new Map([
        [documentPath, parameterContextsForDocument(referenceIndex, documentPath)],
    ]) } : null;
    return { documentVersion, resolve(raw, line, allowReal = false) {
        if (unavailableReason || !parameterIndex || !Number.isInteger(line)) return {
            resolved: false, reasons: [unavailableReason || 'parameter-context-unavailable'],
        };
        const result = (allowReal ? analyzeNumericParameterValueAtLocation : analyzeIntegerParameterValueAtLocation)(parameterIndex, raw, { documentPath, lineIndex: line });
        return !allowReal && result.resolved && (result.value < -2147483648 || result.value > 2147483647)
            ? { resolved: false, reasons: ['parameter-control-outside-int32'] } : result;
    } };
}

export function nativeControlResolver(context: NativeParameterContext | undefined, recordLines: number[] = [], allowReal = false) {
    const reasons = new Set<string>();
    return { reasons, resolve(raw: string, row: number): string {
        if (!raw.includes('&')) return raw;
        const result = context?.resolve(raw, recordLines[row], allowReal);
        if (result?.resolved) return String(result.value);
        for (const reason of result?.reasons || ['parameter-context-unavailable']) reasons.add(reason);
        return raw;
    } };
}
