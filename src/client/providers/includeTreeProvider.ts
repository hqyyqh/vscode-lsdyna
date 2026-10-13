'use strict';

/**
 * @fileoverview VS Code TreeDataProvider for scanning and visualizing the project Include Tree.
 * @module client/providers/includeTreeProvider
 * 
 * This module builds the hierarchy of include files (*INCLUDE) to display in the side bar.
 * It reads from active project snapshots, formats file sizes, tracks circular inclusion paths
 * and missing file warnings, and adds file decoration tooltip overlays.
 * 
 * Role in System: Client-side VS Code Tree View UI provider.
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const includeScanner = require('../../core/parser/includeScanner');
const i18n = require('../../core/i18n');
const {
    localDeclaredSearchPaths,
    mergeEffectiveSearchPaths,
    inheritedPathsForChild,
} = require('../../core/project/includeSearchPathResolve');

type IncludeTreeProviderOptions = {
    loadProjectStructure?: (rootFile: string, options?: any, onProgress?: any, token?: any) => Promise<any>;
    resolveActiveUri?: () => any;
    onSelectProject?: (rootFile: string) => void;
    searchFileFromPaths?: (fileName: string, searchPaths: string[]) => string;
    loadProjectSnapshot?: (rootFile: string, options?: object, onProgress?: (snapshot: any) => void, cancellationToken?: any) => Promise<any>;
    invalidateProjectSnapshot?: (rootFile: string) => Promise<void>;
};

function getLsdynaConfigurationValue(key, defaultValue) {
    const config = vscode.workspace.getConfiguration('lsdyna');
    if (!config || typeof config.get !== 'function') {
        return defaultValue;
    }
    return config.get(key, defaultValue);
}

/**
 * Formats a size in bytes into a human-readable size string (e.g. "1.2 MB").
 * 
 * @param {number} bytes - Byte count.
 * @returns {string} Formatted size string.
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < sizes.length - 1) {
        val /= 1024;
        i++;
    }
    return `${val.toFixed(1)} ${sizes[i]}`;
}

/**
 * Formats a size in bytes into a short size suffix representation (e.g. "1.2M" as "1M" or similar short strings).
 * Used inside small badges.
 * 
 * @param {number} bytes - Byte count.
 * @returns {string} Formatted short string.
 */
function formatShortBytes(bytes) {
    if (bytes <= 0) return '0';
    if (bytes < 1024) {
        return '1k';
    }
    const kb = bytes / 1024;
    if (kb < 10) {
        return `${Math.round(kb)}k`;
    }
    if (kb < 1024) {
        return 'K';
    }
    const mb = kb / 1024;
    if (mb < 10) {
        return `${Math.round(mb)}M`;
    }
    if (mb < 1024) {
        return 'M';
    }
    const gb = mb / 1024;
    if (gb < 10) {
        return `${Math.round(gb)}G`;
    }
    return 'G';
}

/**
 * Formats a size in bytes into a detailed description string using standard units.
 * 
 * @param {number} bytes - Byte count.
 * @returns {string} Visual description string (e.g. "12.3 MB").
 */
function formatVividBytes(bytes) {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < sizes.length - 1) {
        val /= 1024;
        i++;
    }
    return `${val.toFixed(1)} ${sizes[i]}`;
}

/**
 * Modifies a TreeItem description, applying file size visualization badges or status text.
 * 
 * @param {IncludeItem} item - Target tree node.
 * @param {string} relDir - Relative folder directory to record.
 */
function applyVividDescription(item, relDir, showSize = true) {
    let statusText = '';
    const desc = item.description;
    if (desc === 'not found' || desc === i18n.get('notFound')) {
        statusText = i18n.get('notFound');
    } else if (desc === 'missing' || desc === i18n.get('missing')) {
        statusText = i18n.get('missing');
    } else if (desc === 'circular' || desc === i18n.get('circular')) {
        statusText = i18n.get('circular');
    } else if (desc === 'scan failed' || desc === i18n.get('scanFailed')) {
        statusText = i18n.get('scanFailed');
    } else if (item.fileSizeVal !== undefined && showSize) {
        statusText = '• ' + formatVividBytes(item.fileSizeVal);
    }

    item.relDir = relDir || '';
    if (statusText) {
        item.description = statusText;
    } else {
        item.description = '';
    }
}

