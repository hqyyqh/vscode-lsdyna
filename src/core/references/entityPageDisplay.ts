import { EntityQueryCache } from './entityQueryCache';
const { createKeywordIdentityAccumulatorFactory } = require('../keywordDisplayIdentity');
const { readBlockText } = require('../scanner/blockReader');
const { throwIfCancellationRequested } = require('../scanner/scannerContracts');
const { runtimeDefinitionKeywords } = require('./onDemandDefinitionScanner');
const { indexedEntityDisplay } = require('./indexedEntityQuery');

/** Enrich only the returned page, using the worker's existing bounded cache. */
export async function populateEntityPageDisplay(snapshot: any, locations: any[], request: any,
    cache: EntityQueryCache, token: any) {
    const byFile = new Map<string, any[]>();
    for (const location of locations) {
        const rows = byFile.get(location.filePath) || [];
        rows.push(location); byFile.set(location.filePath, rows);
    }
    const definitions = runtimeDefinitionKeywords({ allowCandidate: false });
    for (const [file, rows] of byFile) {
        const index = snapshot.fileIndexes.get(file);
        if (!index) continue;
        const blocks = index.keywordBlocks || [], wanted = new Map<any, any[]>();
        for (const row of rows) {
            let low = 0, high = blocks.length - 1;
            while (low <= high) {
                const middle = (low + high) >>> 1;
                if (blocks[middle].startLine <= row.line) low = middle + 1; else high = middle - 1;
            }
            const block = blocks[high];
            if (!block || row.line > block.endLine) continue;
            const matches = wanted.get(block) || [];
            matches.push(row); wanted.set(block, matches);
        }
        const create = createKeywordIdentityAccumulatorFactory();
        for (const block of blocks) {
            if (block.keyword === '*KEYWORD') create(block);
            const matches = wanted.get(block);
            if (!matches) continue;
            throwIfCancellationRequested(token);
            const key = JSON.stringify(['page-display', file, index.sourceRevision, block.startLine]);
            let display = block.displayIdentity || cache.get(key);
            // Live blocks already carry display summaries from the editor's BlockIndex.
            // A missing optional summary must never trigger a read of a different disk version.
            if (!display && Number.isInteger(index.documentVersion)) continue;
            if (!display) {
                const accumulator = create(block);
                let truncated = false;
                // ponytail: optional display prefixes stop at 64 KiB; extend if real titles follow larger comment headers.
                const text = await readBlockText(block, 'utf8', { cancellationToken: token, maxBytes: 64 * 1024,
                    onTruncated: () => { truncated = true; } });
                const lines = text.split(/\r\n|\r|\n/).slice(1);
                if (truncated) lines.pop();
                for (const line of lines) {
                    if (accumulator.isCaptureComplete()) break;
                    accumulator.acceptLine(line);
                }
                display = accumulator.finish({ dataLineCount: block.dataLineCount });
                cache.set(key, display);
            }
            for (const row of matches) Object.assign(row, indexedEntityDisplay({ ...block, displayIdentity: display },
                row, request.id, request.targetKind, definitions));
        }
    }
}
