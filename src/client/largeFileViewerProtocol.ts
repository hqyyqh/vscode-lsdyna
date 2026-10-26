'use strict';

import type { NotificationType, RequestType } from 'vscode-messenger-common';

export type LargeFileFieldSpan = {
    token: string;
    startColumn: number;
    endColumn: number;
    label: string;
    queryable: boolean;
};

export type LargeFileViewerLine = {
    lineNumber: number;
    text: string;
    truncated: boolean;
    keyword: boolean;
    fields: LargeFileFieldSpan[];
};

export type LargeFileSelectedField = {
    token: string;
    label: string;
    value: string;
    keyword: string;
    cardIndex: number;
    localizedHelp: string;
    englishHelp: string;
    type: string;
    defaultValue: string;
    choices: string[];
    queryable: boolean;
    object?: { kind: string; kindLabel: string; id: string; name?: string };
};

export type LargeFileViewerState = {
    revision: number;
    dirty?: boolean;
    viewer?: string;
    editError?: string;
    locale?: 'en' | 'zh';
    fileName: string;
    fileSize: number;
    anchorLine: number;
    navigationTarget?: { requestId?: string; line: number; startColumn: number; endColumn: number };
    lineCount?: number;
    availableLineCount?: number;
    scannedBytes?: number;
    lines: LargeFileViewerLine[];
    currentKeyword: string;
    indexing: 'loading' | 'ready' | 'error';
    indexingMessage: string;
    stale: boolean;
    selectedField: LargeFileSelectedField | null;
    keywordSearch?: { query: string; count: number; currentIndex: number };
    search: {
        query: string;
        loading: boolean;
        count: number;
        currentIndex: number;
        currentLine?: number;
        truncated: boolean;
        message: string;
    };
    labels: Record<string, string>;
};

export type LargeFileRevisionRequest = { revision: number };
export type LargeFileNavigateRequest = LargeFileRevisionRequest & { line: number };
export type LargeFileKeywordNavigateRequest = LargeFileRevisionRequest & {
    direction: -1 | 1;
    filter: string;
};
export type LargeFileSearchRequest = LargeFileRevisionRequest & { query: string };
export type LargeFileSearchStepRequest = LargeFileRevisionRequest & { direction: -1 | 1 };
export type LargeFileFieldRequest = LargeFileRevisionRequest & { token: string };

export const LargeFileReadyRequest:
    RequestType<LargeFileRevisionRequest, LargeFileViewerState> =
    { method: 'largeFile/ready' };
export const LargeFileNavigateRequestType:
    RequestType<LargeFileNavigateRequest, boolean> =
    { method: 'largeFile/navigate' };
export const LargeFileKeywordNavigateRequestType:
    RequestType<LargeFileKeywordNavigateRequest, boolean> =
    { method: 'largeFile/navigateKeyword' };
export const LargeFileSearchRequestType:
    RequestType<LargeFileSearchRequest, boolean> =
    { method: 'largeFile/search' };
export const LargeFileSearchStepRequestType:
    RequestType<LargeFileSearchStepRequest, boolean> =
    { method: 'largeFile/searchStep' };
export const LargeFileSelectFieldRequest:
    RequestType<LargeFileFieldRequest, boolean> =
    { method: 'largeFile/selectField' };
export const LargeFileQueryFieldRequest:
    RequestType<LargeFileFieldRequest, boolean> =
    { method: 'largeFile/queryField' };
export const LargeFileReloadRequest:
    RequestType<LargeFileRevisionRequest, boolean> =
    { method: 'largeFile/reload' };
export const LargeFileStateChangedNotification: NotificationType<LargeFileViewerState> =
    { method: 'largeFile/stateChanged' };


export const LargeFilePositionChanged: NotificationType<LargeFileNavigateRequest> =
    { method: 'largeFile/positionChanged' };

export const LargeFileOpenNative: RequestType<LargeFileRevisionRequest & { line: number; token?: string }, boolean> = { method: 'largeFile/openNative' };
