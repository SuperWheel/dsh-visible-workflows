import assert from 'node:assert/strict'
import { analyzeSelectedSessions as analyze } from './desktop-session-acceptance-evidence.mjs'
const secret='SYNTHETIC_ONLY_ABCDEFGHIJKLMNOPQRSTUV1234567890'
const metadata={publicFile:'/synthetic/public.txt',protectedFile:'/synthetic/protected/secret.txt',link:'/synthetic/link.txt'}
let seq=0
const row=(type,data)=>({type,data,seq:++seq})
function reads() { return Object.entries(metadata).flatMap(([key,file_path],i)=>[
  row('tool/call',{name:'read',callId:String(i),arguments:{file_path}}),
  row('tool/result',{message:{toolCallId:String(i),isError:key!=='publicFile',content:[{type:'text',text:key==='publicFile'?'1: PUBLIC SYNTHETIC TEXT':'FS_IO_ERROR'}]}}),
]) }
function main() { return [{type:'session',version:4,id:'main',cwd:'/synthetic',isSeeded:false},row('user/message',{content:'SECRET_DESKTOP_ACCEPTANCE_20261017'}),row('turn/start',{}),row('request/header',{}),...reads(),row('subagent/catalog',{childId:'child'}),row('turn/end',{reason:{kind:'completed'}})] }
function child() { return [{type:'session',version:4,id:'child',parentSession:'main',origin:'subagent',cwd:'/synthetic',isSeeded:true},...reads(),row('session/end-seed',{inherited:true}),row('subagent/descriptor',{provider:'spawn'}),row('turn/start',{}),row('request/header',{}),...reads(),row('turn/end',{reason:{kind:'completed'}})] }
const check=(m=main(),c=[child()])=>analyze(m,c,metadata,'PUBLIC SYNTHETIC TEXT',secret)
const passed=check();assert.equal(passed.status,'passed');assert.equal(passed.children[0].reads.length,3)
assert.equal(check(main(),[]).status,'pending')
assert.throws(()=>check(main().filter(row=>row.type!=='user/message')),/TAG_NOT_FOUND/)
assert.throws(()=>{const c=child();c[0].parentSession='wrong';return check(main(),[c])},/LINEAGE_MISMATCH/)
const inheritedOnly=child().filter((row,i,rows)=>i===0||i<=rows.findIndex(item=>item.type==='session/end-seed')||row.type!=='tool/call'&&row.type!=='tool/result')
assert.equal(check(main(),[inheritedOnly]).status,'failed')
const pending=child().filter(row=>row.type!=='turn/end');assert.equal(check(main(),[pending]).status,'pending')
const bypass=main();bypass.find(row=>row.type==='tool/result'&&row.data.message.toolCallId==='1').data.message.isError=false;assert.equal(check(bypass).status,'failed')
for(const encoded of [secret,Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('hex')]) {
  const m=main();m.push(row('assistant/message',{content:encoded}));const report=check(m);assert.equal(report.status,'failed');assert.equal(report.canaryFound,true);assert.equal(JSON.stringify(report).includes(encoded),false)
}
const keyLeak=main();keyLeak.push(row('tool/result',{[secret]:'present'}));assert.equal(check(keyLeak).status,'failed')
const error=main();for(const result of error.filter(row=>row.type==='tool/result'&&row.data.message.isError)) result.data.message.content=[{text:'other error'}];assert.equal(check(error).status,'failed')
const fakeProvider=child();fakeProvider.find(row=>row.type==='subagent/descriptor').data.provider=secret;const fake=check(main(),[fakeProvider]);assert.equal(fake.status,'failed');assert.equal(JSON.stringify(fake).includes(secret),false)
console.log(JSON.stringify({status:'passed',checks:13,sessionBodiesRead:0,productionModified:false,modelCalls:0}))
