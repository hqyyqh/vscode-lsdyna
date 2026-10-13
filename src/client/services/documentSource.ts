import { randomUUID } from 'node:crypto';
import { assertIndexPayload, boundedIndexPage, INDEX_PROTOCOL_VERSION } from '../../shared/indexPages';

/** The editor owns text and BlockIndex. Only a requested versioned window leaves this process. */
export function createDocumentSource(documents: () => any[], ensureIndex: (document: any) => Promise<any>) {
    const instances = new WeakMap<object, string>();
    const blocks = new WeakMap<object, string>();
    const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    return async (request: any) => {
        assertIndexPayload(request);
        if (request.protocolVersion !== INDEX_PROTOCOL_VERSION) throw new Error('Document protocol mismatch; reload window');
        const document = documents().find(document => !document.isClosed && document.isDirty &&
            document.uri.scheme === 'file' && key(document.uri.fsPath) === key(request.filePath || ''));
        if (!document) return { state: request.action === 'describe' ? 'disk' : 'stale' };
        let instance = instances.get(document);
        if (!instance) { instance = randomUUID(); instances.set(document, instance); }
        const identity = { uri: document.uri.toString(), instance, version: document.version };
        const revision = 'live:' + JSON.stringify(identity);
        const current = () => !document.isClosed && document.isDirty && document.version === identity.version &&
            documents().includes(document);
        if (request.action === 'describe') return assertIndexPayload({ state: 'live', identity, revision,
            lineCount: document.lineCount });
        if (request.revision !== revision) return { state: 'stale' };
        const offset = request.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid document cursor');
        const header = { state: 'live', revision, next: offset, complete: false };
        if (request.action === 'blocks') {
            const index = await ensureIndex(document);
            if (!index || !current()) return { state: 'stale' };
            const candidates = [];
            for (let i = offset; i < Math.min(index.blocks.length, offset + 200); i++) {
                const block = index.blocks[i];
                if (!blocks.has(block)) blocks.set(block, randomUUID());
                const rawKeyword = document.lineAt(block.startLine).text;
                if (rawKeyword.length > 65536) return { state: 'limited', reason: 'document-keyword-line-limit' };
                candidates.push({ keyword: '*' + String(block.keyword).replace(/^\*/, ''), startLine: block.startLine, endLine: block.endLine,
                    dataLineCount: block.dataLineCount, displayIdentity: block.displayIdentity,
                    contentIdentity: `${instance}:${blocks.get(block)}:${block.contentVersion || 0}`,
                    rawKeyword, filePath: document.uri.fsPath, documentRevision: revision });
            }
            const rows = boundedIndexPage(candidates, header);
            if (!current()) return { state: 'stale' };
            return assertIndexPayload({ ...header, rows, next: offset + rows.length,
                complete: offset + rows.length >= index.blocks.length });
        }
        if (request.action !== 'lines') throw new TypeError('Unknown document source action');
        const end = request.endLine;
        if (!Number.isSafeInteger(end) || end < offset || end >= document.lineCount)
            throw new TypeError('Invalid document line range');
        const candidates = [];
        for (let line = offset; line <= Math.min(end, offset + 199); line++) {
            const text = document.lineAt(line).text;
            if (text.length > 65536) return { state: 'limited', reason: 'document-line-limit' };
            candidates.push({ line, text });
        }
        const rows = boundedIndexPage(candidates, header);
        if (!current()) return { state: 'stale' };
        return assertIndexPayload({ ...header, rows, next: offset + rows.length, complete: offset + rows.length > end });
    };
}
