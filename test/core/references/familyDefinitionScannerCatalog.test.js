const assert=require('assert');
const {familyDefinitionKeywords,loadFamilyDefinitionScannerCatalog}=require('../../../out/core/references/familyDefinitionScannerCatalog');
describe('familyDefinitionScannerCatalog',()=>{
 it('preserves each approved source value domain without granting solver or completeness approval',()=>{
  const zlib=require('node:zlib'),fs=require('node:fs');
  const source=JSON.parse(zlib.gunzipSync(fs.readFileSync(require('node:path').resolve(__dirname,'../../../keywords/sources/definition-scanners/authoring.json.gz'))));
  const catalog=loadFamilyDefinitionScannerCatalog();
  for(const descriptor of [...source.handoff.descriptors,...source.exact.descriptors])assert.deepEqual(catalog.byKeyword.get(descriptor.keyword).valueDomain,descriptor.valueDomain,descriptor.keyword);
  assert.equal(catalog.byKeyword.get('MAT_024').valueDomain.nonNumericRequiresPLabel,true);
  assert.equal(catalog.permission('completenessClaimPermission'),false);
 });
 it('loads the bounded source-locked gzip catalog',()=>{const c=loadFamilyDefinitionScannerCatalog();assert.equal(c.descriptors.length,1678);assert.equal(c.summary.base,861);assert.equal(c.summary.title,817);assert.equal(c.summary.labelCapable,1659);assert.equal(c.summary.integerOnly,19);assert.equal(c.summary.exact,5);assert.equal(c.permission('scannerExecutionPermission'),true);assert.equal(c.permission('definitionProviderPermission'),true);assert.equal(c.permission('referenceProviderPermission'),true);assert.equal(c.permission('definitionRegistryPermission'),true);assert.equal(c.permission('completenessClaimPermission'),false)});
 it('opens only the proved navigation catalog while completeness remains closed',()=>{const approved=familyDefinitionKeywords();const runtime=approved.onDemand;assert.equal(Object.keys(runtime).length,1678);assert.strictEqual(familyDefinitionKeywords(),approved);const candidateCatalog=familyDefinitionKeywords({allowCandidate:true});const candidate=candidateCatalog.onDemand;assert.strictEqual(familyDefinitionKeywords({allowCandidate:true}),candidateCatalog);assert.equal(Object.keys(candidate).length,1678);assert.equal(candidate.MAT_024.dataRecordOrdinal,0);assert.equal(candidate.MAT_024_TITLE.dataRecordOrdinal,1);assert.equal(candidate.DEFINE_COORDINATE_SYSTEM.targetToken,'*DEFINE_COORDINATE_SYSTEM')});
});
