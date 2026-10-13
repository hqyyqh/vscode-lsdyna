const { ProjectGraph } = require('../../core/project/projectGraph');
const { throwIfCancellationRequested } = require('../../core/scanner/scannerContracts');
const i18n = require('../../core/i18n');

/** One in-flight pull per subscription; no result arrays accumulate in notifications. */
export async function followProjectStructure(request: (params: any, token?: any) => Promise<any>,
    rootFile: string, options: any = {}, onProgress?: (event: any) => void, token?: any) {
    let handle = await request({ action: 'open', rootFile, options }, token);
    let restarted = false;
    let graph = new ProjectGraph(); graph.addFile(rootFile);
    const files = new Map<string, any>();
    const occurrences = new Map<string, any>();
    // Physical files may appear several times; tree identity belongs to the Include occurrence.
    const toTree = (filePath, ancestry = []) => ({ filePath, scanState: files.get(filePath)?.state || 'waiting',
        children: ancestry.includes(filePath) ? [] : [...occurrences.values()]
            .filter(row => row.fromFile === filePath).sort((a, b) => a.lineIndex - b.lineIndex)
            .map(row => ({ ...row, ...(row.pending || row.missing ? { children: [] }
                : graph.toTree(row.filePath, [...ancestry, filePath])),
                occurrenceId: `${row.fromFile}:${row.lineIndex}` })),
        ...(ancestry.includes(filePath) ? { cycle: true } : {}) });
    graph.toTree = toTree;
    let generation = handle.generation;
    let after = 0;
    let previousState;
    const snapshot = () => ({ scope: options.singleFileOnly ? 'single-file' : 'project', rootFile,
        graph, files: [...files.keys()], fileIndexes: new Map(), keywordMap: new Map(),
        missingFiles: graph.missingFiles, cycles: graph.cycles, structureOnly: true,
        project: { ...handle, generation }, fileStates: files });
    try {
        onProgress?.({ type: 'structureProgress', snapshot: snapshot() });
        while (true) {
            throwIfCancellationRequested(token);
            const page = await request({ action: 'read', lease: handle.lease, generation, after,
                kinds: ['file', 'include'] }, token);
            if (page.state === 'stale') {
                if (restarted) {
                    const error = new Error(i18n.get('projectChangedDuringScan')); error.name = 'ScanChangedError'; throw error;
                }
                restarted = true;
                if (page.generation !== undefined && page.generation !== generation) {
                    generation = page.generation;
                } else {
                    await request({ action: 'release', lease: handle.lease }).catch(() => {});
                    throwIfCancellationRequested(token);
                    handle = await request({ action: 'open', rootFile, options }, token);
                    generation = handle.generation;
                }
                after = 0; previousState = undefined;
                graph = new ProjectGraph(); graph.addFile(rootFile); graph.toTree = toTree;
                files.clear(); occurrences.clear();
                onProgress?.({ type: 'structureProgress', state: 'scanning', snapshot: snapshot() });
                continue;
            }
            for (const row of page.rows) {
                if (row.type === 'file') { files.set(row.filePath, row); graph.addFile(row.filePath); }
                if (row.type !== 'include') continue;
                const key = `${row.fromFile}:${row.lineIndex}`;
                const previous = occurrences.get(key);
                occurrences.set(key, row);
                if (row.pending || previous && !previous.pending) continue;
                if (row.missing) graph.addMissingFile(row);
                else if (row.cycle) { graph.addIncludeOccurrence(row.fromFile, row); graph.addCycle(row); }
                else graph.addIncludeEdge(row.fromFile, row.filePath, row);
            }
            after = page.after;
            if (page.rows.length || previousState !== page.state)
                onProgress?.({ type: 'structureProgress', state: page.state, snapshot: snapshot() });
            previousState = page.state;
            if (!page.pending && page.state !== 'scanning') {
                if (page.state !== 'complete') {
                    const error = Object.assign(new Error(i18n.get('scanStructureIncomplete')), { reason: page.error });
                    error.name = 'ProjectIncompleteError'; throw error;
                }
                return snapshot();
            }
            if (!page.pending) await new Promise(resolve => setTimeout(resolve, 200));
        }
    } finally {
        await request({ action: 'release', lease: handle.lease }).catch(() => {});
    }
}
