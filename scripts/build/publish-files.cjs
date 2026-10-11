'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');

// ponytail: detected synchronous failures only; add a recovery journal if interrupted imports must resume automatically.
function publish(files, { beforeRename, exclusive = false } = {}) {
    if (exclusive && files.some(file => file.bytes === null))
        throw new Error('Exclusive publication cannot delete outputs');
    const destinations = files.map(file => path.resolve(file.path));
    const keys = destinations.map(file => process.platform === 'win32' ? file.toLowerCase() : file);
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate build output destination');
    const staged = [];
    let failure, failed = false;
    try {
        for (let index = 0; index < files.length; index++) {
            const destination = destinations[index];
            let previousStat;
            try {
                previousStat = fs.lstatSync(destination);
                if (!previousStat.isFile()) throw new Error(`Build output is not a regular file: ${destination}`);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            if (exclusive && previousStat)
                throw Object.assign(new Error(`Build output already exists: ${destination}`), { code: 'EEXIST' });
            const bytes = files[index].bytes === null ? null : Buffer.from(files[index].bytes);
            if (bytes === null ? !previousStat : previousStat && fs.readFileSync(destination).equals(bytes)) continue;
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            const directory = fs.mkdtempSync(`${destination}.publish-`);
            const entry = { destination, directory, next: path.join(directory, 'next'),
                previous: path.join(directory, 'previous'), existed: !!previousStat, remove: bytes === null, committed: false };
            staged.push(entry);
            if (entry.existed) fs.copyFileSync(destination, entry.previous);
            if (!entry.remove) {
                fs.writeFileSync(entry.next, bytes, { flag: 'wx' });
                if (previousStat) fs.chmodSync(entry.next, previousStat.mode & 0o777);
            }
        }
        beforeRename?.();
        for (const entry of staged) {
            if (entry.remove) fs.rmSync(entry.destination);
            else if (exclusive) fs.linkSync(entry.next, entry.destination);
            else fs.renameSync(entry.next, entry.destination);
            entry.committed = true;
        }
    } catch (error) {
        failed = true;
        failure = error;
        const restoreErrors = [];
        const recoveryTargets = [];
        for (const entry of [...staged].reverse()) {
            if (!entry.committed) continue;
            try {
                if (entry.existed) fs.renameSync(entry.previous, entry.destination);
                else {
                    if (exclusive) {
                        let destinationStat;
                        try { destinationStat = fs.lstatSync(entry.destination, { bigint: true }); }
                        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
                        const stagedStat = fs.lstatSync(entry.next, { bigint: true });
                        if (!destinationStat.isFile() || destinationStat.dev !== stagedStat.dev || destinationStat.ino !== stagedStat.ino)
                            throw new Error(`Build output ownership changed before rollback: ${entry.destination}`);
                    }
                    fs.rmSync(entry.destination, { force: true });
                }
            } catch (restoreError) {
                restoreErrors.push(restoreError);
                recoveryTargets.push(entry.existed ? entry.previous : `previously absent: ${entry.destination}`);
            }
        }
        if (restoreErrors.length) {
            throw new AggregateError([failure, ...restoreErrors],
                `Could not restore all build outputs; retained publication directories: ${staged.map(entry => entry.directory).join(', ')}; recovery targets: ${recoveryTargets.join(', ')}`);
        }
    }
    const cleanupErrors = [];
    for (const entry of staged) {
        try {
            fs.rmSync(entry.next, { force: true });
            fs.rmSync(entry.previous, { force: true });
            fs.rmdirSync(entry.directory);
        } catch (error) {
            cleanupErrors.push(error);
        }
    }
    if (cleanupErrors.length) {
        throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
            `${failed ? 'Original build outputs were preserved' : 'Build outputs were written'}, but cleanup failed; publication directories: ${staged.map(entry => entry.directory).join(', ')}`);
    }
    if (failed) throw failure;
}

module.exports = publish;
