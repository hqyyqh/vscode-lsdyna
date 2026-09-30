import {
    resolveCardForDocumentLine,
    getVerifiedPrefixLayout,
    lookupKeywordSchema,
    getLocalizedHelpForText,
    type KeywordField,
    type KeywordSchema,
} from '../keywordSchema';
import {
    formatCellL1,
    formatCellR1,
    isSafeCardGeometry,
} from '../edit/cardCellModel';
import {
    keywordInputFormat,
    type KeywordInputFormatMode,
} from '../parser/inputFormat';
import { classifyKeywordLine, isKeywordCommentLine } from '../parser/keywordLine';
import {
    fieldChoiceAdviceFromRules,
    type FieldChoiceValueAdvice,
    type SemanticEvidenceLocation,
} from './manualSemanticAdvisor';

const { manualRulesForField: defaultManualRulesForField } = require('../references/fieldReferenceClassifier');

const DEFAULT_MAXIMUM_KEYWORD_LOOKBACK = 0;
const DEFAULT_MAXIMUM_HEADER_LOOKBACK = 32;
const DEFAULT_MAXIMUM_CHOICES = 200;

type DocumentLike = {
    version?: number;
    lineCount: number;
    lineAt(line: number): { text: string };
};

type PositionLike = {
    line: number;
    character: number;
};

type BlockBoundary = {
    startLine: number;
    endLine: number;
};

type BlockBoundaryIndex = {
    lineCount?: number;
    findBlockAtLine(line: number): BlockBoundary | null;
};

export type OfficialFieldChoicePlanStatus =
    | 'ready'
    | 'no-choice'
    | 'unsupported-format'
    | 'parameter-controlled'
    | 'expression-controlled'
    | 'schema-mismatch'
    | 'selector-ambiguous'
    | 'document-unindexed'
    | 'truncated'
    | 'stale'
    | 'unavailable';

export type OfficialFieldChoiceDomainKind = 'closed' | 'mixed';

export type OfficialFieldChoiceCurrentValueKind =
    | 'blank'
    | 'numeric'
    | 'text';

export type OfficialFieldChoice = FieldChoiceValueAdvice & {
    id: string;
    replacementText: string;
};

export type OfficialFieldChoiceRange = {
    line: number;
    startCharacter: number;
    endCharacter: number;
};

export type OfficialFieldChoicePlan = {
    status: OfficialFieldChoicePlanStatus;
    reason: string;
    documentVersion: number | null;
    keyword: string;
    catalogKeyword: string;
    keywordLine: number | null;
    physicalCardIndex: number | null;
    fieldIndex: number | null;
    fieldName: string;
    fieldType: string;
    fieldWidth: number | null;
    fieldRange: OfficialFieldChoiceRange | null;
    currentRawValue: string;
    currentValueKind: OfficialFieldChoiceCurrentValueKind | null;
    domainKind: OfficialFieldChoiceDomainKind | null;
    domainComplete: boolean;
    ruleId: string;
    summary: string;
    localizedSummary?: string | null;
    evidence: SemanticEvidenceLocation[];
    choices: OfficialFieldChoice[];
    lineReads: number;
    usedBlockIndex: boolean;
};

export type OfficialFieldChoicePlannerOptions = {
    blockIndex?: BlockBoundaryIndex | null;
    keywordLine?: number;
    globalInputFormat?: KeywordInputFormatMode;
    expectedDocumentVersion?: number;
    maximumKeywordLookback?: number;
    maximumHeaderLookback?: number;
    maximumChoices?: number;
    rulesForField?: (keyword: string, cardIndex: number, field: KeywordField) => any[];
};

function finiteNonNegativeInteger(value: unknown): number | null {
    return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function emptyPlan(
    status: OfficialFieldChoicePlanStatus,
    reason: string,
    documentVersion: number | null,
): OfficialFieldChoicePlan {
    return {
        status,
        reason,
        documentVersion,
        keyword: '',
        catalogKeyword: '',
        keywordLine: null,
        physicalCardIndex: null,
        fieldIndex: null,
        fieldName: '',
        fieldType: '',
        fieldWidth: null,
        fieldRange: null,
        currentRawValue: '',
        currentValueKind: null,
        domainKind: null,
        domainComplete: false,
        ruleId: '',
        summary: '',
        localizedSummary: null,
        evidence: [],
        choices: [],
        lineReads: 0,
        usedBlockIndex: false,
    };
}

function choiceValueKind(raw: string): OfficialFieldChoiceCurrentValueKind {
    if (!raw) return 'blank';
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(raw)) return 'numeric';
    return 'text';
}

