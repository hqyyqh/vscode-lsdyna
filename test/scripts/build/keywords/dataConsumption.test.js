'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { rebuild, readSources } = require('../../../../scripts/build/keywords/data.cjs');
const root = path.resolve(__dirname, '../../../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

describe('built data consumed by the development extension', function () {
    this.timeout(120000);
    it('consumes a help authoring edit without changing native authority or tracked outputs', function () {
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-consumer-'));
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(root, 'keywords/sources/manifest.json')));
            const inputFiles = ['keywords/sources/manifest.json',
                ...manifest.bundles.map(item => item.path),
                ...(manifest.compilerInputs || []).map(item => item.path),
                ...(manifest.compatibility || []).map(item => item.path),
                ...['field_data_zh.json', 'native_field_help_zh.json', 'manual_semantics_zh.json', 'field-help-corrections.json']
                    .map(name => 'keywords/authoring/' + name)];
            const identities = 'keywords/runtime/native-readers/descriptor-identities.json';
            if (fs.existsSync(path.join(root, identities))) inputFiles.push(identities);
            for (const relative of inputFiles) {
                fs.mkdirSync(path.dirname(path.join(temporary, relative)), { recursive: true });
                fs.copyFileSync(path.join(root, relative), path.join(temporary, relative));
            }
            fs.cpSync(path.join(root, 'out/core'), path.join(temporary, 'out/core'), { recursive: true });
            fs.cpSync(path.join(root, 'src/core'), path.join(temporary, 'src/core'), { recursive: true });
            for (const name of ['keywordSpellingAliases', 'keywordLayoutCorrections',
                'runtimeSemanticRelationCorrections', 'runtimeTableLayoutCorrections']) {
                const relative = 'keywords/authoring/engineering/' + name + '.json';
                fs.mkdirSync(path.dirname(path.join(temporary, relative)), { recursive: true });
                fs.copyFileSync(path.join(root, relative), path.join(temporary, relative));
            }
            const baseline = readSources(root).bundles.schema.payloads.find(item => item.path === 'field_data.json').value;
            const correctionsFile = path.join(temporary, 'keywords/authoring/field-help-corrections.json');
            const corrections = JSON.parse(fs.readFileSync(correctionsFile));
            let selected;
            for (const [keyword, entry] of Object.entries(baseline)) {
                for (const [card, fields] of (entry.c || []).entries()) {
                    const field = fields.find(item => item.h && fields.filter(other => other.n === item.n).length === 1 &&
                        !corrections.fields.some(correction => correction.keyword === keyword &&
                            correction.card === card && correction.field === item.n));
                    if (field) { selected = { keyword, card, field }; break; }
                }
                if (selected) break;
            }
            assert.ok(selected);
            const replacement = selected.field.h + ' Description reviewed for the development-build test.';
            corrections.fields.push({ keyword: selected.keyword, card: selected.card,
                field: selected.field.n, sourceHelpSha256: sha(Buffer.from(selected.field.h)), english: replacement });
            fs.writeFileSync(correctionsFile, JSON.stringify(corrections));
            const localizedFile = path.join(temporary, 'keywords/authoring/field_data_zh.json');
            const localized = JSON.parse(fs.readFileSync(localizedFile));
            const localizedField = localized[selected.keyword].c[selected.card].find(field => field.n === selected.field.n);
            assert.ok(localizedField.h.startsWith(selected.field.h));
            localizedField.h = replacement + localizedField.h.slice(selected.field.h.length);
            fs.writeFileSync(localizedFile, JSON.stringify(localized));
            const trackedSchema = path.join(root, 'keywords/runtime/schema/field_data.json');
            const priorSchemaHash = sha(fs.readFileSync(trackedSchema));
            const stage = path.join(temporary, 'out/data-build');
            const result = rebuild(temporary, stage);
            const helpManifest = 'keywords/runtime/native-help/manifest.json';
            assert.equal(JSON.parse(result.outputs.get(helpManifest)).catalogSha256,
                sha(result.outputs.get('keywords/runtime/input-form/manifest.json')));
            assert.equal(JSON.parse(result.outputs.get('keywords/runtime/native-help/native-null-help.manifest.json')).catalogSha256,
                sha(result.outputs.get(helpManifest)));
            fs.cpSync(path.join(stage, 'out/runtime'), path.join(temporary, 'out/runtime'), { recursive: true });
            const nativeRelative = 'keywords/runtime/native-readers/lspp-native-input-format.json';
            assert.deepEqual(result.outputs.get(nativeRelative), fs.readFileSync(path.join(root, nativeRelative)));
            const cardIdentityKey = "cardSetId";
            const check = `const assert=require('node:assert/strict'),fs=require('node:fs');
                const {keywordDataPath}=require('./out/core/keywordDataPath');
                const schema=require('./out/core/keywordSchema');
                const data=schema.loadKeywordSchema();
                const field=data[${JSON.stringify(selected.keyword)}].c[${selected.card}].find(f=>f.n===${JSON.stringify(selected.field.n)});
                assert.equal(schema.getEnglishFieldHelp(field),${JSON.stringify(replacement)});
                assert.ok(keywordDataPath('schema/field_data.json').includes('data-build'));
                const rules=JSON.parse(fs.readFileSync(keywordDataPath('native-readers/lspp-native-input-format.json')));
                const [keyword,binding]=Object.entries(rules.bindings)[0];
                const api=require('./out/core/semantics/nativeInputFormat');
                const identityKey=${JSON.stringify(cardIdentityKey)};
                assert.equal(api.nativeReadInputFailure({[identityKey]:binding[identityKey]},'*'+keyword+'%','long'),
                    'native-mixed-global-long-local-i10-flags-unimplemented');
                assert.equal(api.nativeReadInputFailure({[identityKey]:'unreviewed'},'*'+keyword+'%','long'),undefined);`;
            execFileSync(process.execPath, ['-e', check], { cwd: temporary, windowsHide: true, stdio: 'pipe' });
            assert.equal(sha(fs.readFileSync(trackedSchema)), priorSchemaHash);
        } finally {
            assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
            fs.rmSync(temporary, { recursive: true, force: true });
        }
    });
});
