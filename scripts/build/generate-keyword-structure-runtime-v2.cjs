'use strict';
// Public deterministic compiler; external collection and certification are separate.
const crypto = require('crypto');

const EXPECTED_SOURCE_PROFILES = new Set([
    '7228f3a1ffa8d305ed8800136c8447f288d95090cb540b170c52d7acef6be1e6',
    'b4dfa3ef1f41ba19eee0a48679031c7bfb24081f4ef9ff523b42d6cec4e543b3',
]);

const VERIFIED_STATUSES = new Set(['verified-full', 'verified-boundary-only']);

const NODE_TYPES = new Set([
    'sequence', 'empty', 'record', 'opaqueRecord', 'choice', 'conditional',
    'optional', 'repeat', 'repeatGroup', 'textBody', 'continuation', 'prefix',
    'suffix', 'marker', 'formatChoice', 'preprocessorGuard',
]);

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stableId(prefix, value) {
    return `${prefix}:${sha256(Buffer.from(canonicalJson(value), 'utf8')).slice(0, 24)}`;
}

function requireContract(condition, message) {
    if (!condition) throw new Error(message);
}

function nodeChildren(node) {
    if (node?.type === 'sequence' || node?.type === 'repeatGroup') return node.nodes || [];
    if (node?.type === 'choice') return node.branches || [];
    if (node?.type === 'conditional') {
        return [node.thenNode, node.elseNode].filter(Boolean);
    }
    if (['optional', 'repeat', 'prefix', 'suffix', 'marker', 'continuation',
        'formatChoice', 'preprocessorGuard'].includes(node?.type)) {
        return node.node ? [node.node] : [];
    }
    return [];
}

function validateNode(node, profileId, status, seenIds) {
    requireContract(node && typeof node === 'object', 'Grammar node is invalid');
    requireContract(/^structure-node:[0-9a-f]{24}$/.test(String(node.nodeId || '')),
        'Grammar node ID is invalid');
    requireContract(!seenIds.has(node.nodeId), `Duplicate grammar node ID: ${node.nodeId}`);
    requireContract(NODE_TYPES.has(node.type), `Grammar node type is unsupported: ${node.type}`);
    seenIds.add(node.nodeId);
    requireContract(node.sourceProfileId === profileId, 'Grammar node profile identity changed');
    requireContract(node.verificationStatus === status, 'Grammar node verification status changed');
    requireContract(Array.isArray(node.evidenceIds) && Array.isArray(node.locations) &&
        node.evidenceIds.length === node.locations.length,
    'Grammar node evidence mapping is incomplete');
    for (let index = 0; index < node.locations.length; index++) {
        const location = node.locations[index];
        requireContract(location && typeof node.evidenceIds[index] === 'string' &&
            node.evidenceIds[index] && location.evidenceId === node.evidenceIds[index] &&
            typeof location.manualId === 'string' &&
            Number.isInteger(location.page) && location.page >= 1 &&
            /^[0-9a-f]{64}$/.test(String(location.evidenceTextSha256 || '')) &&
            /^[0-9a-f]{64}$/.test(String(location.quoteSha256 || '')),
        'Grammar node evidence location is invalid');
    }
    const identity = { ...node };
    delete identity.nodeId;
    requireContract(node.nodeId === stableId('structure-node', identity),
        `Grammar node content hash changed: ${node.nodeId}`);
    if (node.type === 'record' && status === 'verified-full') {
        requireContract(node.geometryRef && node.geometryRef.kind !== 'none',
            `Verified-full record lacks geometry: ${node.nodeId}`);
    }
    let nodes = 1;
    let records = node.type === 'record' || node.type === 'opaqueRecord' ? 1 : 0;
    for (const child of nodeChildren(node)) {
        const childCounts = validateNode(child, profileId, status, seenIds);
        nodes += childCounts.nodes;
        records += childCounts.records;
    }
    return { nodes, records };
}

function validateGrammar(grammar) {
    requireContract(grammar && /^structure-grammar:[0-9a-f]{24}$/.test(
        String(grammar.grammarId || '')),
    'Grammar ID is invalid');
    requireContract(/^\*[A-Z0-9_/-]+$/.test(String(grammar.keyword || '')),
        'Grammar keyword is invalid');
    requireContract(EXPECTED_SOURCE_PROFILES.has(grammar.sourceProfileId),
        'Grammar source profile is not packaged');
    requireContract(VERIFIED_STATUSES.has(grammar.verificationStatus),
        'Unverified grammar entered a shard');
    requireContract(grammar.repairPolicy?.automatic === false,
        'Automatic structure mutation is forbidden');
    if (grammar.verificationStatus === 'verified-boundary-only') {
        requireContract(grammar.repairPolicy?.uniqueRepairEligible === false,
            'Boundary grammar authorized a unique repair');
    }
    const seenIds = new Set();
    const counts = validateNode(
        grammar.root,
        grammar.sourceProfileId,
        grammar.verificationStatus,
        seenIds,
    );
    for (const prefix of grammar.prefixes || []) {
        const prefixCounts = validateNode(prefix.node, grammar.sourceProfileId, 'verified-full', seenIds);
        counts.nodes += prefixCounts.nodes;
        counts.records += prefixCounts.records;
    }
    for (const suffix of grammar.suffixes || []) {
        const suffixCounts = validateNode(suffix.node, grammar.sourceProfileId, 'verified-full', seenIds);
        counts.nodes += suffixCounts.nodes;
        counts.records += suffixCounts.records;
    }
    const identity = { ...grammar };
    delete identity.grammarId;
    requireContract(grammar.grammarId === stableId('structure-grammar', identity),
        `Grammar content hash changed: ${grammar.grammarId}`);
    return counts;
}

module.exports = { validateGrammar };
