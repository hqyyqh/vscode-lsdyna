'use strict';

/**
 * @fileoverview QuickPick helpers for mouse-first search on Include Tree / Keyword Index.
 * Uses LS-DYNA separator-insensitive matching and filters items on each keystroke.
 * @module client/services/treeSearchQuickPick
 */

const path = require('path');
const vscode = require('vscode');
const i18n = require('../../core/i18n');
const {
    scoreKeywordName,
    scorePathFields,
    highlightFuzzyLabel,
    builtinFilterLikelyMatches,
} = require('../../core/search/lsdynaTextMatch');

const DEFAULT_RESULT_LIMIT = 500;

type IncludeSearchEntry = {
    filePath: string;
    label: string;
    description?: string;
    missing: boolean;
    treeItem: any;
};

type KeywordUsage = {
    filePath: string;
    lineIndex: number;
};

type KeywordSearchEntry = {
    keyword: string;
    usages: KeywordUsage[];
    treeItem: any;
};

type IncludeSearchPickOptions = {
    entries?: IncludeSearchEntry[];
    getEntries?: () => IncludeSearchEntry[];
    onAccept: (entry: IncludeSearchEntry) => Promise<void> | void;
    onRequestScan?: () => Promise<void> | void;
    showQuickPick?: (items: any[], options?: object) => Promise<any>;
    createQuickPick?: () => any;
    showInformationMessage?: (...args: any[]) => Promise<any>;
    resultLimit?: number;
};

type KeywordSearchPickOptions = {
    entries?: KeywordSearchEntry[];
    getEntries?: () => KeywordSearchEntry[];
    onAcceptKeyword?: (entry: KeywordSearchEntry) => Promise<void> | void;
    onAcceptUsage: (entry: KeywordSearchEntry, usage: KeywordUsage) => Promise<void> | void;
    onRequestScan?: () => Promise<void> | void;
    showQuickPick?: (items: any[], options?: object) => Promise<any>;
    createQuickPick?: () => any;
    showInformationMessage?: (...args: any[]) => Promise<any>;
    resultLimit?: number;
};

/**
 * Score a candidate string against a free-text query (keyword-oriented).
 * Higher is better; 0 means no match. Empty query is match-all.
 *
 * @param {string} query
 * @param {string} text
 * @returns {number}
 */
function matchScore(query, text) {
    return scoreKeywordName(query, text);
}

/**
 * Filter and rank include search entries for QuickPick.
 *
 * @param {IncludeSearchEntry[]} entries
 * @param {string} query
 * @param {number} [limit]
 * @returns {IncludeSearchEntry[]}
 */
function filterIncludeEntries(entries, query, limit = DEFAULT_RESULT_LIMIT) {
    const list = Array.isArray(entries) ? entries : [];
    const rawQuery = String(query || '').trim();
    if (!rawQuery) {
        return list.slice(0, limit);
    }
    const scored = [];
    for (const entry of list) {
        const score = scorePathFields(rawQuery, {
            label: entry.label,
            description: entry.description || '',
            filePath: entry.filePath || '',
        });
        if (score > 0) {
            scored.push({ entry, score });
        }
    }
    scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
    return scored.slice(0, limit).map(row => row.entry);
}

/**
 * Filter and rank keyword search entries for QuickPick.
 *
 * @param {KeywordSearchEntry[]} entries
 * @param {string} query
 * @param {number} [limit]
 * @returns {KeywordSearchEntry[]}
 */
function filterKeywordEntries(entries, query, limit = DEFAULT_RESULT_LIMIT) {
    const list = Array.isArray(entries) ? entries : [];
    const rawQuery = String(query || '').trim();
    if (!rawQuery) {
        return list.slice(0, limit);
    }
    const scored = [];
    for (const entry of list) {
        const score = scoreKeywordName(rawQuery, entry.keyword);
        if (score > 0) {
            scored.push({ entry, score });
        }
    }
    scored.sort((a, b) => b.score - a.score || a.entry.keyword.localeCompare(b.entry.keyword));
    return scored.slice(0, limit).map(row => row.entry);
}

/**
 * Prompt the user to scan when the tree has no data yet.
 *
 * @param {object} options
 * @param {() => Promise<void>|void} [options.onRequestScan]
 * @param {string} options.emptyMessage
 * @param {string} options.scanActionLabel
 * @param {Function} options.showInformationMessage
 * @returns {Promise<boolean>} True if a scan was requested and completed without throw.
 */
