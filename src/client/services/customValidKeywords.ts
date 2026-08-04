'use strict';

/**
 * @fileoverview Read/write helpers for lsdyna.customValidKeywords.
 * @module client/services/customValidKeywords
 *
 * Array settings overwrite the whole key at a target layer. When writing, we
 * start from the currently effective list (config.get) so defaults stay intact
 * after the first user/workspace materialization.
 */

const vscode = require('vscode');

const CONFIG_KEY = 'customValidKeywords';
const SECTION = 'lsdyna';

/** @type {string[]} */
const FALLBACK_DEFAULTS = ['*END', '*TITLE', '*CASE_BEGIN', '*CASE_END'];

/**
 * Normalize a user/config keyword entry for storage.
 * Exact: "*FOO_BAR". Prefix wildcard: "*MAT_*".
 *
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeCustomKeywordEntry(raw) {
    if (raw == null) return null;
    let text = String(raw).trim().toUpperCase();
    if (!text) return null;
    if (text.startsWith('*')) {
        text = text.slice(1);
    }
    // Allow a single trailing wildcard for prefix matches.
    let wildcard = false;
    if (text.endsWith('*')) {
        wildcard = true;
        text = text.slice(0, -1);
    }
    if (!text) return null;
    if (!/^[A-Z0-9_+\-]+$/.test(text)) {
        return null;
    }
    return wildcard ? `*${text}*` : `*${text}`;
}

/**
 * Compare key without leading asterisk (and keep trailing * for wildcards).
 *
 * @param {string} entry
 * @returns {string}
 */
function matchKey(entry) {
    const normalized = normalizeCustomKeywordEntry(entry);
    if (!normalized) return '';
    return normalized.startsWith('*') ? normalized.slice(1) : normalized;
}

/**
 * @param {string[]} list
 * @returns {string[]}
 */
function normalizeList(list) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
        const n = normalizeCustomKeywordEntry(item);
        if (!n) continue;
        const key = matchKey(n);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(n);
    }
    return out;
}

/**
 * @param {any} config
 * @returns {any}
 */
function resolveConfig(config) {
    if (config && typeof config.get === 'function') {
        return config;
    }
    return vscode.workspace.getConfiguration(SECTION);
}

/**
 * Effective custom valid keywords (VS Code merged view).
 *
 * @param {{ config?: any }} [options]
 * @returns {string[]}
 */
function listCustomValidKeywords(options: { config?: any } = {}) {
    const config = resolveConfig(options.config);
    const raw = config.get(CONFIG_KEY, FALLBACK_DEFAULTS);
    return normalizeList(raw);
}

/**
 * Layered inspect of the setting.
 *
 * @param {{ config?: any }} [options]
 * @returns {{ effective: string[], global: string[]|undefined, workspace: string[]|undefined, default: string[]|undefined }}
 */
function inspectCustomValidKeywords(options: { config?: any } = {}) {
    const config = resolveConfig(options.config);
    const info = typeof config.inspect === 'function' ? config.inspect(CONFIG_KEY) : null;
    return {
        effective: listCustomValidKeywords({ config }),
        global: info && info.globalValue != null ? normalizeList(info.globalValue) : undefined,
        workspace: info && info.workspaceValue != null ? normalizeList(info.workspaceValue) : undefined,
        default: info && info.defaultValue != null
            ? normalizeList(info.defaultValue)
            : normalizeList(FALLBACK_DEFAULTS),
    };
}

/**
 * Whether the effective list already accepts this keyword (exact or wildcard).
 *
 * @param {string} keyword
 * @param {string[]} [list]
 * @returns {boolean}
 */
function isCoveredByCustomList(keyword, list) {
    const check = matchKey(normalizeCustomKeywordEntry(keyword) || keyword);
    if (!check) return false;
    const entries = list || listCustomValidKeywords();
    for (const entry of entries) {
        const key = matchKey(entry);
        if (!key) continue;
        if (key.endsWith('*')) {
            const prefix = key.slice(0, -1);
            if (check.startsWith(prefix)) return true;
        } else if (key === check) {
            return true;
        }
    }
    return false;
}

