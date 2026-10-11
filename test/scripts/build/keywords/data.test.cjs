'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { applyHelpCorrections, publish, obsolete, readSources,validateEngineeringSource, engineeringRuntimeBytes } = require('../../../../scripts/build/keywords/data.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('rebinds legacy form shard paths to the actual compressed and decoded bytes', () => {
    const { updateDescriptors } = require('../../../../scripts/build/keywords/data.cjs');
    const original = { file: 'card_conditions.v4/shard.json.gz', sha256: 'old', uncompressedSha256: 'content', compressedBytes: 20, uncompressedBytes: 30 };
    const result = updateDescriptors(original, new Map([['shard.json.gz', { sha256: 'new', contentSha256: 'content', compressedBytes: 21, uncompressedBytes: 30 }]]));
    assert.deepEqual(result, { ...original, sha256: 'new', compressedBytes: 21 });
    assert.equal(original.sha256, 'old');
});

test('generated gzip bytes are independent of the Windows, Unix and macOS header marker', () => {
    const compress = require('../../../../scripts/build/deterministic-gzip.cjs');
    const original = zlib.gzipSync, source = Buffer.from('same generated engineering data');
    let expected;
    try {
        for (const host of [3, 10, 19]) {
            zlib.gzipSync = (...args) => { const bytes = original(...args); bytes[9] = host; return bytes; };
            const actual = compress(source, { level: 9 });
            assert.equal(actual[9], 255);
            assert.deepEqual(zlib.gunzipSync(actual), source);
            if (expected) assert.deepEqual(actual, expected);
            expected = actual;
        }
    } finally { zlib.gzipSync = original; }
});

test('native definition namespaces rebind explicit targets without changing signed, contextual or permission semantics', () => {
    const { rebindReferenceNamespaces } = require('../../../../scripts/build/keywords/data.cjs');
    const source = { kind: 'entity-reference', sourceRuleId: 'original', field: { keyword: '*ICFD_PART', fieldName: 'SECID' },
        relation: { kind: 'entity-reference', targetKeywords: ['*ICFD_SECTION'], targetKinds: ['section'], transform: 'abs', when: { lt: 0 } },
        permissions: { mutate: false }, contextualReferenceBranch: { gate: 'retained' }, evidence: [{ evidenceId: 'original-evidence' }] };
    const compatible = { ...source, relation: { targetKeywords: ['*DEFINE_FUNCTION'], targetKinds: ['curve'] } };
    const unknown = { ...source, relation: { targetKeywords: ['*UNKNOWN'], targetKinds: ['section'] } };
    const handoff = { contentSha256: 'fixture', definitions: { ICFD_SECTION: { targetKind: 'icfd-section' }, DEFINE_FUNCTION: { targetKind: 'function' } } };
    const observations = [];
    const [fixed, functionRelation, unresolved] = rebindReferenceNamespaces([source, compatible, unknown], handoff, observations);
    assert.deepEqual(fixed.relation, { ...source.relation, targetKinds: ['icfd-section'] });
    for (const key of ['field', 'permissions', 'contextualReferenceBranch', 'evidence', 'sourceRuleId']) assert.deepEqual(fixed[key], source[key]);
    assert.deepEqual(source.relation.targetKinds, ['section']);
    assert.strictEqual(functionRelation, compatible);
    assert.strictEqual(unresolved, unknown);
    assert.equal(observations.length, 1);
    const manual = { kind: source.kind, ruleId: 'manual-rule', keyword: '*ICFD_PART', field: 'SECID',
        selector: { cardIndex: 1, position: 10 }, relation: source.relation };
    const [manualFixed] = rebindReferenceNamespaces([manual], handoff, observations);
    assert.deepEqual(manualFixed.relation.targetKinds, ['icfd-section']);
    assert.deepEqual(manualFixed.selector, manual.selector);
    assert.equal(observations[1].sourceRuleId, 'manual-rule');
    assert.deepEqual(JSON.parse(JSON.stringify(observations)), observations);
    const mixed = { ...source, relation: { targetKeywords: ['*ICFD_SECTION', '*DEFINE_FUNCTION'], targetKinds: ['section'] } };
    const conflicts = [];
    assert.strictEqual(rebindReferenceNamespaces([mixed], handoff, observations, conflicts)[0], mixed);
    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0].candidateTargetKinds, ['icfd-section', 'function']);
});

