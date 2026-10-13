const { createCancellationError } = require('../scanner/scannerContracts');
const { estimateMemorySize } = require('../cache/memorySize');
import { createHash } from 'node:crypto';

// Object identities bind immutable scan products, not temporary snapshot/Map wrappers.
export class EntityQueryCache {
    private identities = new WeakMap<object, number>();
    private fileRevisions = new WeakMap<object, string>();
    private sequence = 0;
    private entries = new Map<string, { value: any; bytes: number }>();
    private pending = new Map<string, any>();
    private bytes = 0;
    private reservedBytes = 0;
    private fallbackBytes = 0;
    private epoch = 0;
    constructor(readonly maxBytes = 512 * 1024 * 1024) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid entity cache budget');
    }
    identity(value: any): number | null {
        if (!value || typeof value !== 'object' && typeof value !== 'function') return null;
        if (!this.identities.has(value)) this.identities.set(value, ++this.sequence);
        return this.identities.get(value);
    }
    fileRevision(index: any): string | number {
        if (index?.semanticBlockRevision) return index.semanticBlockRevision;
        // Live documents need instance identity: close/reopen can restart version numbers.
        if (!index || Number.isInteger(index.documentVersion) || !Number.isFinite(index.size) ||
            !Number.isFinite(index.mtimeMs) || index.scannerVersion === undefined) return this.identity(index);
        let revision = this.fileRevisions.get(index);
        if (!revision) {
            const hash = createHash('sha256');
            hash.update(JSON.stringify([index.size, index.mtimeMs, index.scannerVersion, index.sourceRevision]));
            for (const block of index.keywordBlocks || []) hash.update(JSON.stringify([
                block.keyword, block.rawKeyword, block.startLine, block.endLine, block.startOffset, block.endOffset,
            ]));
            revision = hash.digest('hex');
            this.fileRevisions.set(index, revision);
        }
        return revision;
    }
    revision(snapshot: any): string {
        const files = snapshot?.fileIndexes instanceof Map ? [...snapshot.fileIndexes] : Object.entries(snapshot?.fileIndexes || {});
        return JSON.stringify([snapshot?.rootFile, snapshot?.scope, snapshot?.scanOptionsKey,
            this.identity(snapshot?.graph), snapshot?.files,
            snapshot?.effectiveSearchPathsByFile instanceof Map
                ? [...snapshot.effectiveSearchPathsByFile] : snapshot?.effectiveSearchPathsByFile,
            files.map(([file, index]: [string, any]) => [file, this.identity(index), index?.size,
                index?.mtimeMs, index?.scannerVersion, index?.documentVersion])]);
    }
    get(key: string): any {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key); this.entries.set(key, entry);
        return entry.value;
    }
    set(key: string, value: any): void {
        if (this.entries.get(key)?.value === value) return;
        const budget = this.maxBytes - this.reservedBytes;
        const bytes = estimateMemorySize(value, budget) + 64 + key.length * 2;
        if (!Number.isFinite(bytes) || bytes > budget) return;
        const previous = this.entries.get(key);
        if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
        while (this.bytes + bytes > budget && this.entries.size) {
            const oldest = this.entries.keys().next().value;
            this.bytes -= this.entries.get(oldest).bytes; this.entries.delete(oldest);
        }
        this.entries.set(key, { value, bytes }); this.bytes += bytes;
    }
    reserveBuild(maximum = this.maxBytes) {
        const bytes = Math.max(0, Math.min(maximum, this.maxBytes - this.bytes - this.reservedBytes));
        this.reservedBytes += bytes;
        let released = false;
        return { bytes, release: () => {
            if (!released) { this.reservedBytes -= bytes; released = true; }
        } };
    }
    reserveResult() {
        if (this.maxBytes) {
            const wanted = Math.floor(this.maxBytes / 4);
            while (this.maxBytes - this.bytes - this.reservedBytes < wanted && this.entries.size) {
                const key = this.entries.keys().next().value;
                this.bytes -= this.entries.get(key).bytes; this.entries.delete(key);
            }
            return this.reserveBuild(wanted);
        }
        // Disabling the cache still permits one bounded, uncached query workspace.
        const bytes = Math.max(0, 1024 * 1024 - this.fallbackBytes);
        this.fallbackBytes += bytes;
        let released = false;
        return { bytes, release: () => { if (!released) { this.fallbackBytes -= bytes; released = true; } } };
    }
    clear(): void {
        this.epoch++; this.entries.clear(); this.pending.clear(); this.bytes = 0;
    }
    invalidateQueries(): void {
        this.epoch++; this.pending.clear();
        for (const [key, entry] of this.entries) {
            if (key.startsWith('["definition-type",') || key.startsWith('["reference-type",')) continue;
            this.entries.delete(key); this.bytes -= entry.bytes;
        }
    }
    stats() { return { bytes: this.bytes, reservedBytes: this.reservedBytes, fallbackBytes: this.fallbackBytes,
        entries: this.entries.size, pending: this.pending.size }; }
    async run(key: string, token: any, build: (token: any) => Promise<any>, onPhase?: (event: any) => void) {
        if (token?.isCancellationRequested) throw createCancellationError();
        const cached = this.get(key);
        if (cached) { onPhase?.({ phase: 'query-cache', hit: true, durationMs: 0 }); return cached; }
        let entry = this.pending.get(key);
        if (entry?.token.isCancellationRequested) entry = undefined;
        if (!entry) {
            const epoch = this.epoch;
            const subscribers = new Set<any>();
            entry = { subscribers, token: { get isCancellationRequested() {
                return epoch !== cache.epoch || subscribers.size === 0 ||
                    [...subscribers].every(subscriber => subscriber.token?.isCancellationRequested);
            } } };
            const cache = this;
            const owner = entry;
            entry.promise = Promise.resolve().then(() => build(owner.token)).then(value => {
                if (owner.token.isCancellationRequested) throw createCancellationError();
                if (value.state === 'complete') this.set(key, value);
                return value;
            }).finally(() => { if (this.pending.get(key) === owner) this.pending.delete(key); });
            this.pending.set(key, entry);
        } else onPhase?.({ phase: 'query-cache', joined: true, durationMs: 0 });
        const subscriber = { token };
        entry.subscribers.add(subscriber);
        try {
            return await new Promise((resolve, reject) => {
                const timer = setInterval(() => { if (token?.isCancellationRequested) {
                    clearInterval(timer); reject(createCancellationError());
                } }, 10);
                entry.promise.then(resolve, reject).finally(() => clearInterval(timer));
            });
        } finally { entry.subscribers.delete(subscriber); }
    }
}

/** Editor edits preserve unaffected BlockIndex objects; their facts need no new text read. */
export function* entityFileScopes(entries: Iterable<[string, any]>): Generator<[string, any]> {
    for (const [file, index] of entries) {
        if (!Number.isInteger(index.documentVersion) || !index.keywordBlocks?.every(block => block.contentIdentity)) {
            yield [file, index]; continue;
        }
        const headers = [];
        for (const block of index.keywordBlocks) {
            if (String(block.keyword).replace(/^\*/, '').toUpperCase() === 'KEYWORD') { headers.push(block); continue; }
            yield [file, { ...index, keywordBlocks: [...headers, block], semanticBlockRevision: JSON.stringify([
                block.contentIdentity, block.startLine, block.endLine, headers.map(header => [header.contentIdentity, header.rawKeyword]),
            ]) }];
        }
    }
}