async function promptScanIfEmpty({
    onRequestScan,
    emptyMessage,
    scanActionLabel,
    showInformationMessage,
}) {
    if (typeof onRequestScan !== 'function') {
        await showInformationMessage(emptyMessage);
        return false;
    }
    const choice = await showInformationMessage(emptyMessage, scanActionLabel);
    if (choice !== scanActionLabel) {
        return false;
    }
    await onRequestScan();
    return true;
}

/**
 * Run a self-filtered QuickPick via createQuickPick + onDidChangeValue.
 * When tests inject only `showQuickPick`, use a one-shot list (empty query pre-filter).
 * Production (no mocks) always uses createQuickPick for live filtering.
 *
 * @param {object} options
 * @returns {Promise<any|undefined>}
 */
async function runFilteredQuickPick({
    title,
    placeholder,
    allEntries,
    filterEntries,
    mapItem,
    createQuickPick,
    showQuickPick,
    resultLimit,
}) {
    const limit = resultLimit == null ? DEFAULT_RESULT_LIMIT : resultLimit;

    // Test-only path: injected showQuickPick without createQuickPick.
    if (typeof showQuickPick === 'function' && typeof createQuickPick !== 'function') {
        const rows = filterEntries(allEntries, '', limit);
        return showQuickPick(rows.map(mapItem), {
            title,
            placeHolder: placeholder,
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: true,
        });
    }

    const factory = typeof createQuickPick === 'function'
        ? createQuickPick
        : () => vscode.window.createQuickPick();
    const pick = factory();
    pick.title = title;
    pick.placeholder = placeholder;
    pick.ignoreFocusOut = true;
    pick.matchOnDescription = false;
    pick.matchOnDetail = false;
    pick.canSelectMany = false;

    const apply = () => {
        const query = pick.value || '';
        const rows = filterEntries(allEntries, query, limit);
        // Visibility first: after custom filter, multi-word hits MUST use alwaysShow.
        // VS Code re-filters the list; with alwaysShow=false, "con en" rows vanish even
        // though scoreKeywordName > 0. Single-token contiguous/subsequence can keep
        // alwaysShow=false so native colored bold highlights still paint.
        pick.items = rows.map(entry => {
            const item = mapItem(entry, query);
            const rawLabel = typeof item.label === 'string' ? item.label : String(item.label || '');
            const q = query.trim();
            if (!q) {
                return { ...item, label: rawLabel, alwaysShow: false };
            }
            const nativeOk = builtinFilterLikelyMatches(q, rawLabel);
            if (nativeOk) {
                return { ...item, label: rawLabel, alwaysShow: false };
            }
            return {
                ...item,
                label: highlightFuzzyLabel(rawLabel, q),
                alwaysShow: true,
            };
        });
    };

    return await new Promise(resolve => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            try {
                pick.hide();
            } catch {
                // ignore
            }
            try {
                pick.dispose();
            } catch {
                // ignore
            }
            resolve(value);
        };

        pick.onDidChangeValue(() => apply());
        pick.onDidAccept(() => {
            const selected = pick.selectedItems && pick.selectedItems[0];
            finish(selected);
        });
        pick.onDidHide(() => finish(undefined));
        apply();
        pick.show();
    });
}

/**
 * Show include-tree search QuickPick (mouse-first path from view title).
 *
 * @param {IncludeSearchPickOptions} options
 * @returns {Promise<IncludeSearchEntry|undefined>}
 */
async function showIncludeSearchPick(options) {
    const {
        entries,
        getEntries,
        onAccept,
        onRequestScan,
        showQuickPick,
        createQuickPick,
        showInformationMessage = (...args) => vscode.window.showInformationMessage(...args),
        resultLimit = DEFAULT_RESULT_LIMIT,
    } = options || {};

    const resolveEntries = () => {
        if (typeof getEntries === 'function') {
            const next = getEntries();
            return Array.isArray(next) ? next : [];
        }
        return Array.isArray(entries) ? entries : [];
    };

    let workingEntries = resolveEntries();
    if (workingEntries.length === 0) {
        const scanned = await promptScanIfEmpty({
            onRequestScan,
            emptyMessage: i18n.get('treeSearchIncludeEmpty'),
            scanActionLabel: i18n.get('treeSearchScanNow'),
            showInformationMessage,
        });
        if (!scanned) {
            return undefined;
        }
        workingEntries = resolveEntries();
        if (workingEntries.length === 0) {
            await showInformationMessage(i18n.get('treeSearchStillEmpty'));
            return undefined;
        }
    }

    const picked = await runFilteredQuickPick({
        title: i18n.get('treeSearchIncludeTitle'),
        placeholder: i18n.get('treeSearchIncludePlaceholder'),
        allEntries: workingEntries,
        filterEntries: filterIncludeEntries,
        mapItem: entry => ({
            label: entry.label,
            description: entry.description || '',
            detail: entry.missing ? i18n.get('treeSearchMissingFile') : entry.filePath,
            entry,
        }),
        createQuickPick,
        showQuickPick,
        resultLimit,
    });
    if (!picked || !picked.entry) {
        return undefined;
    }
    if (typeof onAccept === 'function') {
        await onAccept(picked.entry);
    }
    return picked.entry;
}

