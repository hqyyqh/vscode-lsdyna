'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SNAPSHOT_VERSION = 1;
const HASH_ALGORITHM = 'sha256';

function normalizeRelativePath(value) {
    return String(value || '').split(path.sep).join('/');
}

function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(HASH_ALGORITHM);
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function collectEntries(root, relativeDirectory, fileFilter, entries) {
    const directory = path.join(root, relativeDirectory);
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));

    for (const child of children) {
        const relativePath = path.join(relativeDirectory, child.name);
        const normalized = normalizeRelativePath(relativePath);
        const absolutePath = path.join(root, relativePath);
        if (child.isDirectory()) {
            await collectEntries(root, relativePath, fileFilter, entries);
            continue;
        }
        if (child.isSymbolicLink()) {
            const target = await fs.promises.readlink(absolutePath);
            const digest = crypto.createHash(HASH_ALGORITHM).update(target).digest('hex');
            entries[normalized] = {
                kind: 'symlink',
                size: Buffer.byteLength(target),
                sha256: digest,
                target,
            };
            continue;
        }
        if (!child.isFile() || (fileFilter && !fileFilter(normalized))) continue;
        const stat = await fs.promises.stat(absolutePath);
        entries[normalized] = {
            kind: 'file',
            size: stat.size,
            sha256: await hashFile(absolutePath),
        };
    }
}

function treeHash(files) {
    const hash = crypto.createHash(HASH_ALGORITHM);
    for (const relativePath of Object.keys(files).sort()) {
        const entry = files[relativePath];
        hash.update(relativePath);
        hash.update('\0');
        hash.update(entry.kind);
        hash.update('\0');
        hash.update(String(entry.size));
        hash.update('\0');
        hash.update(entry.sha256);
        hash.update('\n');
    }
    return hash.digest('hex');
}

async function snapshotDirectory(rootPath, options = {}) {
    const root = path.resolve(rootPath);
    const stat = await fs.promises.stat(root);
    if (!stat.isDirectory()) {
        throw new Error(`Snapshot root is not a directory: ${root}`);
    }

    const files = {};
    await collectEntries(root, '', options.fileFilter, files);
    return {
        version: SNAPSHOT_VERSION,
        algorithm: HASH_ALGORITHM,
        root,
        files,
        summary: summarizeFiles(files),
    };
}

function summarizeFiles(files) {
    const paths = Object.keys(files).sort();
    return {
        fileCount: paths.length,
        totalBytes: paths.reduce((sum, relativePath) => sum + files[relativePath].size, 0),
        treeSha256: treeHash(files),
    };
}

function diffSnapshots(before, after) {
    if (!before || !after || before.version !== SNAPSHOT_VERSION || after.version !== SNAPSHOT_VERSION) {
        throw new Error(`Unsupported editor-safety snapshot version; expected ${SNAPSHOT_VERSION}`);
    }

    const added = [];
    const removed = [];
    const modified = [];
    const allPaths = new Set([
        ...Object.keys(before.files || {}),
        ...Object.keys(after.files || {}),
    ]);

    for (const relativePath of [...allPaths].sort()) {
        const left = before.files[relativePath];
        const right = after.files[relativePath];
        if (!left) {
            added.push({ path: relativePath, after: right });
        } else if (!right) {
            removed.push({ path: relativePath, before: left });
        } else if (
            left.kind !== right.kind ||
            left.size !== right.size ||
            left.sha256 !== right.sha256
        ) {
            modified.push({ path: relativePath, before: left, after: right });
        }
    }

    return {
        clean: added.length === 0 && removed.length === 0 && modified.length === 0,
        added,
        removed,
        modified,
    };
}

async function copyDirectoryExact(sourcePath, targetPath, options = {}) {
    const source = path.resolve(sourcePath);
    const target = path.resolve(targetPath);
    const relativeTarget = path.relative(source, target);
    if (!relativeTarget || (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget))) {
        throw new Error('Isolation target must not be inside the source directory');
    }

    const sourceStat = await fs.promises.stat(source);
    if (!sourceStat.isDirectory()) {
        throw new Error(`Isolation source is not a directory: ${source}`);
    }
    if (fs.existsSync(target)) {
        throw new Error(`Isolation target already exists: ${target}`);
    }

    async function copyDirectory(relativeDirectory) {
        const sourceDirectory = path.join(source, relativeDirectory);
        const targetDirectory = path.join(target, relativeDirectory);
        await fs.promises.mkdir(targetDirectory, { recursive: true });
        const children = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
        children.sort((left, right) => left.name.localeCompare(right.name, 'en'));

        for (const child of children) {
            const relativePath = path.join(relativeDirectory, child.name);
            const normalized = normalizeRelativePath(relativePath);
            const sourceEntry = path.join(source, relativePath);
            const targetEntry = path.join(target, relativePath);
            if (child.isDirectory()) {
                await copyDirectory(relativePath);
            } else if (child.isSymbolicLink()) {
                const linkTarget = await fs.promises.readlink(sourceEntry);
                await fs.promises.symlink(linkTarget, targetEntry);
            } else if (child.isFile() && (!options.fileFilter || options.fileFilter(normalized))) {
                await fs.promises.copyFile(sourceEntry, targetEntry);
            }
        }
    }

    await copyDirectory('');
    return target;
}

module.exports = {
    HASH_ALGORITHM,
    SNAPSHOT_VERSION,
    copyDirectoryExact,
    diffSnapshots,
    hashFile,
    normalizeRelativePath,
    snapshotDirectory,
    summarizeFiles,
    treeHash,
};
