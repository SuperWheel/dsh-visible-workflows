import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractDocument, prepareDocumentSources } from '../src/host/document-files.ts'

vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>()
  return {...actual,open:vi.fn(actual.open)}
})
const directories:string[]=[]
function directory(){const path=mkdtempSync(join(tmpdir(),'document-files-audit-'));directories.push(path);return path}
const signal=()=>new AbortController().signal
const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
afterEach(()=>{vi.restoreAllMocks();vi.mocked(fs.open).mockReset().mockImplementation(actual.open);for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true})})

describe('document file validation and extraction identity',()=>{
  it('retains canonical path values and records the validated file identity',async()=>{
    const root=directory(),path=join(root,'note.txt');writeFileSync(path,'inside')
    const [prepared]=await prepareDocumentSources(root,'note.txt',signal()),info=statSync(path)
    expect(prepared).toEqual({name:'note.txt',value:realpathSync(path),identity:{dev:info.dev,ino:info.ino,size:info.size}})
    expect(await extractDocument(root,'note.txt',signal())).toEqual({text:'inside',source:'note.txt',characters:6})
  })

  it('rejects a symlink swapped in after preparation without reading outside content',async()=>{
    const root=directory(),outside=directory(),path=join(root,'note.txt'),secret=join(outside,'secret.txt')
    writeFileSync(path,'inside');writeFileSync(secret,'OUTSIDE SECRET')
    // extractDocument has finished prepareDocumentSources before it opens the
    // canonical target. Swap precisely in that check/read gap.
    vi.mocked(fs.open).mockImplementationOnce(async(...args)=>{
      renameSync(path,join(root,'original.txt'));symlinkSync(secret,path)
      return actual.open(...args)
    })
    await expect(extractDocument(root,'note.txt',signal())).rejects.toThrow()
    expect(fs.open).toHaveBeenCalledOnce()
  })

  it('rejects replacement by another regular file even when the size is unchanged',async()=>{
    const root=directory(),path=join(root,'note.txt');writeFileSync(path,'original')
    let read:ReturnType<typeof vi.spyOn>|undefined,close:ReturnType<typeof vi.spyOn>|undefined
    vi.mocked(fs.open).mockImplementationOnce(async(...args)=>{
      renameSync(path,join(root,'original.txt'));writeFileSync(path,'replaced')
      const file=await actual.open(...args);read=vi.spyOn(file,'read');close=vi.spyOn(file,'close');return file
    })
    await expect(extractDocument(root,'note.txt',signal())).rejects.toThrow('身份已变化')
    expect(read).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce()
  })

  it('reads the validated handle if the pathname is replaced during the read',async()=>{
    const root=directory(),outside=directory(),path=join(root,'note.txt'),secret=join(outside,'secret.txt')
    writeFileSync(path,'inside');writeFileSync(secret,'OUTSIDE SECRET')
    vi.mocked(fs.open).mockImplementationOnce(async(...args)=>{
      const file=await actual.open(...args),read=file.read.bind(file)
      vi.spyOn(file,'read').mockImplementationOnce(async(...readArgs:Parameters<typeof read>)=>{
        renameSync(path,join(root,'original.txt'));symlinkSync(secret,path)
        return read(...readArgs)
      })
      return file
    })
    expect((await extractDocument(root,'note.txt',signal())).text).toBe('inside')
  })

  it('caps reads at 10 MB plus one byte when the file grows after fstat and closes the handle',async()=>{
    const root=directory(),path=join(root,'note.txt');writeFileSync(path,'a')
    let totalRead=0,grown=false,close:ReturnType<typeof vi.spyOn>|undefined
    vi.mocked(fs.open).mockImplementationOnce(async(...args)=>{
      const file=await actual.open(...args),read=file.read.bind(file);close=vi.spyOn(file,'close')
      vi.spyOn(file,'read').mockImplementation(async(...readArgs:Parameters<typeof read>)=>{
        if(!grown){grown=true;appendFileSync(path,Buffer.alloc(10_000_100,65))}
        const result=await read(...readArgs);totalRead+=result.bytesRead;return result
      })
      return file
    })
    await expect(extractDocument(root,'note.txt',signal())).rejects.toThrow('10 MB')
    expect(totalRead).toBe(10_000_001);expect(close).toHaveBeenCalledOnce()
  })

  it('checks opened file size and type again before reading',async()=>{
    for(const replacement of ['large','directory']){
      const root=directory(),path=join(root,'note.txt');writeFileSync(path,'inside')
      vi.mocked(fs.open).mockImplementationOnce(async(...args)=>{
        if(replacement==='large')appendFileSync(path,Buffer.alloc(10_000_001))
        else{renameSync(path,join(root,'original.txt'));mkdirSync(path)}
        return actual.open(...args)
      })
      await expect(extractDocument(root,'note.txt',signal())).rejects.toThrow('10 MB')
    }
  })

  it('keeps uploads and in-workspace symlinks readable',async()=>{
    const root=directory();writeFileSync(join(root,'note.txt'),'inside');symlinkSync(join(root,'note.txt'),join(root,'alias.txt'))
    expect((await extractDocument(root,'alias.txt',signal())).text).toBe('inside')
    expect((await extractDocument(root,{name:'upload.md',base64:Buffer.from('# Upload').toString('base64')},signal())).text).toBe('# Upload')
  })
})
