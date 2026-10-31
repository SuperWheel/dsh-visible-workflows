import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureFileEvidence, compareFileEvidence, createNativeFileReadCollector, evaluateFileEvidence, type NativeReadExecution } from '../src/host/file-evidence.ts'
import { makeWorkflow } from '../src/shared/types.ts'
import { parseWorkflow } from '../src/shared/workflow-validation.ts'

const directories:string[]=[]
afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true})})
async function fixture(files:Record<string,string|Uint8Array>={}){const root=await mkdtemp(join(tmpdir(),'workflow-file-evidence-'));directories.push(root);for(const [path,value] of Object.entries(files))await writeFile(join(root,path),value);return root}
const signal=()=>new AbortController().signal
const exec=(root:string,overrides:Partial<NativeReadExecution>={}):NativeReadExecution=>({name:'read',arguments:{file_path:'source.txt'},token:Symbol('read'),agent:{id:'task',session:{header:{cwd:root}}},...overrides})
const result=(root:string,lines:string[],offset=1,totalLines=lines.length)=>({value:{path:join(root,'source.txt'),offset,totalLines,lines:lines.map((text,index)=>({number:offset+index,text}))}})
async function reader(root:string){const snapshot=await captureFileEvidence(root,{requiredReadFiles:['source.txt']},signal());return{snapshot,collector:createNativeFileReadCollector({workspaceRoot:root,taskId:'task',snapshot,trustedTools:{read:'dsh-tool-fs/read@0.2.0-rc.2',str_replace_editor:'dsh-tool-str-replace-editor/view@0.2.0-rc.2'}})}}

describe('trusted workspace file evidence',()=>{
  it('stores only fingerprints and detects required content changes, creation, unchanged rewrites and deletion',async()=>{
    const root=await fixture({'existing.txt':'old'}),requirements={requiredFiles:['existing.txt'],requiredChangedFiles:['existing.txt','created.txt']},before=await captureFileEvidence(root,requirements,signal())
    expect(before.files['created.txt']!.status).toBe('missing');expect(JSON.stringify(before)).not.toContain('old')
    await writeFile(join(root,'existing.txt'),'old');await utimes(join(root,'existing.txt'),new Date(),new Date())
    let after=await captureFileEvidence(root,requirements,signal())
    expect(evaluateFileEvidence(requirements,before,after)).toMatchObject({status:'failed'})
    await writeFile(join(root,'existing.txt'),'new');await writeFile(join(root,'created.txt'),'artifact')
    after=await captureFileEvidence(root,requirements,signal());expect(evaluateFileEvidence(requirements,before,after).status).toBe('passed')
    await rm(join(root,'existing.txt'));expect(evaluateFileEvidence(requirements,before,await captureFileEvidence(root,requirements,signal())).status).toBe('failed')
  })
  it('blocks traversal, absolute paths, directories and both outside and inside symlinks without certifying them',async()=>{
    const root=await fixture({'safe.txt':'inside'}),outside=await fixture({'outside.txt':'outside'})
    await mkdir(join(root,'dir'));await symlink(join(outside,'outside.txt'),join(root,'escape'));await symlink(join(root,'safe.txt'),join(root,'alias'));await symlink(outside,join(root,'parent'))
    const files=['../outside.txt',join(outside,'outside.txt'),'dir','escape','alias','parent/outside.txt','{{input.path}}'],snapshot=await captureFileEvidence(root,{requiredFiles:files},signal())
    for(const path of files)expect(snapshot.files[path]?.status,path).toBe('unverified')
    expect(evaluateFileEvidence({requiredFiles:files},snapshot,snapshot).status).toBe('unverified')
  })
  it('bounds reads, handles absent nested parents and respects cancellation',async()=>{
    const root=await fixture({'huge.txt':''});await truncate(join(root,'huge.txt'),4*1024*1024+1)
    const snapshot=await captureFileEvidence(root,{requiredFiles:['huge.txt','absent/nested.txt']},signal())
    expect(snapshot.files['huge.txt']).toMatchObject({status:'unverified',reason:expect.stringContaining('读取上限')});expect(snapshot.files['absent/nested.txt']!.status).toBe('missing')
    const abort=new AbortController();abort.abort(new Error('cancel evidence'))
    await expect(captureFileEvidence(root,{requiredFiles:['huge.txt']},abort.signal)).rejects.toThrow('cancel evidence')
  })
  it('never turns readable files or a model claim into evidence that the Agent read them',async()=>{
    const root=await fixture({'source.txt':'sensitive fixture content'}),requirements={requiredReadFiles:['source.txt']},snapshot=await captureFileEvidence(root,requirements,signal())
    expect(evaluateFileEvidence(requirements,snapshot,snapshot)).toMatchObject({status:'unverified',reasons:[expect.stringContaining('模型自述不能证明已读')]})
    const untrusted=createNativeFileReadCollector({workspaceRoot:root,taskId:'task',snapshot})
    untrusted.record(exec(root),result(root,['sensitive fixture content']))
    expect(untrusted.receipts()[0]!.status).toBe('unverified');expect(JSON.stringify(untrusted.receipts())).not.toContain('sensitive fixture content')
  })
  it('invalidates restored caches when fingerprints change, disappear, appear or cannot be verified',async()=>{
    const root=await fixture({'source.txt':'first'}),requirements={requiredFiles:['source.txt']},original=await captureFileEvidence(root,requirements,signal())
    expect(compareFileEvidence(original,await captureFileEvidence(root,requirements,signal())).valid).toBe(true)
    await writeFile(join(root,'source.txt'),'other');expect(compareFileEvidence(original,await captureFileEvidence(root,requirements,signal()))).toMatchObject({valid:false,changedPaths:['source.txt'],reasons:[expect.stringContaining('内容已变化')]})
    await rm(join(root,'source.txt'));const missing=await captureFileEvidence(root,requirements,signal());expect(compareFileEvidence(original,missing).reasons[0]).toContain('已缺失')
    await writeFile(join(root,'source.txt'),'first');expect(compareFileEvidence(missing,await captureFileEvidence(root,requirements,signal())).reasons[0]).toContain('从缺失变为存在')
    expect(compareFileEvidence(undefined,original).valid).toBe(false)
    const otherRoot=await fixture({'source.txt':'first'});expect(compareFileEvidence(original,await captureFileEvidence(otherRoot,requirements,signal())).valid).toBe(false)
  })
})

