'use strict';

import type { NotificationType, RequestType } from 'vscode-messenger-common';

export type KeywordOptionsStatus = 'loading' | 'empty' | 'no-options' | 'configuring' | 'ready' | 'applying' | 'stale' | 'error';

export type KeywordOptionValueState = {
    valueId: string;
    label: string;
    selected: boolean;
    enabled: boolean;
};

export type KeywordOptionDimensionState = {
    dimensionId: string;
    label: string;
    selectionMode: 'single' | 'multiple';
    required: boolean;
    values: KeywordOptionValueState[];
};

export type KeywordOptionSearchTarget = {
    targetKeyword: string;
    selected: boolean;
};

export type KeywordOptionPostChoiceState = {
    targetPostCount: number;
    label: string;
    selected: boolean;
    enabled: boolean;
    reason?: string;
};

export type KeywordManagerControlState = {
    controlId: string;
    kind: 'field' | 'enum' | 'boolean' | 'selector';
    label: string;
    groupId?: string;
    value?: string | boolean;
    choices?: Array<{ value: string; label: string; enabled: boolean }>;
    emptyLabel?: string;
    emptyEnabled?: boolean;
    visible: boolean;
    enabled: boolean;
    fieldId?: string;
    targetPostCountByValue?: Record<string, number>;
    reason?: string;
};

export type KeywordOptionsMutationResult = {
    accepted: boolean;
    state: KeywordOptionsViewState;
    reason?: string;
};

export type KeywordManagerInstanceState = {
    instanceId: string;
    uri?: string;
    filePath?: string;
    fileName?: string;
    displayPath?: string;
    keyword: string;
    line: number;
    endLine: number;
    dataLineCount: number;
    occurrenceCount: number;
    category: string;
    displayName: string;
    typeKey?: string;
    title?: string;
    identity?: { field: string; value: string };
    summary?: Array<{ field: string; value: string }>;
    recordStartIndex?: number;
    selected: boolean;
    editLevel: 'editable' | 'recovery';
    dirty?: boolean;
    readonly?: boolean;
    reason?: string;
    message?: string;
};

export type KeywordManagerCapabilityState = {
    capabilityId: 'spelling-switch' | 'layout-migration' | 'fixed-field-edit' |
        'field-choice' | 'field-help' | 'field-driven-card-visibility' |
        'repeat-card-edit';
    label: string;
    availability: 'available' | 'recovery';
    write: boolean;
    reason?: string;
    message?: string;
    evidenceIds: string[];
};

export type KeywordManagerDiagnostic = {
    expectedRecords?: number;
    actualRecords?: number;
    controls?: Array<{ name: string; value: string; line: number; fieldId: string }>;
    conditions?: string[];
    requiredCards?: Array<{ condition: string; fields: string[] }>;
    code: string;
    source: 'original' | 'draft';
    severity: 'warning' | 'error';
    blocksApply: boolean;
    message: string;
    line?: number;
    fieldId?: string;
};

export type KeywordManagerFieldState = {
    fieldId: string;
    cardIndex: number;
    line: number;
    name: string;
    type: string;
    position: number;
    width: number;
    value: string;
    draft?: string;
    diagnostic?: KeywordManagerDiagnostic;
    linkedFields?: string[];
    choices?: string[];
    defaultValue?: string;
    visible?: boolean;
    enabled?: boolean;
    editable: boolean;
    reason?: string;
};

export type KeywordManagerHelpState = {
    status: 'none' | 'loading' | 'ready' | 'unavailable';
    fieldId: string | null;
    name?: string;
    schemaName?: string;
    schemaKeyword?: string;
    contextKey?: string;
    reason?: 'form-unresolved' | 'branch-unverified' | 'branch-help-missing' | 'field-unmatched' | 'description-missing';
    english?: string;
    localized?: string;
    defaultValue?: string;
    choices?: string[];
    message?: string;
};

