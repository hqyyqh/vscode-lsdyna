'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    buildProjectIndex,
} = require('../../../out/core/project/projectIndexer');
const {
    analyzeReference,
    buildProjectReferenceIndex,
} = require('../../../out/core/references/projectReferenceIndex');
const {
    buildReferenceNavigation,
} = require('../../../out/core/references/referenceNavigation');
const {
    diffSnapshots,
    normalizeRelativePath,
    snapshotDirectory,
} = require("../../support/editor-safety/fileOracle");

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'Bolt_A_Explicit');
const ROOT_DECK = path.join(FIXTURE_ROOT, 'mainboltaexpl.k');
const EXPECTED_DECK_TREE_SHA256 = '9c9e6fdc9c42275edd45058335473f3ffcc000bf6f569ca95e9beed94a9e170f';
const EXPECTED_PROJECT_FILES = [
    'bolted_connection_a.k',
    'control_explicit.k',
    'includes.k',
    'mainboltaexpl.k',
    'submodels/loading/prescribed_motion.k',
    'submodels/material_props.k',
];

function relativeToFixture(filePath) {
    return normalizeRelativePath(path.relative(FIXTURE_ROOT, filePath));
}

describe('release regression: real DYNAmore deck remains read-only', function () {
    this.timeout(15_000);

    it('indexes the fixed-format Include closure without rewriting source or inventing missing targets', async () => {
        const before = await snapshotDirectory(FIXTURE_ROOT, {
            fileFilter: relativePath => /\.k$/i.test(relativePath),
        });
        assert.deepEqual(before.summary, {
            fileCount: 6,
            totalBytes: 279_574,
            treeSha256: EXPECTED_DECK_TREE_SHA256,
        });

        const provenance = fs.readFileSync(ROOT_DECK, 'utf8');
        assert.ok(provenance.includes('Example provided by Dr. Nils Karajan'));
        assert.ok(provenance.includes('tested with LS-DYNA R9.2 with double precision'));

        const snapshot = await buildProjectIndex(ROOT_DECK);
        const referenceIndex = buildProjectReferenceIndex(snapshot);

        const after = await snapshotDirectory(FIXTURE_ROOT, {
            fileFilter: relativePath => /\.k$/i.test(relativePath),
        });
        assert.deepEqual(
            diffSnapshots(before, after),
            { clean: true, added: [], removed: [], modified: [] },
            'read-only project indexing changed the real deck fixture',
        );

        assert.deepEqual(
            snapshot.files.map(relativeToFixture).sort(),
            EXPECTED_PROJECT_FILES,
        );
        assert.deepEqual(snapshot.cycles, []);
        assert.equal(snapshot.graph.includeOccurrences.length, 7);
        assert.deepEqual(
            snapshot.missingFiles.map(item => ({
                fileName: item.fileName,
                fromFile: relativeToFixture(item.fromFile),
                candidates: item.candidatePaths.map(relativeToFixture),
            })),
            [{
                fileName: 'missing_geometry.k',
                fromFile: 'mainboltaexpl.k',
                candidates: [
                    'missing_geometry.k',
                    'submodels/missing_geometry.k',
                ],
            }],
        );

        for (const keyword of ['PART', 'MAT_ELASTIC', 'SECTION_SOLID', 'DEFINE_CURVE']) {
            assert.ok(snapshot.keywordMap.has(keyword), `real deck lost ${keyword} from the project index`);
        }
        assert.deepEqual(referenceIndex.completenessReasons, ['missing-include']);
        assert.deepEqual(
            [...referenceIndex.parameterContextsByFile.values()]
                .flat()
                .map(context => context.inputFormatMode),
            Array(7).fill('standard'),
        );

        const includeContext = referenceIndex.parameterContextsByFile
            .get(path.join(FIXTURE_ROOT, 'includes.k'))[0];
        assert.equal(includeContext.initialBindings.get('tEnd').rawValue, '5.0');
        assert.equal(includeContext.initialBindings.get('bltForce').rawValue, '28.8');

        const knownMaterial = analyzeReference(
            referenceIndex,
            { kind: 'numeric', id: 1, raw: '1', isSignedSwitch: false },
            ['material'],
            { projectScoped: true },
        );
        const knownNavigation = buildReferenceNavigation(knownMaterial);
        assert.equal(knownNavigation.state, 'out-of-closure');
        assert.equal(knownNavigation.candidates.length, 1);
        assert.equal(relativeToFixture(knownNavigation.candidates[0].filePath), 'submodels/material_props.k');

        const unknownMaterial = analyzeReference(
            referenceIndex,
            { kind: 'numeric', id: 999_999, raw: '999999', isSignedSwitch: false },
            ['material'],
            { projectScoped: true },
        );
        assert.equal(unknownMaterial.state, 'uncertain');
        assert.deepEqual(unknownMaterial.definitions, []);
        assert.ok(unknownMaterial.reasons.includes('missing-include'));
        assert.equal(buildReferenceNavigation(unknownMaterial).state, 'out-of-closure');
    });
});
