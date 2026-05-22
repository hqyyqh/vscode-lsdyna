'use strict';

class ProjectGraph {
    constructor() {
        this.children = new Map();
        this.parents = new Map();
        this.missingFiles = [];
        this.cycles = [];
    }

    addFile(filePath) {
        if (!this.children.has(filePath)) this.children.set(filePath, []);
        if (!this.parents.has(filePath)) this.parents.set(filePath, []);
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
    }

    addMissingFile(record) {
        this.missingFiles.push(record);
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

    toTree(rootFile, ancestry = []) {
        if (ancestry.includes(rootFile)) {
            return {
                filePath: rootFile,
                children: [],
            };
        }

        return {
            filePath: rootFile,
            children: this.getChildren(rootFile).map(childFile =>
                this.toTree(childFile, [...ancestry, rootFile])
            ),
        };
    }
}

module.exports = {
    ProjectGraph,
};
