'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vscode = require('vscode');
exports.run = async () => {
    const root = process.env.KEYWORD_REFRESH_EVIDENCE;
    let activationProfiler;
    if (process.env.KEYWORD_STARTUP_PROFILE === 'activation') {
        activationProfiler = new (require('node:inspector').Session)();
        activationProfiler.connect();
        await new Promise((resolve, reject) => activationProfiler.post('Profiler.enable', error => error ? reject(error) : resolve()));
        await new Promise((resolve, reject) => activationProfiler.post('Profiler.start', error => error ? reject(error) : resolve()));
    }
    const activationStart = performance.now();
    await vscode.extensions.getExtension('hqyyqh.dynasense').activate();
    const activationMs = performance.now() - activationStart;
    if (activationProfiler) {
        const profile = await new Promise((resolve, reject) => activationProfiler.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(result.profile)));
        fs.writeFileSync(path.join(root, 'activation.cpuprofile'), JSON.stringify(profile));
        activationProfiler.disconnect();
    }
    const startup = process.env.KEYWORD_STARTUP_BENCHMARK === '1';
    const results = [];
    for (const blocks of startup ? [Number(process.env.KEYWORD_STARTUP_BLOCKS || 10000)] : [1000, 10000]) {
        const file = path.join(root, `refresh-${blocks}.k`);
        const before = Array.from({ length: blocks }, () => `*DATABASE_BINARY_BLSTFOR\n${blocks},1,1,1,1`).join('\n') + '\n*END\n';
        fs.writeFileSync(file, before);
        const document = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        if (startup) {
            const deadline = Date.now() + 120000;
            while (!fs.existsSync(path.join(root, 'renderer-attached'))) {
                if (Date.now() > deadline) throw Error('Renderer did not attach');
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        let profiler;
        if (process.env.KEYWORD_STARTUP_PROFILE === '1') {
            profiler = new (require('node:inspector').Session)();
            profiler.connect();
            await new Promise((resolve, reject) => profiler.post('Profiler.enable', error => error ? reject(error) : resolve()));
            await new Promise((resolve, reject) => profiler.post('Profiler.start', error => error ? reject(error) : resolve()));
        }
        const start = performance.now();
        const memoryBefore = process.memoryUsage().rss;
        let peakRss = memoryBefore, last = start, maxEventLoopGapMs = 0;
        const eventLoopGaps = [];
        const timer = startup ? setInterval(() => {
            const now = performance.now(), gapMs = now - last - 10;
            maxEventLoopGapMs = Math.max(maxEventLoopGapMs, gapMs);
            if (gapMs > 20) eventLoopGaps.push({ startMs: last - start, endMs: now - start, gapMs });
            last = now; peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }, 10) : null;
        let visibleMs, directoryMs;
        const observer = startup ? fs.watch(root, () => {
            if (visibleMs === undefined && fs.existsSync(path.join(root, 'startup-visible'))) visibleMs = performance.now() - start;
            if (directoryMs === undefined && fs.existsSync(path.join(root, 'startup-directory'))) directoryMs = performance.now() - start;
        }) : null;
        await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');
        const commandMs = performance.now() - start;
        fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ blocks }));
        const deadline = Date.now() + 120000;
        while (!fs.existsSync(path.join(root, `${blocks}.done`))) {
            if (Date.now() > deadline) throw new Error('Renderer measurement timed out');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(document.getText(), before, 'focus and refresh must not modify source');
        assert.equal(document.isDirty, false);
        if (startup) {
            clearInterval(timer); observer.close();
            if (profiler) {
                const profile = await new Promise((resolve, reject) => profiler.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(result.profile)));
                fs.writeFileSync(path.join(root, 'startup.cpuprofile'), JSON.stringify(profile));
                profiler.disconnect();
            }
            assert.ok(Number.isFinite(visibleMs) && Number.isFinite(directoryMs), 'Renderer must confirm both milestones');
            results.push({ blocks, vscodeVersion: vscode.version, activationMs, commandMs, visibleMs, directoryMs, memoryBefore,
                peakRss: Math.max(peakRss, process.memoryUsage().rss), maxEventLoopGapMs, eventLoopGaps });
            fs.writeFileSync(path.join(root, 'startup-results.json'), JSON.stringify(results));
        }
    }
};
