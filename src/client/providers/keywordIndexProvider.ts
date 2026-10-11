'use strict';

/**
 * @fileoverview Native VS Code TreeView for LS-DYNA keyword occurrences.
 *
 * Scan scope (current file/project), visual projection (source order/A-Z/LS-PrePost category),
 * semantic display identity, and cursor following are deliberately independent.  The provider
 * keeps one occurrence index and projects it into lightweight, lazily materialized tree nodes.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const vscode = require('vscode');

const keywordScanner = require('../../core/parser/keywordScanner');
const { BlockIndex } = require('../../core/incremental/blockIndex');
const {
    createKeywordIdentityAccumulatorFactory,
    normalizeKeyword,
} = require('../../core/keywordDisplayIdentity');
const {
    getCategory,
    resolveKeywordCategory,
} = require('../../core/keywordCategory');
const i18n = require('../../core/i18n');

type KeywordIndexLayout = 'order' | 'alphabetical' | 'category';

type KeywordUsage = {
    filePath: string;
    lineIndex: number;
    endLine?: number;
    displayName?: string;
    keyword?: string;
    category?: string;
    dataLineCount?: number;
    fileOrder?: number;
};

type KeywordOccurrence = {
    key: string;
    keyword: string;
    rawKeyword: string;
    canonicalKeyword: string;
    filePath: string;
    fileKey: string;
    fileOrder: number;
    occurrenceOrder: number;
    startLine: number;
    endLine: number;
    startOffset?: number;
    endOffset?: number;
    dataLineCount: number;
    displayIdentity?: any;
    category: string;
    categoryAliases: string[];
    categoryConfidence: string;
};

type KeywordIndexProviderOptions = {
    resolveActiveUri?: () => any;
    collectIncludeFiles?: (rootFile: string, onProgress?: (count: number) => void) => Promise<string[]>;
    loadProjectSnapshot?: (rootFile: string, options?: object, onProgress?: (snapshot: any) => void, cancellationToken?: any) => Promise<any>;
    invalidateProjectSnapshot?: (rootFile: string) => Promise<void>;
    shouldSkipAutomaticDocumentScan?: (document: any) => boolean;
    workspaceState?: { get?: (key: string, defaultValue?: any) => any; update?: (key: string, value: any) => Promise<any> | any };
    initialLayout?: KeywordIndexLayout;
    followCursor?: boolean;
    asyncDocumentIndexThreshold?: number;
    documentIndexYieldInterval?: number;
    maxIncrementalRescanLines?: number;
};

const KEYWORD_FOLDING_THRESHOLD = 100;
const FILE_FOLDING_THRESHOLD = 50;
const OCCURRENCE_PAGE_SIZE = 200;
const CURSOR_REVEAL_DEBOUNCE_MS = 100;
const DEFAULT_ASYNC_DOCUMENT_INDEX_THRESHOLD = 20000;
const DEFAULT_DOCUMENT_INDEX_YIELD_INTERVAL = 5000;
const DEFAULT_MAX_INCREMENTAL_RESCAN_LINES = 10000;
const VALID_LAYOUTS = new Set(['order', 'alphabetical', 'category']);
const LAYOUT_STATE_KEY = 'lsdyna.keywordIndex.layout';

function getLsdynaConfigurationValue(key, defaultValue) {
    const config = vscode.workspace.getConfiguration('lsdyna');
    if (!config || typeof config.get !== 'function') return defaultValue;
    return config.get(key, defaultValue);
}

function normalizeFileKey(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function documentIndexKey(document) {
    const rendered = document?.uri?.toString?.();
    if (rendered && rendered !== '[object Object]') return rendered;
    return normalizeFileKey(document?.uri?.fsPath || '');
}

function makeOccurrenceKey(filePath, startLine, keyword) {
    return `${normalizeFileKey(filePath)}\0${Math.max(0, Number(startLine) || 0)}\0${normalizeKeyword(keyword)}`;
}

function makeTreeId(...parts) {
    return `lsdyna-keyword-index:${parts.map(part => encodeURIComponent(String(part ?? ''))).join(':')}`;
}

function getActiveUri() {
    const editor = vscode.window.activeTextEditor;
    if (editor) return editor.document.uri;
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab?.input) {
        const input = activeTab.input;
        return input.uri || input.resource || input.modified || input.original || null;
    }
    return null;
}

function isLsdynaUri(uri) {
    if (!uri) return false;
    const ext = path.extname(uri.fsPath || '').toLowerCase();
    const configured = getLsdynaConfigurationValue('additionalExtensions', ['.k', '.key', '.dyna']) || [];
    const extensions = configured.map(value => {
        const normalized = String(value || '').trim().toLowerCase();
        return normalized.startsWith('.') ? normalized : `.${normalized}`;
    });
    return extensions.includes(ext);
}

function isLsdynaFile(document) {
    return !!document?.uri && (isLsdynaUri(document.uri) || document.languageId === 'lsdyna');
}

function markdownCode(value) {
    return String(value == null ? '' : value).replace(/`/g, '\\`');
}

function shorten(value, maxLength = 72) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function layoutLabel(layout: KeywordIndexLayout) {
    if (layout === 'order') return i18n.get('keywordIndexLayoutOrder');
    if (layout === 'category') return i18n.get('keywordIndexLayoutCategory');
    return i18n.get('keywordIndexLayoutAlphabetical');
}

function scopeLabel(mode) {
    return mode === 'recursive'
        ? i18n.get('keywordIndexScopeProject')
        : i18n.get('keywordIndexScopeCurrentFile');
}

function identityText(identity) {
    if (!identity) return '';
    if (identity.title) return shorten(identity.title);
    if (identity.identity) return `${identity.identity.field} ${shorten(identity.identity.value, 48)}`;
    if (Array.isArray(identity.signature) && identity.signature.length > 0) {
        return identity.signature.map(item => `${item.field} ${shorten(item.value, 32)}`).join(' ↔ ');
    }
    return '';
}

function occurrencePresentation(occurrence: KeywordOccurrence, rootDir: string, layout: KeywordIndexLayout) {
    const identity = occurrence.displayIdentity;
    const relativePath = path.relative(rootDir || path.dirname(occurrence.filePath), occurrence.filePath) || path.basename(occurrence.filePath);
    const fileName = path.basename(occurrence.filePath);
    const line = occurrence.startLine + 1;
    const semantic = identityText(identity);
    const auxiliary: string[] = [];

    if (layout === 'order') {
        const label = semantic ? `*${occurrence.keyword} — ${semantic}` : `*${occurrence.keyword}`;
        if (identity?.title && identity?.identity) {
            auxiliary.push(`${identity.identity.field} ${shorten(identity.identity.value, 36)}`);
        }
        if (identity?.collection?.count > 0) {
            auxiliary.push(i18n.get('keywordIndexDataLines', identity.collection.count));
        }
        auxiliary.push(i18n.get('keywordIndexLineShort', line));
        if (rootDir && relativePath !== fileName) auxiliary.push(relativePath);
        return { label, description: auxiliary.join(' · ') };
    }

    let label;
    let usesFileLabel = false;
    if (identity?.path) label = shorten(path.basename(identity.path) || identity.path);
    else if (identity?.title) label = shorten(identity.title);
    else if (identity?.identity) label = `${identity.identity.field} ${shorten(identity.identity.value, 48)}`;
    else if (Array.isArray(identity?.signature) && identity.signature.length > 0) label = semantic;
    else if (identity?.collection) label = `${occurrence.keyword} ${i18n.get('keywordIndexBlock')}`;
    else {
        label = fileName;
        usesFileLabel = true;
    }

    if (identity?.title && identity?.identity) {
        auxiliary.push(`${identity.identity.field} ${shorten(identity.identity.value, 36)}`);
    }
    if (identity?.collection?.count > 0) {
        auxiliary.push(i18n.get('keywordIndexDataLines', identity.collection.count));
    }
    if (usesFileLabel) {
        const relativeDir = path.dirname(relativePath);
        if (relativeDir && relativeDir !== '.') auxiliary.push(relativeDir);
        auxiliary.push(i18n.get('keywordIndexLineShort', line));
    } else {
        auxiliary.push(`${fileName}:${line}`);
    }
    return { label, description: auxiliary.join(' · ') };
}

function occurrenceTooltip(occurrence: KeywordOccurrence, rootDir: string) {
    const tooltip = new vscode.MarkdownString();
    const relativePath = path.relative(rootDir || path.dirname(occurrence.filePath), occurrence.filePath) || path.basename(occurrence.filePath);
    tooltip.appendMarkdown(`### *${occurrence.keyword}\n\n`);
    if (occurrence.displayIdentity?.title) {
        tooltip.appendMarkdown(`- **${i18n.get('keywordIndexName')}**: ${markdownCode(occurrence.displayIdentity.title)}\n`);
    }
    if (occurrence.displayIdentity?.identity) {
        const identity = occurrence.displayIdentity.identity;
        tooltip.appendMarkdown(`- **${markdownCode(identity.field)}**: \`${markdownCode(identity.value)}\`\n`);
    }
    if (Array.isArray(occurrence.displayIdentity?.signature)) {
        for (const item of occurrence.displayIdentity.signature) {
            tooltip.appendMarkdown(`- **${markdownCode(item.field)}**: \`${markdownCode(item.value)}\`\n`);
        }
    }
    if (occurrence.displayIdentity?.collection) {
        tooltip.appendMarkdown(`- **${i18n.get('keywordIndexDataLineLabel')}**: ${occurrence.displayIdentity.collection.count}\n`);
    }
    tooltip.appendMarkdown(`- **${i18n.get('keywordIndexCategory')}**: ${occurrence.category}\n`);
    if (occurrence.categoryAliases.length > 0) {
        tooltip.appendMarkdown(`- **${i18n.get('keywordIndexCategoryAliases')}**: ${occurrence.categoryAliases.join(', ')}\n`);
    }
    tooltip.appendMarkdown(`- **${i18n.get('file')}**: \`${markdownCode(relativePath)}\`\n`);
    tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${markdownCode(occurrence.filePath)}\`\n`);
    tooltip.appendMarkdown(`- **${i18n.get('line')}**: ${occurrence.startLine + 1}`);
    if (occurrence.endLine > occurrence.startLine) {
        tooltip.appendMarkdown(`–${occurrence.endLine + 1}`);
    }
    tooltip.appendMarkdown('\n');
    return tooltip;
}

function makeOccurrence(block, filePath, fileOrder, occurrenceOrder): KeywordOccurrence {
    const rawKeyword = String(block?.rawKeyword || block?.keyword || '').trim();
    const keyword = normalizeKeyword(rawKeyword);
    const startLine = Math.max(0, Number(block?.startLine ?? block?.lineIndex ?? block?.line) || 0);
    const endLine = Math.max(startLine, Number(block?.endLine ?? startLine) || startLine);
    const category = resolveKeywordCategory(keyword);
    const identity = block?.displayIdentity;
    return {
        key: makeOccurrenceKey(filePath, startLine, keyword),
        keyword,
        rawKeyword,
        canonicalKeyword: identity?.canonicalKeyword || keyword,
        filePath,
        fileKey: normalizeFileKey(filePath),
        fileOrder,
        occurrenceOrder,
        startLine,
        endLine,
        ...(Number.isFinite(block?.startOffset) ? { startOffset: Number(block.startOffset) } : {}),
        ...(Number.isFinite(block?.endOffset) ? { endOffset: Number(block.endOffset) } : {}),
        dataLineCount: Math.max(0, Number(block?.dataLineCount ?? identity?.dataLineCount) || 0),
        displayIdentity: identity,
        category: category.primaryCategory,
        categoryAliases: category.aliases || [],
        categoryConfidence: category.confidence,
    };
}

function occurrencesFromKeywordMap(keywordMap, fileOrderByKey = new Map()): KeywordOccurrence[] {
    const occurrences: KeywordOccurrence[] = [];
    let occurrenceOrder = 0;
    for (const [keyword, usages] of keywordMap || []) {
        for (const usage of usages || []) {
            const filePath = usage.filePath;
            const fileKey = normalizeFileKey(filePath);
            occurrences.push(makeOccurrence({
                keyword,
                startLine: usage.lineIndex,
                endLine: usage.endLine ?? usage.lineIndex,
                displayIdentity: usage.displayIdentity,
            }, filePath, fileOrderByKey.get(fileKey) ?? fileOrderByKey.size, occurrenceOrder++));
        }
    }
    return occurrences;
}

function snapshotFileIndexes(snapshot) {
    if (snapshot?.fileIndexes instanceof Map) return snapshot.fileIndexes;
    if (Array.isArray(snapshot?.fileIndexes)) return new Map(snapshot.fileIndexes);
    return null;
}

function occurrencesFromSnapshot(snapshot): KeywordOccurrence[] {
    const indexes = snapshotFileIndexes(snapshot);
    const files = Array.isArray(snapshot?.files) ? snapshot.files.slice() : indexes ? [...indexes.keys()] : [];
    const fileOrderByKey = new Map(files.map((filePath, index) => [normalizeFileKey(filePath), index]));
    if (!indexes) return occurrencesFromKeywordMap(snapshot?.keywordMap || new Map(), fileOrderByKey);

    const occurrences: KeywordOccurrence[] = [];
    let occurrenceOrder = 0;
    for (const [filePath, fileIndex] of indexes.entries()) {
        const blocks = Array.isArray(fileIndex?.keywordBlocks) ? fileIndex.keywordBlocks : [];
        const fileOrder = fileOrderByKey.get(normalizeFileKey(filePath)) ?? fileOrderByKey.size;
        for (const block of blocks) {
            occurrences.push(makeOccurrence(block, filePath, fileOrder, occurrenceOrder++));
        }
    }
    return occurrences;
}

class IndexTreeItem extends vscode.TreeItem {
    kind: string;
    parent: any;
    _children: any[] | null;
    _childFactory: (() => any[]) | null;

    constructor(label, collapsibleState, kind, parent = null) {
        super(label, collapsibleState);
        this.kind = kind;
        this.parent = parent;
        this._children = [];
        this._childFactory = null;
    }

    get children() {
        return this.getIndexChildren();
    }

    set children(value) {
        this._children = Array.isArray(value) ? value : [];
        this._childFactory = null;
    }

    setChildFactory(factory) {
        this._children = null;
        this._childFactory = factory;
    }

    getIndexChildren() {
        if (this._children === null) {
            this._children = typeof this._childFactory === 'function' ? this._childFactory() : [];
        }
        return this._children;
    }
}

class KeywordUsageItem extends IndexTreeItem {
    occurrence: KeywordOccurrence;
    resourceUri: any;
    command: any;

    constructor(filePathOrOccurrence, lineIndexOrRootDir, rootDirOrLayout?, layoutOrParent?, maybeParent?) {
        const legacy = typeof filePathOrOccurrence === 'string';
        const occurrence: KeywordOccurrence = legacy
            ? makeOccurrence({ keyword: '', startLine: lineIndexOrRootDir, endLine: lineIndexOrRootDir }, filePathOrOccurrence, 0, 0)
            : filePathOrOccurrence;
        const rootDir = legacy ? String(rootDirOrLayout || '') : String(lineIndexOrRootDir || '');
        const layout: KeywordIndexLayout = legacy ? 'alphabetical' : (rootDirOrLayout || 'alphabetical');
        const parent = legacy ? null : (layoutOrParent || maybeParent || null);
        const presentation = legacy
            ? { label: path.basename(occurrence.filePath), description: i18n.get('linePrefix', occurrence.startLine + 1) }
            : occurrencePresentation(occurrence, rootDir, layout);
        super(presentation.label, vscode.TreeItemCollapsibleState.None, 'occurrence', parent);
        this.occurrence = occurrence;
        this.resourceUri = vscode.Uri.file(occurrence.filePath);
        this.description = presentation.description;
        this.contextValue = 'file';
        this.iconPath = new vscode.ThemeIcon('symbol-keyword');
        this.id = makeTreeId('occurrence', occurrence.key);
        this.tooltip = occurrenceTooltip(occurrence, rootDir);
        this.command = {
            command: 'extension.goToKeywordUsage',
            title: i18n.get('goToKeyword'),
            arguments: [occurrence.filePath, occurrence.startLine],
        };
    }
}

class AggregatedKeywordUsageItem extends IndexTreeItem {
    resourceUri: any;
    command: any;

    constructor(filePath, count, firstLineIndex, rootDir) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.None, 'legacy-aggregate');
        this.resourceUri = vscode.Uri.file(filePath);
        this.description = count === 1 ? i18n.get('usageSingular') : i18n.get('usagesPlural', count);
        this.contextValue = 'file';
        const rel = path.relative(rootDir, filePath);
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### ${i18n.get('aggregatedUsages')}\n\n`);
        tooltip.appendMarkdown(`- **${i18n.get('file')}**: \`${markdownCode(rel)}\`\n`);
        tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${markdownCode(filePath)}\`\n`);
        tooltip.appendMarkdown(`- **${i18n.get('totalUsages')}**: ${count}\n`);
        tooltip.appendMarkdown(`- **${i18n.get('firstOccurrence')}**: ${i18n.get('lineLabel', firstLineIndex + 1)}\n`);
        this.tooltip = tooltip;
        this.command = {
            command: 'extension.goToKeywordUsage',
            title: i18n.get('goToKeyword'),
            arguments: [filePath, firstLineIndex],
        };
    }
}

class OccurrenceGroupItem extends IndexTreeItem {
    provider: any;
    occurrences: KeywordOccurrence[];
    rootDir: string;
    layout: KeywordIndexLayout;
    allowPaging: boolean;
    _pages: OccurrencePageItem[] | null;
    _leafCache: Map<number, KeywordUsageItem>;

    constructor(label, kind, provider, occurrences, rootDir, layout, parent = null, allowPaging = true) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed, kind, parent);
        this.provider = provider;
        this.occurrences = occurrences;
        this.rootDir = rootDir;
        this.layout = layout;
        this.allowPaging = allowPaging;
        this._pages = null;
        this._leafCache = new Map();
        this.setChildFactory(() => this.buildChildren());
    }

    buildChildren() {
        if (this.allowPaging && this.occurrences.length > OCCURRENCE_PAGE_SIZE) {
            if (!this._pages) {
                this._pages = [];
                for (let start = 0; start < this.occurrences.length; start += OCCURRENCE_PAGE_SIZE) {
                    const slice = this.occurrences.slice(start, start + OCCURRENCE_PAGE_SIZE);
                    const end = start + slice.length;
                    const page = new OccurrencePageItem(
                        `${start + 1}–${end}`,
                        this.provider,
                        slice,
                        this.rootDir,
                        this.layout,
                        this,
                        start,
                    );
                    this._pages.push(page);
                }
            }
            return this._pages;
        }
        return this.occurrences.map((_occurrence, index) => this.materializeOccurrence(index));
    }

    materializeOccurrence(index) {
        if (this.allowPaging && this.occurrences.length > OCCURRENCE_PAGE_SIZE) {
            this.getIndexChildren();
            const pageIndex = Math.floor(index / OCCURRENCE_PAGE_SIZE);
            const localIndex = index % OCCURRENCE_PAGE_SIZE;
            return this._pages?.[pageIndex]?.materializeOccurrence(localIndex) || null;
        }
        if (!this._leafCache.has(index)) {
            const occurrence = this.occurrences[index];
            if (!occurrence) return null;
            this._leafCache.set(index, new KeywordUsageItem(occurrence, this.rootDir, this.layout, this));
        }
        return this._leafCache.get(index);
    }
}

class OccurrencePageItem extends OccurrenceGroupItem {
    startIndex: number;

    constructor(label, provider, occurrences, rootDir, layout, parent, startIndex) {
        super(label, 'page', provider, occurrences, rootDir, layout, parent, false);
        this.startIndex = startIndex;
        this.description = i18n.get('keywordIndexEntries', occurrences.length);
        this.iconPath = new vscode.ThemeIcon('list-ordered');
        this.id = makeTreeId(parent?.id || parent?.label || 'root', 'page', startIndex);
    }
}

class KeywordItem extends OccurrenceGroupItem {
    keyword: string;
    usages: KeywordUsage[];

    constructor(keyword, options: any = {}) {
        const occurrences = options.occurrences || [];
        super(
            keyword,
            'keyword',
            options.provider || null,
            occurrences,
            options.rootDir || '',
            options.layout || 'alphabetical',
            options.parent || null,
            true,
        );
        this.keyword = keyword;
        this.usages = occurrences.map(occurrence => ({
            filePath: occurrence.filePath,
            lineIndex: occurrence.startLine,
            endLine: occurrence.endLine,
            displayName: identityText(occurrence.displayIdentity),
            keyword: occurrence.keyword,
            category: occurrence.category,
        }));
        this.description = occurrences.length === 1
            ? i18n.get('usageSingular')
            : i18n.get('usagesPlural', occurrences.length);
        this.iconPath = new vscode.ThemeIcon('symbol-keyword');
        this.id = makeTreeId(options.layout || 'alphabetical', 'keyword', options.parent?.label || '', keyword);
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### ${i18n.get('keywordLabel')}: **${keyword}**\n\n`);
        tooltip.appendMarkdown(`- **${i18n.get('totalUsages')}**: ${occurrences.length}\n`);
        this.tooltip = tooltip;
    }
}

class CategoryItem extends IndexTreeItem {
    category: string;

    constructor(category, keywordGroups, provider, rootDir) {
        super(category, vscode.TreeItemCollapsibleState.Collapsed, 'category');
        this.category = category;
        const occurrenceCount = keywordGroups.reduce((sum, group) => sum + group.occurrences.length, 0);
        this.description = i18n.get('keywordIndexCategorySummary', keywordGroups.length, occurrenceCount);
        this.iconPath = new vscode.ThemeIcon('symbol-namespace');
        this.id = makeTreeId('category', category);
        this.children = keywordGroups.map(group => new KeywordItem(group.keyword, {
            provider,
            occurrences: group.occurrences,
            rootDir,
            layout: 'category',
            parent: this,
        }));
    }
}

class FileGroupItem extends OccurrenceGroupItem {
    filePath: string;
    resourceUri: any;

    constructor(filePath, occurrences, provider, rootDir) {
        const relative = path.relative(rootDir, filePath) || path.basename(filePath);
        super(path.basename(filePath), 'file-group', provider, occurrences, rootDir, 'order', null, true);
        this.filePath = filePath;
        this.resourceUri = vscode.Uri.file(filePath);
        this.description = `${relative} · ${i18n.get('keywordIndexEntries', occurrences.length)}`;
        this.iconPath = new vscode.ThemeIcon('file-code');
        this.id = makeTreeId('order', 'file', normalizeFileKey(filePath));
    }
}

class LsdynaKeywordIndexProvider {
    collectIncludeFiles?: (rootFile: string, onProgress?: (count: number) => void) => Promise<string[]>;
    loadProjectSnapshot?: (rootFile: string, options?: object, onProgress?: (snapshot: any) => void, cancellationToken?: any) => Promise<any>;
    invalidateProjectSnapshot?: (rootFile: string) => Promise<void>;
    shouldSkipAutomaticDocumentScan?: (document: any) => boolean;
    workspaceState: any;
    _onDidChangeTreeData: any;
    onDidChangeTreeData: any;
    roots: any[];
    _mode: 'local' | 'recursive';
    _layout: KeywordIndexLayout;
    _followCursor: boolean;
    documentIndices: Map<string, any>;
    _documentIndexVersions: Map<string, number | null>;
    _documentIndexDocuments: Map<string, any>;
    _occurrences: KeywordOccurrence[];
    _baseProjectOccurrences: KeywordOccurrence[];
    _documentOverlays: Map<string, KeywordOccurrence[]>;
    _occurrencesByFile: Map<string, KeywordOccurrence[]>;
    _occurrencePlacement: Map<string, { container: any; index: number }>;
    _keywordNodes: Map<string, KeywordItem>;
    _rootDir: string;
    _treeView: any;
    _lastRevealKey: string;
    _revealTimer: any;
    _overlayTimer: any;
    asyncDocumentIndexThreshold: number;
    documentIndexYieldInterval: number;
    _documentIndexGenerations: Map<string, number>;
    _documentIndexBuilds: Map<string, { generation: number; promise: Promise<any>; current: () => boolean }>;
    _closedDocumentKeys: Set<string>;
    maxIncrementalRescanLines: number;
    _openDocuments: Map<string, any>;
    _projectFileOrderByKey: Map<string, number>;
    _localRefreshGeneration: number;
    resolveActiveUri: () => any;

    constructor({
        resolveActiveUri = getActiveUri,
        collectIncludeFiles,
        loadProjectSnapshot,
        invalidateProjectSnapshot,
        shouldSkipAutomaticDocumentScan,
        workspaceState,
        initialLayout,
        followCursor,
        asyncDocumentIndexThreshold,
        documentIndexYieldInterval,
        maxIncrementalRescanLines,
    }: KeywordIndexProviderOptions = {}) {
        this.resolveActiveUri = resolveActiveUri;
        this.collectIncludeFiles = collectIncludeFiles;
        this.loadProjectSnapshot = loadProjectSnapshot;
        this.invalidateProjectSnapshot = invalidateProjectSnapshot;
        this.shouldSkipAutomaticDocumentScan = shouldSkipAutomaticDocumentScan;
        this.workspaceState = workspaceState || null;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.roots = [];
        this._mode = 'local';
        const storedLayout = initialLayout || this.workspaceState?.get?.(LAYOUT_STATE_KEY, 'alphabetical');
        this._layout = VALID_LAYOUTS.has(storedLayout) ? storedLayout : 'alphabetical';
        this._followCursor = followCursor === true;
        this.documentIndices = new Map();
        this._documentIndexVersions = new Map();
        this._documentIndexDocuments = new Map();
        this._occurrences = [];
        this._baseProjectOccurrences = [];
        this._documentOverlays = new Map();
        this._occurrencesByFile = new Map();
        this._occurrencePlacement = new Map();
        this._keywordNodes = new Map();
        this._rootDir = '';
        this._treeView = null;
        this._lastRevealKey = '';
        this._revealTimer = null;
        this._overlayTimer = null;
        this.asyncDocumentIndexThreshold = Math.max(
            1,
            Number(asyncDocumentIndexThreshold) || DEFAULT_ASYNC_DOCUMENT_INDEX_THRESHOLD,
        );
        this.documentIndexYieldInterval = Math.max(
            1,
            Number(documentIndexYieldInterval) || DEFAULT_DOCUMENT_INDEX_YIELD_INTERVAL,
        );
        this._documentIndexGenerations = new Map();
        this._documentIndexBuilds = new Map();
        this._closedDocumentKeys = new Set();
        this._openDocuments = new Map();
        this._projectFileOrderByKey = new Map();
        this._localRefreshGeneration = 0;
        this.maxIncrementalRescanLines = Math.max(
            1,
            Number(maxIncrementalRescanLines) || DEFAULT_MAX_INCREMENTAL_RESCAN_LINES,
        );
        this._updateContexts();
    }

    get layout() { return this._layout; }
    get mode() { return this._mode; }
    get followCursor() { return this._followCursor; }

    /**
     * Returns an already-built live document index without starting or awaiting a scan.
     * Explicit semantic helpers may use it as a boundary hint, but must remain bounded
     * and fail open when the index is absent or stale.
     */
    getDocumentBlockIndexIfReady(document) {
        if (!document?.uri || document.isClosed || !Number.isInteger(document.lineCount)) return null;
        const uriKey = documentIndexKey(document);
        const blockIndex = this.documentIndices.get(uriKey);
        const indexedVersion = this._documentIndexVersions.get(uriKey);
        const currentVersion = Number.isInteger(document.version) ? document.version : null;
        return blockIndex && blockIndex.lineCount === document.lineCount &&
            indexedVersion === currentVersion && this._documentIndexDocuments.get(uriKey) === document ? blockIndex : null;
    }

    private scopeFile = '';
    private projectRoot = '';
    private scanState = 'idle';
    private scanGeneration = 0;

    async chooseScope() {
        const selected = await vscode.window.showQuickPick([
            { label: scopeLabel('local'), mode: 'local', picked: this._mode === 'local' },
            { label: scopeLabel('recursive'), mode: 'recursive', picked: this._mode === 'recursive' },
        ], { title: i18n.get('keywordIndexChooseScope'), ignoreFocusOut: true });
        if (!selected || selected.mode === this._mode) return;
        if (selected.mode === 'local') return this.setLocal();
        return this.scan();
    }

    refreshScope() {
        return this._mode === 'recursive'
            ? this.scan({ rootFile: this.projectRoot || undefined })
            : this.setLocal();
    }

    private pendingAutomaticDocuments = new Map<string, any>();
    private changedAutomaticDocuments = new WeakSet<object>();
    private automaticRefresh: { document: any; version: number; promise: Promise<void> } | undefined;
    private automaticEpoch = 0;
    private projectionDirty = false;

    private isCurrentDocument(document) {
        const editor = vscode.window.activeTextEditor;
        return editor ? editor.document === document
            : normalizeFileKey(this.resolveActiveUri()?.fsPath) === normalizeFileKey(document?.uri?.fsPath);
    }

    stopAutomaticWork() {
        this.automaticEpoch++;
        clearTimeout(this._revealTimer);
        clearTimeout(this._overlayTimer);
        this.automaticRefresh = undefined;
    }

    async refreshAutomatically(uriOrDoc) {
        const document = uriOrDoc?.uri ? uriOrDoc : vscode.window.activeTextEditor?.document ||
            (vscode.workspace.textDocuments || []).find(doc => !doc.isClosed &&
                normalizeFileKey(doc.uri?.fsPath) === normalizeFileKey(uriOrDoc?.fsPath));
        if (document && isLsdynaFile(document)) {
            this._trackOpenDocument(document);
            this.pendingAutomaticDocuments.set(documentIndexKey(document), document);
        }
        if (this._treeView?.visible !== true) return;
        const epoch = this.automaticEpoch;
        if (this._mode === 'recursive') {
            for (const [key, pending] of this.pendingAutomaticDocuments) {
                const version = pending.version;
                const current = () => epoch === this.automaticEpoch && this._treeView?.visible === true &&
                    !pending.isClosed && pending.version === version && this._openDocuments.get(key) === pending;
                if (!current()) continue;
                await this.refreshFromUriOrDocument(pending, current);
                if (current()) this.pendingAutomaticDocuments.delete(key);
            }
            if (epoch === this.automaticEpoch && this._treeView?.visible === true && this.projectionDirty) {
                this.projectionDirty = false;
                this._setOccurrences(this._mergedProjectOccurrences(), this._rootDir);
                this._onDidChangeTreeData.fire(undefined);
            }
            return;
        }
        if (!document || !this.isCurrentDocument(document)) return;
        const version = document.version;
        if (this.automaticRefresh?.document === document && this.automaticRefresh.version === version)
            return this.automaticRefresh.promise;
        const current = () => epoch === this.automaticEpoch && this._treeView?.visible === true &&
            this.isCurrentDocument(document) && !document.isClosed && document.version === version;
        const promise = this.refreshFromUriOrDocument(document, current);
        this.automaticRefresh = { document, version, promise };
        try {
            await promise;
            if (current() && this.getDocumentBlockIndexIfReady(document))
                this.pendingAutomaticDocuments.delete(documentIndexKey(document));
        } finally {
            if ((!current() || !this.getDocumentBlockIndexIfReady(document)) && this.automaticRefresh?.promise === promise)
                this.automaticRefresh = undefined;
        }
    }

    updateDocumentAutomatically(document, event) {
        if (!document || !isLsdynaFile(document)) return false;
        this.changedAutomaticDocuments.add(document);
        this.pendingAutomaticDocuments.set(documentIndexKey(document), document);
        this._trackOpenDocument(document);
        if (this._treeView?.visible !== true ||
            (this._mode === 'local' && !this.isCurrentDocument(document)) ||
            (this._mode === 'recursive' && !this._projectFileOrderByKey.has(normalizeFileKey(document.uri.fsPath)))) {
            const key = documentIndexKey(document);
            this._invalidateDocumentGeneration(key);
            this.documentIndices.delete(key);
            this._documentIndexVersions.delete(key);
            this._documentIndexDocuments.delete(key);
            return false;
        }
        const epoch = this.automaticEpoch;
        const version = document.version;
        return this.updateDocumentIndex(document, event, () => epoch === this.automaticEpoch && this._treeView?.visible === true &&
            !document.isClosed && document.version === version &&
            (this._mode === 'recursive' || this.isCurrentDocument(document)));
    }

    attachTreeView(treeView) {
        this._treeView = treeView;
        this._updateTreeDescription();
    }

    refresh() {
        this._onDidChangeTreeData.fire(undefined);
    }

    _updateContexts() {
        for (const [key, value] of [
            ['lsdyna.keywordIndexMode', this._mode],
            ['lsdyna.keywordIndexScanning', this.scanState === 'scanning'],
            ['lsdyna.keywordIndexLayout', this._layout],
            ['lsdyna.keywordIndexFollowCursor', this._followCursor],
        ]) {
            try { void Promise.resolve(vscode.commands.executeCommand('setContext', key, value)).catch(() => undefined); } catch (_) { /* best effort */ }
        }
    }

    _updateTreeDescription() {
        if (!this._treeView) return;
        const followLabel = this._followCursor
            ? i18n.get('keywordIndexFollowOn')
            : i18n.get('keywordIndexFollowOff');
        this._treeView.description = scopeLabel(this._mode);
        const file = this._mode === 'recursive' ? this.projectRoot : this.scopeFile;
        const status = this.scanState === 'scanning' ? i18n.get('sidebarScanning')
            : this.scanState === 'incomplete' ? i18n.get('sidebarIncomplete')
            : !file ? i18n.get('sidebarOpenFile')
            : !this._occurrences.length ? i18n.get('sidebarNoKeywords') : '';
        const source = file ? `${i18n.get(this._mode === 'recursive' ? 'sidebarMainFile' : 'keywordIndexScopeCurrentFile')}: ${path.basename(file)}` : '';
        this._treeView.message = [source, status, `${layoutLabel(this._layout)} · ${followLabel}`].filter(Boolean).join('\n');
    }

    _setMode(mode) {
        this._localRefreshGeneration++;
        this._mode = mode;
        this._updateContexts();
        this._updateTreeDescription();
    }

    setLayout(layout: KeywordIndexLayout) {
        if (!VALID_LAYOUTS.has(layout) || layout === this._layout) return false;
        this._layout = layout;
        try { void Promise.resolve(this.workspaceState?.update?.(LAYOUT_STATE_KEY, layout)).catch(() => undefined); } catch (_) { /* best effort */ }
        this._lastRevealKey = '';
        this._rebuildProjection();
        this._updateContexts();
        this._updateTreeDescription();
        this._onDidChangeTreeData.fire(undefined);
        if (vscode.window.activeTextEditor) this.scheduleReveal(vscode.window.activeTextEditor, true);
        return true;
    }

    async chooseLayout() {
        const items = [
            { label: `$(list-ordered) ${i18n.get('keywordIndexLayoutOrder')}`, layout: 'order', picked: this._layout === 'order' },
            { label: `$(symbol-keyword) ${i18n.get('keywordIndexLayoutAlphabetical')}`, layout: 'alphabetical', picked: this._layout === 'alphabetical' },
            { label: `$(symbol-namespace) ${i18n.get('keywordIndexLayoutCategory')}`, layout: 'category', picked: this._layout === 'category' },
        ];
        const selected = await vscode.window.showQuickPick(items, {
            title: i18n.get('keywordIndexChooseLayoutTitle'),
            placeHolder: i18n.get('keywordIndexChooseLayoutPlaceholder'),
            ignoreFocusOut: true,
        });
        if (selected?.layout) this.setLayout(selected.layout);
        return selected?.layout || null;
    }

    toggleFollowCursor() {
        this._followCursor = !this._followCursor;
        clearTimeout(this._revealTimer);
        this._updateContexts();
        this._updateTreeDescription();
        if (this._followCursor && vscode.window.activeTextEditor) {
            this.scheduleReveal(vscode.window.activeTextEditor, true);
        }
        return this._followCursor;
    }

    _registerOccurrenceContainer(container) {
        container.occurrences.forEach((occurrence, index) => {
            this._occurrencePlacement.set(occurrence.key, { container, index });
        });
    }

    _setOccurrences(occurrences, rootDir) {
        this._occurrences = occurrences.slice();
        this._updateTreeDescription();
        this._rootDir = rootDir || '';
        this._occurrencesByFile = new Map();
        for (const occurrence of this._occurrences) {
            if (!this._occurrencesByFile.has(occurrence.fileKey)) this._occurrencesByFile.set(occurrence.fileKey, []);
            this._occurrencesByFile.get(occurrence.fileKey).push(occurrence);
        }
        for (const list of this._occurrencesByFile.values()) {
            list.sort((left, right) => left.startLine - right.startLine || left.occurrenceOrder - right.occurrenceOrder);
        }
        this._rebuildProjection();
    }

    _rebuildProjection() {
        this._occurrencePlacement = new Map();
        this._keywordNodes = new Map();
        if (this._layout === 'order') this.roots = this._buildOrderRoots();
        else if (this._layout === 'category') this.roots = this._buildCategoryRoots();
        else this.roots = this._buildAlphabeticalRoots();
    }

    _groupByKeyword(occurrences) {
        const groups = new Map();
        for (const occurrence of occurrences) {
            if (!groups.has(occurrence.keyword)) groups.set(occurrence.keyword, []);
            groups.get(occurrence.keyword).push(occurrence);
        }
        for (const list of groups.values()) {
            list.sort((left, right) =>
                left.fileOrder - right.fileOrder
                || left.startLine - right.startLine
                || left.occurrenceOrder - right.occurrenceOrder
            );
        }
        return groups;
    }

    _buildAlphabeticalRoots() {
        const groups = this._groupByKeyword(this._occurrences);
        return [...groups.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([keyword, occurrences]) => {
                const item = new KeywordItem(keyword, {
                    provider: this,
                    occurrences,
                    rootDir: this._rootDir,
                    layout: 'alphabetical',
                });
                this._keywordNodes.set(keyword, item);
                this._registerOccurrenceContainer(item);
                return item;
            });
    }

    _buildCategoryRoots() {
        const categoryGroups = new Map();
        for (const occurrence of this._occurrences) {
            if (!categoryGroups.has(occurrence.category)) categoryGroups.set(occurrence.category, []);
            categoryGroups.get(occurrence.category).push(occurrence);
        }
        const orderedCategories = [...categoryGroups.keys()].sort((left, right) => {
            const leftCategory = getCategory(left);
            const rightCategory = getCategory(right);
            return leftCategory.displayIndex - rightCategory.displayIndex || left.localeCompare(right);
        });
        return orderedCategories.map(category => {
            const groups = this._groupByKeyword(categoryGroups.get(category));
            const keywordGroups = [...groups.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([keyword, occurrences]) => ({ keyword, occurrences }));
            const item = new CategoryItem(category, keywordGroups, this, this._rootDir);
            for (const keywordItem of item.children) {
                if (!this._keywordNodes.has(keywordItem.keyword)) this._keywordNodes.set(keywordItem.keyword, keywordItem);
                this._registerOccurrenceContainer(keywordItem);
            }
            return item;
        });
    }

    _buildOrderRoots() {
        const sorted = this._occurrences.slice().sort((left, right) =>
            left.fileOrder - right.fileOrder
            || left.startLine - right.startLine
            || left.occurrenceOrder - right.occurrenceOrder
        );
        if (this._mode === 'recursive') {
            const byFile = new Map();
            for (const occurrence of sorted) {
                if (!byFile.has(occurrence.filePath)) byFile.set(occurrence.filePath, []);
                byFile.get(occurrence.filePath).push(occurrence);
            }
            return [...byFile.entries()].map(([filePath, occurrences]) => {
                const item = new FileGroupItem(filePath, occurrences, this, this._rootDir);
                this._registerOccurrenceContainer(item);
                return item;
            });
        }

        if (sorted.length <= OCCURRENCE_PAGE_SIZE) {
            return sorted.map((occurrence, index) => {
                const item = new KeywordUsageItem(occurrence, this._rootDir, 'order', null);
                this._occurrencePlacement.set(occurrence.key, { container: null, index });
                return item;
            });
        }

        const pages = [];
        for (let start = 0; start < sorted.length; start += OCCURRENCE_PAGE_SIZE) {
            const slice = sorted.slice(start, start + OCCURRENCE_PAGE_SIZE);
            const page = new OccurrencePageItem(`${start + 1}–${start + slice.length}`, this, slice, this._rootDir, 'order', null, start);
            page.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            page.id = makeTreeId('order', 'root-page', start);
            pages.push(page);
            this._registerOccurrenceContainer(page);
        }
        return pages;
    }

    _materializeOccurrence(occurrence) {
        const placement = this._occurrencePlacement.get(occurrence.key);
        if (!placement) return null;
        if (!placement.container) {
            return this.roots.find(item => item?.occurrence?.key === occurrence.key) || null;
        }
        return placement.container.materializeOccurrence(placement.index);
    }

    _buildRootsFromKeywordMap(keywordMap, rootDir) {
        // Compatibility path for legacy callers and tests that only provide start lines.  Real
        // snapshots use fileIndexes and therefore receive semantic names, end ranges and paging.
        return [...keywordMap.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([keyword, usages]) => {
                const item = new KeywordItem(keyword);
                item.usages = usages.map(({ filePath, lineIndex }) => ({ filePath, lineIndex }));
                item.description = usages.length === 1 ? i18n.get('usageSingular') : i18n.get('usagesPlural', usages.length);
                if (usages.length > KEYWORD_FOLDING_THRESHOLD) {
                    const groups = new Map();
                    for (const usage of usages) {
                        if (!groups.has(usage.filePath)) groups.set(usage.filePath, []);
                        groups.get(usage.filePath).push(usage);
                    }
                    const children = [];
                    for (const [filePath, fileUsages] of groups.entries()) {
                        if (fileUsages.length > FILE_FOLDING_THRESHOLD) {
                            children.push(new AggregatedKeywordUsageItem(filePath, fileUsages.length, fileUsages[0].lineIndex, rootDir));
                        } else {
                            for (const usage of fileUsages) {
                                children.push(new KeywordUsageItem(usage.filePath, usage.lineIndex, rootDir));
                            }
                        }
                    }
                    item.children = children;
                } else {
                    item.children = usages.map(({ filePath, lineIndex }) => new KeywordUsageItem(filePath, lineIndex, rootDir));
                }
                return item;
            });
    }

    async _buildRootsAsync(filePaths, rootDir) {
        const keywordMap = new Map();
        for (const filePath of filePaths) {
            const keywords = await keywordScanner.collectKeywordsFromFile(filePath);
            for (const { keyword, lineIndex } of keywords) {
                if (!keywordMap.has(keyword)) keywordMap.set(keyword, []);
                keywordMap.get(keyword).push({ filePath, lineIndex });
            }
        }
        return this._buildRootsFromSnapshot({ keywordMap, files: filePaths }, rootDir);
    }

    _buildRootsFromSnapshot(snapshot, rootDir) {
        const indexes = snapshotFileIndexes(snapshot);
        const occurrences = occurrencesFromSnapshot(snapshot);
        this._baseProjectOccurrences = occurrences;
        const files = Array.isArray(snapshot?.files)
            ? snapshot.files
            : indexes ? [...indexes.keys()] : [...new Set(occurrences.map(item => item.filePath))];
        this._projectFileOrderByKey = new Map(
            files.map((filePath, index) => [normalizeFileKey(filePath), index]),
        );
        this._documentOverlays.clear();
        // Project scans read disk.  Keep an already indexed dirty editor model authoritative when
        // a scan starts from that file; otherwise the newly loaded snapshot would briefly replace
        // unsaved engineering changes with stale source coordinates.
        for (const [uriKey, document] of this._openDocuments.entries()) {
            if (document?.isDirty !== true) continue;
            const blockIndex = this.documentIndices.get(uriKey);
            const fileKey = normalizeFileKey(document.uri?.fsPath);
            if (!blockIndex || !this._projectFileOrderByKey.has(fileKey)) continue;
            const fileOrder = this._projectFileOrderByKey.get(fileKey) || 0;
            this._documentOverlays.set(fileKey, this._occurrencesFromBlockIndex(blockIndex, fileOrder));
        }
        this._setOccurrences(this._mergedProjectOccurrences(), rootDir);
        return indexes || this._documentOverlays.size > 0
            ? this.roots : this._buildRootsFromKeywordMap(snapshot?.keywordMap || new Map(), rootDir);
    }

    _createDocumentIndex(document) {
        return new BlockIndex(document.uri.fsPath, {
            createBlockSummaryAccumulator: createKeywordIdentityAccumulatorFactory(),
            maxIncrementalRescanLines: this.maxIncrementalRescanLines,
        });
    }

    _requiresAsyncDocumentIndex(document) {
        return document.lineCount >= this.asyncDocumentIndexThreshold
            || !!this.shouldSkipAutomaticDocumentScan?.(document);
    }

    _documentGeneration(uriKey) {
        return this._documentIndexGenerations.get(uriKey) || 0;
    }

    _invalidateDocumentGeneration(uriKey) {
        const generation = this._documentGeneration(uriKey) + 1;
        this._documentIndexGenerations.set(uriKey, generation);
        return generation;
    }

    _trackOpenDocument(document) {
        const uriKey = documentIndexKey(document);
        const previous = this._openDocuments.get(uriKey);
        if (previous && previous !== document) {
            this._invalidateDocumentGeneration(uriKey);
            this.documentIndices.delete(uriKey);
            this._documentIndexVersions.delete(uriKey);
            this._documentIndexDocuments.delete(uriKey);
        }
        this._openDocuments.set(uriKey, document);
    }

    _documentIndex(document) {
        const uriKey = documentIndexKey(document);
        this._closedDocumentKeys.delete(uriKey);
        this._trackOpenDocument(document);
        let blockIndex = this.documentIndices.get(uriKey);
        if (!blockIndex) {
            blockIndex = this._createDocumentIndex(document);
            blockIndex.buildIndex(document.lineCount, index => document.lineAt(index).text);
            this.documentIndices.set(uriKey, blockIndex);
            this._documentIndexVersions.set(
                uriKey,
                Number.isInteger(document.version) ? document.version : null,
            );
            this._documentIndexDocuments.set(uriKey, document);
        }
        return blockIndex;
    }

    async _documentIndexAsync(document, current = () => true) {
        if (!current()) return null;
        const uriKey = documentIndexKey(document);
        this._closedDocumentKeys.delete(uriKey);
        this._trackOpenDocument(document);
        const existing = this.documentIndices.get(uriKey);
        if (existing) return existing;

        const generation = this._documentGeneration(uriKey);
        const pending = this._documentIndexBuilds.get(uriKey);
        if (pending) {
            await pending.promise;
            if (!current()) return null;
            if (this._closedDocumentKeys.has(uriKey) || document.isClosed === true) return null;
            const completed = this.documentIndices.get(uriKey);
            if (completed) return completed;
            // A content change invalidated the pending scan.  Serialize rebuilds so a rapid edit
            // stream never runs several million-line document scans concurrently.
            if (this._documentGeneration(uriKey) !== pending.generation || !pending.current()) {
                return this._documentIndexAsync(document, current);
            }
            return null;
        }

        const capturedLineCount = document.lineCount;
        const capturedVersion = Number.isInteger(document.version) ? document.version : null;
        const blockIndex = this._createDocumentIndex(document);
        let buildPromise;
        buildPromise = (async () => {
            const isStale = () => !current() ||
                this._closedDocumentKeys.has(uriKey)
                || document.isClosed === true
                || this._openDocuments.get(uriKey) !== document
                || this._documentGeneration(uriKey) !== generation
                || (capturedVersion !== null && document.version !== capturedVersion);
            try {
                const completed = await blockIndex.buildIndexAsync(
                    capturedLineCount,
                    index => document.lineAt(index).text,
                    {
                        yieldInterval: this.documentIndexYieldInterval,
                        shouldCancel: isStale,
                    },
                );
                if (!completed || isStale()) return null;
                this.documentIndices.set(uriKey, blockIndex);
                this._documentIndexVersions.set(uriKey, capturedVersion);
                this._documentIndexDocuments.set(uriKey, document);
                return blockIndex;
            } catch (_error) {
                // A TextDocument may close between event-loop chunks.  Treat that exactly like a
                // generation cancellation; structural indexing remains best effort.
                return null;
            } finally {
                const current = this._documentIndexBuilds.get(uriKey);
                if (current?.promise === buildPromise) this._documentIndexBuilds.delete(uriKey);
            }
        })();
        this._documentIndexBuilds.set(uriKey, { generation, promise: buildPromise, current });
        return buildPromise;
    }

    _occurrencesFromBlockIndex(blockIndex, fileOrder = 0) {
        return blockIndex.getOccurrences().map((block, index) =>
            makeOccurrence(block, blockIndex.filePath, fileOrder, index)
        );
    }

    _applyDocumentOverlay(document, blockIndex) {
        if (this._mode !== 'recursive') return;
        const fileKey = normalizeFileKey(document.uri.fsPath);
        if (!this._projectFileOrderByKey.has(fileKey)) return;
        const fileOrder = this._projectFileOrderByKey.get(fileKey) || 0;
        this._documentOverlays.set(fileKey, this._occurrencesFromBlockIndex(blockIndex, fileOrder));
        this._setOccurrences(this._mergedProjectOccurrences(), this._rootDir);
        this._onDidChangeTreeData.fire(undefined);
    }

    _mergedProjectOccurrences() {
        const merged = this._baseProjectOccurrences.filter(item => !this._documentOverlays.has(item.fileKey));
        for (const overlay of this._documentOverlays.values()) merged.push(...overlay);
        return merged;
    }

    _rebuildDocumentIndexAsync(document, current = () => true) {
        const uriKey = documentIndexKey(document);
        const localRefreshGeneration = this._mode === 'local'
            ? ++this._localRefreshGeneration
            : null;
        this._invalidateDocumentGeneration(uriKey);
        this.documentIndices.delete(uriKey);
        this._documentIndexVersions.delete(uriKey);
        this._documentIndexDocuments.delete(uriKey);
        return this._documentIndexAsync(document, current).then(blockIndex => {
            if (!blockIndex || !current()) return null;
            if (this._mode === 'recursive') {
                this._applyDocumentOverlay(document, blockIndex);
            } else if (localRefreshGeneration === this._localRefreshGeneration) {
                this._setOccurrences(
                    this._occurrencesFromBlockIndex(blockIndex),
                    path.dirname(document.uri.fsPath),
                );
                this._onDidChangeTreeData.fire(undefined);
            }
            return blockIndex;
        });
    }

    updateDocumentIndex(document, event, current = () => true) {
        if (!document || !isLsdynaFile(document)) return false;
        const uriKey = documentIndexKey(document);
        this._closedDocumentKeys.delete(uriKey);
        this._trackOpenDocument(document);
        let blockIndex = this.documentIndices.get(uriKey);
        if (!blockIndex) {
            this._invalidateDocumentGeneration(uriKey);
            if (this._mode === 'recursive') {
                if (this._requiresAsyncDocumentIndex(document)) {
                    void this._documentIndexAsync(document, current).then(index => {
                        if (index && current()) this._applyDocumentOverlay(document, index);
                    });
                } else {
                    blockIndex = this._documentIndex(document);
                    this._applyDocumentOverlay(document, blockIndex);
                }
            } else {
                void this.refreshFromUriOrDocument(document, current);
            }
            return false;
        }
        const changes = event?.contentChanges || [];
        if (changes.length !== 1) {
            if (changes.length > 0) void this._rebuildDocumentIndexAsync(document, current);
            return false;
        }
        const change = changes[0];
        const updated = blockIndex.updateIndex(
            {
                startLine: change.range.start.line,
                endLine: change.range.end.line,
                startCharacter: change.range.start.character,
                endCharacter: change.range.end.character,
            },
            change.text,
            document.lineCount,
            index => document.lineAt(index).text,
        );
        if (!updated) {
            void this._rebuildDocumentIndexAsync(document, current);
            return false;
        }
        this._documentIndexVersions.set(
            uriKey,
            Number.isInteger(document.version) ? document.version : null,
        );
        this._documentIndexDocuments.set(uriKey, document);
        const affectsPresentation = blockIndex.lastUpdateAffectsPresentation !== false;
        if (this._mode === 'recursive' && affectsPresentation) {
            clearTimeout(this._overlayTimer);
            this._overlayTimer = setTimeout(() => { if (current()) this._applyDocumentOverlay(document, blockIndex); }, CURSOR_REVEAL_DEBOUNCE_MS);
        }
        return affectsPresentation;
    }

    disposeDocument(document) {
        if (!document?.uri) return;
        const uriKey = documentIndexKey(document);
        if (this._openDocuments.has(uriKey) && this._openDocuments.get(uriKey) !== document) return;
        this.pendingAutomaticDocuments.delete(uriKey);
        this._closedDocumentKeys.add(uriKey);
        this._invalidateDocumentGeneration(uriKey);
        this.documentIndices.delete(uriKey);
        this._documentIndexVersions.delete(uriKey);
        this._documentIndexDocuments.delete(uriKey);
        this._openDocuments.delete(uriKey);
        const fileKey = normalizeFileKey(document.uri.fsPath);
        if (this._documentOverlays.delete(fileKey) && this._mode === 'recursive') {
            if (this._treeView?.visible === false) this.projectionDirty = true;
            else {
                this._setOccurrences(this._mergedProjectOccurrences(), this._rootDir);
                this._onDidChangeTreeData.fire(undefined);
            }
        }
    }

    refreshFromDocument(document) {
        return this.refreshFromUriOrDocument(document);
    }

    async refreshFromUriOrDocument(uriOrDoc, current?: () => boolean) {
        const automatic = !!current;
        current ??= () => true;
        if (!current()) return;
        if (!uriOrDoc) return;
        let isDocument = typeof uriOrDoc.uri !== 'undefined';
        let uri = isDocument ? uriOrDoc.uri : uriOrDoc;
        if (!isDocument) {
            const renderedUri = uri?.toString?.();
            const uriKey = renderedUri && renderedUri !== '[object Object]'
                ? renderedUri
                : normalizeFileKey(uri?.fsPath || '');
            const fileKey = normalizeFileKey(uri?.fsPath || '');
            const liveDocument = this._openDocuments.get(uriKey) ||
                (vscode.workspace.textDocuments || []).find(document => {
                    if (!document || document.isClosed === true || !isLsdynaFile(document)) return false;
                    return documentIndexKey(document) === uriKey ||
                        normalizeFileKey(document.uri?.fsPath || '') === fileKey;
                });
            if (liveDocument) {
                // Tab events expose a URI and editor events expose a TextDocument;
                // their order is not stable. Prefer the already-open live model so
                // a later tab refresh cannot replace its versioned BlockIndex with
                // a disk identity that omits VS Code's virtual EOF line.
                uriOrDoc = liveDocument;
                isDocument = true;
                uri = liveDocument.uri;
            }
        }
        if (!isLsdynaUri(uri) && !(isDocument && uriOrDoc.languageId === 'lsdyna')) return;
        if (isDocument) this._trackOpenDocument(uriOrDoc);

        if (this._mode === 'recursive') {
            if (isDocument && this._projectFileOrderByKey.has(normalizeFileKey(uri.fsPath))) {
                const uriKey = documentIndexKey(uriOrDoc);
                const existing = this.getDocumentBlockIndexIfReady(uriOrDoc);
                if (!existing && this.documentIndices.has(uriKey)) {
                    this.documentIndices.delete(uriKey); this._invalidateDocumentGeneration(uriKey);
                }
                // A clean open include can use the project snapshot directly.  A dirty document
                // must be read from the live text model; disk content is explicitly not trusted.
                if (!existing && uriOrDoc.isDirty === false && !this.changedAutomaticDocuments.has(uriOrDoc)) return;
                const blockIndex = existing || (this._requiresAsyncDocumentIndex(uriOrDoc)
                    ? await this._documentIndexAsync(uriOrDoc, current)
                    : this._documentIndex(uriOrDoc));
                if (blockIndex && current()) {
                    this._applyDocumentOverlay(uriOrDoc, blockIndex);
                    this.changedAutomaticDocuments.delete(uriOrDoc);
                }
            }
            return;
        }

        this.scopeFile = uri.fsPath;
        this._updateTreeDescription();
        const localRefreshGeneration = ++this._localRefreshGeneration;
        const sourceVersion = isDocument ? uriOrDoc.version : null;
        const isCurrentLocalRefresh = () =>
            current() && this._mode === 'local' && localRefreshGeneration === this._localRefreshGeneration &&
            (!isDocument || (!uriOrDoc.isClosed && uriOrDoc.version === sourceVersion &&
                this._openDocuments.get(documentIndexKey(uriOrDoc)) === uriOrDoc));

        const filePath = uri.fsPath;
        const uriKey = isDocument ? documentIndexKey(uriOrDoc) : uri.toString();
        let blockIndex = this.documentIndices.get(uriKey);
        if (blockIndex && isDocument) {
            const liveVersion = Number.isInteger(uriOrDoc.version) ? uriOrDoc.version : null;
            const indexedVersion = this._documentIndexVersions.get(uriKey);
            const liveIdentityMismatch = blockIndex.lineCount !== uriOrDoc.lineCount ||
                indexedVersion !== liveVersion || this._documentIndexDocuments.get(uriKey) !== uriOrDoc;
            if (liveIdentityMismatch) {
                // A clean file may first be indexed from disk through an active-tab URI.
                // VS Code TextDocument models include a virtual trailing empty line and
                // carry a live version, so that disk index is not safe for field edits.
                // Upgrade it in the provider's normal refresh path; semantic consumers
                // still only read an already-ready index and never trigger this build.
                if (this._requiresAsyncDocumentIndex(uriOrDoc)) {
                    await this._rebuildDocumentIndexAsync(uriOrDoc, current);
                    return;
                }
                this._invalidateDocumentGeneration(uriKey);
                this.documentIndices.delete(uriKey);
                this._documentIndexVersions.delete(uriKey);
                this._documentIndexDocuments.delete(uriKey);
                blockIndex = this._documentIndex(uriOrDoc);
            }
        }
        if (!blockIndex) {
            const isLarge = !isDocument || this._requiresAsyncDocumentIndex(uriOrDoc);
            const mustReadLiveDocument = isDocument && (automatic || uriOrDoc.isDirty !== false);
            if (isLarge && mustReadLiveDocument) {
                blockIndex = await this._documentIndexAsync(uriOrDoc, current);
                if (!blockIndex) {
                    if (!isCurrentLocalRefresh()) return;
                    this.roots = [];
                    this._occurrences = [];
                    this._occurrencesByFile = new Map();
                    this._onDidChangeTreeData.fire(undefined);
                    return;
                }
            } else if (isLarge) {
                blockIndex = this._createDocumentIndex({ uri, lineCount: 0 });
                try {
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Window,
                            title: i18n.get('indexingKeywordsProgress'),
                            cancellable: true,
                        },
                        async (_progress, cancellationToken) =>
                            blockIndex.buildIndexFromFile(filePath, { cancellationToken }),
                    );
                } catch (error) {
                    if (!isCurrentLocalRefresh()) return;
                    this.scanState = 'incomplete';
                    this._setOccurrences([], path.dirname(filePath));
                    this._onDidChangeTreeData.fire(undefined);
                    return;
                }
            } else {
                blockIndex = this._documentIndex(uriOrDoc);
            }
            if (!isCurrentLocalRefresh()) return;
            this.documentIndices.set(uriKey, blockIndex);
            this._documentIndexVersions.set(
                uriKey,
                isDocument && Number.isInteger(uriOrDoc.version) ? uriOrDoc.version : null,
            );
            this._documentIndexDocuments.set(uriKey, isDocument ? uriOrDoc : null);
        }

        if (!isCurrentLocalRefresh()) return;
        this.scanState = 'complete';
        this._setOccurrences(this._occurrencesFromBlockIndex(blockIndex), path.dirname(filePath));
        this._onDidChangeTreeData.fire(undefined);
    }

    async scan(scanOptions: any = {}) {
        if (this.scanState === 'scanning') {
            void vscode.window.showInformationMessage(i18n.get('indexingKeywords'));
            return false;
        }
        const uri = scanOptions.rootFile ? vscode.Uri.file(scanOptions.rootFile) : this.resolveActiveUri();
        if (!uri || !isLsdynaUri(uri)) {
            const editor = vscode.window.activeTextEditor;
            const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
            const debugInfo = [
                `activeEditor=${!!editor}`,
                `tabGroups=${!!vscode.window.tabGroups}`,
                `activeTab=${!!activeTab}`,
                `inputType=${activeTab?.input?.constructor?.name || 'none'}`,
            ].join(', ');
            vscode.window.showWarningMessage(i18n.get('openFileFirst', debugInfo));
            return false;
        }
        const rootFile = uri.fsPath;
        const rootDir = path.dirname(rootFile);
        let activeCancellationToken: any = null;
        let completed = false;
        const scanGeneration = ++this.scanGeneration;
        this.scanState = 'scanning';
        this._updateContexts();
        this._updateTreeDescription();
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: i18n.get('indexingKeywords'), cancellable: true },
                async (progress, cancellationToken) => {
                    activeCancellationToken = cancellationToken;
                    if (this.invalidateProjectSnapshot) await this.invalidateProjectSnapshot(rootFile);
                    let nextRoots;
                    if (this.loadProjectSnapshot) {
                        const options = { fullScanLargeFiles: getLsdynaConfigurationValue('scanner.fullScanLargeFiles', false) };
                        const snapshot = await this.loadProjectSnapshot(rootFile, options, partialSnapshot => {
                            const filesScanned = partialSnapshot?.files?.length || 0;
                            progress.report({ message: i18n.get('scannedFilesProgress', filesScanned) });
                            try {
                                scanOptions.onPartial?.({ filesScanned });
                            } catch (_error) {
                                // UI progress must never interrupt the shared project scan.
                            }
                        }, cancellationToken);
                        if (cancellationToken?.isCancellationRequested || scanGeneration !== this.scanGeneration) return;
                        nextRoots = this._buildRootsFromSnapshot(snapshot, rootDir);
                    } else {
                        const files = await this.collectIncludeFiles(rootFile, count => {
                            progress.report({ message: i18n.get('filesFound', count) });
                        });
                        if (cancellationToken?.isCancellationRequested || scanGeneration !== this.scanGeneration) return;
                        nextRoots = await this._buildRootsAsync(files, rootDir);
                    }
                    if (cancellationToken?.isCancellationRequested || scanGeneration !== this.scanGeneration) return;
                    this.projectRoot = rootFile;
                    this._setMode('recursive');
                    this.roots = nextRoots;
                    this._onDidChangeTreeData.fire(undefined);
                    completed = true;
                },
            );
        } catch (error) {
            if (activeCancellationToken?.isCancellationRequested || error?.name === 'CancellationError') return false;
            throw error;
        } finally {
            if (scanGeneration === this.scanGeneration) {
                this.scanState = completed ? 'complete' : 'incomplete';
                this._updateContexts();
                this._updateTreeDescription();
            }
        }
        return completed;
    }

    setLocal() {
        this.scanGeneration++;
        this.scanState = 'idle';
        this.scopeFile = '';
        this._setMode('local');
        this._baseProjectOccurrences = [];
        this._projectFileOrderByKey = new Map();
        this._documentOverlays.clear();
        const editor = vscode.window.activeTextEditor;
        const uri = editor?.document || this.resolveActiveUri();
        if (uri && (isLsdynaUri(uri.uri || uri) || uri.languageId === 'lsdyna')) return this.refreshFromUriOrDocument(uri);
        this._setOccurrences([], '');
        this._onDidChangeTreeData.fire(undefined);
        return undefined;
    }

    setRecursive() {
        return this.scan();
    }

    findOccurrence(filePath, lineIndex) {
        const occurrences = this._occurrencesByFile.get(normalizeFileKey(filePath)) || [];
        let low = 0;
        let high = occurrences.length - 1;
        const line = Math.max(0, Number(lineIndex) || 0);
        while (low <= high) {
            const middle = (low + high) >> 1;
            const occurrence = occurrences[middle];
            if (line < occurrence.startLine) high = middle - 1;
            else if (line > occurrence.endLine) low = middle + 1;
            else return occurrence;
        }
        return null;
    }

    scheduleReveal(editor, force = false) {
        if (!this._followCursor || this._treeView?.visible !== true) return;
        clearTimeout(this._revealTimer);
        this._revealTimer = setTimeout(() => this.revealForEditor(editor, { force }), CURSOR_REVEAL_DEBOUNCE_MS);
    }

    async revealForEditor(editor, options: { force?: boolean } = {}) {
        if (!this._followCursor || !editor?.document || !isLsdynaFile(editor.document) ||
            editor !== vscode.window.activeTextEditor) return false;
        if (this._treeView?.visible !== true) return false;
        const line = editor.selection?.active?.line ?? 0;
        const text = editor.document.lineAt(line).text;
        const trimmed = String(text || '').trimStart();
        if ((trimmed === '' || (trimmed.startsWith('$') && !trimmed.startsWith('$#'))) && !options.force) {
            return false;
        }
        const occurrence = this.findOccurrence(editor.document.uri.fsPath, line);
        if (!occurrence || (occurrence.key === this._lastRevealKey && !options.force)) return false;
        const item = this._materializeOccurrence(occurrence);
        if (!item || !this._treeView?.reveal) return false;

        let target = item;
        for (let parent = item.parent; parent; parent = parent.parent) {
            target = parent;
            if (parent.kind === 'keyword') break;
        }
        try {
            await this._treeView.reveal(target, { select: true, focus: false, expand: false });
            this._lastRevealKey = occurrence.key;
            return true;
        } catch (_error) {
            return false;
        }
    }

    async resolveTreeItem(item, element, token) {
        if (element?.kind === 'occurrence' || element instanceof KeywordUsageItem) {
            if (token?.isCancellationRequested) return item;
            const occurrence = element.occurrence;
            const snippet = await readFileSnippet(occurrence.filePath, occurrence.startLine, 8);
            if (snippet && !token?.isCancellationRequested) {
                const tooltip = occurrenceTooltip(occurrence, this._rootDir);
                tooltip.appendMarkdown(`\n**${i18n.get('cardDataPreview')}:**\n\n`);
                tooltip.appendMarkdown(`\`\`\`lsdyna\n${snippet}\n\`\`\``);
                tooltip.appendMarkdown('\n---\n');
                tooltip.appendMarkdown(`[${i18n.get('openFile')}](command:vscode.open?${encodeURIComponent(JSON.stringify(item.resourceUri))}) | `);
                tooltip.appendMarkdown(`[${i18n.get('openToSide')}](command:extension.openToSide?${encodeURIComponent(JSON.stringify({ resourceUri: item.resourceUri }))}) | `);
                tooltip.appendMarkdown(`[${i18n.get('revealInExplorer')}](command:extension.revealInExplorer?${encodeURIComponent(JSON.stringify({ resourceUri: item.resourceUri }))})`);
                tooltip.isTrusted = true;
                item.tooltip = tooltip;
            }
        }
        return item;
    }

    getTreeItem(element) { return element; }

    getChildren(element) {
        if (!element) return this.roots;
        if (typeof element.getIndexChildren === 'function') return element.getIndexChildren();
        return element.children || [];
    }

    getParent(element) {
        return element?.parent || null;
    }

    listSearchEntries() {
        if (this._occurrences.length === 0) {
            return (this.roots || [])
                .filter(item => item instanceof KeywordItem)
                .map(item => ({
                    keyword: item.keyword || String(item.label || ''),
                    usages: Array.isArray(item.usages) ? item.usages.slice() : [],
                    treeItem: item,
                }));
        }
        const groups = this._groupByKeyword(this._occurrences);
        return [...groups.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([keyword, occurrences]) => {
                const usages = occurrences.map(occurrence => ({
                    filePath: occurrence.filePath,
                    lineIndex: occurrence.startLine,
                    endLine: occurrence.endLine,
                    displayName: identityText(occurrence.displayIdentity),
                    keyword,
                    category: occurrence.category,
                    dataLineCount: occurrence.dataLineCount,
                    fileOrder: occurrence.fileOrder,
                }));
                const treeItem = this._keywordNodes.get(keyword) || this._materializeOccurrence(occurrences[0]);
                const searchText = [
                    keyword,
                    ...occurrences.flatMap(occurrence => [
                        identityText(occurrence.displayIdentity),
                        occurrence.displayIdentity?.identity?.value || '',
                        occurrence.category,
                        ...occurrence.categoryAliases,
                        path.basename(occurrence.filePath),
                    ]),
                ].filter(Boolean).join(' ');
                return { keyword, usages, treeItem, searchText };
            });
    }
}

function readFileSnippet(filePath, lineIndex, maxLines = 6) {
    return new Promise(resolve => {
        if (!fs.existsSync(filePath)) return resolve(null);
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let current = 0;
        const lines = [];
        reader.on('line', line => {
            if (current >= lineIndex && current < lineIndex + maxLines) lines.push(line);
            if (current >= lineIndex + maxLines) reader.close();
            current++;
        });
        reader.on('close', () => {
            stream.destroy();
            resolve(lines.join('\n'));
        });
        reader.on('error', () => {
            stream.destroy();
            resolve(null);
        });
    });
}

module.exports = {
    LsdynaKeywordIndexProvider,
    readFileSnippet,
};

export {};
