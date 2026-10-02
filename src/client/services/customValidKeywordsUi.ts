'use strict';

/**
 * @fileoverview QuickPick UI for managing lsdyna.customValidKeywords.
 * @module client/services/customValidKeywordsUi
 */

const vscode = require('vscode');
const i18n = require('../../core/i18n');
const {
    inspectCustomValidKeywords,
    addCustomValidKeyword,
    removeCustomValidKeyword,
    replaceCustomValidKeyword,
    normalizeCustomKeywordEntry,
    resolveEntrySource,
    resolveTarget,
} = require('./customValidKeywords');

type ManageUiOptions = {
    config?: any;
    showQuickPick?: (items: any[], options?: object) => Promise<any>;
    showInputBox?: (options?: object) => Promise<string | undefined>;
    showInformationMessage?: (...args: any[]) => Promise<any>;
    showWarningMessage?: (...args: any[]) => Promise<any>;
    executeCommand?: (command: string, ...args: any[]) => Promise<any>;
};

function sourceLabel(source) {
    if (source === 'workspace') return i18n.get('customValidKeywordSourceWorkspace');
    if (source === 'global') return i18n.get('customValidKeywordSourceUser');
    if (source === 'default') return i18n.get('customValidKeywordSourceDefault');
    return i18n.get('customValidKeywordSourceUser');
}

/**
 * Ask User vs Workspace target.
 *
 * @param {ManageUiOptions} ui
 * @returns {Promise<number|undefined>}
 */
async function pickTarget(ui) {
    const showQuickPick = ui.showQuickPick || ((items, opts) => vscode.window.showQuickPick(items, opts));
    const picked = await showQuickPick([
        {
            label: i18n.get('customValidKeywordTargetUser'),
            description: i18n.get('customValidKeywordTargetUserDetail'),
            target: 'global',
        },
        {
            label: i18n.get('customValidKeywordTargetWorkspace'),
            description: i18n.get('customValidKeywordTargetWorkspaceDetail'),
            target: 'workspace',
        },
    ], {
        title: i18n.get('customValidKeywordPickTargetTitle'),
        placeHolder: i18n.get('customValidKeywordPickTargetPlaceholder'),
        ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    return resolveTarget(picked.target);
}

/**
 * Open the manage QuickPick loop.
 *
 * @param {ManageUiOptions} [options]
 * @returns {Promise<void>}
 */
async function showManageCustomValidKeywordsPick(options: ManageUiOptions = {}) {
    const showQuickPick = options.showQuickPick || ((items, opts) => vscode.window.showQuickPick(items, opts));
    const showInputBox = options.showInputBox || (opts => vscode.window.showInputBox(opts));
    const showInformationMessage = options.showInformationMessage
        || ((...args) => vscode.window.showInformationMessage(...args));
    const showWarningMessage = options.showWarningMessage
        || ((...args) => vscode.window.showWarningMessage(...args));
    const executeCommand = options.executeCommand
        || ((command, ...args) => vscode.commands.executeCommand(command, ...args));
    const config = options.config;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const layers = inspectCustomValidKeywords({ config });
        /** @type {any[]} */
        const items: any[] = [
            {
                label: `$(add) ${i18n.get('customValidKeywordManageAdd')}`,
                alwaysShow: true,
                action: 'add',
            },
            {
                label: `$(settings-gear) ${i18n.get('customValidKeywordManageOpenSettings')}`,
                alwaysShow: true,
                action: 'settings',
            },
        ];

        for (const entry of layers.effective) {
            const source = resolveEntrySource(entry, { config });
            items.push({
                label: entry,
                description: sourceLabel(source),
                detail: entry.endsWith('*')
                    ? i18n.get('customValidKeywordWildcardDetail')
                    : undefined,
                entry,
                source,
                action: 'item',
            });
        }

        const picked = await showQuickPick(items, {
            title: i18n.get('customValidKeywordManageTitle'),
            placeHolder: i18n.get('customValidKeywordManagePlaceholder'),
            matchOnDescription: true,
            ignoreFocusOut: true,
        });
        if (!picked) {
            return;
        }

        if (picked.action === 'settings') {
            await executeCommand(
                'workbench.action.openSettings',
                'lsdyna.customValidKeywords'
            );
            return;
        }

        if (picked.action === 'add') {
            const value = await showInputBox({
                title: i18n.get('customValidKeywordManageAdd'),
                prompt: i18n.get('customValidKeywordInputPrompt'),
                placeHolder: '*MY_KEYWORD or *MY_PREFIX_*',
                ignoreFocusOut: true,
                validateInput: (text) => {
                    if (!String(text || '').trim()) {
                        return i18n.get('customValidKeywordInvalid');
                    }
                    return normalizeCustomKeywordEntry(text)
                        ? null
                        : i18n.get('customValidKeywordInvalid');
                },
            });
            if (value == null) {
                continue;
            }
            const target = await pickTarget({ showQuickPick, ...options });
            if (target == null) {
                continue;
            }
            const result = await addCustomValidKeyword({ keyword: value, target, config });
            if (result.status === 'invalid') {
                await showWarningMessage(i18n.get('customValidKeywordInvalid'));
            } else if (result.status === 'exists') {
                await showInformationMessage(i18n.get('customValidKeywordAlready', result.entry));
            } else {
                await showInformationMessage(i18n.get('customValidKeywordAdded', result.entry));
            }
            continue;
        }

        if (picked.action === 'item' && picked.entry) {
            const source = picked.source || resolveEntrySource(picked.entry, { config });
            if (source === 'default') {
                await showWarningMessage(i18n.get('customValidKeywordDefaultReadOnly', picked.entry));
                continue;
            }
            const action = await showQuickPick([
                {
                    label: i18n.get('customValidKeywordManageEdit'),
                    action: 'edit',
                },
                {
                    label: i18n.get('customValidKeywordManageDelete'),
                    action: 'delete',
                },
            ], {
                title: picked.entry,
                placeHolder: i18n.get('customValidKeywordManageItemPlaceholder'),
                ignoreFocusOut: true,
            });
            if (!action) {
                continue;
            }
            const target = source === 'workspace'
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;

            if (action.action === 'delete') {
                const result = await removeCustomValidKeyword({
                    keyword: picked.entry,
                    target,
                    config,
                });
                if (result.status === 'removed') {
                    await showInformationMessage(i18n.get('customValidKeywordRemoved', result.entry));
                } else {
                    await showWarningMessage(i18n.get('customValidKeywordRemoveMissing', picked.entry));
                }
                continue;
            }

            if (action.action === 'edit') {
                const value = await showInputBox({
                    title: i18n.get('customValidKeywordManageEdit'),
                    value: picked.entry,
                    prompt: i18n.get('customValidKeywordInputPrompt'),
                    ignoreFocusOut: true,
                    validateInput: (text) => normalizeCustomKeywordEntry(text)
                        ? null
                        : i18n.get('customValidKeywordInvalid'),
                });
                if (value == null) {
                    continue;
                }
                const result = await replaceCustomValidKeyword({
                    from: picked.entry,
                    to: value,
                    target,
                    config,
                });
                if (result.ok) {
                    await showInformationMessage(i18n.get('customValidKeywordReplaced', result.entry));
                } else {
                    await showWarningMessage(i18n.get('customValidKeywordRemoveMissing', picked.entry));
                }
            }
        }
    }
}

module.exports = {
    showManageCustomValidKeywordsPick,
    pickTarget,
};

export {};
