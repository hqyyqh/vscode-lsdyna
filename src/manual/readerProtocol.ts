'use strict';

import type { NotificationType, RequestType } from 'vscode-messenger-common';
import type { ManualLanguage, ManualLocation, ManualSearchMode, ManualSearchResult, ManualSearchScope } from './manualTypes';
export type { ManualLanguage, ManualLocation, ManualSearchMode, ManualSearchResult, ManualSearchScope } from './manualTypes';

export type ReaderUiLocale = 'en' | 'zh';

/** Host-owned toolbar identity (volume / chapter). Location stays navigation-only. */
export interface ReaderChromeIdentity {
    /** Manifest document title, e.g. "Volume I". Fallback: manualId. */
    volumeTitle: string;
    /** Chapter label from chunks/<dir> grouping. Empty when unknown. */
    chapterLabel: string;
    /** Raw chapter key (e.g. 12_contact); null when unresolved. */
    chapterKey?: string | null;
}

export interface ReaderViewModel {
    revision: number;
    location: ManualLocation;
    language: ManualLanguage;
    uiLocale: ReaderUiLocale;
    /** False for English-only packs — host/UI hide language toggle. */
    canToggleLanguage: boolean;
    /** Sticky toolbar document identity (volume · chapter). */
    chrome: ReaderChromeIdentity;
    content:
        | {
            kind: 'document';
            markdown: string;
            chunkBaseUri: string;
            sentencePairs: Array<{ primary: string; secondary: string; unitId?: string }>;
        }
        | { kind: 'error'; message: string };
    navigation: {
        canBack: boolean;
        canForward: boolean;
        canPreviousSection: boolean;
        canNextSection: boolean;
    };
    search: {
        query: string;
        scope: ManualSearchScope;
        mode: ManualSearchMode;
        results: ManualSearchResult[];
    };
    restore: {
        anchorId: string | null;
        scrollY: number;
        scrollRatio: number;
    };
}

export interface ReaderRevisionRequest { revision: number }
export type ReaderNavigateTarget = 'back' | 'forward' | 'previousSection' | 'nextSection' | ManualLocation;
export interface ReaderNavigateRequest extends ReaderRevisionRequest { target: ReaderNavigateTarget }
export interface ReaderSearchRequest extends ReaderRevisionRequest {
    query: string;
    scope: ManualSearchScope;
    mode?: ManualSearchMode;
}
export interface ReaderOpenLinkRequest extends ReaderRevisionRequest { href: string }
export interface ReaderScrollChanged extends ReaderRevisionRequest { scrollY: number; scrollRatio: number; anchorId: string | null }

export const ReaderReadyRequest: RequestType<ReaderRevisionRequest, ReaderViewModel> = { method: 'reader/ready' };
export const ReaderNavigateRequestType: RequestType<ReaderNavigateRequest, boolean> = { method: 'reader/navigate' };
export const ReaderToggleLanguageRequest: RequestType<ReaderRevisionRequest, boolean> = { method: 'reader/toggleLanguage' };
export const ReaderSearchRequestType: RequestType<ReaderSearchRequest, boolean> = { method: 'reader/search' };
export const ReaderOpenLinkRequestType: RequestType<ReaderOpenLinkRequest, boolean> = { method: 'reader/openLink' };
export const ReaderOpenPdfRequest: RequestType<ReaderRevisionRequest, boolean> = { method: 'reader/openPdf' };
export const ReaderScrollChangedNotification: NotificationType<ReaderScrollChanged> = { method: 'reader/scrollChanged' };
export const ReaderStateChangedNotification: NotificationType<ReaderViewModel> = { method: 'reader/stateChanged' };
