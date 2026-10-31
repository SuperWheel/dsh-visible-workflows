import { describe,expect,it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync,readFileSync,writeFileSync,existsSync,statSync,mkdirSync,rmSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { sdk,FsError,manifest,attest } from './fixtures/t18-tools.ts'
import { EXACT_TARGET_EXISTS_CODE,registeredToolOperation } from '../src/shared/tool-operation-contract.ts'

const exact=new Function(EXACT_TARGET_EXISTS_CODE+';return main;')()
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex')
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'t18-sdk-')),events=new Map<string,Function[]>(),definitions=new Map<string,any>(),calls:string[]=[]
  let denied=false,writes=0
  const version=(path:string)=>existsSync(path)?hash(readFileSync(path)):undefined
  const provider={
    resolve:async(path:string)=>({targetKey:resolve(directory,path),displayPath:resolve(directory,path)}),
    processPath:(target:any)=>target.displayPath,
    stat:async(target:any)=>{
      if(denied)throw new FsError('permission denied','FS_PERMISSION_DENIED')
      const path=target.displayPath
      return existsSync(path)?{type:statSync(path).isFile()?'file':'directory',size:statSync(path).size,version:version(path)}:undefined
    },
    readText:async(target:any)=>readFileSync(target.displayPath,'utf8'),
    writeText:async(target:any,content:string,intent:any)=>{
      if(denied)throw new FsError('permission denied','FS_PERMISSION_DENIED')
      const path=target.displayPath,before=existsSync(path)?readFileSync(path,'utf8'):null
      if(intent?.kind==='createIfAbsent'&&before!==null)throw new FsError('not observed','FS_NOT_OBSERVED')
      if(intent?.kind==='replaceIfVersion'&&version(path)!==intent.version)throw new FsError('external change','FS_STALE_VERSION')
      writeFileSync(path,content,{flag:intent?.kind==='createIfAbsent'?'wx':'w'});writes++
      return {operation:before===null?'create':'update',before,after:content,version:version(path)}
    },
  }
  const ctx={fs:provider,workingDirectory:{ensure:async()=>directory},tools:{register:(tool:any)=>{definitions.set(tool.name,tool)},get:(name:string)=>definitions.get(name)},
    systemPrompt:{section:()=>{},getSectionOrder:()=>0},effect:()=>{},
    on:(name:string,handler:Function)=>{events.set(name,[...(events.get(name)??[]),handler])},emit:(name:string,...args:any[])=>{for(const handler of events.get(name)??[])handler(...args)},
    waterfall:async(name:string,...args:any[])=>{const handlers=events.get(name)??[];return handlers.length?handlers[0]!(...args):undefined},
  }
  sdk(ctx)
  const owner={session:{}},exec=(agent=owner)=>({agent,signal:new AbortController().signal})
  const call=async(name:string,args:any,agent=owner)=>{calls.push(name);return definitions.get(name).execute(args,exec(agent))}
  const run=async(paths:string[],beforeWrite?:()=>void)=>{
    // An explicit listing is supplied as canonical input; it never records a
    // read. This tests the same pinned code exported to planning templates.
    const {exists}=exact({listing:{root:'.',paths},target:'out.json'})
    if(exists)await call('read',{file_path:'out.json'})
    beforeWrite?.()
    await call('write',{file_path:'out.json',content:'Hello'})
    return call('read',{file_path:'out.json'})
  }
  return {directory,definitions,calls,call,run,owner,setDenied:(value:boolean)=>{denied=value},writes:()=>writes,cleanup:()=>rmSync(directory,{recursive:true,force:true})}
}

