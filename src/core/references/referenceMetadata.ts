// Share immutable reference metadata while retaining the public occurrence shape.
const metadataFields = ['targetKinds', 'targetDefinitions', 'targetKeywords',
    'operationalProjection', 'resolution'];
function createReferenceMetadataInterner() {
    const values = new Map();
    const objects = new WeakMap();
    function intern(value) {
        if (!value || typeof value !== 'object') return value;
        if (objects.has(value)) return objects.get(value);
        const key = JSON.stringify(value);
        const shared = values.get(key) || value;
        if (!values.has(key)) values.set(key, value);
        objects.set(value, shared);
        return shared;
    }
    return (record) => {
        for (const owner of [record, record.semantic, record.referenceValue]) {
            if (!owner) continue;
            for (const field of metadataFields) {
                if (owner[field]) owner[field] = intern(owner[field]);
            }
        }
        return record;
    };
}
async function restoreReferenceMetadata(indexes) {
    const intern = createReferenceMetadataInterner();
    let lastYield = Date.now();
    for (const index of indexes) {
        for (const field of ['referenceOccurrences', 'valueDomainOccurrences']) {
            for (const record of index?.registryReferences?.[field] || []) {
                intern(record);
                if (Date.now() - lastYield >= 25) {
                    await new Promise(resolve => setImmediate(resolve));
                    lastYield = Date.now();
                }
            }
        }
    }
}
module.exports = { createReferenceMetadataInterner, restoreReferenceMetadata };
export {};
