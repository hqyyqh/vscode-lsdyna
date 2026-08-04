/**
 * Manual-reader table layout kinds.
 *
 * Pack contract (LSDYNA_Manual_Build `tools/table_annotations.py`):
 *   <!-- manual-table:card-grid -->
 *   <!-- manual-table:variable-desc -->
 *
 * Marker wins; without a marker we infer using the same header vocabulary as
 * the pack classifier (conservative: prefer default over mis-labeling a card
 * grid as prose).
 */

export type TableKind = 'prose' | 'grid' | 'default';

export const MANUAL_TABLE_MARKER_RE = /<!--\s*manual-table\s*:\s*(card-grid|variable-desc)\s*-->/i;

const MARKER_TO_KIND: Record<string, TableKind> = {
    'card-grid': 'grid',
    'variable-desc': 'prose',
};

/** Aligned with Manual-Build `_is_variable_token`. */
const VARIABLE_HEADERS = new Set([
    'variable',
    'variables',
    '变量',
    '变量名',
    '變數',
    '变数',
]);

/** Aligned with Manual-Build `_is_description_token`. */
const DESCRIPTION_HEADERS = new Set([
    'description',
    'descriptions',
    '说明',
    '描述',
    '释义',
    '備註',
    '备注',
]);

/** Strip markdown/HTML decorations from a header cell for matching. */
export function normalizeHeaderCell(value: string): string {
    return value
        .replace(/<[^>]+>/g, ' ')
        .replace(/[`*_~]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function parseManualTableMarker(source: string): TableKind | null {
    const match = MANUAL_TABLE_MARKER_RE.exec(source);
    if (!match) return null;
    return MARKER_TO_KIND[match[1].toLowerCase()] ?? null;
}

function isVariableHeader(cell: string): boolean {
    return VARIABLE_HEADERS.has(normalizeHeaderCell(cell).toLowerCase());
}

function isDescriptionHeader(cell: string): boolean {
    return DESCRIPTION_HEADERS.has(normalizeHeaderCell(cell).toLowerCase());
}

/**
 * Aligned with Manual-Build `_is_card_label` (+ THRM/ORFR common card prefixes).
 */
function isCardishHeader(cell: string): boolean {
    const n = normalizeHeaderCell(cell);
    if (!n) return false;
    const lower = n.toLowerCase();
    if (lower.startsWith('card') || n.startsWith('卡片') || n.startsWith('卡 ')) return true;
    if (lower === 'mpp' || lower === 'mpp 1' || lower === 'mpp 2' || lower === 'id' || lower === 'card id') {
        return true;
    }
    if (n === '卡片 ID' || n === '卡片ID') return true;
    if (/^card\s*[\w.-]+$/i.test(n)) return true;
    if (/^卡片\s*[\w.-]+$/.test(n)) return true;
    if (/^mpp(\s|$)/i.test(n)) return true;
    if (/^thrm(\s|$)/i.test(n)) return true;
    if (/^orfr(\s|$)/i.test(n)) return true;
    return false;
}

function isIndexColumn(cell: string): boolean {
    const n = normalizeHeaderCell(cell);
    return /^\d{1,2}$/.test(n);
}

/** True if most trailing cells look like 1..8 column indices (pack `_mostly_short_ordinals`). */
function mostlyShortOrdinals(cells: string[]): boolean {
    if (cells.length === 0) return false;
    const hits = cells.filter(isIndexColumn).length;
    return hits >= Math.max(3, Math.floor((cells.length * 2) / 3));
}

/**
 * Infer layout kind from header cell texts.
 * Conservative: only return prose/grid when signals are strong.
 * Mirrors pack `classify_markdown_table` header rules (body-only signals stay pack-side).
 */
export function inferTableKindFromHeaders(headers: string[]): TableKind {
    // Keep empty cells — pack classify uses full column count from the pipe row.
    const cells = headers.map(normalizeHeaderCell);
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) return 'default';

    // variable-desc: first two headers Variable + DESCRIPTION (n >= 2, pack option B).
    if (cells.length >= 2 && isVariableHeader(cells[0]) && isDescriptionHeader(cells[1])) {
        return 'prose';
    }

    if (cells.length >= 5) {
        const rest = cells.slice(1);
        if (isCardishHeader(cells[0]) || mostlyShortOrdinals(rest)) {
            return 'grid';
        }
    }

    // 4-col rare Card grids — only with Card-like first cell + ordinals.
    if (cells.length >= 4 && isCardishHeader(cells[0]) && mostlyShortOrdinals(cells.slice(1))) {
        return 'grid';
    }

    return 'default';
}

/** Marker overrides inference. */
export function resolveTableKind(marker: TableKind | null, inferred: TableKind): TableKind {
    return marker ?? inferred;
}

export function tableKindClassName(kind: TableKind): string {
    return `reader-table--${kind}`;
}

export function scrollRegionClassName(kind: TableKind): string {
    return `reader-table-scroll ${tableKindClassName(kind)}`;
}
