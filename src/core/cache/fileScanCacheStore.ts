import { keywordDataPath } from "../keywordDataPath";
'use strict';

/**
 * @fileoverview Capacity- and age-bounded persistent per-file scan cache.
 *
 * The worker stores compact structural scan results here so unchanged Include
 * files do not need to be decoded again in the next VS Code session.  Every
 * public operation is serialized because cache cleanup may run while a project
 * scan is finishing.  Entries are accepted only when both the file signature
 * and the scanner/runtime identity still match.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const referenceIndex = require(keywordDataPath("references/field_reference_index.json"));
const { SCANNER_VERSION } = require('../scanner/scannerContracts');

const INDEX_FILE_NAME = 'file-scan-index.json';
const PAYLOAD_DIR_NAME = 'file-scans';
const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FILE_SCAN_CACHE_SCHEMA_VERSION = [
    'file-scan-v3',
    `scanner-${SCANNER_VERSION}`,
    `reference-schema-${referenceIndex.schemaVersion || 'unknown'}`,
    `manual-runtime-${referenceIndex.generatedFrom?.manualSemanticRuntimeId || 'unknown'}`,
    `manual-manifest-${referenceIndex.generatedFrom?.manualSemanticManifestSha256 || 'unknown'}`,
].join(':');

type FileSignature = {
    mtimeMs: number;
    size: number;
};

type FileScanCacheIndexEntry = {
    payloadFile: string;
    signature: FileSignature;
    byteSize: number;
    lastAccessedAt: number;
};

type FileScanCacheStoreOptions = {
    cacheDirectory?: string;
    schemaVersion?: string | number;
    maxCacheBytes?: number;
    maxEntryAgeMs?: number;
    now?: () => number;
};

function getFileCacheKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getPayloadFileName(cacheKey) {
    return crypto.createHash('sha1').update(cacheKey).digest('hex') + '.json';
}

function areSignaturesEqual(left, right) {
    return left && right && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function isValidSignature(signature) {
    return signature
        && Number.isFinite(signature.mtimeMs)
        && Number.isFinite(signature.size)
        && signature.size >= 0;
}

function isSafeIndexEntry(entry) {
    return entry
        && typeof entry.payloadFile === 'string'
        && path.basename(entry.payloadFile) === entry.payloadFile
        && /^[0-9a-f]{40}\.json$/.test(entry.payloadFile)
        && isValidSignature(entry.signature)
        && Number.isFinite(entry.byteSize)
        && entry.byteSize >= 0
        && Number.isFinite(entry.lastAccessedAt)
        && entry.lastAccessedAt >= 0;
}

function createFileScanCacheStore({
    cacheDirectory,
    schemaVersion = FILE_SCAN_CACHE_SCHEMA_VERSION,
    maxCacheBytes = DEFAULT_MAX_CACHE_BYTES,
    maxEntryAgeMs = DEFAULT_MAX_ENTRY_AGE_MS,
    now = Date.now,
}: FileScanCacheStoreOptions = {}) {
    if (typeof cacheDirectory !== 'string' || cacheDirectory.trim() === '') {
        throw new TypeError('createFileScanCacheStore requires a cacheDirectory path');
    }
    if (typeof maxCacheBytes !== 'number' || Number.isNaN(maxCacheBytes) || maxCacheBytes <= 0) {
        throw new TypeError('createFileScanCacheStore requires maxCacheBytes to be a positive number');
    }
    if (typeof maxEntryAgeMs !== 'number' || Number.isNaN(maxEntryAgeMs) || maxEntryAgeMs <= 0) {
        throw new TypeError('createFileScanCacheStore requires maxEntryAgeMs to be a positive number');
    }
    if (typeof now !== 'function') {
        throw new TypeError('createFileScanCacheStore requires now to be a function');
    }

    const resolvedCacheDir = path.resolve(cacheDirectory);
    const indexFilePath = path.join(resolvedCacheDir, INDEX_FILE_NAME);
    const payloadDirPath = path.join(resolvedCacheDir, PAYLOAD_DIR_NAME);

    /** @type {Map<string, FileScanCacheIndexEntry>|null} */
    let indexCache = null;
    /** @type {Promise<any>} */
    let mutationChain = Promise.resolve();

    async function ensureDirectories() {
        await fs.promises.mkdir(payloadDirPath, { recursive: true });
    }

    async function removeFileIfExists(filePath) {
        try {
            await fs.promises.rm(filePath, { force: true });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }

    async function writeFileAtomically(targetPath, content) {
        const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        try {
            await fs.promises.writeFile(tempPath, content, 'utf8');
            await fs.promises.rename(tempPath, targetPath);
        } finally {
            await removeFileIfExists(tempPath);
        }
    }

    function getIndexStats(index) {
        let totalBytes = 0;
        for (const entry of index.values()) totalBytes += entry.byteSize;
        return { entryCount: index.size, totalBytes };
    }

    async function saveIndex(index = indexCache) {
        if (!index) return;
        await ensureDirectories();
        const entries = Object.fromEntries(
            [...index.entries()].sort((left, right) => left[0].localeCompare(right[0]))
        );
        await writeFileAtomically(indexFilePath, JSON.stringify({ schemaVersion, entries }));
    }

    async function resetStorage() {
        await fs.promises.rm(payloadDirPath, { recursive: true, force: true });
        await removeFileIfExists(indexFilePath);
        await ensureDirectories();
        indexCache = new Map();
        return indexCache;
    }

    function isEntryExpired(entry, currentTime = now()) {
        return Number.isFinite(maxEntryAgeMs)
            && currentTime - entry.lastAccessedAt >= maxEntryAgeMs;
    }

    async function deleteEntry(index, cacheKey) {
        const entry = index.get(cacheKey);
        if (!entry) return false;
        index.delete(cacheKey);
        await removeFileIfExists(path.join(payloadDirPath, entry.payloadFile));
        return true;
    }

    async function removeExpiredEntries(index, currentTime = null) {
        if (index.size === 0) return false;
        const effectiveTime = currentTime ?? now();
        let changed = false;
        for (const [cacheKey, entry] of [...index.entries()]) {
            if (!isEntryExpired(entry, effectiveTime)) continue;
            changed = await deleteEntry(index, cacheKey) || changed;
        }
        return changed;
    }

    async function evictEntriesIfNeeded(index, protectedCacheKey = null) {
        let changed = false;
        while (getIndexStats(index).totalBytes > maxCacheBytes) {
            const candidates = [...index.entries()]
                .filter(([cacheKey]) => cacheKey !== protectedCacheKey)
                .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);
            const victimKey = candidates.length > 0
                ? candidates[0][0]
                : protectedCacheKey;
            if (!victimKey || !index.has(victimKey)) break;
            changed = await deleteEntry(index, victimKey) || changed;
        }
        return changed;
    }

    async function reconcilePayloadFiles(index) {
        let names = [];
        try {
            names = await fs.promises.readdir(payloadDirPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const available = new Set(names);
        const referenced = new Set();
        let changed = false;
        for (const [cacheKey, entry] of [...index.entries()]) {
            if (!available.has(entry.payloadFile)) {
                index.delete(cacheKey);
                changed = true;
                continue;
            }
            referenced.add(entry.payloadFile);
            try {
                const stat = await fs.promises.stat(path.join(payloadDirPath, entry.payloadFile));
                if (!stat.isFile()) {
                    index.delete(cacheKey);
                    referenced.delete(entry.payloadFile);
                    changed = true;
                    continue;
                }
                if (entry.byteSize !== stat.size) {
                    entry.byteSize = stat.size;
                    changed = true;
                }
            } catch (_error) {
                index.delete(cacheKey);
                referenced.delete(entry.payloadFile);
                changed = true;
            }
        }
        await Promise.all(names
            .filter(name => !referenced.has(name))
            .map(async name => {
                try {
                    const orphanPath = path.join(payloadDirPath, name);
                    const stat = await fs.promises.stat(orphanPath);
                    if (stat.isFile()) await removeFileIfExists(orphanPath);
                } catch (_error) { /* best-effort orphan cleanup */ }
            }));
        return changed;
    }

    async function loadIndex() {
        if (indexCache) return indexCache;
        await ensureDirectories();
        try {
            const raw = await fs.promises.readFile(indexFilePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.schemaVersion !== schemaVersion || !parsed.entries
                || Array.isArray(parsed.entries) || typeof parsed.entries !== 'object') {
                return resetStorage();
            }

            const rawEntries = Object.entries(parsed.entries);
            if (rawEntries.some(([, entry]) => !isSafeIndexEntry(entry))) {
                return resetStorage();
            }
            indexCache = new Map(rawEntries);
            let changed = await reconcilePayloadFiles(indexCache);
            changed = await removeExpiredEntries(indexCache) || changed;
            changed = await evictEntriesIfNeeded(indexCache) || changed;
            if (changed) await saveIndex(indexCache);
            return indexCache;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                return resetStorage();
            }
            indexCache = new Map();
            return indexCache;
        }
    }

    function runExclusive(operation) {
        const next = mutationChain.then(operation, operation);
        mutationChain = next.then(() => undefined, () => undefined);
        return next;
    }

    return {
        async get(filePath, currentSignature) {
            return runExclusive(async () => {
                const index = await loadIndex();
                const cacheKey = getFileCacheKey(filePath);
                const accessedAt = now();
                const expiredChanged = await removeExpiredEntries(index, accessedAt);
                const entry = index.get(cacheKey);
                if (!entry || !areSignaturesEqual(entry.signature, currentSignature)) {
                    const removed = entry ? await deleteEntry(index, cacheKey) : false;
                    if (expiredChanged || removed) await saveIndex(index);
                    return null;
                }

                try {
                    const payloadPath = path.join(payloadDirPath, entry.payloadFile);
                    const raw = await fs.promises.readFile(payloadPath, 'utf8');
                    const parsed = JSON.parse(raw);
                    const scannerVersion = parsed?.fileIndex?.scannerVersion ?? parsed?.scannerVersion;
                    if (scannerVersion !== undefined && scannerVersion !== SCANNER_VERSION) {
                        await deleteEntry(index, cacheKey);
                        await saveIndex(index);
                        return null;
                    }
                    entry.byteSize = Buffer.byteLength(raw, 'utf8');
                    entry.lastAccessedAt = accessedAt;
                    await evictEntriesIfNeeded(index, cacheKey);
                    await saveIndex(index);
                    await require('../references/referenceMetadata').restoreReferenceMetadata([parsed.fileIndex]);
                    return index.has(cacheKey) ? parsed : null;
                } catch (_error) {
                    await deleteEntry(index, cacheKey);
                    await saveIndex(index);
                    return null;
                }
            });
        },

        async set(filePath, signature, scanResult) {
            return runExclusive(async () => {
                if (!isValidSignature(signature)) {
                    throw new TypeError('file scan cache entries require a valid file signature');
                }
                const index = await loadIndex();
                const accessedAt = now();
                await removeExpiredEntries(index, accessedAt);
                const cacheKey = getFileCacheKey(filePath);
                const payloadFile = getPayloadFileName(cacheKey);
                const payloadContent = JSON.stringify(scanResult);
                await ensureDirectories();
                await writeFileAtomically(path.join(payloadDirPath, payloadFile), payloadContent);
                index.set(cacheKey, {
                    payloadFile,
                    signature: { mtimeMs: signature.mtimeMs, size: signature.size },
                    byteSize: Buffer.byteLength(payloadContent, 'utf8'),
                    lastAccessedAt: accessedAt,
                });
                await evictEntriesIfNeeded(index, cacheKey);
                await saveIndex(index);
            });
        },

        async invalidate(filePath) {
            return runExclusive(async () => {
                const index = await loadIndex();
                if (await deleteEntry(index, getFileCacheKey(filePath))) {
                    await saveIndex(index);
                    return true;
                }
                return false;
            });
        },

        async invalidateAll() {
            return runExclusive(async () => {
                const index = await loadIndex();
                const removed = getIndexStats(index);
                await resetStorage();
                return removed;
            });
        },

        async getStatsAsync() {
            return runExclusive(async () => getIndexStats(await loadIndex()));
        },

        getStats() {
            return getIndexStats(indexCache || new Map());
        },
    };
}

module.exports = {
    createFileScanCacheStore,
    DEFAULT_MAX_CACHE_BYTES,
    DEFAULT_MAX_ENTRY_AGE_MS,
    FILE_SCAN_CACHE_SCHEMA_VERSION,
};

export {};
