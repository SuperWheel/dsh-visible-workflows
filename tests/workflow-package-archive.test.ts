import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, link, rename, utimes, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupWorkflowArchiveMaterialization, createWorkflowArchive, createWorkflowArchiveReceipt, materializeWorkflowArchive, parseWorkflowArchive, readWorkflowZip, writeWorkflowZip } from '../src/host/workflow-package-archive.ts'
import { importWorkflowJson, parseWorkflowPackage } from '../src/shared/workflow-format.ts'
import { makeWorkflow } from '../src/shared/types.ts'

// Keep real filesystem operations; this hook only schedules a deterministic
// concurrent mutation after open, instead of relying on a timing race in tests.
const boundary=vi.hoisted(()=>({afterOpen:undefined as ((handle:FileHandle)=>Promise<void>)|undefined}))
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>()
  return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{
    const handle=await actual.open(...args)
    try{await boundary.afterOpen?.(handle);return handle}catch(error){await handle.close();throw error}
  }}
})
const directories:string[]=[]
async function directory(){const value=await mkdtemp(join(tmpdir(),'workflow-package-'));directories.push(value);return value}
afterEach(async()=>{boundary.afterOpen=undefined;vi.restoreAllMocks();await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
function documentFlow(){const flow=makeWorkflow('source','资料流程',true);flow.nodes[1]!.kind='document';flow.nodes[1]!.config={source:'docs/参考.txt',verification:{requiredReadFiles:['docs/参考.txt']}};return flow}

describe('portable workflow ZIP',()=>{
  it('transfers real bytes and rewrites every file slot without importing local paths or credentials',async()=>{
    const source=await directory(),target=await directory();await mkdir(join(source,'docs'));await writeFile(join(source,'docs/参考.txt'),'中文资料\nsecond line')
    const flow=documentFlow();flow.environmentVariables=[{id:'key',name:'API_KEY',type:'secret'},{id:'region',name:'REGION',type:'string',value:'private-region'}]
    const zip=await createWorkflowArchive(flow,source),parsed=parseWorkflowArchive(zip.toString('base64'))
    expect(parsed.files).toHaveLength(2);expect(parsed.pkg.workflow.environmentVariables?.find(v=>v.id==='key')).not.toHaveProperty('value');expect(JSON.stringify(parsed.pkg)).not.toContain('private-region');expect(JSON.stringify(parsed)).not.toContain(source)
    const installed=await materializeWorkflowArchive(zip.toString('base64'),target),pkg=parseWorkflowPackage(installed.text)
    const path=pkg.workflow.nodes[1]!.config.source!
    expect(path).toMatch(/^workflow-assets-[^/]+\/1-/);expect(await readFile(join(target,path),'utf8')).toBe('中文资料\nsecond line')
    expect(await readFile(join(target,pkg.workflow.nodes[1]!.config.verification!.requiredReadFiles![0]!),'utf8')).toBe('中文资料\nsecond line')
    expect(importWorkflowJson(installed.text,'target').workflow.nodes[1]!.config.source).toBe(path)
    await installed.cleanup();expect(await readdir(target)).toEqual([])
  })
  it('keeps existing destination files unchanged and supports attachment-free packages',async()=>{
    const root=await directory();await writeFile(join(root,'keep.txt'),'existing')
    const zip=await createWorkflowArchive(makeWorkflow('source'),root),imported=await materializeWorkflowArchive(zip.toString('base64'),root)
    expect(parseWorkflowArchive(zip.toString('base64')).files).toEqual([])
    await imported.cleanup();expect(await readdir(root)).toEqual(['keep.txt']);expect(await readFile(join(root,'keep.txt'),'utf8')).toBe('existing')
  })
  it('never removes a pre-existing directory if internal materialization mkdir fails',async()=>{
    const root=await directory();await mkdir(join(root,'docs'));await writeFile(join(root,'docs/参考.txt'),'public')
    const zip=await createWorkflowArchive(documentFlow(),root),receipt=createWorkflowArchiveReceipt(),target=join(root,receipt.directoryName)
    await mkdir(target);await writeFile(join(target,'keep.txt'),'pre-existing')
    await expect(materializeWorkflowArchive(zip.toString('base64'),root,{receipt})).rejects.toThrow()
    expect(await readFile(join(target,'keep.txt'),'utf8')).toBe('pre-existing')
  })
  it('requires the private ownership receipt and rejects path or symlink substitutions during rollback',async()=>{
    const root=await directory(),outside=await directory();await mkdir(join(root,'docs'));await writeFile(join(root,'docs/参考.txt'),'public');await writeFile(join(outside,'keep.txt'),'protected fixture')
    const installed=await materializeWorkflowArchive((await createWorkflowArchive(documentFlow(),root)).toString('base64'),root),receipt=installed.receipt!
    expect(installed.text).not.toContain('workflow-import-owner');expect(installed.text).not.toContain(receipt.owner)
    await expect(cleanupWorkflowArchiveMaterialization(root,{...receipt,owner:createWorkflowArchiveReceipt().owner})).rejects.toThrow('凭据')
    await expect(cleanupWorkflowArchiveMaterialization(root,{...receipt,directoryName:'../outside'})).rejects.toThrow()
    await rename(join(root,receipt.directoryName),join(root,'original-assets'));await symlink(outside,join(root,receipt.directoryName))
    await expect(installed.cleanup()).rejects.toThrow('目录不匹配')
    expect(await readFile(join(outside,'keep.txt'),'utf8')).toBe('protected fixture')
  })
  it('packages the current canvas sources instead of an older saved main definition',async()=>{
    const root=await directory();await mkdir(join(root,'docs'));await writeFile(join(root,'docs/参考.txt'),'old');await writeFile(join(root,'new.txt'),'current')
    const saved=documentFlow(),current=structuredClone(saved);current.nodes[1]!.config={source:'new.txt'}
    const bundle=parseWorkflowArchive((await createWorkflowArchive(current,root,{workflows:[saved]})).toString('base64'))
    expect(bundle.files).toHaveLength(1);expect(bundle.files[0]!.name).toBe('new.txt');expect(bundle.entries.get(bundle.files[0]!.path)!.toString()).toBe('current')
  })
  it('resolves child attachments independently even when two flows share a node ID',async()=>{
    const source=await directory(),target=await directory();await mkdir(join(source,'docs'));await writeFile(join(source,'docs/参考.txt'),'main');await writeFile(join(source,'docs/child.txt'),'child')
    const main=documentFlow(),child=documentFlow();child.id='child';child.nodes[1]!.id=main.nodes[1]!.id;child.edges[0]!.target=child.nodes[1]!.id;child.edges[1]!.source=child.nodes[1]!.id
    child.nodes[1]!.config={source:'docs/child.txt'}
    main.nodes[2]!.kind='tool';main.nodes[2]!.config={toolId:'workflow:child'}
    const zip=await createWorkflowArchive(main,source,{workflows:[child]})
    const imported=await materializeWorkflowArchive(zip.toString('base64'),target),bundle=importWorkflowJson(imported.text,'target')
    expect(await readFile(join(target,bundle.workflow.nodes[1]!.config.source!),'utf8')).toBe('main')
    expect(await readFile(join(target,bundle.workflows[0]!.nodes[1]!.config.source!),'utf8')).toBe('child')
    expect(bundle.workflow.nodes[2]!.config.toolId).toBe(`workflow:${bundle.workflows[0]!.id}`)
  })
  it('bounds destination filenames by UTF-8 bytes, including long imported display names',async()=>{
    const source=await directory(),target=await directory();await mkdir(join(source,'docs'));await writeFile(join(source,'docs/参考.txt'),'data')
    const entries=readWorkflowZip(await createWorkflowArchive(documentFlow(),source)),manifest=JSON.parse(entries.get('attachments.json')!.toString())
    manifest.files[0].name='a'.repeat(255);manifest.files[1].name='资'.repeat(255);entries.set('attachments.json',Buffer.from(JSON.stringify(manifest)))
    const imported=await materializeWorkflowArchive(writeWorkflowZip(entries).toString('base64'),target),flow=parseWorkflowPackage(imported.text).workflow
    for(const path of [flow.nodes[1]!.config.source!,flow.nodes[1]!.config.verification!.requiredReadFiles![0]!]){
      expect(Buffer.byteLength(path.split('/').at(-1)!)).toBeLessThanOrEqual(184)
      expect(await readFile(join(target,path),'utf8')).toBe('data')
    }
  })
  it('never reads a source outside the workspace, including a symlink',async()=>{
    const root=await directory(),outside=await directory();await writeFile(join(outside,'hidden.txt'),'hidden');await symlink(outside,join(root,'external'))
    const flow=documentFlow();flow.nodes[1]!.config={source:'external/hidden.txt'}
    await expect(createWorkflowArchive(flow,root)).rejects.toThrow('当前工作区')
    flow.nodes[1]!.config.source=join(outside,'hidden.txt');await expect(createWorkflowArchive(flow,root)).rejects.toThrow('当前工作区')
  })
  it('rejects a hard-linked source even when its exported name is inside the workspace',async()=>{
    const root=await directory(),outside=await directory();await writeFile(join(outside,'private.txt'),'synthetic external bytes');await link(join(outside,'private.txt'),join(root,'linked.txt'))
    const flow=documentFlow();flow.nodes[1]!.config={source:'linked.txt'}
    await expect(createWorkflowArchive(flow,root)).rejects.toThrow('硬链接')
    expect(await readFile(join(outside,'private.txt'),'utf8')).toBe('synthetic external bytes')
    // Copying bytes into an independently owned document is an explicit source.
    await writeFile(join(root,'copied.txt'),'public independent source');flow.nodes[1]!.config.source='copied.txt'
    const bundle=parseWorkflowArchive((await createWorkflowArchive(flow,root)).toString('base64'))
    expect(bundle.entries.get(bundle.files[0]!.path)!.toString()).toBe('public independent source')
  })
  it('rejects a source replaced between path inspection and descriptor validation',async()=>{
    const root=await directory();await writeFile(join(root,'source.txt'),'original')
    const flow=documentFlow();flow.nodes[1]!.config={source:'source.txt'}
    boundary.afterOpen=async()=>{boundary.afterOpen=undefined;await rename(join(root,'source.txt'),join(root,'previous.txt'));await writeFile(join(root,'source.txt'),'replaced')}
    await expect(createWorkflowArchive(flow,root)).rejects.toThrow('读取期间发生变化')
  })
  it.each(['same-size-write','hard-link','parent-symlink'] as const)('discards bytes if a concurrent %s changes a source during reading',async mutation=>{
    const root=await directory(),outside=await directory();await mkdir(join(root,'docs'));await writeFile(join(root,'docs/source.txt'),'original');await writeFile(join(outside,'source.txt'),'external')
    const flow=documentFlow();flow.nodes[1]!.config={source:'docs/source.txt'}
    boundary.afterOpen=async handle=>{
      boundary.afterOpen=undefined
      const read=handle.read.bind(handle)
      vi.spyOn(handle,'read').mockImplementationOnce(async(...args:any[])=>{
        const result=await (read as (...values:any[])=>Promise<any>)(...args)
        if(mutation==='same-size-write'){
          await writeFile(join(root,'docs/source.txt'),'modified')
          await utimes(join(root,'docs/source.txt'),new Date('2020-01-01'),new Date('2020-01-01'))
        }else if(mutation==='hard-link')await link(join(root,'docs/source.txt'),join(root,'second-link.txt'))
        else {await rename(join(root,'docs'),join(root,'old-docs'));await symlink(outside,join(root,'docs'))}
        return result
      })
    }
    await expect(createWorkflowArchive(flow,root)).rejects.toThrow(mutation==='hard-link'?'硬链接':'读取期间发生变化')
  })
  it('rejects changed bytes, undeclared payloads and forged attachment node targets',async()=>{
    const root=await directory();await mkdir(join(root,'docs'));await writeFile(join(root,'docs/参考.txt'),'original')
    const zip=await createWorkflowArchive(documentFlow(),root),entries=readWorkflowZip(zip),manifest=JSON.parse(entries.get('attachments.json')!.toString())
    const changed=new Map(entries);changed.set(manifest.files[0].path,Buffer.from('modified'))
    expect(()=>parseWorkflowArchive(writeWorkflowZip(changed).toString('base64'))).toThrow('摘要')
    const extra=new Map(entries);extra.set('unlisted.txt',Buffer.from('extra'));expect(()=>parseWorkflowArchive(writeWorkflowZip(extra).toString('base64'))).toThrow('未声明')
    manifest.files[0].nodeId='not-existing';entries.set('attachments.json',Buffer.from(JSON.stringify(manifest)))
    expect(()=>parseWorkflowArchive(writeWorkflowZip(entries).toString('base64'))).toThrow('节点不存在')
    const corrupted=Buffer.from(zip),payload=30+zip.readUInt16LE(26)+zip.readUInt16LE(28);corrupted[payload]=corrupted[payload]!^1;expect(()=>readWorkflowZip(corrupted)).toThrow('校验')
  })
  it('rejects traversal, invalid base64, encrypted entries and oversized ZIP declarations',()=>{
    expect(()=>writeWorkflowZip(new Map([['../escape',Buffer.from('x')]]))).toThrow('名称')
    expect(()=>parseWorkflowArchive('not a base64 zip')).toThrow('编码')
    const zip=writeWorkflowZip(new Map([['workflow.json',Buffer.from('{}')]]))
    const encrypted=Buffer.from(zip);encrypted.writeUInt16LE(0x801,6);expect(()=>readWorkflowZip(encrypted)).toThrow('不一致')
    const end=zip.length-22,index=zip.readUInt32LE(end+16),oversized=Buffer.from(zip);oversized.writeUInt32LE(8_000_001,index+24)
    expect(()=>readWorkflowZip(oversized)).toThrow('过大')
  })
})
