const { throwIfCancellationRequested } = require('../../core/scanner/scannerContracts');

/** Poll only the first visible page while counts grow; later pages require an explicit user request. */
export async function followEntityQuery(request: (params: any, token?: any) => Promise<any>, query: any,
    onProgress?: (response: any) => void, token?: any, isCurrent = () => true) {
    const handle = await request({ action: 'query-open', query }, token);
    let retained = false;
    let detached = false;
    const release = (retain = false) => {
        if (detached) return;
        detached = true;
        void request({ action: 'query-release', lease: handle.lease, retain }).catch(() => {});
    };
    const loadPage = async (cursor: any) => {
        const response = await request({ action: 'query-page', ...cursor });
        if (response.status === 'ready') response.result.page.appendRole = cursor.role;
        return response;
    };
    try {
        let previous = '';
        while (true) {
            if (!isCurrent()) release(true);
            if (detached) return { status: 'stale' };
            throwIfCancellationRequested(token);
            // Reserve visible space for references even when an ID has many competing definitions.
            const definitions = await request({ action: 'query-page', ...handle, role: 'definition', limit: 100 }, token);
            if (definitions.status !== 'ready') return definitions;
            const firstDefinitions = definitions.result.locations;
            if (firstDefinitions.length > 100) throw new Error('Entity definition page limit exceeded');
            const room = 200 - firstDefinitions.length;
            const references = await request({ action: 'query-page', ...handle, role: 'reference', limit: room }, token);
            if (!isCurrent()) release(true);
            if (detached) return { status: 'stale' };
            if (references.status !== 'ready') return references;
            if (references.result.locations.length > room) throw new Error('Entity page limit exceeded');
            // The producer can finish between the two reads. Never combine a new final count
            // with an older empty definition page and accidentally report no target.
            if (definitions.state !== references.state ||
                definitions.result.page.epoch !== references.result.page.epoch ||
                definitions.result.page.counts.definition !== references.result.page.counts.definition) continue;
            const firstReferences = references.result.locations;
            const next = { ...definitions.result.page.next, ...references.result.page.next };
            const diagnostics = query.diagnostics === true
                ? await request({ action: 'query-diagnostics', ...handle }, token) : undefined;
            if (!isCurrent()) release(true);
            if (detached) return { status: 'stale' };
            throwIfCancellationRequested(token);
            if (diagnostics?.epoch !== undefined && diagnostics.epoch !== references.result.page.epoch) continue;
            const response = { ...references, ...(diagnostics ? { diagnostics } : {}), result: { ...references.result,
                locations: [...firstDefinitions, ...firstReferences], release, loadPage,
                revision: handle.revision, page: { ...references.result.page, next } } };
            const signature = JSON.stringify([response.state, response.result.page.epoch, response.result.page.counts,
                response.result.locations, response.result.reasons, response.diagnostics]);
            if (signature !== previous) { previous = signature; onProgress?.(response); }
            if (response.state !== 'scanning') { retained = true; return response; }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    } finally { if (!retained) release(); }
}
