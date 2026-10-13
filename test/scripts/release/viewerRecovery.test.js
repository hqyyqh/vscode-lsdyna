'use strict';
const assert=require('node:assert/strict');
const {source,validate,outsideViewer}=require('../../../scripts/release/resume-viewer-tests.cjs');
describe('viewer recovery provenance',()=>{
 const target='linux-x64',text='class ProjectSessions { open(){ return 1; } private async fileView(){ return 1; } }';
 const run=()=>({headSha:source,headBranch:'dev',event:'workflow_dispatch',status:'completed',workflowName:'Public collaboration / 公开协作',jobs:[{name:`Build, data, tests, audit and actual VSIX (ubuntu-22.04, ${target})`,conclusion:'success'}]});
 it('permits only the reviewed viewer method and requires successful source checks',()=>{
  const next=text.replace('fileView(){ return 1','fileView(){ return 2');validate(run(),target,['src/worker/projectSessions.ts'],text,next);
  assert.throws(()=>validate(run(),target,['src/extension.ts'],text,next));
  assert.throws(()=>validate(run(),target,[],text,next.replace('open(){ return 1','open(){ return 2')));
  for(const override of [{headSha:'wrong'},{status:'in_progress'},{jobs:[]}])assert.throws(()=>validate({...run(),...override},target,[],text,next));
  assert.throws(()=>outsideViewer('class Other {}'));
 });
});
