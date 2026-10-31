// Summarize observed public Desktop events; intervals include model/network waits,
// and are not labelled as CPU time or independent performance benchmarks.
import fs from 'node:fs'
import path from 'node:path'
const out=path.resolve(import.meta.dirname,'../../docs/evidence/template-fill-desktop-20261019')
const evidence=JSON.parse(fs.readFileSync(path.join(out,'native-public-events.json'),'utf8'))
const sessions=evidence.sessions.map(session=>{
  const calls=session.events.filter(event=>event.type==='tool/call')
  const results=new Map(session.events.filter(event=>event.type==='tool/result').map(event=>[event.message.toolCallId,event]))
  const turns=session.events.filter(event=>event.type==='turn/start').map(start=>{
    const end=session.events.find(event=>event.type==='turn/end'&&event.data.turn===start.data.turn&&event.time>=start.time)
    const turnCalls=calls.filter(event=>event.turn===start.data.turn&&event.time>=start.time&&(!end||event.time<=end.time))
    return {turn:start.data.turn,startedAt:new Date(start.time).toISOString(),endedAt:end?new Date(end.time).toISOString():null,elapsedMs:end?end.time-start.time:null,firstToolDelayMs:turnCalls[0]?turnCalls[0].time-start.time:null,tools:turnCalls.map(call=>{
      const result=results.get(call.callId)
      return {name:call.name,callId:call.callId,callSeq:call.seq,resultSeq:result?.seq??null,startedAt:new Date(call.time).toISOString(),durationMs:result?result.time-call.time:null,isError:result?.message.isError??null}
    })}
  })
  return {sessionId:session.id,role:session.role,label:session.label,turns}
})
const result={capturedAt:evidence.capturedAt,basis:'Observed Desktop session events; no synthetic time and no paired performance conclusion',sessions}
fs.writeFileSync(path.join(out,'tool-timings.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
