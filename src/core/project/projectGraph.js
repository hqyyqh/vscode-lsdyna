'use strict';

/**
 * @fileoverview Graph data structure representing include file dependencies in LS-DYNA projects.
 * @module core/project/projectGraph
 * 
 * This module defines the ProjectGraph class which tracks the parent-child relationships between 
 * files (via *INCLUDE directives), identifies missing file dependencies, and records circular loops (cycles).
 * It supports conversion to tree structures for UI rendering and serialization to JSON for caching.
 * 
 * Role in System: Central dependency registry used by diagnostics, tree views, and index managers
 * to understand the file-to-file topology.
 */

/**
 * @typedef {Object} IncludeEntryNode
 * @property {string} filePath - Absolute path to the resolved file.
 * @property {string} [fileName] - Raw name text as declared in the *INCLUDE statement.
 * @property {boolean} [missing] - True if the file could not be found.
 * @property {number} [lineIndex] - 0-indexed line number of the include statement.
 * @property {number} [startChar] - 0-indexed starting character column.
 * @property {number} [endChar] - 0-indexed ending character column.
 */

/**
 * @typedef {Object} GraphTreeNode
 * @property {string} filePath - Absolute path of this tree node.
 * @property {GraphTreeNode[]} children - Nested child include nodes.
 * @property {boolean} [cycle] - True if this node closes a dependency loop.
 * @property {boolean} [missing] - True if this node represents a missing file.
 * @property {string} [fileName] - Raw filename string if missing.
 * @property {number} [lineIndex] - 0-indexed line number of include statement.
 * @property {number} [startChar] - 0-indexed starting character column.
 * @property {number} [endChar] - 0-indexed ending character column.
 */

/**
 * @typedef {Object} MissingFileRecord
 * @property {string} fromFile - Path to the file containing the include statement.
 * @property {string} filePath - Calculated absolute path where the file was expected.
 * @property {string} fileName - Raw filename string written in the deck.
 * @property {number} lineIndex - 0-indexed line number of the statement.
 * @property {number} startChar - 0-indexed starting character column.
 * @property {number} endChar - 0-indexed ending character column.
 */

/**
 * @typedef {Object} CycleRecord
 * @property {string} fromFile - Path to the file containing the looping include statement.
 * @property {string[]} path - Ordered array of file paths representing the loop.
 * @property {number} lineIndex - 0-indexed line number of the statement causing the loop.
 * @property {number} startChar - 0-indexed starting character column.
 * @property {number} endChar - 0-indexed ending character column.
 */

/**
 * Represeents the complete inclusion directed dependency graph of a workspace project.
 */
class ProjectGraph {
    /**
     * Creates an empty ProjectGraph instance.
     */
    constructor() {
        /**
         * Maps a file path to its child (included) files list.
         * @type {Map<string, string[]>}
         */
        this.children = new Map();

        /**
         * Maps a file path to detailed include entry structures.
         * @type {Map<string, IncludeEntryNode[]>}
         */
        this.includeEntries = new Map();

        /**
         * Maps a file path to its parent (including) files list.
         * @type {Map<string, string[]>}
         */
        this.parents = new Map();

        /**
         * List of missing include file declarations.
         * @type {MissingFileRecord[]}
         */
        this.missingFiles = [];

        /**
         * List of cyclic import relationships.
         * @type {CycleRecord[]}
         */
        this.cycles = [];
    }

    /**
     * Initializes slots for a file path in graph maps if not present.
     * 
     * @param {string} filePath - Absolute path to the file.
     */
    addFile(filePath) {
        if (!this.children.has(filePath)) this.children.set(filePath, []);
        if (!this.includeEntries.has(filePath)) this.includeEntries.set(filePath, []);
        if (!this.parents.has(filePath)) this.parents.set(filePath, []);
    }

