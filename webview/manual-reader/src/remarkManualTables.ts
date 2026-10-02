import type { Plugin } from 'unified';
import {
    inferTableKindFromHeaders,
    parseManualTableMarker,
    resolveTableKind,
    type TableKind,
} from './tableLayout';

type MdastNode = {
    type: string;
    value?: string;
    children?: MdastNode[];
    data?: Record<string, unknown>;
};

function cellText(cell: MdastNode): string {
    if (cell.type === 'text' || cell.type === 'inlineCode') return cell.value ?? '';
    if (!cell.children?.length) return cell.value ?? '';
    return cell.children.map(cellText).join('');
}

function headerCells(table: MdastNode): string[] {
    const headerRow = table.children?.[0];
    if (!headerRow?.children) return [];
    return headerRow.children.map(cellText);
}

function applyKind(table: MdastNode, kind: TableKind): void {
    const data = (table.data ??= {}) as Record<string, unknown>;
    data.manualTableKind = kind;
    const hProperties = (data.hProperties ??= {}) as Record<string, unknown>;
    hProperties['data-manual-table'] = kind;
    const existing = hProperties.className;
    const kindClass = `reader-table--${kind}`;
    if (Array.isArray(existing)) {
        if (!existing.includes(kindClass)) hProperties.className = [...existing, kindClass];
    } else if (typeof existing === 'string' && existing.trim()) {
        if (!existing.split(/\s+/).includes(kindClass)) {
            hProperties.className = `${existing} ${kindClass}`;
        }
    } else {
        hProperties.className = kindClass;
    }
}

function classifyTable(table: MdastNode, previous: MdastNode | undefined): TableKind {
    let marker: TableKind | null = null;
    if (previous?.type === 'html' && typeof previous.value === 'string') {
        marker = parseManualTableMarker(previous.value);
    }
    const inferred = inferTableKindFromHeaders(headerCells(table));
    return resolveTableKind(marker, inferred);
}

function walk(parent: MdastNode): void {
    const children = parent.children;
    if (!children?.length) return;

    for (let index = 0; index < children.length; index += 1) {
        const node = children[index];
        if (node.type === 'table') {
            applyKind(node, classifyTable(node, index > 0 ? children[index - 1] : undefined));
        }
        if (node.children?.length) walk(node);
    }
}

/**
 * Attach layout kind to GFM tables from pack markers or header inference.
 * Sets mdast `data.hProperties` so hast/react-markdown see `data-manual-table`.
 */
export const remarkManualTables: Plugin = () => tree => {
    walk(tree as MdastNode);
};