/**
 * Normalizes file paths for map lookups. Handles Windows casing.
 * 
 * @param {string} filePath - Input path.
 * @returns {string} Normalized path.
 */
function normalizePathKey(filePath) {
    if (!filePath) return '';
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Represents a single Include File Node in the Tree View.
 * @extends vscode.TreeItem
 */
class IncludeItem extends vscode.TreeItem {
    /**
     * Creates an IncludeItem.
     * 
     * @param {string} filePath - Absolute path to the file.
     * @param {boolean} exists - True if the file exists on disk.
     */
    constructor(filePath, exists) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.Collapsed);
        /**
         * Absolute path to the file.
         * @type {string}
         */
        this.filePath = filePath;
        /**
         * Child include nodes.
         * @type {IncludeItem[]}
         */
        this.children = [];
        /**
         * Parent include node (for TreeView.reveal).
         * @type {IncludeItem|null}
         */
        this.parent = null;
        this.resourceUri = vscode.Uri.file(filePath);
        /**
         * Formatted file size string.
         * @type {string}
         */
        this.fileSizeStr = '';
        /**
         * Size in bytes.
         * @type {number|undefined}
         */
        this.fileSizeVal = undefined;

        if (exists) {
            try {
                const stats = fs.statSync(filePath);
                this.fileSizeStr = formatBytes(stats.size);
                this.fileSizeVal = stats.size;
            } catch (error) {
                if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
                exists = false;
            }
        }

        if (!exists) {
            this.description = 'not found';
            this.contextValue = 'file-missing';
        } else {
            this.contextValue = 'file';
            this.iconPath = vscode.Uri.file(path.join(__dirname, '..', '..', '..', 'images', 'ls.svg'));
        }

        if (exists) {
            this.command = { command: 'vscode.open', title: i18n.get('openFile'), arguments: [vscode.Uri.file(filePath)] };
        }
        applyVividDescription(this, '', true);
    }
}

/**
 * Whether an include tree item represents a missing/unresolved file.
 *
 * @param {IncludeItem} item
 * @returns {boolean}
 */
function isMissingIncludeItem(item) {
    if (!item) return false;
    if (item.contextValue === 'file-missing') return true;
    const desc = item.description;
    return desc === 'not found'
        || desc === 'missing'
        || desc === i18n.get('notFound')
        || desc === i18n.get('missing');
}

/**
 * Attaches parent pointers so TreeView.reveal can walk up the include hierarchy.
 *
 * @param {IncludeItem} item
 * @param {IncludeItem|null} parent
 */
function attachParentLinks(item, parent) {
    if (!item) return;
    item.parent = parent || null;
    for (const child of item.children || []) {
        attachParentLinks(child, item);
    }
}

/**
 * Resolves the URI of the currently active editor or tab.
 * 
 * @returns {import('vscode').Uri|null} Active file URI.
 */
function getActiveUri() {
    const editor = vscode.window.activeTextEditor;
    if (editor) return editor.document.uri;
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab && activeTab.input) {
        const input = activeTab.input;
        if (input.uri) return input.uri;
        if (input.resource) return input.resource;
        if (input.modified) return input.modified;
        if (input.original) return input.original;
    }
    return null;
}

/**
 * Checks if a URI targets an LS-DYNA file type.
 * 
 * @param {import('vscode').Uri|null} uri - URI to inspect.
 * @returns {boolean} True if file matches lsdyna extensions.
 */
function isLsdynaUri(uri) {
    if (!uri) return false;
    const ext = path.extname(uri.fsPath).toLowerCase();
    const configExtensions = getLsdynaConfigurationValue('additionalExtensions', ['.k', '.key', '.dyna']) || ['.k', '.key', '.dyna'];
    const normalizedExtensions = configExtensions.map(e => {
        const trimmed = e.trim().toLowerCase();
        return trimmed.startsWith('.') ? trimmed : '.' + trimmed;
    });
    return normalizedExtensions.includes(ext);
}

/**
 * Checks if a VS Code TextDocument corresponds to LS-DYNA.
 * 
 * @param {import('vscode').TextDocument|null} document - Document.
 * @returns {boolean} True if lsdyna.
 */
function isLsdynaFile(document) {
    if (!document || !document.uri) return false;
    return isLsdynaUri(document.uri) || document.languageId === 'lsdyna';
}

/**
 * VS Code TreeDataProvider implementation for LS-DYNA Include Tree side bar.
 * @implements {vscode.TreeDataProvider<IncludeItem>}
 */