test('editorial engineering notes retain the actual classifier correction map', () => {
    require('../../../support/register-out.js');
    const baselineBytes = fs.readFileSync(path.resolve(__dirname,
        '../../../../keywords/authoring/engineering/runtimeTableLayoutCorrections.json'));
    const approved = JSON.parse(baselineBytes);
    const withNotes = { ...approved, notes: 'Contributor review discussion; no new authority.' };
    validateEngineeringSource(withNotes, approved, 'runtimeTableLayoutCorrections');
    const generated = JSON.parse(engineeringRuntimeBytes(Buffer.from(JSON.stringify(withNotes))));
    assert.deepEqual(generated, approved);
    assert.ok(!Object.hasOwn(generated, 'notes'));
    assert.deepEqual(engineeringRuntimeBytes(baselineBytes), baselineBytes);
    const { buildRuntimeTableLayoutIndex } = require('../../../../out/core/references/fieldReferenceClassifier');
    const runtime = require('../../../../out/core/semantics/semanticRuntimeV2').getSemanticRuntimeCatalogV2();
    const keyword = '*DUALCESE_BOUNDARY_PRESCRIBED_HYBRID_SEGMENT_SET';
    const expected = buildRuntimeTableLayoutIndex(keyword, runtime, approved);
    assert.equal(expected.size, 10);
    assert.deepEqual(buildRuntimeTableLayoutIndex(keyword, runtime, generated), expected);
});

test('source inventory order cannot put a schema consumer before its verified schema', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-source-order-'));
    try {
        const bundles = ['manual-semantics', 'schema'].map(bundle => {
            const decoded = Buffer.from(JSON.stringify({ outputRoot: `keywords/runtime/${bundle}`, payloads: [] }));
            const bytes = zlib.gzipSync(decoded), relative = `keywords/sources/${bundle}/logical.json.gz`;
            fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
            fs.writeFileSync(path.join(root, relative), bytes);
            return { bundle, outputRoot: `keywords/runtime/${bundle}`, path: relative,
                sha256: sha(bytes), contentSha256: sha(decoded) };
        });
        const source = { schemaVersion: 1, kind: 'dynasense-portable-data-sources', bundles };
        const manifestPath = path.join(root, 'keywords/sources/manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(source));
        const first = readSources(root).bundles;
        assert.equal(Object.keys(first)[0], 'schema');
        source.bundles.reverse();
        fs.writeFileSync(manifestPath, JSON.stringify(source));
        assert.deepEqual(readSources(root).bundles, first);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retained compiler inputs remain validated and consumed inputs use the verified byte snapshot',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dynasense-compiler-inputs-'));
    try {
        const directory=path.join(root,'keywords/sources');fs.mkdirSync(directory,{recursive:true});
        const inputs=['current','historical'].map(name=>{
            const decoded=Buffer.from(JSON.stringify({name,values:[1,2,3]})),bytes=zlib.gzipSync(decoded),relative=`keywords/sources/${name}.json.gz`;
            fs.writeFileSync(path.join(root,relative),bytes);return {path:relative,sha256:sha(bytes),contentSha256:sha(decoded)};
        });
        fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,kind:'dynasense-portable-data-sources',bundles:[],compilerInputs:inputs}));
        const snapshot=readSources(root).compilerInputs;
        fs.writeFileSync(path.join(root,inputs[0].path),zlib.gzipSync(Buffer.from('{"name":"replaced"}')));
        assert.deepEqual(snapshot[inputs[0].path],{name:'current',values:[1,2,3]});
        assert.strictEqual(snapshot[inputs[0].path],snapshot[inputs[0].path]);
        assert.throws(()=>readSources(root),/Compiler input changed/);
        const invalid=Buffer.from('{invalid JSON'),invalidBytes=zlib.gzipSync(invalid);
        fs.writeFileSync(path.join(root,inputs[0].path),invalidBytes);
        inputs[0].sha256=sha(invalidBytes);inputs[0].contentSha256=sha(invalid);
        fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,kind:'dynasense-portable-data-sources',bundles:[],compilerInputs:inputs}));
        assert.throws(()=>readSources(root),SyntaxError);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('local engineering notes carry no inherited authority and source/layout/reference/permission edits fail closed',()=>{
    const approved = {sourceSha256:'original',corrections:[{field:{type:'integer',width:10},targetKind:'part'}],permissions:{nativeWritePermission:false}};
    validateEngineeringSource({...approved,notes:'Local review discussion'},approved,'engineering');
    for (const edit of [
        value=>{value.sourceSha256='unverified';},
        value=>{value.nativeWritePermission=true;},
        value=>{value.corrections[0].field.width=20;},
        value=>{value.corrections[0].field.type='real';},
        value=>{value.corrections[0].targetKind='node';},
    ]) {
        const changed = structuredClone(approved);edit(changed);
        assert.throws(()=>validateEngineeringSource(changed,approved,'engineering'),/requires-independent-validation/);
    }
});

