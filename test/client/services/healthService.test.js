'use strict';

const assert = require('assert');
const path = require('path');

function createFakeFileSystem({ directories = [], files = {} } = {}) {
    const dirs = new Set(directories);
    let readdirCount = 0;
    return {
        get readdirCount() { return readdirCount; },
        existsSync(target) {
            return dirs.has(target) || Object.prototype.hasOwnProperty.call(files, target);
        },
        readdirSync(target) {
            readdirCount += 1;
            if (!dirs.has(target)) {
                throw new Error(`ENOENT: ${target}`);
            }
            return files[target] || [];
        },
    };
}

describe('createHealthService', () => {
    const {
        createHealthService,
        shouldShowHealthNotice,
    } = require('../../../src/client/services/healthService');

    it('reports a ready first-run environment from lightweight checks', () => {
        const fsMock = createFakeFileSystem({
            directories: ['/ws/manuals'],
            files: {
                '/ws/manuals': ['keyword.pdf', 'vol2.PDF', 'SumatraPDF.exe'],
            },
        });
        const service = createHealthService({
            fs: fsMock,
            pathModule: path.posix,
            platform: 'win32',
            cwd: '/ws',
            extensionPath: '/ext',
            getManualsDir: () => 'manuals',
            getManualFilesCount: () => 2,
            getKeywordDatabaseReady: () => true,
            getProjectToolsReady: () => true,
        });

        const report = service.getReport({
            isLsdyna: true,
            document: { languageId: 'lsdyna', uri: { fsPath: '/ws/main.k' } },
            workspaceFolders: [{ uri: { fsPath: '/ws' } }],
        });

        assert.strictEqual(report.ready, true);
        assert.strictEqual(report.issueCount, 0);
        assert.strictEqual(report.items.length, 8);
        assert.deepStrictEqual(report.items.map(item => item.id), [
            'language',
            'workspace',
            'manualsDir',
            'pdfFiles',
            'manualIndex',
            'sumatra',
            'keywordDatabase',
            'projectTools',
        ]);
        assert.ok(report.items.every(item => item.state === 'ready'));
    });

    it('reports setup warnings without running project scans or parsing PDFs', () => {
        const fsMock = createFakeFileSystem();
        const service = createHealthService({
            fs: fsMock,
            pathModule: path.posix,
            platform: 'win32',
            cwd: '/ws',
            extensionPath: '/ext',
            getManualsDir: () => 'missing-manuals',
            getManualFilesCount: () => 0,
            getKeywordDatabaseReady: () => true,
            getProjectToolsReady: () => true,
        });

        const report = service.getReport({
            isLsdyna: true,
            document: { languageId: 'lsdyna', uri: { fsPath: '/ws/main.k' } },
            workspaceFolders: [{ uri: { fsPath: '/ws' } }],
        });

        const statesById = Object.fromEntries(report.items.map(item => [item.id, item.state]));
        assert.strictEqual(report.ready, false);
        assert.ok(report.issueCount >= 3);
        assert.strictEqual(statesById.manualsDir, 'warning');
        assert.strictEqual(statesById.pdfFiles, 'warning');
        assert.strictEqual(statesById.manualIndex, 'warning');
        assert.strictEqual(statesById.sumatra, 'warning');
    });

    it('caches directory checks until invalidated', () => {
        const fsMock = createFakeFileSystem({
            directories: ['/ws/manuals'],
            files: {
                '/ws/manuals': ['keyword.pdf'],
            },
        });
        const service = createHealthService({
            fs: fsMock,
            pathModule: path.posix,
            platform: 'linux',
            cwd: '/ws',
            extensionPath: '/ext',
            getManualsDir: () => 'manuals',
            getManualFilesCount: () => 1,
            getKeywordDatabaseReady: () => true,
            getProjectToolsReady: () => true,
        });
        const input = {
            isLsdyna: true,
            document: { languageId: 'lsdyna', uri: { fsPath: '/ws/main.k' } },
            workspaceFolders: [{ uri: { fsPath: '/ws' } }],
        };

        service.getReport(input);
        service.getReport(input);
        assert.strictEqual(fsMock.readdirCount, 1);

        service.invalidate();
        service.getReport(input);
        assert.strictEqual(fsMock.readdirCount, 2);
    });

    it('shows the first-run notice once per warning signature', () => {
        const report = {
            issueCount: 2,
            issueSignature: 'manualsDir|pdfFiles',
        };

        assert.strictEqual(shouldShowHealthNotice({
            showFirstRunNotice: true,
            isLsdyna: true,
            report,
            lastPromptedIssueSignature: '',
        }), true);

        assert.strictEqual(shouldShowHealthNotice({
            showFirstRunNotice: true,
            isLsdyna: true,
            report,
            lastPromptedIssueSignature: 'manualsDir|pdfFiles',
        }), false);

        assert.strictEqual(shouldShowHealthNotice({
            showFirstRunNotice: false,
            isLsdyna: true,
            report,
            lastPromptedIssueSignature: '',
        }), false);

        assert.strictEqual(shouldShowHealthNotice({
            showFirstRunNotice: true,
            isLsdyna: true,
            report: { issueCount: 0, issueSignature: '' },
            lastPromptedIssueSignature: '',
        }), false);
    });
});
