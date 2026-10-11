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

export const remarkBilingual: Plugin<[{ sentencePairs: SentencePair[]; comparison?: boolean }], Node> = function (options) {
    const pairs = [...(options?.sentencePairs || [])]
        .filter(pair => pair.primary && pair.secondary && pair.primary !== pair.secondary)
        .sort((left, right) => right.primary.length - left.primary.length);
    return (tree: Node) => {
        if (options.comparison) return;
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

type HtmlNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HtmlNode[] };

/** Pair rendered blocks, including the pack's HTML tables, without changing their structure. */
export const rehypeBilingualComparison: Plugin<[{ sentencePairs: SentencePair[]; comparison?: boolean }], HtmlNode> = function (options) {
    const textOf = (node: HtmlNode): string => node.value ?? (node.children || []).map(textOf).join('');
    const plain = (value: string) => value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^(?:[•*-] |\d+\. )/, '');
    const pairs = options.sentencePairs.map(pair => ({ ...pair, primary: plain(pair.primary), key: normalizeMatchText(plain(pair.primary)) }));
    const translations = new Map<string, Set<string>>();
    for (const pair of pairs) {
        const key = normalizeMatchText(pair.primary);
        const values = translations.get(key) || new Set<string>();
        values.add(pair.secondary);
        translations.set(key, values);
    }
    // Repeated labels with different meanings cannot be aligned safely from text alone.
    const unambiguous = pairs.filter(pair => translations.get(normalizeMatchText(pair.primary))?.size === 1);
    return tree => {
        const used = new Set<string>();
        const visit = (node: HtmlNode) => {
            if (!node.children || ['pre', 'code', 'math', 'svg'].includes(node.tagName || '')) return;
            if (['p', 'td', 'th', 'li', 'h1', 'h2', 'h3', 'h4'].includes(node.tagName || '')
                && !node.children.some(child => ['p', 'ul', 'ol', 'table'].includes(child.tagName || ''))) {
                const text = normalizeMatchText(textOf(node));
                const matches = unambiguous.filter(pair => pair.key.length > 1)
                    .map(pair => ({ pair, span: { index: text.indexOf(pair.key), length: pair.key.length } }))
                    .filter(entry => entry.span.index >= 0)
                    .sort((a, b) => a.span.index - b.span.index || b.span.length - a.span.length);
                let end = -1;
                const selected = matches.filter(({ span }) => {
                    if (span.index < end) return false;
                    end = span.index + span.length;
                    return true;
                });
                if (selected.length) {
                    const unitId = selected[0]!.pair.unitId;
                    const properties: Record<string, unknown> = { className: ['bilingual-primary'], lang: 'zh' };
                    if (unitId && !used.has(unitId)) {
                        node.properties = { ...node.properties, id: node.properties?.id || `reader-unit-${unitId}`, dataUnitId: unitId };
                        used.add(unitId);
                    }
                    if (options.comparison) node.children = [
                        { type: 'element', tagName: 'span', properties, children: node.children },
                        { type: 'element', tagName: 'span', properties: { className: ['bilingual-secondary'], lang: 'en' },
                            children: [{ type: 'text', value: selected.map(({ pair }) => pair.secondary.replace(/^(?:[•*-] |\d+\. )/, '')).join(' ') }] },
                    ];
                }
                return;
            }
            node.children.forEach(visit);
        };
        visit(tree);
    };
};