test('a help correction changes exactly the matched text and retains engineering permissions', () => {
    const schema = { NODE:{c:[[{n:'NID',h:'Node identifier',t:'integer',p:0,w:10,nativeStaticBinding:true}]]} };
    const original = structuredClone(schema);
    const correction = {keyword:'NODE',card:0,field:'NID',sourceHelpSha256:sha('Node identifier'),english:'Unique node identifier'};
    applyHelpCorrections(schema,{schemaVersion:1,fields:[correction]});
    original.NODE.c[0][0].h = correction.english;
    assert.deepEqual(schema,original);
    assert.throws(()=>applyHelpCorrections(schema,{schemaVersion:1,fields:[correction]}),/English source drift/);
    assert.throws(()=>applyHelpCorrections(schema,{schemaVersion:1,fields:[{...correction,nativeWritePermission:true}]}));
    assert.throws(()=>applyHelpCorrections(schema,{schemaVersion:1,fields:[{...correction,field:'OTHER'}]}),/one exact field/);
});

test('the reviewed EPS0SF correction preserves its full field contract and bilingual source', () => {
    const root = path.resolve(__dirname, '../../../..');
    const schema = readSources(root).bundles.schema.payloads.find(item => item.path === 'field_data.json').value;
    const original = structuredClone(schema);
    const corrections = JSON.parse(fs.readFileSync(path.join(root, 'keywords/authoring/field-help-corrections.json')));
    applyHelpCorrections(schema, corrections);
    const english = 'Optional scale factor on permittivity, ε_0. See Remark 6.';
    assert.equal(schema.EM_CONTROL.c[0][5].n, 'EPS0SF');
    assert.equal(schema.EM_CONTROL.c[0][5].h, english);
    original.EM_CONTROL.c[0][5].h = english;
    assert.deepEqual(schema, original);
    const localized = JSON.parse(fs.readFileSync(path.join(root, 'keywords/authoring/field_data_zh.json')));
    assert.equal(localized.EM_CONTROL.c[0][5].h, `${english}\n介电率 ε_0 的可选比例因子。参见备注 6。`);
});