class LsdynaIncludeTreeProvider {
    resolveActiveUri: () => any;
    onSelectProject?: (rootFile: string) => void;
    showSize = true;
    sortMode = 'tree';
    loadProjectStructure?: (rootFile: string, options?: any, onProgress?: any, token?: any) => Promise<any>;
    searchFileFromPaths?: (fileName: string, searchPaths: string[]) => string;
    loadProjectSnapshot?: (rootFile: string, options?: object, onProgress?: (snapshot: any) => void, cancellationToken?: any) => Promise<any>;
    invalidateProjectSnapshot?: (rootFile: string) => Promise<void>;
    _onDidChangeTreeData: any;
    onDidChangeTreeData: any;
    root: IncludeItem | null;
    resolvedPaths: Map<string, string>;
    missingPaths: Set<string>;

    /**
     * Creates an instance of LsdynaIncludeTreeProvider.
     * 
     * @param {Object} [options={}] - Dependencies.
     * @param {function(string, string[]): string} [options.searchFileFromPaths] - Absolute path resolver helper.
     * @param {function(string): Promise<import('../../core/project/projectIndexer').ProjectIndexResult>} [options.loadProjectSnapshot] - Snapshot loader.
     * @param {function(string): Promise<void>} [options.invalidateProjectSnapshot] - Invalidate cache.
     */
    constructor({ searchFileFromPaths, loadProjectSnapshot, loadProjectStructure, invalidateProjectSnapshot, resolveActiveUri = getActiveUri, onSelectProject }: IncludeTreeProviderOptions = {}) {
        this.resolveActiveUri = resolveActiveUri;
        this.onSelectProject = onSelectProject;
        this.searchFileFromPaths = searchFileFromPaths;
        this.loadProjectSnapshot = loadProjectSnapshot;
        this.loadProjectStructure = loadProjectStructure;
        this.invalidateProjectSnapshot = invalidateProjectSnapshot;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        /**
         * Root include tree item.
         * @type {IncludeItem|null}
         */
        this.root = null;
        /**
         * Map matching resolved file paths to their short sizes.
         * @type {Map<string, string>}
         */
        this.resolvedPaths = new Map();
        /**
         * Set tracking missing dependency paths.
         * @type {Set<string>}
         */
        this.missingPaths = new Set();
    }

    private treeView: any;

    attachTreeView(treeView) {
        this.treeView = treeView;
        this.updateTreeDescription();
    }

    private updateTreeDescription() {
        if (!this.treeView) return;
        const status = this.scanPhase === 'structure' || this.scanPhase === 'references'
            ? i18n.get('sidebarScanning')
            : this.scanPhase === 'incomplete' ? i18n.get('sidebarIncomplete')
            : !this.root ? i18n.get(isLsdynaUri(this.resolveActiveUri()) ? 'sidebarNotScanned' : 'sidebarOpenFile')
            : !this.root.children?.length ? i18n.get('sidebarNoIncludes') : '';
        this.treeView.message = status || undefined; // ponytail: YAGNI, root node already shows main file name
    }


    toggleShowSize() {
        if (this.sortMode === 'flat-size') return; // 防呆
        this.showSize = !this.showSize;
        this.updateAllDescriptions();
        this.refresh();
        vscode.commands.executeCommand('setContext', 'lsdyna.includeShowSize', this.showSize ? 'true' : 'false');
    }

    setSortMode(mode) {
        this.sortMode = mode;
        if (mode === 'flat-size') this.showSize = true;
        this.updateAllDescriptions();
        this.refresh();
        vscode.commands.executeCommand('setContext', 'lsdyna.includeSortMode', mode);
    }

    updateAllDescriptions() {
        if (!this.root) return;
        const walk = (node) => {
            applyVividDescription(node, node.relDir, this.showSize);
            if (node.children) node.children.forEach(walk);
        };
        walk(this.root);
    }

    refresh() {
        this.updateTreeDescription();
        this._onDidChangeTreeData.fire(undefined);
    }

    clearProjectSnapshot() {
        this.scanGeneration++;
        this.scanPhase = "idle";
        this.root = null;
        this.resolvedPaths.clear();
        this.missingPaths.clear();
        this.refresh();
    }

