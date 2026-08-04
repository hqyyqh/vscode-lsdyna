'use strict';

const assert = require('assert');
const path = require('path');

const {
    looksLikeManualPack,
    resolveManualDirectoryCandidates,
    resolveManualsRoot,
} = require('../../src/manual/manualsDirResolve');

function createFs({ dirs = [], files = [] } = {}) {
    const dirSet = new Set(dirs);
    const fileSet = new Set(files);
    return {
        existsSync(target) {
            return dirSet.has(target) || fileSet.has(target);
        },
    };
}

describe('manualsDirResolve (portable Code.exe-first)', () => {
    const pathModule = path.posix;

    it('returns absolute manualsDir as the only candidate', () => {
        const candidates = resolveManualDirectoryCandidates({
            manualsDir: '/abs/lsdyna_manual_pack',
            execPath: '/vscode/Code',
            workspaceFolders: [{ uri: { fsPath: '/ws' } }],
            pathModule,
        });
        assert.deepStrictEqual(candidates, ['/abs/lsdyna_manual_pack']);
    });

    it('orders relative candidates with Code.exe directory first', () => {
        const candidates = resolveManualDirectoryCandidates({
            manualsDir: 'lsdyna_manual_pack',
            execPath: '/portable/Code.exe',
            appRoot: '/portable/resources/app',
            workspaceFolders: [{ uri: { fsPath: '/ws' } }],
            cwd: '/cwd',
            extensionPath: '/ext',
            pathModule,
        });
        assert.strictEqual(candidates[0], '/portable/lsdyna_manual_pack');
        assert.ok(candidates.includes('/portable/resources/app/../../lsdyna_manual_pack')
            || candidates.includes(pathModule.resolve('/portable/resources/app', '../../', 'lsdyna_manual_pack')));
        assert.ok(candidates.includes('/ws/lsdyna_manual_pack'));
        assert.ok(candidates.indexOf('/portable/lsdyna_manual_pack')
            < candidates.indexOf('/ws/lsdyna_manual_pack'));
    });

    it('picks Code.exe pack over workspace when both exist', () => {
        const exePack = '/portable/lsdyna_manual_pack';
        const wsPack = '/ws/lsdyna_manual_pack';
        const fs = createFs({
            dirs: [exePack, pathModule.join(exePack, 'indexes'), wsPack, pathModule.join(wsPack, 'indexes')],
            files: [
                pathModule.join(exePack, 'manifest.json'),
                pathModule.join(wsPack, 'manifest.json'),
            ],
        });
        const root = resolveManualsRoot({
            manualsDir: 'lsdyna_manual_pack',
            execPath: '/portable/Code.exe',
            workspaceFolders: [{ uri: { fsPath: '/ws' } }],
            pathModule,
            fs,
        });
        assert.strictEqual(root, exePack);
    });

    it('falls back to workspace pack when install root has no pack', () => {
        const wsPack = '/ws/lsdyna_manual_pack';
        const fs = createFs({
            dirs: [wsPack, pathModule.join(wsPack, 'indexes')],
            files: [pathModule.join(wsPack, 'manifest.json')],
        });
        const root = resolveManualsRoot({
            manualsDir: 'lsdyna_manual_pack',
            execPath: '/portable/Code.exe',
            workspaceFolders: [{ uri: { fsPath: '/ws' } }],
            pathModule,
            fs,
        });
        assert.strictEqual(root, wsPack);
    });

    it('prefers pack-shaped directory over empty same-name folder earlier in list', () => {
        // Empty dir at exe; real pack only in workspace.
        const emptyExe = '/portable/lsdyna_manual_pack';
        const wsPack = '/ws/lsdyna_manual_pack';
        const fs = createFs({
            dirs: [emptyExe, wsPack, pathModule.join(wsPack, 'indexes')],
            files: [pathModule.join(wsPack, 'manifest.json')],
        });
        const root = resolveManualsRoot({
            manualsDir: 'lsdyna_manual_pack',
            execPath: '/portable/Code.exe',
            workspaceFolders: [{ uri: { fsPath: '/ws' } }],
            pathModule,
            fs,
        });
        assert.strictEqual(root, wsPack);
        assert.strictEqual(looksLikeManualPack(emptyExe, fs, pathModule), false);
        assert.strictEqual(looksLikeManualPack(wsPack, fs, pathModule), true);
    });

    it('returns first candidate when nothing exists (best-effort absolute path)', () => {
        const fs = createFs();
        const root = resolveManualsRoot({
            manualsDir: 'lsdyna_manual_pack',
            execPath: '/portable/Code.exe',
            workspaceFolders: [{ uri: { fsPath: '/ws' } }],
            pathModule,
            fs,
        });
        assert.strictEqual(root, '/portable/lsdyna_manual_pack');
    });
});