describe('native file read receipts (actual SDK contract, simulated host events)',()=>{
  it('certifies complete same-task read results and paginated content, but retains no document content',async()=>{
    const root=await fixture({'source.txt':'first\r\nsecond\r\n'}),{snapshot,collector}=await reader(root)
    collector.record(exec(root,{arguments:{file_path:'source.txt',offset:2,limit:1}}),result(root,['second'],2,2))
    expect(collector.receipts()[0]!.status).toBe('unverified')
    collector.record(exec(root,{arguments:{file_path:'source.txt',offset:1,limit:1}}),result(root,['first'],1,2))
    expect(collector.receipts()[0]).toMatchObject({status:'passed',calls:2,tools:['read'],sha256:snapshot.files['source.txt']!.sha256})
    expect(JSON.stringify(collector.receipts())).not.toContain('first')
    expect(evaluateFileEvidence({requiredReadFiles:['source.txt']},snapshot,snapshot,collector.receipts()).status).toBe('passed')
  })
  it('ignores other tasks, failed reads and fabricated read_file names',async()=>{
    const root=await fixture({'source.txt':'text'}),{collector}=await reader(root)
    collector.record(exec(root,{agent:{id:'other',session:{header:{cwd:root}}}}),result(root,['text']))
    collector.record(exec(root),{...result(root,['text']),isError:true})
    collector.record(exec(root,{name:'read_file'}),result(root,['text']))
    expect(collector.receipts()[0]).toMatchObject({status:'unverified',calls:0})
  })
  it('waits for the final successful parent token chain and never counts a failed PTC envelope',async()=>{
    const root=await fixture({'source.txt':'text'}),{collector}=await reader(root),outer=Symbol('outer'),middle=Symbol('middle')
    collector.record(exec(root,{parent:middle}),result(root,['text']))
    collector.record(exec(root,{name:'run_code',token:middle,parent:outer}),{value:{}})
    expect(collector.receipts()[0]!.status).toBe('unverified')
    collector.record(exec(root,{name:'run_code',token:outer}),{value:{}})
    expect(collector.receipts()[0]!.status).toBe('passed')
    const failed=await reader(root),failedOuter=Symbol('failed')
    failed.collector.record(exec(root,{parent:failedOuter}),result(root,['text']));failed.collector.record(exec(root,{name:'run_code',token:failedOuter}),{isError:true,value:{}})
    expect(failed.collector.receipts()[0]!.status).toBe('unverified')
  })
  it('rejects wrong paths, missing lines, truncation and contents that changed from the snapshot',async()=>{
    const root=await fixture({'source.txt':'one\ntwo'})
    for(const value of [result(root,['wrong','two']),result(root,['one']),result(root,['one... (line truncated to 3 chars)','two']),{value:{...result(root,['one','two']).value,path:'/elsewhere/source.txt'}}]){
      const {collector}=await reader(root);collector.record(exec(root),value);expect(collector.receipts()[0]!.status).toBe('unverified')
    }
  })
  it('accepts a complete str_replace_editor view but rejects clipped or range-limited output',async()=>{
    const root=await fixture({'source.txt':'one\ntwo\n'}),header=`Here's the content of ${join(root,'source.txt')} with line numbers (which has a total of 3 lines):\n`,view=header+'     1  one\n     2  two\n     3  \n'
    const {collector}=await reader(root);collector.record(exec(root,{name:'str_replace_editor',arguments:{command:'view',path:join(root,'source.txt')}}),{value:view});expect(collector.receipts()[0]!.status).toBe('passed')
    for(const [args,value] of [[{command:'view',path:join(root,'source.txt')},view+'<response clipped>'],[{command:'view',path:join(root,'source.txt'),view_range:[1,2]},view]] as const){const limited=await reader(root);limited.collector.record(exec(root,{name:'str_replace_editor',arguments:args}),{value});expect(limited.collector.receipts()[0]!.status).toBe('unverified')}
  })
  it('requires a successful read even for an empty file and handles it without invented content',async()=>{
    const root=await fixture({'source.txt':''}),{collector}=await reader(root)
    expect(collector.receipts()[0]!.status).toBe('unverified');collector.record(exec(root),result(root,[]));expect(collector.receipts()[0]!.status).toBe('passed')
  })
})

describe('file verification configuration schema',()=>{
  it('preserves explicit read/change requirements and continues rejecting undeclared verification fields',()=>{
    const flow=makeWorkflow('workspace','Files',true);flow.nodes[1]!.config.verification={requiredFiles:['output.txt'],requiredReadFiles:['source.txt'],requiredChangedFiles:['output.txt']}
    expect(parseWorkflow(flow).nodes[1]!.config.verification).toEqual(flow.nodes[1]!.config.verification)
    expect(()=>parseWorkflow({...flow,nodes:flow.nodes.map(node=>({...node,config:{...node.config,verification:{...node.config.verification,claimedRead:true}}}))})).toThrow()
  })
})
