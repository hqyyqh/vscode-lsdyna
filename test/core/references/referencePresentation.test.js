const assert = require('assert');
const path = require('path');
const {
    buildReferencePresentation,
    candidatePreviewMode,
    normalizeFilePathKey,
} = require('../../../out/core/references/referencePresentation');

describe('referencePresentation', () => {
    const currentFile = path.resolve('model', 'main.k');

    it('presents an exact current-file curve as a confirmed visual candidate', () => {
        const definition = {
            kind: 'curve',
            filePath: currentFile,
            startLine: 4,
            points: [{ x: 0, y: 1 }, { x: 1, y: 2 }],
        };
        const presentation = buildReferencePresentation({
            state: 'exact',
            definitions: [definition],
            reasons: [],
        }, { documentPath: currentFile });

        assert.equal(presentation.bindingState, 'exact');
        assert.equal(presentation.candidates[0].origin, 'current-file');
        assert.equal(presentation.candidates[0].relation, 'confirmed-match');
        assert.equal(presentation.candidates[0].previewMode, 'visual');
        assert.equal(presentation.candidates[0].navigable, true);
    });

    it('keeps an uncertain current-file candidate inspectable and offers project coverage', () => {
        const pathVariant = process.platform === 'win32'
            ? currentFile.toUpperCase().replace(/\\/g, '/')
            : currentFile;
        const presentation = buildReferencePresentation({
            state: 'uncertain',
            definitions: [{ kind: 'curve', filePath: pathVariant, startLine: 0, points: [] }],
            reasons: ['project-scan-unavailable'],
        }, { documentPath: currentFile });

        assert.equal(presentation.candidates[0].origin, 'current-file');
        assert.equal(presentation.candidates[0].relation, 'possible-match');
        assert.equal(presentation.showProjectScanAction, true);
        assert.equal(presentation.projectCoverageAvailable, false);
    });

    it('uses summary mode for incomplete and function curves', () => {
        const incomplete = {
            kind: 'curve',
            dataCompleteness: { state: 'partial', reasons: ['parameterized-data'] },
        };
        assert.equal(candidatePreviewMode(incomplete), 'summary');
        assert.equal(candidatePreviewMode({ kind: 'functionCurve' }), 'summary');
        assert.equal(candidatePreviewMode({ kind: 'curve', points: [] }), 'summary');

        const presentation = buildReferencePresentation({
            state: 'uncertain',
            definitions: [incomplete],
            reasons: [],
        });
        assert.deepEqual(
            presentation.candidates[0].previewBlockedReasons,
            ['parameterized-data']
        );
    });

    it('keeps generic definitions location-only and rejects invalid navigation targets', () => {
        const presentation = buildReferencePresentation({
            state: 'uncertain',
            definitions: [{ kind: 'generic', filePath: currentFile, startLine: -1 }],
            reasons: ['project-root-ambiguous'],
        }, { documentPath: currentFile });

        assert.equal(presentation.candidates[0].previewMode, 'location-only');
        assert.equal(presentation.candidates[0].navigable, false);
        assert.equal(presentation.showProjectScanAction, false);
    });

    it('normalizes equivalent Windows path spellings', () => {
        if (process.platform !== 'win32') return;
        assert.equal(
            normalizeFilePathKey('C:/Model/MAIN.k'),
            normalizeFilePathKey('c:\\model\\main.k')
        );
    });
});