function parameterOrExpressionStatus(raw: string, fieldType: string): OfficialFieldChoicePlanStatus | null {
    if (!raw) return null;
    if (/(?:^|[^A-Za-z0-9_])-?&[A-Za-z_][A-Za-z0-9_-]{0,8}(?:$|[^A-Za-z0-9_-])/.test(raw) || raw.includes('&')) {
        return 'parameter-controlled';
    }
    if ((raw.startsWith('<') && raw.endsWith('>')) || /[{}()[\]*\/^]/.test(raw)) {
        return 'expression-controlled';
    }
    const isNumeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(raw);
    if (!isNumeric && /^(?:integer|real|float|double)$/i.test(fieldType) && /[+-]/.test(raw)) {
        return 'expression-controlled';
    }
    return null;
}

function isStringyField(field: KeywordField): boolean {
    const type = String(field?.t || '').trim().toLowerCase();
    return type === 'string' || type === 'character' || type === 'char' || Number(field?.w) >= 40;
}

function replacementForChoice(field: KeywordField, valueText: string): string {
    return isStringyField(field)
        ? formatCellL1(valueText, Number(field.w))
        : formatCellR1(valueText, Number(field.w));
}

function choiceIdentity(ruleId: string, choice: FieldChoiceValueAdvice): string {
    return `${ruleId}\u0000${choice.valueText.toUpperCase()}\u0000${choice.role}`;
}

/**
 * Plans a source-locked official field choice without importing VS Code UI.
 *
 * The default selection path deliberately performs no keyword lookback. A caller may
 * provide an already-ready BlockIndex or an exact keyword line. Explicit compatibility
 * paths may opt into a small bounded lookback; exhausting that bound returns truncated.
 */
