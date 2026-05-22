'use strict';

class ProjectGraph {
    constructor() {
        this.children = new Map();
        this.includeEntries = new Map();
        this.parents = new Map();
        this.missingFiles = [];
        this.cycles = [];
    }

    addFile(filePath) {
        if (!this.children.has(filePath)) this.children.set(filePath, []);
        if (!this.includeEntries.has(filePath)) this.includeEntries.set(filePath, []);
        if (!this.parents.has(filePath)) this.parents.set(filePath, []);
    }

    addIncludeEntry(fromFile, entry) {
        this.addFile(fromFile);
        const entries = this.includeEntries.get(fromFile);
        const exists = entries.some(candidate =>
            candidate.filePath === entry.filePath && Boolean(candidate.missing) === Boolean(entry.missing)
        );
        if (!exists) {
            entries.push(entry);
        }
    }

    addIncludeEdge(fromFile, toFile) {
        this.addFile(fromFile);
        this.addFile(toFile);

        if (!this.children.get(fromFile).includes(toFile)) {
            this.children.get(fromFile).push(toFile);
        }
        if (!this.parents.get(toFile).includes(fromFile)) {
            this.parents.get(toFile).push(fromFile);
        }

        this.addIncludeEntry(fromFile, { filePath: toFile });
    }

    addMissingFile(record) {
        this.missingFiles.push(record);
        if (record.fromFile && record.filePath) {
            this.addIncludeEntry(record.fromFile, {
                filePath: record.filePath,
                fileName: record.fileName,
                missing: true,
            });
        }
    }

    addCycle(record) {
        this.cycles.push(record);
    }

    getChildren(filePath) {
        return [...(this.children.get(filePath) || [])];
    }

    getParents(filePath) {
        return [...(this.parents.get(filePath) || [])];
    }

    getIncludeEntries(filePath) {
        return [...(this.includeEntries.get(filePath) || [])];
    }

    toTree(rootFile, ancestry = []) {
        if (ancestry.includes(rootFile)) {
            return {
                filePath: rootFile,
                children: [],
            };
        }

        return {
            filePath: rootFile,
            children: this.getIncludeEntries(rootFile).map(entry => (
                entry.missing
                    ? { ...entry, children: [] }
                    : this.toTree(entry.filePath, [...ancestry, rootFile])
            )),
        };
    }
}

module.exports = {
    ProjectGraph,
};
