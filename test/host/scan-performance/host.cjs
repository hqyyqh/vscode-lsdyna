'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vscode=require('vscode');
exports.run=async()=>{
    const evidence=process.env.SCAN_HOST_EVIDENCE, source=process.env.SCAN_HOST_MODEL;
    const extension=vscode.extensions.getExtension('hqyyqh.dynasense');assert.ok(extension);await extension.activate();
    const entry=path.join(extension.extensionPath,'out/extension.js');
    const loaded=Object.keys(require.cache).find(file=>file.toLowerCase()===entry.toLowerCase());
    const api=(loaded?require.cache[loaded].exports:require(entry))._internals;
    const prototype=api.LsdynaIncludeTreeProvider.prototype, original=prototype.acceptStructure, originalScan=prototype.scan;
    const result={vscode:vscode.version,extension:extension.extensionPath,checks:[],samples:[],status:'running'};
    let start=0,structureMs=null,latest=null,cancelNext=false,cancelAt=0,maxGap=0,previous=performance.now();
    prototype.scan=function(...args){latest=this;return originalScan.apply(this,args);};
    prototype.acceptStructure=function(...args){ latest=this; const value=original.apply(this,args);structureMs=performance.now()-start;
        if(cancelNext){cancelNext=false;cancelAt=performance.now();this.clearProjectSnapshot();}return value; };
    let timer;
    try{
        const document=await vscode.workspace.openTextDocument(source);await vscode.window.showTextDocument(document);
        await new Promise(resolve=>setTimeout(resolve,500));
        previous=performance.now();timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;},5);
        let snapshot;
        for(let i=0;i<31;i++){
            start=performance.now();structureMs=null;
            const scan=await vscode.commands.executeCommand('extension.scanIncludeTree');
            result.samples.push({ms:performance.now()-start,structureMs});
            assert.ok(scan?.snapshot?.fileIndexes?.size>=2);snapshot=scan.snapshot;
        }
        clearInterval(timer);result.scanMaxEventLoopGapMs=maxGap;
        assert.equal(latest.scanPhase,'complete');assert.ok(latest.root?.children?.length);
        result.checks.push('real Include command, early tree, full result, 30 warm repeats');
        const curve=[...snapshot.fileIndexes.values()].flatMap(index=>index.referenceDefinitions?.curves||[])[0];
        assert.ok(curve?.id,'The fixture must contain an independently scanned curve definition');
        const query=await vscode.commands.executeCommand('extension.queryLsdynaEntityId',{targetKind:'curve',id:String(curve.id)});
        assert.ok(query?.locations?.length>0,'Representative curve definition/references must be found');
        result.query={id:String(curve.id),state:query.state,locations:query.locations.length};result.checks.push('object reference query');
        const tempFile=path.join(evidence,'workspace','cancel.key');fs.copyFileSync(source,tempFile);
        const changed=await vscode.workspace.openTextDocument(tempFile);await vscode.window.showTextDocument(changed);
        cancelNext=true;start=performance.now();
        const cancelled=await vscode.commands.executeCommand('extension.scanIncludeTree');
        assert.ok(cancelAt);assert.ok(!cancelled);result.cancelMs=performance.now()-cancelAt;
        assert.ok(result.cancelMs<=500,'Cancellation must settle within 500 ms');
        result.checks.push('clear invalidates active scan without late tree/result refill');
        // A later edit must rebuild the root file rather than reuse its former signature.
        await vscode.window.showTextDocument(changed);const edit=new vscode.WorkspaceEdit();edit.insert(changed.uri,new vscode.Position(0,0),'$ scan invalidation test\n');
        assert.ok(await vscode.workspace.applyEdit(edit));await changed.save();
        const refreshed=await vscode.commands.executeCommand('extension.scanIncludeTree');
        assert.equal(refreshed.snapshot.rootFile.toLowerCase(),tempFile.toLowerCase());
        assert.equal(refreshed.snapshot.fileIndexes.get(refreshed.snapshot.rootFile).size,fs.statSync(tempFile).size);
        result.checks.push('saved edit invalidation and recovery');
        const warm=result.samples.slice(1).map(s=>s.ms).sort((a,b)=>a-b);
        result.warmP95=warm[Math.ceil(warm.length*.95)-1];
        result.gates={cold:result.samples[0].ms<=10000,tree:result.samples[0].structureMs!==null&&result.samples[0].structureMs<=3000,warm:result.warmP95<=1000,eventLoop:result.scanMaxEventLoopGapMs<=100};
        result.status=Object.values(result.gates).every(Boolean)?'passed':'failed';
        assert.equal(result.status,'passed',JSON.stringify(result.gates));
    }catch(error){result.status='failed';result.error=String(error);throw error;
    }finally{clearInterval(timer);prototype.acceptStructure=original;prototype.scan=originalScan;fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2));}
};
