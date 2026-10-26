'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const {execFileSync}=require('node:child_process');
const source='2f68e32bd74e5552461501e42010199112bbf7b4';
function outsideViewer(text){
 const tree=ts.createSourceFile('sessions.ts',text,ts.ScriptTarget.Latest,true);let member;
 for(const statement of tree.statements)if(ts.isClassDeclaration(statement)&&statement.name?.text==='ProjectSessions')member=statement.members.find(m=>ts.isMethodDeclaration(m)&&m.name.getText(tree)==='fileView');
 assert.ok(member,'Missing reviewed viewer method');
 return (text.slice(0,member.getStart(tree))+'REVIEWED_VIEWER'+text.slice(member.end)).replace(/\r\n/g,'\n');
}
function validate(run,target,changes,before,after){
 assert.equal(run.headSha,source);assert.equal(run.headBranch,'dev');assert.equal(run.event,'workflow_dispatch');assert.equal(run.status,'completed');assert.equal(run.workflowName,'Public collaboration / 公开协作');
 assert.ok(run.jobs.some(j=>j.name.startsWith('Build, data, tests, audit and actual VSIX')&&j.name.endsWith(`${target})`)&&j.conclusion==='success'));
 const allowed=new Set(['src/worker/projectSessions.ts','test/worker/projectSessions.test.js','test/host/editor-safety/extension-host/index.js','scripts/release/resume-viewer-tests.cjs','test/scripts/release/viewerRecovery.test.js','.github/workflows/public-ci.yml','public-source-manifest.json']);
 for(const f of changes)assert.ok(allowed.has(f),`Unreviewed recovery change: ${f}`);
 assert.equal(outsideViewer(before),outsideViewer(after),'Non-viewer product logic changed');
}
function main(){
 const runId=process.env.UNIT_RESUME_RUN,repo=process.env.GITHUB_REPOSITORY,target=process.env.EXPECTED_TARGET;
 assert.equal(runId,'38373457591');assert.ok(repo);assert.equal(process.env.GITHUB_REF,'refs/heads/dev');assert.equal(target,process.platform+'-'+process.arch);
 const command=(exe,args)=>execFileSync(exe,args,{encoding:'utf8',maxBuffer:64*1024**2,timeout:180000});
 const run=JSON.parse(command('gh',['run','view',runId,'--repo',repo,'--json','headSha,headBranch,event,status,workflowName,jobs']));
 command('git',['merge-base','--is-ancestor',source,'HEAD']);
 const file='src/worker/projectSessions.ts';
 validate(run,target,command('git',['diff','--name-only',source,'HEAD']).trim().split('\n'),command('git',['show',`${source}:${file}`]),fs.readFileSync(file,'utf8'));
 const directory='.artifacts/unit-recovery';fs.mkdirSync(directory,{recursive:true});
 command('gh',['run','download',runId,'--repo',repo,'--name',`unit-recovery-${target}`,'--dir',directory+'/prior']);
 const proof=JSON.parse(fs.readFileSync(directory+'/prior/reused.json'));
 assert.equal(proof.current,source);assert.equal(proof.target,target);assert.equal(proof.run,'38366233304');assert.equal(proof.passing,{'win32-x64':4051,'linux-x64':4322,'darwin-arm64':4050}[target]);
 const raw=fs.readFileSync(directory+'/prior/current.log','utf8'),prior=JSON.parse(raw.slice(raw.indexOf('{\n  "stats"')));assert.equal(prior.stats.passes,6);assert.equal(prior.stats.failures,0);
 const output=command(process.execPath,['node_modules/mocha/bin/mocha.js','--require','test/support/register-out.js','test/worker/projectSessions.test.js','test/scripts/release/viewerRecovery.test.js','--fail-zero','--reporter','json']);
 fs.writeFileSync(directory+'/current.log',output);
 const current=JSON.parse(output.slice(output.indexOf('{\n  "stats"')));assert.equal(current.stats.failures,0);assert.ok(current.passes.some(t=>t.title==='reopens an unpublished viewer invalidated during scanning, but rejects repeated invalidation'));
 fs.writeFileSync(directory+'/reused.json',JSON.stringify({source,run:runId,target,current:process.env.GITHUB_SHA,prior:proof,correctedPriorPasses:6,currentPasses:current.stats.passes,scope:'Only fileView product method changed; project session suite rerun; all other unit/data inputs unchanged'},null,2));
}
if(require.main===module)main();
module.exports={source,outsideViewer,validate};
