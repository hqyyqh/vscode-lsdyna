'use strict';

const assert = require('assert');
const path = require('path');

describe('findAffectedProjectRoots', () => {
    it('matches newly created files against missing dependency candidates', () => {
        const { findAffectedProjectRoots } = require('../../../src/core/incremental/fileInvalidation');
        const rootFile = path.resolve('project', 'main.k');
        const createdFile = path.resolve('project', 'search', 'missing.key');

        assert.deepStrictEqual(findAffectedProjectRoots(createdFile, [{
            rootFile,
            trackedFiles: [rootFile],
            missingDependencyPaths: [createdFile],
        }]), [rootFile]);
        assert.deepStrictEqual(findAffectedProjectRoots(createdFile, [{
            rootFile,
            trackedFiles: [rootFile],
        }]), []);
    });

    it('finds all project roots whose manifest tracks the changed file', () => {
        const { findAffectedProjectRoots } = require('../../../src/core/incremental/fileInvalidation');
        const changedFile = path.resolve('project', 'shared.key');
        const rootA = path.resolve('project', 'root-a.k');
        const rootB = path.resolve('project', 'root-b.k');
        const rootC = path.resolve('project', 'root-c.k');

        const affectedRoots = findAffectedProjectRoots(changedFile, [
            {
                rootFile: rootA,
                trackedFiles: [rootA, changedFile],
            },
            {
                rootFile: rootB,
                trackedFiles: [rootB, changedFile],
            },
            {
                rootFile: rootC,
                trackedFiles: [rootC],
            },
        ]);

        assert.deepEqual(affectedRoots, [rootA, rootB]);
    });

    it('matches changed file aliases case-insensitively on windows-style paths', () => {
        const { findAffectedProjectRoots } = require('../../../src/core/incremental/fileInvalidation');
        const rootFile = path.resolve('project', 'main.k');
        const trackedFile = path.resolve('project', 'Sub', 'PART.KEY');
        const changedAlias = `${path.dirname(trackedFile)}${path.sep}.${path.sep}${path.basename(trackedFile).toLowerCase()}`;

        const affectedRoots = findAffectedProjectRoots(changedAlias, [
            {
                rootFile,
                trackedFiles: [rootFile, trackedFile],
            },
        ]);

        assert.deepEqual(affectedRoots, [rootFile]);
    });
});
