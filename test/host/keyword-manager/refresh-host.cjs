'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { withCpuProfile } = require('../../support/cpu-profile.cjs');
exports.run = async () => {
    const root = process.env.KEYWORD_REFRESH_EVIDENCE;
    const activationMs = await withCpuProfile(process.env.KEYWORD_STARTUP_PROFILE === 'activation',
        path.join(root, 'activation.cpuprofile'), async () => {
            const activationStart = performance.now();
            await vscode.extensions.getExtension('hqyyqh.dynasense').activate();
            return performance.now() - activationStart;
        });
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
        const measurement = await withCpuProfile(process.env.KEYWORD_STARTUP_PROFILE === '1',
            path.join(root, 'startup.cpuprofile'), async () => {
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
            let observer, commandMs;
            try {
                observer = startup ? fs.watch(root, () => {
                    if (visibleMs === undefined && fs.existsSync(path.join(root, 'startup-visible'))) visibleMs = performance.now() - start;
                    if (directoryMs === undefined && fs.existsSync(path.join(root, 'startup-directory'))) directoryMs = performance.now() - start;
                }) : null;
                await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');
                commandMs = performance.now() - start;
                fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ blocks }));
                const deadline = Date.now() + 120000;
                while (!fs.existsSync(path.join(root, `${blocks}.done`))) {
                    if (Date.now() > deadline) throw new Error('Renderer measurement timed out');
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                assert.equal(document.getText(), before, 'focus and refresh must not modify source');
                assert.equal(document.isDirty, false);
            } finally {
                clearInterval(timer);
                observer?.close();
            }
            return { blocks, vscodeVersion: vscode.version, activationMs, commandMs, visibleMs, directoryMs, memoryBefore,
                peakRss: Math.max(peakRss, process.memoryUsage().rss), maxEventLoopGapMs, eventLoopGaps };
        });
        if (startup) {
            const { visibleMs, directoryMs } = measurement;
            assert.ok(Number.isFinite(visibleMs) && Number.isFinite(directoryMs), 'Renderer must confirm both milestones');
            results.push(measurement);
            fs.writeFileSync(path.join(root, 'startup-results.json'), JSON.stringify(results));
        }
    }
};