export type KeywordOptionPreview = {
    sharedByteChanges?: string[];
    targetKeyword: string;
    changedFields: number;
    reviewLevel: 'none' | 'field' | 'structural' | 'destructive';
    migrated: number;
    added: number;
    discarded: number;
    comments: number;
    details: {
        keyword: string[];
        cards: string[];
        fields: string[];
        migrated: string[];
        added: string[];
        discarded: string[];
        comments: string[];
    };
};

export type KeywordOptionsViewState = {
    manualConditions?: Array<{ id: string; condition: string | null; fields: string[]; applicability: string;
        cards: string[]; summaries: Array<string | { english: string; localized?: string | null }>; evidence: Array<{ evidenceId: string; page: number; ruleId: string }>;
        unresolvedFields: string[]; reason: string | null }>;
    branchSummary?: { current: number[]; draft: number[]; added?: number[]; removed?: number[]; reordered?: boolean } | null;
    revision: number;
    status: KeywordOptionsStatus;
    locale: 'en' | 'zh';
    pinned: boolean;
    provisional: boolean;
    currentKeyword: string;
    targetKeyword: string;
    currentPostCount: number;
    targetPostCount: number;
    mode: 'dimensions' | 'search' | 'fields' | 'none';
    dimensions: KeywordOptionDimensionState[];
    targets: KeywordOptionSearchTarget[];
    postChoices: KeywordOptionPostChoiceState[];
    controls: KeywordManagerControlState[];
    formCandidates: Array<{ ruleId: string; label: string }>;
    selectedFormRuleId: string | null;
    instances: KeywordManagerInstanceState[];
    instanceContext?: Pick<KeywordManagerInstanceState, 'uri' | 'typeKey' | 'filePath' | 'fileName' | 'dirty'>;
    directoryStatus?: 'loading' | 'ready' | 'error';
    selectedInstanceId: string | null;
    editLevel: 'editable' | 'recovery';
    capabilities: KeywordManagerCapabilityState[];
    cards: Array<{ cardId?: string; title?: string; cardIndex: number; occurrenceIndex?: number; line: number; editable: boolean; reason?: string; fields: KeywordManagerFieldState[] }>;
    layoutDiagnostics?: KeywordManagerDiagnostic[];
    unresolvedRecords?: Array<{ line: number; text: string }>;
    selectedFieldId: string | null;
    help: KeywordManagerHelpState;
    preview: KeywordOptionPreview | null;
    hasDrafts: boolean;
    canApply: boolean;
    message: string;
    labels: {
        selectorReload: string;
        selectorAppliedReselect: string;
        selectorTitle: string;
        selectorSearch: string;
        selectorPrevious: string;
        selectorNext: string;
        selectorClear: string;
        selectorClose: string;
        selectorFileOrder: string;
        selectorIdOrder: string;
        selectorSort: string;
        selectorCurrent: string;
        selectorLine: string;
        selectorRecord: string;
        selectorCount: string;
        selectorCountSingle: string;
        selectorSelected: string;
        selectorMissing: string;
        selectorNoMatch: string;
        selectorOutside: string;
        selectorLoading: string;
        selectorError: string;
        selectorEmpty: string;
        current: string;
        result: string;
        search: string;
        postCards: string;
        apply: string;
        reset: string;
        pin: string;
        unpin: string;
        migrated: string;
        added: string;
        discarded: string;
        details: string;
        keywordLine: string;
        cards: string;
        fields: string;
        comments: string;
        currentFile: string;
        dirty: string;
        readonly: string;
        noOptions: string;
        provisional: string;
        reviewed: string;
        capabilities: string;
        available: string;
        locateSource: string;
        openManual: string;
        resetField: string;
    };
};

