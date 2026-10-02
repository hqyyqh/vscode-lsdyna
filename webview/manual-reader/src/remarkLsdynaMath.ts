import type { Plugin } from 'unified';

type Node = {
    type: string;
    value?: string;
    lang?: string;
    data?: Record<string, unknown>;
    position?: { start?: { offset?: number }; end?: { offset?: number } };
    children?: Node[];
};

/**
 * Escape text for embedding inside an HTML attribute-free element body.
 * Keeps KaTeX source intact after rehype-raw (entities decode via toText).
 */
function escapeHtmlText(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Split markdown into fenced-code regions (left untouched) and the rest
 * (math-protectable). Fences match GFM: ``` or ~~~ with optional indent.
 */
function mapOutsideFences(source: string, transform: (chunk: string) => string): string {
    const fence = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\r?\n[\s\S]*?\r?\n\2\3[ \t]*(?=\r?\n|$)/g;
    let out = '';
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = fence.exec(source))) {
        const start = match.index;
        if (start > cursor) out += transform(source.slice(cursor, start));
        out += match[0];
        cursor = start + match[0].length;
    }
    if (cursor < source.length) out += transform(source.slice(cursor));
    return out;
}

function protectDisplayMathChunk(source: string): string {
    let out = source.replace(
        /(^|\n)( {0,3})\$\$[ \t]*\r?\n([\s\S]*?)\r?\n( {0,3})\$\$[ \t]*(?=\r?\n|$)/g,
        (_m, lead: string, indent: string, body: string) => `${lead}${indent}\`\`\`math\n${body}\n${indent}\`\`\``,
    );
    out = out.replace(
        /(^|\n)( {0,3})\\\[[ \t]*\r?\n([\s\S]*?)\r?\n( {0,3})\\\][ \t]*(?=\r?\n|$)/g,
        (_m, lead: string, indent: string, body: string) => `${lead}${indent}\`\`\`math\n${body}\n${indent}\`\`\``,
    );
    return out;
}

/**
 * Convert display $$ / \\[ \\] blocks into fenced ```math before remark-parse.
 *
 * Why: CommonMark setext headings treat a lone line of `=` under any paragraph
 * as <h1>. Pack equations often write:
 *
 *   $$
 *   \\begin{pmatrix}...\\end{pmatrix}
 *   =
 *   \\begin{pmatrix}...\\end{pmatrix}
 *   $$
 *
 * which remark-parse splits into a heading + leftover text, so KaTeX never sees
 * a complete block and the UI shows raw LaTeX (see MAT 133 / 23.133).
 *
 * Fenced code is opaque to setext / emphasis, and rehype-katex already renders
 * `language-math` as display math. Existing non-math fences are left alone.
 */
export function protectDisplayMath(source: string): string {
    return mapOutsideFences(source, protectDisplayMathChunk);
}

function protectInlineMathChunk(source: string): string {
    return source.replace(
        /(^|[^\\$])\$(?![#$\s])((?:[^$\r\n\\]|\\.)+?)(?<!\\)\$(?!\$)/g,
        (_m, prefix: string, expr: string) => `${prefix}<code class="math-inline">${escapeHtmlText(expr)}</code>`,
    );
}

/**
 * Convert inline $...$ to HTML <code class="math-inline"> so `_` / `*` inside
 * the expression are not parsed as Markdown emphasis (which otherwise shreds
 * subscripts like X_{ij} and leaves raw \\prime tokens in the DOM).
 * Skips fenced code so examples like `$fenced$` stay literal.
 */
export function protectInlineMath(source: string): string {
    return mapOutsideFences(source, protectInlineMathChunk);
}

/** Full pre-parse shield for LS-DYNA pack markdown. */
export function protectLsdynaMathSource(source: string): string {
    // Display first: converts $$ to ```math fences, which subsequent inline
    // protection then skips (fenced regions are opaque).
    return protectInlineMath(protectDisplayMath(source));
}

function displayExpression(source: string): string | null {
    const dollar = source.match(/^ {0,3}\$\$[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\$\$[ \t]*$/);
    if (dollar) return dollar[1];
    const bracket = source.match(/^ {0,3}\\\[[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\\\][ \t]*$/);
    return bracket ? bracket[1] : null;
}

function inlineMathNodes(value: string): Node[] | null {
    const nodes: Node[] = [];
    const expression = /(^|[^\\])\$(?![#$\s])([^\r\n$]+?)(?<!\\)\$/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(value))) {
        const start = match.index + match[1].length;
        if (start > cursor) nodes.push({ type: 'text', value: value.slice(cursor, start) });
        nodes.push({
            type: 'inlineCode',
            value: match[2],
            data: { hProperties: { className: ['math-inline'] } },
        });
        cursor = match.index + match[0].length;
    }
    if (nodes.length === 0) return null;
    if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) });
    return nodes;
}

function transformInline(node: Node): void {
    if (!node.children || ['code', 'inlineCode', 'html', 'math', 'inlineMath'].includes(node.type)) return;
    const next: Node[] = [];
    for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
            next.push(...(inlineMathNodes(child.value) || [child]));
        } else {
            transformInline(child);
            next.push(child);
        }
    }
    node.children = next;
}

/**
 * Post-parse fallback for any remaining $$ paragraphs (e.g. single-line) and
 * leftover inline $. Prefer protectLsdynaMathSource() before parsing.
 */
export const remarkLsdynaMath: Plugin = function () {
    return (unistTree, file) => {
        const tree = unistTree as unknown as Node;
        const source = String(file.value || '');
        const transformBlocks = (node: Node): void => {
            if (!node.children || ['code', 'html'].includes(node.type)) return;
            node.children = node.children.map(child => {
                if (child.type === 'paragraph') {
                    const start = child.position?.start?.offset;
                    const end = child.position?.end?.offset;
                    const raw = typeof start === 'number' && typeof end === 'number' ? source.slice(start, end) : '';
                    const value = displayExpression(raw);
                    if (value !== null) return { type: 'code', lang: 'math', value };
                }
                transformBlocks(child);
                return child;
            });
        };
        transformBlocks(tree);
        transformInline(tree);
    };
};
