import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ownRows, publicEvents, scrub, selectedRecords, scope } from '../../scripts/probes/collect-backend-batch2-desktop.mjs'

test('only the matched routing record is parsed as a full object',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'batch2-collector-')),file=path.join(dir,'aggregate.json'),parse=JSON.parse
  try{
    fs.writeFileSync(file,JSON.stringify({tasks:[{workspaceId:'foreign',payload:'private-body-must-not-be-parsed'},{workspaceId:scope.workspaceId,id:'owned',sessionId:scope.rootSessionId}]}))
    JSON.parse=text=>{assert(!text.includes('private-body-must-not-be-parsed'),'foreign full record was parsed');return parse(text)}
    assert.deepEqual(selectedRecords(file,'tasks',scalar=>scalar('workspaceId')===scope.workspaceId),[{workspaceId:scope.workspaceId,id:'owned',sessionId:scope.rootSessionId}])
  }finally{JSON.parse=parse;fs.rmSync(dir,{recursive:true,force:true})}
})
test('public tool text, usage and lifecycle survive without reasoning or request dump',()=>{
  const rows=[{seq:1,type:'request/header',data:{requestDump:'NEVER'}},{seq:2,type:'assistant/message',data:{content:[{type:'thinking',text:'NEVER'}],stream:[{type:'chunk',chunk:{type:'reasoning',text:'NEVER'}}],usage:{totalTokens:7}}},{seq:3,type:'tool/call',data:{name:'write',callId:'c',arguments:'{"file_path":"result.md","token":"NEVER"}'}},{seq:4,type:'tool/result',data:{message:{toolCallId:'c',isError:false,content:[{type:'text',text:'done'},{type:'image',data:'NEVER'}]}}},{seq:5,type:'subagent/end',data:{id:'child',runId:'epoch',provider:'spawn',local:true,stopReason:'completed',lastAssistantMessage:[{text:'NEVER'}]}}]
  const events=publicEvents(rows),serialized=JSON.stringify(events)
  assert(!serialized.includes('NEVER'));assert(serialized.includes('done'));assert(serialized.includes('epoch'));assert.equal(events[0].usage.totalTokens,7)
})
test('seeded history is excluded and missing seed boundary fails closed',()=>{
  assert.deepEqual(ownRows({isSeeded:true},[{type:'tool/call',data:{name:'foreign'}},{type:'session/end-seed',data:{inherited:true}},{type:'tool/call',data:{name:'owned'}}]),[{type:'tool/call',data:{name:'owned'}}])
  assert.throws(()=>ownRows({isSeeded:true},[]),/Seed boundary/)
})
test('recursive public projection redacts credential keys and omits private model fields',()=>{
  assert.deepEqual(scrub({authorization:'NEVER',analysis:'NEVER',nested:{apiKey:'NEVER',token:'NEVER',text:'Bearer NEVER',url:'http://localhost/?token=NEVER'},count:3}),{authorization:'[redacted]',nested:{apiKey:'[redacted]',token:'[redacted]',text:'Bearer [redacted]',url:'http://localhost/?token=[redacted]'},count:3})
})
