'use strict';

function emptyReferenceIndex(files = []) {
    return {
        curvesById: new Map(),
        tablesById: new Map(),
        files,
    };
}

function getFileIndex(fileIndexes, filePath) {
    if (!fileIndexes) {
        return null;
    }
    if (fileIndexes instanceof Map) {
        return fileIndexes.get(filePath) || null;
    }
    return fileIndexes[filePath] || null;
}

function addDefinition(targetMap, definition) {
    if (!definition || !Number.isFinite(definition.id)) {
        return;
    }
    if (!targetMap.has(definition.id)) {
        targetMap.set(definition.id, []);
    }
    targetMap.get(definition.id).push(definition);
}

function buildProjectReferenceIndex(snapshot) {
    if (!snapshot) {
        return emptyReferenceIndex();
    }
    const fileIndexes = snapshot.fileIndexes || new Map();
    const files = Array.isArray(snapshot.files)
        ? snapshot.files.slice()
        : fileIndexes instanceof Map
            ? [...fileIndexes.keys()]
            : Object.keys(fileIndexes);
    const index = emptyReferenceIndex(files);

    for (const filePath of files) {
        const fileIndex = getFileIndex(fileIndexes, filePath);
        const definitions = fileIndex && fileIndex.referenceDefinitions;
        if (!definitions) {
            continue;
        }
        for (const curve of definitions.curves || []) {
            addDefinition(index.curvesById, curve);
        }
        for (const table of definitions.tables || []) {
            addDefinition(index.tablesById, table);
        }
    }

    return index;
}

function resolveReferenceDefinitions(referenceIndex, id, targetKinds) {
    if (!referenceIndex || !Number.isFinite(id)) {
        return [];
    }
    const kinds = new Set(targetKinds || []);
    const definitions = [];
    if (kinds.has('curve') || kinds.has('functionCurve')) {
        const curves = referenceIndex.curvesById && referenceIndex.curvesById.get(id);
        if (curves) {
            definitions.push(...curves);
        }
    }
    if (kinds.has('table')) {
        const tables = referenceIndex.tablesById && referenceIndex.tablesById.get(id);
        if (tables) {
            definitions.push(...tables);
        }
    }
    return definitions;
}

function attachResolvedTableChildren(definition, referenceIndex) {
    if (!definition || definition.kind !== 'table') {
        return definition;
    }
    const resolvedChildren = new Map();
    for (const row of definition.rows || []) {
        if (!Number.isFinite(row.childId)) {
            continue;
        }
        const targetKinds = row.childKind === 'table' ? ['table'] : ['curve'];
        const matches = resolveReferenceDefinitions(referenceIndex, row.childId, targetKinds);
        if (matches.length > 0) {
            resolvedChildren.set(row.childId, matches);
        }
    }
    return {
        ...definition,
        resolvedChildren,
    };
}

module.exports = {
    buildProjectReferenceIndex,
    resolveReferenceDefinitions,
    attachResolvedTableChildren,
};

export {};
