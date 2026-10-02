'use strict';

/**
 * Host-side session model for explicit namespace/ID entity queries.
 * Query identities are durable; physical result coordinates are deliberately ephemeral.
 */

const path = require('node:path');
const vscode = require('vscode');

const DEFAULT_MAX_PINNED = 10;
const DEFAULT_RESULT_BUDGET_BYTES = 8 * 1024 * 1024;

type EntityQueryScope =
    | { kind: 'project'; rootFile: string }
    | { kind: 'single-file'; filePath: string };

type EntityQueryIdentity = {
    targetKind: string;
    id: number | string;
    scope: EntityQueryScope;
};

function normalizePath(value) {
    const resolved = path.resolve(String(value || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeScope(scope): EntityQueryScope | null {
    if (scope?.kind === 'project' && scope.rootFile) {
        return { kind: 'project', rootFile: path.resolve(scope.rootFile) };
    }
    if ((scope?.kind === 'single-file' || scope?.kind === 'file') && scope.filePath) {
        return { kind: 'single-file', filePath: path.resolve(scope.filePath) };
    }
    return null;
}

function normalizeIdentity(identity): EntityQueryIdentity | null {
    const targetKind = String(identity?.targetKind || '').trim();
    const id = typeof identity?.id === 'string' ? identity.id.trim() : identity?.id;
    const scope = normalizeScope(identity?.scope);
    const validId = typeof id === 'string'
        ? (/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(id) || /^\+?\d+$/.test(id))
        : Number.isSafeInteger(id) && id > 0;
    if (!targetKind || !validId || !scope) {
        return null;
    }
    return { targetKind, id, scope };
}

function entityQueryKey(identity) {
    const normalized = normalizeIdentity(identity);
    if (!normalized) return '';
    const scopePath = normalized.scope.kind === 'project'
        ? normalized.scope.rootFile
        : normalized.scope.filePath;
    return [
        normalized.targetKind,
        String(normalized.id),
        normalized.scope.kind,
        normalizePath(scopePath),
    ].join('\0');
}

function estimateLocationsBytes(locations) {
    let bytes = 256;
    for (const location of locations || []) {
        bytes += 192;
        bytes += String(location.filePath || '').length * 2;
        bytes += String(location.keyword || '').length * 2;
        bytes += String(location.fieldName || '').length * 2;
    }
    return bytes;
}

function locationRange(location) {
    const start = new vscode.Position(location.line, location.startCharacter);
    const end = new vscode.Position(location.line, location.endCharacter);
    return new vscode.Range(start, end);
}

class LsdynaEntityReferenceProvider {
    maxPinned: number;
    resultBudgetBytes: number;
    clock: () => number;
    sessions: Map<string, any>;
    pinnedKeys: string[];
    currentKey: string | null;
    activeKey: string | null;
    referenceCursorByKey: Map<string, number>;
    _onDidChangeTreeData: any;
    onDidChangeTreeData: any;

    constructor(options: any = {}) {
        this.maxPinned = Number.isInteger(options.maxPinned) ? options.maxPinned : DEFAULT_MAX_PINNED;
        this.resultBudgetBytes = Number.isFinite(options.resultBudgetBytes)
            ? Math.max(0, options.resultBudgetBytes)
            : DEFAULT_RESULT_BUDGET_BYTES;
        this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
        this.sessions = new Map();
        this.pinnedKeys = [];
        this.currentKey = null;
        this.activeKey = null;
        this.referenceCursorByKey = new Map();
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    dispose() {
        if (this._onDidChangeTreeData && typeof this._onDidChangeTreeData.dispose === 'function') {
            this._onDidChangeTreeData.dispose();
        }
    }

    createSession(identity, pinned, state) {
        const now = this.clock();
        return {
            key: entityQueryKey(identity),
            identity,
            pinned: !!pinned,
            state,
            locations: [],
            reasons: [],
            lastAccessedAt: now,
            estimatedBytes: 0,
        };
    }

    refreshTree(node = undefined) {
        this._onDidChangeTreeData.fire(node);
    }

    getSession(target = undefined) {
        const key = typeof target === 'string'
            ? target
            : target?.queryKey || target?.session?.key || target?.key || this.activeKey;
        return key ? this.sessions.get(key) || null : null;
    }

    getActiveSession() {
        return this.getSession(this.activeKey);
    }

    getCurrentSession() {
        return this.currentKey ? this.sessions.get(this.currentKey) || null : null;
    }

    clearCurrent() {
        const key = this.currentKey;
        const session = key ? this.sessions.get(key) : null;
        if (!session || session.pinned) return false;
        this.sessions.delete(key);
        this.currentKey = null;
        this.referenceCursorByKey.delete(key);
        if (this.activeKey === key) this.activeKey = this.pinnedKeys[0] || null;
        this.refreshTree();
        return true;
    }

    listSessions() {
        const result = [];
        if (this.currentKey && this.sessions.has(this.currentKey)) {
            result.push(this.sessions.get(this.currentKey));
        }
        for (const key of this.pinnedKeys) {
            const session = this.sessions.get(key);
            if (session) result.push(session);
        }
        return result;
    }

    setActive(target) {
        const session = this.getSession(target);
        if (!session) return null;
        session.lastAccessedAt = this.clock();
        this.activeKey = session.key;
        this.refreshTree();
        return session;
    }

    publish(identityInput, result) {
        const identity = normalizeIdentity(identityInput);
        if (!identity) return null;
        const key = entityQueryKey(identity);
        let session = this.sessions.get(key);
        if (!session) {
            if (this.currentKey && this.currentKey !== key) {
                this.sessions.delete(this.currentKey);
                this.referenceCursorByKey.delete(this.currentKey);
            }
            session = this.createSession(identity, false, 'loading');
            this.sessions.set(key, session);
            this.currentKey = key;
        } else if (!session.pinned) {
            if (this.currentKey && this.currentKey !== key) this.sessions.delete(this.currentKey);
            this.currentKey = key;
        }
        session.identity = identity;
        session.resolution = result?.state;
        const navigable = ['complete', 'exact', 'ambiguous', 'partial'].includes(result?.state);
        session.state = result?.state === 'loading' ? 'loading'
            : ['complete', 'exact', 'ambiguous', 'missing'].includes(result?.state)
                ? 'ready'
            : result?.state === 'partial' ? 'partial' : 'incomplete';
        session.locations = navigable ? [...(result.locations || [])] : [];
        session.reasons = [...new Set(result?.reasons || [])];
        session.estimatedBytes = navigable
            ? estimateLocationsBytes(session.locations)
            : 0;
        session.lastAccessedAt = this.clock();
        this.activeKey = key;
        this.referenceCursorByKey.delete(key);
        this.enforceResultBudget();
        this.refreshTree();
        return session;
    }

    markLoading(target) {
        const session = this.getSession(target);
        if (!session) return null;
        session.state = 'loading';
        session.locations = [];
        session.reasons = [];
        session.estimatedBytes = 0;
        session.lastAccessedAt = this.clock();
        this.activeKey = session.key;
        this.refreshTree();
        return session;
    }

    markIncomplete(target, reasons = []) {
        const session = this.getSession(target);
        if (!session) return null;
        session.state = 'incomplete';
        session.locations = [];
        session.reasons = [...new Set(reasons || [])];
        session.estimatedBytes = 0;
        this.referenceCursorByKey.delete(session.key);
        this.refreshTree();
        return session;
    }

    markNeedsRefresh(target, reasons = []) {
        const session = this.getSession(target);
        if (!session) return null;
        session.state = 'needs-refresh';
        session.locations = [];
        session.reasons = [...new Set(reasons || [])];
        session.estimatedBytes = 0;
        this.referenceCursorByKey.delete(session.key);
        this.refreshTree();
        return session;
    }

    async pin(target) {
        const session = this.getSession(target);
        if (!session) return { ok: false, reason: 'missing' };
        if (session.pinned) {
            this.setActive(session);
            return { ok: true, session };
        }
        if (this.pinnedKeys.length >= this.maxPinned) {
            return { ok: false, reason: 'limit', limit: this.maxPinned };
        }
        session.pinned = true;
        this.pinnedKeys = [session.key, ...this.pinnedKeys.filter(key => key !== session.key)];
        if (this.currentKey === session.key) this.currentKey = null;
        this.activeKey = session.key;
        this.refreshTree();
        return { ok: true, session };
    }

    async unpin(target) {
        const session = this.getSession(target);
        if (!session || !session.pinned) return null;
        if (this.currentKey && this.currentKey !== session.key) {
            this.sessions.delete(this.currentKey);
            this.referenceCursorByKey.delete(this.currentKey);
        }
        session.pinned = false;
        this.pinnedKeys = this.pinnedKeys.filter(key => key !== session.key);
        this.currentKey = session.key;
        this.activeKey = session.key;
        this.refreshTree();
        return session;
    }

    async remove(target) {
        const session = this.getSession(target);
        if (!session) return false;
        this.sessions.delete(session.key);
        this.pinnedKeys = this.pinnedKeys.filter(key => key !== session.key);
        if (this.currentKey === session.key) this.currentKey = null;
        this.referenceCursorByKey.delete(session.key);
        if (this.activeKey === session.key) {
            this.activeKey = this.currentKey || this.pinnedKeys[0] || null;
        }
        this.refreshTree();
        return true;
    }

    async clear() {
        this.sessions.clear();
        this.pinnedKeys = [];
        this.currentKey = null;
        this.activeKey = null;
        this.referenceCursorByKey.clear();
        this.refreshTree();
    }

    markStaleForPath(filePath) {
        const key = normalizePath(filePath);
        let changed = false;
        for (const session of this.sessions.values()) {
            const scope = session.identity.scope;
            const resultContainsPath = session.locations.some(location => normalizePath(location.filePath) === key);
            const sameSingleFile = scope.kind === 'single-file' && normalizePath(scope.filePath) === key;
            if (!resultContainsPath && !sameSingleFile) continue;
            session.state = 'stale';
            this.referenceCursorByKey.delete(session.key);
            changed = true;
        }
        if (changed) this.refreshTree();
        return changed;
    }

    markStaleForRoot(rootFile) {
        const key = normalizePath(rootFile);
        let changed = false;
        for (const session of this.sessions.values()) {
            if (session.identity.scope.kind !== 'project' ||
                normalizePath(session.identity.scope.rootFile) !== key) continue;
            session.state = 'stale';
            this.referenceCursorByKey.delete(session.key);
            changed = true;
        }
        if (changed) this.refreshTree();
        return changed;
    }

    enforceResultBudget() {
        let total = [...this.sessions.values()].reduce((sum, session) => sum + session.estimatedBytes, 0);
        if (total <= this.resultBudgetBytes) return;
        const candidates = [...this.sessions.values()]
            .filter(session => session.estimatedBytes > 0)
            .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
        for (const session of candidates) {
            if (total <= this.resultBudgetBytes) break;
            total -= session.estimatedBytes;
            session.locations = [];
            session.estimatedBytes = 0;
            session.state = 'needs-refresh';
            session.reasons = ['entity-reference-results-evicted'];
            this.referenceCursorByKey.delete(session.key);
        }
    }

    referenceAtOffset(offset) {
        const session = this.getActiveSession();
        if (!session || (session.state !== 'ready' && session.state !== 'partial')) return null;
        const references = session.locations.filter(location => location.role === 'reference');
        if (references.length === 0) return null;
        const previous = this.referenceCursorByKey.get(session.key);
        const start = Number.isInteger(previous) ? previous : (offset > 0 ? -1 : 0);
        const index = (start + offset + references.length) % references.length;
        this.referenceCursorByKey.set(session.key, index);
        session.lastAccessedAt = this.clock();
        return { session, location: references[index], index, count: references.length };
    }

    nextReference() {
        return this.referenceAtOffset(1);
    }

    previousReference() {
        return this.referenceAtOffset(-1);
    }

    static openArguments(node, side = true) {
        const session = node?.session;
        const location = node?.location;
        if (!session || (session.state !== 'ready' && session.state !== 'partial') || !location) return null;
        return [
            vscode.Uri.file(location.filePath),
            {
                viewColumn: side ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
                preview: true,
                selection: locationRange(location),
            },
        ];
    }
}

module.exports = {
    DEFAULT_MAX_PINNED,
    DEFAULT_RESULT_BUDGET_BYTES,
    LsdynaEntityReferenceProvider,
    entityQueryKey,
    estimateLocationsBytes,
    normalizeIdentity,
    normalizeScope,
};

export {};
