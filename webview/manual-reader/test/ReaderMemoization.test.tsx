import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReaderApp, type ReaderTransport } from '../src/ReaderApp';
import { MarkdownDocument } from '../src/MarkdownDocument';

vi.mock('../src/MarkdownDocument', () => ({
    MarkdownDocument: vi.fn(() => <article>memoized markdown</article>),
}));

const view = {
    revision: 1,
    location: { manualId: 'vol', sectionId: 'one', anchorId: null, title: 'One' },
    language: 'en' as const,
    uiLocale: 'en' as const,
    canToggleLanguage: true,
    chrome: { volumeTitle: 'Volume I', chapterLabel: 'One', chapterKey: '01_one' },
    content: { kind: 'document' as const, markdown: '# One', chunkBaseUri: 'vscode-resource:/chunks/', sentencePairs: [] },
    navigation: { canBack: false, canForward: false, canPreviousSection: false, canNextSection: false },
    search: { query: '', scope: 'en' as const, mode: 'keyword' as const, results: [] },
    restore: { anchorId: null, scrollY: 0, scrollRatio: 0 },
};

describe('ReaderApp markdown isolation', () => {
    it('does not rerender the Markdown viewport for transient search input', async () => {
        const transport: ReaderTransport = {
            request: vi.fn(async () => true),
            notify: vi.fn(),
            onStateChanged: vi.fn(() => () => {}),
        };
        const user = userEvent.setup();
        render(<ReaderApp initialState={view} transport={transport} />);
        expect(MarkdownDocument).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole('button', { name: 'Search manuals' }));
        await user.type(screen.getByRole('searchbox'), 'mass scaling');
        vi.useFakeTimers();
        fireEvent.scroll(window);
        await vi.advanceTimersByTimeAsync(250);
        vi.useRealTimers();

        expect(MarkdownDocument).toHaveBeenCalledTimes(1);
    });
});
