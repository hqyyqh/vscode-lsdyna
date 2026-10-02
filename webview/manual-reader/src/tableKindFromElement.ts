import type { ReactNode } from 'react';
import { inferTableKindFromHeaders, type TableKind } from './tableLayout';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Collect plain text from a React node tree (header cells). */
export function reactNodeText(node: ReactNode): string {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(reactNodeText).join('');
    if (isRecord(node) && 'props' in node) {
        const props = (node as { props?: { children?: ReactNode } }).props;
        return reactNodeText(props?.children);
    }
    return '';
}

function elementType(node: unknown): string | null {
    if (!isRecord(node)) return null;
    const type = node.type;
    if (typeof type === 'string') return type;
    return null;
}

function elementChildren(node: unknown): ReactNode {
    if (!isRecord(node) || !isRecord(node.props)) return null;
    return (node.props as { children?: ReactNode }).children ?? null;
}

function findFirstRow(nodes: ReactNode): unknown | null {
    const list = Array.isArray(nodes) ? nodes : [nodes];
    for (const node of list) {
        if (!node) continue;
        const type = elementType(node);
        if (type === 'tr') return node;
        if (type === 'thead' || type === 'tbody' || type === 'table') {
            const nested = findFirstRow(elementChildren(node));
            if (nested) return nested;
        }
        if (Array.isArray(node)) {
            const nested = findFirstRow(node);
            if (nested) return nested;
        }
    }
    return null;
}

/** Header labels from the first row of a rendered table (th preferred, else td). */
export function headerCellsFromTableChildren(children: ReactNode): string[] {
    const row = findFirstRow(children);
    if (!row) return [];
    const cells = elementChildren(row);
    const list = Array.isArray(cells) ? cells : cells != null ? [cells] : [];
    const headers: string[] = [];
    for (const cell of list) {
        const type = elementType(cell);
        if (type === 'th' || type === 'td') {
            headers.push(reactNodeText(cell).trim());
        }
    }
    return headers;
}

/**
 * Resolve kind for a react-markdown table component.
 * Prefer data-manual-table from remark; else infer from header cells.
 */
export function tableKindFromProps(
    dataManualTable: unknown,
    children: ReactNode,
): TableKind {
    if (dataManualTable === 'prose' || dataManualTable === 'grid' || dataManualTable === 'default') {
        return dataManualTable;
    }
    if (typeof dataManualTable === 'string') {
        const normalized = dataManualTable.toLowerCase();
        if (normalized === 'prose' || normalized === 'grid' || normalized === 'default') {
            return normalized;
        }
    }
    return inferTableKindFromHeaders(headerCellsFromTableChildren(children));
}
