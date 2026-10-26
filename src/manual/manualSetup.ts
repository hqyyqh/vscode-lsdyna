import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ManualIndexRepository } from './ManualIndexRepository';
import { discoverManualPdfFiles } from './packPdf';
const i18n = require('../core/i18n');

export function validateManualDirectory(root: string): void {
    if (fs.existsSync(path.join(root, 'manifest.json'))) {
        const repository = new ManualIndexRepository(root);
        repository.loadNavigation();
        repository.getCapabilities();
        if (!repository.listSections().length) throw new Error('Manual pack has no sections');
    } else if (!discoverManualPdfFiles(root).some(file => fs.statSync(file).isFile())) {
        throw new Error('No manual pack or PDF files');
    }
}

/** Only explicit setup actions open external pages or change the selected directory. */
export async function chooseManualDirectory(unavailable = false): Promise<string | undefined> {
    let prompt = unavailable ? 'manualSetupUnavailable' : 'manualSetupPrompt';
    for (;;) {
        const choice = await vscode.window.showQuickPick([
            { label: `$(folder-opened) ${i18n.get('manualSetupSelectFolder')}`, description: i18n.get('manualSetupFolderHint'), action: 'folder' },
            ...(i18n.getLanguage() === 'zh-cn' ? [{ label: `$(cloud-download) ${i18n.get('manualDownloadBilingual')}`, description: i18n.get('manualSetupDownloadHint'), action: 'bilingual' }] : []),
            { label: `$(cloud-download) ${i18n.get('manualDownloadEnglish')}`, description: i18n.get('manualSetupDownloadHint'), action: 'en' },
        ], { title: i18n.get('manualSetupTitle'), placeHolder: i18n.get(prompt), matchOnDescription: true });
        if (!choice) return;
        if (choice.action !== 'folder') {
            const url = `https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-${choice.action}.zip`;
            try { if (await vscode.env.openExternal(vscode.Uri.parse(url))) return; }
            catch (error) { console.warn('[DynaSense] Manual download link failed:', error); }
            prompt = 'manualDownloadFailed';
            continue;
        }
        const folders = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false,
            canSelectMany: false, openLabel: i18n.get('manualSetupSelectFolder'), title: i18n.get('manualSetupFolderHint') });
        if (!folders?.[0]) return;
        try { validateManualDirectory(folders[0].fsPath); return folders[0].fsPath; }
        catch (error) { console.warn('[DynaSense] Invalid manual directory:', error); prompt = 'manualSetupUnavailable'; }
    }
}
