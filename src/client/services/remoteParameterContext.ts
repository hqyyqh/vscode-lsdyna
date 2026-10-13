import { EntityQueryCache } from '../../core/references/entityQueryCache';
import { boundedIndexPage, indexJsonBytes } from '../../shared/indexPages';
import { CancellationToken, CancellationTokenSource } from 'vscode';

// Values only. The dependency graph and expression evaluation stay in the worker.
const values = new EntityQueryCache(8 * 1024 * 1024);
export function createRemoteParameterContext(documentVersion: number,
    request: (fields: any[], token: CancellationToken) => Promise<any>, current: () => boolean) {
    const identity = values.identity({});
    const pending = new Map<string, any>();
    let pendingBytes = 0, requested = 0, inFlight: Promise<boolean> | undefined;
    const unavailable = (reason: string) => ({ resolved: false, reasons: [reason] });
    const key = (raw: string, line: number, allowReal: boolean) => JSON.stringify([identity, line, allowReal, raw]);
    return {
        documentVersion,
        resolve(raw: string, line: number, allowReal = false) {
            if (!current()) return unavailable('parameter-context-stale');
            if (!Number.isSafeInteger(line) || line < 0) return unavailable('parameter-context-unavailable');
            if (Buffer.byteLength(raw) > 16 * 1024) return unavailable('parameter-evaluation-budget');
            const id = key(raw, line, allowReal), cached = values.get(id);
            if (cached) return cached;
            if (!pending.has(id)) {
                const field = { raw, line, allowReal }, bytes = indexJsonBytes(field) * 4;
                if (requested >= 4096 || pendingBytes + bytes > 256 * 1024) return unavailable('parameter-evaluation-budget');
                pending.set(id, field); pendingBytes += bytes; requested++;
            }
            return unavailable('parameter-context-pending');
        },
        flush(): Promise<boolean> {
            if (inFlight) return inFlight;
            inFlight = (async () => {
                let changed = false;
                while (pending.size && current()) {
                    const fields = boundedIndexPage(pending.values(), { fields: [] });
                    let response;
                    const cancellation = new CancellationTokenSource();
                    const timer = setInterval(() => { if (!current()) cancellation.cancel(); }, 25);
                    try { response = await request(fields, cancellation.token); }
                    catch { response = { status: 'unavailable' }; }
                    finally { clearInterval(timer); cancellation.dispose(); }
                    if (!current()) { pending.clear(); pendingBytes = 0; return false; }
                    for (let i = 0; i < fields.length; i++) {
                        const field = fields[i], id = key(field.raw, field.line, field.allowReal);
                        let result = response?.status === 'ready' && response.results?.length === fields.length
                            ? response.results[i] : unavailable(response?.status === 'limited'
                                ? 'parameter-evaluation-budget' : 'parameter-context-unavailable');
                        if (!result || typeof result.resolved !== 'boolean' ||
                            result.resolved && !Number.isFinite(result.value)) result = unavailable('parameter-context-unavailable');
                        if (!field.allowReal && result.resolved && (!Number.isInteger(result.value) || result.value < -2147483648 || result.value > 2147483647))
                            result = unavailable('parameter-control-outside-int32');
                        values.set(id, result); pending.delete(id); pendingBytes -= indexJsonBytes(field) * 4;
                    }
                    changed = true;
                }
                return changed;
            })().finally(() => { inFlight = undefined; });
            return inFlight;
        },
    };
}
