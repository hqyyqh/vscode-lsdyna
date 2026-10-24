const { INCLUDE_OFFSET_KEYS } = require('../core/references/nativeIncludeOffsets');

/** Bounded, allowlisted diagnostics: never transport model text or physical paths. */
export function entityQueryDiagnosticSummary(snapshot: any, referenceIndex?: any) {
    const files = new Map<string, string>();
    const fileId = (file: string) => {
        if (!file) return null;
        const key = process.platform === 'win32' ? file.toLowerCase() : file;
        if (!files.has(key)) files.set(key, `file-${files.size + 1}`);
        return files.get(key);
    };
    const offsets = (values: any) => Object.fromEntries(INCLUDE_OFFSET_KEYS.map(key => [key,
        Number.isSafeInteger(values?.[key]) ? values[key] : null]));
    const reasons = (values: any) => (Array.isArray(values) ? values : [])
        .filter(value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,100}$/.test(value)).slice(0, 32);
    const input = (value: any) => ({ kind: ['blank', 'numeric', 'parameter', 'expression', 'invalid'].includes(value?.kind)
        ? value.kind : 'unknown', value: Number.isFinite(value?.value) ? value.value : null });
    const root = fileId(snapshot.rootFile);
    const sources = [];
    for (const [file, index] of snapshot.fileIndexes || []) {
        if (sources.length === 128) break;
        sources.push({ file: fileId(file), source: Number.isInteger(index.documentVersion) ? 'editor' : 'disk',
            documentVersion: index.documentVersion, blocks: index.keywordBlocks?.length });
    }
    const edges = snapshot.graph?.includeOccurrences || [];
    const includes = edges.slice(0, 128).map(edge => ({ from: fileId(edge.fromFile), to: fileId(edge.filePath),
        line: edge.lineIndex + 1, transform: edge.transform ? {
            offsets: Object.fromEntries(INCLUDE_OFFSET_KEYS.map(key => [key, input(edge.transform.offsets?.[key])])),
            tranid: input(edge.transform.tranid), reasons: reasons(edge.transform.parseCompleteness?.reasons),
        } : null }));
    const contexts = [];
    let contextCount = 0;
    for (const [file, entries] of referenceIndex?.parameterContextsByFile || []) for (const entry of entries) {
        contextCount++;
        if (contexts.length < 128) contexts.push({ file: fileId(file), depth: entry.occurrencePath?.length,
            offsets: offsets(entry.includeOffsets), offsetDepths: offsets(entry.offsetDepths),
            reasons: reasons(entry.uncertaintyReasons) });
    }
    return { root, fileCount: snapshot.fileIndexes?.size, sources, includes, includeCount: edges.length,
        missingCount: snapshot.missingFiles?.length || 0, failedCount: snapshot.failedFiles?.length || 0,
        cycleCount: snapshot.graph?.cycles?.length || 0, contexts, contextCount,
        truncated: snapshot.fileIndexes?.size > 128 || edges.length > 128 || contextCount > 128,
        completenessReasons: reasons(referenceIndex?.completenessReasons) };
}
