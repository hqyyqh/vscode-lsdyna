import * as path from 'node:path';
import { createParameterLineScanner } from '../parser/parameterScanner';
import { classifyParameterKeyword, scanBareParameterReferences } from '../parser/parameterSyntax';
import { parameterBindingId, parameterQueryBudget, visibleParameters } from './visibleParameters';
const { parameterContextsForDocument } = require('./projectReferenceIndex');
const { scanBlockLinesFromDisk } = require('./onDemandDefinitionScanner');
const { throwIfCancellationRequested } = require('../scanner/scannerContracts');
const sameFile = (a: string, b: string) => process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

export async function parameterNavigation(index: any, fileIndexes: Map<string, any>, request: any,
    token?: any, scanBlockLines = scanBlockLinesFromDisk) {
    const { filePath, line, character, name, declaration, references, includeDeclaration } = request;
    const reasons = new Set<string>(index.completenessReasons || []);
    const selected = new Map<string, any>();
    const step = parameterQueryBudget(token);
    throwIfCancellationRequested(token);
    const contexts = parameterContextsForDocument(index, filePath);
    if (!contexts.length)
        return { items: [], reasons: ['parameter-context-unavailable'], incomplete: true, ambiguous: false };
    if (!references) {
        if (declaration) {
            for (const context of contexts) {
                await step();
                for (const reason of context.initialUncertaintyReasons || []) reasons.add(reason);
                for (const point of context.timeline || []) {
                    await step();
                    if (point.lineIndex > line) continue;
                    for (const reason of point.uncertaintyReasons || []) reasons.add(reason);
                    const binding = point.definitionBinding;
                    if (binding?.name === name && binding?.filePath && sameFile(binding.filePath, filePath) && binding.definitionLine === line &&
                        character >= binding.definitionStart && character < binding.definitionStart + binding.definitionLength)
                        selected.set(parameterBindingId(binding), binding);
                }
            }
        } else {
            const visible = await visibleParameters(index, filePath, line, character, token);
            for (const reason of visible.reasons) reasons.add(reason);
            for (const scope of visible.scopes) {
                await step();
                const binding = scope.get(name);
                if (parameterBindingId(binding) && Number.isInteger(binding.definitionStart) && Number.isInteger(binding.definitionLength))
                    selected.set(parameterBindingId(binding), binding);
                else reasons.add('parameter-definition-unavailable');
            }
        }
        if (!selected.size) reasons.add('parameter-definition-unavailable');
        // Definition navigation still requires a confirmed binding and complete context.
        if (reasons.size) return { items: [], reasons: [...reasons], incomplete: true, ambiguous: false };
    }
    const ambiguous = selected.size > 1;
    const items: any[] = [], seen = new Set<string>();
    const add = (file: string, at: number, start: number, end: number) => {
        const key = JSON.stringify([file, at, start, end]);
        if (seen.has(key)) return;
        if (items.length >= 1000) { reasons.add('parameter-reference-limit'); return; }
        seen.add(key); items.push({ filePath: file, line: at, startCharacter: start, endCharacter: end });
    };
    for (const binding of selected.values())
        add(binding.filePath, binding.definitionLine, binding.definitionStart, binding.definitionStart + binding.definitionLength);
    if (!references) return { items, reasons: [...reasons], incomplete: reasons.size > 0, ambiguous };

    // Reference search is lexical within the shared physical file set, not binding ownership.
    const names = new Set<string>([name]);
    let bytes = 0, stopped = false;
    try {
    for (const [file, fileIndex] of fileIndexes) {
        await step();
        if (!Array.isArray(fileIndex.keywordBlocks)) { reasons.add('parameter-block-index-unavailable'); continue; }
        const scopes = parameterContextsForDocument(index, file);
        if (!scopes.length) { reasons.add('parameter-context-unavailable'); continue; }
        const formats = new Set(scopes.map(scope => scope.inputFormatMode || 'standard'));
        if (formats.size !== 1) { reasons.add('parameter-input-format-ambiguous'); continue; }
        const scan = createParameterLineScanner(false);
        scan(formats.has('long') ? '*KEYWORD LONG=Y' : '*KEYWORD', -1);
        for (const block of fileIndex.keywordBlocks || []) {
            await step();
            scan(block.rawKeyword || block.keyword, block.startLine);
            const parameterBlock = !!classifyParameterKeyword(block.rawKeyword || block.keyword);
            // Only shared, versioned scan facts may prove a block has no candidates.
            if (!parameterBlock && block.parameterCandidates === false &&
                !Number.isInteger(fileIndex.documentVersion) && !block.documentRevision) continue;
            if (Number.isInteger(fileIndex.documentVersion) && scanBlockLines === scanBlockLinesFromDisk) {
                reasons.add('parameter-live-source-unavailable'); break;
            }
            let read;
            try {
                read = await scanBlockLines({ ...block, filePath: file }, async (text: string, at: number) => {
                    const lineBytes = Buffer.byteLength(text, 'utf8'); bytes += lineBytes + 1;
                    if (bytes > 64 * 1024 * 1024 || lineBytes > 64 * 1024 || items.length >= 1000) {
                        stopped = true; reasons.add('parameter-reference-limit'); throw new RangeError('Parameter reference limit');
                    }
                    if (!parameterBlock && !text.includes(name)) return;
                    try { await step(); } catch (error) {
                        if (error.code === 'PARAMETER_QUERY_BUDGET') { stopped = true; reasons.add('parameter-reference-limit'); }
                        throw error;
                    }
                    const symbols = scan(text, at);
                    if (includeDeclaration) for (const definition of symbols.definitions) {
                        if (definition.normalizedName === name)
                            add(file, at, definition.startChar, definition.startChar + definition.length);
                    }
                    const refs = [...symbols.references, ...symbols.expressionSegments.flatMap(segment =>
                        scanBareParameterReferences(segment, names))];
                    for (const ref of refs) {
                        if (ref.name !== name) continue;
                        add(file, at, ref.startChar, ref.startChar + ref.length);
                    }
                }, token);
            } catch (error) { if (!stopped) throw error; }
            throwIfCancellationRequested(token);
            if (stopped) break;
            if (!read?.complete) reasons.add(read?.reason || 'parameter-reference-read-incomplete');
        }
        if (stopped) break;
    }
    } catch (error) {
        if (error.code !== 'PARAMETER_QUERY_BUDGET') throw error;
        reasons.add('parameter-reference-limit');
    }
    return { items, reasons: [...reasons], incomplete: reasons.size > 0, ambiguous };
}
