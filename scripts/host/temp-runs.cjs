'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = path.join(os.tmpdir(), 'dynasense-host-runs');
const MARKER = '.lifecycle.json';
const LIMITS = { completed: 32, evidenceBytes: 512 * 1024 ** 2, unfinished: 8,
    admissionBytes: 4 * 1024 ** 3, freeBytes: 2 * 1024 ** 3, ageMs: 7 * 86400000 };
const pendingRuns = new Map();

function writeEvidence(...args) {
    try { fs.writeFileSync(...args); }
    catch (error) { error.evidenceSaveFailed = true; throw error; }
}

function bytes(root) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink()) return 0;
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(root).reduce((total, name) => total + bytes(path.join(root, name)), 0);
}

function manager(base = BASE, limits = LIMITS) {
    base = path.resolve(base);
    fs.mkdirSync(base, { recursive: true });
    if (fs.lstatSync(base).isSymbolicLink()) throw Error(`Refusing linked temporary storage: ${base}`);
    const realBase = fs.realpathSync(base);
    function check(root) {
        if (fs.realpathSync(base) !== realBase || path.dirname(path.resolve(root)) !== base
            || !/^dynasense-[a-z-]+-[a-zA-Z0-9]+$/.test(path.basename(root))
            || fs.lstatSync(root).isSymbolicLink()) throw Error(`Unsafe temporary run path: ${root}`);
    }
    function remove(root) {
        check(root);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 16, retryDelay: 125 });
    }
    function checkMarker(marker) {
        const stat = fs.lstatSync(marker);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw Error(`Invalid temporary ownership marker: ${marker}`);
    }
    function locked(action) {
        const lock = path.join(base, '.lock');
        // ponytail: fail closed on contention or an abandoned lock; no unsafe stale-lock recovery.
        try { fs.mkdirSync(lock); } catch (error) {
            throw Error(`Temporary storage is locked: ${lock}; wait for other runners or inspect an interrupted run.`, { cause: error });
        }
        try { return action(); } finally { fs.rmdirSync(lock); }
    }
    function entries() {
        return fs.readdirSync(base).filter(name => name !== '.lock').map(name => {
            const root = path.join(base, name);
            check(root);
            const markerPath = path.join(root, MARKER);
            checkMarker(markerPath);
            const state = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
            if (state.version !== 1) throw Error(`Unknown temporary run: ${root}`);
            return { ...state, root, size: bytes(root) };
        });
    }
    function prune() {
        const all = entries();
        const completed = all.filter(entry => entry.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
        let size = completed.reduce((sum, entry) => sum + entry.size, 0);
        let count = completed.length;
        for (const entry of completed) {
            if (count <= limits.completed && size <= limits.evidenceBytes
                && Date.now() - entry.finishedAt < limits.ageMs) break;
            remove(entry.root);
            size -= entry.size; count--;
        }
        return entries();
    }
    function create(prefix) {
        if (!/^dynasense-[a-z-]+-$/.test(prefix)) throw Error('Invalid temporary run prefix');
        return locked(() => {
            const all = prune();
            const disk = fs.statfsSync(base);
            if (all.filter(entry => !entry.finishedAt).length >= limits.unfinished
                || all.reduce((sum, entry) => sum + entry.size, 0) >= limits.admissionBytes
                || disk.bavail * disk.bsize < limits.freeBytes)
                throw Error(`Temporary storage budget exhausted: ${base}; inspect unfinished runs before retrying.`);
            const root = fs.mkdtempSync(path.join(base, prefix));
            fs.writeFileSync(path.join(root, MARKER), JSON.stringify({ version: 1, pid: process.pid, startedAt: Date.now() }));
            return root;
        });
    }
    function finish(root) {
        return locked(() => {
            check(root);
            const marker = path.join(root, MARKER);
            checkMarker(marker);
            const state = JSON.parse(fs.readFileSync(marker, 'utf8'));
            if (state.version !== 1 || state.pid !== process.pid) throw Error(`Run is not owned by this process: ${root}`);
            // Keep root-level reports/screenshots readable by parent benchmark drivers.
            // Windows debug-adapter log handles can outlive the closed host briefly;
            // bounded filesystem retries preserve ownership checks and still fail if locked.
            for (const name of fs.readdirSync(root)) {
                if (name === MARKER) continue;
                const target = path.join(root, name), stat = fs.lstatSync(target);
                if (stat.isFile() && (/\.(json|jsonl|png|log|txt|cpuprofile)$/i.test(name)
                    || /^history-(expected|actual)\.k$/.test(name))) continue;
                fs.rmSync(target, { recursive: true, force: true, maxRetries: 16, retryDelay: 125 });
            }
            checkMarker(marker);
            fs.writeFileSync(marker, JSON.stringify({ ...state, finishedAt: Date.now(), exitCode: process.exitCode || 0 }));
            prune();
        });
    }
    return { create, finish };
}

function createTempRun(prefix) {
    const runs = manager(), root = runs.create(prefix);
    // beforeExit waits for referenced child processes and sockets, including failed runs.
    // Forced termination leaves an unfinished slot; never guess that orphan hosts have stopped.
    const onExit = () => {
        try { finishTempRun(root); } catch (error) {
            console.error(`Temporary run cleanup failed: ${root}`, error);
            process.exitCode = 1;
        }
    };
    pendingRuns.set(root, { runs, onExit });
    process.once('beforeExit', onExit);
    return root;
}

// Call only after the host has closed. Retain an unfinished slot if closure is uncertain.
function finishTempRun(root, { retain = false } = {}) {
    const pending = pendingRuns.get(root);
    if (!pending) throw Error(`Temporary run is not owned by this process: ${root}`);
    process.removeListener('beforeExit', pending.onExit);
    pendingRuns.delete(root);
    if (!retain) pending.runs.finish(root);
}

function createEvidenceDirectory(purpose, base = path.resolve(__dirname, '../../.artifacts/reports')) {
    if (!/^[a-z][a-z0-9-]*$/.test(purpose)) throw Error('Invalid evidence purpose');
    base = path.resolve(base);
    for (const directory of [path.dirname(base), base, path.join(base, purpose)]) {
        fs.mkdirSync(directory, { recursive: true });
        if (fs.lstatSync(directory).isSymbolicLink()) throw Error(`Linked evidence storage: ${directory}`);
    }
    const root = fs.mkdtempSync(path.join(base, purpose, 'run-'));
    const realRoot = fs.realpathSync(root);
    const marker = path.join(root, 'evidence.json');
    const state = { version: 1, purpose, pid: process.pid, startedAt: Date.now(),
        command: [process.execPath, ...process.argv.slice(1)], retention: 'review-before-delete', status: 'running' };
    fs.writeFileSync(marker, JSON.stringify(state, null, 2), { flag: 'wx' });
    // Driver exit is not product approval; the caller's result/identity reports own acceptance.
    process.once('exit', exitCode => {
        try {
            if (!fs.existsSync(root)) return; // A test may explicitly dispose its own synthetic evidence.
            if (fs.realpathSync(root) !== realRoot || fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(marker).isSymbolicLink())
                throw Error(`Linked evidence path: ${root}`);
            fs.writeFileSync(marker, JSON.stringify({ ...state, status: 'driver-exited', finishedAt: Date.now(), exitCode }, null, 2));
        } catch (error) { console.error(`Evidence status write failed: ${root}`, error); process.exitCode = 1; }
    });
    return root;
}
module.exports = { createTempRun, finishTempRun, createEvidenceDirectory, writeEvidence, manager, LIMITS };
