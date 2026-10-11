export type StructureStatus =
    | 'valid'
    | 'definite-error'
    | 'context-dependent'
    | 'ambiguous'
    | 'profile-unverified'
    | 'unsupported-input';

export type VerificationStatus = 'verified-full' | 'verified-boundary-only';

export type TriState = 'true' | 'false' | 'unknown';

export type StructureLocation = {
    evidenceId?: string;
    evidenceTextSha256?: string;
    manualId: string;
    page: number;
    quoteSha256?: string;
};

export type StructurePredicate = {
    op: string;
    field?: string;
    value?: unknown;
    values?: unknown[];
    option?: string;
    predicates?: StructurePredicate[];
    predicate?: StructurePredicate;
    [key: string]: unknown;
};

export type StructureNode = {
    type: string;
    nodeId: string;
    sourceProfileId: string;
    verificationStatus: VerificationStatus;
    evidenceIds?: string[];
    locations?: StructureLocation[];
    nodes?: StructureNode[];
    branches?: StructureNode[];
    node?: StructureNode;
    thenNode?: StructureNode;
    elseNode?: StructureNode;
    predicate?: StructurePredicate;
    cardinality?: string;
    min?: number;
    max?: number;
    minLines?: number;
    maxLines?: number;
    countFrom?: unknown;
    until?: unknown;
    omission?: string;
    option?: string;
    value?: unknown;
    marker?: unknown;
    contextRequirement?: unknown;
    mode?: string;
    terminator?: unknown;
    cardNodeId?: string;
    cardLabel?: string;
    blankAllowed?: boolean;
    formatChoice?: string[];
    geometryRef?: any;
    [key: string]: unknown;
};

export type StructureGrammar = {
    grammarId: string;
    keyword: string;
    sourceProfileId: string;
    verificationStatus: VerificationStatus;
    root: StructureNode;
    prefixes?: Array<{ option: string; policyId?: string; node: StructureNode }>;
    suffixes?: Array<{ option: string; policyId?: string; node: StructureNode }>;
    unsupportedOptions?: Array<{ option: string; reason: string; evidenceIds?: string[] }>;
    repairPolicy?: {
        automatic?: boolean;
        uniqueRepairEligible?: boolean;
        mode?: string;
        insertableCardOrdinals?: number[];
        minimumExistingPhysicalCard?: number;
        targetPhysicalCard?: number;
        [key: string]: unknown;
    };
    [key: string]: unknown;
};

export type StructureBinding = {
    status: string;
    grammarId?: string;
    reason?: string;
    details?: Record<string, unknown>;
};

export type ObservedComment = {
    line: number;
    text: string;
    kind: 'field-header' | 'comment';
};

export type ObservedRecord = {
    ordinal: number;
    line: number;
    text: string;
    format: 'fixed' | 'free';
    comments: ObservedComment[];
};

export type ObservedKeywordBlock = {
    keyword: string;
    rawKeyword: string;
    keywordLine: number;
    endLine: number;
    records: ObservedRecord[];
    trailingComments: ObservedComment[];
    preprocessorMetadata: Array<{ line: number; text: string }>;
    boundary: 'next-keyword' | 'eof' | 'provided-end';
};

export type DecodedField = {
    name: string;
    raw: string;
    value?: unknown;
    state: 'known' | 'blank' | 'parameter' | 'invalid' | 'unsupported';
    typeCode?: string;
};

export type RecordMatchQuality = 'exact' | 'unknown' | 'mismatch' | 'unsupported';

export type RecordMatch = {
    quality: RecordMatchQuality;
    reason?: string;
    decodedFields: DecodedField[];
};

export type ExpectedRecord = {
    node: StructureNode;
    nodeId: string;
    cardNodeId?: string;
    cardLabel: string;
    marker?: unknown;
    wrappers: string[];
};

export type PredicateAssumption = {
    predicate: StructurePredicate;
    expected: boolean;
    nodeId: string;
};

export type GrammarPath = {
    records: ExpectedRecord[];
    assumptions: PredicateAssumption[];
    dependencies: string[];
    branchTrace: string[];
};

export type StructureEdit = {
    kind: 'insert' | 'delete' | 'substitute' | 'move' | 'branch' | 'option' | 'context';
    observedIndex?: number;
    expectedIndex?: number;
    observedLine?: number;
    cardNodeId?: string;
    cardLabel?: string;
    nodeId?: string;
    reason?: string;
};

export type RecordMapping = {
    observedOrdinal: number;
    observedLine: number;
    expectedIndex?: number;
    cardNodeId?: string;
    cardLabel?: string;
    nodeId?: string;
    status: 'matched' | 'mapping-ambiguous' | 'extra' | 'mismatch';
};

export type StructureRepairCandidate = {
    kind: 'insert-blank-record';
    insertionRecordIndex: number;
    beforeLine?: number;
    cardNodeId: string;
    cardLabel: string;
    nodeId: string;
    text: string;
    format: 'fixed' | 'free';
};

export type StructureAnalysis = {
    status: StructureStatus;
    reason: string;
    keyword: string;
    sourceProfileId?: string;
    bindingStatus?: string;
    grammarId?: string;
    verificationStatus?: VerificationStatus;
    observedDataRecords: number;
    expectedDataRecords?: number;
    mappingAmbiguous?: boolean;
    records: RecordMapping[];
    diagnostics: StructureEdit[];
    alternativeDiagnostics?: StructureEdit[][];
    dependencies: string[];
    repairCandidates: StructureRepairCandidate[];
    block?: ObservedKeywordBlock;
    details?: Record<string, unknown>;
};

export type StructureContext = {
    fields?: Record<string, unknown>;
    keywordOptions?: Iterable<string>;
    version?: string | number;
    solverMode?: string;
    preprocessor?: Record<string, unknown>;
};

export type StructureBudgets = {
    maximumRecords: number;
    maximumPaths: number;
    maximumExpandedRecords: number;
    maximumAlignments: number;
    maximumDynamicProgrammingCells: number;
};