export type KeywordOptionsRevisionRequest = { revision: number };
export type KeywordOptionsDimensionRequest = KeywordOptionsRevisionRequest & {
    dimensionId: string;
    values: string[];
};
export type KeywordOptionsTargetRequest = KeywordOptionsRevisionRequest & { targetKeyword: string };
export type KeywordOptionsPostCountRequest = KeywordOptionsRevisionRequest & { targetPostCount: number };
export type KeywordManagerUpdateControlRequest = KeywordOptionsRevisionRequest & {
    controlId: string;
    value: string | boolean;
};
export type KeywordManagerInstanceRequest = KeywordOptionsRevisionRequest & { instanceId: string };
export type KeywordManagerFieldRequest = KeywordOptionsRevisionRequest & { fieldId: string };
export type KeywordManagerHelpRequest = KeywordManagerFieldRequest & { instanceId: string | null; requestId: number };
export type KeywordManagerHelpResult = KeywordManagerHelpRequest & {
    accepted: boolean;
    help?: KeywordManagerHelpState;
    reason?: string;
};
export type KeywordManagerFieldValueRequest = KeywordOptionsRevisionRequest & { fieldId: string; value: string };
export type KeywordManagerFormRequest = KeywordOptionsRevisionRequest & { ruleId: string };

export const KeywordOptionsReadyRequest: RequestType<KeywordOptionsRevisionRequest, KeywordOptionsViewState> =
    { method: 'keywordOptions/ready' };
export const KeywordOptionsSelectDimensionRequest:
    RequestType<KeywordOptionsDimensionRequest, KeywordOptionsMutationResult> = { method: 'keywordOptions/selectDimension' };
export const KeywordOptionsSelectTargetRequest:
    RequestType<KeywordOptionsTargetRequest, KeywordOptionsMutationResult> = { method: 'keywordOptions/selectTarget' };
export const KeywordOptionsSelectPostCountRequest:
    RequestType<KeywordOptionsPostCountRequest, KeywordOptionsMutationResult> = { method: 'keywordOptions/selectPostCount' };
export const KeywordManagerUpdateControlRequest:
    RequestType<KeywordManagerUpdateControlRequest, KeywordOptionsMutationResult> = { method: 'keywordManager/updateControl' };
export const KeywordManagerSelectFormRequest:
    RequestType<KeywordManagerFormRequest, KeywordOptionsMutationResult> = { method: 'keywordManager/selectForm' };
export const KeywordManagerSelectInstanceRequest:
    RequestType<KeywordManagerInstanceRequest, KeywordOptionsMutationResult> = { method: 'keywordManager/selectInstance' };
export const KeywordManagerSelectFieldRequest:
    RequestType<KeywordManagerHelpRequest, KeywordManagerHelpResult> = { method: 'keywordManager/selectField' };
export const KeywordManagerUpdateFieldRequest:
    RequestType<KeywordManagerFieldValueRequest, KeywordOptionsMutationResult> = { method: 'keywordManager/updateField' };
export const KeywordManagerLocateSourceRequest: RequestType<KeywordOptionsRevisionRequest, boolean> =
    { method: 'keywordManager/locateSource' };
export const KeywordManagerOpenManualRequest: RequestType<KeywordOptionsRevisionRequest & { conditionId?: string; evidenceId?: string }, boolean> =
    { method: 'keywordManager/openManual' };
export const KeywordOptionsApplyRequest: RequestType<KeywordOptionsRevisionRequest, KeywordOptionsMutationResult> =
    { method: 'keywordOptions/apply' };
export const KeywordOptionsResetRequest: RequestType<KeywordOptionsRevisionRequest, KeywordOptionsMutationResult> =
    { method: 'keywordOptions/reset' };
export const KeywordOptionsTogglePinRequest: RequestType<KeywordOptionsRevisionRequest, KeywordOptionsMutationResult> =
    { method: 'keywordOptions/togglePin' };
export const KeywordOptionsStateChangedNotification: NotificationType<KeywordOptionsViewState> =
    { method: 'keywordOptions/stateChanged' };
