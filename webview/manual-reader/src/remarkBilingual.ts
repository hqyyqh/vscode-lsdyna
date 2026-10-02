import type { Plugin } from 'unified';

export type SentencePair = { primary: string; secondary: string; unitId?: string };
type Node = { type: string; value?: string; data?: Record<string, unknown>; children?: Node[] };

const PUNCT_MAP: Record<string, string> = {
    '：': ':', '；': ';', '，': ',', '。': '.',
    '（': '(', '）': ')', '【': '[', '】': ']',
    '\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'",
    '\u00a0': '', '\u3000': '',
};

/** Collapse whitespace / light punctuation so map text can hit rendered markdown. */
export function normalizeMatchText(value: string): string {
    let out = '';
    for (const ch of value) {
        if (/\s/.test(ch)) continue;
        if (ch === '`' || ch === '*' || ch === '_' || ch === '~') continue;
        out += PUNCT_MAP[ch] ?? ch;
    }
    return out;
}

/**
 * Locate `needle` inside `haystack`, preferring an exact substring, then a
 * whitespace/punctuation-normalized span. Returns the literal slice bounds
 * in `haystack` so the DOM keeps the displayed characters.
 */
export function findMatchSpan(haystack: string, needle: string): { index: number; length: number } | null {
    if (!haystack || !needle) return null;
    const exact = haystack.indexOf(needle);
    if (exact >= 0) return { index: exact, length: needle.length };

    const target = normalizeMatchText(needle);
    if (!target || target.length < 2) return null;

    // Map each normalized character back to its original index (O(n)).
    const normChars: string[] = [];
    const origIndex: number[] = [];
    for (let i = 0; i < haystack.length; i += 1) {
        const piece = normalizeMatchText(haystack[i]!);
        for (const ch of piece) {
            normChars.push(ch);
            origIndex.push(i);
        }
    }
    if (normChars.length < target.length) return null;
    const at = normChars.join('').indexOf(target);
    if (at < 0) return null;
    const start = origIndex[at]!;
    const end = origIndex[at + target.length - 1]!;
    return { index: start, length: end - start + 1 };
}

function splitText(value: string, pairs: SentencePair[]): Node[] {
    const nodes: Node[] = [];
    let remaining = value;
    while (remaining) {
        let selected: SentencePair | undefined;
        let selectedIndex = -1;
        let selectedLength = 0;
        for (const pair of pairs) {
            const span = findMatchSpan(remaining, pair.primary);
            if (!span) continue;
            const better =
                selectedIndex < 0
                || span.index < selectedIndex
                || (span.index === selectedIndex && span.length > selectedLength);
            if (better) {
                selected = pair;
                selectedIndex = span.index;
                selectedLength = span.length;
            }
        }
        if (!selected) {
            nodes.push({ type: 'text', value: remaining });
            break;
        }
        if (selectedIndex > 0) nodes.push({ type: 'text', value: remaining.slice(0, selectedIndex) });
        const matched = remaining.slice(selectedIndex, selectedIndex + selectedLength);
        nodes.push({
            type: 'bilingualText',
            data: {
                hName: 'span',
                hProperties: {
                    className: ['bilingual-text'],
                    tabIndex: 0,
                    dataTranslation: selected.secondary,
                    ...(selected.unitId ? { dataUnitId: selected.unitId } : {}),
                },
            },
            children: [{ type: 'text', value: matched }],
        });
        remaining = remaining.slice(selectedIndex + selectedLength);
    }
    return nodes;
}

const SKIP_TYPES = new Set(['code', 'inlineCode', 'html', 'math', 'inlineMath', 'bilingualText']);

export const remarkBilingual: Plugin<[{ sentencePairs: SentencePair[] }], Node> = function (options) {
    const pairs = [...(options?.sentencePairs || [])]
        .filter(pair => pair.primary && pair.secondary && pair.primary !== pair.secondary)
        .sort((left, right) => right.primary.length - left.primary.length);
    return (tree: Node) => {
        const visit = (node: Node): void => {
            if (!node.children || SKIP_TYPES.has(node.type)) return;
            // Process text siblings even when the parent also holds raw HTML
            // tokens (common for mixed prose + trusted HTML). Never rewrite
            // html/code/math node values themselves.
            const next: Node[] = [];
            for (const child of node.children) {
                if (child.type === 'text' && typeof child.value === 'string') {
                    next.push(...splitText(child.value, pairs));
                } else {
                    visit(child);
                    next.push(child);
                }
            }
            node.children = next;
        };
        visit(tree);
    };
};
