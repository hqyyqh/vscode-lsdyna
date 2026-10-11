'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
    resolveIncludeWithCaseCheck,
    isIncludeResolveAccepted,
    normalizePathCaseCheckMode,
} = require('../../../src/core/fs/pathCaseFidelity');

function createMockFs({ files = {}, dirs = {} } = {}) {
    const normalizedFiles = new Map();
    for (const [key, value] of Object.entries(files)) {
        normalizedFiles.set(path.normalize(key), value);
    }
    const normalizedDirs = new Map();
    for (const [key, names] of Object.entries(dirs)) {
        normalizedDirs.set(path.normalize(key), names);
    }

    return {
        async access(target) {
            const n = path.normalize(target);
            if (normalizedFiles.has(n)) return;
            // case-insensitive existence for Windows-like OS resolve
            for (const key of normalizedFiles.keys()) {
                if (key.toLowerCase() === n.toLowerCase()) return;
            }
            const err = new Error(`ENOENT: ${target}`);
            err.code = 'ENOENT';
            throw err;
        },
        async readdir(dir) {
            const n = path.normalize(dir);
            if (normalizedDirs.has(n)) {
                return normalizedDirs.get(n).map(name => ({
                    name,
                    isDirectory: () => true,
                    isFile: () => true,
                }));
            }
            for (const [key, names] of normalizedDirs.entries()) {
                if (key.toLowerCase() === n.toLowerCase()) {
                    return names.map(name => ({
                        name,
                        isDirectory: () => true,
                        isFile: () => true,
                    }));
                }
            }
            const err = new Error(`ENOENT readdir: ${dir}`);
            err.code = 'ENOENT';
            throw err;
        },
    };
}

