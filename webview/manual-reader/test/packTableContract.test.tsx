import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownDocument } from '../src/MarkdownDocument';
import { parseManualTableMarker } from '../src/tableLayout';

const fixtures = path.resolve(__dirname, 'fixtures');

function loadFixture(name: string): string {
    return fs.readFileSync(path.join(fixtures, name), 'utf8');
}

/** Drop leading HTML comment block used only for humans reading the fixture. */
function bodyMarkdown(source: string): string {
    return source.replace(/^<!--[\s\S]*?-->\s*/, '');
}

describe('pack table contract (dist fixtures)', () => {
    it('locks EN mandatory-card-2 markers to grid then prose scroll regions', () => {
        const raw = loadFixture('pack-mandatory-card-2.en.md');
        expect(raw).toContain('<!-- manual-table:card-grid -->');
        expect(raw).toContain('<!-- manual-table:variable-desc -->');
        expect(parseManualTableMarker('<!-- manual-table:card-grid -->')).toBe('grid');
        expect(parseManualTableMarker('<!-- manual-table:variable-desc -->')).toBe('prose');

        const { container } = render(<MarkdownDocument
            markdown={bodyMarkdown(raw)}
            chunkBaseUri="vscode-resource:/pack/chunks/"
            sentencePairs={[]}
            onOpenLink={vi.fn()}
        />);

        const scrollers = [...container.querySelectorAll<HTMLElement>('.reader-table-scroll')];
        expect(scrollers.length).toBeGreaterThanOrEqual(2);
        expect(scrollers[0].className).toMatch(/reader-table--grid/);
        expect(scrollers[1].className).toMatch(/reader-table--prose/);
        expect(scrollers[0].querySelector('table')).toHaveAttribute('data-manual-table', 'grid');
        expect(scrollers[1].querySelector('table')).toHaveAttribute('data-manual-table', 'prose');
        // Card grid header cells present
        expect(container.textContent).toMatch(/Card 2/);
        expect(container.textContent).toMatch(/FS/);
    });

    it('locks ZH mandatory-card-2 markers with Chinese card headers', () => {
        const raw = loadFixture('pack-mandatory-card-2.zh.md');
        expect(raw).toContain('<!-- manual-table:card-grid -->');
        expect(raw).toContain('<!-- manual-table:variable-desc -->');

        const { container } = render(<MarkdownDocument
            markdown={bodyMarkdown(raw)}
            chunkBaseUri="vscode-resource:/pack/chunks/"
            sentencePairs={[]}
            onOpenLink={vi.fn()}
        />);

        const scrollers = [...container.querySelectorAll<HTMLElement>('.reader-table-scroll')];
        expect(scrollers.length).toBeGreaterThanOrEqual(2);
        expect(scrollers[0].className).toMatch(/reader-table--grid/);
        expect(scrollers[1].className).toMatch(/reader-table--prose/);
        expect(container.textContent).toMatch(/卡片/);
        expect(container.textContent).toMatch(/变量|Variable/);
    });

    it('infers grid from Chinese card header when pack markers are stripped (fallback)', () => {
        const raw = bodyMarkdown(loadFixture('pack-mandatory-card-2.zh.md'))
            .replace(/<!--\s*manual-table\s*:\s*card-grid\s*-->\s*/gi, '')
            .replace(/<!--\s*manual-table\s*:\s*variable-desc\s*-->\s*/gi, '');
        // Keep only the card-grid table for a tight assertion.
        const cardOnly = raw.split('| **Variable** | DESCRIPTION |')[0];

        const { container } = render(<MarkdownDocument
            markdown={cardOnly}
            chunkBaseUri="vscode-resource:/pack/chunks/"
            sentencePairs={[]}
            onOpenLink={vi.fn()}
        />);

        const scroller = container.querySelector('.reader-table-scroll');
        expect(scroller?.className).toMatch(/reader-table--grid/);
    });
});