export function planOfficialFieldChoices(
    document: DocumentLike,
    position: PositionLike,
    schema: KeywordSchema,
    options: OfficialFieldChoicePlannerOptions = {},
): OfficialFieldChoicePlan {
    const documentVersion = Number.isInteger(document?.version) ? Number(document.version) : null;
    let result = emptyPlan('unavailable', 'planner-unavailable', documentVersion);
    const lineCache = new Map<number, string>();
    let inputBytes = 0;
    const readLine = (line: number): string => {
        if (lineCache.has(line)) return lineCache.get(line) as string;
        if (lineCache.size >= 256) throw new Error('field-context-line-limit');
        const text = String(document.lineAt(line).text || '');
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > 64 * 1024 || inputBytes + bytes > 256 * 1024) throw new Error('field-context-byte-limit');
        inputBytes += bytes;
        lineCache.set(line, text);
        return text;
    };
    const finish = (
        status: OfficialFieldChoicePlanStatus,
        reason: string,
        patch: Partial<OfficialFieldChoicePlan> = {},
    ): OfficialFieldChoicePlan => ({
        ...result,
        ...patch,
        status,
        reason,
        lineReads: lineCache.size,
    });

    try {
        if (!document || !schema || !Number.isInteger(document.lineCount) || document.lineCount <= 0 ||
            !Number.isInteger(position?.line) || position.line < 0 || position.line >= document.lineCount ||
            !Number.isInteger(position?.character) || position.character < 0) {
            return finish('unavailable', 'invalid-document-or-position');
        }
        if (Number.isInteger(options.expectedDocumentVersion) &&
            documentVersion !== Number(options.expectedDocumentVersion)) {
            return finish('stale', 'document-version-changed');
        }

        const currentText = readLine(position.line);
        if (classifyKeywordLine(currentText).isKeyword || isKeywordCommentLine(currentText)) {
            return finish('no-choice', 'position-is-not-data');
        }
        if (currentText.includes(',')) {
            return finish('unsupported-format', 'comma-or-free-format');
        }

        let keywordLine = finiteNonNegativeInteger(options.keywordLine);
        let usedBlockIndex = false;
        if (keywordLine === null && options.blockIndex &&
            (options.blockIndex.lineCount === undefined || options.blockIndex.lineCount === document.lineCount)) {
            const block = options.blockIndex.findBlockAtLine(position.line);
            if (block && Number.isInteger(block.startLine) && Number.isInteger(block.endLine) &&
                block.startLine >= 0 && block.startLine < position.line && block.endLine >= position.line) {
                keywordLine = block.startLine;
                usedBlockIndex = true;
            }
        }

        const maximumLookback = Number.isFinite(options.maximumKeywordLookback)
            ? Math.max(0, Math.floor(Number(options.maximumKeywordLookback)))
            : DEFAULT_MAXIMUM_KEYWORD_LOOKBACK;
        if (keywordLine === null && maximumLookback > 0) {
            const minimum = Math.max(0, position.line - maximumLookback);
            for (let line = position.line - 1; line >= minimum; line--) {
                if (classifyKeywordLine(readLine(line)).isKeyword) {
                    keywordLine = line;
                    break;
                }
            }
            if (keywordLine === null && minimum > 0) {
                return finish('truncated', 'keyword-lookback-limit');
            }
        }
        if (keywordLine === null || keywordLine >= position.line) {
            return finish('document-unindexed', 'trusted-keyword-block-unavailable');
        }

        const keywordText = readLine(keywordLine);
        const keywordClassification = classifyKeywordLine(keywordText);
        if (!keywordClassification.isKeyword) {
            return finish('stale', 'keyword-line-changed', { keywordLine, usedBlockIndex });
        }
        const keyword = keywordClassification.normalizedKeyword;
        result = {
            ...result,
            keyword,
            keywordLine,
            usedBlockIndex,
        };
        if (keywordInputFormat(keywordText, options.globalInputFormat || 'standard') !== 'standard') {
            return finish('unsupported-format', 'non-standard-keyword-input');
        }

        const maximumHeaderLookback = Number.isFinite(options.maximumHeaderLookback)
            ? Math.max(0, Math.floor(Number(options.maximumHeaderLookback)))
            : DEFAULT_MAXIMUM_HEADER_LOOKBACK;
        let dataLineOrdinal = 0;
        const observedDataLines: string[] = [];
        for (let line = keywordLine + 1; line <= position.line; line++) {
            if (line - keywordLine > maximumHeaderLookback) {
                return finish('truncated', 'physical-card-position-lookback-limit');
            }
            const text = readLine(line);
            if (classifyKeywordLine(text).isKeyword) return finish('stale', 'keyword-block-changed');
            if (isKeywordCommentLine(text)) continue;
            dataLineOrdinal++;
            if (observedDataLines.length < 32) observedDataLines.push(text);
        }
        const resolution = resolveCardForDocumentLine(document, position.line, schema, {
            keywordLine, readLine, dataLineOrdinal, observedDataLines,
            globalInputFormat: options.globalInputFormat,
        });
        const cardInfo = resolution.cardInfo;
        if (resolution.status !== 'resolved') return finish('schema-mismatch', resolution.reason);
        if (cardInfo?.resolutionSource === 'native-file-reader' && !cardInfo.card.every(field => field.nativeStaticBinding)) {
            return finish('schema-mismatch', 'native-field-edit-binding-unverified');
        }
        if (!cardInfo || cardInfo.isTextCard || !Array.isArray(cardInfo.card) ||
            !isSafeCardGeometry(cardInfo.card as any)) {
            return finish('schema-mismatch', 'safe-fixed-card-unavailable');
        }

        const fieldIndex = cardInfo.card.findIndex(field =>
            Number.isInteger(field?.p) && Number.isInteger(field?.w) &&
            position.character >= Number(field.p) &&
            position.character < Number(field.p) + Number(field.w)
        );
        if (fieldIndex < 0) {
            return finish('no-choice', 'position-outside-field');
        }
        const field = cardInfo.card[fieldIndex];
        const fieldStart = Number(field.p);
        const fieldWidth = Number(field.w);
        const fieldEnd = fieldStart + fieldWidth;
        const fieldName = String(field.n || '').trim().toUpperCase();
        const fieldType = String(field.t || '').trim().toLowerCase();
        const basePatch: Partial<OfficialFieldChoicePlan> = {
            keyword: `*${String(cardInfo.keywordName || keyword).replace(/^\*/, '').toUpperCase()}`,
            keywordLine,
            physicalCardIndex: cardInfo.cardIndex,
            fieldIndex,
            fieldName,
            fieldType,
            fieldWidth,
            fieldRange: {
                line: position.line,
                startCharacter: fieldStart,
                endCharacter: fieldEnd,
            },
            usedBlockIndex,
        };
        if (!fieldName || !Number.isSafeInteger(fieldStart) || !Number.isSafeInteger(fieldWidth) ||
            fieldWidth <= 0 || fieldEnd > currentText.length) {
            return finish('schema-mismatch', 'complete-fixed-cell-unavailable', basePatch);
        }

        const currentRawValue = currentText.slice(fieldStart, fieldEnd).trim();
        const currentValueKind = choiceValueKind(currentRawValue);
        const valuePatch = { ...basePatch, currentRawValue, currentValueKind };
        const controlledStatus = parameterOrExpressionStatus(currentRawValue, fieldType);
        if (controlledStatus) {
            return finish(controlledStatus, controlledStatus, valuePatch);
        }

        const rulesForField = options.rulesForField || defaultManualRulesForField;
        const rules = rulesForField(cardInfo.keywordName, cardInfo.cardIndex, field) || [];
        const candidates = rules.filter((rule: any) =>
            rule?.kind === 'field-choice' && rule?.relation?.kind === 'field-choice'
        );
        if (candidates.length === 0) {
            return finish('no-choice', 'no-official-field-choice', valuePatch);
        }
        if (candidates.length !== 1) {
            return finish('selector-ambiguous', 'multiple-official-field-choice-rules', valuePatch);
        }

        const advice = fieldChoiceAdviceFromRules(candidates);
        if (!advice || !advice.ruleId || advice.field !== fieldName) {
            return finish('selector-ambiguous', 'official-field-choice-not-projectable', valuePatch);
        }
        // Manual help may supplement a native enum, but cannot extend its values.
        if (field.definitionSource && Array.isArray(field.e) && field.e.length) {
            const allowed = new Set(field.e.map(value => String(value).trim()));
            advice.choices = advice.choices.filter(choice => allowed.has(choice.valueText));
            if (!advice.choices.length) return finish('no-choice', 'native-enum-has-no-matching-manual-choice', valuePatch);
        }
        if (advice.choices.every(choice => choice.role === 'reference')) {
            return finish('no-choice', 'reference-only-domain', {
                ...valuePatch,
                catalogKeyword: advice.keyword,
                ruleId: advice.ruleId,
            });
        }
        const localizedSummary = advice.summary ? getLocalizedHelpForText(advice.summary) : null;
        const maximumChoices = Number.isFinite(options.maximumChoices)
            ? Math.max(1, Math.floor(Number(options.maximumChoices)))
            : DEFAULT_MAXIMUM_CHOICES;
        if (advice.choices.length > maximumChoices) {
            return finish('truncated', 'official-choice-count-limit', {
                ...valuePatch,
                catalogKeyword: advice.keyword,
                domainKind: advice.domainKind,
                domainComplete: advice.domainComplete,
                ruleId: advice.ruleId,
                summary: advice.summary,
                localizedSummary,
                evidence: advice.evidence,
            });
        }

        const choices = advice.choices.flatMap(choice => {
            if (choice.valueText.length > fieldWidth) return [];
            return [{
                ...choice,
                id: choiceIdentity(advice.ruleId, choice),
                replacementText: replacementForChoice(field, choice.valueText),
            }];
        });
        if (choices.length !== advice.choices.length || choices.length === 0) {
            return finish('schema-mismatch', 'official-choice-does-not-fit-cell', {
                ...valuePatch,
                catalogKeyword: advice.keyword,
                domainKind: advice.domainKind,
                domainComplete: advice.domainComplete,
                ruleId: advice.ruleId,
                summary: advice.summary,
                localizedSummary,
                evidence: advice.evidence,
            });
        }

        return finish('ready', 'official-field-choices-ready', {
            ...valuePatch,
            catalogKeyword: advice.keyword,
            domainKind: advice.domainKind,
            domainComplete: advice.domainComplete,
            ruleId: advice.ruleId,
            summary: advice.summary,
            localizedSummary,
            evidence: advice.evidence,
            choices,
        });
    } catch (error) {
        if (error instanceof Error && /^field-context-/.test(error.message)) return finish('truncated', error.message);
        return finish('unavailable', 'planner-error');
    }
}
