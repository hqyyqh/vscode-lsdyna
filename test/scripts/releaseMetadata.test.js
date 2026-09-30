'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { prepareReleaseMetadata } = require('../../scripts/prepare-release-metadata.cjs');
const { releasePath, authoringPath } = require('../../scripts/release-resource-paths.cjs');

describe('release metadata boundaries', () => {
    it('rejects mixing both names of the same release resource', () => {
        const errors = require('../../scripts/validate-package-contents.cjs').validatePackageFiles([
            'out/runtime/catalog-input-form/manifest.json', 'out/runtime/lspp-input-form/manifest.json',
        ]);
        assert.ok(errors.includes('VSIX contains mixed authoring/release resource paths'));
    });
    it('removes only unused producer fields and keeps reader bindings, rule identities and language support', () => {
        const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-metadata-'));
        const put = (name, value) => { const file = path.join(stage, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
        try {
            put('out/runtime/lspp-input-form/manifest.json', JSON.stringify({ dataset: {
                name: 'extract_lspp.py', authority: 'LS-PrePost callbacks', executable: 'C:/vendor.exe',
                sha256: 'a'.repeat(64), datasetVersion: 'verified-version',
            }, auditSha256: 'b'.repeat(64), summary: { safeWriteGaps: 0 } }));
            put('package.json', JSON.stringify({ scripts: { build: 'extract' }, devDependencies: { tool: '1' },
                main: './out/extension.js', dependencies: { runtime: '1' }, contributes: { languages: [{ id: 'lsprepost-command-file' }] } }));
            put('out/core/lsppCatalog.js', 'module.exports = 42;');
            put('out/extension.js', "exports.value = require('./core/lsppCatalog'); exports.reason = 'lspp-input-form-source-error';");
            put('keywords/lspp-reader.json', '{"evidence":{"sha256":"keep"},"source":"keep"}');
            put('keywords/field_reference_index.json', JSON.stringify({ lsppBlockedReferences: { file: 'keywords/lspp-reader.json', sha256: 'keep' } }));
            put('keywords/lspp_keyword_categories.runtime.json', JSON.stringify({ source: { datasetVersion: 'private', datasetSha256: 'private', catalogSha256: 'keep' }, categories: [{ name: 'MAT' }] }));
            put('.vscodeignore', '!keywords/lspp-reader.json\n!syntaxes/lspp-cfile.tmLanguage.json');
            const baselineMetadata = prepareReleaseMetadata(stage, { renameResources: false });
            assert.equal(baselineMetadata.removedProducer.executable, 'C:/vendor.exe');
            assert.ok(fs.existsSync(path.join(stage, 'out/runtime/lspp-input-form/manifest.json')));
            assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'package.json'))).scripts, undefined);
            assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'keywords/field_reference_index.json'))).lsppBlockedReferences.file,
                'keywords/lspp-reader.json');
            prepareReleaseMetadata(stage);
            const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'out/runtime/catalog-input-form/manifest.json')));
            assert.deepEqual(manifest.dataset, { sha256: 'a'.repeat(64), datasetVersion: 'verified-version' });
            assert.equal(manifest.auditSha256, 'b'.repeat(64));
            assert.equal(manifest.summary.safeWriteGaps, 0);
            const entry = require(path.join(stage, 'out/extension.js'));
            assert.equal(entry.value, 42);
            assert.equal(entry.reason, 'lspp-input-form-source-error');
            assert.equal(fs.readFileSync(path.join(stage, 'keywords/catalog-reader.json'), 'utf8'), '{"evidence":{"sha256":"keep"},"source":"keep"}');
            const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json')));
            assert.equal(pkg.scripts, undefined); assert.equal(pkg.devDependencies, undefined);
            assert.equal(pkg.dependencies.runtime, '1'); assert.equal(pkg.contributes.languages[0].id, 'lsprepost-command-file');
            assert.equal(authoringPath(releasePath('out/core/lsppCatalog.js')), 'out/core/lsppCatalog.js');
            assert.equal(releasePath('syntaxes/lspp-cfile.tmLanguage.json'), 'syntaxes/lspp-cfile.tmLanguage.json');
            assert.equal(fs.existsSync(path.join(stage, 'keywords/lspp-reader.json')), false);
            const descriptor = JSON.parse(fs.readFileSync(path.join(stage, 'keywords/field_reference_index.json'))).lsppBlockedReferences;
            assert.equal(descriptor.file, 'keywords/catalog-reader.json');
            assert.equal(descriptor.sha256, 'keep');
            assert.ok(fs.existsSync(path.join(stage, descriptor.file)));
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, 'keywords/catalog_keyword_categories.runtime.json'))), { source: { catalogSha256: 'keep' }, categories: [{ name: 'MAT' }] });
        } finally {
            assert.equal(path.dirname(stage), os.tmpdir());
            assert.ok(path.basename(stage).startsWith('dynasense-metadata-'));
            fs.rmSync(stage, { recursive: true, force: true });
        }
    });
});
