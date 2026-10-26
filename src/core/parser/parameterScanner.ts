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

/** Incremental lexical reader shared by local symbols and on-demand project queries. */
export function createParameterLineScanner(retainExpressionText = true) {
    let currentKeyword: ParameterKeywordClassification | null = null;
    let currentExpressionDefinition: ParameterDefinition | null = null;
    let globalInputFormat: KeywordInputFormatMode = 'standard';
    let opaqueActive = false;

    return (text: string, lineIndex: number) => {
        const result: { definitions: ParameterDefinition[]; references: ParameterReference[];
            expressionSegments: ReturnType<typeof inlineExpressionSegments> } =
            { definitions: [], references: [], expressionSegments: [] };
        if (opaqueActive) {
            if (!isColumnZeroKeywordBoundary(text)) return result;
            opaqueActive = false;
        }
        if (classifyOpaqueCommentDirective(text)) {
            currentKeyword = null;
            currentExpressionDefinition = null;
            opaqueActive = true;
            return result;
        }
        if (text.trimStart().startsWith('$')) return result;

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
            return result;
        }

        result.references.push(...scanAmpersandParameterReferences(text, lineIndex));
        if (!currentKeyword) result.expressionSegments.push(...inlineExpressionSegments(text, lineIndex));
        if (!currentKeyword) return result;

        const parsed = parseParameterDataLine(
            text,
            lineIndex,
            currentKeyword,
            globalInputFormat === 'long',
        );
        if (parsed.isContinuation) {
            if (currentExpressionDefinition && parsed.expressionSegments[0]) {
                if (retainExpressionText) currentExpressionDefinition.value += `\n${parsed.expressionSegments[0].text}`;
                if (currentExpressionDefinition.parameterType !== 'C') result.expressionSegments.push(...parsed.expressionSegments);
            }
            return result;
        }

        currentExpressionDefinition = null;
        for (const definition of parsed.definitions) {
            result.definitions.push(definition);
            if (definition.expression) currentExpressionDefinition = definition;
        }
        if (currentExpressionDefinition?.parameterType !== 'C') result.expressionSegments.push(...parsed.expressionSegments);
        return result;
    };
}

export function scanParameterSymbols(
    lineCount: number,
    readLine: (lineIndex: number) => string,
): ParameterSymbolIndex {
    const definitions = new Map<string, ParameterDefinition[]>();
    const definitionList: ParameterDefinition[] = [];
    const references: ParameterReference[] = [];
    const expressionSegments = [];
    const scan = createParameterLineScanner();
    for (let line = 0; line < lineCount; line++) {
        const result = scan(String(readLine(line) || ''), line);
        for (const definition of result.definitions) addDefinition(definitions, definitionList, definition);
        references.push(...result.references);
        expressionSegments.push(...result.expressionSegments);
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
