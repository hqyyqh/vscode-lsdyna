import { describe, expect, it } from 'vitest';
import {
    MANUAL_TABLE_MARKER_RE,
    inferTableKindFromHeaders,
    parseManualTableMarker,
    resolveTableKind,
    scrollRegionClassName,
} from '../src/tableLayout';

describe('tableLayout', () => {
    it('parses pack manual-table markers', () => {
        expect(parseManualTableMarker('<!-- manual-table:card-grid -->')).toBe('grid');
        expect(parseManualTableMarker('<!--manual-table:variable-desc-->')).toBe('prose');
        expect(parseManualTableMarker('<!-- manual-table:variable-desc -->')).toBe('prose');
        expect(parseManualTableMarker('<!-- other -->')).toBeNull();
    });

    it('preserves the null contract when the exported expression is recompiled', () => {
        const { source, flags } = MANUAL_TABLE_MARKER_RE;
        try {
            MANUAL_TABLE_MARKER_RE.compile('<!-- manual-table:(future-kind) -->', 'i');
            expect(parseManualTableMarker('<!-- manual-table:future-kind -->')).toBeNull();
            expect(resolveTableKind(parseManualTableMarker('<!-- manual-table:future-kind -->'), 'prose')).toBe('prose');
        } finally {
            MANUAL_TABLE_MARKER_RE.compile(source, flags);
        }
        expect(parseManualTableMarker('<!-- manual-table:card-grid -->')).toBe('grid');
        expect(parseManualTableMarker('<!-- manual-table:variable-desc -->')).toBe('prose');
    });

    it('infers prose and grid from headers aligned with Manual-Build vocabulary', () => {
        expect(inferTableKindFromHeaders(['**Variable**', 'DESCRIPTION'])).toBe('prose');
        expect(inferTableKindFromHeaders(['变量', '说明'])).toBe('prose');
        expect(inferTableKindFromHeaders(['變數', '備註'])).toBe('prose');
        expect(inferTableKindFromHeaders(['Variable', 'Description', 'BASELINE VALUE'])).toBe('prose');
        expect(inferTableKindFromHeaders(['Card 2', '1', '2', '3', '4', '5', '6', '7', '8'])).toBe('grid');
        expect(inferTableKindFromHeaders(['卡片 2', '1', '2', '3', '4', '5', '6', '7', '8'])).toBe('grid');
        expect(inferTableKindFromHeaders(['MPP', '1', '2', '3', '4', '5', '6', '7', '8'])).toBe('grid');
        expect(inferTableKindFromHeaders(['THRM 1', '1', '2', '3', '4', '5', '6', '7', '8'])).toBe('grid');
        expect(inferTableKindFromHeaders(['Field', 'Meaning'])).toBe('default');
        expect(inferTableKindFromHeaders(['CARD', 'DESCRIPTION'])).toBe('default');
    });

    it('lets markers override inference', () => {
        expect(resolveTableKind('grid', 'prose')).toBe('grid');
        expect(resolveTableKind(null, 'default')).toBe('default');
        expect(scrollRegionClassName('prose')).toBe('reader-table-scroll reader-table--prose');
    });
});
