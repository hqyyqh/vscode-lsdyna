/**
 * Presentation helpers for keyword field help on hover/completion.
 * Chinese UI: primary Chinese text; English secondary is muted when short,
 * or shown as a short muted preview + command link when long (avoids hover
 * <details> height/scroll bugs).
 */

export type FieldHelpParts = {
    primary: string;
    secondary: string | null;
};

export type FormatFieldHelpOptions = {
    /** Link label for long English (e.g. 原文). */
    summaryLabel?: string;
    /**
     * Full markdown command href including `command:` prefix and encoded args.
     * Used only for the long-English branch.
     */
    englishCommandHref?: string;
};

/** Select English-only or Chinese-primary help from separately stored texts. */
export function selectFieldHelp(
    englishHelp: string | null | undefined,
    localizedHelp: string | null | undefined,
    language: string,
): FieldHelpParts {
    const english = String(englishHelp ?? '');
    const localized = String(localizedHelp ?? '');
    if ((language || 'en').toLowerCase() === 'zh-cn' && localized) {
        return { primary: localized, secondary: english || null };
    }
    return { primary: english, secondary: null };
}

/** Max code units for "short" English when single-line; also preview length cap. */
export const SHORT_ENGLISH_MAX_CHARS = 60;

/**
 * Escape HTML special characters so field help can be embedded safely in MarkdownString HTML.
 */
export function escapeHtml(text: string): string {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Whether English secondary should stay expanded (muted full span) vs preview + link.
 * Multi-line → long; single-line only short if length ≤ {@link SHORT_ENGLISH_MAX_CHARS}.
 */
export function isShortEnglish(text: string | null | undefined): boolean {
    const t = String(text ?? '').trim();
    if (!t) {
        return true;
    }
    if (/\r?\n/.test(t)) {
        return false;
    }
    return t.length <= SHORT_ENGLISH_MAX_CHARS;
}

/**
 * Build a one-line muted preview for long English help.
 * First line, at most maxChars, with … when truncated or multi-line remainder exists.
 */
export function previewEnglish(
    text: string | null | undefined,
    maxChars: number = SHORT_ENGLISH_MAX_CHARS,
): string {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n');
    const fullTrimmed = normalized.trim();
    if (!fullTrimmed) {
        return '';
    }
    const firstLine = (normalized.split('\n')[0] ?? '').trim();
    const base = firstLine.length > maxChars ? firstLine.slice(0, maxChars) : firstLine;
    const needsEllipsis = fullTrimmed.length > base.length || firstLine.length > maxChars;
    return needsEllipsis ? `${base}…` : base;
}

function formatMutedSecondarySpan(secondaryHtml: string): string {
    return (
        `<span style="display:block;margin-top:6px;font-size:0.92em;opacity:0.72;` +
        `color:var(--vscode-descriptionForeground);">${secondaryHtml}</span>`
    );
}

/**
 * Format primary (and optional English secondary) help for MarkdownString (supportHtml).
 * Short English: muted full span. Long English: muted preview + optional command link.
 */
export function formatFieldHelpMarkdown(
    parts: FieldHelpParts,
    options: FormatFieldHelpOptions = {},
): string {
    const primary = parts?.primary != null ? String(parts.primary) : '';
    const secondary = parts?.secondary != null ? String(parts.secondary) : '';
    if (!primary && !secondary) {
        return '';
    }

    const primaryMd = primary.replace(/\r?\n/g, '  \n');
    if (!secondary) {
        return primaryMd;
    }

    let secondaryBlock: string;
    if (isShortEnglish(secondary)) {
        const secondaryHtml = escapeHtml(secondary).replace(/\r?\n/g, '<br/>');
        secondaryBlock = formatMutedSecondarySpan(secondaryHtml);
    } else {
        const preview = previewEnglish(secondary);
        const previewHtml = escapeHtml(preview).replace(/\r?\n/g, '<br/>');
        secondaryBlock = formatMutedSecondarySpan(previewHtml);
        const href = options.englishCommandHref != null ? String(options.englishCommandHref).trim() : '';
        if (href) {
            const label = String(options.summaryLabel != null ? options.summaryLabel : 'English original');
            const title = label.replace(/"/g, '');
            secondaryBlock += `\n\n[${label}](${href} "${title}")`;
        }
    }

    if (!primaryMd) {
        return secondaryBlock;
    }
    return `${primaryMd}\n\n${secondaryBlock}`;
}
