/** Keyword Manager model and preview service. VS Code lifecycle stays in the entry point. */
const vscode = require('vscode');
const { groupConditionalAdvice, nativeBranchSummary } = require('../../core/semantics/conditionalPresentation');
const { nativeConditionalBinding } = require('../../core/semantics/nativeConditionalLayout');
const path = require('path');
const keywordSchema = require('../../core/keywordSchema');
const cardCellModel = require('../../core/edit/cardCellModel');
const { classifyKeywordLine, isKeywordCommentLine } = require('../../core/parser/keywordLine');
const i18n = require('../../core/i18n');
const LARGE_DOCUMENT_LINE_THRESHOLD = 100000;
const { generateCommentLine } = require('../../core/completion/fieldComment');
const {
    keywordInputFormat,
} = require('../../core/parser/inputFormat');
const { classifyOpaqueCommentDirective } = require('../../core/parser/opaqueCommentRange');
const {
    collectBlocksFromLineReader,
} = require('../../core/parser/blockScanner');
const nodeCrypto = require('crypto');
const { resolveKeywordCategory } = require('../../core/keywordCategory');
const {
    getCatalogInputFormCatalogV4,
} = require("../../core/semantics/catalogInputFormCatalogV4");
const {
    loadKeywordOptionGrammarRuntime,
} = require('../../core/options/keywordOptionGrammarCatalog');
const {
    OPTION_SWITCH_MAX_BYTES,
    planOptionSwitch,
    planProvisionalOptionSwitch,
} = require('../../core/options/optionSwitchPlanner');
const { evaluateOptionGrammar } = require('../../core/options/optionGrammarEvaluator');
const { evaluatePredicate } = require('../../core/semantics/predicateEvaluator');
const { getLegalSelectorValues, resolveFormRulePriorScore } = require("../../core/semantics/catalogPriorRules");
const keywordRecordSerializer = require('../../core/edit/keywordRecordSerializer');
const { parseNumericInput } = require('../../core/references/referenceInputValue');
const { NATIVE_FILE_SOURCE } = require("../../core/semantics/catalogNativeFileLayout");