    /**
     * Triggers a workspace scan starting from the active editor document to rebuild the tree.
     * 
     * @returns {Promise<void>}
     */
    scanGeneration = 0;
    scanPhase = 'idle';
    structureRoot: any = null;
    structureDescription: any = '';

    markReferencesIncomplete() {
        this.scanPhase = 'incomplete';
        this.updateTreeDescription();
        if (this.root && this.root === this.structureRoot) {
            this.root.description = `${this.structureDescription} · ${i18n.get(this.loadProjectStructure ? 'scanStructureIncomplete' : 'scanReferencesIncomplete')}`;
            this.refresh();
        }
    }

    _collectTreePaths(root) {
        const resolved = new Map();
        const missing = new Set<string>();
        let incomplete = false;
        const visit = (item) => {
            if (item.pending) return;
            if (item.scanFailed) incomplete = true;
            const key = normalizePathKey(item.filePath);
            if (isMissingIncludeItem(item)) missing.add(key);
            else resolved.set(key, formatShortBytes(item.fileSizeVal || 0));
            for (const child of item.children || []) visit(child);
        };
        visit(root);
        return { resolved, missing, incomplete };
    }

    acceptStructure(snapshot, rootFile, complete = false) {
        const root = this._buildRootFromSnapshot(snapshot, rootFile);
        if (!root) return;
        const { resolved, missing } = this._collectTreePaths(root);
        root.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        this.structureDescription = root.description || '';
        if (!complete) root.description = `${this.structureDescription} · ${i18n.get(snapshot.structureOnly ? 'scanStructureProgress' : 'scanReferencesPending')}`;
        const changed = new Set<any>();
        const reconcile = (previous, next) => {
            if (!previous || previous.id !== next.id) return next;
            const oldChildren = new Map(previous.children.map(child => [child.id, child]));
            const children = next.children.map(child => reconcile(oldChildren.get(child.id), child));
            const before = JSON.stringify([previous.label, previous.description, previous.contextValue,
                previous.children.map(child => child.id)]);
            const after = JSON.stringify([next.label, next.description, next.contextValue, children.map(child => child.id)]);
            Object.assign(previous, next, { children });
            if (before !== after) changed.add(previous);
            return previous;
        };
        const previous = this.root;
        this.root = reconcile(previous, root);
        attachParentLinks(this.root, null);
        this.structureRoot = this.root;
        this.resolvedPaths = resolved;
        this.missingPaths = missing;
        this.updateTreeDescription();
        if (previous !== this.root) this._onDidChangeTreeData.fire(undefined);
        else for (const item of changed) this._onDidChangeTreeData.fire(item);
    }

    updateProjectStructure(snapshot) {
        if (!this.loadProjectStructure || !this.root || normalizePathKey(this.root.filePath) !== normalizePathKey(snapshot.rootFile)) return;
        this.scanPhase = 'complete'; this.acceptStructure(snapshot, snapshot.rootFile, true);
    }

