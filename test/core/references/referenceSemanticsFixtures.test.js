'use strict';

const assert = require('assert');
const path = require('path');

const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { buildProjectIndex } = require('../../../src/core/project/projectIndexer');
const {
    buildProjectReferenceIndex,
    analyzeReference,
} = require('../../../out/core/references/projectReferenceIndex');
const {
    parseFieldReferenceValue,
} = require('../../../out/core/references/fieldReferenceClassifier');

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixtures', 'reference-semantics');

function fixture(name) {
    return path.join(FIXTURE_DIR, name);
}

async function analyzeFixture(name, id = 1001, kinds = ['curve']) {
    const snapshot = await buildProjectIndex(fixture(name));
    const index = buildProjectReferenceIndex(snapshot);
    return {
        snapshot,
        index,
        analysis: analyzeReference(
            index,
            { kind: 'numeric', id, raw: String(id) },
            kinds,
            { projectScoped: true }
        ),
    };
}

describe('official reference-semantics fixtures', () => {
    it('preserves numeric, parameterized definition, point and child-ID states', async () => {
        const numeric = await buildFileIndex(fixture('01_numeric_definitions.k'));
        assert.equal(numeric.referenceDefinitions.curves[0].id, 1001);
        assert.equal(numeric.referenceDefinitions.tables[0].id, 2001);

        const parameterDefinition = await buildFileIndex(fixture('03_parameterized_definition.k'));
        assert.equal(parameterDefinition.referenceDefinitions.curves[0].id, null);
        assert.equal(parameterDefinition.referenceDefinitions.curves[0].idInput.kind, 'parameter');

        const parameterPoints = await buildFileIndex(fixture('04_parameterized_points.k'));
        assert.equal(parameterPoints.referenceDefinitions.curves[0].points[1].xRaw, '&X');
        assert.equal(parameterPoints.referenceDefinitions.curves[0].dataCompleteness.state, 'incomplete');

        const parameterChild = await buildFileIndex(fixture('05_parameterized_table_child.k'));
        assert.equal(parameterChild.referenceDefinitions.tables[0].rows[0].childIdRaw, '&CID');
        assert.equal(parameterChild.referenceDefinitions.tables[0].rows[0].childIdInput.kind, 'parameter');
    });

    it('preserves both parameter reference sign forms', () => {
        const plain = parseFieldReferenceValue('&CID', { allowSignedSwitch: true });
        const signed = parseFieldReferenceValue('-&CID', { allowSignedSwitch: true });

        assert.equal(plain.kind, 'parameter');
        assert.equal(plain.isSignedSwitch, false);
        assert.equal(signed.kind, 'parameter');
        assert.equal(signed.isSignedSwitch, true);
        assert.equal(parseFieldReferenceValue('&A-B', { allowSignedSwitch: true }).parameterName, 'A-B');
    });

    it('applies one numeric IDFOFF while parameterized IDFOFF remains uncertain', async () => {
        const zero = await analyzeFixture('06_transform_idfoff_zero.k');
        const numeric = await analyzeFixture('07_transform_idfoff_numeric.k', 1101);
        const parameter = await analyzeFixture('08_transform_idfoff_parameter.k');
        const unrelated = await analyzeFixture('13_unrelated_offsets.k');

        assert.equal(zero.analysis.state, 'exact');
        assert.equal(unrelated.analysis.state, 'exact');
        assert.equal(numeric.analysis.state, 'exact');
        assert.equal(numeric.analysis.definitions[0].sourceId, 1001);
        assert.equal(numeric.analysis.definitions[0].effectiveId, 1101);
        assert.equal(numeric.analysis.definitions[0].idfoffOffset, 100);
        assert.equal(parameter.analysis.state, 'uncertain');
        assert.ok(parameter.analysis.reasons.includes('transform-offset-unresolved'));
    });

    it('retains repeated source-file occurrences without rescanning the source definition', async () => {
        const { snapshot, analysis } = await analyzeFixture('09_duplicate_occurrences.k');
        const sharedPath = fixture('shared_curve.k');
        const occurrences = snapshot.graph.includeOccurrences.filter(item => item.filePath === sharedPath);

        assert.equal(occurrences.length, 2);
        assert.equal(snapshot.files.filter(filePath => filePath === sharedPath).length, 1);
        assert.equal(analysis.state, 'exact');
        assert.equal(analysis.definitions.length, 1);
        assert.equal(analysis.unresolved.length, 0);
        assert.equal(
            analyzeReference(
                buildProjectReferenceIndex(snapshot),
                { kind: 'numeric', id: 1101, raw: '1101' },
                ['curve'],
                { projectScoped: true }
            ).state,
            'exact'
        );
        const sharedFileAnalysis = analyzeReference(
            buildProjectReferenceIndex(snapshot),
            { kind: 'numeric', id: 1001, raw: '1001' },
            ['curve'],
            {
                projectScoped: true,
                documentPath: sharedPath,
                lineIndex: 3,
            }
        );
        assert.equal(sharedFileAnalysis.state, 'uncertain');
        assert.ok(sharedFileAnalysis.reasons.includes('transform-occurrence-ambiguous'));
    });

    it('reports nested transforms and PARAMETER_TYPE combinations as uncertain', async () => {
        const nested = await analyzeFixture('10_nested_transform.k');
        const parameterType = await analyzeFixture('12_parameter_type_transform.k');

        assert.equal(nested.analysis.state, 'uncertain');
        assert.ok(nested.analysis.reasons.includes('nested-transform-unsupported'));
        assert.equal(parameterType.analysis.state, 'uncertain');
        assert.ok(parameterType.analysis.reasons.includes('parameter-type-transform-unsupported'));
    });

    it('does not report missing when a parameterized include leaves the project tree incomplete', async () => {
        const { analysis } = await analyzeFixture('11_parameterized_include.k');

        assert.equal(analysis.state, 'uncertain');
        assert.ok(analysis.reasons.includes('parameterized-include-unresolved'));
        assert.ok(analysis.reasons.includes('missing-include'));
    });

    it('marks a local-only index incomplete when project scope is unavailable', async () => {
        const filePath = fixture('14_project_scan_unavailable.k');
        const fileIndex = await buildFileIndex(filePath);
        const index = buildProjectReferenceIndex({
            rootFile: filePath,
            files: [filePath],
            fileIndexes: new Map([[filePath, fileIndex]]),
        });
        const analysis = analyzeReference(
            index,
            { kind: 'numeric', id: 1001, raw: '1001' },
            ['curve'],
            { projectScoped: false }
        );

        assert.equal(analysis.state, 'uncertain');
        assert.ok(analysis.reasons.includes('project-scan-unavailable'));
        assert.equal(analysis.definitions.length, 1);
    });

    it('isolates multiple main decks and ignores unreferenced versions in one directory', async () => {
        const directory = fixture('multi-root');
        const rootA = path.join(directory, 'condition_a.k');
        const rootB = path.join(directory, 'condition_b.k');
        const sharedFile = path.join(directory, 'shared_reference.k');
        const oldRoot = path.join(directory, 'condition_a_old_20260727.k');
        const oldCurve = path.join(directory, 'old_curve.k');

        async function analyzeRoot(rootFile, expectedId) {
            const snapshot = await buildProjectIndex(rootFile);
            const index = buildProjectReferenceIndex(snapshot);
            const analysis = analyzeReference(
                index,
                {
                    kind: 'parameter',
                    raw: '&CID',
                    parameterName: 'CID',
                    isSignedSwitch: false,
                },
                ['curve'],
                {
                    projectScoped: true,
                    documentPath: sharedFile,
                    lineIndex: 2,
                }
            );
            assert.equal(analysis.state, 'exact');
            assert.equal(analysis.id, expectedId);
            return snapshot;
        }

        const snapshotA = await analyzeRoot(rootA, 1001);
        const snapshotB = await analyzeRoot(rootB, 2002);

        assert.ok(!snapshotA.files.includes(rootB));
        assert.ok(!snapshotA.files.includes(oldRoot));
        assert.ok(!snapshotA.files.includes(oldCurve));
        assert.ok(!snapshotB.files.includes(rootA));
        assert.ok(!snapshotB.files.includes(oldRoot));
        assert.ok(!snapshotB.files.includes(oldCurve));
    });
});
