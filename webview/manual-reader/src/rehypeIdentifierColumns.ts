import type { Plugin } from 'unified';
import { normalizeHeaderCell } from './tableLayout';

type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };
const headers = new Set(['variable', 'variables', 'variable name', 'option', 'options', 'keyword', 'identifier',
    '变量', '变量名', '變數', '变数', '选项', '選項', '关键字', '關鍵字', '标识符']);
const text = (node: Node): string => node.value ?? node.children?.map(text).join('') ?? '';
const cells = (row: Node) => (row.children || []).filter(node => node.tagName === 'th' || node.tagName === 'td');

/** Run after raw HTML parsing, so HTML and Markdown use the same column semantics. */
export const rehypeIdentifierColumns: Plugin = () => tree => {
    function walk(node: Node) {
        if (node.tagName === 'table') {
            const rows = (node.children || []).flatMap(child => child.tagName === 'tr' ? [child]
                : ['thead', 'tbody', 'tfoot'].includes(child.tagName || '') ? (child.children || []).filter(row => row.tagName === 'tr') : []);
            const first = rows[0] && cells(rows[0]);
            if (first && first.every(cell => Number(cell.properties?.colSpan ?? 1) === 1)) {
                const columns = first.map(cell => headers.has(normalizeHeaderCell(text(cell)).toLowerCase()));
                for (const row of rows.slice(1)) {
                    let column = 0;
                    for (const cell of cells(row)) {
                        const span = Number(cell.properties?.colSpan ?? 1);
                        // Protect identifiers, not prose that happens to sit under an option heading.
                        if (span === 1 && columns[column] && /^[\sA-Za-z0-9_*+.,/()=<>\[\]:-]+$/.test(text(cell).trim())) {
                            const props = cell.properties ??= {};
                            const classes = Array.isArray(props.className) ? props.className : String(props.className || '').split(/\s+/);
                            props.className = [...classes.filter(Boolean), 'reader-identifier-cell'];
                        }
                        column += span;
                    }
                }
            }
        }
        node.children?.forEach(walk);
    }
    walk(tree as Node);
};