/**
 * Show keyword-index search QuickPick, with a second step when a keyword has multiple usages.
 *
 * @param {KeywordSearchPickOptions} options
 * @returns {Promise<{entry: KeywordSearchEntry, usage?: KeywordUsage}|undefined>}
 */
async function showKeywordSearchPick(options) {
    const {
        entries,
        getEntries,
        onAcceptKeyword,
        onAcceptUsage,
        onRequestScan,
        showQuickPick,
        createQuickPick,
        showInformationMessage = (...args) => vscode.window.showInformationMessage(...args),
        resultLimit = DEFAULT_RESULT_LIMIT,
    } = options || {};

    const resolveEntries = () => {
        if (typeof getEntries === 'function') {
            const next = getEntries();
            return Array.isArray(next) ? next : [];
        }
        return Array.isArray(entries) ? entries : [];
    };

    let workingEntries = resolveEntries();
    if (workingEntries.length === 0) {
        const scanned = await promptScanIfEmpty({
            onRequestScan,
            emptyMessage: i18n.get('treeSearchKeywordEmpty'),
            scanActionLabel: i18n.get('treeSearchScanNow'),
            showInformationMessage,
        });
        if (!scanned) {
            return undefined;
        }
        workingEntries = resolveEntries();
        if (workingEntries.length === 0) {
            await showInformationMessage(i18n.get('treeSearchStillEmpty'));
            return undefined;
        }
    }

    const picked = await runFilteredQuickPick({
        title: i18n.get('treeSearchKeywordTitle'),
        placeholder: i18n.get('treeSearchKeywordPlaceholder'),
        allEntries: workingEntries,
        filterEntries: filterKeywordEntries,
        mapItem: entry => {
            const count = entry.usages ? entry.usages.length : 0;
            return {
                label: entry.keyword,
                description: count === 1
                    ? i18n.get('usageSingular')
                    : i18n.get('usagesPlural', count),
                detail: count > 0 && entry.usages[0]
                    ? entry.usages[0].filePath
                    : '',
                entry,
            };
        },
        createQuickPick,
        showQuickPick,
        resultLimit,
    });
    if (!picked || !picked.entry) {
        return undefined;
    }

    const entry = picked.entry;
    if (typeof onAcceptKeyword === 'function') {
        await onAcceptKeyword(entry);
    }

    const usages = Array.isArray(entry.usages) ? entry.usages : [];
    if (usages.length === 0) {
        return { entry };
    }
    if (usages.length === 1) {
        if (typeof onAcceptUsage === 'function') {
            await onAcceptUsage(entry, usages[0]);
        }
        return { entry, usage: usages[0] };
    }

    const usageItems = usages.map(usage => ({
        label: `${path.basename(usage.filePath)}:${usage.lineIndex + 1}`,
        description: path.dirname(usage.filePath),
        detail: usage.filePath,
        usage,
    }));
    const showPick = typeof showQuickPick === 'function'
        ? showQuickPick
        : (items, opts) => vscode.window.showQuickPick(items, opts);
    const usagePicked = await showPick(usageItems, {
        title: i18n.get('treeSearchKeywordUsageTitle', entry.keyword),
        placeHolder: i18n.get('treeSearchKeywordUsagePlaceholder'),
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true,
    });
    if (!usagePicked || !usagePicked.usage) {
        return { entry };
    }
    if (typeof onAcceptUsage === 'function') {
        await onAcceptUsage(entry, usagePicked.usage);
    }
    return { entry, usage: usagePicked.usage };
}

module.exports = {
    matchScore,
    filterIncludeEntries,
    filterKeywordEntries,
    showIncludeSearchPick,
    showKeywordSearchPick,
    DEFAULT_RESULT_LIMIT,
};

export {};
