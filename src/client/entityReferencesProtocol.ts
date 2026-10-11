'use strict';

import type { NotificationType, RequestType } from 'vscode-messenger-common';

export type EntityReferenceScopePreference = 'auto' | 'file' | 'project';
export type EntityReferenceViewStatus =
    'empty' | 'loading' | 'ready' | 'partial' | 'missing' | 'incomplete' | 'stale' | 'needs-refresh';

export type EntityReferenceKindOption = {
    value: string;
    label: string;
};

export type EntityReferenceLocationItem = {
    locationId: string;
    role: 'definition' | 'reference';
    label: string;
    description: string;
    fileLabel?: string;
    line?: number;
    detail: string;
    keyword?: string;
    fieldName?: string;
    entityId?: string;
    entityName?: string;
    entityKind?: string;
    entityKindLabel?: string;
};

export type EntityReferenceSessionSummary = {
    key: string;
    label: string;
    state: EntityReferenceViewStatus;
    pinned: boolean;
    active: boolean;
    scopeLabel?: string;
    scopePath?: string;
    definitionCount: number;
    referenceCount: number;
    entityId?: string;
    entityKindLabel?: string;
    entityName?: string;
    keyword?: string;
};

export type EntityReferencesViewState = {
    locale?: 'en' | 'zh';
    following: boolean;
    revision: number;
    /** A bounded next page, appended only to this exact preceding view revision. */
    appendPage?: { baseRevision: number; role: 'definition' | 'reference' };
    input: {
        targetKind: string;
        id: string;
        scopePreference: EntityReferenceScopePreference;
    };
    kindOptions: EntityReferenceKindOption[];
    scope: {
        selected: 'file' | 'project';
        fileAvailable: boolean;
        projectAvailable: boolean;
        fileLabel: string;
        projectLabel: string;
    };
    status: EntityReferenceViewStatus;
    ambiguous?: boolean;
    activeSession: EntityReferenceSessionSummary | null;
    definitions: EntityReferenceLocationItem[];
    references: EntityReferenceLocationItem[];
    referenceGroupCounts?: Record<string, number>;
    hasMoreDefinitions: boolean;
    hasMoreReferences: boolean;
    reasons: string[];
    pinnedSessions: EntityReferenceSessionSummary[];
    message: string;
    largeFileOffer?: {
        token: string;
        fileName: string;
        reason: string;
    };
    labels: Record<string, string>;
};

export type EntityReferencesRevisionRequest = { revision: number };
export type EntityReferencesQueryRequest = EntityReferencesRevisionRequest & {
    targetKind: string;
    id: string;
    scopePreference: EntityReferenceScopePreference;
};
export type EntityReferencesLoadMoreRequest = EntityReferencesRevisionRequest & {
    role: 'definition' | 'reference';
};
export type EntityReferencesSessionRequest = EntityReferencesRevisionRequest & { sessionKey: string };
export type EntityReferencesOpenRequest = EntityReferencesRevisionRequest & {
    locationId: string;
    side: boolean;
};
export type EntityReferencesOpenLargeFileRequest = EntityReferencesRevisionRequest & { token: string };

export const EntityReferencesReadyRequest:
    RequestType<EntityReferencesRevisionRequest, EntityReferencesViewState> =
    { method: 'entityReferences/ready' };
export const EntityReferencesQueryRequestType:
    RequestType<EntityReferencesQueryRequest, boolean> =
    { method: 'entityReferences/query' };
export const EntityReferencesInferRequest:
    RequestType<EntityReferencesRevisionRequest, boolean> =
    { method: 'entityReferences/infer' };
export const EntityReferencesSearchRequest:
    RequestType<EntityReferencesRevisionRequest, boolean> =
    { method: 'entityReferences/search' };
export const EntityReferencesScopeRequest:
    RequestType<EntityReferencesRevisionRequest & { scopePreference: 'file' | 'project' }, boolean> =
    { method: 'entityReferences/scope' };
export const EntityReferencesToggleFollowRequest:
    RequestType<EntityReferencesRevisionRequest, boolean> =
    { method: 'entityReferences/toggleFollow' };
export const EntityReferencesRefreshRequest:
    RequestType<EntityReferencesRevisionRequest, boolean> =
    { method: 'entityReferences/refresh' };
export const EntityReferencesLoadMoreRequestType:
    RequestType<EntityReferencesLoadMoreRequest, boolean> =
    { method: 'entityReferences/loadMore' };
export const EntityReferencesTogglePinRequest:
    RequestType<EntityReferencesSessionRequest, boolean> =
    { method: 'entityReferences/togglePin' };
export const EntityReferencesSelectSessionRequest:
    RequestType<EntityReferencesSessionRequest, boolean> =
    { method: 'entityReferences/selectSession' };
export const EntityReferencesRemoveSessionRequest:
    RequestType<EntityReferencesSessionRequest, boolean> =
    { method: 'entityReferences/removeSession' };
export const EntityReferencesClearRequest:
    RequestType<EntityReferencesRevisionRequest, boolean> =
    { method: 'entityReferences/clear' };
export const EntityReferencesOpenRequestType:
    RequestType<EntityReferencesOpenRequest, boolean> =
    { method: 'entityReferences/open' };
export const EntityReferencesOpenLargeFileRequestType:
    RequestType<EntityReferencesOpenLargeFileRequest, boolean> =
    { method: 'entityReferences/openLargeFile' };
export const EntityReferencesStateChangedNotification: NotificationType<EntityReferencesViewState> =
    { method: 'entityReferences/stateChanged' };
export const EntityReferencesFocusNotification: NotificationType<{ target: 'id' }> =
    { method: 'entityReferences/focus' };
