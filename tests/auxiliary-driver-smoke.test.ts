import {expect,it} from 'vitest'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
it('runs all Graphon audit boundaries using current subagent bindings and no real models',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'audit-driver-smoke-')),output=join(directory,'audit.json')
  try{
    await promisify(execFile)(process.execPath,['--import','tsx','scripts/audit-graphon-boundaries.ts','--output',output],{cwd:new URL('../',import.meta.url).pathname,timeout:20000})
    const report=JSON.parse(readFileSync(output,'utf8'))
    expect(report.externalModelCalls).toBe(0);expect(report.libraries).toEqual([])
    expect(Object.keys(report.probes)).toHaveLength(7)
    expect(report.probes.nativeAgentLifecycle).toMatchObject({status:'success',starts:1,toolCalls:1,disposed:1,host:'explicit-sdk-shaped-test-double',externalModelCalls:0})
    expect(report.probes.siblingReferenceWithoutDependency.status).toBe('rejected')
    expect(report.probes.duplicateOutputName).toMatchObject({status:'failed',completedOutputs:1})
    for(const mode of ['terminate','null','remove'])expect(report.probes[`exitLoopInsideIteration_${mode}`]).toMatchObject({status:'success',outputs:{result:'1'}})
  }finally{rmSync(directory,{recursive:true,force:true})}
},25000)