/**
 * Resolve ConfigurationTarget from a string or enum value.
 *
 * @param {any} target
 * @returns {number}
 */
function resolveTarget(target) {
    if (target === 'workspace' || target === vscode.ConfigurationTarget.Workspace) {
        return vscode.ConfigurationTarget.Workspace;
    }
    return vscode.ConfigurationTarget.Global;
}

/**
 * Read the array currently stored at a target layer (normalized).
 * When the layer is unset, seed from the effective list so defaults are kept.
 *
 * @param {any} config
 * @param {number} target
 * @returns {string[]}
 */
function readLayerList(config, target) {
    const info = typeof config.inspect === 'function' ? config.inspect(CONFIG_KEY) : null;
    if (target === vscode.ConfigurationTarget.Workspace) {
        if (info && info.workspaceValue != null) {
            return normalizeList(info.workspaceValue);
        }
    } else if (info && info.globalValue != null) {
        return normalizeList(info.globalValue);
    }
    return listCustomValidKeywords({ config });
}

/**
 * Add a keyword to the custom valid list.
 *
 * @param {{ keyword: string, target?: any, config?: any }} options
 * @returns {Promise<{ ok: boolean, status: 'added'|'exists'|'invalid', entry?: string, list?: string[] }>}
 */
async function addCustomValidKeyword(options) {
    const { keyword, target: targetOpt, config: configOpt } = options || {};
    const entry = normalizeCustomKeywordEntry(keyword);
    if (!entry) {
        return { ok: false, status: 'invalid' };
    }
    const config = resolveConfig(configOpt);
    const target = resolveTarget(targetOpt);
    const effective = listCustomValidKeywords({ config });
    if (isCoveredByCustomList(entry, effective)) {
        return { ok: true, status: 'exists', entry, list: effective };
    }
    const layer = readLayerList(config, target);
    if (isCoveredByCustomList(entry, layer)) {
        return { ok: true, status: 'exists', entry, list: layer };
    }
    const next = normalizeList([...layer, entry]);
    await config.update(CONFIG_KEY, next, target);
    return { ok: true, status: 'added', entry, list: next };
}

/**
 * Add many keywords in one config update (exact entries only).
 *
 * @param {{ keywords: string[], target?: any, config?: any }} options
 * @returns {Promise<{ ok: boolean, status: 'added'|'none', added: string[], skipped: string[], list: string[] }>}
 */
async function addManyCustomValidKeywords(options) {
    const { keywords, target: targetOpt, config: configOpt } = options || {};
    const config = resolveConfig(configOpt);
    const target = resolveTarget(targetOpt);
    const effective = listCustomValidKeywords({ config });
    const layer = readLayerList(config, target);
    const added = [];
    const skipped = [];
    const pending = [];
    const seenPending = new Set();

    for (const raw of Array.isArray(keywords) ? keywords : []) {
        const entry = normalizeCustomKeywordEntry(raw);
        if (!entry) continue;
        const key = matchKey(entry);
        if (isCoveredByCustomList(entry, effective) || isCoveredByCustomList(entry, layer) || seenPending.has(key)) {
            skipped.push(entry);
            continue;
        }
        seenPending.add(key);
        pending.push(entry);
        added.push(entry);
    }

    if (pending.length === 0) {
        return { ok: true, status: 'none', added: [], skipped, list: effective };
    }

    const next = normalizeList([...layer, ...pending]);
    await config.update(CONFIG_KEY, next, target);
    return { ok: true, status: 'added', added, skipped, list: next };
}

/**
 * Remove a keyword entry from a target layer.
 *
 * @param {{ keyword: string, target?: any, config?: any }} options
 * @returns {Promise<{ ok: boolean, status: 'removed'|'missing'|'invalid', entry?: string, list?: string[] }>}
 */
