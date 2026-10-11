const assert = require('assert');
const makeTemp = require('../../support/tempDirectories').trackTempDirectories();
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    SemanticEvidenceResolver,
} = require('../../../out/core/semantics/semanticEvidenceResolver');
const { handleOpenSemanticEvidenceCommand } = require('../../../src/extension')._internals;

function hash(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createFixture() {
    const root = makeTemp(path.join(os.tmpdir(), 'semantic-evidence-'));
    const pdfDir = path.join(root, 'pdf');
    fs.mkdirSync(pdfDir);
    const pdfBytes = Buffer.from('verified official PDF fixture');
    const pdfFile = 'pdf/vol-i.pdf';
    fs.writeFileSync(path.join(root, pdfFile), pdfBytes);
    const manifest = {
        schema: 'lsdyna.manual.package.v2',
        schemaVersion: 2,
        documents: [{ slug: 'manual-vol-i', title: 'Volume I', pdfFile }],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(path.join(root, 'manifest.json'), manifestBytes);
    const evidence = {
        evidenceId: 'evidence:one',
        manualId: 'manual-vol-i',
        page: 7,
    };
    const sourceLock = {
        manualPackManifestSha256: hash(manifestBytes),
        documents: [{
            manualId: 'manual-vol-i',
            title: 'Volume I',
            pdfFile,
            sha256: hash(pdfBytes),
            size: pdfBytes.length,
            pages: 10,
        }],
    };
    const catalog = {
        rulesForKeyword: keyword => keyword === '*TEST'
            ? [{ ruleId: 'rule:one', evidence: [evidence] }]
            : [],
        summary: () => ({ sourceLock }),
    };
    return { root, catalog, sourceLock, manifestBytes };
}

function createPackScopedFixture({ flavor = 'en' } = {}) {
    const root = makeTemp(path.join(os.tmpdir(), 'semantic-evidence-profile-'));
    fs.mkdirSync(path.join(root, 'pdf'));
    fs.mkdirSync(path.join(root, 'indexes'));
    const manualId = 'manual-vol-ii';
    const sourceProfileId = flavor === 'en' ? 'a'.repeat(64) : 'b'.repeat(64);
    const sourceDocumentId = flavor === 'en' ? 'c'.repeat(64) : 'd'.repeat(64);
    const pdfFile = flavor === 'en' ? 'pdf/vol-ii.pdf' : 'pdf/vol-ii.zh-CN.pdf';
    const pdfBytes = Buffer.from(`profile-${flavor}-official-pdf`);
    const revision = flavor === 'en'
        ? 'master@96ae93b45 (06/11/26)'
        : 'master@79685cced (03/12/26)';
    fs.writeFileSync(path.join(root, pdfFile), pdfBytes);
    const authority = {
        schema: 'lsdyna.pdf.authority-index.v1',
        schemaVersion: 1,
        flavor,
        sourceProfileId,
        documents: [{
            manualId,
            sourceDocumentId,
            revision,
            pages: flavor === 'en' ? 900 : 850,
            artifactSha256: hash(pdfBytes),
            artifactBytes: pdfBytes.length,
            pdfFile,
        }],
    };
    const indexBytes = Buffer.from(`${JSON.stringify(authority, null, 2)}\n`);
    const indexSha256 = hash(indexBytes);
    fs.writeFileSync(path.join(root, 'indexes', 'pdf-authority.json'), indexBytes);
    const manifest = {
        schema: 'lsdyna.manual.package.v2',
        schemaVersion: 2,
        generatedAt: 'first-build',
        flavor,
        documents: [{
            slug: manualId,
            title: 'LS-DYNA Keyword Manual Vol II',
            pdfFile,
            pdfAuthoritySourceDocumentId: sourceDocumentId,
        }],
        indexes: { pdfAuthority: 'indexes/pdf-authority.json' },
        pdfAuthority: {
            index: 'indexes/pdf-authority.json',
            indexSha256,
            sourceProfileId,
            schemaVersion: 1,
        },
    };
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    const evidenceAuthority = {
        sourceProfileId,
        indexSha256,
        documents: authority.documents,
    };
    const evidence = {
        evidenceId: 'evidence:profile',
        manualId,
        page: flavor === 'en' ? 832 : 814,
        sourceProfileId,
    };
    const catalog = {
        rulesForKeyword: keyword => keyword === '*TEST'
            ? [{ ruleId: 'rule:profile', evidence: [evidence] }]
            : [],
        summary: () => ({ evidenceAuthority }),
    };
    return {
        root,
        authority,
        catalog,
        evidence,
        evidenceAuthority,
        indexBytes,
        manifest,
        pdfBytes,
    };
}

describe('semantic evidence resolver', () => {
    it('rejects a declared authority with no valid profile despite a valid legacy source lock', async () => {
        const fixture = createFixture();
        const legacySummary = fixture.catalog.summary();
        const request = { keyword: '*TEST', ruleId: 'rule:one', evidenceId: 'evidence:one' };
        const resolver = new SemanticEvidenceResolver();
        const opened = [];
        const openEvidence = () => handleOpenSemanticEvidenceCommand({}, request, {
            resolver, catalog: fixture.catalog, manualPackRoot: fixture.root, showMessage: false,
            openPdf: (_context, pdfPath) => opened.push(pdfPath),
        });
        assert.equal((await openEvidence()).status, 'resolved');
        for (const evidenceAuthority of [null, false, 0, '', {}, [], { profiles: [] },
            { profiles: [{ sourceProfileId: 'a'.repeat(64), indexSha256: 'invalid', documents: [] }] },
            { sourceProfileId: 'a'.repeat(64), indexSha256: 'invalid', documents: [] }]) {
            fixture.catalog.summary = () => ({ ...legacySummary, evidenceAuthority });
            const result = await openEvidence();
            assert.equal(result.status, 'source-lock-unavailable', JSON.stringify(evidenceAuthority));
            assert.equal(opened.length, 1, 'invalid authority must not reach the PDF opener');
        }
        fixture.catalog.summary = () => legacySummary;
        assert.equal((await openEvidence()).status, 'resolved');
        assert.equal(opened.length, 2);
    });

    for (const kind of ['source-lock', 'profile-authority']) {
        it(`checks current PDF bytes after a same-size/mtime replacement (${kind})`, async () => {
            const profileAware = kind === 'profile-authority';
            const fixture = profileAware ? createPackScopedFixture() : createFixture();
            const expected = profileAware ? fixture.authority.documents[0] : fixture.sourceLock.documents[0];
            const pdfPath = path.join(fixture.root, expected.pdfFile);
            const original = fs.readFileSync(pdfPath);
            const fixedTime = new Date('2020-01-02T03:04:05.000Z');
            fs.utimesSync(pdfPath, fixedTime, fixedTime);
            const before = fs.statSync(pdfPath);
            const request = { keyword: '*TEST',
                ruleId: profileAware ? 'rule:profile' : 'rule:one',
                evidenceId: profileAware ? 'evidence:profile' : 'evidence:one' };
            const resolver = new SemanticEvidenceResolver();
            const opened = [];
            const openEvidence = () => handleOpenSemanticEvidenceCommand({}, request, {
                resolver, catalog: fixture.catalog, manualPackRoot: fixture.root, showMessage: false,
                openPdf: (_context, actualPath) => opened.push(actualPath),
            });
            const statuses = [(await openEvidence()).status];
            assert.equal(opened.length, 1);

            fs.writeFileSync(pdfPath, Buffer.alloc(original.length, 0x78));
            fs.utimesSync(pdfPath, fixedTime, fixedTime);
            const replaced = fs.statSync(pdfPath);
            assert.equal(replaced.size, before.size);
            assert.equal(replaced.mtimeMs, before.mtimeMs);
            assert.notEqual(hash(fs.readFileSync(pdfPath)), hash(original));
            statuses.push((await openEvidence()).status);
            const opensAfterReplacement = opened.length;

            fs.writeFileSync(pdfPath, original);
            fs.utimesSync(pdfPath, fixedTime, fixedTime);
            statuses.push((await openEvidence()).status);
            console.log(JSON.stringify({ kind, size: before.size, mtimeMs: before.mtimeMs,
                replacementMtimeMs: replaced.mtimeMs, statuses }));
            assert.deepStrictEqual(statuses, ['resolved', 'pdf-integrity-mismatch', 'resolved']);
            assert.equal(opensAfterReplacement, 1, 'changed bytes must not reach the PDF opener');
            assert.deepStrictEqual(opened, [fs.realpathSync(pdfPath), fs.realpathSync(pdfPath)]);
        });
    }

    it('accepts a rebuilt pack when source profile/index identity stays unchanged', async () => {
        const fixture = createPackScopedFixture();
        {
            fixture.manifest.generatedAt = 'second-build';
            fs.writeFileSync(path.join(fixture.root, 'manifest.json'), JSON.stringify(fixture.manifest));
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:profile',
                evidenceId: 'evidence:profile',
            }, fixture.catalog, fixture.root);
            assert.equal(result.status, 'resolved');
            assert.equal(result.page, 832);
            assert.equal(result.sourceProfileId, 'a'.repeat(64));
            assert.equal(result.revision, 'master@96ae93b45 (06/11/26)');
        }
    });

    it('silently classifies an unapproved configured profile as unavailable', async () => {
        const english = createPackScopedFixture({ flavor: 'en' });
        const bilingual = createPackScopedFixture({ flavor: 'bilingual' });
        {
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:profile',
                evidenceId: 'evidence:profile',
            }, english.catalog, bilingual.root);
            assert.equal(result.status, 'manual-pack-profile-unavailable');
        }
    });

    it('selects a future published location for the configured profile without page guessing', async () => {
        const fixture = createPackScopedFixture({ flavor: 'bilingual' });
        {
            fixture.catalog.rulesForKeyword = () => [{
                ruleId: 'rule:profile',
                evidence: [{
                    evidenceId: 'evidence:profile',
                    locations: [{
                        sourceProfileId: fixture.evidenceAuthority.sourceProfileId,
                        manualId: 'manual-vol-ii',
                        page: 814,
                    }],
                }],
            }];
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:profile',
                evidenceId: 'evidence:profile',
            }, fixture.catalog, fixture.root);
            assert.equal(result.status, 'resolved');
            assert.equal(result.page, 814);
        }
    });

    it('opens the native evidence page selected from a two-profile registry', async () => {
        const english = createPackScopedFixture({ flavor: 'en' });
        const bilingual = createPackScopedFixture({ flavor: 'bilingual' });
        {
            const registry = {
                schemaVersion: 2,
                defaultSourceProfileId: english.evidenceAuthority.sourceProfileId,
                profiles: [english.evidenceAuthority, bilingual.evidenceAuthority],
            };
            const evidence = {
                evidenceId: 'evidence:profile',
                locations: [
                    {
                        sourceProfileId: english.evidenceAuthority.sourceProfileId,
                        manualId: 'manual-vol-ii',
                        page: 832,
                    },
                    {
                        sourceProfileId: bilingual.evidenceAuthority.sourceProfileId,
                        manualId: 'manual-vol-ii',
                        page: 814,
                    },
                ],
            };
            const catalog = {
                rulesForKeyword: keyword => keyword === '*TEST'
                    ? [{ ruleId: 'rule:profile', evidence: [evidence] }]
                    : [],
                summary: () => ({ evidenceAuthority: registry }),
            };
            const resolver = new SemanticEvidenceResolver();
            const request = {
                keyword: '*TEST',
                ruleId: 'rule:profile',
                evidenceId: 'evidence:profile',
            };
            const englishResult = await resolver.resolve(request, catalog, english.root);
            const bilingualResult = await resolver.resolve(request, catalog, bilingual.root);
            assert.equal(englishResult.status, 'resolved');
            assert.equal(englishResult.page, 832);
            assert.equal(bilingualResult.status, 'resolved');
            assert.equal(bilingualResult.page, 814);
            assert.equal(bilingualResult.flavor, 'bilingual');
        }
    });

    it('rejects authority metadata and PDF tampering in the profile-aware path', async () => {
        const fixture = createPackScopedFixture();
        const request = {
            keyword: '*TEST',
            ruleId: 'rule:profile',
            evidenceId: 'evidence:profile',
        };
        {
            fs.appendFileSync(path.join(fixture.root, 'indexes', 'pdf-authority.json'), ' ');
            let result = await new SemanticEvidenceResolver().resolve(request, fixture.catalog, fixture.root);
            assert.equal(result.status, 'manual-pack-authority-invalid');

            fs.writeFileSync(path.join(fixture.root, 'indexes', 'pdf-authority.json'), fixture.indexBytes);
            const pdfPath = path.join(fixture.root, fixture.authority.documents[0].pdfFile);
            fs.writeFileSync(pdfPath, Buffer.alloc(fixture.pdfBytes.length, 0x78));
            result = await new SemanticEvidenceResolver().resolve(request, fixture.catalog, fixture.root);
            assert.equal(result.status, 'pdf-integrity-mismatch');
        }
    });

    it('opens only a published evidence record against the exact locked pack and PDF', async () => {
        const fixture = createFixture();
        {
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:one',
                evidenceId: 'evidence:one',
            }, fixture.catalog, fixture.root);

            assert.equal(result.status, 'resolved');
            assert.equal(result.page, 7);
            assert.equal(result.manualId, 'manual-vol-i');
            assert.equal(result.pdfPath, fs.realpathSync(path.join(fixture.root, 'pdf', 'vol-i.pdf')));
        }
    });

    it('rejects a rule or evidence ID that is not in the published runtime', async () => {
        const fixture = createFixture();
        {
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:forged',
                evidenceId: 'evidence:one',
            }, fixture.catalog, fixture.root);
            assert.equal(result.status, 'invalid-request');
        }
    });

    it('fails open when a legacy manual pack identity is unavailable', async () => {
        const fixture = createFixture();
        {
            fs.appendFileSync(path.join(fixture.root, 'manifest.json'), '\n');
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:one',
                evidenceId: 'evidence:one',
            }, fixture.catalog, fixture.root);
            assert.equal(result.status, 'manual-pack-evidence-unavailable');
        }
    });

    it('fails open when PDF bytes differ from the official source lock', async () => {
        const fixture = createFixture();
        {
            const pdfPath = path.join(fixture.root, 'pdf', 'vol-i.pdf');
            fs.writeFileSync(pdfPath, Buffer.alloc(fixture.sourceLock.documents[0].size, 0x78));
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:one',
                evidenceId: 'evidence:one',
            }, fixture.catalog, fixture.root);
            assert.equal(result.status, 'pdf-integrity-mismatch');
        }
    });

    it('rejects an evidence page outside the locked PDF page count', async () => {
        const fixture = createFixture();
        {
            fixture.catalog.rulesForKeyword = () => [{
                ruleId: 'rule:one',
                evidence: [{ evidenceId: 'evidence:one', manualId: 'manual-vol-i', page: 11 }],
            }];
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:one',
                evidenceId: 'evidence:one',
            }, fixture.catalog, fixture.root);
            assert.equal(result.status, 'page-out-of-range');
        }
    });
});
