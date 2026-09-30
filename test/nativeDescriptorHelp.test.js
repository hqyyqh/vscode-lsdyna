'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'), crypto=require('node:crypto'), zlib=require('node:zlib');
const { nativeDescriptorHelp }=require('../out/core/semantics/nativeDescriptorHelp');
const { getCatalogInputFormCatalogV4 }=require("../out/core/semantics/catalogInputFormCatalogV4");
const { fakeDoc }=require('./helpers');
const schema=require('../out/core/keywordSchema');
const { LsdynaFieldHoverProvider }=require('../out/extension')._internals;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

describe('native descriptor help authority',()=>{
    it('prepares native help asynchronously, rejects tampering and allows retry', async () => {
        const manifest = JSON.parse(fs.readFileSync('keywords/lspp-field-help/manifest.json'));
        const descriptor = Object.values(manifest.shards)[0];
        const fields = JSON.parse(zlib.gunzipSync(fs.readFileSync('keywords/lspp-field-help/' + descriptor.file)));
        const [address, value] = Object.entries(fields).find(([, field]) => typeof field.help === 'string');
        const field = { fieldRecordId: address, name: value.name, type: value.type };
        const modulePath = require.resolve('../out/core/semantics/nativeDescriptorHelp');
        delete require.cache[modulePath];
        const fresh = require(modulePath);
        const read = fs.promises.readFile;
        fs.promises.readFile = async (...args) => {
            const bytes = await read.apply(fs.promises, args);
            return String(args[0]).endsWith(descriptor.file) ? Buffer.concat([bytes, Buffer.from('bad')]) : bytes;
        };
        try { await assert.rejects(fresh.prepareNativeDescriptorHelp([field]), /hash mismatch/); }
        finally { fs.promises.readFile = read; }
        await Promise.all([fresh.prepareNativeDescriptorHelp([field]), fresh.prepareNativeDescriptorHelp([field])]);
        assert.equal(fresh.nativeDescriptorHelp(field), value.help);
        assert.equal(fresh.nativeDescriptorHelp({ ...field, name: 'wrong identity' }), undefined);
    });
    it('serializes the native reader type -2 as text, including legal commas',()=>{
        
        const { writeRecordField }=require('../out/core/edit/keywordRecordSerializer');
        const field={name:'TEXT',type:-2,position:0,width:20};
        assert.equal(writeRecordField(' '.repeat(20),[field],0,'a,b','standard'),'a,b'.padEnd(20));
    });
    it('validates every help shard and its published catalog identity',()=>{
        const root='keywords/lspp-field-help/';
        const manifest=JSON.parse(fs.readFileSync(root+'manifest.json','utf8'));
        assert.equal(manifest.catalogSha256,sha(fs.readFileSync('keywords/lspp-input-form/manifest.json')));
        const supplement=JSON.parse(fs.readFileSync(root+'native-null-help.manifest.json'));
        assert.equal(supplement.catalogSha256,sha(fs.readFileSync(root+'manifest.json')));
        const supplementBytes=fs.readFileSync(root+supplement.file);
        assert.equal(sha(supplementBytes),supplement.sha256);
        const supplementFields=JSON.parse(zlib.gunzipSync(supplementBytes)).fields;
        let count=0;
        for(const descriptor of Object.values(manifest.shards)){
            const encoded=fs.readFileSync(root+descriptor.file),decoded=zlib.gunzipSync(encoded);
            assert.equal(sha(encoded),descriptor.sha256);assert.equal(sha(decoded),descriptor.uncompressedSha256);
            assert.equal(decoded.length,descriptor.uncompressedBytes);
            for(const [fieldRecordId,field] of Object.entries(JSON.parse(decoded))){
                assert.equal(nativeDescriptorHelp({...field,fieldRecordId}),
                    field.help===null?supplementFields[fieldRecordId]?.help:field.help);
                count++;
            }
        }
        assert.equal(count,manifest.fields);assert.equal(count,29557);
        assert.equal(nativeDescriptorHelp({fieldRecordId:"record:4b406e2a862b77b1bf7aac6a:148aebe659272edfda9e7a08",name:'OTHER',type:1}),undefined);
    });
    it('uses LSPP help and enums in both the manager catalog and actual editor hover',async()=>{
        const form=getCatalogInputFormCatalogV4().formForKeyword('MAT_DAMAGE_1');
        const native=form.rules[form.reference.formRuleIds[0]].cards[1].fields[7];
        assert.deepEqual(native.choices,['0','-1','1']);
        assert.ok(native.help.includes('EQ.-1. Anisotropic damage'));
        assert.ok(!native.help.includes('EQ.10'));
        const doc={...fakeDoc('*MAT_DAMAGE_1\n'+' '.repeat(80)+'\n'+' '.repeat(79)+'0'),version:1};
        const resolution=schema.resolveCardForDocumentLine(doc,2,undefined,{keywordLine:0,globalInputFormat:'standard'});
        const field=resolution.cardInfo.card[7];
        assert.deepEqual(field.e,native.choices);
        assert.equal(schema.getEnglishFieldHelp(field),native.help);
        assert.equal(field.nativeIdentity,undefined,'definition identity does not grant a native file/edit binding');
        const hover=await new LsdynaFieldHoverProvider().provideHover(doc,{line:2,character:75});
        assert.ok(hover?.contents[0].value.includes('**FLAG**'));
    });
    it('does not let a native default grant automatic trailing omission to a previously required field',()=>{
        const { nativeFieldDefinitions }=require('../out/core/semantics/nativeFieldDefinitions');
        const form=getCatalogInputFormCatalogV4().formForKeyword('MAT_DAMAGE_1');
        const native=form.rules[form.reference.formRuleIds[0]].cards[1].fields;
        const card=native.map(f=>({n:f.name,p:f.position,w:f.width}));
        const projected=nativeFieldDefinitions('MAT_DAMAGE_1',{},card);
        assert.equal(projected[7].d,native[7].defaultValue);
        assert.equal(projected[7].definitionSource.alignmentMayOmit,false);
        const { analyzeTabLineInterpretation }=require('../out/extension')._internals;
        const alignmentCard=[0,1,2].map(index=>({n:`F${index}`,p:index*10,w:10,t:'integer',d:0}));
        assert.equal(analyzeTabLineInterpretation('1 2',alignmentCard).status,'repairable');
        alignmentCard[2].definitionSource=projected[7].definitionSource;
        assert.equal(analyzeTabLineInterpretation('1 2',alignmentCard).status,'ambiguous');
    });
});