test('stale cleanup removes only previously owned unchanged generated artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'dynasense-stale-test-'));
    try {
        const file = 'keywords/runtime/schema/obsolete.json';
        fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});
        fs.writeFileSync(path.join(root,file),'old');
        fs.mkdirSync(path.join(root,'keywords/provenance'),{recursive:true});
        fs.writeFileSync(path.join(root,'keywords/provenance/current-data.json'),JSON.stringify({outputs:{[file]:sha('old')}}));
        assert.deepEqual([...obsolete(root,new Map())],[[file,null]]);
        publish(root,obsolete(root,new Map()),path.join(root,'backup'));
        assert.equal(fs.existsSync(path.join(root,file)),false);
        fs.writeFileSync(path.join(root,file),'unreviewed');
        assert.throws(()=>obsolete(root,new Map()),/Obsolete generated artifact was edited/);
        const extra='keywords/runtime/schema/unlisted.json';
        fs.writeFileSync(path.join(root,extra),'unlisted');
        assert.throws(()=>obsolete(root,new Map([[file,Buffer.from('unreviewed')]])),/Unlisted runtime artifact/);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('source integrity fails before compilation when checkpoint bytes change', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'dynasense-source-test-'));
    try {
        fs.mkdirSync(path.join(root,'keywords/sources/schema'),{recursive:true});
        fs.writeFileSync(path.join(root,'keywords/sources/schema/logical.json.gz'),'tampered');
        fs.writeFileSync(path.join(root,'keywords/sources/manifest.json'),JSON.stringify({schemaVersion:1,
            kind:'dynasense-portable-data-sources',bundles:[{bundle:'schema',outputRoot:'keywords/runtime/schema',
                path:'keywords/sources/schema/logical.json.gz',sha256:sha('original')}]}));
        assert.throws(()=>readSources(root),/Source checkpoint changed/);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('a compiler input cannot escape through a parent directory junction', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'dynasense-source-escape-test-'));
    const root=path.join(temporary,'root'), outside=path.join(temporary,'outside');
    try {
        fs.mkdirSync(path.join(root,'keywords/sources'),{recursive:true}); fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside,'input.json'),'{}');
        const junction = path.join(root,'keywords/sources/junction');
        fs.symlinkSync(outside,junction,process.platform==='win32'?'junction':'dir');
        fs.writeFileSync(path.join(root,'keywords/sources/manifest.json'),JSON.stringify({schemaVersion:1,
            kind:'dynasense-portable-data-sources',bundles:[],compilerInputs:[{
                path:'keywords/sources/junction/input.json',sha256:sha('{}'),contentSha256:sha('{}')}]}));
        assert.throws(()=>readSources(root),/Compiler input escaped checkout/);
        fs.unlinkSync(junction);
    } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('publishing fails closed outside generated output roots and restores prior artifacts', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'dynasense-publish-test-'));
    try {
        const root = path.join(temporary,'root'), backup = path.join(temporary,'backup');
        fs.mkdirSync(path.join(root,'keywords/runtime/schema'),{recursive:true});
        const original = path.join(root,'keywords/runtime/schema/field_data.json');
        fs.writeFileSync(original,'original');
        assert.throws(()=>publish(root,new Map([
            ['keywords/runtime/schema/field_data.json',Buffer.from('replacement')],
            ['keywords/authoring/field_data_zh.json',Buffer.from('must not write')],
        ]),backup),/Not a generated artifact/);
        assert.equal(fs.readFileSync(original,'utf8'),'original');
        assert.equal(fs.existsSync(path.join(root,'keywords/authoring/field_data_zh.json')),false);
        assert.equal(fs.existsSync(`${original}.data-next`),false);
    } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
});

test('derived publication rejects parent junctions before mutating otherwise valid outputs', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-derived-boundary-'));
    const root = path.join(temporary, 'root'), outside = path.join(temporary, 'outside');
    try {
        fs.mkdirSync(path.join(root, 'out/runtime'), { recursive: true }); fs.mkdirSync(outside);
        const first = path.join(root, 'out/runtime/first.json'); fs.writeFileSync(first, 'original');
        const link = path.join(root, 'out/runtime/external');
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => publish(root, new Map([
            ['out/runtime/first.json', Buffer.from('replacement')],
            ['out/runtime/external/other.json', Buffer.from('escaped')],
        ]), undefined, { derived: true }), /Output escaped checkout/);
        assert.equal(fs.readFileSync(first, 'utf8'), 'original');
        assert.deepEqual(fs.readdirSync(outside), []);
        fs.unlinkSync(link);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
