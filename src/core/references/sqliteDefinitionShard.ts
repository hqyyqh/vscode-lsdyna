import { EntityIndexStore, EntityIndexRecord } from '../cache/entityIndexStore';
import { entityFileRevision } from '../cache/entityFileRevision';
const { scanOnDemandDefinitions, scanBlockLinesFromDisk } = require('./onDemandDefinitionScanner');
const { throwIfCancellationRequested } = require('../scanner/scannerContracts');

/** Streams the existing semantic reader into bounded transactions without retaining all IDs in JS. */
export async function buildSqliteDefinitionShard(store: EntityIndexStore, key: string, revision: string,
    file: string, fileIndex: any, parser: string, options: any) {
    if (Number.isInteger(fileIndex.documentVersion)) throw new Error('Unsaved document cannot enter the disk index');
    const sourceRevision = await entityFileRevision(file);
    if (sourceRevision !== options.sourceRevision) throw new Error('Entity file index source revision is stale');
    const build = await store.begin(key, revision, options.cancellationToken);
    if (!build) return { state: 'busy' };
    let batch: EntityIndexRecord[] = [], bytes = 0, writeFailure: unknown;
    let templates: { key: string; payload: unknown }[] = [];
    const templateKeys = new Map<string, string>();
    let templateSequence = 0, templateKeyBytes = 0;
    const flush = async () => {
        if (!batch.length) return;
        try { await store.append(build, batch, options.cancellationToken, templates); }
        catch (error) { writeFailure = error; throw error; }
        batch = []; templates = []; bytes = 0;
    };
    let blockMetadata: { file: string; anchor: string; line: number; offset: number }[] = [];
    const flushBlocks = async () => {
        if (!blockMetadata.length) return;
        await store.metadata(build, { blocks: blockMetadata }, options.cancellationToken);
        blockMetadata = [];
    };
    try {
        await store.metadata(build, { files: [{ file, revision: sourceRevision, parser }] }, options.cancellationToken);
        const reader = options.scanBlockLines || scanBlockLinesFromDisk;
        const lookup = await scanOnDemandDefinitions({ ...options, fileIndexes: new Map([[file, fileIndex]]),
            collectAllIds: true, retainDefinitions: false,
            acceptDefinition: definition => {
                const context = JSON.stringify(definition.occurrencePath?.length ? definition.occurrencePath : definition.occurrenceId ?? '');
                let template = templateKeys.get(context);
                const { id, idRaw, idInput, parameterResolution, idLine, idStartChar, idEndChar, sourceId, effectiveId,
                    ...shared } = definition;
                if (!template) {
                    templateKeyBytes += context.length * 2 + 64;
                    if (templateKeyBytes > 128 * 1024) {
                        writeFailure = new Error('Entity definition context budget exhausted'); throw writeFailure;
                    }
                    template = String(++templateSequence); templateKeys.set(context, template);
                    templates.push({ key: template, payload: shared });
                    bytes += Buffer.byteLength(JSON.stringify(shared));
                }
                const record: EntityIndexRecord = { key: `${idLine}:${idStartChar}:${idEndChar}:${template}`,
                    kind: definition.targetKind, id: definition.id, role: 'definition', file,
                    block: `b:${definition.startLine}`, line: definition.idLine,
                    start: idStartChar, end: idEndChar, context: template, template,
                    payload: { id, idRaw, idInput, ...(parameterResolution ? { parameterResolution } : {}),
                        idLine, idStartChar, idEndChar, sourceId, effectiveId } };
                bytes += Buffer.byteLength(JSON.stringify(record));
                if (bytes > 512 * 1024) {
                    writeFailure = new Error('Entity definition context batch exceeds memory budget');
                    throw writeFailure;
                }
                batch.push(record);
                return true;
            },
            scanBlockLines: async (block, visit, token, readOptions) => {
                // Only blocks actually needed by this type belong in its persistent shard.
                blockMetadata.push({ file, anchor: `b:${block.startLine}`, line: block.startLine, offset: block.startOffset });
                if (blockMetadata.length >= 128) await flushBlocks();
                templateKeys.clear(); templateKeyBytes = 0;
                let renewed = Date.now();
                const result = await reader(block, async (...args) => {
                    visit(...args);
                    if (bytes >= 256 * 1024 || batch.length >= 512) await flush();
                    if (Date.now() - renewed > 5000) { await store.renew(build); renewed = Date.now(); }
                }, token, readOptions);
                return result;
            } });
        if (writeFailure) throw writeFailure;
        await flush();
        await flushBlocks();
        throwIfCancellationRequested(options.cancellationToken);
        if (sourceRevision !== await entityFileRevision(file)) throw new Error('Entity source changed during construction');
        if (lookup.state !== 'complete') { await store.abandon(build); return lookup; }
        await store.publish(build, { state: lookup.state, reasons: lookup.reasons }, options.cancellationToken);
        return { ...lookup, generation: build.generation };
    } catch (error) { await store.abandon(build).catch(() => {}); throw error; }
}
