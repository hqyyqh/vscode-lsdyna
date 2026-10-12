'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), vscode = require('vscode');
const { withCpuProfile } = require('../../support/cpu-profile.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const viewType = tab => String(tab.input?.viewType || '').replace(/^mainThreadWebview-/, '');
exports.run = async () => {
    const root = process.env.LSDYNA_RELEASE_HOST_ROOT, phase = process.env.LSDYNA_RELEASE_HOST_PHASE;
    const metrics = [], checks = [], output = path.join(root, 'result.json');
    const measure = async (name, operation) => withCpuProfile(process.env.LSDYNA_PROFILE_CPU === name ||
        (process.env.LSDYNA_PROFILE_CPU === '1' && name === 'first-hover'),
        path.join(root, name + '.cpuprofile'), async () => {
        await delay(10);
        let previous = performance.now(), maxEventLoopGapMs = 0;
        let previousUtilization = performance.eventLoopUtilization();
        const gaps = [];
        const timer = setInterval(() => { const now = performance.now(); maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - previous);
            const utilization = performance.eventLoopUtilization();
            // Diagnostic only: active time includes synchronous waits, not just product CPU work.
            if (now - previous > 40) gaps.push({ endUs: Number(process.hrtime.bigint() / 1000n), ms: now - previous,
                activeMs: utilization.active - previousUtilization.active, idleMs: utilization.idle - previousUtilization.idle });
            previousUtilization = utilization;
            previous = now; }, 2);
        const memoryBefore = process.memoryUsage(), start = performance.now();
        let peakRss = memoryBefore.rss;
        const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 2);
        try {
            return await operation();
        }
        finally {
            const durationMs = performance.now() - start;
            try { await delay(10); } finally { clearInterval(timer); }
            clearInterval(memoryTimer);
            const memoryAfter = process.memoryUsage();
            peakRss = Math.max(peakRss, memoryAfter.rss, process.resourceUsage().maxRSS * 1024);
            metrics.push({ name, durationMs, maxEventLoopGapMs, peakRss, peakRssScope: 'extension-host process high-water mark', memoryBefore, memoryAfter, ...(gaps.length ? { gaps } : {}) });
        }
    });
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    assert.ok(extension);
    const result = { phase, vscodeVersion: vscode.version, platform: process.platform, arch: process.arch,
        node: process.version, electron: process.versions.electron, cpu: require('node:os').cpus()[0].model,
        totalMemoryBytes: require('node:os').totalmem(),
        configuration: Object.fromEntries(['changeMarks.enabled', 'changeMarks.debounceMs', 'changeMarks.maxLineCount',
            'largeFile.enableRendering', 'include.pathCaseCheck', 'language'].map(key => [key, vscode.workspace.getConfiguration('lsdyna').get(key)])),
        packageVersion: extension.packageJSON.version, installedPath: extension.extensionPath,
        initiallyActive: extension.isActive, metrics, checks, status: 'running' };
    let failure;
    try {
        assert.equal(extension.isActive, false, 'Cold host must begin before DynaSense activation');
        const Module = require('node:module'), originalLoad = Module._load;
        if (process.env.LSDYNA_PROFILE_LOAD) {
            result.moduleLoads = [];
            Module._load = function(request) {
                const start = performance.now();
                try { return originalLoad.apply(this, arguments); }
                finally { const ms = performance.now() - start; if (ms >= 10) result.moduleLoads.push({ request, ms }); }
            };
        }
        try { await measure('activation', () => extension.activate()); }
        finally { Module._load = originalLoad; }
        assert.ok(extension.isActive);
        if (phase === 'sqlite') {
            await require('./sqlite.cjs').check(extension, root, checks);
            result.status = 'passed'; return;
        }
        if (phase === 'entity-pages') {
            await require('./entity-pages.cjs').check(root, checks);
            result.status = 'passed'; return;
        }
        if (phase === 'cache-settings') {
            await require('./cache-settings.cjs').check(extension, root, checks);
            result.status = 'passed'; return;
        }
        if (phase === 'reference-hover') {
            await require('./reference-hover.cjs').check(extension, root, checks);
            result.status = 'passed'; return;
        }
        if (phase === 'completion') {
            await require('./completion.cjs').check(checks);
            result.status = 'passed'; return;
        }
        if (phase === 'catalog') {
            const { digest } = require("../../../scripts/release/compare-release-data.cjs");
            const catalog = require(path.join(extension.extensionPath, 'out/extension'))._internals.getCatalogInputFormCatalogV4();
            const manifest = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'out/runtime',
                fs.existsSync(path.join(extension.extensionPath, 'out/runtime/catalog-input-form/manifest.json')) ? 'catalog-input-form' : 'lspp-input-form', 'manifest.json')));
            const forms = {};
            for (const keyword of Object.keys(manifest.keywords).sort()) {
                const form = catalog.formForKeyword(keyword);
                assert.ok(form, keyword); forms[keyword] = digest(form);
            }
            result.catalog = { keywords: Object.keys(forms).length, fingerprint: digest(forms) };
            if (process.env.LSDYNA_EXPECTED_CATALOG) assert.deepEqual(result.catalog,
                JSON.parse(fs.readFileSync(process.env.LSDYNA_EXPECTED_CATALOG)));
            if (process.env.LSDYNA_CATALOG_OUTPUT) fs.writeFileSync(process.env.LSDYNA_CATALOG_OUTPUT, JSON.stringify(result.catalog));
            checks.push('installed-catalog-complete'); result.status = 'passed'; return;
        }
        if (phase === 'activation') { result.functionalChecksPassed = true; result.status = 'passed'; return; }
        const file = path.join(root, 'workspace', phase === 'manager' && fs.existsSync(path.join(root, 'workspace', 'interaction.k')) ? 'interaction.k' : 'core.k');
        const original = fs.readFileSync(file), document = await vscode.workspace.openTextDocument(file);
        let editor = await vscode.window.showTextDocument(document);
        result.fixtureSha256 = sha(original);
        if (phase === 'experience') {
            const renderer = await require('../../support/release/rendered.cjs').connect(process.env.LSDYNA_RELEASE_CDP_PORT);
            try {
                let manager;
                await measure('first-manager-rendered', async () => {
                    await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions', 1);
                    manager = await renderer.wait(`typeof document !== 'undefined' && document.querySelector('main')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.fieldEditor input, .fieldEditor select').length >= 5`);
                });
                for (let i = 0; i < 2; i++) await measure('manager-refresh', () => renderer.evaluate(manager, `(async () => {
                    const button = [...document.querySelectorAll('.headerActions button')].find(b => /^(Reload this instance|重新读取当前实例)$/.test(b.title));
                    if (!button || button.disabled) throw Error('Refresh unavailable');
                    await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => { cleanup(); reject(Error('Refresh response timeout')); }, 10000);
                        const cleanup = () => { clearTimeout(timeout); window.removeEventListener('message', receive); };
                        const receive = event => {
                            const result = event.data?.result;
                            if (!result?.state || typeof result.accepted !== 'boolean') return;
                            cleanup(); result.accepted ? resolve() : reject(Error('Refresh rejected'));
                        };
                        window.addEventListener('message', receive); button.click();
                    });
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    if (document.querySelector('main')?.getAttribute('aria-busy') !== 'false') throw Error('Refresh still busy');
                })()`));
                await measure('manual-open', async () => {
                    await vscode.commands.executeCommand('extension.manual.openReader');
                    await renderer.wait(`typeof document !== 'undefined' && !!document.querySelector('.katex') && document.body.textContent.includes('release-formula') && !document.querySelector('.katex-error')`);
                });
                const main = await vscode.workspace.openTextDocument(path.join(root, 'workspace', 'main.k'));
                await vscode.window.showTextDocument(main);
                const scanned = await measure('scan', () => vscode.commands.executeCommand('extension.scanIncludeTree'));
                assert.equal(path.basename(scanned?.rootFile || ''), 'main.k');
                assert.equal(scanned?.snapshot?.files?.length, 2, 'The scan must complete both fixture files');
                assert.ok(metrics.find(item => item.name === 'scan').maxEventLoopGapMs <= 250,
                    'First project scan must yield while preparing shared reference rules');
                checks.push('rendered-manager-refresh-manual-scan');
                assert.equal(document.getText(), original.toString());
                result.warmSampleCount = metrics.filter(item => item.name === 'manager-refresh').length;
                result.status = 'passed'; return;
            } finally { renderer.close(); }
        }
        if (phase === 'choices') {
            const api = require(path.join(extension.extensionPath, 'out/extension'))._internals;
            const plan = api.planPreparedOfficialFieldChoices || api.planOfficialFieldChoicesForDocument;
            const query = async () => {
                const result = await plan(document, new vscode.Position(3, 75), { keywordLine: 1 });
                assert.equal(result?.status, 'ready');
                assert.deepEqual(result.choices.map(choice => choice.valueText), ['-1', '0', '1']);
            };
            await measure('first-choices', query);
            for (let i = 0; i < 2; i++) await measure('warm-choices', query);
            checks.push('installed-official-field-choices');
        }
        if (phase === 'hover' || phase === 'smoke') {
            const hover = await measure('first-hover', () => vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(2, 1)));
            assert.ok(hover?.length, 'First field Hover must provide content');
            if (phase === 'hover') for (let i = 0; i < 2; i++) await measure('warm-hover', async () => {
                const value = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(2, 1));
                assert.ok(value?.length, 'Warm Hover must provide content');
            });
            checks.push('field-hover');
            if (phase === 'smoke') {
                const position = new vscode.Position(1, 2);
                assert.equal(document.lineAt(position.line).text, '*NODE');
                const headers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, position);
                const keywordHover = headers?.find(item => item.contents.some(content => {
                    const text = typeof content === 'string' ? content : content.value;
                    return /symbol-keyword/.test(text) && /\*NODE\b/.test(text);
                }));
                assert.ok(keywordHover, 'Registered keyword-name Hover must describe *NODE, not a data field');
                if (keywordHover.range) {
                    assert.equal(keywordHover.range.start.line, position.line);
                    assert.equal(keywordHover.range.end.line, position.line);
                    assert.ok(keywordHover.range.contains(position), 'Keyword Hover range must contain the requested token');
                }
                result.keywordHover = { keyword: '*NODE', line: position.line, character: position.character,
                    range: keywordHover.range, contentLength: keywordHover.contents.map(content => typeof content === 'string' ? content : content.value).join('\n').length };
                checks.push('keyword-name-hover');
            }
        }
        if (phase === 'manager' || phase === 'smoke') {
            const lines = document.getText().split(/\r?\n/);
            const line = Math.max(0, lines.findIndex(text => /^\*(CONTROL_TIMESTEP|NODE)\s*$/i.test(text)));
            editor.selection = new vscode.Selection(line, 0, line, 0);
            await measure('first-manager', async () => {
                await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions', line);
                const deadline = performance.now() + 10000;
                while (!vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => viewType(tab) === 'lsdynaKeywordManager')) {
                    assert.ok(performance.now() < deadline, 'First manager tab did not become available');
                    await delay(10);
                }
            });
            result.tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => ({ title: tab.label, viewType: tab.input?.viewType }));
            assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => viewType(tab) === 'lsdynaKeywordManager'));
            if (phase === 'manager') for (let i = 0; i < 2; i++) {
                await vscode.window.showTextDocument(document);
                await delay(30);
                await measure('warm-manager-command', async () => {
                const model = await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions', line);
                result.lastWarmModel = model ? { keywordLine: model.keywordLine, currentKeyword: model.currentKeyword,
                    documentVersion: model.documentVersion, uri: model.uri } : null;
                result.requestedLine = line;
                result.documentVersion = document.version;
                assert.ok(model && model.documentVersion === document.version && model.keywordLine === line,
                    'Warm manager samples must return the requested current model');
                });
            }
            checks.push('manager-open');
        }
        if (phase === 'smoke') {
            editor = await vscode.window.showTextDocument(document);
            await delay(100);
            editor.selection = new vscode.Selection(2, 0, 2, 0);
            await delay(30);
            await vscode.commands.executeCommand('extension.lsdynaTab');
            assert.equal(editor.selection.start.line, 2);
            assert.ok(editor.selection.end.character > editor.selection.start.character);
            await vscode.commands.executeCommand('type', { text: '2' });
            const changed = document.getText();
            assert.notEqual(changed, original.toString());
            await vscode.commands.executeCommand('undo');
            assert.equal(document.getText(), original.toString());
            await vscode.commands.executeCommand('redo');
            assert.equal(document.getText(), changed);
            assert.ok(await document.save());
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            const reopened = await vscode.workspace.openTextDocument(file);
            assert.equal(reopened.getText(), changed);
            checks.push('field-edit-undo-redo-save-reopen');
            const main = await vscode.workspace.openTextDocument(path.join(root, 'workspace', 'main.k'));
            await vscode.window.showTextDocument(main);
            await vscode.commands.executeCommand('extension.scanIncludeTree');
            await vscode.commands.executeCommand('extension.scanKeywordIndex');
            checks.push('project-and-keyword-index');
            const manualRoot = path.join(root, 'workspace', 'lsdyna_manual_pack');
            if (fs.existsSync(path.join(manualRoot, 'manifest.json'))) {
                await vscode.commands.executeCommand('extension.manual.openReader');
                const deadline = Date.now() + 10000;
                while (!vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => viewType(tab) === 'lsdynaManualReader')) {
                    if (Date.now() > deadline) throw Error('Manual reader did not open');
                    await delay(20);
                }
                result.manualManifestSha256 = sha(fs.readFileSync(path.join(manualRoot, 'manifest.json')));
                checks.push('manual-reader-open');
                if (process.env.LSDYNA_RELEASE_CDP_PORT) {
                    const rendered = path.join(root, 'manual-renderer.json'), deadline = Date.now() + 90000;
                    while (!fs.existsSync(rendered)) {
                        if (Date.now() > deadline) throw Error('Manual renderer verification timed out');
                        await delay(50);
                    }
                    result.manualRenderer = JSON.parse(fs.readFileSync(rendered));
                    assert.equal(result.manualRenderer.status, 'passed');
                    checks.push('manual-content-rendered');
                }
            } else result.manual = 'unverified: no external manual pack';
        } else {
            assert.equal(document.getText(), original.toString());
            assert.equal(sha(fs.readFileSync(file)), sha(original));
            result.functionalChecksPassed = true;
            const warm = metrics.filter(item => item.name.startsWith('warm-')).map(item => item.durationMs);
            result.warmSampleCount = warm.length;
            result.warmMaxMs = Math.max(...warm);
            for (const metric of metrics.filter(item => item.name !== 'activation')) assert.ok(metric.maxEventLoopGapMs <= 100,
                `${metric.name} blocked the event loop for ${metric.maxEventLoopGapMs.toFixed(1)}ms`);
            assert.ok(result.warmMaxMs <= 100);
        }
        result.status = 'passed';
    } catch (error) { failure = error; result.status = 'failed'; result.error = String(error); throw error; }
    finally {
        result.peakRssBytes = process.resourceUsage().maxRSS * 1024;
        try { fs.writeFileSync(output, JSON.stringify(result, null, 2)); console.log(`Release host result: ${output}`); }
        catch (error) {
            if (!failure) throw error;
            failure.evidenceSaveFailed = true;
            failure.evidenceError = error;
            console.error('Release host evidence save failed:', error);
        }
    }
};