async function removeCustomValidKeyword(options) {
    const { keyword, target: targetOpt, config: configOpt } = options || {};
    const entry = normalizeCustomKeywordEntry(keyword);
    if (!entry) {
        return { ok: false, status: 'invalid' };
    }
    const config = resolveConfig(configOpt);
    const target = resolveTarget(targetOpt);
    const removeKey = matchKey(entry);
    const info = typeof config.inspect === 'function' ? config.inspect(CONFIG_KEY) : null;
    const layerRaw = target === vscode.ConfigurationTarget.Workspace
        ? (info && info.workspaceValue)
        : (info && info.globalValue);
    if (layerRaw == null) {
        return { ok: false, status: 'missing', entry };
    }
    const layer = normalizeList(layerRaw);
    const next = layer.filter(item => matchKey(item) !== removeKey);
    if (next.length === layer.length) {
        return { ok: false, status: 'missing', entry, list: layer };
    }
    await config.update(CONFIG_KEY, next, target);
    return { ok: true, status: 'removed', entry, list: next };
}

/**
 * Replace one entry with another on a target layer.
 *
 * @param {{ from: string, to: string, target?: any, config?: any }} options
 * @returns {Promise<{ ok: boolean, status: string, entry?: string, list?: string[] }>}
 */
async function replaceCustomValidKeyword(options) {
    const { from, to, target: targetOpt, config: configOpt } = options || {};
    const fromEntry = normalizeCustomKeywordEntry(from);
    const toEntry = normalizeCustomKeywordEntry(to);
    if (!fromEntry || !toEntry) {
        return { ok: false, status: 'invalid' };
    }
    const config = resolveConfig(configOpt);
    const target = resolveTarget(targetOpt);
    const info = typeof config.inspect === 'function' ? config.inspect(CONFIG_KEY) : null;
    const layerRaw = target === vscode.ConfigurationTarget.Workspace
        ? (info && info.workspaceValue)
        : (info && info.globalValue);
    if (layerRaw == null) {
        return { ok: false, status: 'missing' };
    }
    const fromKey = matchKey(fromEntry);
    const layer = normalizeList(layerRaw);
    let found = false;
    const mapped = layer.map(item => {
        if (matchKey(item) === fromKey) {
            found = true;
            return toEntry;
        }
        return item;
    });
    if (!found) {
        return { ok: false, status: 'missing', entry: fromEntry, list: layer };
    }
    const next = normalizeList(mapped);
    await config.update(CONFIG_KEY, next, target);
    return { ok: true, status: 'replaced', entry: toEntry, list: next };
}

/**
 * Suggest a prefix wildcard entry for a concrete keyword (e.g. *FOO_BAR → *FOO_*).
 *
 * @param {string} keyword
 * @returns {string|null}
 */
function suggestPrefixWildcard(keyword) {
    const entry = normalizeCustomKeywordEntry(keyword);
    if (!entry || entry.endsWith('*')) return null;
    const body = entry.slice(1);
    const idx = body.lastIndexOf('_');
    if (idx <= 0) return null;
    return normalizeCustomKeywordEntry(`*${body.slice(0, idx)}_*`);
}

/**
 * Classify which layer currently owns an exact stored entry (for manage UI).
 *
 * @param {string} keyword
 * @param {{ config?: any }} [options]
 * @returns {'workspace'|'global'|'default'|'none'}
 */
function resolveEntrySource(keyword, options: { config?: any } = {}) {
    const key = matchKey(normalizeCustomKeywordEntry(keyword) || keyword);
    if (!key) return 'none';
    const layers = inspectCustomValidKeywords(options);
    if (layers.workspace && layers.workspace.some(item => matchKey(item) === key)) {
        return 'workspace';
    }
    if (layers.global && layers.global.some(item => matchKey(item) === key)) {
        return 'global';
    }
    if (layers.default && layers.default.some(item => matchKey(item) === key)) {
        return 'default';
    }
    if (layers.effective.some(item => matchKey(item) === key)) {
        return 'global';
    }
    return 'none';
}

module.exports = {
    CONFIG_KEY,
    FALLBACK_DEFAULTS,
    normalizeCustomKeywordEntry,
    matchKey,
    listCustomValidKeywords,
    inspectCustomValidKeywords,
    isCoveredByCustomList,
    addCustomValidKeyword,
    addManyCustomValidKeywords,
    removeCustomValidKeyword,
    replaceCustomValidKeyword,
    suggestPrefixWildcard,
    resolveEntrySource,
    resolveTarget,
};

export {};
