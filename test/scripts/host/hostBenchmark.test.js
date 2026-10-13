'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const repo = path.resolve(__dirname, '../../..');
const create = require('../../support/tempDirectories.js').trackTempDirectories();

describe('host benchmark evidence contracts', function () {
    this.timeout(10000); // Synthetic child reports; no real host timing claim.
    function scenario(kind, mode = 'passed') {
        const root = create(path.join(os.tmpdir(), 'host-benchmark-test-'));
        const baseline = path.join(root,'baseline.vsix'), candidate = path.join(root,'candidate.vsix'), output = path.join(root,'report.json');
        fs.writeFileSync(baseline,'synthetic baseline'); fs.writeFileSync(candidate,'synthetic candidate');
        const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        const editor = kind === 'editor', calls = [];
        if (mode.startsWith('resume-') || mode === 'fixed-wrong-version') {
            fs.writeFileSync(output,JSON.stringify({ identities:{baseline:hash(baseline),candidate:hash(candidate)},
                samples: mode.startsWith('resume-') ? [{ version:'1.100.0', phase:'activation',run:0,name:'baseline',
                    result:mode==='resume-missing-version'?{}:{vscodeVersion:'1.139.1'} }] : [], failures:[] }));
        }
        const fixed = path.join(root,'fixed.json');
        if (mode === 'fixed-wrong-version') fs.writeFileSync(fixed,JSON.stringify({identities:{baseline:hash(baseline)},
            samples:[{ version:'1.100.0',phase:'activation',run:0,name:'baseline',result:{vscodeVersion:'1.139.1'} }],failures:[]}));
        const relative = editor ? 'scripts/benchmark/benchmark-editor-hosts.cjs' : 'scripts/benchmark/benchmark-release-hosts.cjs';
        const script = path.join(repo,relative);
        const proc = {argv:[process.execPath,script,baseline,candidate,output,...(mode==='fixed-wrong-version'?[fixed]:[])],execPath:process.execPath,
            env:mode.startsWith('phase-')?{LSDYNA_PERFORMANCE_PHASE:mode.slice(6)}:{}};
        const context = {__dirname:path.dirname(script),process:proc,console:{log(){},error(){}},require(name){
            if(name==='node:fs')return {...fs,existsSync(file){
                if(editor&&String(file).endsWith('Code.exe'))return mode!=='missing-executable';
                return fs.existsSync(file);
            }};
            if(name==='node:child_process')return {spawnSync(_node,args,{env}){
                calls.push({args,env});
                const requested = editor ? /archive-(\d+\.\d+\.\d+)/.exec(env.VSCODE_EXECUTABLE_PATH)[1] : '1.100.0';
                const phase=args[1],metric=name=>({name,durationMs:1,maxEventLoopGapMs:1,peakRss:100,memoryAfter:{rss:100}});
                const metrics=[metric('activation'), ...(phase === 'experience'
                    ? ['first-manager-rendered','manual-open','scan',...Array(2).fill('manager-refresh')]
                    : ['first-'+phase, ...Array(2).fill(phase === 'hover' ? 'warm-hover' : 'warm-manager-command')]).map(metric)];
                const result={status:'passed',vscodeVersion:mode==='wrong-version'?'0.0.0':requested,
                    functionalChecksPassed:true,metrics,warmSampleCount:2,warmMaxMs:1,peakRssBytes:100};
                if(mode==='empty-metrics')result.metrics=[];
                if(mode==='missing-metrics')delete result.metrics;
                if(mode==='wrong-phase-metrics')result.metrics=result.metrics.filter(item=>item.name==='activation');
                const file=path.join(root,`host-${calls.length}.json`);fs.writeFileSync(file,JSON.stringify(result));
                return {status:0,stdout:`Release host result: ${file}\n`,stderr:''};
            }};
            return require(name);
        }};
        let error;
        try{vm.runInNewContext(fs.readFileSync(script,'utf8'),context,{filename:script});}catch(caught){error=caught;}
        return {report:fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):null,error,calls,exitCode:proc.exitCode};
    }
    it('uses the repository download directory and binds each launch to its requested host version',()=>{
        const result=scenario('editor');
        assert.equal(result.error,undefined);assert.equal(result.report.complete,true);assert.equal(result.calls.length,32);
        for(const {env} of result.calls){
            const version=/archive-(\d+\.\d+\.\d+)/.exec(env.VSCODE_EXECUTABLE_PATH)[1];
            assert.equal(env.VSCODE_EXECUTABLE_PATH,path.join(repo,`.vscode-test/vscode-win32-x64-archive-${version}/Code.exe`));
            assert.equal(env.VSCODE_TEST_VERSION,version);
        }
    });
    it('refuses a freshly measured host with the wrong actual version',()=>{
        const result=scenario('editor','wrong-version');
        assert.equal(result.report.complete,false);assert.equal(result.exitCode,1);
        assert.ok(result.report.failures.length>0);
        assert.ok(result.report.failures.every(row=>row.kind==='functional'));
    });
    it('refuses an incomplete cached host archive before launching benchmark children',()=>{
        const result=scenario('editor','missing-executable');
        assert.match(result.error?.message||'',/executable is missing/);assert.equal(result.calls.length,0);
    });
    for(const mode of ['resume-wrong-version','resume-missing-version','fixed-wrong-version']){
        it(`rejects ${mode} rows before launching hosts`,()=>{
            const result=scenario('editor',mode);
            assert.match(result.error?.message||'',/actual host version/i);assert.equal(result.calls.length,0);
        });
    }
    for(const mode of ['empty-metrics','missing-metrics','wrong-phase-metrics']){
        it(`rejects release samples with ${mode} despite a passed status and two warm samples`,()=>{
            const result=scenario('release',mode);
            assert.equal(result.report.complete,false);assert.equal(result.exitCode,1);
            assert.ok(result.report.failures.length>0);
        });
    }
    it('keeps complete release samples and 12 alternating launches, without claiming percentiles',()=>{
        const result=scenario('release');
        assert.equal(result.error,undefined);assert.equal(result.report.complete,true);assert.equal(result.calls.length,12);
        assert.ok(result.report.metrics.length>0);
        assert.ok(result.report.metrics.every(item=>item.statistic==='maximum' && !('percentile' in item)));
    });
    it('runs four paired launches for one phase without certifying complete performance',()=>{
        for(const phase of ['hover','manager','experience']) {
            const result=scenario('release','phase-'+phase);
            assert.equal(result.error,undefined);assert.equal(result.exitCode,undefined);
            assert.equal(result.calls.length,4);assert.ok(result.calls.every(call=>call.args[1]===phase));
            assert.equal(result.report.complete,false);assert.equal(result.report.selectedPhasesPassed,true);
            assert.deepEqual(result.report.phases,[phase]);
        }
        const invalid=scenario('release','phase-typo');
        assert.match(invalid.error.message,/Unknown performance phase/);assert.equal(invalid.calls.length,0);
    });
    it('observes a ready frame while an unrelated frame evaluation remains pending',async()=>{
        let listener, releaseSlow, closed=false;
        const slow=new Promise(resolve=>{releaseSlow=resolve;});
        const script=path.join(repo,'test/support/release/rendered.cjs');
        const context={module:{exports:{}},setTimeout,require(name){
            assert.equal(name,'../devtools.cjs');
            return {fetchJson:async()=>({webSocketDebuggerUrl:'synthetic'}),
                openSocket:async()=>({addEventListener(_event,callback){listener=callback;}}),
                createCdp:()=>({close(){closed=true;},async call(method,params,session){
                    if(method==='Target.getTargets')return {targetInfos:[{type:'page',targetId:'slow'},{type:'iframe',targetId:'ready'}]};
                    if(method==='Target.attachToTarget')return {sessionId:params.targetId};
                    if(method==='Runtime.enable'){
                        listener({data:JSON.stringify({method:'Runtime.executionContextCreated',sessionId:session,params:{context:{id:1}}})});
                        return {};
                    }
                    assert.equal(method,'Runtime.evaluate');
                    return session==='slow'?slow:{result:{value:true}};
                }})};
        }};
        vm.runInNewContext(fs.readFileSync(script,'utf8'),context,{filename:script});
        const renderer=await context.module.exports.connect(1234);
        const waiting=renderer.wait('actual readiness predicate');
        try {
            const result=await Promise.race([waiting,new Promise(resolve=>setImmediate(()=>resolve(null)))]);
            assert.equal(result?.sessionId,'ready','An unrelated pending evaluation delayed the ready view');
        } finally {
            releaseSlow({result:{value:false}});await waiting;renderer.close();
        }
        assert.equal(closed,true);
    });
});