describe('T18 offline official SDK bodies + observation policy, isolated provider double',()=>{
  it('pins package version and original source bytes used by the offline fixture',()=>{
    for(const pkg of manifest.packages){expect(pkg.version).toBe('0.2.1-rc.2');expect(hash(readFileSync(new URL('./fixtures/t18-sdk/'+pkg.fixture,import.meta.url)))).toBe(pkg.sha256)}
  })
  it('first creation needs no unconditional read, then readback sees the artifact',async()=>{
    const f=fixture();try{const result=await f.run([]);expect(result.path).toBe(join(f.directory,'out.json'));expect(f.calls).toEqual(['write','read']);expect(f.writes()).toBe(1);expect(readFileSync(join(f.directory,'out.json'),'utf8')).toBe('Hello')}finally{f.cleanup()}
  })
  it('overwrites an existing target after the exact read, once per run',async()=>{
    const f=fixture();try{writeFileSync(join(f.directory,'out.json'),'old');await f.run(['./out.json']);expect(f.calls).toEqual(['read','write','read']);expect(f.writes()).toBe(1);await f.run(['out.json']);expect(f.writes()).toBe(2);expect(readFileSync(join(f.directory,'out.json'),'utf8')).toBe('Hello')}finally{f.cleanup()}
  })
  it('same basename only in a subdirectory stays on creation and leaves that file intact',async()=>{
    const f=fixture();try{mkdirSync(join(f.directory,'sub'));writeFileSync(join(f.directory,'sub/out.json'),'untouched');await f.run(['sub/out.json']);expect(f.calls).toEqual(['write','read']);expect(f.writes()).toBe(1);expect(readFileSync(join(f.directory,'sub/out.json'),'utf8')).toBe('untouched')}finally{f.cleanup()}
  })
  it('rejects overwrite with no read or a read in another owner',async()=>{
    const f=fixture();try{writeFileSync(join(f.directory,'out.json'),'old');await expect(f.call('write',{file_path:'out.json',content:'bad'})).rejects.toThrow('file has not been read');await f.call('read',{file_path:'out.json'},{session:{}});await expect(f.call('write',{file_path:'out.json',content:'bad'})).rejects.toThrow('file has not been read');expect(f.writes()).toBe(0);expect(readFileSync(join(f.directory,'out.json'),'utf8')).toBe('old')}finally{f.cleanup()}
  })
  it('rejects external changes after reading and does not pre-read or retry',async()=>{
    const f=fixture();try{writeFileSync(join(f.directory,'out.json'),'old');await expect(f.run(['out.json'],()=>writeFileSync(join(f.directory,'out.json'),'external'))).rejects.toThrow('re-read the file');expect(f.calls).toEqual(['read','write']);expect(f.writes()).toBe(0);expect(readFileSync(join(f.directory,'out.json'),'utf8')).toBe('external')}finally{f.cleanup()}
  })
  it('a racing creation stays rejected by createIfAbsent without hidden read',async()=>{
    const f=fixture();try{await expect(f.run([],()=>writeFileSync(join(f.directory,'out.json'),'racer'))).rejects.toThrow('file has not been read');expect(f.calls).toEqual(['write']);expect(f.writes()).toBe(0);expect(readFileSync(join(f.directory,'out.json'),'utf8')).toBe('racer')}finally{f.cleanup()}
  })
  it.each(['read','write'])('propagates %s permission denial with no writes or escalation',async operation=>{
    const f=fixture();try{if(operation==='read')writeFileSync(join(f.directory,'out.json'),'old');f.setDenied(true);await expect(f.run(operation==='read'?['out.json']:[])).rejects.toThrow('permission denied');expect(f.calls).toEqual([operation]);expect(f.writes()).toBe(0);expect(existsSync(join(f.directory,'out.json'))).toBe(operation==='read')}finally{f.cleanup()}
  })
  it('missing read fails explicitly and cannot be used as unconditional creation preparation',async()=>{
    const f=fixture();try{await expect(f.call('read',{file_path:'out.json'})).rejects.toMatchObject({code:'FS_NOT_FOUND'});expect(f.writes()).toBe(0)}finally{f.cleanup()}
  })
  it('current SDK registration without operation metadata is unknown even with an output schema',()=>{
    const f=fixture();try{const definition=f.definitions.get('write');expect(registeredToolOperation('native:write',definition).status).toBe('unknown');expect(attest('write',definition).operationContract?.status).toBe('known')}finally{f.cleanup()}
  })
  it.each([null,{root:'.',paths:null},{root:'sub',paths:['out.json']},{root:'.',paths:['../out.json']},{root:'.',paths:['/out.json']},{root:'.',paths:['C:\\out.json']},{root:'.',paths:[null]}])('rejects malformed or unsupported listing %j',listing=>{
    expect(()=>exact({listing,target:'out.json'})).toThrow()
  })
})