    /**
     * Adds an include statement reference to a file's entries list.
     * 
     * @param {string} fromFile - File containing the include statement.
     * @param {IncludeEntryNode} entry - Detailed include statement node.
     */
    addIncludeEntry(fromFile, entry) {
        this.addFile(fromFile);
        const entries = this.includeEntries.get(fromFile);
        if (entry.missing) {
            entries.push(entry);
            return;
        }
        const exists = entries.some(candidate =>
            candidate.filePath === entry.filePath && Boolean(candidate.missing) === Boolean(entry.missing)
        );
        if (!exists) {
            entries.push(entry);
        }
    }

    /**
     * Adds a resolved inclusion link edge between two files in the graph.
     * 
     * @param {string} fromFile - Parent file.
     * @param {string} toFile - Child file.
     */
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

    /**
     * Registers a missing include file record.
     * 
     * @param {MissingFileRecord} record - Missing details.
     */
    addMissingFile(record) {
        this.missingFiles.push(record);
        if (record.fromFile && record.filePath) {
            this.addIncludeEntry(record.fromFile, {
                filePath: record.filePath,
                fileName: record.fileName,
                missing: true,
                lineIndex: record.lineIndex,
                startChar: record.startChar,
                endChar: record.endChar,
            });
        }
    }

    /**
     * Registers a circular dependency cycle loop.
     * 
     * @param {CycleRecord} record - Cycle details.
     */
    addCycle(record) {
        this.cycles.push(record);
    }

    /**
     * Gets child files directly included by the file.
     * 
     * @param {string} filePath - Absolute path.
     * @returns {string[]} Scanned child paths.
     */
    getChildren(filePath) {
        return [...(this.children.get(filePath) || [])];
    }

    /**
     * Gets parent files directly including the file.
     * 
     * @param {string} filePath - Absolute path.
     * @returns {string[]} Scanned parent paths.
     */
    getParents(filePath) {
        return [...(this.parents.get(filePath) || [])];
    }

    /**
     * Gets detailed include entries for a file.
     * 
     * @param {string} filePath - Absolute path.
     * @returns {IncludeEntryNode[]} Include entries.
     */
    getIncludeEntries(filePath) {
        return [...(this.includeEntries.get(filePath) || [])];
    }

    /**
     * Traverses graph recursively to construct a tree structure starting from the root file.
     * Detects cycle boundaries to prevent infinite loops.
     * 
     * @param {string} rootFile - Path of the root node.
     * @param {string[]} [ancestry=[]] - Array of ancestor paths in the current traversal path.
     * @returns {GraphTreeNode} Resolved tree representation.
     */
    toTree(rootFile, ancestry = []) {
        if (ancestry.includes(rootFile)) {
            return {
                filePath: rootFile,
                children: [],
                cycle: true,
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

    /**
     * Serializes the graph instance to a plain JSON-compatible object.
     * 
     * @returns {Object} Plain object snapshot.
     */
    toJSON() {
        return {
            children: [...this.children.entries()].map(([filePath, childFiles]) => [filePath, [...childFiles]]),
            includeEntries: [...this.includeEntries.entries()].map(([filePath, entries]) => [filePath, [...entries]]),
            parents: [...this.parents.entries()].map(([filePath, parentFiles]) => [filePath, [...parentFiles]]),
            missingFiles: [...this.missingFiles],
            cycles: [...this.cycles],
        };
    }

    /**
     * De-serializes a JSON representation back into a ProjectGraph instance.
     * 
     * @param {Object} [data={}] - Plain data object.
     * @returns {ProjectGraph} A new ProjectGraph instance populated with data.
     */
    static fromJSON(data = {}) {
        const graph = new ProjectGraph();
        graph.children = new Map(data.children || []);
        graph.includeEntries = new Map(data.includeEntries || []);
        graph.parents = new Map(data.parents || []);
        graph.missingFiles = [...(data.missingFiles || [])];
        graph.cycles = [...(data.cycles || [])];
        return graph;
    }
}

module.exports = {
    ProjectGraph,
};
