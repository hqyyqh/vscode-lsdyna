'use strict';

const path = require('path');

function normalizeMainDeckContextKey(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function projectRootFile(project) {
    return project && (
        project.rootFile ||
        project.snapshot && project.snapshot.rootFile
    ) || '';
}

function sortProjectsByRoot(projects) {
    return [...projects].sort((left, right) =>
        normalizeMainDeckContextKey(projectRootFile(left))
            .localeCompare(normalizeMainDeckContextKey(projectRootFile(right)))
    );
}

function createMainDeckContextSelector() {
    const selectedRootByDocument = new Map();

    function resolve(documentPath, {
        exactProject = null,
        containingProjects = [],
    } = {}) {
        if (!documentPath) {
            return { state: 'unavailable', rootFile: null, project: null, candidates: [] };
        }
        const documentKey = normalizeMainDeckContextKey(documentPath);
        if (exactProject) {
            selectedRootByDocument.delete(documentKey);
            return {
                state: 'exact',
                rootFile: projectRootFile(exactProject),
                project: exactProject,
                candidates: [exactProject],
            };
        }

        const candidates = sortProjectsByRoot(
            (containingProjects || []).filter(project => projectRootFile(project))
        );
        if (candidates.length === 0) {
            selectedRootByDocument.delete(documentKey);
            return { state: 'unavailable', rootFile: null, project: null, candidates: [] };
        }
        if (candidates.length === 1) {
            selectedRootByDocument.delete(documentKey);
            return {
                state: 'unique',
                rootFile: projectRootFile(candidates[0]),
                project: candidates[0],
                candidates,
            };
        }

        const selectedRootKey = selectedRootByDocument.get(documentKey);
        if (selectedRootKey) {
            const selectedProject = candidates.find(project =>
                normalizeMainDeckContextKey(projectRootFile(project)) === selectedRootKey
            );
            if (selectedProject) {
                return {
                    state: 'selected',
                    rootFile: projectRootFile(selectedProject),
                    project: selectedProject,
                    candidates,
                };
            }
            selectedRootByDocument.delete(documentKey);
        }

        return {
            state: 'ambiguous',
            rootFile: null,
            project: null,
            candidates,
        };
    }

    function select(documentPath, rootFile, containingProjects = []) {
        if (!documentPath || !rootFile) return false;
        const candidates = sortProjectsByRoot(
            (containingProjects || []).filter(project => projectRootFile(project))
        );
        if (candidates.length < 2) return false;
        const rootKey = normalizeMainDeckContextKey(rootFile);
        if (!candidates.some(project =>
            normalizeMainDeckContextKey(projectRootFile(project)) === rootKey
        )) {
            return false;
        }
        selectedRootByDocument.set(normalizeMainDeckContextKey(documentPath), rootKey);
        return true;
    }

    function clearDocument(documentPath) {
        if (!documentPath) return false;
        return selectedRootByDocument.delete(normalizeMainDeckContextKey(documentPath));
    }

    function clearRoot(rootFile) {
        if (!rootFile) return 0;
        const rootKey = normalizeMainDeckContextKey(rootFile);
        let cleared = 0;
        for (const [documentKey, selectedRootKey] of selectedRootByDocument) {
            if (selectedRootKey !== rootKey) continue;
            selectedRootByDocument.delete(documentKey);
            cleared += 1;
        }
        return cleared;
    }

    function clearAll() {
        selectedRootByDocument.clear();
    }

    return {
        resolve,
        select,
        clearDocument,
        clearRoot,
        clearAll,
    };
}

module.exports = {
    createMainDeckContextSelector,
    normalizeMainDeckContextKey,
};

export {};
