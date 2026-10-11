/**
 * Presentation helpers for keyword field help on hover/completion.
 * Chinese UI: primary Chinese text with an optional link to the English original.
 */

export type FieldHelpParts = {
    primary: string;
    secondary: string | null;
};

export type FormatFieldHelpOptions = {
    /** Link label for English help (e.g. 原文). */
    summaryLabel?: string;
    /** Full markdown command href including `command:` prefix and encoded args. */
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

/**
 * Format primary help and an optional low-emphasis link to the English original.
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

    const primaryMd = primary
        .replace(/(`+)[\s\S]*?\1|\b[a-z][a-z\d+.-]*:\S+|[a-z\d]+(?:_[a-z\d]+){2,}/gi, token =>
            token.includes('`') || token.includes(':') ? token : token.replace(/_/g, '_<wbr>'))
        .replace(/\r?\n/g, '  \n');
    if (!secondary) {
        return primaryMd;
    }

    const href = options.englishCommandHref != null ? String(options.englishCommandHref).trim() : '';
    if (!href) return primaryMd;
    const label = String(options.summaryLabel != null ? options.summaryLabel : 'Original');
    const link = `[${label}](${href})`;
    return primaryMd ? `${link} ${primaryMd}` : link;
}