describe('pathCaseFidelity', () => {
    const root = path.resolve('/project');

    it('normalizes pathCaseCheck modes', () => {
        assert.equal(normalizePathCaseCheckMode('off'), 'off');
        assert.equal(normalizePathCaseCheckMode('strict'), 'strict');
        assert.equal(normalizePathCaseCheckMode('crossPlatform'), 'crossPlatform');
        assert.equal(normalizePathCaseCheckMode('nope'), 'crossPlatform');
    });

    it('returns exact when every segment matches disk casing', async () => {
        const child = path.join(root, 'Sub', 'Part.k');
        const io = createMockFs({
            files: { [child]: true },
            dirs: {
                [root]: ['Sub'],
                [path.join(root, 'Sub')]: ['Part.k'],
            },
        });

        const result = await resolveIncludeWithCaseCheck('Sub/Part.k', [root], { fs: io });
        assert.equal(result.status, 'exact');
        assert.equal(path.normalize(result.resolvedPath), path.normalize(child));
    });

    it('returns case-mismatch when OS can open but casing differs', async () => {
        const child = path.join(root, 'Sub', 'Part.k');
        const io = createMockFs({
            files: { [child]: true },
            dirs: {
                [root]: ['Sub'],
                [path.join(root, 'Sub')]: ['Part.k'],
            },
        });

        const result = await resolveIncludeWithCaseCheck('sub/part.k', [root], { fs: io });
        assert.equal(result.status, 'case-mismatch');
        assert.ok(result.diffs.some(d => d.deck === 'sub' && d.disk === 'Sub'));
        assert.ok(result.diffs.some(d => d.deck === 'part.k' && d.disk === 'Part.k'));
        assert.equal(result.diskRelative.replace(/\\/g, '/'), 'Sub/Part.k');
        assert.equal(result.deckRelative.replace(/\\/g, '/'), 'sub/part.k');
    });

    it('returns missing when no search path can open the file', async () => {
        const io = createMockFs({ files: {}, dirs: { [root]: [] } });
        const result = await resolveIncludeWithCaseCheck('gone.k', [root], { fs: io });
        assert.equal(result.status, 'missing');
    });

    it('preserves include access faults rather than reporting a missing file', async () => {
        for (const code of ['EACCES', 'EPERM', 'EIO', undefined]) {
            const fault = Object.assign(new Error('controlled include access failure'), { code });
            const io = { access: async () => { throw fault; }, readdir: async () => [] };
            await assert.rejects(resolveIncludeWithCaseCheck('child.k', [root], { fs: io }), error => error === fault);
        }
        const io = { access: async () => { throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }); }, readdir: async () => [] };
        assert.equal((await resolveIncludeWithCaseCheck('child.k', [root], { fs: io })).status, 'missing');
    });

    it('resolves against a later search path', async () => {
        const other = path.resolve('/other');
        const child = path.join(other, 'mesh.k');
        const io = createMockFs({
            files: { [child]: true },
            dirs: {
                [root]: [],
                [other]: ['mesh.k'],
            },
        });

        const result = await resolveIncludeWithCaseCheck('mesh.k', [root, other], { fs: io });
        assert.equal(result.status, 'exact');
        assert.equal(path.normalize(result.resolvedPath), path.normalize(child));
    });

    it('skips when readdir fails after OS resolve', async () => {
        const child = path.join(root, 'only.k');
        const io = {
            async access(target) {
                if (path.normalize(target).toLowerCase() === path.normalize(child).toLowerCase()) return;
                throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            },
            async readdir() {
                throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            },
        };

        const result = await resolveIncludeWithCaseCheck('only.k', [root], { fs: io });
        assert.equal(result.status, 'skipped');
        assert.equal(result.reason, 'io-error');
    });

    it('preserves backslash style in diskRelative when deck used backslashes', async () => {
        const child = path.join(root, 'Sub', 'Part.k');
        const io = createMockFs({
            files: { [child]: true },
            dirs: {
                [root]: ['Sub'],
                [path.join(root, 'Sub')]: ['Part.k'],
            },
        });

        const result = await resolveIncludeWithCaseCheck('sub\\part.k', [root], { fs: io });
        assert.equal(result.status, 'case-mismatch');
        assert.equal(result.diskRelative, 'Sub\\Part.k');
    });

    it('isIncludeResolveAccepted honors strict mode', () => {
        const mismatch = {
            status: 'case-mismatch',
            resolvedPath: '/a',
            realPath: '/A',
            diffs: [],
            deckRelative: 'a',
            diskRelative: 'A',
        };
        assert.equal(isIncludeResolveAccepted(mismatch, 'crossPlatform'), true);
        assert.equal(isIncludeResolveAccepted(mismatch, 'strict'), false);
        assert.equal(isIncludeResolveAccepted({ status: 'missing' }, 'crossPlatform'), false);
        assert.equal(isIncludeResolveAccepted({ status: 'exact', resolvedPath: '/a', realPath: '/a' }, 'strict'), true);
    });

    it('walks parent segments before checking literal names and preserves strict rejection', async () => {
        const parent = path.dirname(root);
        const child = path.join(parent, 'Shared', 'Part.k');
        for (const raw of ['../shared/part.k', '..\\shared\\part.k']) {
            const io = createMockFs({ files: { [child]: true }, dirs: {
                [parent]: ['Shared'], [path.join(parent, 'Shared')]: ['Part.k'],
            } });
            const result = await resolveIncludeWithCaseCheck(raw, [root], { fs: io });
            assert.equal(result.status, 'case-mismatch');
            assert.deepEqual(result.diffs, [{ index: 1, deck: 'shared', disk: 'Shared' },
                { index: 2, deck: 'part.k', disk: 'Part.k' }]);
            assert.equal(result.diskRelative, raw.includes('\\') ? '..\\Shared\\Part.k' : '../Shared/Part.k');
            assert.equal(path.normalize(result.realPath), path.normalize(child));
            assert.equal(isIncludeResolveAccepted(result, 'strict'), false);
            assert.equal(isIncludeResolveAccepted(result, 'crossPlatform'), true);
        }
    });

    it('owns the search roots across the asynchronous existence check', async () => {
        const roots = [root];
        const child = path.join(root, 'Sub', 'Part.k');
        const io = createMockFs({ files: { [child]: true }, dirs: {
            [root]: ['Sub'], [path.join(root, 'Sub')]: ['Part.k'],
        } });
        const access = io.access;
        io.access = async target => { await access(target); roots.length = 0; };
        const result = await resolveIncludeWithCaseCheck('sub/Part.k', roots, { fs: io });
        assert.equal(roots.length, 0);
        assert.equal(result.status, 'case-mismatch');
        assert.deepEqual(result.diffs, [{ index: 0, deck: 'sub', disk: 'Sub' }]);
        assert.equal(isIncludeResolveAccepted(result, 'strict'), false);
    });

    it('preserves directory ambiguity and prefers an exact spelling among case variants', async () => {
        const child = path.join(root, 'part.k');
        const ambiguous = await resolveIncludeWithCaseCheck('part.k', [root], { fs: createMockFs({
            files: { [child]: true }, dirs: { [root]: ['Part.k', 'PART.K'] },
        }) });
        assert.equal(ambiguous.status, 'skipped');
        assert.equal(ambiguous.reason, 'ambiguous-segment');
        const exact = await resolveIncludeWithCaseCheck('Part.k', [root], { fs: createMockFs({
            files: { [child]: true }, dirs: { [root]: ['Part.k', 'PART.K'] },
        }) });
        assert.equal(exact.status, 'exact');
    });

    it('checks repeated parent segments against the actual filesystem', async () => {
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-path-case-'));
        try {
            const base = path.join(temporary, 'deck', 'nested');
            fs.mkdirSync(base, { recursive: true });
            fs.mkdirSync(path.join(temporary, 'Shared'));
            const target = path.join(temporary, 'Shared', 'Part.k');
            fs.writeFileSync(target, '*END\n');
            const result = await resolveIncludeWithCaseCheck('../../Shared/Part.k', [base]);
            assert.equal(result.status, 'exact');
            assert.equal(result.realPath, target);
            assert.equal(isIncludeResolveAccepted(result, 'strict'), true);
            const absolute = await resolveIncludeWithCaseCheck(base + `${path.sep}..${path.sep}..${path.sep}Shared${path.sep}Part.k`, [base]);
            assert.equal(absolute.status, 'exact');
            if (process.platform === 'win32') {
                const mismatched = await resolveIncludeWithCaseCheck('../../shared/part.k', [base]);
                assert.equal(mismatched.status, 'case-mismatch');
                assert.equal(isIncludeResolveAccepted(mismatched, 'strict'), false);
            }
        } finally {
            fs.rmSync(temporary, { recursive: true, force: true });
        }
    });
});
