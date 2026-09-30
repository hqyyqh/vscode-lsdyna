const assert = require('assert');
const { vscodeMock } = require('../../helpers');
const i18n = require('../../../src/core/i18n');
const { buildReferenceHoverSection, buildDefinitionHoverSection } = require('../../../out/core/references/fieldReferenceHover');

describe('fieldReferenceHover', () => {
    afterEach(() => {
        i18n.updateLanguage();
    });

    it('renders curve preview, signed switch note and definition link', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 1001,
            raw: '-1001',
            isSignedSwitch: true,
            definitions: [{
                kind: 'curve',
                id: 1001,
                keyword: '*DEFINE_CURVE',
                filePath: 'C:/model/main.k',
                startLine: 10,
                endLine: 13,
                points: [
                    { x: 0, y: 400, xRaw: '0', yRaw: '400', lineIndex: 12 },
                    { x: 0.1, y: 450, xRaw: '0.1', yRaw: '450', lineIndex: 13 },
                ],
            }],
        });

        assert.ok(section.includes('LCSS reference'));
        assert.ok(section.includes(i18n.get('negativeSwitchStripped')));
        assert.ok(section.includes('*DEFINE\\_CURVE'));
        assert.ok(section.includes('data:image/svg+xml;base64,'));
        assert.ok(section.includes('command:extension.openLsdynaReferenceDefinition'));
        assert.ok(!section.includes('Current-file preview'));
        assert.ok(!section.includes('Reference not unique'));
    });

    it('renders a compact unscanned-project status rather than a false missing result', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 1001,
            definitions: [],
            needsProjectScan: true,
        });

        assert.ok(section.includes('Project not scanned'));
        assert.ok(!section.includes('No curve or table definition was found'));
        assert.ok(section.includes('Scan Include Tree'));
        assert.ok(!section.includes('insufficient to resolve'));
    });

    it('offers an explicitly labeled workspace text fallback without serializing semantic claims', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            referenceValue: { kind: 'numeric', id: 1001, raw: '1001' },
            analysis: {
                state: 'uncertain',
                id: 1001,
                definitions: [],
                reasons: ['project-scan-unavailable'],
            },
            workspaceSearchContext: {
                filePath: 'C:/model/main.k',
                lineIndex: 4,
                character: 20,
                documentVersion: 7,
                projectRootFile: 'C:/model/root.k',
            },
        });

        assert.ok(section.includes('Search workspace text for ID 1001'));
        assert.ok(section.includes('Text matches only'));
        const match = section.match(
            /command:extension\.searchLsdynaReferenceInWorkspace\?([^\s)]+)/
        );
        assert.ok(match);
        const [payload] = JSON.parse(decodeURIComponent(match[1]));
        assert.deepEqual(payload, {
            filePath: 'C:/model/main.k',
            lineIndex: 4,
            character: 20,
            documentVersion: 7,
            projectRootFile: 'C:/model/root.k',
        });
        assert.equal(Object.hasOwn(payload, 'id'), false);
        assert.equal(Object.hasOwn(payload, 'targetKinds'), false);
    });

    it('does not offer workspace search for unresolved parameters or known candidates', () => {
        const context = {
            filePath: 'C:/model/main.k',
            lineIndex: 4,
            character: 20,
            documentVersion: 7,
        };
        const unresolved = buildReferenceHoverSection({
            fieldName: 'LCSS',
            referenceValue: { kind: 'parameter', raw: '&CID', parameterName: 'CID' },
            analysis: {
                state: 'uncertain',
                definitions: [],
                reasons: ['parameter-unresolved'],
            },
            workspaceSearchContext: context,
        });
        assert.ok(!unresolved.includes('searchLsdynaReferenceInWorkspace'));

        const known = buildReferenceHoverSection({
            fieldName: 'LCSS',
            referenceValue: { kind: 'numeric', id: 1001, raw: '1001' },
            analysis: {
                state: 'uncertain',
                id: 1001,
                definitions: [{
                    kind: 'curve',
                    id: 1001,
                    keyword: '*DEFINE_CURVE',
                    filePath: 'C:/model/curves.k',
                    startLine: 10,
                }],
                reasons: ['project-scan-unavailable'],
            },
            workspaceSearchContext: context,
        });
        assert.ok(!known.includes('searchLsdynaReferenceInWorkspace'));
    });

    it('renders generic DEFINE target locations without curve or table previews', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'CHM',
            id: 7001,
            definitions: [{
                kind: 'generic',
                id: 7001,
                keyword: '*DEFINE_CPM_CHAMBER',
                filePath: 'C:/model/airbag.k',
                startLine: 10,
                endLine: 12,
            }],
        });

        assert.ok(section.includes('*DEFINE\\_CPM\\_CHAMBER'));
        assert.ok(section.includes('command:extension.openLsdynaReferenceDefinition'));
        assert.ok(!section.includes('data:image/svg+xml;base64,'));
    });

    it('renders a parameter-controlled reference as uncertain using only its raw value', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            referenceValue: {
                kind: 'parameter',
                parameterName: 'CID',
                raw: '&CID',
                isSignedSwitch: false,
            },
            analysis: {
                state: 'uncertain',
                definitions: [],
                reasons: ['parameter-unresolved'],
            },
        });

        assert.ok(section.includes('`&CID`'));
        assert.ok(section.includes('parameter-controlled'));
        assert.ok(!section.includes('No matching curve/table definition'));
        assert.ok(!section.includes('`undefined`'));
    });

    it('renders missing only for a complete zero-match analysis', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            referenceValue: { kind: 'numeric', id: 77, raw: '77' },
            analysis: { state: 'missing', definitions: [], reasons: [] },
        });

        assert.ok(section.includes('Definition not found'));
        assert.ok(section.includes('No curve or table definition was found for ID 77'));
        assert.ok(!section.includes('insufficient to resolve'));
    });

    it('previews a known uncertain current-file candidate without claiming an exact binding', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            referenceValue: { kind: 'numeric', id: 1001, raw: '1001' },
            analysis: {
                state: 'uncertain',
                reasons: ['project-scan-unavailable'],
                definitions: [{
                    kind: 'curve',
                    id: 1001,
                    keyword: '*DEFINE_CURVE',
                    filePath: 'C:/model/main.k',
                    startLine: 10,
                    points: [
                        { x: 0, y: 1, xRaw: '0', yRaw: '1' },
                        { x: 1, y: 2, xRaw: '1', yRaw: '2' },
                    ],
                }],
            },
            documentPath: 'C:/model/main.k',
        });

        const referenceLine = section.split('\n').find(line => line.includes('LCSS reference'));
        assert.ok(referenceLine.includes('Current-file preview'));
        assert.ok(section.includes('*DEFINE\\_CURVE'));
        assert.ok(section.includes('Open candidate definition'));
        assert.ok(section.includes('command:extension.openLsdynaReferenceDefinition'));
        assert.ok(section.includes('data:image/svg+xml;base64,'));
        assert.ok(section.includes('Scan Include Tree'));
        assert.ok(!section.includes('Known candidate definitions'));
        assert.ok(!section.includes('Current-file candidate'));
        assert.ok(!section.includes('insufficient to resolve'));
        assert.ok(!section.includes('No curve or table definition was found'));
    });

    it('hides every curve preview when multiple current-file candidates are known before a scan', () => {
        const definitions = ['a.k', 'b.k'].map((filePath, index) => ({
            kind: 'curve',
            id: 1001,
            keyword: '*DEFINE_CURVE',
            filePath: `C:/model/${filePath}`,
            startLine: 10 + index,
            points: [
                { x: 0, y: 1 + index, xRaw: '0', yRaw: String(1 + index) },
                { x: 1, y: 2 + index, xRaw: '1', yRaw: String(2 + index) },
            ],
        }));
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            referenceValue: { kind: 'numeric', id: 1001, raw: '1001' },
            analysis: {
                state: 'uncertain',
                reasons: ['project-scan-unavailable'],
                definitions,
            },
            documentPath: 'C:/model/main.k',
        });

        assert.ok(section.includes('Reference not unique'));
        assert.ok(section.includes('2 definitions with the same ID'));
        assert.ok(section.includes('a.k'));
        assert.ok(section.includes('b.k'));
        assert.ok(!section.includes('data:image/svg+xml;base64,'));
    });

    it('keeps a local table and its local child inspectable before project scan', () => {
        const childCurve = {
            kind: 'curve',
            id: 1001,
            keyword: '*DEFINE_CURVE',
            filePath: 'C:/model/main.k',
            startLine: 30,
            points: [{ x: 0, y: 1 }, { x: 1, y: 2 }],
        };
        const secondChildCurve = {
            ...childCurve,
            id: 1002,
            startLine: 40,
            points: [{ x: 0, y: 3 }, { x: 1, y: 4 }],
        };
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            referenceValue: { kind: 'numeric', id: 2001, raw: '2001' },
            analysis: {
                state: 'uncertain',
                reasons: ['project-scan-unavailable'],
                definitions: [{
                    kind: 'table',
                    tableType: '2d',
                    id: 2001,
                    keyword: '*DEFINE_TABLE_2D',
                    filePath: 'C:/model/main.k',
                    startLine: 20,
                    rows: [
                        {
                            valueRaw: '0.01',
                            value: 0.01,
                            childIdRaw: '1001',
                            childId: 1001,
                            childKind: 'curve',
                            childAnalysis: {
                                state: 'uncertain',
                                effectiveChildId: 1001,
                                definitions: [childCurve],
                                unresolved: [],
                                reasons: ['project-scan-unavailable'],
                            },
                        },
                        {
                            valueRaw: '0.02',
                            value: 0.02,
                            childIdRaw: '1002',
                            childId: 1002,
                            childKind: 'curve',
                            childAnalysis: {
                                state: 'uncertain',
                                effectiveChildId: 1002,
                                definitions: [secondChildCurve],
                                unresolved: [],
                                reasons: ['project-scan-unavailable'],
                            },
                        },
                    ],
                }],
            },
            documentPath: 'C:/model/main.k',
            tablePreviewContext: {
                key: 'C:/model/main.k:4:LCSS',
                view: 'front',
                filePath: 'C:/model/main.k',
                lineIndex: 4,
                character: 10,
            },
        });

        assert.ok(section.includes('Current-file preview'));
        assert.ok(section.includes('Open candidate definition'));
        assert.ok(section.includes('Open child curve candidate 1'));
        assert.ok(section.includes('Scan Include Tree'));
        assert.ok(section.includes('View:'));
        assert.ok(section.includes('**Front**'));
        assert.ok(section.includes('command:extension.setLsdynaTablePreviewView'));
        assert.ok(section.includes('![3D table preview](data:image/svg+xml;base64,'));
        assert.ok(!section.includes('binding for child ID'));

        const dataUri = section.match(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/)[0];
        const svg = Buffer.from(dataUri.split(',')[1], 'base64').toString('utf8');
        assert.ok(svg.includes('data-table-view="front"'));
    });

    it('shows occurrence paths for complete ambiguous matches', () => {
        const makeDefinition = (includeLine) => ({
            kind: 'curve',
            id: 1001,
            keyword: '*DEFINE_CURVE',
            filePath: 'C:/model/shared.k',
            startLine: 10,
            points: [],
            occurrencePathLabels: [
                'root',
                `C:/model/main.k:${includeLine} -> shared.k`,
            ],
        });
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            referenceValue: { kind: 'numeric', id: 1001, raw: '1001' },
            analysis: {
                state: 'ambiguous',
                reasons: [],
                definitions: [makeDefinition(5), makeDefinition(12)],
            },
        });

        assert.ok(section.includes('Reference not unique'));
        assert.ok(section.includes('2 definitions with the same ID'));
        assert.ok(section.includes('Occurrence path'));
        assert.ok(section.includes('main.k:5'));
        assert.ok(section.includes('main.k:12'));
        assert.ok(!section.includes('data:image/svg+xml;base64,'));
    });

    it('shows source and effective IDs for a proven numeric IDFOFF mapping', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            referenceValue: { kind: 'numeric', id: 1001, raw: '1001' },
            analysis: {
                state: 'exact',
                reasons: [],
                transformResolution: {
                    resolved: true,
                    sourceId: 1001,
                    effectiveId: 1101,
                    offset: 100,
                    evidenceRule: 'E-T02',
                },
                definitions: [{
                    kind: 'curve',
                    id: 1101,
                    sourceId: 1001,
                    effectiveId: 1101,
                    idfoffOffset: 100,
                    evidenceRule: 'E-T02',
                    keyword: '*DEFINE_CURVE',
                    filePath: 'C:/model/shared.k',
                    startLine: 10,
                    points: [],
                }],
            },
        });

        assert.ok(section.includes('IDFOFF=100'));
        assert.ok(section.includes('source ID `1001`'));
        assert.ok(section.includes('effective ID `1101`'));
        assert.ok(!section.includes('E-T02'), 'internal evidence identifiers should not appear in user-facing copy');
    });

    it('does not draw an SVG for parameterized curve data', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            referenceValue: { kind: 'numeric', id: 1001, raw: '1001' },
            analysis: {
                state: 'exact',
                reasons: [],
                definitions: [{
                    kind: 'curve',
                    id: 1001,
                    keyword: '*DEFINE_CURVE',
                    filePath: 'C:/model/main.k',
                    startLine: 10,
                    endLine: 13,
                    points: [
                        { x: 0, y: 1, xRaw: '0', yRaw: '1' },
                        { x: null, y: 2, xRaw: '&X', yRaw: '2' },
                    ],
                    dataCompleteness: { state: 'incomplete', reasons: ['parameter-unresolved'] },
                }],
            },
        });

        assert.ok(section.includes('a plot cannot be generated'));
        assert.ok(!section.includes('data:image/svg+xml;base64,'));
    });

    it('localizes reference hover guidance in Chinese', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key) => key === 'language' ? 'zh-cn' : undefined
        });
        i18n.updateLanguage();

        try {
            const section = buildReferenceHoverSection({
                fieldName: 'LCSS',
                id: 1001,
                raw: '-1001',
                isSignedSwitch: true,
                definitions: [],
                needsProjectScan: true,
            });

            assert.ok(section.includes('LCSS 引用'));
            assert.ok(section.includes('项目未扫描'));
            assert.ok(section.includes('原始值'));
            assert.ok(section.includes('按绝对值 ID 查找定义'));
            assert.ok(section.includes('扫描引用文件树'));
            assert.ok(!section.includes('当前信息不足'));
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('renders resolved child curve links for table rows when available', () => {
        const childCurve = {
            kind: 'curve',
            id: 1001,
            keyword: '*DEFINE_CURVE',
            filePath: 'C:/model/main.k',
            startLine: 30,
            endLine: 35,
            points: [],
        };
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 2001,
            definitions: [{
                kind: 'table',
                tableType: '2d',
                id: 2001,
                keyword: '*DEFINE_TABLE_2D',
                filePath: 'C:/model/main.k',
                startLine: 20,
                endLine: 25,
                rows: [{
                    valueRaw: '0.01',
                    value: 0.01,
                    childIdRaw: '1001',
                    childId: 1001,
                    childKind: 'curve',
                    lineIndex: 23,
                    childAnalysis: {
                        state: 'exact',
                        effectiveChildId: 1001,
                        definitions: [childCurve],
                        unresolved: [],
                        reasons: [],
                    },
                }],
            }],
        });

        assert.ok(section.includes('| value | curve ID |'));
        assert.ok(section.includes('1001'));
        assert.ok(section.includes('Open child curve'));
    });

    it('shows ambiguous table child candidates without selecting one for 3D preview', () => {
        const candidates = ['a.k', 'b.k'].map((filePath, index) => ({
            kind: 'curve',
            id: 1001,
            keyword: '*DEFINE_CURVE',
            filePath: `C:/model/${filePath}`,
            startLine: 30 + index,
            points: [
                { x: 0, y: 10 + index, xRaw: '0', yRaw: String(10 + index) },
                { x: 1, y: 20 + index, xRaw: '1', yRaw: String(20 + index) },
            ],
        }));
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 2001,
            definitions: [{
                kind: 'table',
                tableType: '2d',
                id: 2001,
                keyword: '*DEFINE_TABLE_2D',
                filePath: 'C:/model/main.k',
                startLine: 20,
                rows: [{
                    valueRaw: '0.01',
                    value: 0.01,
                    childIdRaw: '1001',
                    childId: 1001,
                    childKind: 'curve',
                    childAnalysis: {
                        state: 'ambiguous',
                        effectiveChildId: 1001,
                        definitions: candidates,
                        unresolved: [],
                        reasons: [],
                    },
                }],
            }],
        });

        assert.ok(section.includes('2 matching candidates'));
        assert.ok(section.includes('Open child curve candidate 1'));
        assert.ok(section.includes('Open child curve candidate 2'));
        assert.ok(section.includes('Combined preview hidden'));
        assert.ok(section.includes('requires exactly one candidate definition'));
        assert.ok(!section.includes('data:image/svg+xml;base64,'));
    });

    it('previews a unique uncertain child and keeps its non-scan warning compact', () => {
        const childCurve = {
            kind: 'curve',
            id: 1001,
            keyword: '*DEFINE_CURVE',
            filePath: 'C:/model/main.k',
            startLine: 30,
            points: [
                { x: 0, y: 10, xRaw: '0', yRaw: '10' },
                { x: 1, y: 20, xRaw: '1', yRaw: '20' },
            ],
        };
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 2001,
            definitions: [{
                kind: 'table',
                tableType: '2d',
                id: 2001,
                keyword: '*DEFINE_TABLE_2D',
                filePath: 'C:/model/main.k',
                startLine: 20,
                rows: [{
                    valueRaw: '0.01',
                    value: 0.01,
                    childIdRaw: '1001',
                    childId: 1001,
                    childKind: 'curve',
                    childAnalysis: {
                        state: 'uncertain',
                        effectiveChildId: 1001,
                        definitions: [childCurve],
                        unresolved: [],
                        reasons: ['missing-include'],
                    },
                }],
            }],
        });

        assert.ok(section.includes('![3D table preview](data:image/svg+xml;base64,'));
        assert.ok(section.includes('Child 1001 unresolved'));
        assert.ok(section.includes('At least one include file is missing'));
        assert.ok(!section.includes('\n- At least one include file is missing'));
    });

    it('keeps parameterized table children uncertain and visible as raw IDs', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 2001,
            definitions: [{
                kind: 'table',
                tableType: '2d',
                id: 2001,
                keyword: '*DEFINE_TABLE_2D',
                filePath: 'C:/model/main.k',
                startLine: 20,
                rows: [{
                    valueRaw: '0.01',
                    value: 0.01,
                    childIdRaw: '&CID',
                    childId: null,
                    childKind: 'curve',
                    childAnalysis: {
                        state: 'uncertain',
                        definitions: [],
                        unresolved: [],
                        reasons: ['parameter-unresolved'],
                    },
                }],
            }],
        });

        assert.ok(section.includes('&CID'));
        assert.ok(section.includes('Child &amp;CID unresolved'));
        assert.ok(section.includes('parameter-controlled'));
        assert.ok(!section.includes('data:image/svg+xml;base64,'));
    });

    it('reports a missing table child only for a complete child analysis', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 2001,
            definitions: [{
                kind: 'table',
                tableType: '2d',
                id: 2001,
                keyword: '*DEFINE_TABLE_2D',
                filePath: 'C:/model/main.k',
                startLine: 20,
                rows: [{
                    valueRaw: '0.01',
                    value: 0.01,
                    childIdRaw: '999',
                    childId: 999,
                    childKind: 'curve',
                    childAnalysis: {
                        state: 'missing',
                        effectiveChildId: 999,
                        definitions: [],
                        unresolved: [],
                        reasons: [],
                    },
                }],
            }],
        });

        assert.ok(section.includes('No child curve definition was found for ID `999`'));
        assert.ok(!section.includes('data:image/svg+xml;base64,'));
    });

    it('localizes resolved child curve labels in Chinese table previews', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key) => key === 'language' ? 'zh-cn' : undefined
        });
        i18n.updateLanguage();

        try {
            const childCurve = {
                kind: 'curve',
                id: 1001,
                keyword: '*DEFINE_CURVE',
                filePath: 'C:/model/main.k',
                startLine: 30,
                endLine: 35,
                points: [],
            };
            const section = buildReferenceHoverSection({
                fieldName: 'LCSS',
                id: 2001,
                definitions: [{
                    kind: 'table',
                    tableType: '2d',
                    id: 2001,
                    keyword: '*DEFINE_TABLE_2D',
                    filePath: 'C:/model/main.k',
                    startLine: 20,
                    endLine: 25,
                    rows: [{
                        valueRaw: '0.01',
                        value: 0.01,
                        childIdRaw: '1001',
                        childId: 1001,
                        childKind: 'curve',
                        lineIndex: 23,
                        childAnalysis: {
                            state: 'exact',
                            effectiveChildId: 1001,
                            definitions: [childCurve],
                            unresolved: [],
                            reasons: [],
                        },
                    }],
                }],
            });

            assert.ok(section.includes('| 值 | 曲线 ID |'));
            assert.ok(section.includes('打开子级曲线'));
            assert.ok(!section.includes('curve ID'));
            assert.ok(!section.includes('Open child curve'));
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('renders 3D table preview in hover section with SVG data URI', () => {
        const childCurve = {
            kind: 'curve',
            id: 1001,
            keyword: '*DEFINE_CURVE',
            filePath: 'C:/model/main.k',
            startLine: 30,
            endLine: 35,
            points: [
                { x: 0, y: 10, xRaw: '0', yRaw: '10' },
                { x: 1, y: 20, xRaw: '1', yRaw: '20' }
            ],
        };
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 2001,
            definitions: [{
                kind: 'table',
                tableType: '2d',
                id: 2001,
                keyword: '*DEFINE_TABLE_2D',
                filePath: 'C:/model/main.k',
                startLine: 20,
                endLine: 25,
                rows: [{
                    valueRaw: '0.01',
                    value: 0.01,
                    childIdRaw: '1001',
                    childId: 1001,
                    childKind: 'curve',
                    lineIndex: 23,
                    childAnalysis: {
                        state: 'exact',
                        effectiveChildId: 1001,
                        definitions: [childCurve],
                        unresolved: [],
                        reasons: [],
                    },
                }],
            }],
        });

        assert.ok(section.includes('![3D table preview](data:image/svg+xml;base64,'));
        assert.ok(section.includes('| value | curve ID |'));
        assert.ok(section.includes('1001'));
        assert.ok(section.includes('Open child curve'));
    });

    describe('buildDefinitionHoverSection', () => {
        it('renders curve definition preview without redundant reference or file links', () => {
            const section = buildDefinitionHoverSection({
                kind: 'curve',
                id: 1001,
                keyword: '*DEFINE_CURVE',
                filePath: 'C:/model/main.k',
                startLine: 10,
                endLine: 13,
                title: 'My Curve Title',
                points: [
                    { x: 0, y: 400, xRaw: '0', yRaw: '400', lineIndex: 12 },
                    { x: 0.1, y: 450, xRaw: '0.1', yRaw: '450', lineIndex: 13 },
                ],
            });

            // Should have headers, title, and preview SVG
            assert.ok(section.includes('### $(graph-line) **\\*DEFINE\\_CURVE (ID: 1001)** - _My Curve Title_'));
            assert.ok(section.includes('data:image/svg+xml;base64,'));
            // Should NOT have reference header or Go to File links since it's definition hover
            assert.ok(!section.includes('LCSS reference'));
            assert.ok(!section.includes('command:extension.openLsdynaReferenceDefinition'));
        });

        it('offers viewpoint controls on a combined table definition preview', () => {
            const childCurve = {
                kind: 'curve',
                id: 1001,
                points: [{ x: 0, y: 2 }, { x: 1, y: 4 }],
            };
            const section = buildDefinitionHoverSection({
                kind: 'table',
                tableType: '2d',
                id: 2001,
                keyword: '*DEFINE_TABLE_2D',
                rows: [{
                    valueRaw: '0.5',
                    value: 0.5,
                    childIdRaw: '1001',
                    childKind: 'curve',
                    childAnalysis: {
                        state: 'exact',
                        definitions: [childCurve],
                        reasons: [],
                    },
                }],
            }, 2, {
                key: 'C:/model/main.k:20:DEFINITION',
                view: 'side',
                filePath: 'C:/model/main.k',
                lineIndex: 20,
                character: 0,
            });

            assert.ok(section.includes('View:'));
            assert.ok(section.includes('**Side**'));
            assert.ok(section.includes('command:extension.setLsdynaTablePreviewView'));
            const dataUri = section.match(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/)[0];
            const svg = Buffer.from(dataUri.split(',')[1], 'base64').toString('utf8');
            assert.ok(svg.includes('data-table-view="side"'));
        });

        it('localizes curve definition title punctuation in Chinese', () => {
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            vscodeMock.workspace.getConfiguration = () => ({
                get: (key) => key === 'language' ? 'zh-cn' : undefined
            });
            i18n.updateLanguage();

            try {
                const section = buildDefinitionHoverSection({
                    kind: 'curve',
                    id: 1001,
                    keyword: '*DEFINE_CURVE',
                    filePath: 'C:/model/main.k',
                    startLine: 10,
                    endLine: 13,
                    points: [],
                });

                assert.ok(section.includes('### $(graph-line) **\\*DEFINE\\_CURVE（ID：1001）**'));
            } finally {
                vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            }
        });
    });
});


describe('public reference diagnostic wording', () => {
    const { userFacingReason } = require('../../../out/core/userFacingReason');
    const { uncertaintyReasonLabel } = require('../../../out/core/references/fieldReferenceHover');
    it('keeps source names and unknown diagnostic codes out of Hover and notices', () => {
        for (const reason of ['lspp-link-code-target-noncanonical', 'lspp-link-code-target-unresolved (4 occurrences)', 'LSPREPOST-source-unavailable', 'future-internal-reason']) {
            assert.doesNotMatch(uncertaintyReasonLabel(reason), /lspp|lsprepost|future-internal-reason/i);
            for (const locale of ['zh-cn', 'en']) assert.doesNotMatch(userFacingReason(reason, locale), /lspp|lsprepost|future-internal-reason/i);
        }
        assert.match(userFacingReason('lspp-link-code-target-unresolved (4 occurrences)', 'zh-cn'), /4 处/);
        assert.match(userFacingReason('lspp-link-code-target-unresolved (1 occurrence)', 'en'), /1 occurrence\)/);
    });
});
