'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => Buffer.from(JSON.stringify(canonical(value)) + '\n');
const read = file => JSON.parse(fs.readFileSync(file));

function within(root, relative) {
    assert.equal(typeof relative, 'string');
    assert.ok(relative && !relative.includes('\\') && !path.isAbsolute(relative) &&
        relative.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe data path: ${relative}`);
    const location = path.resolve(root, relative);
    assert.ok(location.startsWith(path.resolve(root) + path.sep), `Data path escaped root: ${relative}`);
    return location;
}

function write(root, relative, bytes) {
    const target = within(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
}

function encode(value, storage = {}) {
    const logical = storage.sorted ? canonical(value) : value;
    const raw = Buffer.from(JSON.stringify(logical, null, storage.indent || undefined) + (storage.newline ? '\n' : ''));
    return { raw, bytes: storage.gzip ? zlib.gzipSync(raw, { level: 9, mtime: 0 }) : raw };
}

function readSources(root = ROOT) {
    const manifest = read(path.join(root, 'keywords/sources/manifest.json'));
    assert.equal(manifest.kind, 'dynasense-portable-data-sources');
    assert.equal(manifest.schemaVersion, 1);
    const bundles = {};
    // Manual and semantic compilation consume the schema; manifest inventory order is not a dependency contract.
    for (const item of [...manifest.bundles].sort((a, b) =>
        (a.bundle === 'schema' ? 0 : 1) - (b.bundle === 'schema' ? 0 : 1))) {
        assert.ok(['schema','references','structure-v2','categories','native-readers','native-help','input-form',
            'manual-semantics','semantic-v2','snippets'].includes(item.bundle),`Unknown source bundle: ${item.bundle}`);
        assert.equal(item.outputRoot,item.bundle==='snippets'?'snippets':`keywords/runtime/${item.bundle}`);
        assert.ok(!bundles[item.bundle], `Duplicate source bundle: ${item.bundle}`);
        const location = within(root, item.path);
        assert.equal(fs.lstatSync(location).isSymbolicLink(), false, 'Symlink source checkpoint');
        assert.ok(fs.realpathSync(location).startsWith(fs.realpathSync(root) + path.sep), 'Source checkpoint escaped checkout');
        const bytes = fs.readFileSync(location);
        assert.equal(sha(bytes), item.sha256, `Source checkpoint changed: ${item.path}`);
        const decoded = zlib.gunzipSync(bytes, { maxOutputLength: 768 * 1024 * 1024 });
        assert.equal(sha(decoded), item.contentSha256, `Logical source checkpoint changed: ${item.path}`);
        bundles[item.bundle] = JSON.parse(decoded);
    }
    const compilerInputs = {};
    for (const item of manifest.compilerInputs || []) {
        const location = within(root, item.path);
        assert.equal(fs.lstatSync(location).isSymbolicLink(), false, 'Symlink compiler input');
        assert.ok(fs.realpathSync(location).startsWith(fs.realpathSync(root)+path.sep),'Compiler input escaped checkout');
        const bytes = fs.readFileSync(location);
        assert.equal(sha(bytes), item.sha256, `Compiler input changed: ${item.path}`);
        const decoded = item.path.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes;
        assert.equal(sha(decoded), item.contentSha256, `Compiler logical input changed: ${item.path}`);
        compilerInputs[item.path] = JSON.parse(decoded);
    }
    return { manifest, bundles, compilerInputs };
}

function applyHelpCorrections(schema, corrections) {
    assert.equal(corrections.schemaVersion, 1);
    assert.ok(Array.isArray(corrections.fields));
    const touched = new Set();
    for (const item of corrections.fields) {
        assert.deepEqual(Object.keys(item).sort(), ['card', 'english', 'field', 'keyword', 'sourceHelpSha256']);
        assert.ok(Number.isSafeInteger(item.card) && item.card >= 0 && typeof item.english === 'string' && item.english.trim());
        const card = schema[item.keyword]?.c?.[item.card];
        const matches = card?.filter(field => field.n === item.field) || [];
        assert.equal(matches.length, 1, `Help correction requires one exact field: ${item.keyword}.${item.field}`);
        const key = `${item.keyword}/${item.card}/${item.field}`;
        assert.ok(!touched.has(key), `Duplicate help correction: ${key}`);
        touched.add(key);
        assert.equal(sha(Buffer.from(matches[0].h || '')), item.sourceHelpSha256, `English source drift: ${key}`);
        matches[0].h = item.english;
    }
    return schema;
}

function validateEngineeringSource(value, approved, name) {
    // Editorial notes do not grant engineering authority. Every other property,
    // including source evidence, selectors and permissions, retains its reviewed identity.
    const authority = source => {
        const {notes, ...core} = source;
        return canonical(core);
    };
    assert.deepEqual(authority(value),authority(approved),
        `Engineering authority changed; requires-independent-validation: ${name}`);
}

function engineeringRuntimeBytes(bytes) {
    const source = JSON.parse(bytes);
    if (!Object.hasOwn(source, 'notes')) return bytes;
    const { notes, ...authority } = source;
    return Buffer.from(JSON.stringify(authority, null, 2) + '\n');
}

// Repartition semantic records using the production generator's SHA-256 keyword buckets.
function semanticPayloads(bundle, destination) {
    const generator = require('../generate-semantic-runtime-v2.cjs');
    const scannerGroups = generator.groupedByPrefix(bundle.scanners, record => record.keyword);
    const descriptors = [
        ...[...generator.groupedByPrefix(bundle.references, record => record.field.keyword)].map(([prefix, records]) =>
            generator.writeShard(destination, 'references', prefix, records, scannerGroups.get(prefix))),
        ...[...generator.groupedByPrefix(bundle.options, record => record.targets[0]?.spelling || record.canonicalSectionId)].map(([prefix, records]) =>
            generator.writeShard(destination, 'options', prefix, records)),
    ];
    return descriptors.map(item => ({path:item.path, value:JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(destination,item.path)))),
        storage:{gzip:true,sorted:true}}));
}

function updateDescriptors(value, descriptors) {
    if (Array.isArray(value)) return value.map(item => updateDescriptors(item, descriptors));
    if (!value || typeof value !== 'object') return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, updateDescriptors(item, descriptors)]));
    const descriptor = descriptors.get(value.path || value.file);
    if (descriptor) {
        for (const key of ['sha256', 'compressedBytes', 'uncompressedBytes']) if (key in value) next[key] = descriptor[key];
        for (const key of ['uncompressedSha256', 'contentSha256']) if (key in value) next[key] = descriptor.contentSha256;
    }
    return next;
}

function rebuild(root = ROOT, destination) {
    assert.ok(destination && path.resolve(destination) !== path.resolve(root), 'Build into a separate stage');
    const { manifest, bundles, compilerInputs } = readSources(root);
    const outputs = new Map();
    const bindingObservations = [];
    const inputs = { 'keywords/sources/manifest.json': sha(fs.readFileSync(path.join(root, 'keywords/sources/manifest.json'))) };
    for (const source of manifest.bundles) inputs[source.path] = source.sha256;
    for (const source of manifest.compilerInputs || []) inputs[source.path] = source.sha256;
    const engineeringAuthority = compilerInputs[manifest.engineeringAuthorityInput];
    assert.equal(engineeringAuthority?.kind,'derived-approved-engineering-rule-baseline');
    assert.equal(engineeringAuthority.schemaVersion,1);
    for (const name of ['keywordSpellingAliases','keywordLayoutCorrections','runtimeSemanticRelationCorrections','runtimeTableLayoutCorrections']) {
        const file = `keywords/authoring/engineering/${name}.json`;
        validateEngineeringSource(read(path.join(root,file)),
            engineeringAuthority.rules[name],name);
        inputs[file] = sha(fs.readFileSync(path.join(root,file)));
        outputs.set(`keywords/runtime/engineering/${name}.json`,engineeringRuntimeBytes(fs.readFileSync(path.join(root,file))));
    }
    for (const [file,bytes] of outputs) write(destination,file,bytes);
    // The compiled schema helper imports native reader modules eagerly. Give each
    // stage its own verified checkpoint inputs before loading that helper.
    for (const [name,bundle] of Object.entries(bundles)) if (name!=='semantic-v2') {
        for (const item of bundle.payloads) write(destination,`${bundle.outputRoot}/${item.path}`,encode(item.value,item.storage).bytes);
        if (bundle.manifest) write(destination,`${bundle.outputRoot}/manifest.json`,encode(bundle.manifest.value,bundle.manifest.storage).bytes);
    }
    const coreRoot = path.resolve(root,'out/core');
    const buildGenerators = ['generate-field-reference-index.cjs','generate-manual-semantic-runtime.cjs'];
    for (const file of Object.keys(require.cache)) if (file.startsWith(coreRoot+path.sep) ||
        buildGenerators.some(name=>file===require.resolve(`../${name}`))) delete require.cache[file];
    const paths = require(path.join(coreRoot,'keywordDataPath'));
    paths.setKeywordDataRootForBuild(path.join(destination,'keywords/runtime'));
    try {
    const authoring = ['field_data_zh.json', 'native_field_help_zh.json', 'manual_semantics_zh.json', 'field-help-corrections.json'];
    for (const name of authoring) {
        const file = `keywords/authoring/${name}`;
        inputs[file] = sha(fs.readFileSync(path.join(root, file)));
    }
    for (const contract of manifest.compatibility || []) {
        const bytes = fs.readFileSync(within(root, contract.path));
        assert.equal(sha(bytes), contract.sha256, `Compatibility source changed; review and publish a new baseline: ${contract.path}`);
        inputs[contract.path] = contract.sha256;
    }
    for (const [name, bundle] of Object.entries(bundles)) {
        const base = bundle.outputRoot;
        const payloads = name === 'semantic-v2' ? semanticPayloads(bundle, path.join(destination,base)) : bundle.payloads;
        const descriptors = new Map();
        for (const item of payloads) {
            let value = name === 'schema' && item.path === 'field_data.json'
                ? applyHelpCorrections(structuredClone(item.value), read(path.join(root, 'keywords/authoring/field-help-corrections.json'))) : item.value;
            if (name === 'manual-semantics') {
                const generator = require('../generate-manual-semantic-runtime.cjs');
                const schema = JSON.parse(outputs.get('keywords/runtime/schema/field_data.json'));
                const keywordSchema = require(path.join(coreRoot,'keywordSchema'));
                value = { ...value, rules: value.rules.map(rule => {
                    const compiled = generator.compileRule(rule, schema, keywordSchema);
                    assert.ok(compiled.rule, `Approved manual rule no longer binds: ${rule.ruleId} (${compiled.blocked?.reason})`);
                    if (rule.selector) {
                        for (const key of ['cardIndex','fieldIndex','fieldName','fieldType']) assert.equal(compiled.rule.selector[key],rule.selector[key],
                            `Manual binding identity changed; independent validation required: ${rule.ruleId}.${key}`);
                        if (JSON.stringify(canonical(compiled.rule.selector)) !== JSON.stringify(canonical(rule.selector)))
                            bindingObservations.push({ruleId:rule.ruleId,sourceSelector:rule.selector,computedSelector:compiled.rule.selector,
                                state:'requires-independent-validation',runtimeSelector:'unchanged-source-selector'});
                        return {...compiled.rule,selector:rule.selector};
                    }
                    return compiled.rule;
                }) };
            }
            if (name === 'structure-v2') {
                const generator = require('../generate-keyword-structure-runtime-v2.cjs');
                for (const grammar of Object.values(value.grammars)) generator.validateGrammar(grammar);
            }
            const { raw, bytes } = encode(value, item.storage);
            const file = `${base}/${item.path}`;
            outputs.set(file, bytes);
            descriptors.set(item.path, { sha256: sha(bytes), contentSha256: sha(raw), compressedBytes: bytes.length, uncompressedBytes: raw.length });
        }
        if (bundle.manifest) {
            const projected = updateDescriptors(bundle.manifest.value, descriptors);
            if (name === 'manual-semantics') {
                projected.fieldSchema = {file:'keywords/runtime/schema/field_data.json',sha256:sha(outputs.get('keywords/runtime/schema/field_data.json'))};
                projected.runtimeId = sha(Buffer.from([manifest.bundles.find(item=>item.bundle===name).contentSha256,
                    projected.fieldSchema.sha256,sha(fs.readFileSync(require.resolve('../generate-manual-semantic-runtime.cjs')))].join('\n')));
            }
            if (name === 'semantic-v2') {
                projected.source.fieldDataSha256 = sha(outputs.get('keywords/runtime/schema/field_data.json'));
                projected.source.prefixLayoutSha256 = sha(outputs.get('keywords/runtime/schema/keyword_prefix_layouts.json'));
                projected.datasetReleaseId = `semantic-dataset:${sha(Buffer.from(JSON.stringify(canonical({source:projected.source,
                    referenceShards:projected.referenceShards,optionShards:projected.optionShards,
                    referenceKeywordIndex:projected.referenceKeywordIndex,optionSpellingIndex:projected.optionSpellingIndex})))).slice(0,24)}`;
                const {contentSha256,...core} = projected;
                projected.contentSha256 = sha(Buffer.from(JSON.stringify(canonical(core))));
            }
            outputs.set(`${base}/manifest.json`, encode(projected, bundle.manifest.storage).bytes);
        }
    }
    // Bind the generated help to the actual published catalog. The source checkpoint
    // retains its original producer catalog pin; this is a current consumer binding.
    const helpRoot = 'keywords/runtime/native-help';
    const helpBundle = bundles['native-help'];
    const helpManifest = JSON.parse(outputs.get(`${helpRoot}/manifest.json`));
    helpManifest.catalogSha256 = sha(outputs.get('keywords/runtime/input-form/manifest.json'));
    outputs.set(`${helpRoot}/manifest.json`, encode(helpManifest, helpBundle.manifest.storage).bytes);
    const supplement = helpBundle.payloads.find(item => item.path === 'native-null-help.manifest.json');
    const supplementSource = JSON.parse(outputs.get(`${helpRoot}/${supplement.path}`));
    const supplementBytes = outputs.get(`${helpRoot}/${supplementSource.file}`);
    const supplementDecoded = zlib.gunzipSync(supplementBytes);
    const supplementManifest = updateDescriptors(supplementSource, new Map([[supplementSource.file, {
        sha256: sha(supplementBytes), contentSha256: sha(supplementDecoded),
        compressedBytes: supplementBytes.length, uncompressedBytes: supplementDecoded.length,
    }]]));
    supplementManifest.catalogSha256 = sha(outputs.get(`${helpRoot}/manifest.json`));
    outputs.set(`${helpRoot}/${supplement.path}`, encode(supplementManifest, supplement.storage).bytes);
    for (const [file, bytes] of outputs) write(destination, file, bytes);
    const registrySource = compilerInputs['keywords/sources/definition-registry/authoring.json.gz'];
    const registryGenerator = require('../generate-definition-registry.cjs');
    const registry = registryGenerator.buildRegistry(registrySource, registrySource.authorityLock, registrySource.authorityLockSha256);
    registryGenerator.validateRegistry(registry, registrySource.authorityLock);
    outputs.set('keywords/runtime/definitions/definition_registry.json', Buffer.from(JSON.stringify(registry,null,2)+'\n'));
    const scannerSource = compilerInputs['keywords/sources/definition-scanners/authoring.json.gz'];
    const scanner = require('../generate-family-definition-scanner-runtime.cjs').buildRuntime(scannerSource.handoff,scannerSource.approval,scannerSource.exact);
    outputs.set('keywords/runtime/definitions/family_definition_scanner.runtime.json.gz', encode(scanner,{gzip:true,sorted:true}).bytes);
    const referenceGenerator = require('../generate-field-reference-index.cjs');
    const manual = referenceGenerator.readManualRuntime(path.join(destination,'keywords/runtime/manual-semantics'));
    const handoffPath = 'keywords/sources/semantic-inputs/lspp_reference_handoff.json.gz';
    const handoff = compilerInputs[handoffPath];
    const index = referenceGenerator.buildIndex(JSON.parse(outputs.get('keywords/runtime/schema/field_data.json')),manual.rules,
        {runtimeId:manual.manifest.runtimeId,manifestSha256:manual.manifestSha256,lsppHandoffSha256:inputs[handoffPath]},handoff,
        require(path.join(coreRoot,'keywordSchema')));
    index.lsppBlockedReferences = referenceGenerator.writeBlockedRuntime(index.blockedReferences,
        path.join(destination,'keywords/runtime/references/lspp_reference_blockers.runtime.json.gz'));
    delete index.blockedReferences;
    outputs.set('keywords/runtime/references/field_reference_index.json',Buffer.from(JSON.stringify(index,null,2)+'\n'));
    outputs.set('keywords/runtime/references/lspp_reference_blockers.runtime.json.gz',fs.readFileSync(path.join(destination,'keywords/runtime/references/lspp_reference_blockers.runtime.json.gz')));
    for (const [file, bytes] of outputs) write(destination,file,bytes);
    const schemaFile = 'keywords/runtime/schema/field_data.json';
    const schemaGenerator = require('../generate-field-schema-runtime.cjs');
    schemaGenerator.generateFieldSchemaRuntime({ inputPath: path.join(destination, schemaFile),
        schemaOutputPath: path.join(destination, 'out/runtime/field_schema.runtime.json.gz') });
    const helpGenerator = require('../generate-field-help-runtime.cjs');
    helpGenerator.generateFieldHelpRuntime({ englishPath: path.join(destination, schemaFile),
        localizedPath: path.join(root, 'keywords/authoring/field_data_zh.json'),
        textTranslationsPath: path.join(root, 'keywords/authoring/native_field_help_zh.json'),
        manualSemanticsPath: path.join(root, 'keywords/authoring/manual_semantics_zh.json'),
        outputDirectory: path.join(destination, 'out/runtime/field_help') });
    const inputFormGenerator = require('../generate-lspp-input-form-runtime.cjs');
    const inputForm = inputFormGenerator.projectRuntimeManifest(outputs.get('keywords/runtime/input-form/manifest.json'));
    write(destination,'out/runtime/lspp-input-form/manifest.json',inputForm);
    const derived = new Map();
    function collect(directory) {
        for (const item of fs.readdirSync(directory,{withFileTypes:true})) {
            const file = path.join(directory,item.name);
            if (item.isDirectory()) collect(file);
            else derived.set(path.relative(destination,file).split(path.sep).join('/'),fs.readFileSync(file));
        }
    }
    collect(path.join(destination,'out/runtime'));
    const compilerTools = Object.fromEntries(['keywords/data.cjs','generate-field-schema-runtime.cjs','generate-field-help-runtime.cjs',
        'generate-field-help-zh-delta.cjs','generate-semantic-runtime-v2.cjs','generate-manual-semantic-runtime.cjs',
        'generate-keyword-structure-runtime-v2.cjs','generate-definition-registry.cjs','generate-family-definition-scanner-runtime.cjs',
        'generate-field-reference-index.cjs','generate-lspp-input-form-runtime.cjs']
        .map(file=>[`scripts/build/${file}`,sha(fs.readFileSync(path.join(__dirname,'..',file)))]));
    for (const file of Object.keys(require.cache)) if (file.startsWith(coreRoot+path.sep) && file.endsWith('.js')) {
        const relative = `src/core/${path.relative(coreRoot,file).slice(0,-3).split(path.sep).join('/')}.ts`;
        assert.ok(fs.existsSync(within(root,relative)),`Compiler source missing: ${relative}`);
        compilerTools[relative] = sha(fs.readFileSync(within(root,relative)));
    }
    const lineage = { schemaVersion: 1, kind: 'dynasense-local-data-projection',
        sourceIdentity: manifest.sourceIdentity, verification: { logicalCheckpointIntegrity: true,
            externalProducerReplay: 'unverified', sourcePermissions: 'inherited-from-unchanged-verified-checkpoints',
            manualBindingObservations:bindingObservations },
        inputs, tools: compilerTools,
        derived: Object.fromEntries([...derived].sort(([a],[b])=>a.localeCompare(b)).map(([file,bytes])=>[file,sha(bytes)])),
        outputs: Object.fromEntries([...outputs].sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => [file, sha(bytes)])) };
    write(destination, 'keywords/provenance/current-data.json', json(lineage));
    return { outputs, derived, lineage };
    } finally { paths.setKeywordDataRootForBuild(); }
}

function compare(a, b) {
    assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), 'Generated data file set changed');
    for (const [file, bytes] of a) assert.equal(sha(bytes), sha(b.get(file)), `Non-deterministic data: ${file}`);
}

function runtimeFiles(root) {
    const files = [];
    const visit = relative => {
        const directory = within(root,relative);
        if (!fs.existsSync(directory)) return;
        for (const item of fs.readdirSync(directory,{withFileTypes:true})) {
            assert.equal(item.isSymbolicLink(),false,'Symlink runtime artifact');
            const file = `${relative}/${item.name}`;
            if (item.isDirectory()) visit(file); else files.push(file);
        }
    };
    visit('keywords/runtime');
    if (fs.existsSync(within(root,'snippets/lsdyna.json'))) files.push('snippets/lsdyna.json');
    return files.sort();
}

function obsolete(root, outputs) {
    const previous = within(root,'keywords/provenance/current-data.json');
    const owned = fs.existsSync(previous) ? read(previous).outputs : {};
    const deletions = new Map();
    for (const file of runtimeFiles(root)) if (!outputs.has(file)) {
        assert.ok(Object.hasOwn(owned,file),`Unlisted runtime artifact; review before removing: ${file}`);
        assert.equal(sha(fs.readFileSync(within(root,file))),owned[file],`Obsolete generated artifact was edited: ${file}`);
        deletions.set(file,null);
    }
    return deletions;
}

// Complete both rebuilds before changing any tracked artifact. Restore the previous
// file set if publishing fails; authoring and source checkpoints never enter this set.
function publish(root, outputs, backupRoot, {derived = false} = {}) {
    fs.mkdirSync(root,{recursive:true});
    const changed = [];
    try {
        for (const [file,bytes] of outputs) {
            assert.ok(file.startsWith('keywords/runtime/') || file === 'snippets/lsdyna.json' ||
                file === 'keywords/provenance/current-data.json' || (derived && file.startsWith('out/runtime/')),
                `Not a generated artifact: ${file}`);
            const target = within(root,file);
            let parent = path.dirname(target);
            while (!fs.existsSync(parent)) parent = path.dirname(parent);
            const actual = fs.realpathSync(parent), resolved = fs.realpathSync(root);
            assert.ok(actual===resolved || actual.startsWith(resolved+path.sep),'Output escaped checkout');
            if (fs.existsSync(target)) {
                assert.equal(fs.lstatSync(target).isSymbolicLink(),false,'Symlink generated artifact');
                write(backupRoot,file,fs.readFileSync(target));
            }
            changed.push({file,existed:fs.existsSync(target)});
            if (bytes === null) fs.rmSync(target,{force:true});
            else {
                fs.mkdirSync(path.dirname(target),{recursive:true});
                fs.writeFileSync(`${target}.data-next`,bytes); fs.renameSync(`${target}.data-next`,target);
            }
        }
    } catch(error) {
        for (const item of changed.reverse()) {
            if (item.existed) write(root,item.file,fs.readFileSync(within(backupRoot,item.file)));
            else fs.rmSync(within(root,item.file),{force:true});
            fs.rmSync(`${within(root,item.file)}.data-next`,{force:true});
        }
        throw error;
    }
}

function main(args = process.argv.slice(2), root = ROOT) {
    assert.equal(args.length, 1, 'Use --build, --update or --check');
    assert.ok(['--build', '--update', '--check'].includes(args[0]));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-data-'));
    try {
        const a = rebuild(root, path.join(temporary, 'a'));
        const b = rebuild(root, path.join(temporary, 'b'));
        compare(a.outputs, b.outputs);
        compare(a.derived,b.derived);
        assert.deepEqual(a.lineage, b.lineage, 'Non-deterministic lineage');
        if (args[0] === '--check') {
            assert.deepEqual(runtimeFiles(root),[...a.outputs.keys()].filter(file=>file.startsWith('keywords/runtime/')||file==='snippets/lsdyna.json').sort(),
                'Runtime file set differs from declared generated outputs');
            for (const [file, bytes] of a.outputs) assert.equal(sha(fs.readFileSync(within(root, file))), sha(bytes), `Generated data is stale: ${file}`);
            assert.deepEqual(read(path.join(root, 'keywords/provenance/current-data.json')), a.lineage, 'Data lineage is stale');
        } else if (args[0] === '--build') {
            const target = path.join(root, 'out/data-build');
            const stale = obsolete(target,a.outputs);
            const oldStageLineage = path.join(target,'keywords/provenance/current-data.json');
            if (fs.existsSync(oldStageLineage)) for (const [file,digest] of Object.entries(read(oldStageLineage).derived || {})) {
                assert.ok(file.startsWith('out/runtime/'),'Unsafe derived stage path');
                if (!a.derived.has(file) && fs.existsSync(within(target,file))) {
                    assert.equal(sha(fs.readFileSync(within(target,file))),digest,`Obsolete derived stage artifact was edited: ${file}`);
                    stale.set(file,null);
                }
            }
            publish(target,new Map([...stale,...a.outputs,...a.derived,
                ['keywords/provenance/current-data.json',json(a.lineage)]]),path.join(temporary,'stage-rollback'),{derived:true});
        } else {
            publish(root,new Map([...obsolete(root,a.outputs),...a.outputs,['keywords/provenance/current-data.json',json(a.lineage)]]),path.join(temporary,'rollback'));
            for (const [file, bytes] of a.derived) write(root,file,bytes);
        }
        return a.lineage;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (require.main === module) try { const result = main(); console.log(JSON.stringify({ generatedFiles: Object.keys(result.outputs).length,
    localProjection: 'verified', externalProducerReplay: result.verification.externalProducerReplay })); }
catch (error) { console.error(error.message); process.exitCode = 1; }
module.exports = { rebuild, readSources, applyHelpCorrections, compare, main, canonical, encode, updateDescriptors, publish,
    obsolete, runtimeFiles, validateEngineeringSource, engineeringRuntimeBytes };
