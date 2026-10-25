'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');
const { fetchJson, openSocket, createCdp } = require('../../support/devtools.cjs');
const { createEvidenceDirectory } = require('../../../scripts/host/temp-runs.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Measure the glyph stroke, including its margin and blank prefix, in the actual editor.
function measure() {
    const editor = [...document.querySelectorAll('.monaco-editor')].find(e =>
        e.querySelector('.view-line')?.textContent === '*KEYWORD');
    if (!editor) return null;
    const rulers = [...editor.querySelectorAll('.view-ruler')].map(e => e.getBoundingClientRect().x);
    const lines = [...editor.querySelectorAll('.view-line')].map(line => {
        const guides = [];
        for (const span of line.querySelectorAll('span')) for (const side of ['before', 'after']) {
            const style = getComputedStyle(span, '::' + side), rect = span.getBoundingClientRect();
            if (!style.content.includes('│')) continue;
            const text = style.content.slice(1, -1), prefix = text.slice(0, -1);
            const canvas = document.createElement('canvas').getContext('2d');
            canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const glyph = canvas.measureText('│');
            const centre = (glyph.actualBoundingBoxRight - glyph.actualBoundingBoxLeft) / 2;
            const prefixWidth = canvas.measureText(prefix).width + prefix.length * (parseFloat(style.letterSpacing) || 0);
            guides.push({ side, x: rect.x + parseFloat(style.marginLeft) + prefixWidth + centre,
                occupiedWidth: rect.width, expectedWidth: parseFloat(style.width), color: style.color });
        }
        return { text: line.textContent.replaceAll('\u00a0', ' '), guides };
    });
    const font = getComputedStyle(editor.querySelector('.view-line'));
    return { rulers, lines, fontSize: parseFloat(font.fontSize), letterSpacing: parseFloat(font.letterSpacing) || 0 };
}

exports.check = async (root, checks) => {
    const evidence = createEvidenceDirectory('column-guides');
    console.log('Column guide evidence: ' + evidence);
    const file = path.join(root, 'workspace', 'guides.k');
    const data = ['1', '1', '1', '0', '0', '0', '0', '0'].map(v => v.padStart(10)).join('');
    const original = ['*KEYWORD', '*PART', 'Guide test', data, '$' + '1234567890'.repeat(9),
        '*NODE', '1, 0.0, 1.0, 2.0', '*INCLUDE', 'a-very-long-file-name-without-any-field-boundaries.k', '', '*END', ''].join('\n');
    fs.writeFileSync(file, original);
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document);
    const targets = await fetchJson(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/json/list`);
    const target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
    assert.ok(target, 'workbench CDP target');
    const cdp = createCdp(await openSocket(target.webSocketDebuggerUrl));
    const results = [];
    try {
        await vscode.commands.executeCommand('notifications.clearAll');
        for (const theme of ['Default Light Modern', 'Default Dark Modern', 'Default High Contrast', 'Default High Contrast Light']) {
            await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
            for (const [fontSize, letterSpacing] of [[14, 0], [28, 0], [14, 1]]) {
                const config = vscode.workspace.getConfiguration('editor', document);
                await config.update('fontSize', fontSize, vscode.ConfigurationTarget.Global);
                await config.update('letterSpacing', letterSpacing, vscode.ConfigurationTarget.Global);
                editor.revealRange(new vscode.Range(1, 80, 1, 80));
                // Theme and font changes repaint asynchronously; poll for stable passing geometry.
                let measured, error;
                const deadline = Date.now() + 5000;
                do {
                    await delay(100);
                    const reply = await cdp.call('Runtime.evaluate', { returnByValue: true, expression: `(${measure})()` });
                    assert.ok(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
                    measured = reply.result.value;
                    try {
                        assert.equal(measured?.rulers.length, 8);
                        assert.equal(measured.fontSize, fontSize);
                        assert.equal(measured.letterSpacing, letterSpacing);
                        for (const line of measured.lines) {
                            const count = line.text === data ? 8 : 0;
                            assert.equal(line.guides.length, count);
                            for (const [i, guide] of line.guides.entries()) {
                                assert.ok(Math.abs(guide.occupiedWidth - guide.expectedWidth) < 0.1, 'alignment must not add layout width');
                                const ruler = measured.rulers[guide.side === 'after' ? 7 : i];
                                assert.ok(Math.abs(guide.x - ruler) <= 1, `Guide ${i}: ${guide.x} vs ruler ${ruler}`);
                            }
                        }
                        assert.ok(measured.lines.some(l => l.text === data && l.guides.length === 8));
                        assert.ok(measured.lines.some(l => l.text.startsWith('$') && l.guides.length === 0));
                        assert.ok(measured.lines.some(l => l.text.length === 0));
                        error = undefined;
                    } catch (e) { error = e; }
                } while (error && Date.now() < deadline);
                const name = `${theme.replaceAll(' ', '-')}-${fontSize}-${letterSpacing}`;
                results.push({ theme, fontSize, letterSpacing, measured, error: error?.message });
                const shot = await cdp.call('Page.captureScreenshot');
                fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(shot.data, 'base64'));
                if (error) throw error;
            }
        }
        await vscode.workspace.getConfiguration('lsdyna', document.uri).update('columnGuides.enabled', false, vscode.ConfigurationTarget.Workspace);
        await delay(200);
        const disabled = (await cdp.call('Runtime.evaluate', { returnByValue: true, expression: `(${measure})()` })).result.value;
        assert.ok(disabled.lines.every(line => line.guides.length === 0), 'resource setting disables all guides');
        checks.push('column-guides:verified-card-only-and-resource-disable');
        assert.equal(document.getText(), original);
        assert.equal(document.isDirty, false);
        checks.push('column-guides-align-with-native-rulers:four-themes-three-font-settings');
    } finally {
        cdp.close();
        fs.writeFileSync(path.join(evidence, 'measurements.json'), JSON.stringify({ version: vscode.version, results }, null, 2));
    }
};
