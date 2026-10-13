import { entityFileSignature } from '../core/cache/entityFileRevision';
import { assertIndexPayload, INDEX_PROTOCOL_VERSION, indexJsonBytes } from '../shared/indexPages';
const { buildFileStructure } = require('../core/scanner/fileIndexBuilder');
const { scanBlockLinesFromDisk } = require('../core/references/onDemandDefinitionScanner');
const { throwIfCancellationRequested } = require('../core/scanner/scannerContracts');

/** Versioned editor reads share parsing with disk sources, without a second document mirror. */
export class LiveFileSource {
    constructor(private request: (request: any) => Promise<any>, private maxBytes = 16 * 1024 * 1024) {}
    private async read(request: any, token?: any) {
        throwIfCancellationRequested(token);
        const result = assertIndexPayload(await this.request({ ...request, protocolVersion: INDEX_PROTOCOL_VERSION }));
        throwIfCancellationRequested(token);
        return result;
    }
    signature = async (filePath: string): Promise<any> => {
        const source = await this.read({ action: 'describe', filePath });
        if (source.state === 'disk') return entityFileSignature(filePath);
        if (source.state !== 'live') throw this.changed();
        // Live size is deliberately unknown, never a falsely measured byte count.
        return { size: 0, mtimeMs: source.identity.version, sourceRevision: source.revision,
            documentVersion: source.identity.version, lineCount: source.lineCount };
    };
    unchanged = async (files: any[], token?: any) => {
        for (const file of files) {
            throwIfCancellationRequested(token);
            try { if ((await this.signature(file.file)).sourceRevision !== file.revision) return false; }
            catch (error) { throwIfCancellationRequested(token); return false; }
        }
        return true;
    };
    private changed() { const error = new Error('Document source changed'); error.name = 'ScanChangedError'; return error; }
    structure = async (filePath: string, options: any) => {
        const signature = await this.signature(filePath);
        if (!Number.isInteger(signature.documentVersion)) return buildFileStructure(filePath, options);
        const keywordBlocks = [];
        let offset = 0, bytes = 0;
        while (true) {
            const page = await this.read({ action: 'blocks', filePath, revision: signature.sourceRevision, offset }, options.cancellationToken);
            if (page.state === 'stale') throw this.changed();
            if (page.state !== 'live') throw new RangeError('Document structure unavailable within limits');
            for (const block of page.rows) {
                bytes += indexJsonBytes(block) * 4;
                if (bytes > this.maxBytes) throw new RangeError('Document structure budget exceeded');
                keywordBlocks.push(block); options.onStructureBlock?.(block, true);
            }
            await options.flushStructure?.();
            if (page.complete) break;
            if (page.next <= offset) throw new Error('Document cursor did not advance');
            offset = page.next;
        }
        const result = await buildFileStructure(filePath, { ...options, liveSource: { signature, keywordBlocks,
            readBlockText: (block, readOptions) => this.blockText(block, { ...readOptions, cancellationToken: options.cancellationToken }) } });
        if ((await this.signature(filePath)).sourceRevision !== signature.sourceRevision) throw this.changed();
        return result;
    };
    blockText = async (block: any, options: any = {}) => {
        const parts = [];
        const limit = options.maxBytes ?? 8 * 1024 * 1024;
        let bytes = 0, records = 0, offset = block.startLine;
        while (offset <= block.endLine) {
            const page = await this.read({ action: 'lines', filePath: block.filePath, revision: block.documentRevision,
                offset, endLine: block.endLine }, options.cancellationToken);
            if (page.state === 'stale') throw this.changed();
            if (page.state !== 'live') {
                if (!options.onTruncated) throw new RangeError('Document block exceeds reader limits');
                options.onTruncated(); break;
            }
            for (const row of page.rows) {
                bytes += Buffer.byteLength(row.text, 'utf8') + 1;
                if (bytes > limit) {
                    if (!options.onTruncated) throw new RangeError('Document block exceeds reader budget');
                    options.onTruncated(); return parts.join('\n');
                }
                parts.push(row.text);
                if (row.line > block.startLine && !row.text.trimStart().startsWith('$') && !row.text.trimStart().startsWith('*')) records++;
                if (options.headerDataRecords && records >= options.headerDataRecords) return parts.join('\n');
            }
            if (page.complete) break;
            if (page.next <= offset) throw new Error('Document cursor did not advance');
            offset = page.next;
        }
        return parts.join('\n');
    };
    scanBlockLines = async (block: any, visit: any, token?: any, options: any = {}) => {
        if (!block.documentRevision) return scanBlockLinesFromDisk(block, visit, token, options);
        let offset = block.startLine, lineCount = 0, records = 0, keywordLineText = '';
        while (offset <= block.endLine) {
            const page = await this.read({ action: 'lines', filePath: block.filePath, revision: block.documentRevision,
                offset, endLine: block.endLine }, token);
            if (page.state !== 'live') return { complete: false, reason: page.state === 'stale'
                ? 'on-demand-file-changed' : 'on-demand-block-range-unavailable', lineCount };
            for (const row of page.rows) {
                if (options.endLine !== undefined && row.line > options.endLine) return { complete: true, lineCount, keywordLineText };
                if (row.line === block.startLine) { keywordLineText = row.text; continue; }
                await visit(row.text, row.line, { keywordLineText }); lineCount++;
                if (!row.text.trimStart().startsWith('$') && !row.text.trimStart().startsWith('*')) records++;
                if (options.dataRecordLimit && records >= options.dataRecordLimit) return { complete: true, lineCount, keywordLineText };
            }
            if (page.complete) break;
            if (page.next <= offset) throw new Error('Document cursor did not advance');
            offset = page.next;
        }
        return { complete: true, lineCount, keywordLineText };
    };
}
