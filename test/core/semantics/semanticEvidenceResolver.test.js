const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    SemanticEvidenceResolver,
} = require('../../../out/core/semantics/semanticEvidenceResolver');

function hash(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-evidence-'));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-evidence-profile-'));
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
    it('accepts a rebuilt pack when source profile/index identity stays unchanged', async () => {
        const fixture = createPackScopedFixture();
        try {
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
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('silently classifies an unapproved configured profile as unavailable', async () => {
        const english = createPackScopedFixture({ flavor: 'en' });
        const bilingual = createPackScopedFixture({ flavor: 'bilingual' });
        try {
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:profile',
                evidenceId: 'evidence:profile',
            }, english.catalog, bilingual.root);
            assert.equal(result.status, 'manual-pack-profile-unavailable');
        } finally {
            fs.rmSync(english.root, { recursive: true, force: true });
            fs.rmSync(bilingual.root, { recursive: true, force: true });
        }
    });

    it('selects a future published location for the configured profile without page guessing', async () => {
        const fixture = createPackScopedFixture({ flavor: 'bilingual' });
        try {
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
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('opens the native evidence page selected from a two-profile registry', async () => {
        const english = createPackScopedFixture({ flavor: 'en' });
        const bilingual = createPackScopedFixture({ flavor: 'bilingual' });
        try {
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
        } finally {
            fs.rmSync(english.root, { recursive: true, force: true });
            fs.rmSync(bilingual.root, { recursive: true, force: true });
        }
    });

    it('rejects authority metadata and PDF tampering in the profile-aware path', async () => {
        const fixture = createPackScopedFixture();
        const request = {
            keyword: '*TEST',
            ruleId: 'rule:profile',
            evidenceId: 'evidence:profile',
        };
        try {
            fs.appendFileSync(path.join(fixture.root, 'indexes', 'pdf-authority.json'), ' ');
            let result = await new SemanticEvidenceResolver().resolve(request, fixture.catalog, fixture.root);
            assert.equal(result.status, 'manual-pack-authority-invalid');

            fs.writeFileSync(path.join(fixture.root, 'indexes', 'pdf-authority.json'), fixture.indexBytes);
            const pdfPath = path.join(fixture.root, fixture.authority.documents[0].pdfFile);
            fs.writeFileSync(pdfPath, Buffer.alloc(fixture.pdfBytes.length, 0x78));
            result = await new SemanticEvidenceResolver().resolve(request, fixture.catalog, fixture.root);
            assert.equal(result.status, 'pdf-integrity-mismatch');
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('opens only a published evidence record against the exact locked pack and PDF', async () => {
        const fixture = createFixture();
        try {
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:one',
                evidenceId: 'evidence:one',
            }, fixture.catalog, fixture.root);

            assert.equal(result.status, 'resolved');
            assert.equal(result.page, 7);
            assert.equal(result.manualId, 'manual-vol-i');
            assert.equal(result.pdfPath, fs.realpathSync(path.join(fixture.root, 'pdf', 'vol-i.pdf')));
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects a rule or evidence ID that is not in the published runtime', async () => {
        const fixture = createFixture();
        try {
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:forged',
                evidenceId: 'evidence:one',
            }, fixture.catalog, fixture.root);
            assert.equal(result.status, 'invalid-request');
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('fails open when a legacy manual pack identity is unavailable', async () => {
        const fixture = createFixture();
        try {
            fs.appendFileSync(path.join(fixture.root, 'manifest.json'), '\n');
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:one',
                evidenceId: 'evidence:one',
            }, fixture.catalog, fixture.root);
            assert.equal(result.status, 'manual-pack-evidence-unavailable');
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('fails open when PDF bytes differ from the official source lock', async () => {
        const fixture = createFixture();
        try {
            const pdfPath = path.join(fixture.root, 'pdf', 'vol-i.pdf');
            fs.writeFileSync(pdfPath, Buffer.alloc(fixture.sourceLock.documents[0].size, 0x78));
            const result = await new SemanticEvidenceResolver().resolve({
                keyword: '*TEST',
                ruleId: 'rule:one',
                evidenceId: 'evidence:one',
            }, fixture.catalog, fixture.root);
            assert.equal(result.status, 'pdf-integrity-mismatch');
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects an evidence page outside the locked PDF page count', async () => {
        const fixture = createFixture();
        try {
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
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });
});