export function createKeywordManagerServices(host: {
    getKeywordSemanticAdviceForDocument?: (...args: any[]) => any;
    readyCardEditBlockIndex: (...args: any[]) => any;
    isKeywordLineText: (...args: any[]) => any;
    cardCommentLabelCase: (...args: any[]) => any;
    documentUriIdentity: (...args: any[]) => any;
    nativeParameterContextForDocument: (...args: any[]) => any;
    documentGlobalInputFormat: (...args: any[]) => any;
    legacyOptionRecord: (...args: any[]) => any;
    getFieldData: (...args: any[]) => any;
    lookupOperationalKeywordOptionGrammar: (...args: any[]) => any;
    isLsdynaFile: (...args: any[]) => any;
    isActiveLsdynaSemanticLocation: (...args: any[]) => any;
    findKeywordLineForLine: (...args: any[]) => any;
}) {
    const {
        readyCardEditBlockIndex,
        isKeywordLineText,
        cardCommentLabelCase,
        documentUriIdentity,
        nativeParameterContextForDocument,
        documentGlobalInputFormat,
        legacyOptionRecord,
        getFieldData,
        lookupOperationalKeywordOptionGrammar,
        isLsdynaFile,
        isActiveLsdynaSemanticLocation,
        findKeywordLineForLine,
    } = host;

    function blockedKeywordOptionSwitchPlan(currentKeyword, targetKeyword, reason, metadata: any = {}) {
        return {
            status: 'blocked', reason, blockers: [reason], currentKeyword, targetKeyword,
            documentVersion: metadata.documentVersion ?? null,
            uri: metadata.uri || null,
            keywordLine: metadata.keywordLine || 0,
            sourceLockIdentity: metadata.sourceLockIdentity || null,
            replacementRecords: [], migratedFields: [], emptyTargetFields: [],
            discardedFields: [], commentChanges: [], estimatedBytes: 0,
            applicationMode: metadata.applicationMode || 'layout-migration',
            requiresLossConfirmation: false,
        };
    }

    const OPTION_SWITCH_MAX_PHYSICAL_LINES = 512;

    const OPTION_SWITCH_MAX_DATA_RECORDS = 256;

    function collectOptionSwitchBlock(document, keywordLine, options: any = {}) {
        const blockIndex = options.blockIndex !== undefined
            ? options.blockIndex
            : readyCardEditBlockIndex(document, options.keywordIndexProvider);
        const indexed = blockIndex?.lineCount === document.lineCount
            ? blockIndex.findBlockAtLine?.(keywordLine)
            : null;
        const indexedBlock = indexed?.startLine === keywordLine && Number.isInteger(indexed.endLine) &&
            indexed.endLine >= keywordLine && indexed.endLine < document.lineCount
            ? indexed : null;
        if (indexedBlock && (indexedBlock.endLine - keywordLine > OPTION_SWITCH_MAX_PHYSICAL_LINES ||
            Number(indexedBlock.dataLineCount) > OPTION_SWITCH_MAX_DATA_RECORDS)) {
            return {
                status: 'blocked', reason: 'edit-budget-exceeded', blockEnd: keywordLine + 1,
                indexedBlockEnd: indexedBlock.endLine + 1, records: [], trailingComments: [],
            };
        }

        const scanEnd = indexedBlock
            ? indexedBlock.endLine + 1
            : Math.min(document.lineCount, keywordLine + OPTION_SWITCH_MAX_PHYSICAL_LINES + 2);
        const records = [];
        let comments = [];
        let estimatedBytes = Buffer.byteLength(String(document.lineAt(keywordLine).text || ''), 'utf8');
        for (let line = keywordLine + 1; line < scanEnd; line++) {
            const text = String(document.lineAt(line).text || '');
            if (!indexedBlock && isKeywordLineText(text)) {
                return { status: 'ready', blockEnd: line, records, trailingComments: comments, estimatedBytes };
            }
            if (!indexedBlock && line - keywordLine > OPTION_SWITCH_MAX_PHYSICAL_LINES) {
                return {
                    status: 'blocked', reason: 'edit-budget-exceeded', blockEnd: keywordLine + 1,
                    records: [], trailingComments: [],
                };
            }
            estimatedBytes += Buffer.byteLength(text, 'utf8') + 2;
            if (estimatedBytes > OPTION_SWITCH_MAX_BYTES) {
                return {
                    status: 'blocked', reason: 'edit-budget-exceeded', blockEnd: keywordLine + 1,
                    records: [], trailingComments: [],
                };
            }
            if (isKeywordCommentLine(text)) {
                comments.push(text);
                continue;
            }
            records.push({ text, comments });
            comments = [];
            if (records.length > OPTION_SWITCH_MAX_DATA_RECORDS) {
                return {
                    status: 'blocked', reason: 'edit-budget-exceeded', blockEnd: keywordLine + 1,
                    records: [], trailingComments: [],
                };
            }
        }
        if (indexedBlock || scanEnd === document.lineCount) {
            return { status: 'ready', blockEnd: scanEnd, records, trailingComments: comments, estimatedBytes };
        }
        return {
            status: 'blocked', reason: 'edit-budget-exceeded', blockEnd: keywordLine + 1,
            records: [], trailingComments: [],
        };
    }

    function keywordOptionTarget(grammar, spelling) {
        const normalized = String(spelling || '').toUpperCase().replace(/[+%\-]$/, '');
        return (grammar?.targets || []).find(target =>
            String(target.spelling || '').toUpperCase() === normalized) || null;
    }

    function keywordOptionLayoutProfile(grammar, spelling, postCount = 0) {
        const target = keywordOptionTarget(grammar, spelling);
        if (!target) return null;
        const matches = (target.layouts || []).filter(candidate => candidate.postCount === postCount);
        return matches.length === 1 ? matches[0].layout : null;
    }

    function keywordOptionLayoutCandidate(grammar, spelling, postCount = 0) {
        const target = keywordOptionTarget(grammar, spelling);
        if (!target) return null;
        const matches = (target.layouts || []).filter(candidate => candidate.postCount === postCount);
        return matches.length === 1 ? matches[0] : null;
    }

    function optionSwitchCardFromRecord(record) {
        return (record.fields || []).map(field => ({
            n: field.name, t: field.type, p: field.position, w: field.width,
        }));
    }

    function optionSwitchCommentAnalysis(text, records) {
        const cards = records.map(optionSwitchCardFromRecord);
        const analysis = keywordSchema.analyzeCardCommentHeader(text, cards);
        if (!analysis) return null;
        return {
            recordIndex: analysis.cardIndex - 1,
            style: analysis.style,
            labelCase: cardCommentLabelCase(text),
            exactMatch: analysis.exactMatch,
            possibleVersionDrift: analysis.possibleVersionDrift,
        };
    }

    function optionSwitchCommentLine(record, style, labelCase) {
        return generateCommentLine(optionSwitchCardFromRecord(record), style, labelCase);
    }

    function optionSwitchSourceRanges(text: string, record, inputFormat: string) {
        const requested = inputFormat === 'long' ? 'long' : inputFormat === 'i10' ? 'i10' : 'standard';
        const format = keywordRecordSerializer.detectRecordFormat(text, requested, record.fields);
        const ranges = keywordRecordSerializer.formattedReadRanges(record.fields, text, format);
        if (ranges.length !== record.fields.length) return null;
        // Commas separate verified fields; extra comma fields have no coverage.
        return format === 'comma' ? [...ranges, ...Array.from(text.matchAll(/,/g), match =>
            ({ start: match.index, end: match.index + 1 }))] : ranges;
    }

    function keywordSpellingFromLine(text) {
        const classification = classifyKeywordLine(String(text || ''));
        if (!classification.isKeyword) return '';
        return classification.normalizedKeyword.toUpperCase().replace(/[+%\-]$/, '');
    }

    function keywordOptionBlockSha256(document, keywordLine, blockEnd) {
        if (!document || !Number.isInteger(keywordLine) || !Number.isInteger(blockEnd) ||
            keywordLine < 0 || blockEnd <= keywordLine || blockEnd > document.lineCount) return null;
        const lines = [];
        for (let line = keywordLine; line < blockEnd; line++) lines.push(String(document.lineAt(line).text || ''));
        return nodeCrypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
    }

    function keywordOptionsEditorForModel(model, preferred = vscode.window.activeTextEditor) {
        if (!model?.uri) return null;
        const matchesDocument = document => document && !document.isClosed &&
            (!model.sourceDocument || document === model.sourceDocument) && documentUriIdentity(document) === model.uri;
        const matches = editor => matchesDocument(editor?.document);
        if (matches(preferred)) return preferred;
        const visible = (vscode.window.visibleTextEditors || []).find(matches);
        if (visible) return visible;
        const document = (vscode.workspace.textDocuments || []).find(matchesDocument);
        return document ? {
            document,
            selection: { active: new vscode.Position(model.keywordLine || 0, 0) },
        } : null;
    }

    async function locateKeywordManagerSource(model, editor = keywordOptionsEditorForModel(model)) {
        if (!model || !editor) return false;
        try {
            const visible = (vscode.window.visibleTextEditors || []).find(candidate =>
                documentUriIdentity(candidate.document) === model.uri);
            const sourceEditor = typeof vscode.window.showTextDocument === 'function'
                ? await vscode.window.showTextDocument(editor.document, {
                    viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One,
                    preserveFocus: false,
                    preview: false,
                })
                : visible || editor;
            const diagnostic = keywordManagerLayoutDiagnostics(model)[0];
            const line = diagnostic?.controls?.find(control => control.fieldId === model.selectedFieldId)?.line
                ?? diagnostic?.line ?? model.keywordLine;
            const position = new vscode.Position(Math.min(Math.max(0, line), editor.document.lineCount - 1), 0);
            sourceEditor.selection = new vscode.Selection(position, position);
            sourceEditor.revealRange?.(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenterIfOutsideViewport,
            );
            return true;
        } catch (_error) {
            return false;
        }
    }

    async function openKeywordManagerManual(model) {
        if (!model?.targetKeyword) return false;
        try {
            await vscode.commands.executeCommand('extension.manual.pickPackChapter', model.targetKeyword, 'reader');
            return true;
        } catch (_error) {
            return false;
        }
    }

    function keywordManagerDisplayName(identity) {
        if (!identity) return '';
        if (identity.title) return String(identity.title);
        if (identity.identity) return `${identity.identity.field} ${identity.identity.value}`;
        if (identity.missingIdentity) return `${identity.missingIdentity.field} ${i18n.get(
            identity.missingIdentity.status === 'empty' ? 'keywordManagerIdentityEmpty' : 'keywordManagerIdentityUnresolved')}`;
        if (Array.isArray(identity.signature)) {
            return identity.signature.map(item => `${item.field} ${item.value}`).join(' ↔ ');
        }
        return '';
    }

    function keywordManagerReadonlyUri(uri) {
        return !!uri?.scheme && typeof vscode.workspace.fs?.isWritableFileSystem === 'function' &&
            vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false;
    }

    function keywordManagerInstanceFileState(document) {
        const uri = documentUriIdentity(document);
        const filePath = String(document?.uri?.fsPath || '');
        return {
            uri,
            filePath,
            fileName: filePath ? path.basename(filePath) : '',
            dirty: document?.isDirty === true,
            readonly: keywordManagerReadonlyUri(document?.uri),
        };
    }

    const { nativeSpellingBinding, nativeFileCatalogKeyword, nativeFileLayoutKind: nativeReaderLayoutKind, nativeFileLayoutCards, readNativeFileField, selectVerifiedSourceRecords, nativeBatchFixedBinding } = require("../../core/semantics/catalogNativeFileLayout");
    const { contactThermalBinding, contactThermalSource, contactThermalAllowed, contactThermalRecordDefinition, equivalentContactThermalSpelling, expandContactThermalRecords } = require('../../core/semantics/contactThermal');

    // Verified descriptor grammars use the existing record-selection and instance paths.
    function nativeFileLayoutKind(rule, keyword) {
        const kind = nativeReaderLayoutKind(rule?.nativeForm || rule, keyword);
        return kind === 'verified-source-records' ? null : kind;
    }

    function keywordManagerNativeFileSelection(document, keywordLine, rule, records, drafts = {}, recordDrafts = {}, targetKeyword = null) {
        const keyword = keywordSpellingFromLine(document.lineAt(keywordLine).text);
        const canonical = keyword.replace(/^\*/, '');
        let physical = keywordLine + 1;
        const recordLines = records.map(record => { physical += (record.comments || []).length; return physical++; });
        const parameters =
            records.some(record => record.text.includes('&')) || [...Object.values(drafts), ...Object.values(recordDrafts)].some(value => String(value).includes('&'))
                ? nativeParameterContextForDocument(document) : undefined;
        const reading = require('../../core/semantics/nativeFileReadContext').nativeFileReadContext(
            rule.nativeForm || rule, document.lineAt(keywordLine).text, records.map(record => record.text),
            documentGlobalInputFormat(document), recordLines, parameters);
        if (!reading.kind) return null;
        const { read, cards, input } = reading;
        const selection = reading.select(false,
            (record, field, value) => {
                const key = reading.kind === 'conditional-sequence' ? record.key.replace(/^instance:0:/, '') : record.key;
                const id = `lspp-input:${canonical}:${key}`;
                const fieldId = `${id}:field:${field}`;
                if (Object.prototype.hasOwnProperty.call(drafts, fieldId)) return String(drafts[fieldId] ?? '');
                if (Object.prototype.hasOwnProperty.call(recordDrafts, id)) return read(recordDrafts[id], record.cardIndex, field);
                return value;
            }, /_TITLE$/.test(targetKeyword || canonical),
            (record, text) => {
                const key = reading.kind === 'conditional-sequence' ? record.key.replace(/^instance:0:/, '') : record.key;
                const id = `lspp-input:${canonical}:${key}`;
                let value = Object.prototype.hasOwnProperty.call(recordDrafts, id) ? String(recordDrafts[id] ?? '') : text;
                const fields = cards.get(record.cardIndex)?.fields || [];
                for (let index = 0; index < fields.length; index++) {
                    const fieldId = `${id}:field:${index}`;
                    if (Object.prototype.hasOwnProperty.call(drafts, fieldId)) value = keywordRecordSerializer.writeRecordField(
                        value, fields, index, String(drafts[fieldId] ?? ''), value.includes(',') ? 'comma' : input);
                }
                return value;
            });
        // Read-only identities still belong in the field view and instance directory.
        return selection?.current ? { ...selection, writeCompatible: reading.writeCompatible(selection.current) } : selection;
    }

    function keywordManagerNativeInstanceCounts(grammar, count) {
        if (grammar?.repeatResolution === 'observed-single-instance-only' && count === grammar.recordCount) return [count];
        if (grammar?.repeatResolution === 'observed-single-instance-only' && Array.isArray(grammar.sourceCardCounts)) {
            if (!grammar.sourceCardCounts.includes(count)) return null;
            if (count === grammar.recordCount) return [count];
            const optional = grammar.optionalTrailingRecords;
            return optional?.scope === 'end-of-keyword-block-only' &&
                JSON.stringify(optional.cardIndexes) === JSON.stringify(Array.from({ length: grammar.recordCount - count }, (_, i) => count + i + 1))
                ? [count] : null;
        }
        if (grammar?.repeatResolution !== 'verified-fixed-record-instances' ||
            !Number.isInteger(grammar.recordsPerInstance) || grammar.recordsPerInstance < 1) return null;
        const size = grammar.recordsPerInstance;
        const counts = Array(Math.floor(count / size)).fill(size);
        const remainder = count % size;
        if (remainder) {
            const optional = grammar.optionalTrailingRecords;
            if (!grammar.sourceCardCounts?.includes(remainder) || optional?.scope !== 'end-of-keyword-block-only' ||
                JSON.stringify(optional.cardIndexes) !== JSON.stringify(Array.from({ length: size - remainder }, (_, i) => remainder + i + 1))) return null;
            counts.push(remainder);
        }
        return counts;
    }

    function keywordManagerExpandNativeInstances(document, instance, selectedLine, onParameterDependency = () => {}) {
        // Project entries can describe an unopened Include.
        if (!Number.isInteger(document?.lineCount) || typeof document.lineAt !== 'function') return [instance];
        if (instance.endLine - instance.line > OPTION_SWITCH_MAX_PHYSICAL_LINES ||
            instance.dataLineCount > OPTION_SWITCH_MAX_DATA_RECORDS) return [instance];
        const forms = keywordManagerCatalogNativeFormRules(instance.keyword);
        if (forms.length !== 1) return [instance];
        // Conditional sequences are one keyword block, including optional tails.
        if (nativeConditionalBinding(instance.keyword)) return [instance];
        const fileKind = nativeFileLayoutKind(forms[0], instance.keyword);
        if (!fileKind && forms[0].nativeDescriptorExtent?.consumption !== 'static-descriptor-records') return [instance];
        const grammar = forms[0].occurrenceGrammar;
        if (!fileKind && grammar?.sourceSha256 !== forms[0].catalogSource?.datasetSha256) return [instance];
        const block = collectOptionSwitchBlock(document, instance.line);
        if (block.status !== 'ready') return [instance];
        if (fileKind && block.records.some(record => record.text.includes('&'))) onParameterDependency();
        const counts = fileKind ? keywordManagerNativeFileSelection(document, instance.line, forms[0], block.records)?.counts :
            keywordManagerNativeInstanceCounts(grammar, block.records.length);
        if (!counts) return [instance];
        let physical = instance.line + 1;
        const selectionStarts: number[] = [];
        const lines = block.records.map(record => {
            selectionStarts.push(physical);
            physical += (record.comments || []).length;
            return physical++;
        });
        let start = 0;
        return counts.map((count, ordinal) => {
            const first = start; start += count;
            const line = lines[first], endLine = lines[start - 1];
            return { ...instance, instanceId: `${instance.uri}:${instance.line}:record:${first}`,
                line, endLine, headerLine: instance.line, recordStartIndex: first, dataLineCount: count,
                selectionStartLine: ordinal === 0 ? instance.line : selectionStarts[first],
                selected: selectedLine >= (ordinal === 0 ? instance.line : selectionStarts[first]) && selectedLine <= endLine };
        });
    }

    const keywordManagerInstanceDirectories = new WeakMap<object, {
        version: number; lineCount: number; blockIndex: any; instances: any[]; parameterContext?: any;
    }>();

    function cachedKeywordManagerDirectory(document, blockIndex) {
        const usableIndex = blockIndex?.lineCount === document.lineCount ? blockIndex : null;
        const cached = keywordManagerInstanceDirectories.get(document);
        return cached && cached.version === document.version && cached.lineCount === document.lineCount &&
            cached.blockIndex === usableIndex && (!cached.parameterContext ||
                cached.parameterContext === nativeParameterContextForDocument(document)) ? cached : null;
    }

    function keywordManagerTypeKey(keyword) {
        const normalized = String(keyword || '').trim().replace(/^\*/, '').toUpperCase();
        return keywordSchema.lookupKeywordSchema(normalized)?.canonicalName || normalized;
    }

    function keywordManagerNativeIdentitySource(document, instance) {
        const forms = keywordManagerCatalogNativeFormRules(instance.keyword);
        if (!forms.length) return null;
        if (forms.length !== 1 || instance.endLine - instance.line > OPTION_SWITCH_MAX_PHYSICAL_LINES ||
            instance.dataLineCount > OPTION_SWITCH_MAX_DATA_RECORDS) return { unverified: true };
        const block = collectOptionSwitchBlock(document, instance.line);
        if (block.status !== 'ready') return { unverified: true };
        const rows = block.records.map(record => record.text);
        let physical = instance.line + 1;
        const recordLines = block.records.map(record => { physical += (record.comments || []).length; return physical++; });
        const reading = require('../../core/semantics/nativeFileReadContext').nativeFileReadContext(
            forms[0].nativeForm || forms[0], document.lineAt(instance.line).text, rows, documentGlobalInputFormat(document),
            recordLines, nativeParameterContextForDocument(document));
        const records = reading.select()?.current;
        return records?.length === rows.length ? { rows, reading, records } : { unverified: true };
    }

    function keywordManagerSourceIdentity(document, instance, nativeSource = null) {
        if (nativeSource?.unverified) return { typeKey: keywordManagerTypeKey(instance.keyword), displayName: '', summary: [] };
        const { createKeywordIdentityAccumulator, summarizeKeywordIdentity, compactText } = require('../../core/keywordDisplayIdentity');
        const input = keywordInputFormat(document.lineAt(instance.headerLine ?? instance.line).text,
            documentGlobalInputFormat(document));
        const reader = createKeywordIdentityAccumulator(instance.keyword, {
            managerSummary: true, longFormat: input === 'long', percentFormat: input === 'i10',
        });
        for (let line = instance.headerLine !== undefined ? instance.line : instance.line + 1;
            line <= Math.min(instance.endLine, (instance.headerLine ?? instance.line) + 256) && !reader.isCaptureComplete(); line++) reader.acceptLine(document.lineAt(line).text);
        let identity = reader.finish({ dataLineCount: instance.dataLineCount });
        if (nativeSource) {
            const { rows, reading, records } = nativeSource;
            const first = instance.recordStartIndex ?? 0;
            const count = instance.recordStartIndex !== undefined ? instance.dataLineCount : rows.length;
            const values = [];
            let bytes = 0;
            for (let index = first; index < Math.min(rows.length, first + count, first + 32); index++) {
                bytes += Buffer.byteLength(rows[index], 'utf8');
                if (bytes > 8192) break;
                const cardIndex = records[index].cardIndex;
                if (cardIndex === 0 && /_TITLE$/.test(instance.keyword) && !reading.cards.has(0)) {
                    values.push({ name: 'TITLE', value: compactText(rows[index]), cardIndex: 1, fieldIndex: 0 });
                }
                for (const [fieldIndex, field] of (reading.cards.get(cardIndex)?.fields || []).entries()) {
                    const value = compactText(reading.read(rows[index], cardIndex, fieldIndex));
                    if (value) values.push({ name: String(field.name || '').trim().toUpperCase(),
                        value, cardIndex: cardIndex + 1, fieldIndex });
                }
            }
            identity = summarizeKeywordIdentity(instance.keyword, [], {
                managerSummary: true, sourceValues: values, dataLineCount: instance.dataLineCount,
            });
        }
        return { typeKey: keywordManagerTypeKey(instance.keyword), title: identity.title,
            identity: identity.identity, summary: identity.summary || identity.signature?.slice(0, 2) || [],
            displayName: keywordManagerDisplayName(identity) };
    }

    function keywordManagerInstances(document, selectedLine, blockIndex = readyCardEditBlockIndex(document), selectedBlock = null) {
        if (!document) return [];
        const fileState = keywordManagerInstanceFileState(document);
        const usableIndex = blockIndex?.lineCount === document.lineCount ? blockIndex : null;
        if (!usableIndex && document.lineCount > LARGE_DOCUMENT_LINE_THRESHOLD) return [];
        const project = instances => {
            const selected = instances.find(instance => selectedLine >= (instance.selectionStartLine ?? instance.line) && selectedLine <= instance.endLine);
            if (!selected) return [];
            return instances.filter(instance => instance.typeKey === selected.typeKey).map(({ selectionStartLine, ...instance }) => ({
            ...instance, ...fileState,
            selected: selectedLine >= (selectionStartLine ?? instance.line) && selectedLine <= instance.endLine,
            editLevel: 'view-only', reason: 'select-instance-to-evaluate',
            message: i18n.get('keywordManagerReasonSelectInstance'),
        }));
        };
        const cached = cachedKeywordManagerDirectory(document, usableIndex);
        if (cached) return project(cached.instances);
        const iterator = buildKeywordManagerInstanceDirectory(document, usableIndex, selectedBlock ? [selectedBlock] : null);
        let next = iterator.next();
        while (!next.done) next = iterator.next();
        if (!selectedBlock) keywordManagerInstanceDirectories.set(document, next.value);
        return project(next.value.instances);
    }

    function* buildKeywordManagerInstanceDirectory(document, usableIndex, selectedBlocks = null) {
        const blocks = selectedBlocks || (usableIndex
            ? usableIndex.getOccurrences()
            : collectBlocksFromLineReader(document.lineCount, line => document.lineAt(line).text));
        let parameterDependent = false;
        const instances = [];
        for (const block of blocks) {
            const keyword = `*${String(block.keyword || '').replace(/^\*/, '')}`.toUpperCase();
            yield keyword;
            const category = resolveKeywordCategory(keyword).primaryCategory;
            const startLine = Number(block.startLine);
            const endLine = Number(block.endLine);
            const instance = {
                instanceId: `${documentUriIdentity(document)}:${startLine}`,
                uri: documentUriIdentity(document),
                keyword,
                line: startLine,
                endLine,
                dataLineCount: Number(block.dataLineCount) || 0,
                occurrenceCount: 1,
                category,
                displayName: keywordManagerDisplayName(block.displayIdentity),
            };
            const expanded = keywordManagerExpandNativeInstances(document, instance, -1,
                () => { parameterDependent = true; });
            const nativeSource = keywordManagerNativeIdentitySource(document, instance);
            for (const { selected, ...item } of expanded) instances.push({ ...item,
                ...(nativeSource?.unverified ? keywordManagerSourceIdentity(document, item, nativeSource) : item.endLine - startLine > OPTION_SWITCH_MAX_PHYSICAL_LINES ? {
                    typeKey: keywordManagerTypeKey(keyword), title: block.displayIdentity?.title,
                    identity: block.displayIdentity?.identity, summary: block.displayIdentity?.signature?.slice(0, 2) || [],
                } : keywordManagerSourceIdentity(document, item, nativeSource)) });
        }
        const counts = new Map();
        for (const instance of instances) counts.set(instance.typeKey, (counts.get(instance.typeKey) || 0) + 1);
        for (const instance of instances) instance.occurrenceCount = counts.get(instance.typeKey) || 1;
        return { version: document.version, lineCount: document.lineCount,
            blockIndex: usableIndex, instances,
            parameterContext: parameterDependent ? nativeParameterContextForDocument(document) : undefined };
    }

    async function prepareKeywordManagerInstances(document, blockIndex, isCurrent = () => true) {
        await require('../../core/keywordSchema').prepareKeywordSchema();
        if (!document || document.isClosed || !isCurrent()) return false;
        const usableIndex = blockIndex?.lineCount === document.lineCount ? blockIndex : null;
        if (!usableIndex && document.lineCount > LARGE_DOCUMENT_LINE_THRESHOLD) return false;
        const version = document.version, parameterContext = nativeParameterContextForDocument(document);
        const current = () => !document.isClosed && document.version === version && isCurrent();
        const cached = keywordManagerInstanceDirectories.get(document);
        if (cached && cached.version === version && cached.lineCount === document.lineCount &&
            cached.blockIndex === usableIndex && (!cached.parameterContext || cached.parameterContext === parameterContext)) return true;
        const iterator = buildKeywordManagerInstanceDirectory(document, usableIndex);
        const catalog = getCatalogInputFormCatalogV4({ allowUnaudited: isKeywordManagerUnauditedCatalogAllowed() });
        let started = performance.now(), next;
        do {
            if (!current()) return false;
            next = iterator.next();
            if (!next.done) {
                try { await catalog.prepareKeyword(next.value); }
                catch { /* The normal model path reports catalog failures without authorizing writes. */ }
            }
            if (performance.now() - started >= 16) {
                await new Promise(resolve => setTimeout(resolve, 0));
                started = performance.now();
            }
        } while (!next.done);
        if (!current() || (next.value.parameterContext &&
            next.value.parameterContext !== parameterContext)) return false;
        keywordManagerInstanceDirectories.set(document, next.value);
        // Keep final model construction out of the last catalog decoding turn.
        await new Promise(resolve => setTimeout(resolve, 0));
        return current();
    }

    function completeKeywordManagerInstances(model, document, blockIndex) {
        if (!model || model.stale || document.isClosed ||
            model.uri !== documentUriIdentity(document) || model.session?.documentVersion !== document.version ||
            !cachedKeywordManagerDirectory(document, blockIndex)) return false;
        const instances = keywordManagerInstances(document, model.managerSelectionLine, blockIndex);
        const selected = instances.find(instance => instance.instanceId === model.selectedInstanceId);
        if (!selected) return false;
        const previous = model.managerInstances.find(instance => instance.instanceId === model.selectedInstanceId);
        if (previous) Object.assign(selected, { editLevel: previous.editLevel, reason: previous.reason, message: previous.message });
        model.managerInstances = instances;
        model.directoryStatus = 'ready';
        return true;
    }

    let keywordManagerCatalogCatalogFailure = '';
    let keywordManagerModelForms: WeakMap<object, Map<string, any>> | null = null;

    function isKeywordManagerUnauditedCatalogAllowed(): boolean {
        if (process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG === '1') return true;
        try {
            const config = vscode.workspace.getConfiguration('lsdyna');
            return Boolean(config.get('keywordManager.allowUnauditedCatalog', false));
        } catch {
            return false;
        }
    }

    function keywordManagerCatalogCatalogForm(keyword, fresh = false) {
        const allowUnaudited = isKeywordManagerUnauditedCatalogAllowed();
        try {
            const catalog = getCatalogInputFormCatalogV4({ allowUnaudited });
            const forms = fresh ? undefined : keywordManagerModelForms?.get(catalog);
            if (forms?.has(keyword)) return forms.get(keyword);
            const form = catalog.resolveFormForKeyword(keyword);
            if (form && !fresh && keywordManagerModelForms) {
                const entries = forms || new Map();
                entries.set(keyword, form);
                keywordManagerModelForms.set(catalog, entries);
            }
            return form;
        } catch (error) {
            keywordManagerCatalogCatalogFailure = (error instanceof Error ? error.message : String(error)) || 'Field catalog loading failed';
            return null;
        }
    }

    function keywordManagerCatalogAllowsWrite(keyword) {
        const source = keywordManagerCatalogCatalogForm(keyword, true)?.source;
        return source?.datasetSha256 === NATIVE_FILE_SOURCE &&
            source.conservationSatisfied === true && !source.isUnauditedDiagnostic;
    }

    function keywordManagerCatalogRules(keyword, referenceKey) {
        const form = keywordManagerCatalogCatalogForm(keyword);
        const ruleIds = Array.isArray(form?.reference?.[referenceKey]) ? form.reference[referenceKey] : [];
        return ruleIds.map(ruleId => ({
            ...form.rules[ruleId],
            catalogRuleId: ruleId,
            catalogSource: form.source,
            catalogKeyword: form.keyword,
        }));
    }

    function keywordManagerCatalogFormFingerprint(rule) {
        return JSON.stringify((rule?.cards || []).map(card => ({
            cardIndex: Number(card.cardIndex),
            fields: (card.fields || []).map(field => ({
                name: String(field.name || ''),
                type: String(field.type ?? ''),
                position: Number(field.position),
                width: Number(field.width),
                choices: (field.choices || []).map(String),
                defaultValue: field.defaultValue == null ? null : String(field.defaultValue),
            })),
        })));
    }

    function keywordManagerCatalogNativeFormRules(keyword) {
        const batch = nativeBatchFixedBinding(keyword);
        return keywordManagerCatalogRules(nativeFileCatalogKeyword(keyword), 'formRuleIds').filter(rule => !batch || rule.cardSetId === batch.cardSetId).map(rule => {
            const cards = nativeFileLayoutCards(rule, keyword);
            return cards === rule.cards ? rule : { ...rule, cards, nativeForm: rule };
        });
    }

    function keywordManagerCatalogNativeFormRule(keyword, cardSetId = null) {
        const rules = keywordManagerCatalogNativeFormRules(keyword).filter(rule =>
            !cardSetId || rule.cardSetId === cardSetId);
        const fingerprints = new Map(rules.map(rule => [keywordManagerCatalogFormFingerprint(rule), rule]));
        return fingerprints.size === 1 ? [...fingerprints.values()][0] : null;
    }

    function keywordManagerCatalogEffectiveFormRules(keyword) {
        const stateRules = keywordManagerCatalogRules(keyword, 'fieldRuleIds');
        return keywordManagerCatalogNativeFormRules(keyword).flatMap(rawForm => {
            const sourceForm = rawForm.nativeForm || rawForm;
            const state = stateRules.find(rule => rule.cardSetId === rawForm.cardSetId);
            const binding = nativeConditionalBinding(keyword);
            if (state && !['unsupported-source', 'counted-occurrences'].includes(nativeReaderLayoutKind(sourceForm, keyword)) &&
                binding && !binding.steps.some(step => step?.tagged)) {
                return [{ ...state, spellingGroups: rawForm.spellingGroups, nativeForm: sourceForm },
                    { ...rawForm, nativeForm: sourceForm }];
            }
            if (nativeFileLayoutKind(rawForm, keyword)) return { ...rawForm, nativeForm: sourceForm };
            const nativeForm = rawForm.recordSelection
                ? { ...rawForm, cards: rawForm.recordSelection.cards } : rawForm;
            // The source-bound relation owns the complete active card composition.
            // A legacy state pool must not replace its prefix/selected-row layout.
            if (rawForm.recordSelection) return { ...nativeForm, nativeForm: sourceForm };
            const stateRule = stateRules.find(rule => rule.cardSetId === nativeForm.cardSetId);
            return stateRule ? {
                ...stateRule,
                spellingGroups: nativeForm.spellingGroups,
                nativeForm: sourceForm,
            } : { ...nativeForm, nativeForm: sourceForm };
        });
    }

    function keywordManagerCatalogEquivalentSpellings(rule, keyword) {
        const normalized = String(keyword || '').replace(/^\*/, '').toUpperCase();
        const group = (rule?.spellingGroups || []).find(candidate =>
            Array.isArray(candidate?.keywords) && candidate.keywords.includes(normalized));
        return group?.relation === 'native-equivalent-spellings'
            ? group.keywords.map(value => String(value).toUpperCase())
            : [normalized];
    }

    function preserveEquivalentNativeSpelling(form, keyword, requested, selectorSpelling) {
        if (contactThermalBinding(keyword) && equivalentContactThermalSpelling(requested, selectorSpelling)) return requested;
        const spellings = keywordManagerCatalogEquivalentSpellings(form, keyword).map(value => `*${value}`);
        return spellings.includes(requested) && spellings.includes(selectorSpelling) ? requested : selectorSpelling;
    }

    function keywordManagerCatalogSelectorRule(keyword) {
        const form = keywordManagerCatalogCatalogForm(nativeFileCatalogKeyword(keyword));
        const ruleIds = form?.reference?.selectorRuleIds || [];
        const rules = ruleIds.map(ruleId => form.rules[ruleId]).filter(Boolean);
        return rules.length ? {
            ruleId: 'lspp-native-input-form-selectors',
            selectors: rules.flatMap(rule => rule.selectors || []),
            catalogRuleId: ruleIds.join('+'),
            catalogRuleIds: ruleIds,
            catalogSource: form.source,
            catalogKeyword: form.keyword,
            canonicalKeyword: form.reference.aliasOf || form.keyword,
        } : null;
    }

    function keywordManagerCatalogSelectorSpelling(rule, selections) {
        const base = String(rule?.canonicalKeyword || rule?.catalogKeyword || '').toUpperCase();
        const suffixes = (rule?.selectors || []).flatMap(selector => {
            const selected = (selector.values || []).find(value =>
                String(value.value) === String(selections?.[selector.controlId] || ''));
            const suffix = String(selected?.keywordSuffix ||
                (selected ? selector.keywordSuffix : '') || '').toUpperCase();
            return suffix ? [{ order: Number(selector.parserCallOrder || 0), suffix }] : [];
        }).sort((left, right) => right.order - left.order);
        return `*${base}${suffixes.map(item => item.suffix).join('')}`;
    }

    // Source-bound geometry permits existing field compatibility checks. It does
    // not prove a fixed total record count or authorize dropping blank records.
    function keywordManagerStaticLayout(keyword, form) {
        const selector = keywordManagerCatalogSelectorRule(keyword);
        if (selector && !keywordManagerCatalogExplicitSpellingSelections(selector,
            `*${String(keyword).replace(/^\*/, '').toUpperCase()}`)) return false;
        return !!form && !form.states && !form.domains && !form.recordSelection && !form.controllerFields?.length &&
            !nativeFileLayoutKind(form, keyword) && !keywordManagerVerifiedTrailingRepeat(keyword, form) &&
            !keywordManagerCatalogRules(keyword, 'fieldRuleIds').length &&
            form.occurrenceGrammar?.kind === 'native-ordered-source-bound-records' &&
            (form.cards || []).every(card => !card.when && card.recordKind === 'fields' &&
                card.occurrence?.kind === 'source-bound');
    }

    function keywordManagerStaticSource(document, keywordLine, result) {
        if (result.block) result.block = { ...result.block, inputFormat:
            keywordInputFormat(document.lineAt(keywordLine).text, documentGlobalInputFormat(document)) };
        if (result.preservedTrailingRecords || result.block?.status !== 'ready') return;
        const keyword = keywordSpellingFromLine(document.lineAt(keywordLine).text);
        const forms = keywordManagerCatalogNativeFormRules(keyword);
        const selector = keywordManagerCatalogSelectorRule(keyword);
        const selected = keywordManagerCatalogExplicitSpellingSelections(selector, keyword);
        if (!forms.length || !forms.every(form => keywordManagerStaticLayout(keyword, form)) ||
            (selector && !selected)) return;
        const prefixCount = (selector?.selectors || []).reduce((count, control) => count +
            (control.values.find(value => value.value === selected[control.controlId])?.cards?.length || 0), 0);
        const counts = new Set(forms.map(form => form.cards.length + prefixCount));
        if (counts.size !== 1) return;
        const count = [...counts][0] as number;
        const records = result.block.records;
        if (records.length <= count || !records.slice(count).every(record => /^[ \t]*$/.test(record.text))) return;
        result.preservedTrailingRecords = records.slice(count);
        result.block = { ...result.block, records: records.slice(0, count) };
    }

    function keywordManagerUnverifiedRepeat(keyword, forms) {
        return forms.some(form => !nativeFileLayoutKind(form, keyword) &&
            form.occurrenceGrammar?.repeatResolution === 'source-compatible-native-card');
    }

    function keywordManagerValueIssue(field, rawValue, source = 'original', document = null, line = undefined) {
        const value = String(rawValue ?? '');
        const trimmed = value.trim();
        let code;
        if (/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) code = 'characters';
        else if (value.length > Number(field.width)) code = 'width';
        else if (!trimmed) return undefined;
        else {
            const type = String(field.type ?? '').toLowerCase();
            const numericType = ![0, -2].includes(Number(field.type)) && type !== 'string';
            let candidate = trimmed;
            const input = numericType ? parseNumericInput(trimmed, { integerOnly: false }) : null;
            if (input?.kind === 'parameter' || input?.kind === 'expression') {
                return undefined;
            }
            if (!code && numericType) {
                const parsed = parseNumericInput(candidate.replace(/[dD]/g, 'e'), { integerOnly: false });
                const number = parsed.kind === 'numeric' ? parsed.value : NaN;
                if (!Number.isFinite(number)) code = 'number';
                else if ((Math.abs(Number(field.type)) === 1 || type === 'integer' || type === 'bool') &&
                    !Number.isInteger(number)) code = 'integer';
            }
            if (!code && field.choices?.length && !field.choices.some(choice => String(choice) === candidate ||
                (numericType && Number(String(choice).replace(/[dD]/g, 'e')) === Number(candidate.replace(/[dD]/g, 'e'))))) code = 'choice';
        }
        return code ? { code, source, severity: ['width', 'characters'].includes(code) ? 'error' : 'warning',
            blocksApply: source === 'draft' && ['width', 'characters'].includes(code),
            message: i18n.get(`keywordManagerValue_${code}`) } : undefined;
    }

    function keywordManagerLayoutDiagnostics(model) {
        if (!String(model.plan?.reason || '').startsWith('lspp-input-form-source-layout-')) return [];
        if (model.structureDiagnostic) return [model.structureDiagnostic];
        const keyword = model.currentKeyword;
        const forms = keywordManagerCatalogEffectiveFormRules(keyword);
        let code = model.inputFormResolution?.status === 'ambiguous' ? 'ambiguous' : 'evidence';
        if (code !== 'ambiguous' && keywordManagerUnverifiedRepeat(keyword, forms)) code = 'repeatUnsupported';
        else if (code !== 'ambiguous' && forms.some(form => form.states || form.recordSelection || nativeFileLayoutKind(form, keyword))) {
            code = 'control';
        }
        return [{ code, source: 'original', severity: 'warning', blocksApply: true, line: model.keywordLine,
            message: i18n.get(`keywordManagerLayout_${code}`) }];
    }

    function keywordManagerUnresolvedSource(document, keywordLine, result) {
        const keyword = keywordSpellingFromLine(document.lineAt(keywordLine).text);
        const records = result.block?.records || [];
        let line = keywordLine + 1;
        const lines = records.map(record => { line += (record.comments || []).length; return line++; });
        const binding = nativeConditionalBinding(keyword);
        const readings = keywordManagerCatalogNativeFormRules(keyword).map(rule => {
            const reading = require('../../core/semantics/nativeFileReadContext').nativeFileReadContext(rule.nativeForm || rule,
                document.lineAt(keywordLine).text, records.map(record => record.text), documentGlobalInputFormat(document),
                lines, records.some(record => record.text.includes('&')) ? nativeParameterContextForDocument(document) : undefined);
            return { reading, selected: reading.select(true) };
        });
        const unique = new Map(readings.map(item => [JSON.stringify({ kind: item.reading.kind,
            current: item.selected?.current, counts: item.selected?.counts, reasons: item.selected?.reasons,
            unboundedTail: item.selected?.unboundedTail, minimumRecords: item.selected?.minimumRecords,
            cards: [...item.reading.cards.values()].map(card => [card.cardIndex, card.fields]) }), item]));
        const resolved = unique.size === 1 ? [...unique.values()][0] : null;
        const expected = !resolved?.reading.readInputFailure && !resolved?.selected?.unboundedTail && resolved?.selected?.failureKind !== 'implementation-gap' &&
            resolved?.selected?.counts?.length === 1 ? resolved.selected.counts[0] : undefined;
        const forms = keywordManagerCatalogNativeFormRules(keyword);
        let code = result.inputFormResolution?.status === 'ambiguous' ? 'ambiguous' : 'evidence';
        if (code !== 'ambiguous' && resolved) {
            code = !resolved.reading.kind || resolved.reading.readInputFailure || resolved.selected?.failureKind === 'implementation-gap' ? 'evidence' :
                Number.isInteger(expected) && expected !== records.length ? expected > records.length ? 'missing' : 'extra' : 'control';
        }
        if (code !== 'ambiguous' && Number.isInteger(expected) && expected !== records.length)
            code = expected > records.length ? 'missing' : 'extra';
        else if (code !== 'ambiguous' && resolved?.selected?.unboundedTail &&
            resolved.selected.minimumRecords > records.length) code = 'missing';
        else if (code !== 'ambiguous' && keywordManagerUnverifiedRepeat(keyword, forms)) code = 'repeatUnsupported';
        // On malformed conditional input only the unconditional prefix is independently located.
        const prefix = [];
        if (resolved && binding && !resolved.reading.readInputFailure) {
            if (/_TITLE$/.test(keyword)) prefix.push(0);
            for (const step of binding.steps || []) { if (typeof step !== 'number') break; prefix.push(step); }
        } else if (resolved && nativeSpellingBinding(keyword)?.displayOnly && !resolved.reading.readInputFailure) {
            prefix.push(...(resolved.selected?.current || []).map(record => record.cardIndex));
        }
        const cards = prefix.slice(0, records.length).flatMap((cardIndex, index) => {
            const card = resolved.reading.cards.get(cardIndex);
            if (!card) return [];
            return [{ cardIndex, line: lines[index], editable: false, fields: card.fields.map((field, fieldIndex) => ({
                fieldId: `lspp-input:${keyword.replace(/^\*/, '')}:${binding ? '' : `record:${index}:`}card:${cardIndex}:field:${fieldIndex}`,
                name: field.name, type: String(field.type), position: field.position, width: field.width,
                line: lines[index], value: readNativeFileField(resolved.reading.kind, cardIndex, card.fields,
                    records[index].text, fieldIndex, resolved.reading.readInput),
                visible: true, enabled: true, editable: false,
            })) }];
        });
        const controls = Object.entries(binding?.controls || {}).flatMap(([name, coordinate]: [string, any]) => {
            const card = cards.find(card => card.cardIndex === coordinate.card);
            const field = card?.fields[coordinate.field];
            return field ? [{ name, value: field.value, line: field.line, fieldId: field.fieldId }] : [];
        });
        const countMessage = ['missing', 'extra'].includes(code) && Number.isInteger(expected)
            ? i18n.get('keywordManagerLayout_recordCount').replace('{expected}', String(expected)).replace('{actual}', String(records.length))
            : i18n.get(`keywordManagerLayout_${code}`);
        const requiredCards = (binding?.steps || []).flatMap(step => {
            if (!step.control || !Array.isArray(step.then)) return [];
            const operator = { lt: '<', gt: '>', eq: '=', ne: '≠' }[step.op];
            const condition = `${step.control}${operator}${step.value}`;
            if (!operator || !resolved?.selected?.conditions?.includes(`${condition}: yes`)) return [];
            return step.then.filter(index => typeof index === 'number').map(index => ({ condition,
                fields: (resolved.reading.cards.get(index)?.fields || []).map(field => field.name) }));
        });
        return { cards, selectedFieldId: cards[0]?.fields[0]?.fieldId || null,
            diagnostic: { code, source: 'original', severity: 'warning', blocksApply: true,
                message: countMessage, line: controls[0]?.line ?? keywordLine, actualRecords: records.length,
                ...(Number.isInteger(expected) ? { expectedRecords: expected } : {}), controls,
                conditions: resolved?.selected?.conditions || [], requiredCards },
            unresolvedRecords: records.slice(cards.length).map((record, index) => ({
                line: lines[cards.length + index], text: record.text,
            })) };
    }

    function keywordManagerCatalogSourceRecordCompatible(source, record, staticLayout = false, inputFormat = 'standard') {
        const text = String(source?.text || '');
        const fields = record?.fields || [];
        const format = keywordRecordSerializer.detectRecordFormat(text, inputFormat, fields);
        const geometry = keywordRecordSerializer.formattedFields(fields, text, format);
        if (record.recordMarker && (!text.startsWith(record.recordMarker.value) ||
            keywordRecordSerializer.readRecordField(text, fields, record.recordMarker.fieldIndex, format) !== record.recordMarker.value)) return false;
        if (staticLayout) return format === 'comma'
            ? text.split(',').length <= fields.length
            : !text.slice(Math.max(0, ...geometry.map(field => Number(field.position) + Number(field.width)))).trim();
        return fields.every((field, index) => {
            if (index === record.recordMarker?.fieldIndex) return true;
            const value = format === 'standard'
                ? text.slice(Number(field.position), Number(field.position) + Number(field.width)).trim()
                : keywordRecordSerializer.readRecordField(text, fields, index, format);
            if (!value) return true;
            const type = String(field.type || '').toLowerCase();
            if (Number(field.type) === 0 || type === 'string') return true;
            const parsed = parseNumericInput(value.replace(/[dD]/g, 'e'), { integerOnly: false });
            if (parsed.kind === 'parameter' || parsed.kind === 'expression') return true;
            if (parsed.kind !== 'numeric') return false;
            const integer = Math.abs(Number(field.type)) === 1 || type === 'integer' || type === 'bool';
            return !integer || Number.isInteger(parsed.value);
        });
    }

    function keywordManagerContactPrefixSteps(rule) {
        return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
            /^CONTACT_(?!2D(?:_|$))/.test(rule.canonicalKeyword)
            ? keywordSchema.getVerifiedPrefixLayoutSteps(rule.canonicalKeyword, ['ID', 'MPP']) : null;
    }

    function keywordManagerPrefixCardMatches(step, card) {
        const type = value => Number(value) === 0 || value === 'string' ? 'string'
            : Math.abs(Number(value)) === 1 || value === 'integer' ? 'integer' : 'real';
        const fields = card?.fields || [];
        return !!step && fields.length > 0 && step.card.every(expected => {
            const field = fields.find(candidate => Number(candidate.position) === expected.p && Number(candidate.width) === expected.w);
            return field && (step.recordMarker && expected.p === 0 ? field.name === '-' :
                (field.name === expected.n || expected.n === 'HEADING' && field.name === 'TITLE') && type(field.type) === type(expected.t));
        }) && fields.every(field => field.name === '-' || step.card.some(expected =>
            Number(field.position) === expected.p && Number(field.width) === expected.w));
    }

    function keywordManagerContactIdentitySelector(rule, selector) {
        const values = selector.values || [];
        const id = values.find(value => value.value === 'ID' && value.keywordSuffix === '_ID');
        const title = values.find(value => value.value === 'TITLE' && value.keywordSuffix === '_TITLE');
        const step = keywordManagerContactPrefixSteps(rule)?.find(step => step.template === 'contact-id-heading');
        return selector.placement === 'before-base' && values.length === 2 && id?.cards?.length === 1 &&
            title?.cards?.length === 1 && JSON.stringify(id.cards) === JSON.stringify(title.cards) &&
            !!id.cards[0].parserAddress && !!id.cards[0].descriptorAddress && keywordManagerPrefixCardMatches(step, id.cards[0]);
    }

    function keywordManagerCatalogSelectorLayout(rule, keyword, nativeForm, selections, evaluatedRecords = null) {
        const selectors = rule.selectors || [];
        const canonical = String(keyword).replace(/^\*/, '').toUpperCase();
        const recordForCard = (card, identity) => legacyOptionRecord((card.fields || []).map(field => ({
            n: field.name === '-' ? 'UNUSED' : field.name, t: field.type, p: field.position, w: field.width,
        })), identity, true);
        const selectedBaseCards = new Set<number>(selectors.flatMap(selector => (selector.baseCardIndexes || []).map(Number)));
        const base = evaluatedRecords?.filter(record => Number(record.lsppCardIndex) !== 0 &&
            !selectedBaseCards.has(Number(record.lsppCardIndex))) ||
            (nativeForm.cards || []).filter(card => !selectedBaseCards.has(Number(card.cardIndex))).map(card => ({
                ...recordForCard(card, `lspp-input:${canonical}:card:${card.cardIndex}`), lsppCardIndex: Number(card.cardIndex),
            }));
        const before: any[] = [], after: any[] = [], thermal: any[] = [];
        const prefixSteps = keywordManagerContactPrefixSteps(rule);
        let markerCheck = null;
        for (const selector of [...selectors].sort((a, b) => Number(a.placementOrder || 0) - Number(b.placementOrder || 0))) {
            const controlId = String(selector.controlId || '');
            const value = (selector.values || []).find(candidate => String(candidate.value) === String(selections[controlId] || ''));
            const mpp = selector.placement === 'before-base' && selector.keywordSuffix === '_MPP' && value;
            if (mpp) {
                const step = prefixSteps?.find(step => step.template === 'contact-mpp-2');
                if (!step?.recordMarker || !['MPP1', 'MPP2'].includes(value.value)) return null;
                markerCheck = { index: before.length + 1, value: step.recordMarker.value, present: value.value === 'MPP2' };
            }
            const identity = keywordManagerContactIdentitySelector(rule, selector);
            const records = [];
            for (const [index, card] of (value?.cards || []).entries()) {
                const record: any = recordForCard(card, `lspp-input:${canonical}:selector:${controlId}:card:${index + 1}`);
                if (selector.placement === 'before-base') record.lsppCardIndex = 0;
                else if (card.cardIndex != null) record.lsppCardIndex = Number(card.cardIndex);
                if (mpp || identity) {
                    const step = prefixSteps?.find(step => step.template === (mpp ? `contact-mpp-${index + 1}` : 'contact-id-heading'));
                    if (!keywordManagerPrefixCardMatches(step, card)) return null;
                    record.prefixRole = mpp ? `mpp${index + 1}` : 'identity';
                    if (step.recordMarker) {
                        record.recordMarker = { ...step.recordMarker, fieldIndex: 0, evidenceIds: step.evidenceIds };
                        record.fields[0] = { ...record.fields[0], name: step.recordMarker.value, type: 'string' };
                    }
                }
                records.push(record);
            }
            (selector.placement === 'before-base' ? before : selector.controlId === contactThermalSource().controlId ? thermal : after).push(...records);
        }
        const orthotropic=base.findIndex(record=>record.fields[0]?.name==='FS1_SA');
        const split=orthotropic<0?base.length:orthotropic;
        const mechanical=base.map(record=>prefixSteps?{...record,prefixRole:'base'}:record);
        return { spelling: keywordManagerCatalogSelectorSpelling(rule, selections),
            records: [...before, ...mechanical.slice(0,split), ...thermal, ...mechanical.slice(split), ...after], markerCheck };
    }

    function keywordManagerVerifiedTrailingRepeat(keyword, nativeForm) {
        // The curve point sequence has independent native-format roundtrip fixtures.
        // A compatible numeric row alone is not evidence that an arbitrary card repeats.
        const cards = nativeForm?.cards || [];
        return /^\*?DEFINE_CURVE(?:_TITLE)?$/.test(String(keyword).toUpperCase()) &&
            nativeForm?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
            cards.length === 2 && cards[1].fields?.map(field => field.name).join('|') === 'A1|O1';
    }

    function keywordManagerResolveCatalogSelectorState(rule, currentKeyword, block) {
        if (!rule || block?.status !== 'ready') return null;
        const selectors = Array.isArray(rule.selectors) ? rule.selectors : [];
        const combinations = selectors.reduce((states, selector) => {
            const legalValues = getLegalSelectorValues(currentKeyword, selector);
            return states.flatMap(state => legalValues.map(value => ({
                ...state,
                [selector.controlId]: value,
            })));
        }, [{}]);
        let candidates: any[] = [];
        for (const nativeForm of keywordManagerCatalogNativeFormRules(currentKeyword)) {
            for (const selections of combinations) {
                const layout = keywordManagerCatalogSelectorLayout(rule, currentKeyword, nativeForm, selections);
                if (!layout || layout.markerCheck &&
                    String(block.records[layout.markerCheck.index]?.text || '').startsWith(layout.markerCheck.value) !== layout.markerCheck.present) continue;
                if (layout.spelling.replace(/^\*/, '') !==
                    String(currentKeyword || '').toUpperCase().replace(/^\*/, '') &&
                    !equivalentContactThermalSpelling(layout.spelling, currentKeyword)) continue;
                let candidateRecords = expandContactThermalRecords(currentKeyword, layout.records, block.records,
                    block.inputFormat || 'standard', (card, identity) => legacyOptionRecord(card, identity, true),
                    {}, layout.records, block.parameterContext, block.recordLines);
                if (!candidateRecords) continue;
                const isExactLength = candidateRecords.length === block.records.length;
                if (keywordManagerVerifiedTrailingRepeat(currentKeyword, nativeForm) && !isExactLength && candidateRecords.length < block.records.length) {
                    const extra = block.records.length - candidateRecords.length;
                    const repeatAt = candidateRecords.length - 1;
                    const expanded = candidateRecords.flatMap((record, index) => index === repeatAt
                        ? Array.from({ length: extra + 1 }, (_unused, occurrenceIndex) => ({
                            ...record,
                            recordMigrationId: `${record.recordMigrationId}:occurrence:${occurrenceIndex + 1}`,
                            occurrence: { kind: 'exactly-once' },
                            lsppOccurrenceIndex: occurrenceIndex + 1,
                            fields: (record.fields || []).map(field => ({
                                ...field,
                                fieldMigrationId: `${field.fieldMigrationId}:occurrence:${occurrenceIndex + 1}`,
                            })),
                        })) : [record]);
                    if (expanded.length === block.records.length &&
                        expanded.every((record, index) => keywordManagerCatalogSourceRecordCompatible(block.records[index], record))) {
                        candidateRecords = expanded;
                    }
                }
                if (candidateRecords.length !== block.records.length || candidateRecords.some((record, index) =>
                    record.recordMarker && !keywordManagerCatalogSourceRecordCompatible(block.records[index], record,
                        true, block.inputFormat || 'standard'))) continue;
                const compatible = candidateRecords.every((record, index) =>
                    keywordManagerCatalogSourceRecordCompatible(block.records[index], record,
                        keywordManagerStaticLayout(currentKeyword, nativeForm), block.inputFormat || 'standard'));
                candidates.push({ selections, nativeForm, isExactLength, compatible, layout: { ...layout, records: candidateRecords } });
            }
        }
        const hasExact = candidates.some(candidate => candidate.isExactLength);
        if (hasExact) {
            candidates = candidates.filter(candidate => candidate.isExactLength);
        }

        const unique = new Map(candidates.map(candidate => [JSON.stringify({
            selections: candidate.selections,
            form: keywordManagerCatalogFormFingerprint(candidate.nativeForm),
            records: candidate.layout.records.map(record => optionSwitchCardFromRecord(record)),
        }), candidate]));
        // Unique file syntax locates fields even when their values have warnings.
        // Numeric compatibility can eliminate candidates, never manufacture certainty.
        const distinct = [...unique.values()];
        const remaining = distinct.length === 1 ? distinct : distinct.filter(candidate => candidate.compatible);
        return remaining.length === 1 ? remaining[0] : null;
    }

    function keywordManagerInferCatalogSelectorSelections(rule, currentKeyword, _grammar, block) {
        return keywordManagerResolveCatalogSelectorState(rule, currentKeyword, block)?.selections ||
            keywordManagerCatalogExplicitSpellingSelections(rule, currentKeyword) || {};
    }

    function keywordManagerCatalogExplicitSpellingSelections(rule, keyword) {
        const selectors = rule?.selectors || [];
        if (!selectors.length || !selectors.every(selector => selector.placement === 'before-base' &&
            !(selector.baseCardIndexes || []).length && (selector.values || []).every(value => value.keywordSuffix))) return null;
        const states = selectors.reduce((states, selector) => states.flatMap(state =>
            ['', ...selector.values.map(value => value.value)].map(value => ({ ...state, [selector.controlId]: value }))), [{}]);
        const matches = states.filter(state => keywordManagerCatalogSelectorSpelling(rule, state) === keyword);
        return matches.length === 1 ? matches[0] : null;
    }

    function keywordManagerPrepareCatalogSelectorLayout(
        document, keywordLine, result, selections: any = {}, selectionsDescribeCurrentLayout = false,
        fieldDrafts = {},
    ) {
        let physical = keywordLine + 1;
        if (result.block) {
            result.block = {...result.block, inputFormat:keywordInputFormat(document.lineAt(keywordLine).text, documentGlobalInputFormat(document)),
                parameterContext:nativeParameterContextForDocument(document),
                recordLines:result.block.records.map(r=>{physical += (r.comments || []).length; return physical++;})};
        }
        const keyword = keywordSpellingFromLine(document.lineAt(keywordLine).text);
        // A source-row relation owns its records. Static spelling layouts must not
        // replace it (or rescue a rejected relation) with the all-cards snapshot.
        if (keywordManagerCatalogNativeFormRules(keyword).some(form => form.recordSelection || nativeFileLayoutKind(form, keyword))) return null;
        const rule = keywordManagerCatalogSelectorRule(keyword);
        const resolved = keywordManagerResolveCatalogSelectorState(rule, keyword, result?.block) ||
            (result.inputFormProjection?.branchEvidence === 'predicate' ? {
                nativeForm: result.inputFormProjection.nativeForm,
                selections: keywordManagerCatalogExplicitSpellingSelections(rule, keyword),
            } : null);
        const nativeForm = resolved?.nativeForm;
        const selectors = Array.isArray(rule?.selectors) ? rule.selectors : [];
        const hasSelection = selectors.some(selector =>
            Object.prototype.hasOwnProperty.call(selections, selector.controlId));
        if (!rule || !hasSelection || !nativeForm || !result.currentLayout || !result.targetLayout) return null;
        // An unchanged spelling selection must not replace an already evaluated
        // field-state layout with the native all-cards snapshot.
        if (result.inputFormProjection?.branchEvidence === 'predicate' && selectors.every(selector =>
            String(selections[selector.controlId] ?? '') === String(resolved.selections[selector.controlId] ?? ''))) return null;
        const predicateProjection = result.inputFormProjection?.branchEvidence === 'predicate'
            ? result.inputFormProjection : null;
        // Spelling selectors cannot authorize a layout whose field conditions
        // failed validation. This also runs during application revalidation.
        if (!result.inputFormProjection && keywordManagerCatalogRules(keyword, 'fieldRuleIds').length) return null;
        const layoutFor = (selected, evaluatedRecords = null, drafts = {}, recordDrafts = {}) => {
            const layout = keywordManagerCatalogSelectorLayout(rule, keyword, nativeForm, selected, evaluatedRecords);
            if (!layout) return null;
            let records = expandContactThermalRecords(keyword, layout.records, result.block.records, result.block.inputFormat || 'standard',
                (card, identity) => legacyOptionRecord(card, identity, true), drafts, resolved?.layout?.records || layout.records,
                result.block.parameterContext, result.block.recordLines, recordDrafts);
            if (!records) return null;
            if (keywordManagerVerifiedTrailingRepeat(keyword, nativeForm) && !evaluatedRecords && result?.block?.records && result.block.records.length > records.length) {
                const extra = result.block.records.length - records.length;
                const repeatAt = records.length - 1;
                records = records.flatMap((record, index) => index === repeatAt
                    ? Array.from({ length: extra + 1 }, (_unused, occurrenceIndex) => ({
                        ...record,
                        recordMigrationId: `${record.recordMigrationId}:occurrence:${occurrenceIndex + 1}`,
                        occurrence: { kind: 'exactly-once' },
                        lsppOccurrenceIndex: occurrenceIndex + 1,
                        fields: (record.fields || []).map(field => ({
                            ...field,
                            fieldMigrationId: `${field.fieldMigrationId}:occurrence:${occurrenceIndex + 1}`,
                        })),
                    })) : [record]);
            }
            return {
                spelling: layout.spelling,
                records,
            };
        };
        const inferred = resolved?.selections || {};
        const currentState = layoutFor(selectionsDescribeCurrentLayout ? selections : inferred,
            predicateProjection ? result.currentLayout.records : null);
        const targetState = layoutFor(selections, predicateProjection ? result.targetLayout.records : null, fieldDrafts, result.recordDrafts || {});
        if (!currentState || !targetState) {
            result.plan = blockedKeywordOptionSwitchPlan(keyword, result.plan?.targetKeyword, 'lspp-prefix-layout-unverified', result.plan);
            return null;
        }
        targetState.spelling = preserveEquivalentNativeSpelling(
            nativeForm, keyword, result.plan?.targetKeyword || keyword, targetState.spelling,
        );
        if (selectors.some(selector => !getLegalSelectorValues(targetState.spelling, selector)
            .includes(String(selections[selector.controlId] || '')))) {
            result.plan = blockedKeywordOptionSwitchPlan(keyword, targetState.spelling, 'lspp-selector-spelling-unverified', result.plan);
            return null;
        }
        const sourceIdentity = result.targetLayout.sourceIdentity;
        const targetLayout = {
            ...result.targetLayout,
            profileId: `${result.targetLayout.profileId}:lspp-selectors:${selectors.map(selector =>
                String(selections[selector.controlId] || '-')).join(':')}`,
            records: targetState.records,
            sourceIdentity,
        };
        const currentLayout = { ...targetLayout, records: currentState.records };
        const inputFormat = keywordInputFormat(
            String(document.lineAt(keywordLine).text || ''), documentGlobalInputFormat(document),
        );
        const plan = planOptionSwitch({
            currentKeyword: keyword,
            targetKeyword: targetState.spelling,
            currentLayout,
            targetLayout,
            records: result.block.records,
            documentVersion: document.version,
            uri: documentUriIdentity(document),
            keywordLine,
            sourceLockIdentity: [result.plan.sourceLockIdentity || '', rule.catalogRuleId,
                rule.catalogSource?.datasetSha256 || ''].join(':'),
            inputFormat,
            readField: (text, record, index) => keywordRecordSerializer.readRecordField(
                text, record.fields, index,
                keywordRecordSerializer.detectRecordFormat(text, inputFormat === 'long' ? 'long' : inputFormat === 'i10' ? 'i10' : 'standard', record.fields),
            ),
            readRecordRanges: (text, record) => optionSwitchSourceRanges(text, record, inputFormat),
            writeField: (text, record, index, value) => keywordRecordSerializer.writeRecordField(
                text, record.fields, index, value,
                keywordRecordSerializer.detectRecordFormat(text, inputFormat === 'long' ? 'long' : inputFormat === 'i10' ? 'i10' : 'standard', record.fields),
            ),
            createRecord: targetRecord => keywordRecordSerializer.blankRecord(
                targetRecord.fields,
                inputFormat === 'long' ? 'long' : inputFormat === 'i10' ? 'i10' : inputFormat === 'comma' ? 'comma' : inputFormat === 'free' ? 'free' : 'standard',
            ),
            maxBytes: OPTION_SWITCH_MAX_BYTES,
            analyzeComment: optionSwitchCommentAnalysis,
            generateComment: optionSwitchCommentLine,
        });
        Object.assign(result, {
            currentLayout,
            targetLayout,
            plan,
            trailingCommentInsertIndex: targetState.records.length,
            inputFormProjection: {
                ...predicateProjection,
                currentRecordIds: currentLayout.records.map(record => record.recordMigrationId),
                targetRecordIds: targetState.records.map(record => record.recordMigrationId),
                ruleId: rule.catalogRuleId,
                nativeForm: predicateProjection?.nativeForm || nativeForm,
                branchEvidence: predicateProjection ? 'predicate' : 'selector',
                controlValues: { ...predicateProjection?.controlValues, ...selections },
            },
        });
        return result.inputFormProjection;
    }

    function keywordManagerPrepareCatalogInputFormLayout(document, keywordLine, result, drafts = {}, recordDrafts = {}, selectedFormRuleId = null) {
        result.validationDocument = document;
        result.recordDrafts = recordDrafts;
        keywordManagerStaticSource(document, keywordLine, result);
        const keyword = keywordSpellingFromLine(document.lineAt(keywordLine).text);
        const formRules = nativeConditionalBinding(keyword)
            ? keywordManagerCatalogNativeFormRules(keyword) : keywordManagerCatalogEffectiveFormRules(keyword);
        let matches = formRules.flatMap(rule => {
            const trial = { ...result, plan: { ...(result?.plan || {}), targetKeyword: keyword } };
            const projection = keywordManagerPrepareCatalogInputFormLayoutForRule(
                document, keywordLine, trial, rule,
            );
            if (!projection) return [];
            return [{ projection, rule, trial }];
        });
        if (nativeConditionalBinding(keyword)) {
            // Physical file readers are authoritative, regardless of comment contents.
            matches = matches.filter(match => match.projection.branchEvidence === 'native-file-reader');
        }
        const groups = new Map<string, any>();
        for (const match of matches) {
            const fingerprint = JSON.stringify({
                current: (match.trial.currentLayout?.records || []).map(optionSwitchCardFromRecord),
                target: (match.trial.targetLayout?.records || []).map(optionSwitchCardFromRecord),
                currentSnapshot: match.projection.currentSnapshot || null,
                targetSnapshot: match.projection.targetSnapshot || null,
            });
            if (!groups.has(fingerprint)) groups.set(fingerprint, match);
        }
        if (groups.size !== 1) {
            result.inputFormResolution = {
                status: groups.size === 0 ? 'unmatched' : 'ambiguous',
                candidateRuleIds: matches.map(match => match.rule.catalogRuleId),
                candidateSummaries: matches.map(match => {
                    const records = match.trial.currentLayout?.records || [];
                    const fields = records.map(record => (record.fields || [])
                        .map(field => field.name).filter(Boolean).join('/')).join(' | ');
                    return `${match.rule.catalogRuleId}: ${records.length} Card${records.length === 1 ? '' : 's'} [${fields}]`;
                }),
            };
            result.plan.status = 'blocked';
            result.plan.reason = groups.size === 0
                ? 'lspp-input-form-source-layout-unresolved' : 'lspp-input-form-source-layout-ambiguous';
            result.plan.replacementRecords = [];
            return null;
        }
        const selected = [...groups.values()][0];
        let prepared = selected.trial;
        if (Object.keys(drafts).length || Object.keys(recordDrafts).length || result.plan.targetKeyword !== keyword) {
            const targets = matches.map(match => {
                const trial = { ...result, plan: { ...result.plan } };
                const projection = keywordManagerPrepareCatalogInputFormLayoutForRule(
                    document, keywordLine, trial, match.rule, drafts, recordDrafts);
                return projection ? trial : null;
            });
            const targetLayouts = new Set(targets.map(trial => JSON.stringify({
                records: trial?.targetLayout?.records.map(optionSwitchCardFromRecord),
                snapshot: trial?.inputFormProjection?.targetSnapshot || null,
            })));
            if (targets.every(Boolean) && targetLayouts.size === 1) prepared = targets[0];
            else {
                prepared.plan = { ...prepared.plan, targetKeyword: result.plan.targetKeyword,
                    status: 'blocked', reason: 'lspp-input-form-field-draft-invalid', replacementRecords: [] };
            }
        }
        Object.assign(result, prepared, {
            inputFormResolution: {
                status: 'resolved',
                ruleId: selected.rule.catalogRuleId,
                equivalentRuleIds: matches.map(match => match.rule.catalogRuleId),
            },
        });
        return result.inputFormProjection;
    }

    function keywordManagerPrepareCatalogInputFormLayoutForRule(
        document, keywordLine, result, rule, drafts = {}, recordDrafts: Record<string, string> = {},
    ) {
        const keyword = keywordSpellingFromLine(document.lineAt(keywordLine).text);
        const allSourceRecords = result?.block?.records || [];
        let sourceRecords = allSourceRecords;
        if (!rule || result?.block?.status !== 'ready' || !Array.isArray(rule.cards)) return null;
        // A projected form must keep the source identity of the original descriptor.
        if (rule.nativeForm && (rule.catalogSource?.datasetSha256 !== rule.nativeForm.catalogSource?.datasetSha256 ||
            rule.cardSetId !== rule.nativeForm.cardSetId)) return null;
        const prefixRecordsFor = spelling => {
            const records: any[] = [];
            const spellingRule = keywordManagerCatalogSelectorRule(keyword);
            const selected = keywordManagerCatalogExplicitSpellingSelections(spellingRule, spelling);
            for (const selector of selected ? spellingRule.selectors : []) {
                const value = selector.values.find(value => value.value === selected[selector.controlId]);
                for (const [index, card] of (value?.cards || []).entries()) {
                    records.push({ ...legacyOptionRecord(card.fields.map(field => ({
                        n: field.name, t: field.type, p: field.position, w: field.width,
                    })), `lspp-input:${keyword.replace(/^\*/, '')}:selector:${selector.controlId}:card:${index + 1}`, true),
                    lsppCardIndex: 0 });
                }
            }
            const nativeSpelling = nativeSpellingBinding(spelling);
            if (nativeSpelling) {
                records.length = 0;
                if (nativeSpelling.prefixCard) records.push({ ...legacyOptionRecord(nativeSpelling.prefixCard.fields.map(field => ({
                    n: field.name, t: field.type, p: field.position, w: field.width,
                })), `lspp-input:${keyword}:prefix:0`, true), lsppCardIndex: 0 });
            }
            return records;
        };
        let currentPrefixRecords: any[] = [];
        let targetPrefixRecords: any[] = [];
        const fileKind = nativeFileLayoutKind(rule, keyword);
        let parameterLine = keywordLine + 1;
        const parameterLines = new Map(allSourceRecords.map(record => {
            parameterLine += (record.comments || []).length;
            return [record, parameterLine++];
        }));
        if (fileKind || (Array.isArray(rule.states) && Array.isArray(rule.domains))) {
            currentPrefixRecords = prefixRecordsFor(keyword);
            targetPrefixRecords = prefixRecordsFor(result.plan?.targetKeyword || keyword);
            if (currentPrefixRecords.length > sourceRecords.length) return null;
            if (!fileKind) sourceRecords = sourceRecords.slice(currentPrefixRecords.length);
        }
        const cardsByIndex = new Map<number, any>(rule.cards.map(card => [Number(card.cardIndex), card]));
        const effectiveCards = new Map([...cardsByIndex].map(([index, card]: any) => {
            if (!Array.isArray(card.fields) || (card.fields.length === 0 &&
                !(['ordinal-fixed', 'batch-fixed'].includes(fileKind) && card.nativeZeroFieldRecord))) return [index, null];
            return [index, card.fields.map(field => ({
                n: /^(?:-|\s*)$/.test(String(field.name || '')) ? 'UNUSED' : field.name,
                t: field.type,
                p: field.position,
                w: field.width,
            }))];
        }));
        if ([...effectiveCards.values()].some(card => !card)) return null;
        const canonical = String(keyword).replace(/^\*/, '').toUpperCase();
        const recordSelection = rule.recordSelection;
        if (recordSelection && (recordSelection.kind !== 'native-string-tail-replacement' ||
            recordSelection.keyword !== nativeFileCatalogKeyword(canonical) ||
            recordSelection.scope !== 'source-row' ||
            recordSelection.datasetSha256 !== rule.catalogSource?.datasetSha256)) return null;
        const schemaRecords = new Map([...cardsByIndex].map(([cardIndex, card]: any) => {
            const record: any = legacyOptionRecord(effectiveCards.get(cardIndex), `lspp-input:${canonical}:card:${cardIndex}`);
            record.lsppCardIndex = cardIndex;
            record.fields.forEach((field, index) => {
                if (card.fields[index].nativeReadGeometry) field.nativeReadGeometry = card.fields[index].nativeReadGeometry;
            });
            if (card?.sharedByteEditing?.mode === 'native-shared-bytes-v1' ||
                keywordRecordSerializer.hasSharedByteContract(card, rule.catalogSource?.datasetSha256)) {
                record.sharedByteEditing = 'native-shared-bytes-v1';
            }
            return [cardIndex, record];
        }));
        const acceptsSource = (record, source) => {
            // These fixed readers retain field identity even when a numeric view
            // shares bytes with another type. Value validity is separate from layout.
            if (nativeBatchFixedBinding(keyword)?.readWindows) return true;
            const text = String(source?.text || '');
            const fields = record?.fields || [];
            const input = keywordInputFormat(document.lineAt(keywordLine).text, documentGlobalInputFormat(document));
            const format = keywordRecordSerializer.detectRecordFormat(text, input, fields);
            return fields.every((field, index) => {
                let value = format === 'standard'
                    ? text.slice(Number(field.position), Number(field.position) + Number(field.width)).trim()
                    : keywordRecordSerializer.readRecordField(text, fields, index, format);
                if (!value) return true;
                const type = String(field.type || '').toLowerCase();
                if (Number(field.type) === 0 || type === 'string') return true;
                if (fileKind && value.includes('&')) {
                    const parameter = nativeParameterContextForDocument(document).resolve(value, parameterLines.get(source));
                    if (!parameter.resolved) return false;
                    value = String(parameter.value);
                }
                const numeric = Number(value.replace(/[dD]/g, 'e'));
                if (!Number.isFinite(numeric)) return false;
                return !(Math.abs(Number(field.type)) === 1 || type === 'integer' || type === 'bool') ||
                    Number.isInteger(numeric);
            });
        };
        const expandTrailingRepeat = records => {
            if (sourceRecords.length <= records.length) return records;
            if (!keywordManagerVerifiedTrailingRepeat(keyword, rule)) return null;
            const extra = sourceRecords.length - records.length;
            const repeatAt = records.length - 1;
            const expanded = records.flatMap((record, index) => index === repeatAt
                ? Array.from({ length: extra + 1 }, (_unused, occurrenceIndex) => ({
                    ...record,
                    recordMigrationId: `${record.recordMigrationId}:occurrence:${occurrenceIndex + 1}`,
                    occurrence: { kind: 'exactly-once' },
                    lsppOccurrenceIndex: occurrenceIndex + 1,
                    fields: (record.fields || []).map(field => ({
                        ...field,
                        fieldMigrationId: `${field.fieldMigrationId}:occurrence:${occurrenceIndex + 1}`,
                    })),
                })) : [record]);
            return expanded.every((record, index) => acceptsSource(record, sourceRecords[index]))
                ? expanded : null;
        };
        let controllerValues = {};
        const controllers = !fileKind && Array.isArray(rule.controllerFields) ? rule.controllerFields : [];
        const controllerKey = controller => String(controller.controllerId || controller.name || '').toUpperCase();
        const readController = (controller, source, target = controllerValues) => {
            const record = schemaRecords.get(Number(controller.cardIndex));
            const field = record?.fields?.[Number(controller.fieldIndex)];
            if (!field || !source) return false;
            const input = keywordInputFormat(document.lineAt(keywordLine).text, documentGlobalInputFormat(document));
            const format = keywordRecordSerializer.detectRecordFormat(source.text, input, record.fields);
            target[controllerKey(controller)] = keywordRecordSerializer.readRecordField(
                source.text, record.fields, Number(controller.fieldIndex), format) || controller.defaultValue || 0;
            return true;
        };
        const numeric = value => {
            const parsed = Number(String(value ?? '').trim().replace(/[dD]/g, 'e'));
            return Number.isFinite(parsed) ? parsed : null;
        };
        const inInterval = (value, interval) => {
            const number = numeric(value);
            if (number === null) return false;
            if (interval.min !== undefined && (number < Number(interval.min) ||
                (number === Number(interval.min) && interval.minInclusive === false))) return false;
            if (interval.max !== undefined && (number > Number(interval.max) ||
                (number === Number(interval.max) && interval.maxInclusive === false))) return false;
            return true;
        };
        const stateFor = fields => {
            if (!Array.isArray(rule.domains) || !Array.isArray(rule.states)) return null;
            const indexes = rule.domains.map(domain => (domain.intervals || []).findIndex(interval =>
                inInterval(fields[String(domain.controllerId || domain.field || '').toUpperCase()], interval)));
            if (indexes.some(index => index < 0)) return null;
            const state = rule.states.find(candidate => Array.isArray(candidate.domainIndexes) &&
                candidate.domainIndexes.length === indexes.length &&
                candidate.domainIndexes.every((value, index) => Number(value) === indexes[index]));
            return state || null;
        };
        const stateLayout = fields => stateFor(fields)?.cardIndexes?.map(Number) || null;
        if (!fileKind && Array.isArray(rule.states) && Array.isArray(rule.domains)) {
            const matches = [];
            const layouts = new Map<string, number[]>((rule.states || []).map(state => [
                (state.cardIndexes || []).map(Number).join(','), (state.cardIndexes || []).map(Number),
            ]));
            for (const layout of layouts.values()) {
                if (layout.length !== sourceRecords.length) continue;
                const values = {};
                let valid = true;
                for (const controller of controllers) {
                    const sourceIndex = layout.indexOf(Number(controller.cardIndex));
                    if (sourceIndex < 0) {
                        values[controllerKey(controller)] = Number(controller.defaultValue) || 0;
                    } else if (!readController(controller, sourceRecords[sourceIndex], values)) {
                        valid = false;
                        break;
                    }
                }
                const evaluated = valid ? stateLayout(values) : null;
                if (evaluated && evaluated.join(',') === layout.join(',')) {
                    matches.push({ layout, values });
                }
            }
            if (matches.length === 1) {
                controllerValues = matches[0].values;
            } else {
                return null;
            }
        } else {
            for (const controller of controllers.filter(item => Number.isInteger(Number(item.sourceOrdinal)))) {
                if (!readController(controller, sourceRecords[Number(controller.sourceOrdinal) - 1])) return null;
            }
            for (let pass = 0; pass <= rule.cards.length; pass++) {
                const before = Object.keys(controllerValues).length;
                let sourceIndex = 0;
                let blocked = false;
                for (const card of rule.cards) {
                    const state = !card.when ? 'true' : evaluatePredicate(card.when, { fields: controllerValues });
                    if (state === 'indeterminate') {
                        blocked = true;
                        continue;
                    }
                    if (state !== 'true') continue;
                    if (blocked) break;
                    const source = sourceRecords[sourceIndex++];
                    for (const controller of controllers.filter(item =>
                        Number(item.cardIndex) === Number(card.cardIndex) &&
                        !Object.prototype.hasOwnProperty.call(controllerValues, controllerKey(item)))) {
                        if (!readController(controller, source)) return null;
                    }
                }
                if (Object.keys(controllerValues).length === before) break;
            }
        }
        if (controllers.some(controller => !Object.prototype.hasOwnProperty.call(
            controllerValues, controllerKey(controller)))) return null;
        const targetValues = { ...controllerValues };
        for (const controller of rule.controllerFields || []) {
            const fieldId = `lspp-input:${canonical}:card:${controller.cardIndex}:field:${controller.fieldIndex}`;
            if (Object.prototype.hasOwnProperty.call(drafts, fieldId)) {
                targetValues[controllerKey(controller)] = String(drafts[fieldId] ?? '').trim() || controller.defaultValue || 0;
            }
            const record = schemaRecords.get(Number(controller.cardIndex));
            if (record && recordDrafts && Object.prototype.hasOwnProperty.call(recordDrafts, record.recordMigrationId)) {
                const draftText = recordDrafts[record.recordMigrationId];
                const field = record.fields?.[Number(controller.fieldIndex)];
                if (field) {
                    const cellVal = cardCellModel.readCellValue(draftText, [{ n: field.name, p: field.position, w: field.width, t: field.type }], 0);
                    targetValues[controllerKey(controller)] = cellVal !== undefined ? (cellVal || 0) : 0;
                }
            }
        }
        const visible = fields => {
            if (fileKind) return rule.cards.map(card => Number(card.cardIndex));
            if (Array.isArray(rule.states) && Array.isArray(rule.domains)) {
                return stateLayout(fields);
            }
            return stateLayout(fields) || rule.cards.filter(card => !card.when ||
                evaluatePredicate(card.when, { fields }) === 'true').map(card => Number(card.cardIndex));
        };
        let currentCardIndexes = visible(controllerValues);
        let targetCardIndexes = visible(targetValues);
        const currentState = fileKind ? null : stateFor(controllerValues);
        const targetState = fileKind ? null : stateFor(targetValues);
        if (!currentCardIndexes || currentCardIndexes.length === 0 || !targetCardIndexes || targetCardIndexes.length === 0) return null;
        let currentRecords = currentCardIndexes.map(index => schemaRecords.get(index));
        let targetRecords = targetCardIndexes.map(index => schemaRecords.get(index));
        let nativeWriteCompatible = true;
        if (currentRecords.some(r => !r) || targetRecords.some(r => !r)) return null;
        if (fileKind) {
            const selected = keywordManagerNativeFileSelection(document, keywordLine, rule, sourceRecords, drafts, recordDrafts,
                result.plan?.targetKeyword);
            if (!selected) return null;
            nativeWriteCompatible = selected.writeCompatible;
            const makeRecord = (item, prefixRecords) => {
                const key = fileKind === 'conditional-sequence' ? item.key.replace(/^instance:0:/, '') : item.key;
                const id = `lspp-input:${canonical}:${key}`;
                const template = item.cardIndex === 0 ? prefixRecords[0] : schemaRecords.get(item.cardIndex);
                if (!template) return null;
                return { ...template, recordMigrationId: id, lsppInstanceStart: item.instanceStart,
                    fields: template.fields.map((field, index) => ({ ...field,
                        ...(fileKind === 'mat213' && [8,12,14,16,18].includes(item.cardIndex) && index === 0
                            ? { nativeReadWidth: 10 } : {}),
                        fieldMigrationId: `${id}:field:${index}${fileKind === 'mat213' && item.cardIndex >= 8 &&
                            item.cardIndex !== 10 && item.cardIndex !== 11 && field.name !== 'FTYPE' ? `:${field.name}` : ''}` })) };
            };
            currentRecords = selected.current.map(item => makeRecord(item, currentPrefixRecords));
            targetRecords = selected.target.map(item => makeRecord(item, targetPrefixRecords));
            if (currentRecords.some((record, index) => !record || !acceptsSource(record, sourceRecords[index])) ||
                targetRecords.some(record => !record)) return null;
            currentCardIndexes = selected.current.map(item => item.cardIndex);
            targetCardIndexes = selected.target.map(item => item.cardIndex);
            currentPrefixRecords = [];
            targetPrefixRecords = [];
        } else if (recordSelection) {
            const controllerIndex = recordSelection.controllerFieldIndex;
            const selectionPrefix = recordSelection.prefixCardIndexes || [];
            if (!Array.isArray(selectionPrefix) || new Set(selectionPrefix).size !== selectionPrefix.length ||
                selectionPrefix.some(index => !Number.isInteger(index) || !schemaRecords.has(index) ||
                    recordSelection.cases.some(item => item.cardIndex === index)) ||
                (selectionPrefix.length > 0 && recordSelection.sourceRowCount !== 1) ||
                (recordSelection.controllerCardIndex !== undefined &&
                    !recordSelection.cases.some(item => item.cardIndex === recordSelection.controllerCardIndex)) ||
                (recordSelection.sourceRowCount !== undefined &&
                    (!Number.isInteger(recordSelection.sourceRowCount) || recordSelection.sourceRowCount !== 1 ||
                     sourceRecords.length !== selectionPrefix.length + recordSelection.sourceRowCount))) return null;
            const template: any = recordSelection.controllerCardIndex !== undefined
                ? schemaRecords.get(recordSelection.controllerCardIndex) : [...schemaRecords.values()][0];
            if (!Number.isInteger(controllerIndex) || !template?.fields?.[controllerIndex]) return null;
            if (recordSelection.controllerReadWidth !== undefined &&
                (!Number.isInteger(recordSelection.controllerReadWidth) || recordSelection.controllerReadWidth <= 0 ||
                 recordSelection.controllerReadWidth > template.fields[controllerIndex].width)) return null;
            const normalize = value => recordSelection.caseInsensitive
                ? String(value).trim().toUpperCase() : String(value).trim();
            const selectCard = value => recordSelection.cases.find(item => normalize(item.value) === normalize(value))?.cardIndex;
            currentCardIndexes = [...selectionPrefix];
            targetCardIndexes = [...selectionPrefix];
            currentRecords = selectionPrefix.map(index => schemaRecords.get(index));
            targetRecords = [...currentRecords];
            const input = keywordInputFormat(String(document.lineAt(keywordLine).text || ''), documentGlobalInputFormat(document));
            const nativeSource = selectVerifiedSourceRecords(rule, keyword, sourceRecords.map(record => record.text), input);
            if (nativeSource && nativeSource.length !== sourceRecords.length) return null;
            for (let ordinal = 0; ordinal < sourceRecords.length - selectionPrefix.length; ordinal++) {
                const id = `lspp-input:${canonical}:row:${ordinal + 1}`;
                const source = sourceRecords[ordinal + selectionPrefix.length];
                const format = keywordRecordSerializer.detectRecordFormat(source.text,
                    input === 'long' ? 'long' : input === 'i10' ? 'i10' : 'standard', template.fields);
                const original = keywordRecordSerializer.readRecordField(source.text, template.fields, controllerIndex, format);
                if (recordSelection.controllerReadWidth !== undefined &&
                    (format === 'standard' || format === 'long' || format === 'i10')) {
                    const physical = keywordRecordSerializer.formattedFields(template.fields, source.text, format)[controllerIndex];
                    if (!physical) return null;
                    const nativeValue = source.text.slice(physical.position,
                        physical.position + recordSelection.controllerReadWidth);
                    // Native selection must see the same token as the full field.
                    // A LONG token entirely in the second half selects native ALL.
                    if (normalize(nativeValue) !== normalize(original)) return null;
                }
                const fieldId = `${id}:field:${controllerIndex}`;
                const draft = Object.prototype.hasOwnProperty.call(drafts, fieldId) ? drafts[fieldId] : original;
                const currentIndex = Number(nativeSource?.[ordinal + selectionPrefix.length]?.cardIndex ?? selectCard(original));
                const targetIndex = Number(selectCard(draft) ?? (nativeSource && normalize(draft) === '' ? recordSelection.defaultCardIndex : undefined));
                if (!cardsByIndex.has(currentIndex) || !cardsByIndex.has(targetIndex)) return null;
                const recordFor = cardIndex => ({
                    ...legacyOptionRecord(effectiveCards.get(cardIndex), id),
                    lsppCardIndex: cardIndex,
                    lsppOccurrenceIndex: ordinal + 1,
                });
                currentCardIndexes.push(currentIndex);
                targetCardIndexes.push(targetIndex);
                currentRecords.push(recordFor(currentIndex));
                targetRecords.push(recordFor(targetIndex));
            }
        } else if (rule.nativeDescriptorExtent?.consumption === 'static-descriptor-records' &&
            rule.occurrenceGrammar?.kind === 'native-fixed-records') {
            const counts = keywordManagerNativeInstanceCounts(rule.occurrenceGrammar, sourceRecords.length);
            if (!counts) return null;
            currentRecords = []; targetRecords = [];
            const input = keywordInputFormat(document.lineAt(keywordLine).text, documentGlobalInputFormat(document));
            const nativeSource = selectVerifiedSourceRecords(rule, keyword, sourceRecords.map(record => record.text), input);
            if (!nativeSource || nativeSource.length !== sourceRecords.length) return null;
            for (const [index, item] of nativeSource.entries()) {
                const cardIndex = item.cardIndex;
                const id = `lspp-input:${canonical}:${item.key}`;
                const record = { ...legacyOptionRecord(effectiveCards.get(cardIndex), id), lsppCardIndex: cardIndex };
                if (!acceptsSource(record, sourceRecords[index])) return null;
                currentRecords.push(record); targetRecords.push(record);
            }
        } else if (sourceRecords.length === 0) {
            currentRecords = [];
        } else if (currentRecords.length !== sourceRecords.length) {
            if (sourceRecords.length < currentRecords.length) {
                if (sourceRecords.every((src, idx) => acceptsSource(currentRecords[idx], src))) {
                    currentRecords = currentRecords.slice(0, sourceRecords.length);
                } else {
                    return null;
                }
            } else {
                if (currentCardIndexes.join(',') !== targetCardIndexes.join(',')) return null;
                const expanded = expandTrailingRepeat(currentRecords);
                if (!expanded) return null;
                currentRecords = expanded;
                targetRecords = expanded;
            }
        }
        currentRecords = [...currentPrefixRecords, ...currentRecords];
        targetRecords = [...targetPrefixRecords, ...targetRecords];
        sourceRecords = allSourceRecords;
        const currentLayout = {
            profileId: `lspp-input-form:${canonical}:${currentCardIndexes.join('-')}`,
            keyword,
            inputFormat: 'standard-fixed',
            sourceIdentity: { canonicalKeyword: canonical, fieldSchema: 'lspp-native-input-form' },
            records: currentRecords,
        };
        const targetLayout = {
            ...currentLayout,
            profileId: `lspp-input-form:${canonical}:${targetCardIndexes.join('-')}`,
            records: targetRecords,
        };
        const sourceLockIdentity = [result.plan?.sourceLockIdentity || '', rule.catalogRuleId,
            rule.catalogSource?.datasetSha256 || ''].join(':');
        const requestedKeyword = String(result.plan?.targetKeyword || keyword).toUpperCase();
        const inputFormat = keywordInputFormat(
            String(document.lineAt(keywordLine).text || ''), documentGlobalInputFormat(document),
        );
        const plan = planOptionSwitch({
            currentKeyword: keyword,
            targetKeyword: requestedKeyword,
            allowOrdinalRecordMatch: fileKind !== 'conditional-sequence',
            currentLayout,
            targetLayout,
            records: sourceRecords,
            documentVersion: document.version,
            uri: documentUriIdentity(document),
            keywordLine,
            sourceLockIdentity,
            inputFormat,
            readField: (text, record, index) => keywordRecordSerializer.readRecordField(
                text, record.fields, index,
                keywordRecordSerializer.detectRecordFormat(text, inputFormat === 'long' ? 'long' : inputFormat === 'i10' ? 'i10' : 'standard', record.fields),
            ),
            readRecordRanges: (text, record) => optionSwitchSourceRanges(text, record, inputFormat),
            writeField: (text, record, index, value) => keywordRecordSerializer.writeRecordField(
                text, record.fields, index, value,
                keywordRecordSerializer.detectRecordFormat(text, inputFormat === 'long' ? 'long' : inputFormat === 'i10' ? 'i10' : 'standard', record.fields),
            ),
            createRecord: targetRecord => keywordRecordSerializer.blankRecord(
                targetRecord.fields,
                inputFormat === 'long' ? 'long' : inputFormat === 'i10' ? 'i10' : inputFormat === 'comma' ? 'comma' : inputFormat === 'free' ? 'free' : 'standard',
            ),
            maxBytes: OPTION_SWITCH_MAX_BYTES,
            analyzeComment: optionSwitchCommentAnalysis,
            generateComment: optionSwitchCommentLine,
        });
        // Reading a comma controller correctly does not prove the conditional
        // file-record writer. Keep this existing unsupported material path read-only.
        // RESIDUAL_VECTOR already has verified comma-format support.
        const unverifiedConditionalWriter = fileKind === 'conditional-sequence'
            ? keyword.replace(/^\*/, '') !== 'CONTROL_IMPLICIT_RESIDUAL_VECTOR' &&
                !nativeConditionalBinding(keyword)?.steps.some(step => step?.tagged) &&
                keywordManagerCatalogRules(keyword, 'fieldRuleIds').some(candidate => Array.isArray(candidate.states) && Array.isArray(candidate.domains))
            : !fileKind && Array.isArray(rule.states);
        if (unverifiedConditionalWriter && sourceRecords.some(record => record.text.includes(','))) {
            plan.status = 'blocked';
            plan.reason = 'conditional-comma-write-unverified';
            plan.replacementRecords = [];
        }
        if (!nativeWriteCompatible || (nativeBatchFixedBinding(keyword)?.readWindows && (inputFormat !== 'standard' || sourceRecords.some(record => record.text.includes(',')) ||
            rule.cards.some(card => card.fields.some((field, index) => index > 0 && field.position < card.fields[index - 1].position))))) {
            plan.status = 'blocked';
            plan.reason = nativeWriteCompatible ? 'native-read-window-write-unverified' : 'native-file-write-unverified';
            plan.replacementRecords = [];
        }
        if (plan.status !== 'blocked' && currentRecords.length === targetRecords.length &&
            currentRecords.every((record, index) =>
                record.recordMigrationId === targetRecords[index]?.recordMigrationId &&
                record.lsppCardIndex === targetRecords[index]?.lsppCardIndex)) {
            for (let index = 0; index < plan.replacementRecords.length; index++) {
                const rec = targetRecords[index];
                if (recordDrafts && Object.prototype.hasOwnProperty.call(recordDrafts, rec.recordMigrationId)) {
                    plan.replacementRecords[index].text = recordDrafts[rec.recordMigrationId];
                } else if (sourceRecords[index]) {
                    plan.replacementRecords[index].text = sourceRecords[index].text;
                }
            }
        }
        Object.assign(result, {
            currentLayout,
            targetLayout,
            inputFormat,
            plan,
            ...(require('../../core/semantics/nativeFieldResolution').nativeFieldDisplayOnly(canonical)
                ? { readonly: true } : {}),
            currentPostCount: 0,
            targetPostCount: 0,
            trailingCommentInsertIndex: targetLayout.records.length,
            inputFormProjection: {
                currentCardIndexes,
                targetCardIndexes,
                currentRecordIds: currentRecords.map(record => record.recordMigrationId),
                targetRecordIds: targetRecords.map(record => record.recordMigrationId),
                currentSnapshot: currentState?.formSnapshot,
                targetSnapshot: targetState?.formSnapshot,
                ruleId: rule.catalogRuleId,
                nativeForm: rule.nativeForm || rule,
                branchEvidence: fileKind ? 'native-file-reader' : recordSelection ? 'record-selection' :
                    (rule.states?.length || rule.cards.some(card => card.when)) ? 'predicate' : 'static',
                controlValues: targetValues,
            },
        });
        return result.inputFormProjection;
    }

    function keywordManagerFieldProjection(document, keywordLine, result, drafts = {}, selectedFieldId = null) {
        if (String(result.plan?.reason || '').startsWith('lspp-input-form-source-layout-')) {
            const unresolved = keywordManagerUnresolvedSource(document, keywordLine, result);
            result.structureDiagnostic = unresolved.diagnostic;
            result.unresolvedRecords = unresolved.unresolvedRecords;
            return { cards: unresolved.cards, selectedFieldId: unresolved.selectedFieldId };
        }
        const inputFormat = keywordInputFormat(
            String(document.lineAt(keywordLine).text || ''),
            documentGlobalInputFormat(document),
        );
        const inputFormProjection = result?.inputFormProjection;
        const records = inputFormProjection ? result?.targetLayout?.records || [] : result?.currentLayout?.records || [];
        const sourceRecords = result?.block?.records || [];
        const nativeForm = inputFormProjection?.nativeForm || null;
        const nativeReading = nativeForm
            ? require('../../core/semantics/nativeFileReadContext').nativeFileReadContext(
                nativeForm, document.lineAt(keywordLine).text, sourceRecords.map(record => record.text),
                documentGlobalInputFormat(document))
            : null;
        if (nativeReading?.readInputFailure) return { cards: [], selectedFieldId: null, reason: nativeReading.readInputFailure };
        const readInput = nativeReading?.readInput || inputFormat;
        const nativeCards = nativeReading?.cards || new Map<number, any>();
        const nativeControlStates = new Map<string, any>((inputFormProjection?.targetSnapshot?.controls || [])
            .map(control => [String(control.controlId || ''), control]));
        const supportedFormats = ['standard', 'long', 'i10', 'comma', 'free'];
        const isReadonly = result?.readonly === true || keywordManagerReadonlyUri(document?.uri) || readInput !== inputFormat;
        const editableLayout = !isReadonly && supportedFormats.includes(inputFormat) &&
            (result?.plan?.status !== 'blocked' || result?.plan?.reason === 'lspp-input-form-field-draft-invalid') &&
            result?.plan?.applicationMode === 'layout-migration' &&
            (inputFormProjection || records.length >= sourceRecords.length) && records.every(record =>
                record?.occurrence?.kind === 'exactly-once' && (
                    cardCellModel.isSafeCardGeometry(
                        (record.fields || []).map(field => ({
                            n: field.name,
                            p: field.position,
                            w: field.width,
                            t: field.type,
                        }))) ||
                    record.sharedByteEditing === 'native-shared-bytes-v1'
                ));
        const physicalLines = [];
        let nextPhysicalLine = keywordLine + 1;
        for (const sourceRecord of sourceRecords) {
            nextPhysicalLine += (sourceRecord.comments || []).length;
            physicalLines.push(nextPhysicalLine++);
        }
        const cards = [];
        for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
            const record = records[recordIndex];
            const thermalDefinition = contactThermalRecordDefinition(result.plan?.targetKeyword, record);
            const officialCardIndex = Number.isInteger(record?.lsppCardIndex)
                ? Number(record.lsppCardIndex)
                : recordIndex + 1;
            const sourceIndex = inputFormProjection?.currentRecordIds
                ? inputFormProjection.currentRecordIds.indexOf(record.recordMigrationId)
                : inputFormProjection ? inputFormProjection.currentCardIndexes.indexOf(officialCardIndex) : recordIndex;
            const sourceRecord = sourceIndex >= 0 ? sourceRecords[sourceIndex] : null;
            const physicalLine = sourceIndex >= 0 ? physicalLines[sourceIndex] : keywordLine + 1 + sourceRecords.length;
            const fields = Array.isArray(record?.fields) ? record.fields : [];
            const cardEditable = editableLayout && !!record;
            cards.push({
                cardId: String(record.recordMigrationId),
                title: record.prefixRole === 'identity' ? i18n.get('keywordManagerIdAndTitle')
                    : /^mpp[12]$/.test(record.prefixRole || '') ? i18n.get('keywordManagerMppCard', record.prefixRole.slice(-1))
                    : record.prefixRole === 'base' ? i18n.get('keywordManagerBaseCard', officialCardIndex) : undefined,
                cardIndex: officialCardIndex,
                ...(Number.isInteger(record?.lsppOccurrenceIndex)
                    ? { occurrenceIndex: Number(record.lsppOccurrenceIndex) } : {}),
                line: physicalLine,
                editable: cardEditable,
                reason: cardEditable ? undefined : !supportedFormats.includes(inputFormat)
                    ? `input-format-${inputFormat}` : 'field-geometry-unsupported',
                fields: fields.map((field, fieldIndex) => {
                    const fieldId = String(field.fieldMigrationId || `${recordIndex}:${fieldIndex}`);
                    const syntaxField = fieldIndex === record.recordMarker?.fieldIndex;
                    const geometry = { n: field.name, p: field.position, w: field.width, t: field.type };
                    const recordFormat = sourceRecord ? keywordRecordSerializer.detectRecordFormat(
                        sourceRecord.text,
                        inputFormat === 'long' ? 'long' : inputFormat === 'i10' ? 'i10' : 'standard',
                        fields,
                    ) : 'standard';
                    const sourceFormat = sourceRecord ? keywordRecordSerializer.detectRecordFormat(
                        sourceRecord.text, readInput, fields) : 'standard';
                    const value = sourceRecord
                        ? keywordRecordSerializer.readRecordField(sourceRecord.text, fields, fieldIndex, sourceFormat)
                        : '';
                    const readGeometry = field.nativeReadGeometry && sourceRecord
                        ? keywordRecordSerializer.formattedReadFields(fields, sourceRecord.text, sourceFormat)[fieldIndex] : field;
                    const isSharedByte = record?.sharedByteEditing === 'native-shared-bytes-v1';
                    const overlapIndexes = isSharedByte
                        ? keywordRecordSerializer.overlappingFieldIndexes(fields, fieldIndex)
                        : [];
                    const linkedFields = overlapIndexes.map(idx => String(fields[idx]?.name || ''));
                    let draftVal = Object.prototype.hasOwnProperty.call(drafts, fieldId) ? drafts[fieldId] : undefined;
                    const recordDraft = result.recordDrafts?.[record.recordMigrationId];
                    if (draftVal === undefined && recordDraft !== undefined) {
                        const draftValue = keywordRecordSerializer.readRecordField(recordDraft, fields, fieldIndex, recordFormat);
                        if (draftValue !== value) draftVal = draftValue;
                    }
                    if (draftVal === undefined && isSharedByte && result?.plan?.replacementRecords?.[recordIndex]?.text) {
                        const repl = cardCellModel.readCellValue(result.plan.replacementRecords[recordIndex].text, [geometry], 0);
                        if (repl !== value) {
                            draftVal = repl;
                        }
                    }
                    const verifiedPlaceholder = candidate => /^(?:-|\s*)$/.test(String(candidate.name || '')) &&
                        (inputFormProjection?.branchEvidence === 'native-file-reader' ||
                        (nativeForm?.nativeDescriptorExtent?.consumption === 'static-descriptor-records' &&
                        nativeForm.occurrenceGrammar?.sourceSha256 === nativeForm.nativeDescriptorExtent.datasetSha256 &&
                        (nativeForm.occurrenceGrammar?.normalizations || []).some(item =>
                            item.fieldRecordId === candidate.fieldRecordId && item.cardIndex === officialCardIndex &&
                            item.fieldIndex === candidate.fieldIndex && item.output === '')));
                    const nativeField = (nativeCards.get(officialCardIndex)?.fields || []).find(candidate =>
                        Number(candidate.fieldIndex) === fieldIndex &&
                        (String(candidate.name || '').toUpperCase() === String(field.name || '').toUpperCase() ||
                            (String(field.name).toUpperCase() === 'UNUSED' && verifiedPlaceholder(candidate))) &&
                        String(candidate.type) === String(field.type) &&
                        Number(candidate.position) === Number(field.position) &&
                        Number(candidate.width) === Number(field.width));
                    const controlState = nativeControlStates.get(
                        `card-${officialCardIndex}-field-${Number(nativeField?.fieldIndex ?? fieldIndex)}`,
                    );
                    const choices = Array.isArray(controlState?.choices)
                        ? controlState.choices.map(String)
                        : Array.isArray(nativeField?.choices) ? nativeField.choices.map(String) : [];
                    const fieldDefault = nativeField?.defaultValue ?? thermalDefinition?.[fieldIndex]?.d;
                    const defaultValue = fieldDefault == null ? undefined : String(fieldDefault);
                    const controlEnabled = !syntaxField && controlState?.enabled !== false && !(nativeField && verifiedPlaceholder(nativeField));
                    return {
                        fieldId,
                        cardIndex: officialCardIndex,
                        line: physicalLine,
                        name: String(controlState?.label || field.name || ''),
                        type: String(field.type || ''),
                        position: Number(readGeometry.position),
                        width: Number(readGeometry.width),
                        value,
                        diagnostic: keywordManagerValueIssue({ ...field, choices, width: ['comma', 'free'].includes(recordFormat) ? Number(field.width) : Number(readGeometry.width) },
                            draftVal ?? value, draftVal === undefined ? 'original' : 'draft', document, physicalLine),
                        ...(linkedFields.length > 0 ? { linkedFields } : {}),
                        ...(draftVal !== undefined ? { draft: draftVal } : {}),
                        ...(choices.length > 0 ? { choices } : {}),
                        ...(defaultValue !== undefined ? { defaultValue } : {}),
                        visible: !syntaxField && controlState?.visible !== false,
                        enabled: controlEnabled,
                        editable: cardEditable && controlEnabled,
                        reason: cardEditable && controlEnabled ? undefined : controlEnabled
                            ? (!supportedFormats.includes(inputFormat) ? `input-format-${inputFormat}` : 'field-geometry-unsupported')
                            : 'lspp-control-disabled',
                    };
                }),
            });
        }
        const flat = cards.flatMap(card => card.fields);
        const selected = flat.some(field => field.fieldId === selectedFieldId)
            ? selectedFieldId : flat[0]?.fieldId || null;
        return { cards, selectedFieldId: selected };
    }

    const { resolveManagerSchemaField: keywordManagerResolveSchemaField,
        managerHelpLookups } = require('../../core/hover/managerFieldHelpResolution');

    function keywordManagerReadFieldHelp(model, editor, request) {
        if (!model || !editor || model.stale || editor.document.version !== model.documentVersion ||
            documentUriIdentity(editor.document) !== model.uri || request.instanceId !== model.selectedInstanceId ||
            !model.managerCards?.some(card => card.fields.some(field => field.fieldId === request.fieldId))) return null;
        return keywordManagerHelpState({ ...model, selectedFieldId: request.fieldId });
    }

    function keywordManagerHelpState(model) {
        const context = model?.helpContext;
        const unresolvedForm = model?.inputFormResolution && model.inputFormResolution.status !== 'resolved' && !context;
        const selectedCard = (model?.managerCards || []).find(card =>
            (card.fields || []).some(field => field.fieldId === model?.selectedFieldId));
        const selected = selectedCard?.fields.find(field => field.fieldId === model.selectedFieldId);
        if (!selected) return { status: 'none', fieldId: null,
            ...(unresolvedForm ? { reason: 'form-unresolved' } : {}) };
        const records = model.targetLayout?.records || model.currentLayout?.records || [];
        const record = records.find(record => record.fields?.some(field => field.fieldMigrationId === selected.fieldId));
        if (context?.branchEvidence === 'record-selection' || context?.branchEvidence === 'native-file-reader' ||
            context?.nativeForm?.nativeDescriptorExtent?.consumption === 'static-descriptor-records') {
            const nativeCards = nativeFileLayoutCards(context.nativeForm, model.currentKeyword || model.targetKeyword);
            const nativeCard = record?.lsppCardIndex === 0
                ? nativeSpellingBinding(model.currentKeyword || model.targetKeyword)?.prefixCard || nativeCards.find(card => card.cardIndex === 0)
                : nativeCards.find(card => card.cardIndex === record?.lsppCardIndex);
            const index = record?.fields?.findIndex(field => field.fieldMigrationId === selected.fieldId);
            const nativeField = nativeCard?.fields?.find(field => field.fieldIndex === index &&
                (field.name === selected.name || (selected.name === 'UNUSED' && /^(?:-|\s*)$/.test(String(field.name || '')))));
            const english = String(nativeField?.help || '').trim();
            const description = /^[\s.-]*$/.test(english) ? undefined : english;
            const defaultValue = selected.defaultValue == null ? undefined : String(selected.defaultValue);
            const choices = Array.isArray(selected.choices) ? selected.choices.map(String) : [];
            const controller = !context.nativeForm.recordSelection || context.nativeForm.recordSelection.prefixCardIndexes?.includes(record?.lsppCardIndex)
                ? undefined : selectedCard.fields[context.nativeForm.recordSelection.controllerFieldIndex];
            const contextKey = nodeCrypto.createHash('sha256').update(JSON.stringify([
                context.nativeForm.catalogSource?.datasetSha256, selected.fieldId,
                nativeField?.fieldRecordId, controller?.draft ?? controller?.value, description,
            ])).digest('hex');
            return { status: description || defaultValue !== undefined || choices.length ? 'ready' : 'unavailable',
                fieldId: selected.fieldId, name: selected.name, schemaName: nativeField?.name,
                schemaKeyword: String(context.nativeForm.recordSelection?.keyword || model.targetKeyword || model.currentKeyword).replace(/^\*/, ''), english: description,
                localized: description ? keywordSchema.getLocalizedHelpForText(description) || undefined : undefined,
                reason: description ? undefined : 'description-missing', defaultValue, choices, contextKey };
        }
        const originalNames = new Map(records.flatMap(record => (record.fields || [])
            .map(field => [field.fieldMigrationId, field.name])));
        const withOriginalName = field => ({ ...field, originalName: originalNames.get(field.fieldId) });
        const keyword = model.targetKeyword || model.currentKeyword;
        const lookupCandidates = managerHelpLookups(keyword, getFieldData(), context?.nativeForm);
        const currentRecord = (model.currentLayout?.records || []).some(source => source.recordMigrationId === record?.recordMigrationId);
        let reason = unresolvedForm ? 'form-unresolved' : undefined;
        // A raw static form can contain every alternate card. A padded target record
        // is not evidence that its branch is active; predicates/selectors are evidence.
        if (!reason && context?.branchEvidence === 'static' && record && !currentRecord &&
            model.currentLayout?.records?.length > 0) reason = 'branch-unverified';
        const option = selectedCard.fields.find(field => field.name === 'OPTION');
        const optionValue = String(option?.draft ?? option?.value ?? '').trim().toUpperCase();
        // The TRIM schema's last four slots describe PARTSET. SPHERE/PLANE/etc.
        // re-use them with different meanings even if the generic UI says PSID/DIST.
        if (!reason && keyword.replace(/^\*/, '').replace(/_(ID|TITLE)$/, '') === 'ALE_STRUCTURED_MESH_TRIM' &&
            selected.position >= 40 && optionValue !== 'PARTSET') reason = 'branch-help-missing';
        const results = reason ? [] : lookupCandidates.map(lookup => ({ lookup,
            field: keywordManagerResolveSchemaField(lookup, withOriginalName(selected),
                { ...selectedCard, fields: selectedCard.fields.map(withOriginalName) }, !!context),
        })).filter(result => result.field);
        const definition = result => JSON.stringify([result.field.n, result.field.t,
            keywordSchema.getEnglishFieldHelp(result.field), keywordSchema.getLocalizedFieldHelp(result.field)]);
        const resolved = results.length && results.every(result => definition(result) === definition(results[0])) ? results[0] : null;
        const schemaField = resolved?.field;
        const english = keywordSchema.getEnglishFieldHelp(schemaField);
        const localized = keywordSchema.getLocalizedFieldHelp(schemaField);
        if (!reason && !schemaField) reason = context ? 'branch-help-missing' : 'field-unmatched';
        if (!reason && !english && !localized) reason = 'description-missing';
        const choices = Array.isArray(selected.choices) ? selected.choices.map(String) : [];
        const defaultValue = selected.defaultValue == null ? undefined : String(selected.defaultValue);
        const contextKey = nodeCrypto.createHash('sha256').update(JSON.stringify([
            keyword, context?.nativeForm?.catalogRuleId, context?.nativeForm?.catalogSource?.datasetSha256,
            context?.ruleId, context?.controlValues, context?.targetSnapshot, model.targetLayout?.profileId,
            record?.recordMigrationId, selected.fieldId, selectedCard.fields.map(field => field.name),
            optionValue, resolved?.lookup.inputName, schemaField?.hi, english, localized, reason,
        ])).digest('hex');
        return {
            status: english || localized || defaultValue !== undefined || choices.length ? 'ready' : 'unavailable',
            fieldId: selected.fieldId, name: selected.name, schemaName: schemaField?.n,
            schemaKeyword: resolved?.lookup.canonicalName, reason, contextKey,
            english: english || undefined, localized: localized || undefined, defaultValue, choices,
        };
    }

    function keywordManagerHasStaging(model) {
        if (!model) return false;
        const normalizeKeyword = value => String(value || '').trim().toUpperCase();
        return Object.keys(model.fieldDrafts || {}).length > 0 ||
            Object.keys(model.draftControlState || {}).length > 0 ||
            model.dynamicCardsSelected === true ||
            normalizeKeyword(model.targetKeyword) !== normalizeKeyword(model.currentKeyword) ||
            Number(model.targetPostCount || 0) !== Number(model.currentPostCount || 0) ||
            String(model.currentLayout?.profileId || '') !== String(model.targetLayout?.profileId || '');
    }

    function keywordManagerCapabilityProjection(model) {
        const evidence = (...values) => [...new Set(values.flat().filter(value => typeof value === 'string' && value))];
        const claim = (capabilityId, labelKey, availability, write, reason, messageKey, evidenceIds = []) => ({
            capabilityId,
            label: i18n.get(labelKey),
            availability,
            write,
            ...(reason ? { reason } : {}),
            message: i18n.get(messageKey),
            evidenceIds: evidence(evidenceIds),
        });
        const hasSpellingAlternative = (model?.choices || []).some(choice =>
            choice.kind === 'spelling' && choice.enabled === true &&
            String(choice.targetKeyword).toUpperCase() !== model.currentKeyword);
        const plan = model?.plan;
        const fields = (model?.managerCards || []).flatMap(card => card.fields || []);
        const editableFields = fields.filter(field => field.editable);
        const choiceFields = fields.filter(field => Array.isArray(field.choices) && field.choices.length > 0);
        const editableChoiceFields = choiceFields.filter(field => field.editable);
        const layoutEvidence = evidence(model?.grammarId, model?.currentLayout?.profileId, model?.targetLayout?.profileId);
        const dynamicEvidence = evidence(model?.dynamicCards?.layoutId, model?.dynamicCards?.ruleId);
        let capabilities = [
            hasSpellingAlternative
                ? claim('spelling-switch', 'keywordManagerCapabilitySpelling', 'available', true,
                    'ready', 'keywordManagerReasonAvailable', [model?.grammarId])
                : claim('spelling-switch', 'keywordManagerCapabilitySpelling', 'view-only', true,
                    'option-target-unavailable', 'keywordManagerReasonNoAlternative', [model?.grammarId]),
            plan?.applicationMode === 'layout-migration' && plan.status !== 'blocked'
                ? claim('layout-migration', 'keywordManagerCapabilityLayout', 'available', true,
                    'ready', 'keywordManagerReasonAvailable', layoutEvidence)
                : claim('layout-migration', 'keywordManagerCapabilityLayout', plan?.status === 'blocked' ? 'blocked' : 'view-only', true,
                    plan?.reason || 'layout-migration-unavailable', 'keywordManagerReasonLayoutUnavailable', layoutEvidence),
            editableFields.length > 0
                ? claim('fixed-field-edit', 'keywordManagerCapabilityField', 'available', true,
                    'ready', 'keywordManagerReasonAvailable', [model?.currentLayout?.profileId])
                : claim('fixed-field-edit', 'keywordManagerCapabilityField', 'view-only', true,
                    fields[0]?.reason || 'field-geometry-unsupported', 'keywordManagerReasonFieldUnavailable',
                    [model?.currentLayout?.profileId]),
            editableChoiceFields.length > 0
                ? claim('field-choice', 'keywordManagerCapabilityChoice', 'available', true,
                    'ready', 'keywordManagerReasonAvailable', [model?.currentLayout?.profileId,
                        ...editableChoiceFields.map(field => field.fieldId)])
                : claim('field-choice', 'keywordManagerCapabilityChoice', 'view-only', true,
                    'field-choice-unavailable', 'keywordManagerReasonChoiceUnavailable', [model?.currentLayout?.profileId,
                        ...choiceFields.map(field => field.fieldId)]),
            model?.help?.status === 'ready'
                ? claim('field-help', 'keywordManagerCapabilityHelp', 'available', false,
                    'ready', 'keywordManagerReasonAvailable', [model.help.fieldId])
                : claim('field-help', 'keywordManagerCapabilityHelp', 'view-only', false,
                    'field-help-unavailable', 'keywordManagerReasonHelpUnavailable', [model?.selectedFieldId]),
            model?.dynamicCards?.enabled || model?.dynamicCards?.selected
                ? claim('field-driven-card-visibility', 'keywordManagerCapabilityDynamic', 'available', true,
                    'ready', 'keywordManagerReasonAvailable', dynamicEvidence)
                : claim('field-driven-card-visibility', 'keywordManagerCapabilityDynamic',
                    model?.dynamicCards?.status === 'schema-mismatch' || model?.dynamicCards?.status === 'stale'
                        ? 'blocked' : 'view-only', true,
                    model?.dynamicCards?.reason || 'reviewed-dynamic-layout-unavailable',
                    'keywordManagerReasonDynamicUnavailable', dynamicEvidence),
            ...((model?.managerCards || []).some(card => Number.isInteger(card.occurrenceIndex) && card.editable) ? [
                claim('repeat-card-edit', 'keywordManagerCapabilityRepeat', 'available', true,
                    'ready', 'keywordManagerReasonAvailable'),
            ] : []),
        ];
        if (model?.readonly === true) {
            capabilities = capabilities.map(item => item.write ? {
                ...item,
                availability: 'recovery',
                reason: 'document-readonly',
                message: i18n.get('keywordOptionsDocumentReadonly'),
            } : item);
        }
        const editable = capabilities.some(item => item.write && item.availability === 'available');
        const blocked = !editable && capabilities.some(item => item.write && item.availability === 'blocked');
        const editLevel = model?.readonly === true ? 'recovery' : editable ? 'editable' : blocked ? 'blocked' : 'view-only';
        const primary = capabilities.find(item => item.write && item.availability === (blocked ? 'blocked' : 'view-only'));
        return {
            capabilities,
            editLevel,
            reason: editable ? 'ready' : primary?.reason || 'no-reviewed-writer',
            message: editable ? i18n.get('keywordManagerReasonAvailable') :
                primary?.message || i18n.get('keywordOptionsTreeReadOnly'),
        };
    }

    function keywordManagerEditField(model, fieldId: string, value: string) {
        if (!model || typeof fieldId !== 'string') return null;
        if (['native-read-window-write-unverified', 'native-file-write-unverified'].includes(model.plan?.reason)) return null;
        const rawValue = String(value ?? '');
        if (/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|,/.test(rawValue)) {
            return null;
        }
        const flatFields = (model.managerCards || []).flatMap((c: any) => c.fields || []);
        const field = flatFields.find((f: any) => f.fieldId === fieldId);
        if (!field || field.editable === false) return null;
        if (rawValue.length > Number(field.width)) {
            return null;
        }
        const targetRecords = model.targetLayout?.records || [];
        let recordIndex = -1;
        let fieldIndex = -1;
        for (let rIdx = 0; rIdx < targetRecords.length; rIdx++) {
            const rec = targetRecords[rIdx];
            const fIdx = (rec.fields || []).findIndex((f: any) => f.fieldMigrationId === fieldId);
            if (fIdx >= 0) {
                recordIndex = rIdx;
                fieldIndex = fIdx;
                break;
            }
        }
        if (recordIndex < 0) return null;
        const record = targetRecords[recordIndex];
        const isShared = record.sharedByteEditing === 'native-shared-bytes-v1';
        const fieldDrafts = { ...(model.fieldDrafts || {}) };
        const recordDrafts = { ...(model.recordDrafts || {}) };

        if (model.helpContext?.branchEvidence === 'record-selection') {
            const selection = model.helpContext.nativeForm.recordSelection;
            if (!selection.prefixCardIndexes?.includes(record.lsppCardIndex) && fieldIndex === selection.controllerFieldIndex) {
                const normalize = input => selection.caseInsensitive ? String(input).trim().toUpperCase() : String(input).trim();
                const target = selection.cases.find(item => normalize(item.value) === normalize(rawValue));
                if (!target) return null;
                if (target.cardIndex !== record.lsppCardIndex) {
                    for (const index of selection.clearedFieldIndexesOnCardChange) {
                        const cleared = record.fields[index];
                        if (!cleared) return null;
                        fieldDrafts[cleared.fieldMigrationId] = '';
                    }
                }
            }
            if (rawValue.trim() === String(field.value ?? '').trim()) delete fieldDrafts[fieldId];
            else fieldDrafts[fieldId] = rawValue;
            return { fieldDrafts, recordDrafts };
        }

        if (!isShared) {
            if (rawValue === '') {
                delete fieldDrafts[fieldId];
            } else {
                fieldDrafts[fieldId] = rawValue;
            }
            return { fieldDrafts, recordDrafts };
        }

        const originalText = model.block?.records?.[recordIndex]?.text || ' '.repeat(80);
        const currentText = recordDrafts[record.recordMigrationId] ||
            model.plan?.replacementRecords?.[recordIndex]?.text ||
            originalText;
        const nextText = keywordRecordSerializer.editSharedRecord(
            currentText,
            record.fields || [],
            fieldIndex,
            rawValue,
            'standard'
        );
        if (nextText === null) {
            return null;
        }
        if (nextText === originalText) {
            delete recordDrafts[record.recordMigrationId];
        } else {
            recordDrafts[record.recordMigrationId] = nextText;
        }
        return { fieldDrafts, recordDrafts };
    }

    function keywordManagerStageFieldDrafts(result, drafts = {}, recordDrafts: Record<string, string> = {}) {
        const fieldEntries = Object.entries(drafts || {});
        const recordEntries = Object.entries(recordDrafts || {});
        if (fieldEntries.length === 0 && recordEntries.length === 0) return { changed: 0, details: [] };
        const plan = result?.plan;
        const currentRecords = result?.currentLayout?.records || [];
        const targetRecords = result?.targetLayout?.records || [];
        if (!plan || !Array.isArray(plan.replacementRecords) || targetRecords.length !== plan.replacementRecords.length) {
            return null;
        }
        if (recordEntries.length > 0) {
            if (result.inputFormat && result.inputFormat !== 'standard') return null;
        }
        const details = [];
        const nativeForm = result.inputFormProjection?.nativeForm;
        const nativeCards = recordEntries.length && nativeForm
            ? nativeFileLayoutCards(nativeForm, result.currentKeyword || result.plan.currentKeyword) : [];

        for (const [recordId, draftText] of recordEntries) {
            const recordIndex = targetRecords.findIndex(r => r.recordMigrationId === recordId);
            if (recordIndex < 0) return null;
            const targetRecord = targetRecords[recordIndex];
            const sourceText = result?.block?.records?.[recordIndex]?.text || plan.replacementRecords[recordIndex]?.text || '';
            
            const fields = targetRecord.fields || [];
            const recordFormat = keywordRecordSerializer.detectRecordFormat(sourceText,
                result.inputFormat || 'standard', fields);
            if (targetRecord.recordMarker && !keywordManagerCatalogSourceRecordCompatible({ text: draftText }, targetRecord, true, result.inputFormat || 'standard')) return null;
            if (/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draftText) ||
                (recordFormat === 'comma' && draftText.split(',').length > fields.length)) return null;
            const allowedMask = new Array(Math.max(draftText.length, sourceText.length)).fill(false);
            for (const field of fields) {
                for (let i = field.position; i < field.position + field.width; i++) {
                    allowedMask[i] = true;
                }
            }
            for (let i = 0; i < Math.max(draftText.length, sourceText.length); i++) {
                const c1 = draftText[i] || ' ';
                const c2 = sourceText[i] || ' ';
                if (c1 !== c2 && !allowedMask[i]) {
                    return null;
                }
            }

            plan.replacementRecords[recordIndex].text = draftText;

            for (const [fieldIndex, field] of fields.entries()) {
                const beforeSlice = recordFormat === 'comma'
                    ? keywordRecordSerializer.readRecordField(sourceText, fields, fieldIndex, recordFormat)
                    : sourceText.slice(field.position, field.position + field.width);
                const afterSlice = recordFormat === 'comma'
                    ? keywordRecordSerializer.readRecordField(draftText, fields, fieldIndex, recordFormat)
                    : draftText.slice(field.position, field.position + field.width);
                if (beforeSlice !== afterSlice) {
                    const card = nativeCards.find(card => card.cardIndex === targetRecord.lsppCardIndex);
                    const nativeField = card?.fields?.find(candidate => candidate.position === field.position && candidate.width === field.width);
                    const sourceLine = (result.plan.keywordLine || 0) + 1 + (result.block?.records || []).slice(0, recordIndex)
                        .reduce((n, record) => n + 1 + (record.comments || []).length, 0) + (result.block?.records?.[recordIndex]?.comments || []).length;
                    const issue = keywordManagerValueIssue({ ...field, choices: nativeField?.choices }, afterSlice,
                        'draft', result.validationDocument, sourceLine);
                    if (issue?.blocksApply) return null;
                    const beforeTrimmed = beforeSlice.trim();
                    const afterTrimmed = afterSlice.trim();
                    let beforeDisplay: string;
                    let afterDisplay: string;
                    if (beforeTrimmed === afterTrimmed) {
                        beforeDisplay = beforeSlice.replace(/ /g, '·');
                        afterDisplay = afterSlice.replace(/ /g, '·');
                    } else {
                        beforeDisplay = beforeTrimmed;
                        afterDisplay = afterTrimmed;
                    }
                    details.push({
                        fieldId: field.fieldMigrationId,
                        name: field.name,
                        before: beforeDisplay,
                        after: afterDisplay,
                        sharedByte: true,
                    });
                }
            }
        }

        const targetIdBySourceId = new Map((plan.migratedFields || []).map(field => [
            field.sourceFieldMigrationId,
            field.targetFieldMigrationId,
        ]));
        const currentByFieldId = new Map();
        for (let recordIndex = 0; recordIndex < currentRecords.length; recordIndex++) {
            const record = currentRecords[recordIndex];
            for (const field of record.fields || []) {
                currentByFieldId.set(field.fieldMigrationId, { field, recordIndex });
            }
        }
        const targetLocations = new Map();
        for (let recordIndex = 0; recordIndex < targetRecords.length; recordIndex++) {
            for (let fieldIndex = 0; fieldIndex < (targetRecords[recordIndex].fields || []).length; fieldIndex++) {
                const field = targetRecords[recordIndex].fields[fieldIndex];
                targetLocations.set(field.fieldMigrationId, { recordIndex, fieldIndex, field });
            }
        }
        for (const [sourceFieldId, rawValue] of fieldEntries) {
            const sourceEntry = currentByFieldId.get(sourceFieldId);
            const targetFieldId = targetIdBySourceId.get(sourceFieldId) || sourceFieldId;
            const location = targetLocations.get(targetFieldId);
            if (!location) return null;
            if (location.fieldIndex === targetRecords[location.recordIndex].recordMarker?.fieldIndex) return null;
            const sourceField = sourceEntry?.field || location.field;
            const value = String(rawValue ?? '').trim();
            const recordFields = targetRecords[location.recordIndex].fields;
            const sourceLine = (result.plan.keywordLine || 0) + 1 + (result.block?.records || []).slice(0, location.recordIndex)
                .reduce((n, record) => n + 1 + (record.comments || []).length, 0) +
                (result.block?.records?.[location.recordIndex]?.comments || []).length;
            const validationFormat = keywordRecordSerializer.detectRecordFormat(plan.replacementRecords[location.recordIndex].text,
                result.inputFormat || 'standard', recordFields);
            const validationField = ['comma', 'free'].includes(validationFormat) ? location.field : keywordRecordSerializer.formattedReadFields(recordFields,
                plan.replacementRecords[location.recordIndex].text, validationFormat)[location.fieldIndex];
            const valueIssue = keywordManagerValueIssue({ ...location.field, width: validationField.width },
                String(rawValue ?? ''), 'draft', result.validationDocument, sourceLine);
            if (valueIssue?.blocksApply) return null;
            if (!sourceField || /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
                value.length > Number(validationField.width)) return null;
            const targetCard = targetRecords[location.recordIndex].fields.map(field => ({
                n: field.name, p: field.position, w: field.width, t: field.type,
            }));
            if (!cardCellModel.isSafeCardGeometry(targetCard)) return null;
            const replacement = plan.replacementRecords[location.recordIndex];
            const targetRecordFields = targetRecords[location.recordIndex].fields || [];
            const recordFormat = keywordRecordSerializer.detectRecordFormat(
                replacement.text,
                result?.inputFormat === 'long' ? 'long' : result?.inputFormat === 'i10' ? 'i10' : 'standard',
                targetRecordFields,
            );
            const before = recordFormat === 'standard' && !targetRecords[location.recordIndex].sharedByteEditing
                ? cardCellModel.readCellValue(replacement.text, targetCard, location.fieldIndex)
                : keywordRecordSerializer.readRecordField(replacement.text, targetRecordFields, location.fieldIndex, recordFormat);
            const writtenText = recordFormat === 'standard' && !targetRecords[location.recordIndex].sharedByteEditing
                ? cardCellModel.writeCellR1(replacement.text, targetCard, location.fieldIndex, value)
                : keywordRecordSerializer.writeRecordField(replacement.text, targetRecordFields, location.fieldIndex, value, recordFormat);
            if (writtenText === null) return null;
            replacement.text = writtenText;
            const after = recordFormat === 'standard' && !targetRecords[location.recordIndex].sharedByteEditing
                ? cardCellModel.readCellValue(replacement.text, targetCard, location.fieldIndex)
                : keywordRecordSerializer.readRecordField(replacement.text, targetRecordFields, location.fieldIndex, recordFormat);
            if (after !== value) return null;
            if (before !== after) details.push({ fieldId: sourceFieldId, name: sourceField.name, before, after });
        }
        if (details.length > 0 && (plan.status === 'no-change' || plan.status === 'ready')) {
            plan.status = 'ready';
            plan.reason = 'fixed-field-drafts';
            plan.blockers = [];
        }
        plan.fieldChanges = details;
        return { changed: details.length, details };
    }

    function buildKeywordOptionSwitchPlan(document, keywordLine, targetKeyword, targetPostCount = null, options: any = {}) {
        const provisional = options.provisional === true;
        const keywordText = String(document.lineAt(keywordLine).text || '');
        const currentKeyword = keywordSpellingFromLine(keywordText);
        const metadata: any = {
            documentVersion: document.version,
            uri: documentUriIdentity(document),
            keywordLine,
            sourceLockIdentity: loadKeywordOptionGrammarRuntime()?.datasetReleaseId || null,
        };
        if (!currentKeyword || classifyOpaqueCommentDirective(keywordText)) {
            return { plan: blockedKeywordOptionSwitchPlan(currentKeyword, targetKeyword, 'opaque-or-invalid-keyword', metadata) };
        }
        const inputFormat = keywordInputFormat(keywordText, documentGlobalInputFormat(document));
        const block = collectOptionSwitchBlock(document, keywordLine, options);
        const currentGrammar = lookupOperationalKeywordOptionGrammar(currentKeyword);
        const targetGrammar = lookupOperationalKeywordOptionGrammar(targetKeyword);
        const currentTarget = keywordOptionTarget(currentGrammar, currentKeyword);
        const target = keywordOptionTarget(targetGrammar, targetKeyword);
        if (!currentGrammar || !targetGrammar || currentGrammar.grammarId !== targetGrammar.grammarId ||
            !currentTarget || !target) {
            const nativeForm = currentKeyword === String(targetKeyword || '').toUpperCase() && block.status === 'ready'
                ? keywordManagerCatalogNativeFormRule(currentKeyword) : null;
            const nativeCards = (nativeForm?.cards || []).map(card => (card.fields || []).map(field => ({
                n: /^(?:-|\s*)$/.test(String(field.name || '')) ? 'UNUSED' : field.name,
                t: field.type,
                p: field.position,
                w: field.width,
            })));
            if (inputFormat === 'standard' && nativeCards.length > 0 && nativeCards.length === block.records.length &&
                nativeCards.every(card => cardCellModel.isSafeCardGeometry(card))) {
                const canonical = String(currentKeyword).replace(/^\*/, '').toUpperCase();
                const layout = {
                    profileId: `lspp-v4-fixed-layout:${canonical}`,
                    keyword: currentKeyword,
                    inputFormat: 'standard-fixed',
                    sourceIdentity: {
                        canonicalKeyword: canonical,
                        fieldSchema: 'lspp-input-form-v4',
                        datasetSha256: nativeForm.catalogSource?.datasetSha256,
                    },
                    records: nativeCards.map((card, index) => {
                        const record: any = legacyOptionRecord(card, `lspp-v4:${canonical}:${index}`);
                        record.lsppCardIndex = Number(nativeForm.cards[index].cardIndex);
                        return record;
                    }),
                };
                metadata.sourceLockIdentity = [metadata.sourceLockIdentity, layout.profileId,
                    nativeForm.catalogSource?.datasetSha256 || ''].join(':');
                const plan = planOptionSwitch({
                    currentKeyword,
                    targetKeyword: currentKeyword,
                    currentLayout: layout,
                    targetLayout: layout,
                    records: block.records,
                    documentVersion: document.version,
                    uri: metadata.uri,
                    keywordLine,
                    sourceLockIdentity: metadata.sourceLockIdentity,
                    inputFormat: 'standard',
                    maxBytes: OPTION_SWITCH_MAX_BYTES,
                });
                return {
                    block, currentPostCount: 0, targetPostCount: 0,
                    currentLayout: layout, targetLayout: layout, plan,
                    trailingCommentInsertIndex: block.records.length,
                };
            }
            return { block, plan: blockedKeywordOptionSwitchPlan(currentKeyword, targetKeyword, 'official-field-migration-binding-unavailable', metadata) };
        }
        const preserveBlock = (fallbackReason, extra: any = {}) => {
            const readableBlock = block.status === 'ready' ? block : {
                status: 'ready', blockEnd: keywordLine + 1, records: [], trailingComments: [],
            };
            metadata.applicationMode = 'keyword-only-preserve-block';
            metadata.sourceLockIdentity = [metadata.sourceLockIdentity, currentGrammar.grammarId,
                'keyword-only-preserve-block'].join(':');
            const emptyCurrentLayout = { profileId: `keyword-only:${currentKeyword}`, keyword: currentKeyword, records: [] };
            const emptyTargetLayout = { profileId: `keyword-only:${targetKeyword}`, keyword: targetKeyword, records: [] };
            const plan = planOptionSwitch({
                currentKeyword,
                targetKeyword,
                currentLayout: emptyCurrentLayout,
                targetLayout: emptyTargetLayout,
                records: readableBlock.records,
                documentVersion: document.version,
                uri: metadata.uri,
                keywordLine,
                sourceLockIdentity: metadata.sourceLockIdentity,
                inputFormat,
                maxBytes: OPTION_SWITCH_MAX_BYTES,
                applicationMode: 'keyword-only-preserve-block',
            });
            plan.fallbackReason = fallbackReason;
            return {
                block: readableBlock, currentGrammar, targetGrammar, currentTarget, target,
                currentPostCount: 0, targetPostCount: 0,
                currentLayout: emptyCurrentLayout, targetLayout: emptyTargetLayout, plan,
                trailingCommentInsertIndex: readableBlock.records.length,
                ...extra,
            };
        };
        if (block.status !== 'ready') return preserveBlock(block.reason);
        if (inputFormat !== 'standard') return preserveBlock('non-standard-input');
        if (provisional && (/[+%\-]$/.test(keywordText.trim().split(/[\s,]/)[0] || '') ||
            block.records.some(record => String(record.text || '').includes(',')))) {
            return preserveBlock('marked-or-comma-input', { provisional: true });
        }
        if (provisional) {
            const currentCandidates = (currentTarget.layouts || []).filter(candidate =>
                candidate?.layout && Array.isArray(candidate.layout.records));
            const matchingCurrent = currentCandidates.filter(candidate =>
                candidate.layout.records.length === block.records.length);
            const currentCandidate = matchingCurrent.length === 1
                ? matchingCurrent[0]
                : currentCandidates.length === 1 ? currentCandidates[0] : null;
            const currentLayout = currentCandidate?.layout || {
                profileId: `provisional:${currentKeyword}`,
                keyword: currentKeyword,
                records: [],
            };
            const currentPostCount = Number.isInteger(currentCandidate?.postCount)
                ? currentCandidate.postCount
                : 0;
            const selectedPostCount = Number.isInteger(targetPostCount) ? targetPostCount : currentPostCount;
            const targetCandidates = (target.layouts || []).filter(candidate =>
                candidate?.layout && Array.isArray(candidate.layout.records));
            const matchingTarget = targetCandidates.filter(candidate => candidate.postCount === selectedPostCount);
            const targetCandidate = matchingTarget.length === 1
                ? matchingTarget[0]
                : targetCandidates.length === 1 ? targetCandidates[0] : null;
            const targetLayout = targetCandidate?.layout || {
                profileId: `provisional:${targetKeyword}`,
                keyword: targetKeyword,
                records: [],
            };
            metadata.sourceLockIdentity = [metadata.sourceLockIdentity, 'provisional-v1',
                currentLayout.profileId, targetLayout.profileId].join(':');
            const plan = planProvisionalOptionSwitch({
                currentKeyword,
                targetKeyword,
                currentLayout,
                targetLayout,
                records: block.records,
                documentVersion: document.version,
                uri: metadata.uri,
                keywordLine,
                sourceLockIdentity: metadata.sourceLockIdentity,
                inputFormat: 'standard',
                maxBytes: OPTION_SWITCH_MAX_BYTES,
            });
            if (plan.status === 'blocked') return preserveBlock(plan.reason, { provisional: true });
            const sourceRecordIds = new Set(currentLayout.records.map(record => record.recordMigrationId));
            const retainedTargetIndexes = targetLayout.records
                .map((record, index) => sourceRecordIds.has(record.recordMigrationId) ? index : -1)
                .filter(index => index >= 0);
            return {
                block, currentGrammar, targetGrammar, currentTarget, target,
                currentPostCount, targetPostCount: selectedPostCount,
                currentLayout, targetLayout, plan,
                trailingCommentInsertIndex: retainedTargetIndexes.length
                    ? Math.max(...retainedTargetIndexes) + 1
                    : block.records.length,
                provisional: true,
            };
        }
        if (currentTarget.applicationMode === 'keyword-only-preserve-block' ||
            target.applicationMode === 'keyword-only-preserve-block') {
            return preserveBlock('layout-unavailable');
        }
        const currentLayouts = currentTarget.layouts || [];
        const inferredLayouts = currentLayouts.filter(candidate =>
            candidate.layout?.records?.length === block.records.length);
        const currentPostCount = inferredLayouts.length === 1 ? inferredLayouts[0].postCount : null;
        if (!Number.isInteger(currentPostCount)) {
            return { block, plan: blockedKeywordOptionSwitchPlan(currentKeyword, targetKeyword,
                'record-count-unresolved', metadata) };
        }
        const selectedPostCount = Number.isInteger(targetPostCount) ? targetPostCount : currentPostCount;
        const currentCandidate = keywordOptionLayoutCandidate(currentGrammar, currentKeyword, currentPostCount);
        const targetCandidate = keywordOptionLayoutCandidate(targetGrammar, targetKeyword, selectedPostCount);
        const currentLayout = currentCandidate?.layout;
        const targetLayout = targetCandidate?.layout;
        if (!currentLayout || !targetLayout) {
            return { block, currentPostCount,
                plan: blockedKeywordOptionSwitchPlan(currentKeyword, targetKeyword,
                    'official-layout-unverified', metadata) };
        }
        const currentCanonical = String(currentLayout.sourceIdentity?.canonicalKeyword ||
            currentLayout.sourceIdentity?.canonicalSectionId || '').toUpperCase();
        const targetCanonical = String(targetLayout.sourceIdentity?.canonicalKeyword ||
            targetLayout.sourceIdentity?.canonicalSectionId || '').toUpperCase();
        if (!currentCanonical || !targetCanonical || currentCanonical !== targetCanonical) {
            return preserveBlock('layout-identity-mismatch', { currentPostCount, currentLayout, targetLayout });
        }
        metadata.sourceLockIdentity = [metadata.sourceLockIdentity, currentGrammar.grammarId,
            currentLayout.profileId, targetLayout.profileId].join(':');
        const plan = planOptionSwitch({
            currentKeyword,
            targetKeyword,
            currentLayout,
            targetLayout,
            records: block.records,
            documentVersion: document.version,
            uri: metadata.uri,
            keywordLine,
            sourceLockIdentity: metadata.sourceLockIdentity,
            inputFormat: 'standard',
            maxBytes: OPTION_SWITCH_MAX_BYTES,
            analyzeComment: optionSwitchCommentAnalysis,
            generateComment: optionSwitchCommentLine,
            bindings: targetCandidate.bindings || [],
        });
        if (plan.status === 'blocked') return { block, currentPostCount, currentLayout, targetLayout, plan };
        const sourceRecordIds = new Set(currentLayout.records.map(record => record.recordMigrationId));
        const retainedTargetIndexes = targetLayout.records
            .map((record, index) => sourceRecordIds.has(record.recordMigrationId) ? index : -1)
            .filter(index => index >= 0);
        const trailingCommentInsertIndex = retainedTargetIndexes.length
            ? Math.max(...retainedTargetIndexes) + 1
            : 0;
        return {
            block, currentGrammar, targetGrammar, currentTarget, target, currentPostCount,
            targetPostCount: selectedPostCount, currentLayout, targetLayout, plan,
            trailingCommentInsertIndex,
        };
    }

    function buildKeywordManagerCatalogPlan(document, keywordLine, targetKeyword, options: any = {}) {
        const currentKeyword = keywordSpellingFromLine(document.lineAt(keywordLine).text);
        const block = collectOptionSwitchBlock(document, keywordLine, options);
        const nativeForms = keywordManagerCatalogNativeFormRules(currentKeyword);
        const nativeForm = keywordManagerCatalogNativeFormRule(currentKeyword);
        const metadata: any = {
            documentVersion: document.version,
            uri: documentUriIdentity(document),
            keywordLine,
            sourceLockIdentity: nativeForms[0]?.catalogSource?.datasetSha256 || null,
        };
        if (nativeForms.length === 0 || block.status !== 'ready') {
            return { block, plan: blockedKeywordOptionSwitchPlan(
                currentKeyword, targetKeyword, nativeForms.length ? block.reason : 'lspp-input-form-catalog-unavailable', metadata,
            ) };
        }
        const canonical = String(currentKeyword).replace(/^\*/, '').toUpperCase();
        const records = (nativeForm?.cards || []).map(card => {
            const record: any = legacyOptionRecord((card.fields || []).map(field => ({
                n: /^(?:-|\s*)$/.test(String(field.name || '')) ? 'UNUSED' : field.name,
                t: field.type,
                p: field.position,
                w: field.width,
            })), `lspp-input:${canonical}:card:${card.cardIndex}`, true);
            record.lsppCardIndex = Number(card.cardIndex);
            return record;
        });
        const layout = {
            profileId: `lspp-input-form:${canonical}:catalog-base`,
            keyword: currentKeyword,
            inputFormat: 'standard-fixed',
            sourceIdentity: {
                canonicalKeyword: canonical,
                fieldSchema: 'lspp-native-input-form',
                datasetSha256: nativeForms[0]?.catalogSource?.datasetSha256,
            },
            records,
        };
        const plan = planOptionSwitch({
            currentKeyword,
            targetKeyword,
            currentLayout: layout,
            targetLayout: layout,
            records: block.records,
            documentVersion: document.version,
            uri: metadata.uri,
            keywordLine,
            sourceLockIdentity: metadata.sourceLockIdentity,
            inputFormat: keywordInputFormat(
                String(document.lineAt(keywordLine).text || ''), documentGlobalInputFormat(document),
            ),
            maxBytes: OPTION_SWITCH_MAX_BYTES,
            analyzeComment: optionSwitchCommentAnalysis,
            generateComment: optionSwitchCommentLine,
        });
        plan.provisional = options.provisional === true;
        return {
            block, currentPostCount: 0, targetPostCount: 0,
            currentLayout: layout, targetLayout: layout, plan,
            trailingCommentInsertIndex: block.records.length,
        };
    }

    function buildKeywordOptionViewModel(editor, requestedLine = null, staged: any = {}) {
        const previous = keywordManagerModelForms;
        keywordManagerModelForms = new WeakMap();
        try {
            return buildKeywordOptionViewModelInScope(editor, requestedLine, staged);
        } finally {
            keywordManagerModelForms = previous;
        }
    }

    function buildKeywordOptionViewModelInScope(editor, requestedLine = null, staged: any = {}) {
        const document = editor?.document;
        if (!document || !isLsdynaFile(document)) return null;
        const line = Number.isInteger(requestedLine)
            ? requestedLine
            : Number.isInteger(editor.selection?.active?.line) ? editor.selection.active.line : 0;
        if (!isActiveLsdynaSemanticLocation(document, { line, character: 0 }, { requireLiveSnapshot: true })) return null;
        const candidateIndex = staged.blockIndex !== undefined ? staged.blockIndex : readyCardEditBlockIndex(document);
        const blockIndex = candidateIndex?.lineCount === document.lineCount ? candidateIndex : null;
        const indexed = blockIndex?.lineCount === document.lineCount ? blockIndex.findBlockAtLine?.(line) : null;
        const keywordLine = isKeywordLineText(document.lineAt(line).text)
            ? line
            : indexed && Number.isInteger(indexed.startLine)
                ? indexed.startLine
                : document.lineCount > LARGE_DOCUMENT_LINE_THRESHOLD ? null : findKeywordLineForLine(document, line);
        if (!Number.isInteger(keywordLine)) return null;
        const currentKeyword = keywordSpellingFromLine(document.lineAt(keywordLine).text);
        if (!currentKeyword) return null;
        keywordManagerCatalogCatalogFailure = '';
        const catalogForm = keywordManagerCatalogCatalogForm(currentKeyword);
        const grammar = null;
        // Native geometry owns fields; source-locked prefix rules add file syntax.
        const dimensions = [];
        let selection = staged.selection && typeof staged.selection === 'object'
            ? Object.fromEntries(Object.entries(staged.selection).map(([slot, values]) => [
                slot, (Array.isArray(values) ? values : [values]).map(value => String(value).toUpperCase()),
            ]))
            : null;
        let selectionState = 'exact';
        let targetKeyword = String(staged.targetKeyword || currentKeyword).toUpperCase();
        const selectorRule = keywordManagerCatalogSelectorRule(currentKeyword);
        const selectorSeedBlock = selectorRule ? collectOptionSwitchBlock(document, keywordLine, { blockIndex }) : null;
        if (selectorSeedBlock) {
            let physical = keywordLine + 1;
            Object.assign(selectorSeedBlock, {inputFormat:keywordInputFormat(document.lineAt(keywordLine).text, documentGlobalInputFormat(document)),
                parameterContext:nativeParameterContextForDocument(document),
                recordLines:selectorSeedBlock.records.map(r=>{physical += (r.comments || []).length; return physical++;})});
        }
        const inferredInputFormSelections = keywordManagerInferCatalogSelectorSelections(
            selectorRule, currentKeyword, grammar, selectorSeedBlock,
        );
        const currentControlState = Object.fromEntries(Object.entries(inferredInputFormSelections)
            .map(([controlId, value]) => [controlId, typeof value === 'boolean' ? value : String(value ?? '')]));
        const draftControlState = staged.draftControlState && typeof staged.draftControlState === 'object'
            ? Object.fromEntries(Object.entries(staged.draftControlState).map(([controlId, value]) =>
                [controlId, typeof value === 'boolean' ? value : String(value ?? '')])) : {};
        const resolvedTargetState = { ...currentControlState, ...draftControlState };
        if (selectorRule && Object.keys(resolvedTargetState).length > 0) {
            const selectorSpelling = keywordManagerCatalogSelectorSpelling(selectorRule, resolvedTargetState);
            // An unchanged selector must preserve a verified native alias. A real
            // form transition (for example TITLE) still determines the spelling.
            targetKeyword = preserveEquivalentNativeSpelling(
                keywordManagerCatalogNativeFormRule(currentKeyword), currentKeyword, targetKeyword, selectorSpelling,
            );
        }
        let requestedPostCount = staged.targetPostCount;
        const provisional = staged.provisional === true;
        const baseResult: any = buildKeywordManagerCatalogPlan(
            document,
            keywordLine,
            targetKeyword,
            { provisional, blockIndex },
        );
        const currentPostCount = baseResult.currentPostCount || 0;
        const targetPostCount = Number.isInteger(requestedPostCount) ? requestedPostCount : currentPostCount;
        const choices = [];
        const blockEnd = Number.isInteger(baseResult.block?.blockEnd)
            ? baseResult.block.blockEnd
            : keywordLine + 1;
        const dynamicPlan = null;
        const dynamicPreparation: any = { staged: false, changes: [] };
        const dynamicCardsSelected = false;
        const fieldDrafts = staged.fieldDrafts && typeof staged.fieldDrafts === 'object'
            ? Object.fromEntries(Object.entries(staged.fieldDrafts).map(([fieldId, value]) => [fieldId, String(value ?? '')]))
            : {};
        const recordDrafts = staged.recordDrafts && typeof staged.recordDrafts === 'object'
            ? Object.fromEntries(Object.entries(staged.recordDrafts).map(([recordId, text]) => [recordId, String(text ?? '')]))
            : {};
        const selectedFormRuleId = typeof staged.selectedFormRuleId === 'string' ? staged.selectedFormRuleId : null;
        const preparedInputForm = keywordManagerPrepareCatalogInputFormLayout(
            document, keywordLine, baseResult, fieldDrafts, recordDrafts, selectedFormRuleId,
        );
        const preparedSelectors = keywordManagerPrepareCatalogSelectorLayout(
            document, keywordLine, baseResult, resolvedTargetState, false, fieldDrafts,
        );
        if (catalogForm && !preparedInputForm && !preparedSelectors) {
            baseResult.plan.status = 'blocked';
            baseResult.plan.reason = baseResult.inputFormResolution?.status === 'ambiguous'
                ? 'lspp-input-form-source-layout-ambiguous' : 'lspp-input-form-source-layout-unresolved';
            baseResult.plan.blockers = [baseResult.plan.reason];
            baseResult.plan.replacementRecords = [];
        }
        const stagedFields = keywordManagerStageFieldDrafts(baseResult, fieldDrafts, recordDrafts);
        if (stagedFields === null && baseResult.plan.status !== 'blocked') {
            baseResult.plan.status = 'blocked';
            baseResult.plan.reason = 'lspp-input-form-field-draft-invalid';
            baseResult.plan.blockers = [baseResult.plan.reason];
        }
        const nativeForm = baseResult.inputFormProjection?.nativeForm || keywordManagerCatalogNativeFormRule(currentKeyword);
        const nativeSpellings = keywordManagerCatalogEquivalentSpellings(nativeForm, currentKeyword);
        const targets = catalogForm && nativeForm
            ? nativeSpellings.map(spelling => ({ spelling: `*${String(spelling).replace(/^\*/, '')}` }))
            : [];
        for (const optionTarget of targets) {
            const spelling = optionTarget.spelling;
            choices.push({
                id: `spelling:${spelling}`,
                kind: 'spelling',
                slotId: 'official-concrete-spelling',
                label: spelling,
                targetKeyword: spelling,
                selected: spelling === targetKeyword,
                provisional,
                enabled: true,
                description: i18n.get('keywordOptionsTreeEditable'),
            });
        }
        for (const requestedSpelling of new Set([targetKeyword,
            ...(staged.targetKeyword ? [String(staged.targetKeyword).toUpperCase()] : [])])) {
            if (!catalogForm || requestedSpelling === currentKeyword) continue;
            const isEquivalentSpelling = targets.some(target => target.spelling === requestedSpelling);
            const isValidSelectorSpelling = selectorRule && (
                keywordManagerCatalogSelectorSpelling(selectorRule, resolvedTargetState) === requestedSpelling ||
                (selectorRule.selectors || []).reduce((states, selector) => states.flatMap(state => [
                    { ...state, [selector.controlId]: '' },
                    ...(selector.values || []).map(value => ({ ...state, [selector.controlId]: String(value.value) })),
                ]), [{}]).some(selections => keywordManagerCatalogSelectorSpelling(selectorRule, selections) === requestedSpelling)
            );
            if (!isEquivalentSpelling && !isValidSelectorSpelling) {
                baseResult.plan.status = 'blocked';
                baseResult.plan.reason = 'lspp-input-form-target-spelling-unavailable';
                baseResult.plan.blockers = [baseResult.plan.reason];
                baseResult.plan.replacementRecords = [];
            }
        }
        const fieldProjection = keywordManagerFieldProjection(
            document,
            keywordLine,
            baseResult,
            fieldDrafts,
            staged.selectedFieldId,
        );
        if (Object.entries(draftControlState).some(([id,value])=>value!=='' && !selectorRule?.selectors.some(s=>s.controlId===id&&s.values.some(v=>v.value===value)))) {
            baseResult.plan=blockedKeywordOptionSwitchPlan(currentKeyword,targetKeyword,'lspp-selector-spelling-unverified',baseResult.plan);
        }
        const thermalAllowed=contactThermalAllowed(currentKeyword,(name,fallback)=> {
            const field=fieldProjection.cards.flatMap(c=>c.fields).find(f=>f.name===name);
            if(!field) return null;
            const raw=fieldDrafts[field.fieldId]??field.value??'';
            const value=require('../../core/semantics/nativeParameterContext').nativeControlResolver(
                nativeParameterContextForDocument(document),[field.line]).resolve(raw||String(fallback),0);
            return value.trim()&&Number.isFinite(Number(value))?Number(value):null;
        });
        for (const field of fieldProjection.cards.flatMap(card => card.fields)) {
            if (field.draft !== undefined && String(field.draft).trim() === String(field.value || '').trim()) {
                delete fieldDrafts[field.fieldId];
                delete field.draft;
            }
        }
        const selectedSourceLine = staged.selectedFieldId
            ? fieldProjection.cards.flatMap(card => card.fields).find(field => field.fieldId === staged.selectedFieldId)?.line ?? line : line;
        const directoryUnavailable = !blockIndex && document.lineCount > LARGE_DOCUMENT_LINE_THRESHOLD;
        const deferInstances = staged.deferInstances === true && !directoryUnavailable &&
            !cachedKeywordManagerDirectory(document, blockIndex);
        // Use the same block descriptor and native instance reader as the complete directory.
        const selectedBlock = deferInstances ? indexed || {
            keyword: currentKeyword, startLine: keywordLine, endLine: blockEnd - 1,
        } : null;
        const localInstances = keywordManagerInstances(document, selectedSourceLine, blockIndex, selectedBlock);
        const instances = localInstances;
        const selectedInstance = instances.find(instance => instance.selected);
        if (selectedInstance?.recordStartIndex !== undefined && selectedInstance.headerLine === keywordLine) {
            const nativeRecords = baseResult.targetLayout?.records || [];
            fieldProjection.cards = nativeRecords.some(record => record.lsppInstanceStart !== undefined)
                ? fieldProjection.cards.filter((_card, index) =>
                    nativeRecords[index]?.lsppInstanceStart === selectedInstance.recordStartIndex)
                : fieldProjection.cards.slice(selectedInstance.recordStartIndex,
                    selectedInstance.recordStartIndex + selectedInstance.dataLineCount);
            if (!fieldProjection.cards.some(card => card.fields.some(field => field.fieldId === fieldProjection.selectedFieldId))) {
                fieldProjection.selectedFieldId = fieldProjection.cards[0]?.fields[0]?.fieldId || null;
            }
        }
        const manualAdvice = host.getKeywordSemanticAdviceForDocument?.(document, keywordLine);
        const rawConditions = groupConditionalAdvice(manualAdvice);
        const manualConditions = rawConditions.map(group => ({
            ...group,
            summaries: (group.summaries || []).map((summary: any) => {
                const english = typeof summary === 'string' ? summary : String(summary?.english || '');
                return {
                    english,
                    localized: keywordSchema.getLocalizedHelpForText(english) || null,
                };
            }),
        }));
        const showBranch = manualConditions.length > 0 || !!nativeConditionalBinding(currentKeyword) || baseResult.inputFormProjection?.branchEvidence === 'predicate';
        const model: any = {
            manualConditionKeyword: manualAdvice?.keyword,
            manualConditions,
            branchSummary: showBranch && baseResult.inputFormProjection ? nativeBranchSummary(
                (baseResult.currentLayout?.records || []).map(record => record.lsppCardIndex).filter(Number.isFinite),
                (baseResult.targetLayout?.records || []).map(record => record.lsppCardIndex).filter(Number.isFinite),
            ) : null,
            managerInstances: instances,
            managerInstanceContext: { ...keywordManagerInstanceFileState(document), typeKey: keywordManagerTypeKey(currentKeyword) },
            managerSelectionLine: selectedSourceLine,
            directoryStatus: directoryUnavailable ? 'error' : deferInstances ? 'loading' : 'ready',
            managerCards: fieldProjection.cards,
            selectedInstanceId: selectedInstance?.instanceId || null,
            readonly: selectedInstance?.readonly === true || keywordManagerReadonlyUri(document?.uri),
            selectedFieldId: fieldProjection.selectedFieldId,
            fieldDrafts,
            recordDrafts,
            selectedFormRuleId,
            sharedByteChanges: (stagedFields?.details || [])
                .filter((d: any) => d.sharedByte)
                .map((d: any) => `${d.name}: ${d.before || '∅'} → ${d.after || '∅'}`),
            currentControlState,
            draftControlState,
            resolvedTargetState,
            controls: (selectorRule?.selectors || []).filter(selector=>selector.controlId!==contactThermalSource().controlId||thermalAllowed).map(selector => {
                const controlId = String(selector.controlId || '');
                const currentValue = resolvedTargetState[controlId] ?? '';
                const identity = keywordManagerContactIdentitySelector(selectorRule, selector);
                const identityValue = currentValue || currentControlState[controlId] || 'ID';
                return {
                    controlId,
                    kind: 'selector',
                    label: identity ? i18n.get('keywordManagerIdAndTitle') : String(selector.label || controlId),
                    value: currentValue,
                    ...(identity ? { emptyLabel: i18n.get('keywordManagerIdentityDisabled') } : {}),
                    choices: identity ? [{ value: identityValue, label: i18n.get('keywordManagerIdentityEnabled'), enabled: true }]
                        : selector.values.map(value => ({ value: value.value, label: value.value, enabled: true })),
                    visible: true,
                    enabled: !keywordManagerCatalogCatalogFailure,
                };
            }),
            fieldChanges: stagedFields?.details || [],
            dynamicCardsSelected,
            dynamicCardChanges: dynamicPreparation.changes || [],
            currentLayout: baseResult.currentLayout,
            targetLayout: baseResult.targetLayout,
            block: baseResult.block,
            // Host-only identity; buildKeywordOptionsViewState never transports it.
            sourceDocument: document,
            uri: documentUriIdentity(document),
            documentVersion: document.version,
            keywordLine,
            currentKeyword,
            targetKeyword,
            targetPostCount,
            currentPostCount,
            grammarId: grammar?.grammarId || null,
            grammarStatus: grammar?.status || 'editable',
            grammarKind: grammar?.grammarKind || (catalogForm ? 'lspp-input-form' : 'compatibility-indeterminate'),
            grammar,
            dimensions,
            selection: selection || {},
            selectionState,
            sourceLabel: `${grammar
                ? `${grammar.manualId || ''} · ${grammar.canonicalSectionId}`
                : i18n.get('keywordOptionsTreeInventoryUnavailable')}`,
            inputFormSource: catalogForm ? {
                schemaVersion: catalogForm.source.schemaVersion,
                datasetVersion: catalogForm.source.datasetVersion,
                datasetSha256: catalogForm.source.datasetSha256,
                keyword: catalogForm.keyword,
            } : null,
            inputFormSourceUnavailable: !!keywordManagerCatalogCatalogFailure,
            inputFormSourceError: keywordManagerCatalogCatalogFailure ||
                (!catalogForm ? 'The form catalog has no entry for this keyword.' : ''),
            inputFormResolution: baseResult.inputFormResolution || null,
            structureDiagnostic: baseResult.structureDiagnostic,
            unresolvedRecords: baseResult.unresolvedRecords || [],
            // Host-only: help consumes the same final projection as the editor.
            helpContext: baseResult.inputFormProjection || null,
            choices,
            slots: grammar?.slots || [],
            plan: baseResult.plan,
            blockEnd,
            session: {
                uri: documentUriIdentity(document),
                documentVersion: document.version,
                keywordLine,
                blockEnd,
                blockSha256: keywordOptionBlockSha256(document, keywordLine, blockEnd),
                grammarId: grammar?.grammarId || null,
                sourceLockIdentity: baseResult.plan?.sourceLockIdentity || null,
                currentLayoutProfileId: baseResult.currentLayout?.profileId || null,
                targetLayoutProfileId: baseResult.targetLayout?.profileId || null,
                dynamicLayoutId: dynamicPlan?.layoutId || null,
                dynamicRuleId: dynamicPlan?.ruleId || null,
                dynamicStatus: dynamicPlan?.status || null,
                dynamicPredicateState: dynamicPlan?.predicateState || null,
                dynamicExistingPhysicalCards: dynamicPlan?.existingPhysicalCards ?? null,
                dynamicTargetPhysicalCard: dynamicPlan?.targetPhysicalCard ?? null,
                dynamicCardsSelected,
            },
            trailingComments: baseResult.block?.trailingComments || [],
            stale: false,
            pinned: !!staged.pinned,
            provisional,
        };
        model.help = keywordManagerHelpState(model);
        if (catalogForm && !keywordManagerCatalogAllowsWrite(currentKeyword)) {
            model.inputFormSourceError = 'The catalog source is not verified for editing.';
        }
        model.readonly = model.readonly || !!model.inputFormSourceError;
        if (model.readonly) {
            for (const field of model.managerCards.flatMap(card => card.fields)) {
                field.editable = false;
                field.reason = model.inputFormSourceError ? 'lspp-input-form-source-error' : 'document-readonly';
            }
        }
        const capabilityProjection = keywordManagerCapabilityProjection(model);
        model.capabilities = capabilityProjection.capabilities;
        model.editLevel = capabilityProjection.editLevel;
        if (selectedInstance) {
            selectedInstance.editLevel = capabilityProjection.editLevel;
            selectedInstance.reason = capabilityProjection.reason;
            selectedInstance.message = capabilityProjection.message;
        }
        return model;
    }

    function keywordOptionProductLabels() {
        return {
            selectorReload: i18n.get('selectorReload'),
            selectorAppliedReselect: i18n.get('keywordManagerAppliedReselect'),
            selectorTitle: i18n.get('selectorTitle'),
            selectorSearch: i18n.get('selectorSearch'),
            selectorPrevious: i18n.get('selectorPrevious'),
            selectorNext: i18n.get('selectorNext'),
            selectorClear: i18n.get('selectorClear'),
            selectorClose: i18n.get('selectorClose'),
            selectorFileOrder: i18n.get('selectorFileOrder'),
            selectorIdOrder: i18n.get('selectorIdOrder'),
            selectorSort: i18n.get('selectorSort'),
            selectorCurrent: i18n.get('selectorCurrent'),
            selectorLine: i18n.get('selectorLine'),
            selectorRecord: i18n.get('selectorRecord'),
            selectorCount: i18n.get('selectorCount'),
            selectorCountSingle: i18n.get('selectorCountSingle'),
            selectorSelected: i18n.get('selectorSelected'),
            selectorMissing: i18n.get('selectorMissing'),
            selectorNoMatch: i18n.get('selectorNoMatch'),
            selectorOutside: i18n.get('selectorOutside'),
            selectorLoading: i18n.get('selectorLoading'),
            selectorError: i18n.get('selectorError'),
            selectorEmpty: i18n.get('selectorEmpty'),
            current: i18n.get('keywordOptionsCurrent'),
            result: i18n.get('keywordOptionsResult'),
            search: i18n.get('keywordOptionsSearch'),
            postCards: i18n.get('chooseConsecutiveOptionalCards'),
            apply: i18n.get('keywordOptionsApply'),
            reset: i18n.get('keywordOptionsReset'),
            pin: i18n.get('keywordOptionsPin'),
            unpin: i18n.get('keywordOptionsUnpin'),
            migrated: i18n.get('keywordOptionsMigrated'),
            added: i18n.get('keywordOptionsAdded'),
            discarded: i18n.get('keywordOptionsDiscarded'),
            details: i18n.get('keywordOptionsDetails'),
            keywordLine: i18n.get('keywordOptionsKeywordLine'),
            cards: i18n.get('keywordOptionsCards'),
            fields: i18n.get('keywordOptionsFields'),
            comments: i18n.get('keywordOptionsComments'),
            currentFile: i18n.get('keywordManagerCurrentFile'),
            dirty: i18n.get('keywordManagerDirty'),
            readonly: i18n.get('keywordManagerReadonly'),
            noOptions: i18n.get('keywordOptionsNoAlternatives'),
            provisional: i18n.get('keywordOptionsProvisional'),
            reviewed: i18n.get('verifiedCardEditSection'),
            capabilities: i18n.get('keywordManagerCapabilities'),
            available: i18n.get('keywordManagerCapabilityAvailable'),
            viewOnly: i18n.get('keywordManagerCapabilityViewOnly'),
            blocked: i18n.get('keywordManagerCapabilityBlocked'),
            locateSource: i18n.get('keywordManagerLocateSource'),
            openManual: i18n.get('keywordManagerOpenManual'),
            resetField: i18n.get('keywordManagerResetField'),
        };
    }

    function keywordOptionEmptyViewState(pinned = false) {
        return {
            revision: 0,
            status: 'empty',
            locale: i18n.getLanguage() === 'zh-cn' ? 'zh' : 'en',
            pinned,
            provisional: false,
            currentKeyword: '',
            targetKeyword: '',
            currentPostCount: 0,
            targetPostCount: 0,
            mode: 'none',
            dimensions: [],
            targets: [],
            postChoices: [],
            controls: [],
            formCandidates: [],
            selectedFormRuleId: null,
            instances: [],
            selectedInstanceId: null,
            editLevel: 'view-only',
            capabilities: [],
            cards: [],
            inputFormSource: null,
            inputFormSourceError: '',
            selectedFieldId: null,
            help: { status: 'none', fieldId: null },
            preview: null,
            hasDrafts: false,
            canApply: false,
            message: i18n.get('noKeywordAtCursor'),
            labels: keywordOptionProductLabels(),
        };
    }

    function keywordOptionPlanDetails(model) {
        const plan = model?.plan;
        const label = field => String(field?.name || field?.fieldMigrationId || field?.targetFieldMigrationId || '');
        const provisionalDiff = (entry) => {
            const kind = String(entry?.kind || 'provisional-fallback');
            const name = label(entry);
            const reason = String(entry?.reason || '').replace(/^lspp-/, '');
            const keywords = entry?.currentKeyword && entry?.targetKeyword
                ? `${entry.currentKeyword} → ${entry.targetKeyword}` : '';
            return [kind, name || keywords, reason].filter(Boolean).join(': ');
        };
        const currentProfile = String(model?.currentLayout?.profileId || '');
        const targetProfile = String(model?.targetLayout?.profileId || '');
        const keyword = plan?.currentKeyword && plan?.targetKeyword && plan.currentKeyword !== plan.targetKeyword
            ? [`L${Number(model?.keywordLine || 0) + 1}: ${plan.currentKeyword} → ${plan.targetKeyword}`]
            : [];
        const cards = [
            ...(currentProfile && targetProfile && currentProfile !== targetProfile
                ? [`layout: ${currentProfile} → ${targetProfile}`] : []),
            ...(model?.currentPostCount !== model?.targetPostCount
                ? [`post-count: ${model?.currentPostCount} → ${model?.targetPostCount}`] : []),
            ...(plan?.dynamicCardChanges || []).map(change =>
                `Card ${change.physicalCardIndex}: ${change.relation}`),
        ];
        return {
            keyword,
            cards,
            fields: [
                ...(plan?.fieldChanges || []).map(change =>
                    `${change.name || change.fieldId}: ${change.before} → ${change.after}`),
                ...(plan?.previewDiff || []).map(provisionalDiff).filter(Boolean),
            ],
            migrated: (plan?.migratedFields || []).map(field => {
                const source = label(field.source || field);
                const target = label(field.target || field);
                const mapping = field?.mapping ? ` [${field.mapping}]` : '';
                const names = source && target && source !== target ? `${source} → ${target}` : source || target;
                return names ? `${names}${mapping}` : '';
            }).filter(Boolean),
            added: (plan?.emptyTargetFields || []).map(label).filter(Boolean),
            discarded: (plan?.discardedFields || []).map(field => {
                const name = label(field);
                return field?.value ? `${name} = ${field.value}` : name;
            }).filter(Boolean),
            comments: (plan?.commentChanges || []).map(change => {
                const source = String(change?.source || '').trimEnd();
                const target = String(change?.target || '').trimEnd();
                if (source && target && source !== target) return `${source} → ${target}`;
                return target || source || String(change?.kind || '');
            }).filter(Boolean),
        };
    }

    function buildKeywordOptionsViewState(model) {
        if (!model) return keywordOptionEmptyViewState(false);
        const grammar = model.grammar;
        const dimensions = model.dimensions || [];
        const locale = i18n.getLanguage() === 'zh-cn' ? 'zh' : 'en';
        const targetsBySelection = new Map();
        for (const target of grammar?.targets || []) {
            const key = target.semanticSelectionId || target.spelling;
            const current = targetsBySelection.get(key);
            if (!current || target.spelling === model.currentKeyword || target.preferredForSelection === true) {
                targetsBySelection.set(key, target);
            }
        }
        const productTargets = grammar
            ? [...targetsBySelection.values()]
            : (model.choices || []).filter(choice => choice.kind === 'spelling').map(choice => ({
                spelling: choice.targetKeyword,
                writePermission: choice.enabled,
            }));
        const postChoices = model.choices.filter(choice => choice.kind === 'post-range');
        const hasAlternatives = productTargets.some(target => target.spelling !== model.currentKeyword) ||
            postChoices.length > 1;
        const hasFieldChanges = (model.fieldChanges || []).length > 0;
        const hasDynamicCardChanges = (model.dynamicCardChanges || []).length > 0;
        const hasInputFormChanges = String(model?.currentLayout?.profileId || '') !==
            String(model?.targetLayout?.profileId || '');
        const hasRecordChanges = (model.plan?.replacementRecords?.length ?? 0) !== (model.block?.records?.length ?? 0);
        const hasCommentChanges = (model.plan?.commentChanges || []).length > 0;
        const hasFormFields = (model.managerCards || []).some(card => (card.fields || []).length > 0);
        const hasEditableFields = (model.managerCards || []).some(card =>
            (card.fields || []).some(field => field.editable));
        let status = !hasAlternatives && !hasFieldChanges && !hasFormFields && !model.dynamicCards
            ? 'no-options' : 'configuring';
        let message = '';
        if (status === 'no-options') message = i18n.get('keywordOptionsNoAlternatives');
        if (model.stale) {
            status = 'stale';
            message = model.sourceAnchorInvalid ? '' : i18n.get('keywordManagerSourceChanged');
        } else if (dimensions.length > 0 && model.selectionState !== 'exact') {
            status = 'configuring';
            message = i18n.get('keywordOptionsChooseValid');
        } else if (model.plan?.status === 'blocked' && model.plan.reason === 'lspp-input-form-field-draft-invalid') {
            status = 'error';
            message = i18n.get('keywordManagerDraftLayoutUnavailable');
        } else if (model.plan?.status === 'blocked' &&
            ((hasAlternatives || hasFormFields) ||
                String(model.plan.reason || '').startsWith('lspp-input-form-source-layout-')) && !hasFieldChanges) {
            status = 'error';
            const ambiguousCandidates = model.inputFormResolution?.status === 'ambiguous'
                ? (model.inputFormResolution.candidateSummaries || []).join('; ') : '';
            message = ambiguousCandidates
                ? i18n.get('keywordOptionsLayoutAmbiguous', ambiguousCandidates)
                : model.plan.reason === 'lspp-selector-spelling-unverified'
                    ? i18n.get('keywordOptionsContactTransitionUnverified')
                    : ['unmodeled-source-text', 'source-record-coverage-unproven'].includes(model.plan.reason)
                    ? i18n.get('keywordManagerRecordContentUnverified')
                    : String(model.plan.reason || '').startsWith('lspp-input-form-source-layout-')
                    ? i18n.get('keywordOptionsLayoutUnresolved')
                    : i18n.get('keywordOptionsTargetUnavailable');
            console.warn(`[lsdyna] Keyword option target unavailable: ${String(model.plan.reason || 'unknown').replace(/^lspp-/, '')}`);
        } else if (model.plan?.status === 'ready' &&
            (model.targetKeyword !== model.currentKeyword || model.targetPostCount !== model.currentPostCount ||
                hasFieldChanges || hasDynamicCardChanges || hasInputFormChanges || hasRecordChanges || hasCommentChanges)) {
            status = 'ready';
        }
        const fieldDiagnostics = (model.managerCards || []).flatMap(card => card.fields)
            .map(field => field.diagnostic).filter(Boolean);
        const layoutDiagnostics = keywordManagerLayoutDiagnostics(model);
        if (layoutDiagnostics.length) message = layoutDiagnostics.map(item => item.message).join(' ') +
            (model.inputFormResolution?.status === 'ambiguous' ? ` ${(model.inputFormResolution.candidateSummaries || []).join('; ')}` : '');
        if (fieldDiagnostics.some(item => item.blocksApply)) {
            status = 'error';
            message = i18n.get('keywordManagerInvalidDraft');

        }
        if (!model.stale && model.inputFormSourceUnavailable) {
            status = 'error';
            message = i18n.get('keywordManagerFieldInfoLoadFailed');
        }
        const dimensionStates = dimensions.map(dimension => {
            const selected = model.selection?.[dimension.dimensionId] || [];
            return {
                dimensionId: dimension.dimensionId,
                label: dimension.labels?.[locale] || dimension.labels?.en || dimension.dimensionId,
                selectionMode: dimension.selectionMode,
                required: dimension.required,
                values: (dimension.values || []).map(value => {
                    const valueId = String(value.valueId).toUpperCase();
                    const next = { ...model.selection };
                    if (dimension.selectionMode === 'single') {
                        next[dimension.dimensionId] = [valueId];
                    } else {
                        const values = new Set(selected.map(item => String(item).toUpperCase()));
                        if (values.has(valueId)) values.delete(valueId); else values.add(valueId);
                        next[dimension.dimensionId] = dimension.values
                            .map(item => String(item.valueId).toUpperCase()).filter(item => values.has(item));
                    }
                    const evaluation = evaluateOptionGrammar(grammar, next, { currentSpelling: model.currentKeyword });
                    return {
                        valueId,
                        label: value.labels?.[locale] || value.labels?.en || valueId,
                        selected: selected.map(item => String(item).toUpperCase()).includes(valueId),
                        enabled: evaluation.state !== 'invalid',
                    };
                }),
            };
        });
        const plan = model.plan;
        const discarded = plan?.discardedFields?.length || 0;
        const structural = model.targetKeyword !== model.currentKeyword ||
            model.targetPostCount !== model.currentPostCount || hasDynamicCardChanges ||
            String(model?.currentLayout?.profileId || '') !== String(model?.targetLayout?.profileId || '');
        const reviewLevel = discarded > 0 ? 'destructive'
            : structural ? 'structural'
                : hasFieldChanges ? 'field' : 'none';
        const preview = status !== 'no-options' && plan && plan.status !== 'blocked' ? {
            targetKeyword: model.targetKeyword,
            changedFields: (model.fieldChanges || []).length,
            reviewLevel,
            migrated: plan.migratedFields?.length || 0,
            added: plan.emptyTargetFields?.length || 0,
            discarded,
            comments: (plan.commentChanges?.length || 0) + (plan.dynamicCardChanges?.length || 0),
            details: keywordOptionPlanDetails(model),
            ...(Array.isArray(model.sharedByteChanges) && model.sharedByteChanges.length > 0
                ? { sharedByteChanges: model.sharedByteChanges }
                : {}),
        } : null;
        return {
            revision: 0,
            status,
            locale,
            pinned: !!model.pinned,
            provisional: model.provisional === true,
            currentKeyword: model.currentKeyword,
            targetKeyword: model.targetKeyword,
            currentPostCount: model.currentPostCount,
            targetPostCount: model.targetPostCount,
            mode: status === 'no-options' ? 'none' : dimensions.length > 0 ? 'dimensions'
                : hasAlternatives ? 'search' : 'fields',
            dimensions: dimensionStates,
            targets: dimensions.length > 0 ? [] : productTargets.map(target => ({
                targetKeyword: target.spelling,
                selected: target.spelling === model.targetKeyword,
            })),
            postChoices: postChoices.map(choice => ({
                targetPostCount: choice.targetPostCount,
                label: choice.label,
                selected: choice.selected,
                enabled: choice.enabled,
                reason: choice.reason,
            })),
            manualConditions: model.manualConditions || [],
            branchSummary: model.branchSummary || null,
            controls: model.controls || [],
            formCandidates: (model?.inputFormResolution?.candidateRuleIds || []).map((ruleId, index) => ({
                ruleId,
                label: model?.inputFormResolution?.candidateSummaries?.[index] || `${locale === 'zh' ? '表单' : 'Form'} ${index + 1}`,
            })),
            selectedFormRuleId: typeof model?.selectedFormRuleId === 'string' ? model.selectedFormRuleId : null,
            instances: model.managerInstances || [],
            instanceContext: model.managerInstanceContext,
            directoryStatus: model.directoryStatus || 'ready',
            selectedInstanceId: model.selectedInstanceId || null,
            editLevel: (model.readonly === true || model.managerInstances?.find(i => i.selected)?.readonly === true)
                ? 'recovery'
                : (model.editLevel || 'view-only'),
            capabilities: model.capabilities || [],
            cards: model.managerCards || [],
            layoutDiagnostics,
            unresolvedRecords: model.unresolvedRecords || [],
            selectedFieldId: model.selectedFieldId || null,
            help: model.help || { status: 'none', fieldId: null },
            preview,
            hasDrafts: keywordManagerHasStaging(model),
            canApply: model.readonly !== true && model.stale !== true && status === 'ready' &&
                (model.targetKeyword !== model.currentKeyword ||
                    model.targetPostCount !== model.currentPostCount ||
                    (model.fieldChanges || []).length > 0 ||
                    hasDynamicCardChanges || hasInputFormChanges || hasRecordChanges || hasCommentChanges),
            message,
            labels: keywordOptionProductLabels(),
        };
    }

    function keywordLineWithTargetSpelling(originalLine, targetKeyword) {
        const match = String(originalLine || '').match(/^(\s*)\*[A-Za-z0-9_+%\-]+(.*)$/);
        if (!match) return String(targetKeyword || '');
        const originalToken = classifyKeywordLine(String(originalLine || '')).rawKeyword || '';
        const formatMarker = /[+%\-]$/.test(originalToken) ? originalToken.slice(-1) : '';
        return `${match[1]}${targetKeyword}${formatMarker}${match[2] || ''}`;
    }

    function optionSwitchReplacement(document, model, result) {
        if (result.plan.applicationMode === 'keyword-only-preserve-block') {
            const line = String(document.lineAt(model.keywordLine).text || '');
            const match = /\*[A-Za-z0-9_]+[+%\-]?/.exec(line);
            if (!match) throw new Error('keyword-token-unavailable');
            const marker = /[+%\-]$/.test(match[0]) ? match[0].slice(-1) : '';
            return {
                range: new vscode.Range(model.keywordLine, match.index,
                    model.keywordLine, match.index + match[0].length),
                text: `${result.plan.targetKeyword}${marker}`,
            };
        }
        const eol = document.eol === 2 ? '\r\n' : '\n';
        const keywordText = keywordLineWithTargetSpelling(
            document.lineAt(model.keywordLine).text,
            result.plan.targetKeyword,
        );
        const lines = [keywordText];
        const records = result.plan.replacementRecords || [];
        const trailingAt = !result.plan.trailingComments?.length && Number.isInteger(result.trailingCommentInsertIndex)
            ? result.trailingCommentInsertIndex
            : records.length;
        for (let index = 0; index < records.length; index++) {
            if (index === trailingAt) lines.push(...(result.block?.trailingComments || []));
            const record = records[index];
            lines.push(...(record.comments || []), record.text);
        }
        for (const record of result.preservedTrailingRecords || []) lines.push(...(record.comments || []), record.text);
        lines.push(...(result.plan.trailingComments || []));
        if (trailingAt >= records.length) lines.push(...(result.block?.trailingComments || []));
        const blockEnd = result.block.blockEnd;
        const beforeNextKeyword = blockEnd < document.lineCount;
        const range = beforeNextKeyword
            ? new vscode.Range(model.keywordLine, 0, blockEnd, 0)
            : new vscode.Range(
                model.keywordLine,
                0,
                document.lineCount - 1,
                document.lineAt(document.lineCount - 1).text.length,
            );
        return { range, text: lines.join(eol) + (beforeNextKeyword ? eol : '') };
    }

    function keywordManagerReplacementMatchesTarget(document, model, result, replacement) {
        if (result.inputFormProjection?.branchEvidence !== 'selector') return true;
        const lines = replacement.text.replace(/\r?\n$/, '').split(/\r?\n/);
        const keyword = keywordSpellingFromLine(lines[0]);
        if (keyword !== result.plan.targetKeyword) return false;
        if (contactThermalBinding(keyword) && (!keywordManagerCatalogAllowsWrite(keyword) || !keywordSchema.lookupKeywordSchema(keyword))) return false;
        const virtual = { ...document, lineCount: lines.length + 1,
            lineAt: index => ({ text: index < lines.length ? lines[index] : '*END' }) };
        const block = collectOptionSwitchBlock(virtual, 0, { blockIndex: null });
        if (block.status !== 'ready' || block.records.length !== result.targetLayout.records.length +
            (result.preservedTrailingRecords?.length || 0)) return false;
        const expectedRecords = [...result.plan.replacementRecords, ...(result.preservedTrailingRecords || [])];
        if (block.records.some((record, index) => record.text !== expectedRecords[index]?.text)) return false;
        const expectedComments = [...expectedRecords.flatMap(record => record.comments || []),
            ...(result.plan.trailingComments || []), ...(result.block.trailingComments || [])];
        if (JSON.stringify(lines.slice(1).filter(line => line.trimStart().startsWith('$'))) !==
            JSON.stringify(expectedComments)) return false;
        block.records = block.records.slice(0, result.targetLayout.records.length);
        let physical = model.keywordLine + 1;
        Object.assign(block, {parameterContext:nativeParameterContextForDocument(document),
            recordLines:block.records.map(r=>{physical += (r.comments || []).length; return physical++;})});
        const resolved = keywordManagerResolveCatalogSelectorState(keywordManagerCatalogSelectorRule(keyword), keyword,
            { ...block, inputFormat: keywordInputFormat(lines[0], documentGlobalInputFormat(document)) });
        return !!resolved && Object.entries(model.resolvedTargetState || {}).every(([id, value]) =>
            String(resolved.selections[id] || '') === String(value || '')) &&
            JSON.stringify(resolved.layout.records.map(optionSwitchCardFromRecord)) ===
            JSON.stringify(result.targetLayout.records.map(optionSwitchCardFromRecord));
    }

    return {
        blockedKeywordOptionSwitchPlan,
        OPTION_SWITCH_MAX_PHYSICAL_LINES,
        OPTION_SWITCH_MAX_DATA_RECORDS,
        collectOptionSwitchBlock,
        keywordOptionTarget,
        keywordOptionLayoutProfile,
        keywordOptionLayoutCandidate,
        optionSwitchCardFromRecord,
        optionSwitchCommentAnalysis,
        optionSwitchCommentLine,
        keywordSpellingFromLine,
        keywordOptionBlockSha256,
        keywordOptionsEditorForModel,
        locateKeywordManagerSource,
        openKeywordManagerManual,
        keywordManagerDisplayName,
        keywordManagerReadonlyUri,
        keywordManagerInstanceFileState,
        nativeFileLayoutKind,
        nativeFileLayoutCards,
        readNativeFileField,
        selectVerifiedSourceRecords,
        nativeBatchFixedBinding,
        keywordManagerNativeFileSelection,
        keywordManagerNativeInstanceCounts,
        keywordManagerExpandNativeInstances,
        keywordManagerInstanceDirectories,
        keywordManagerInstances,
        keywordManagerTypeKey,
        prepareKeywordManagerInstances,
    completeKeywordManagerInstances,
        keywordManagerCatalogCatalogFailure,
        isKeywordManagerUnauditedCatalogAllowed,
        keywordManagerCatalogCatalogForm,
        keywordManagerCatalogRules,
        keywordManagerCatalogFormFingerprint,
        keywordManagerCatalogNativeFormRules,
        keywordManagerCatalogNativeFormRule,
        keywordManagerCatalogEffectiveFormRules,
        keywordManagerCatalogEquivalentSpellings,
        keywordManagerCatalogSelectorRule,
        keywordManagerCatalogSelectorSpelling,
        keywordManagerCatalogSourceRecordCompatible,
        keywordManagerResolveCatalogSelectorState,
        keywordManagerInferCatalogSelectorSelections,
        keywordManagerCatalogExplicitSpellingSelections,
        keywordManagerPrepareCatalogSelectorLayout,
        keywordManagerPrepareCatalogInputFormLayout,
        keywordManagerPrepareCatalogInputFormLayoutForRule,
        keywordManagerFieldProjection,
        keywordManagerResolveSchemaField,
        managerHelpLookups,
        keywordManagerReadFieldHelp,
        keywordManagerHelpState,
        keywordManagerHasStaging,
        keywordManagerCapabilityProjection,
        keywordManagerEditField,
        keywordManagerStageFieldDrafts,
        buildKeywordOptionSwitchPlan,
        buildKeywordManagerCatalogPlan,
        buildKeywordOptionViewModel,
        keywordOptionProductLabels,
        keywordOptionEmptyViewState,
        keywordOptionPlanDetails,
        buildKeywordOptionsViewState,
        keywordManagerCatalogAllowsWrite,
        keywordLineWithTargetSpelling,
        optionSwitchReplacement,
        keywordManagerReplacementMatchesTarget,
    };
}