    async scan(rootFile?: string) {
        const uri = rootFile ? vscode.Uri.file(rootFile) : this.resolveActiveUri();
        if (!uri || !isLsdynaUri(uri)) {
            const editor = vscode.window.activeTextEditor;
            const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
            const debugInfo = [
                `activeEditor=${!!editor}`,
                `tabGroups=${!!vscode.window.tabGroups}`,
                `activeTab=${!!activeTab}`,
                `inputType=${activeTab?.input?.constructor?.name || 'none'}`,
                `inputKeys=${activeTab?.input ? JSON.stringify(Object.keys(activeTab.input)) : 'none'}`
            ].join(', ');
            vscode.window.showWarningMessage(i18n.get('openFileFirst', debugInfo));
            return;
        }
        this.onSelectProject?.(uri.fsPath);
        const generation = ++this.scanGeneration;
        const document = [vscode.window.activeTextEditor?.document, ...(vscode.workspace.textDocuments || [])]
            .find(candidate => candidate && !candidate.isClosed && normalizePathKey(candidate.uri.fsPath) === normalizePathKey(uri.fsPath));
        const version = document?.version;
        const wasDirty = document?.isDirty;
        const isCurrent = () => generation === this.scanGeneration &&
            (!document || (document.version === version && (!wasDirty || !document.isClosed)));
        this.scanPhase = 'structure';
        this.updateTreeDescription();
        let activeCancellationToken: any = null;
        let completedSnapshot = null;
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: i18n.get('scanningIncludes'), cancellable: true },
                async (progress, cancellationToken) => {
                    const scanToken = {
                        get isCancellationRequested() { return !isCurrent() || cancellationToken?.isCancellationRequested; },
                        onCancellationRequested(listener) {
                            const timer = setInterval(() => {
                                if (scanToken.isCancellationRequested) { clearInterval(timer); listener(); }
                            }, 25);
                            timer.unref?.();
                            return { dispose: () => clearInterval(timer) };
                        },
                    };
                    activeCancellationToken = scanToken;

                    let nextRoot = null;
                    if (this.loadProjectStructure || this.loadProjectSnapshot) {
                        const options = { fullScanLargeFiles: getLsdynaConfigurationValue('scanner.fullScanLargeFiles', false) };
                        const snapshot = await (this.loadProjectStructure || this.loadProjectSnapshot)(uri.fsPath, options, (event) => {
                            if (!isCurrent() || cancellationToken?.isCancellationRequested) return;
                            if (event?.type === 'structureProgress') {
                                this.acceptStructure(event.snapshot, uri.fsPath);
                                progress.report({ message: i18n.get('scannedFilesProgress', event.snapshot.files.length) });
                            } else if (event?.type === 'structureReady') {
                                this.acceptStructure(event.snapshot, uri.fsPath);
                                this.scanPhase = 'references';
                                progress.report({ message: i18n.get('scanReferencesProgress') });
                            } else if (event?.type === 'progress') {
                                if (event.phase === 'restarting') {
                                    this.root = null;
                                    this.resolvedPaths.clear(); this.missingPaths.clear();
                                    this.refresh();
                                }
                                progress.report({ message: event.phase === 'references'
                                    ? i18n.get('scanReferencesProgress') + (event.filePath ? ' ' + path.basename(event.filePath) : '')
                                    : i18n.get('scannedFilesProgress', event.processedFiles || 0) });
                            } else {
                                progress.report({ message: i18n.get('scannedFilesProgress', event?.files?.length || 0) });
                            }
                        }, scanToken);
                        if (!isCurrent()) return;
                        if (cancellationToken?.isCancellationRequested) return;
                        completedSnapshot = snapshot;
                        nextRoot = this._buildRootFromSnapshot(snapshot, uri.fsPath);
                    } else {
                        nextRoot = await this._buildItem(uri.fsPath, new Set(), progress, uri.fsPath);
                        if (cancellationToken?.isCancellationRequested) return;
                    }

                    if (!nextRoot || !isCurrent() || cancellationToken?.isCancellationRequested) return;
                    const { resolved, missing, incomplete } = this._collectTreePaths(nextRoot);
                    this.scanPhase = incomplete ? 'incomplete' : 'complete';
                    nextRoot.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                    this.root = nextRoot;
                    this.resolvedPaths = resolved;
                    this.missingPaths = missing;
                    this.refresh();
                },
            );
        } catch (error) {
            if (generation === this.scanGeneration) {
                this.markReferencesIncomplete();
                if (!isCurrent() || error?.name === 'ScanChangedError') {
                    this.root = null; this.resolvedPaths.clear(); this.missingPaths.clear();
                    this.refresh();
                }
            }
            if (activeCancellationToken?.isCancellationRequested || error?.name === 'CancellationError') return;
            throw error;
        }
        if (generation === this.scanGeneration && !isCurrent()) {
            this.clearProjectSnapshot();
            return null;
        }
        if (isCurrent() && activeCancellationToken?.isCancellationRequested) this.markReferencesIncomplete();
        if (!isCurrent() || this.scanPhase !== 'complete' || !this.root || (this.loadProjectSnapshot && !completedSnapshot)) return null;
        return {
            rootFile: this.root.filePath,
            snapshot: completedSnapshot,
        };
    }

    /**
     * Converts a ProjectGraph node representation recursively into TreeItem structures.
     * 
     * @private
     * @param {import('../../core/project/projectGraph').GraphTreeNode} node - Graph node.
     * @param {string} rootPath - Ancestor file path.
     * @returns {IncludeItem} Assembled tree item.
     */
    _buildItemFromTreeNode(node, rootPath, parentId = '') {
        const item = new IncludeItem(node.filePath, !node.missing && !node.pending);
        item.id = parentId ? `${parentId}/${node.occurrenceId || `${node.fromFile}:${node.lineIndex}`}` : `include:${node.filePath}`;
        if (node.pending) {
            item.pending = true;
            item.label = node.fileName;
            item.description = i18n.get('projectIncludePending');
            item.iconPath = new vscode.ThemeIcon('loading~spin');
            item.command = undefined; item.resourceUri = undefined;
            item.contextValue = 'includePending';
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            item.tooltip = i18n.get('projectIncludePending');
            return item;
        } else if (node.cycle) {
            item.description = 'circular';
            item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.orange'));
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else if (node.missing) {
            item.description = 'missing';
            item.iconPath = new vscode.ThemeIcon('warning');
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else {
            item.children = (node.children || []).map(childNode => this._buildItemFromTreeNode(childNode, rootPath || node.filePath, item.id));
            item.collapsibleState = item.children.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None;
        }

        let dirStr = '';
        if (rootPath && rootPath !== node.filePath) {
            const dir = path.dirname(rootPath);
            const rel = path.relative(dir, node.filePath);
            const relDir = path.dirname(rel);
            dirStr = relDir === '.' ? '' : relDir;
        }
        applyVividDescription(item, dirStr, this.showSize ?? true);
        if (!node.cycle && !node.missing && ['waiting', 'scanning'].includes(node.scanState)) {
            item.description = `${item.description || ''} · ${i18n.get(node.scanState === 'waiting' ? 'projectFileWaiting' : 'projectFileScanning')}`;
            item.iconPath = new vscode.ThemeIcon(node.scanState === 'waiting' ? 'clock' : 'loading~spin');
        }
        if (node.scanState === 'failed') {
            item.description = `${item.description || ''} · ${i18n.get('scanStructureIncomplete')}`;
            item.iconPath = new vscode.ThemeIcon('warning');
        }

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### ${i18n.get('includeFile')}: **${path.basename(node.filePath)}**\n\n`);
        tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${node.filePath}\`\n`);
        if (node.cycle) {
            tooltip.supportThemeIcons = true;
            tooltip.appendMarkdown(`- **${i18n.get('status')}**: ${i18n.get('circularDependency')}\n`);
        } else if (node.scanState === 'failed') {
            tooltip.appendMarkdown(`- **${i18n.get('status')}**: ${i18n.get('scanStructureIncomplete')}\n`);
        } else if (!node.missing && item.children.length > 0) {
            tooltip.appendMarkdown(`- **${i18n.get('subIncludes')}**: ${item.children.length}\n`);
        }
        item.tooltip = tooltip;

        return item;
    }

    /**
     * Generates include tree from a resolved project snapshot.
     * 
     * @private
     * @param {import('../../core/project/projectIndexer').ProjectIndexResult} snapshot - Project index snapshot.
     * @param {string} rootFile - Absolute path of the root file.
     * @returns {IncludeItem} Assembled tree.
     */
    _buildRootFromSnapshot(snapshot, rootFile) {
        const root = this._buildItemFromTreeNode(snapshot.graph.toTree(rootFile), rootFile);
        attachParentLinks(root, null);
        return root;
    }

    /**
     * Recursively parses and builds a TreeItem list for files without using global LSP snapshots.
     * (Deprecated fallback path for non-LSP mode).
     * 
     * @private
     * @param {string} filePath - Absolute path to scan.
     * @param {Set<string>} visited - Tracks visited paths.
     * @param {import('vscode').Progress<{message: string}>} progress - Progress dialog handle.
     * @param {string} rootPath - Ancestor file path.
     * @returns {Promise<IncludeItem>} Assembled tree item.
     */
    async _buildItem(filePath, visited, progress, rootPath, inheritedPaths = []) {
        const item = new IncludeItem(filePath, true);
        const exists = !isMissingIncludeItem(item);
        const actualRootPath = rootPath || filePath;

        let dirStr = '';
        if (actualRootPath !== filePath) {
            const dir = path.dirname(actualRootPath);
            const rel = path.relative(dir, filePath);
            const relDir = path.dirname(rel);
            dirStr = relDir === '.' ? '' : relDir;
        }

        if (!exists || visited.has(filePath)) {
            if (visited.has(filePath)) {
                item.description = 'circular';
                item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.orange'));
            }
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            applyVividDescription(item, dirStr, this.showSize ?? true);

            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### ${i18n.get('includeFile')}: **${path.basename(filePath)}**\n\n`);
            tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${filePath}\`\n`);
            if (visited.has(filePath)) {
                tooltip.supportThemeIcons = true;
                tooltip.appendMarkdown(`- **${i18n.get('status')}**: ${i18n.get('circularDependency')}\n`);
            }
            item.tooltip = tooltip;

            return item;
        }

        visited.add(filePath);
        progress.report({ message: path.basename(filePath) });

        let includeEntries;
        let searchPaths;
        let pathEntries = [];
        try {
            ({ includeEntries, searchPaths, pathEntries = [] } =
                await includeScanner.collectIncludeDirectivesFromFile(filePath));
        } catch (error) {
            item.scanFailed = true;
            item.description = 'scan failed';
            applyVividDescription(item, dirStr, this.showSize ?? true);

            const tooltip = new vscode.MarkdownString();
            tooltip.supportThemeIcons = true;
            tooltip.appendMarkdown(`### ${i18n.get('includeFile')}: **${path.basename(filePath)}**\n\n`);
            tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${filePath}\`\n`);
            tooltip.appendMarkdown(`- **${i18n.get('status')}**: ${i18n.get('scanFailedStatus')}\n`);
            tooltip.appendMarkdown(`- **${i18n.get('error')}**: ${error.message}\n`);
            item.tooltip = tooltip;

            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            return item;
        }

        const fileDir = path.dirname(filePath);
        const localDeclared = localDeclaredSearchPaths({
            fileDir,
            searchPaths,
            pathEntries,
        });
        const effectivePaths = mergeEffectiveSearchPaths({
            fileDir,
            localDeclaredPaths: localDeclared,
            inheritedPaths,
        });
        const childInherited = inheritedPathsForChild({
            localDeclaredPaths: localDeclared,
            inheritedPaths,
        });

        for (const { fileName } of includeEntries) {
            let childPath;
            try {
                childPath = this.searchFileFromPaths === undefined
                    ? path.resolve(fileDir, fileName)
                    : this.searchFileFromPaths(fileName, effectivePaths);
            } catch (e) {
                if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e;
                childPath = path.resolve(path.dirname(filePath), fileName);
            }
            const child = await this._buildItem(
                childPath,
                new Set(visited),
                progress,
                actualRootPath,
                childInherited
            );
            child.parent = item;
            item.children.push(child);
        }

        item.collapsibleState = item.children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        applyVividDescription(item, dirStr, this.showSize ?? true);

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### ${i18n.get('includeFile')}: **${path.basename(filePath)}**\n\n`);
        tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${filePath}\`\n`);
        if (item.children.length > 0) {
            tooltip.appendMarkdown(`- **${i18n.get('subIncludes')}**: ${item.children.length}\n`);
        }
        item.tooltip = tooltip;

        await new Promise(r => setImmediate(r));
        return item;
    }

    /**
     * Resolves metadata details when a user hovers over/selects a tree node.
     * Generates clickable command links for commands inside tooltips.
     * 
     * @param {IncludeItem} item - Target tree item.
     * @param {IncludeItem} element - Parent element.
     * @param {import('vscode').CancellationToken} token - Cancellation token.
     * @returns {Promise<IncludeItem>} Resolved tree item.
     */
    async resolveTreeItem(item, element, token) {
        if (!item.filePath || !fs.existsSync(item.filePath)) {
            return item;
        }
        try {
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### ${i18n.get('includeFile')}: **${path.basename(item.filePath)}**\n\n`);
            if (item.relDir) {
                tooltip.appendMarkdown(`- **${i18n.get('folder')}**: \`${item.relDir}\`\n`);
            }
            tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${item.filePath}\`\n`);
            if (item.fileSizeStr) {
                tooltip.appendMarkdown(`- **${i18n.get('size')}**: \`${item.fileSizeStr}\`\n`);
            }
            if (item.scanFailed) {
                tooltip.appendMarkdown(`- **${i18n.get('status')}**: ${i18n.get('scanStructureIncomplete')}\n`);
            }
            
            if (item.contextValue !== 'file-missing') {
                if (item.children && item.children.length > 0) {
                    tooltip.appendMarkdown(`- **${i18n.get('subIncludes')}**: ${item.children.length}\n`);
                }
            }
            
            tooltip.appendMarkdown(`\n---\n`);
            tooltip.appendMarkdown(`[${i18n.get('openFile')}](command:vscode.open?${encodeURIComponent(JSON.stringify(vscode.Uri.file(item.filePath)))}) | `);
            tooltip.appendMarkdown(`[${i18n.get('openToSide')}](command:extension.openToSide?${encodeURIComponent(JSON.stringify({ resourceUri: vscode.Uri.file(item.filePath) }))}) | `);
            tooltip.appendMarkdown(`[${i18n.get('revealInExplorer')}](command:extension.revealInExplorer?${encodeURIComponent(JSON.stringify({ resourceUri: vscode.Uri.file(item.filePath) }))})`);
            tooltip.isTrusted = true;
            
            item.tooltip = tooltip;
        } catch (e) {
            // Fallback to basic tooltip
        }
        return item;
    }

    /**
     * Simple node identity resolver.
     * 
     * @param {IncludeItem} element - Element to fetch.
     * @returns {IncludeItem} Input element.
     */
    getTreeItem(element) { return element; }

    /**
     * Parent resolver required by TreeView.reveal for nested include nodes.
     *
     * @param {IncludeItem} element
     * @returns {IncludeItem|null}
     */
    getParent(element) {
        return element && element.parent ? element.parent : null;
    }

    /**
     * Fetches nested child items for a node.
     * 
     * @param {IncludeItem} [element] - Target element.
     * @returns {IncludeItem[]} Nested children list.
     */
        getChildren(element) {
        if (!this.root) return [];
        if (this.sortMode === 'tree') {
            return element ? element.children : [this.root];
        }
        // Flat mode
        if (element) return []; // no children for flat list items

        // Flatten
        const flatMap = new Map();
        const walk = (node) => {
            if (!flatMap.has(node.filePath)) {
                // clone node to avoid mutating tree state
                const clone = new IncludeItem(node.filePath, true);
                clone.contextValue = node.contextValue;
                clone.iconPath = node.iconPath;
                clone.description = node.description;
                clone.tooltip = node.tooltip;
                clone.fileSizeVal = node.fileSizeVal;
                clone.relDir = node.relDir;
                clone.collapsibleState = vscode.TreeItemCollapsibleState.None;
                if (node === this.root) {
                    clone.iconPath = vscode.Uri.file(path.join(__dirname, '..', '..', '..', 'images', 'ls.svg'));
                }
                applyVividDescription(clone, clone.relDir, this.showSize);
                flatMap.set(node.filePath, clone);
            }
            if (node.children) node.children.forEach(walk);
        };
        walk(this.root);

        const arr = Array.from(flatMap.values());
        if (this.sortMode === 'flat-name') {
            return arr.sort((a, b) => require('path').basename(a.filePath).localeCompare(require('path').basename(b.filePath)));
        } else if (this.sortMode === 'flat-size') {
            return arr.sort((a, b) => (b.fileSizeVal || 0) - (a.fileSizeVal || 0));
        }
        return arr;
    }

    /**
     * Flatten unique include nodes for title-bar QuickPick search.
     * Returns an empty array when the tree has not been scanned.
     *
     * @returns {Array<{filePath: string, label: string, description: string, missing: boolean, treeItem: IncludeItem}>}
     */
    listSearchEntries() {
        if (!this.root) {
            return [];
        }
        const seen = new Set();
        const entries = [];
        const walk = (item) => {
            if (!item || !item.filePath) {
                return;
            }
            const key = normalizePathKey(item.filePath);
            if (!seen.has(key)) {
                seen.add(key);
                entries.push({
                    filePath: item.filePath,
                    label: path.basename(item.filePath),
                    description: item.relDir || '',
                    missing: isMissingIncludeItem(item),
                    treeItem: item,
                });
            }
            for (const child of item.children || []) {
                walk(child);
            }
        };
        walk(this.root);
        return entries;
    }

    /**
     * Basename of the last successful Include Tree scan root (main deck),
     * or null when the tree has not been scanned this session.
     * Used by the status bar detail HUD / tooltip — honest, not a job manager.
     *
     * @returns {string|null}
     */
    getLastScanRootName() {
        if (!this.root || !this.root.filePath) {
            return null;
        }
        const base = path.basename(String(this.root.filePath));
        return base || null;
    }
}

module.exports = {
    LsdynaIncludeTreeProvider,
    formatBytes,
    formatShortBytes,
    formatVividBytes,
    applyVividDescription,
    normalizePathKey,
    isMissingIncludeItem,
};

export {};
