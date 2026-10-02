'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    loadManualPackAuthority,
    loadManualPackAuthoritySync,
} = require('../../out/manual/manualPackAuthority');

function hash(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createAuthorityPack({ flavor = 'en' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-manual-authority-'));
    fs.mkdirSync(path.join(root, 'indexes'), { recursive: true });
    fs.mkdirSync(path.join(root, 'pdf'), { recursive: true });
    const manualId = 'manual-vol-ii';
    const pdfFile = flavor === 'bilingual' ? 'pdf/Vol II.zh-CN.pdf' : 'pdf/Vol II.pdf';
    const pdfBytes = Buffer.from(`official-${flavor}-pdf`);
    fs.writeFileSync(path.join(root, pdfFile), pdfBytes);
    const sourceDocumentId = flavor === 'bilingual' ? 'b'.repeat(64) : 'a'.repeat(64);
    const sourceProfileId = flavor === 'bilingual' ? 'd'.repeat(64) : 'c'.repeat(64);
    const revision = flavor === 'bilingual'
        ? 'master@79685cced (03/12/26)'
        : 'master@96ae93b45 (06/11/26)';
    const authority = {
        schema: 'lsdyna.pdf.authority-index.v1',
        schemaVersion: 1,
        flavor,
        sourceProfileId,
        documents: [{
            manualId,
            sourceDocumentId,
            revision,
            pages: 20,
            artifactSha256: hash(pdfBytes),
            artifactBytes: pdfBytes.length,
            pdfFile,
        }],
    };
    const indexBytes = Buffer.from(`${JSON.stringify(authority, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'indexes', 'pdf-authority.json'), indexBytes);
    const manifest = {
        schema: 'lsdyna.manual.package.v2',
        schemaVersion: 2,
        flavor,
        displayName: flavor,
        documents: [{
            slug: manualId,
            title: 'LS-DYNA Keyword Manual Vol II',
            pdfFile,
            pdfAuthoritySourceDocumentId: sourceDocumentId,
        }],
        indexes: { pdfAuthority: 'indexes/pdf-authority.json' },
        pdfAuthority: {
            index: 'indexes/pdf-authority.json',
            indexSha256: hash(indexBytes),
            sourceProfileId,
            schemaVersion: 1,
        },
    };
    fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { root, manifest, authority, indexBytes, pdfBytes };
}

describe('manual pack authority', () => {
    it('loads the bounded pack profile and document identity synchronously and asynchronously', async () => {
        const fixture = createAuthorityPack();
        try {
            const sync = loadManualPackAuthoritySync(fixture.root);
            const asyncResult = await loadManualPackAuthority(fixture.root);
            for (const result of [sync, asyncResult]) {
                assert.equal(result.status, 'ready');
                assert.equal(result.snapshot.sourceProfileId, 'c'.repeat(64));
                assert.equal(result.snapshot.documents[0].manualId, 'manual-vol-ii');
                assert.equal(result.snapshot.documents[0].revision, 'master@96ae93b45 (06/11/26)');
            }
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('rejects authority-index tampering and manifest/document identity drift', () => {
        const fixture = createAuthorityPack();
        try {
            fs.appendFileSync(path.join(fixture.root, 'indexes', 'pdf-authority.json'), ' ');
            assert.equal(loadManualPackAuthoritySync(fixture.root).status, 'manual-pack-authority-invalid');

            fs.writeFileSync(
                path.join(fixture.root, 'indexes', 'pdf-authority.json'),
                fixture.indexBytes,
            );
            const changed = JSON.parse(JSON.stringify(fixture.manifest));
            changed.documents[0].pdfAuthoritySourceDocumentId = 'f'.repeat(64);
            fs.writeFileSync(path.join(fixture.root, 'manifest.json'), JSON.stringify(changed));
            assert.equal(loadManualPackAuthoritySync(fixture.root).status, 'manual-pack-authority-invalid');
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('distinguishes a missing pack from a pack without the new authority contract', async () => {
        const missing = path.join(os.tmpdir(), `lsdyna-no-pack-${process.pid}-${Date.now()}`);
        assert.equal((await loadManualPackAuthority(missing)).status, 'manual-pack-unavailable');

        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-legacy-pack-'));
        try {
            fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2 }));
            assert.equal(
                (await loadManualPackAuthority(root)).status,
                'manual-pack-authority-unavailable',
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

module.exports = { createAuthorityPack };
