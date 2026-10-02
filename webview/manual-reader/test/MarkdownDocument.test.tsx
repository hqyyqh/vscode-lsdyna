import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownDocument } from '../src/MarkdownDocument';

describe('MarkdownDocument', () => {
    it('renders GFM and trusted raw HTML tables with spans intact', () => {
        const markdown = `| Field | Meaning |
| --- | --- |
| DT2MS | Mass scaling |

<table><tbody><tr><td colspan="2" rowspan="3">raw cell</td></tr></tbody></table>`;
        const { container } = render(<MarkdownDocument markdown={markdown} chunkBaseUri="vscode-resource:/pack/chunks/" sentencePairs={[]} onOpenLink={vi.fn()} />);

        expect(container.querySelectorAll('table')).toHaveLength(2);
        const scrollers = [...container.querySelectorAll<HTMLElement>('.reader-table-scroll')];
        expect(scrollers).toHaveLength(2);
        expect(scrollers.every(scroller => scroller.tabIndex === 0)).toBe(true);
        expect(scrollers.every(scroller => scroller.getAttribute('role') === 'region')).toBe(true);
        expect(scrollers[0].className).toContain('reader-table--default');
        const raw = screen.getByText('raw cell');
        expect(raw).toHaveAttribute('colspan', '2');
        expect(raw).toHaveAttribute('rowspan', '3');
    });

    it('renders display math that contains a lone = line (setext trap in CommonMark)', () => {
        // Theory-manual style: matrix assignment with `=` on its own line inside $$.
        // Without pre-parse shielding, remark-parse turns the first half into <h1>.
        const markdown = [
            '分别地。矩阵由下式给出',
            '',
            '$$',
            '\\begin{pmatrix} X^{\\prime}_{11} \\\\ X^{\\prime}_{22} \\\\ X^{\\prime}_{12} \\end{pmatrix}',
            '=',
            '\\begin{pmatrix} L^{\\prime}_{11} & L^{\\prime}_{12} & 0 \\\\ L^{\\prime}_{21} & L^{\\prime}_{22} & 0 \\\\ 0 & 0 & L^{\\prime}_{33} \\end{pmatrix}',
            '\\begin{pmatrix} s_{xx} \\\\ s_{yy} \\\\ s_{xy} \\end{pmatrix},',
            '$$',
            '',
            'The $X^{\\prime}{}_{i j}$ values follow.',
        ].join('\n');
        const { container } = render(<MarkdownDocument
            markdown={markdown}
            chunkBaseUri="vscode-resource:/pack/chunks/"
            sentencePairs={[]}
            onOpenLink={vi.fn()}
        />);

        // Must not leak raw $$ / begin{pmatrix} as visible document text.
        expect(container.textContent || '').not.toMatch(/\$\$\s*\\begin\{pmatrix\}/);
        expect(container.querySelector('h1')).toBeNull();
        // KaTeX display output present.
        expect(container.querySelectorAll('.katex-display').length).toBeGreaterThanOrEqual(1);
        expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(1);
    });

    it('classifies pack-marked and inferred card vs variable tables', () => {
        const markdown = `<!-- manual-table:card-grid -->
| Card 2 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Variable** | \`FS\` | \`FD\` | \`DC\` | \`VC\` | \`VDC\` | \`PENCHK\` | \`BT\` | \`DT\` |

<!-- manual-table:variable-desc -->
| **Variable** | DESCRIPTION |
| :---: | --- |
| \`FS\` | Static coefficient of friction with a long explanation that should wrap inside the content column instead of forcing page scroll. |

| **Variable** | DESCRIPTION |
| --- | --- |
| \`FD\` | Unmarked variable table still infers prose layout. |

| Field | Meaning |
| --- | --- |
| X | Ordinary two-column table stays default. |
`;
        const { container } = render(<MarkdownDocument markdown={markdown} chunkBaseUri="vscode-resource:/pack/chunks/" sentencePairs={[]} onOpenLink={vi.fn()} />);
        const scrollers = [...container.querySelectorAll<HTMLElement>('.reader-table-scroll')];
        expect(scrollers).toHaveLength(4);
        expect(scrollers[0].className).toMatch(/reader-table--grid/);
        expect(scrollers[1].className).toMatch(/reader-table--prose/);
        expect(scrollers[2].className).toMatch(/reader-table--prose/);
        expect(scrollers[3].className).toMatch(/reader-table--default/);
        expect(scrollers[0].querySelector('table')).toHaveAttribute('data-manual-table', 'grid');
        expect(scrollers[1].querySelector('table')).toHaveAttribute('data-manual-table', 'prose');
    });

    it('renders strict inline and line-owned display math without consuming LS-DYNA comments or fences', () => {
        const markdown = `Inline $x^2$.

$ LS-DYNA comment, not math

$$
\\frac{a}{b}
$$

\\[
E = mc^2
\\]

\`\`\`text
$fenced$ and $$
\`\`\``;
        const { container } = render(<MarkdownDocument markdown={markdown} chunkBaseUri="vscode-resource:/pack/chunks/" sentencePairs={[]} onOpenLink={vi.fn()} />);

        expect(container.querySelectorAll('.katex')).toHaveLength(3);
        expect(screen.getByText('$ LS-DYNA comment, not math')).toBeInTheDocument();
        expect(screen.getByText(/\$fenced\$/)).toBeInTheDocument();
    });

    it('preserves anchors, resolves images from the chunk base, and intercepts every link', () => {
        const onOpenLink = vi.fn();
        const markdown = `<a id="target"></a>
[relative](../next.md#next) [external](https://example.com)

![diagram](../assets/diagram.png)`;
        const { container } = render(<MarkdownDocument markdown={markdown} chunkBaseUri="vscode-resource://authority/pack/doc/chunks/" sentencePairs={[]} onOpenLink={onOpenLink} />);

        expect(container.querySelector('#target')).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'diagram' })).toHaveAttribute('src', 'vscode-resource://authority/pack/doc/assets/diagram.png');
        fireEvent.click(screen.getByRole('link', { name: 'relative' }));
        fireEvent.click(screen.getByRole('link', { name: 'external' }));
        expect(onOpenLink.mock.calls.map(call => call[0])).toEqual(['../next.md#next', 'https://example.com']);
    });

    it('shows translations only while Alt is held for hover or keyboard focus and skips code', () => {
        const primary = 'This ordinary sentence has a translation.';
        const markdown = `${primary}

\`${primary}\`

<span>${primary}</span>`;
        const { container } = render(<MarkdownDocument markdown={markdown} chunkBaseUri="vscode-resource:/pack/chunks/" sentencePairs={[{ primary, secondary: '这句普通文本有译文。' }]} onOpenLink={vi.fn()} />);
        const translated = container.querySelectorAll('.bilingual-text');

        // Prose is wrapped; inline code is not. Text siblings next to raw HTML
        // tokens (e.g. inside <span>) may also wrap — needed for table cells.
        expect(translated.length).toBeGreaterThanOrEqual(1);
        expect(container.querySelector('code .bilingual-text')).toBeNull();
        const first = translated[0] as HTMLElement;
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'Alt' });
        fireEvent.mouseEnter(first);
        expect(screen.getByRole('tooltip')).toHaveTextContent('这句普通文本有译文。');
        fireEvent.mouseLeave(first);
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        fireEvent.focus(first);
        expect(screen.getByRole('tooltip')).toBeInTheDocument();
        fireEvent.keyUp(window, { key: 'Alt' });
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('pins translations with pointer or keyboard and keeps them pinned when the target is left', () => {
        const primary = 'Click this sentence to inspect its translation.';
        const props = {
            markdown: primary,
            chunkBaseUri: 'vscode-resource:/pack/chunks/',
            sentencePairs: [{ primary, secondary: '点击这句话查看译文。' }],
            onOpenLink: vi.fn(),
            translationHint: 'Hold Alt to preview; click to pin.',
            translationPreviewLabel: 'Translation preview',
            closeTranslationLabel: 'Close translation',
        };
        const { container, rerender } = render(<MarkdownDocument {...props} />);
        const translated = container.querySelector('.bilingual-text') as HTMLElement;

        expect(screen.getByText('Hold Alt to preview; click to pin.')).toBeInTheDocument();
        expect(translated).toHaveAttribute('aria-haspopup', 'dialog');
        expect(translated).toHaveAttribute('title', 'Hold Alt to preview; click to pin.');

        fireEvent.click(translated);
        const pinned = screen.getByRole('dialog', { name: 'Translation preview' });
        expect(pinned).toHaveTextContent('点击这句话查看译文。');
        expect(translated).toHaveAttribute('aria-describedby', pinned.id);
        fireEvent.mouseLeave(translated);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        fireEvent.focus(translated);
        fireEvent.keyDown(translated, { key: 'Enter' });
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'Escape' });
        fireEvent.keyDown(translated, { key: ' ' });
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        rerender(<MarkdownDocument {...props} markdown="A different document." sentencePairs={[]} />);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('positions temporary Alt previews next to their target and inside the viewport', () => {
        const primary = 'Position this translated sentence.';
        const { container } = render(<MarkdownDocument
            markdown={primary}
            chunkBaseUri="vscode-resource:/pack/chunks/"
            sentencePairs={[{ primary, secondary: '定位这条译文。' }]}
            onOpenLink={vi.fn()}
        />);
        const translated = container.querySelector('.bilingual-text') as HTMLElement;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
        Object.defineProperty(translated, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({ left: 370, right: 398, top: 260, bottom: 282, width: 28, height: 22 }),
        });

        fireEvent.keyDown(window, { key: 'Alt' });
        fireEvent.mouseEnter(translated);

        const tooltip = screen.getByRole('tooltip');
        expect(Number.parseInt(tooltip.style.left, 10)).toBeLessThanOrEqual(372);
        expect(Number.parseInt(tooltip.style.top, 10)).toBeLessThan(260);
        expect(translated).toHaveAttribute('aria-describedby', tooltip.id);
    });

    it('opens a keyboard-accessible image lightbox with zoom, wheel, drag, reset, and focus restoration', () => {
        render(<MarkdownDocument
            markdown={'![diagram](../assets/diagram.png "Mass scaling diagram")'}
            chunkBaseUri="vscode-resource://authority/pack/doc/chunks/"
            sentencePairs={[]}
            onOpenLink={vi.fn()}
            openImageLabel="Open image"
            imagePreviewLabel="Image preview"
            zoomInLabel="Zoom in"
            zoomOutLabel="Zoom out"
            resetImageLabel="Reset image"
            closeImageLabel="Close image"
        />);
        const trigger = screen.getByRole('button', { name: /Open image.*diagram/ });
        trigger.focus();
        fireEvent.keyDown(trigger, { key: 'Enter' });

        const dialog = screen.getByRole('dialog', { name: 'Image preview' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        const close = within(dialog).getByRole('button', { name: 'Close image' });
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Tab' });
        expect(within(dialog).getByRole('button', { name: 'Zoom out' })).toHaveFocus();
        fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Zoom out' }), { key: 'Tab', shiftKey: true });
        expect(close).toHaveFocus();
        expect(within(dialog).getByText('Mass scaling diagram')).toBeInTheDocument();
        const image = within(dialog).getByRole('img', { name: 'diagram' });
        expect(image).toHaveAttribute('src', 'vscode-resource://authority/pack/doc/assets/diagram.png');

        fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
        expect(image.style.transform).toContain('scale(1.25)');
        // Wheel is handled on the dialog via non-passive capture (React onWheel cannot cancel scroll).
        fireEvent.wheel(image, { deltaY: -100, bubbles: true });
        expect(image.style.transform).toContain('scale(1.5)');
        fireEvent.pointerDown(image, { pointerId: 1, clientX: 10, clientY: 12 });
        fireEvent.pointerMove(image, { pointerId: 1, clientX: 42, clientY: 52 });
        fireEvent.pointerUp(image, { pointerId: 1 });
        expect(image.style.transform).toContain('translate(32px, 40px)');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Reset image' }));
        expect(image.style.transform).toContain('translate(0px, 0px) scale(1)');

        expect(document.documentElement.style.overflow).toBe('hidden');
        expect(document.body.style.overflow).toBe('hidden');

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
        expect(document.documentElement.style.overflow).toBe('');
        expect(document.body.style.overflow).toBe('');

        fireEvent.click(trigger);
        // Backdrop dismiss: figure/stage fill the dialog, so pressing empty stage (not the img) must close.
        fireEvent.mouseDown(document.querySelector('.reader-lightbox__stage') as HTMLElement);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();

        fireEvent.click(trigger);
        const openImage = within(screen.getByRole('dialog')).getByRole('img', { name: 'diagram' });
        fireEvent.mouseDown(openImage);
        expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeInTheDocument();
        fireEvent.mouseDown(document.querySelector('.reader-lightbox__toolbar') as HTMLElement);
        expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'Escape' });
    });

    it('does not make invalid image URIs interactive', () => {
        const { container } = render(<MarkdownDocument
            markdown={'<img src="javascript:alert(1)" alt="unsafe">'}
            chunkBaseUri="vscode-resource:/pack/chunks/"
            sentencePairs={[]}
            onOpenLink={vi.fn()}
        />);

        expect(screen.queryByRole('button', { name: /unsafe/ })).not.toBeInTheDocument();
        expect(container.querySelector('img[src^="javascript:"]')).not.toBeInTheDocument();
    });
});
