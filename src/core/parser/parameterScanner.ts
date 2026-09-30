import { classifyKeywordLine } from './keywordLine';
import {
    globalInputFormatFromKeywordLine,
    type KeywordInputFormatMode,
} from './inputFormat';
import {
    classifyOpaqueCommentDirective,
    isColumnZeroKeywordBoundary,
} from './opaqueCommentRange';
import {
    ParsedParameterDefinition,
    ParsedParameterReference,
    ParameterKeywordClassification,
    classifyParameterKeyword,
    inlineExpressionSegments,
    parseParameterDataLine,
    scanAmpersandParameterReferences,
    scanBareParameterReferences,
} from './parameterSyntax';

export type ParameterDefinition = ParsedParameterDefinition;
export type ParameterReference = ParsedParameterReference;
export type ParameterReferenceSyntax = ParameterReference['syntax'];

export interface ParameterSymbolIndex {
    definitions: Map<string, ParameterDefinition[]>;
    definitionList: ParameterDefinition[];
    references: ParameterReference[];
}

function addDefinition(
    definitions: Map<string, ParameterDefinition[]>,
    definitionList: ParameterDefinition[],
    definition: ParameterDefinition,
): void {
    const existing = definitions.get(definition.normalizedName);
    if (existing) {
        existing.push(definition);
    } else {
        definitions.set(definition.normalizedName, [definition]);
    }
    definitionList.push(definition);
}

export function scanParameterSymbols(
    lineCount: number,
    readLine: (lineIndex: number) => string,
): ParameterSymbolIndex {
    const definitions = new Map<string, ParameterDefinition[]>();
    const definitionList: ParameterDefinition[] = [];
    const references: ParameterReference[] = [];
    const expressionSegments = [];
    let currentKeyword: ParameterKeywordClassification | null = null;
    let currentExpressionDefinition: ParameterDefinition | null = null;
    let globalInputFormat: KeywordInputFormatMode = 'standard';
    let opaqueActive = false;

    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
        const text = String(readLine(lineIndex) || '');
        if (opaqueActive) {
            if (!isColumnZeroKeywordBoundary(text)) continue;
            opaqueActive = false;
        }
        if (classifyOpaqueCommentDirective(text)) {
            currentKeyword = null;
            currentExpressionDefinition = null;
            opaqueActive = true;
            continue;
        }
        if (text.trimStart().startsWith('$')) continue;

        const classification = classifyKeywordLine(text);
        if (classification.isKeyword) {
            if (classification.normalizedKeyword === '*KEYWORD') {
                globalInputFormat = globalInputFormatFromKeywordLine(text, globalInputFormat);
            }
            const parameterKeyword = classifyParameterKeyword(text);
            currentKeyword = parameterKeyword &&
                (parameterKeyword.kind === 'definition' || parameterKeyword.kind === 'parameter-type')
                ? parameterKeyword
                : null;
            currentExpressionDefinition = null;
            continue;
        }

        references.push(...scanAmpersandParameterReferences(text, lineIndex));
        expressionSegments.push(...inlineExpressionSegments(text, lineIndex));
        if (!currentKeyword) continue;

        const parsed = parseParameterDataLine(
            text,
            lineIndex,
            currentKeyword,
            globalInputFormat === 'long',
        );
        if (parsed.isContinuation) {
            if (currentExpressionDefinition && parsed.expressionSegments[0]) {
                currentExpressionDefinition.value += `\n${parsed.expressionSegments[0].text}`;
                expressionSegments.push(...parsed.expressionSegments);
            }
            continue;
        }

        currentExpressionDefinition = null;
        for (const definition of parsed.definitions) {
            addDefinition(definitions, definitionList, definition);
            if (definition.expression) currentExpressionDefinition = definition;
        }
        expressionSegments.push(...parsed.expressionSegments);
    }

    const definedNames = new Set(definitions.keys());
    for (const segment of expressionSegments) {
        references.push(...scanBareParameterReferences(segment, definedNames));
    }

    const uniqueReferences = new Map<string, ParameterReference>();
    for (const reference of references) {
        const key = `${reference.lineIndex}:${reference.startChar}:${reference.length}:${reference.syntax}`;
        if (!uniqueReferences.has(key)) uniqueReferences.set(key, reference);
    }
    const sortedReferences = [...uniqueReferences.values()].sort((left, right) =>
        left.lineIndex - right.lineIndex ||
        left.startChar - right.startChar ||
        left.syntax.localeCompare(right.syntax)
    );
    return { definitions, definitionList, references: sortedReferences };
}
