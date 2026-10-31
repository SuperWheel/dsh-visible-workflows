import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  TRIAL_LIMITS, trialPathSchema, trialPublicEventSchema, trialHumanReviewSchema, verifiedTrialEvidenceSchema,
  type TrialPublicEvent, type TrialHumanReview, type TrialVerificationReport, type VerifiedTrialEvidence,
} from '../../shared/planning-trial.ts'
import type { ConversationEvidence, ConversationEvidenceRecord } from '../../shared/retrospective.ts'
import { CONVERSATION_EVIDENCE_LIMITS, conversationEvidenceDigest, publicEvidenceExcerpt, publicEvidenceText, validateConversationEvidence } from './conversation-evidence.ts'
import { validateTrialVerificationReport } from './trial-verification.ts'

/** Only public, bounded fields leave the trial driver; model reasoning is never retained. */
export function projectTrialEvent(event: SessionEvent): TrialPublicEvent | undefined {
  const seq = event.seq
  if (event.type === 'turn/start') return trialPublicEventSchema.parse({ seq, type: event.type, turn: event.data.turn })
  if (event.type === 'turn/end') return trialPublicEventSchema.parse({ seq, type: event.type, turn: event.data.turn, completed: event.data.reason.kind === 'completed' })
  if (event.type === 'tool/call') return trialPublicEventSchema.parse({ seq, type: event.type, turn: event.data.turn, callId: event.data.callId, toolName: event.data.name, ...publicEvidenceExcerpt(event.data.arguments, true) })
  if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
    const message = event.type === 'user/message' ? event.data : event.data.message
    const visible = publicEvidenceText(message), excerpt = publicEvidenceExcerpt(visible.text || (visible.omitted ? '[非文本材料未展开]' : ''))
    const common = { seq, type: event.type, text: excerpt.text, truncated: excerpt.truncated || visible.omitted }
    if (event.type === 'user/message') return trialPublicEventSchema.parse({ ...common, source: event.data.source.kind === 'user' ? 'user' : 'host' })
    if (event.type === 'assistant/message') return trialPublicEventSchema.parse({ ...common, turn: event.data.turn, interrupted: !!event.data.interrupted })
    return trialPublicEventSchema.parse({ ...common, turn: event.data.turn, callId: event.data.message.toolCallId, isError: !!event.data.message.isError, ...(event.data.error?.code ? { errorCode: event.data.error.code } : {}) })
  }
}

const unknownOutcome = /TOOL_(?:NOT_STARTED|OUTCOME_UNKNOWN)|(?:"|\b)(?:outcome|status)(?:"|\b)\s*[:=]\s*"?(?:unknown|interrupted|not.started)/i
const childTool = /subagent|spawn_agent|delegate|cliworker/i
const structuredTool = /(?:^|[.:/])structured_output$/

/** Reject unusable records before distillation, independently of business checks.
 * `resumedFrom` is the first seq of a continuation (T30.1): the stopped segment before it
 * may end mid-turn, and its unclosed calls count as unknown instead of voiding the trial. */
export function checkTrialEvents(input: readonly TrialPublicEvent[], evidenceIncomplete: boolean, resumedFrom?: number) {
  if (evidenceIncomplete || !input.length || input.length > TRIAL_LIMITS.events) throw Object.assign(new Error('试做公开记录不完整，不能可靠提炼'),{code:'TRIAL_EVIDENCE_INCOMPLETE'})
  const events = input.map(event => trialPublicEventSchema.parse(event))
  if (events.some((event, index) => index > 0 && event.seq <= events[index - 1]!.seq)) throw new Error('试做事件身份重复或顺序无效')
  const starts = new Map<number, number>(), endings = new Map<number, { seq: number; completed: boolean }>()
  const calls = new Map<string, Extract<TrialPublicEvent, { type: 'tool/call' }>>(), results = new Map<string, Extract<TrialPublicEvent, { type: 'tool/result' }>>()
  for (const event of events) {
    if (event.type === 'turn/start') { if (starts.has(event.turn)) throw new Error('试做轮次开始重复'); starts.set(event.turn, event.seq) }
    if (event.type === 'turn/end') {
      if (!starts.has(event.turn) || endings.has(event.turn) || starts.get(event.turn)! >= event.seq) throw new Error('试做轮次结束无效')
      endings.set(event.turn, { seq: event.seq, completed: event.completed })
    }
    if (event.type === 'tool/call') { if (calls.has(event.callId)) throw new Error('试做工具调用身份重复'); calls.set(event.callId, event) }
    if (event.type === 'tool/result') { if (results.has(event.callId)) throw new Error('试做工具结果身份重复'); results.set(event.callId, event) }
  }
  const current = (event: { seq: number }) => resumedFrom === undefined || event.seq >= resumedFrom
  if (!starts.size || [...starts].some(([turn, seq]) => current({ seq }) && !endings.get(turn)?.completed)) throw new Error('试做会话尚未完整结束，不能提炼试做记录')
  // A stopped segment's last turn may have no end; nothing in it counts as closed.
  const closed = (event: { turn: number; seq: number }) => starts.has(event.turn) && starts.get(event.turn)! < event.seq && (endings.get(event.turn)?.seq ?? -1) > event.seq
  // A truncated public excerpt hides content, not the outcome: the gate reads the
  // reported outcome, while records still mark truncated calls as unknown content.
  const outcomeFor = (callId: string): ConversationEvidenceRecord['status'] => {
    const call = calls.get(callId), result = results.get(callId)
    if (!call || !result || call.seq >= result.seq || call.turn !== result.turn || !closed(call) || !closed(result) || childTool.test(call.toolName) || unknownOutcome.test(result.text + (result.errorCode ?? ''))) return 'unknown'
    return result.isError ? 'failed' : 'reported-success'
  }
  const truncated = (callId: string) => !!calls.get(callId)?.truncated || !!results.get(callId)?.truncated
  const statusFor = (callId: string): ConversationEvidenceRecord['status'] => truncated(callId) ? 'unknown' : outcomeFor(callId)
  const succeeded = [...calls.values()].filter(call => !structuredTool.test(call.toolName) && outcomeFor(call.callId) === 'reported-success')
  if (!succeeded.length) throw new Error('试做缺少真实、完整、成功的业务工具调用与结果；助手声明或结构化输出不能代替执行')
  const unpaired=(result:Extract<TrialPublicEvent,{type:'tool/result'}>)=>{const call=calls.get(result.callId);return !call||call.seq>=result.seq||call.turn!==result.turn||!closed(result)}
  if([...calls.values()].some(call=>current(call)&&(!results.has(call.callId)||!closed(call)))||[...results.values()].some(result=>current(result)&&unpaired(result))){
    throw Object.assign(new Error('试做调用和结果未完整配对，无法可靠提炼'),{code:'TRIAL_EVIDENCE_INCOMPLETE'})
  }
  return { events, calls, results, closed, outcomeFor, statusFor, truncatedSuccess: !succeeded.some(call => !truncated(call.callId)) }
}

/** Stable ordinal in the durable call stream; provider IDs never cross the model contract. */
export function trialCallIndex(events:readonly TrialPublicEvent[]){
  const results=new Map(events.filter(event=>event.type==='tool/result').map(event=>[event.callId,event]))
  return events.filter((event):event is Extract<TrialPublicEvent,{type:'tool/call'}>=>event.type==='tool/call'&&!structuredTool.test(event.toolName)).map((call,index)=>({number:index+1,call,result:results.get(call.callId)}))
}
export function verifyTrialPath(events:readonly TrialPublicEvent[],path:unknown,evidenceIncomplete=false,resumedFrom?:number){
  const checked=checkTrialEvents(events,evidenceIncomplete,resumedFrom),declared=trialPathSchema.parse(path),index=trialCallIndex(checked.events)
  const selected=new Set<string>(),warnings:string[]=[],entries:typeof declared=[],renumbered=new Map<number,number>(),dropped:string[]=[]
  const outcome=(row:typeof index[number])=>checked.outcomeFor(row.call.callId)
  let previous=0
  // A step fits a later call of its tool whose outcome matches its status; a stuck
  // step cites that tool's last complete failure. A probe that answered normally
  // (glob "No files found", Desktop r35 A) still fits an expected failure.
  const fits=(entry:typeof declared[number],row:typeof index[number])=>row.number>previous&&row.call.toolName===entry.tool&&(
    entry.status==='failed'?outcome(row)==='failed'&&!index.some(later=>later.number>row.number&&later.call.toolName===entry.tool&&outcome(later)==='failed')
    :entry.status==='expected-failure'?['failed','reported-success'].includes(outcome(row)):outcome(row)==='reported-success')
  for(const [position,entry] of declared.entries()){
    // Only the step that does not match is corrected: a misnumbered step is realigned
    // by its tool (Desktop r56 C numbered 1..n past an off-path glob), and a step
    // with no matching call is dropped alone. The rest of the path stays.
    const cited=index[entry.call-1],row=cited&&fits(entry,cited)?cited:index.find(row=>fits(entry,row))
    if(!row||entry.status==='failed'&&position!==declared.length-1){dropped.push(`#${entry.call} ${entry.tool}`);continue}
    if(row.number!==entry.call)renumbered.set(entry.call,row.number)
    previous=row.number
    if(entry.status==='failed')warnings.push(`未跑通：${entry.label}（调用 #${row.number}），最后一次尝试失败。`)
    // A check whose error is the observation (write-before probe of a missing file, Desktop r34 A).
    else if(entry.status==='expected-failure')warnings.push(outcome(row)==='failed'?`预期失败的检查：${entry.label}（调用 #${row.number}）`:`检查按成功计入：${entry.label}（调用 #${row.number}）声明为预期失败，实际正常返回。`)
    selected.add(row.call.callId);entries.push({...entry,call:row.number})
    if(entry.workaround)warnings.push(`未跑通：${entry.label}（调用 #${row.number}）使用绕行：${entry.reason}`)
  }
  if(!entries.length)throw new Error('路径没有一步对得上实际调用')
  if(renumbered.size)warnings.push(`路径编号与实际调用错位，Host 按工具名对齐：${[...renumbered].map(([from,to])=>`#${from}→#${to}`).join('、')}。`)
  if(dropped.length)warnings.push(`路径中 ${dropped.join('、')} 对不上实际调用，只去掉这几步，其余保留。`)
  const excluded=index.filter(row=>!selected.has(row.call.callId)),counts=new Map<string,number>()
  for(const row of excluded)counts.set(row.call.toolName,(counts.get(row.call.toolName)??0)+1)
  warnings.unshift(`另有 ${excluded.length} 次尝试已排除${excluded.length?`（${[...counts].map(([name,count])=>`${name}×${count}`).join('、')}）`:''}`.slice(0,1000))
  return {selected,entries,warnings,renumbered}
}

/** Trial-submitted procedures cite path calls as cN, numbered like the path (renumbered when Host realigned it); map each to its call and result records.
 * Evidence holds only path calls, so an excluded note about an off-path attempt
 * loses that citation (and the note when nothing is left) instead of voiding the procedure. */
export function trialProcedureRefs(events:readonly TrialPublicEvent[],procedure:unknown,selected?:ReadonlySet<string>,specRefs?:readonly string[],renumbered?:ReadonlyMap<number,number>):unknown{
  if(!procedure||typeof procedure!=='object')return procedure
  const index=trialCallIndex(events),refs=(value:unknown,offPath:boolean)=>Array.isArray(value)?[...new Set(value.flatMap(ref=>{
    const match=typeof ref==='string'?/^c([1-9]\d*)$/.exec(ref):null,row=match?index[(renumbered?.get(Number(match[1]))??Number(match[1]))-1]:undefined
    if(row&&offPath&&selected&&!selected.has(row.call.callId))return []
    return row?[`e${row.call.seq}`,...(row.result?[`e${row.result.seq}`]:[])]:[ref]
  }))]:value
  const value=structuredClone(procedure) as {steps?:unknown;excluded?:unknown}
  for(const [list,offPath] of [[value.steps,false],[value.excluded,true]] as const){
    if(!Array.isArray(list))continue
    for(const item of list)if(item&&typeof item==='object'&&'evidenceRefs' in item){const cited=item as {evidenceRefs:unknown};cited.evidenceRefs=refs(cited.evidenceRefs,offPath)}
  }
  // specRefs are optional constraints; the full spec still reaches planning, so names the trial invented are dropped (Desktop r34 A).
  if(specRefs&&Array.isArray(value.steps))for(const step of value.steps)if(step&&typeof step==='object'&&Array.isArray((step as {specRefs?:unknown}).specRefs)){
    const kept=(step as {specRefs:unknown[]}).specRefs.filter(ref=>typeof ref==='string'&&specRefs.includes(ref))
    if(kept.length)(step as {specRefs:unknown[]}).specRefs=kept;else delete (step as {specRefs?:unknown}).specRefs
  }
  if(Array.isArray(value.excluded))value.excluded=value.excluded.filter(item=>!(item&&typeof item==='object'&&Array.isArray((item as {evidenceRefs?:unknown}).evidenceRefs)&&!(item as {evidenceRefs:unknown[]}).evidenceRefs.length))
  return value
}

/** Called only with driver-owned observations and Host-created verification. Digests
 * provide integrity; the TrialService's owned receipt remains the authority. */
export function buildTrialEvidence(options: {
  trialId: string; workspaceId: string; rootSessionId: string; childSessionId: string; specDigest: string;
  verification: TrialVerificationReport; events: readonly TrialPublicEvent[]; evidenceIncomplete: boolean; humanReview?: TrialHumanReview; path?:unknown; onDiagnostic?:(diagnostic:{code:string;message:string})=>void
  resumedFrom?: number
}): VerifiedTrialEvidence {
  const verification = validateTrialVerificationReport(options.verification)
  const humanReview = options.humanReview ? trialHumanReviewSchema.parse(options.humanReview) : undefined
  const reviewed = verification.verdict === 'needs-review' && !!verification.reviewItems.length && [...verification.inputs, ...verification.artifacts].every(item => item.status === 'passed') && !!humanReview
  if (verification.specDigest !== options.specDigest) throw new Error('试做冻结检查摘要不匹配')
  if (options.rootSessionId === options.childSessionId) throw new Error('试做证据必须保留真实子会话身份，不能冒充根对话')
  const evidence = trialConversationEvidence({ childSessionId: options.childSessionId, events: options.events, evidenceIncomplete: options.evidenceIncomplete, reviewed, verification, path:options.path, onDiagnostic:options.onDiagnostic, resumedFrom:options.resumedFrom })
  return validateVerifiedTrialEvidence({ evidence, binding: {
    trialId: options.trialId, workspaceId: options.workspaceId, rootSessionId: options.rootSessionId, childSessionId: options.childSessionId,
    specDigest: options.specDigest, verificationDigest: verification.digest, evidenceDigest: evidence.digest, ...(reviewed ? { humanReview } : {}),
  } })
}

const TRIAL_EVIDENCE_WARNINGS = [
  '证据来自 Host 管理的真实试做子会话；根对话授权身份另存于试做回执。',
  '工具成功仅表示调用报告成功；文件验收只证明事先冻结的检查条件，不证明泛化能力。',
  'Host 下发的执行提示不作为真人用户原话；原始需求与验收规范由试做回执绑定。',
  '公开内容按既有规则脱敏和限长；自动脱敏不能保证识别所有敏感信息。',
]
type EvidenceEvent = Exclude<TrialPublicEvent, { type: 'turn/start' | 'turn/end' }>

function trialPathDiagnostic(error: unknown): { code: string; message: string } {
  const reason=error instanceof Error&&error.name!=='ZodError'?error.message:'路径字段或数量不符合声明格式'
  return {code:'TRIAL_PATH_INVALID',message:`TRIAL_PATH_INVALID：${reason.slice(0,600)}；改用完整试做证据及既有压缩与提炼。`}
}
function trialEvidenceRecord(event: EvidenceEvent, checked: ReturnType<typeof checkTrialEvents>): ConversationEvidenceRecord {
  let kind: ConversationEvidenceRecord['kind'], status: ConversationEvidenceRecord['status'] = 'statement', toolName: string | undefined, callId: string | undefined
  if (event.type === 'tool/call') { kind = 'tool-call'; toolName = event.toolName; callId = event.callId; status = checked.statusFor(callId) }
  else if (event.type === 'tool/result') { kind = 'tool-result'; callId = event.callId; toolName = checked.calls.get(callId)?.toolName; status = checked.statusFor(callId) }
  else if (event.type === 'assistant/message') { kind = 'assistant'; if (event.interrupted || !checked.closed(event)) status = 'unknown' }
  else kind = 'user'
  if (event.truncated) status = 'unknown'
  return { id: `e${event.seq}`, seq: event.seq, kind, status, text: event.text, truncated: event.truncated, ...(toolName ? { toolName } : {}), ...(callId ? { callId } : {}) }
}

/** Bounded public rehearsal evidence, including explicit check gaps. */
export function trialConversationEvidence(options: {
  childSessionId: string; events: readonly TrialPublicEvent[]; evidenceIncomplete: boolean; reviewed: boolean
  verification?:TrialVerificationReport; path?:unknown; onDiagnostic?:(diagnostic:{code:string;message:string})=>void; resumedFrom?:number
}) {
  const checked = checkTrialEvents(options.events, options.evidenceIncomplete, options.resumedFrom), { events, truncatedSuccess } = checked
  const warnings = new Set<string>(TRIAL_EVIDENCE_WARNINGS)
  if (options.resumedFrom !== undefined) warnings.add('试做分两段：第一段中途停止，第二段由新的试做子会话接着完成（记录从 e' + options.resumedFrom + ' 起）；第一段未闭合的调用按结果未知处理。')
  if (truncatedSuccess) warnings.add('部分成功调用的公开摘录已截断：仅按调用报告计为执行成功，提炼时不得把摘录当作完整参数或返回内容。')
  if (options.reviewed) warnings.add('机械检查通过，非机械复核项由真人询问确认；原文件验收报告仍保留 needs-review 状态。')
  if(options.verification?.verdict!=='passed'&&options.verification)warnings.add('试做记录包含未通过或无法核验的检查及最终审阅备注；完整检查报告随 trialReport 传递，不代表工作流已验证。')
  for(const item of [...(options.verification?.inputs??[]),...(options.verification?.artifacts??[])])if(item.status!=='passed')warnings.add(`${item.path}: ${item.status}；${item.reason}`.slice(0,1000))
  let path:ReturnType<typeof verifyTrialPath>|undefined
  if(options.path!==undefined){
    try{path=verifyTrialPath(events,options.path,false,options.resumedFrom);for(const warning of path.warnings)warnings.add(warning)}
    catch(error){const diagnostic=trialPathDiagnostic(error);options.onDiagnostic?.(diagnostic);warnings.add(diagnostic.message)}
  }
  const records: ConversationEvidenceRecord[] = []
  for (const event of events) {
    if(path&&(!(event.type==='tool/call'||event.type==='tool/result')||!path.selected.has(event.callId)))continue
    if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'user/message' && event.source === 'host') continue
    if (!event.text.trim() && !event.truncated) continue
    const record = trialEvidenceRecord(event, checked)
    if (record.status === 'unknown' || record.status === 'failed') warnings.add('存在失败、未知或摘录记录：不要当成已验证事实；未采用的记录写明排除理由，reviewItems 备注可选。')
    records.push(record)
  }
  return validateConversationEvidence(compactTrialEvidence({ version: 1 as const, sessionId: options.childSessionId, fromSeq: events[0]!.seq, throughSeq: events.at(-1)!.seq, records, warnings: [...warnings] }))
}

const COMPACT_NOTE = '\n[摘录：试做记录超限，已缩短]'
type EvidenceBody = Omit<ConversationEvidence, 'digest'>
const sealed = (value: EvidenceBody): ConversationEvidence => ({ ...value, digest: conversationEvidenceDigest(value) })
const fits = (value: EvidenceBody) => value.records.length <= CONVERSATION_EVIDENCE_LIMITS.records && Buffer.byteLength(JSON.stringify(sealed(value)), 'utf8') <= CONVERSATION_EVIDENCE_LIMITS.bytes
const shorten = (record: ConversationEvidenceRecord, chars: number): ConversationEvidenceRecord =>
  record.text.length <= chars ? record : { ...record, text: record.text.slice(0, chars) + COMPACT_NOTE, truncated: true, status: 'unknown' }

/** The rehearsal is for learning the working path, so an oversized record keeps that
 * path and visibly shortens, then folds, superseded or failed attempts; nothing is
 * dropped without a warning naming it. */
export function compactTrialEvidence(value: EvidenceBody): ConversationEvidence {
  if (fits(value)) return sealed(value)
  const original = value.records, last = new Map<string, string>()
  // The latest non-failed call of each tool is the working path, even when its long
  // excerpt was already cut; everything earlier is an attempt.
  for (const record of original) if (record.kind === 'tool-result' && record.status !== 'failed' && record.toolName && record.callId) last.set(record.toolName, record.callId)
  const path = new Set(original.filter(record => !!record.callId && !!record.toolName && last.get(record.toolName) === record.callId).map(record => record.id))
  const keep = (record: ConversationEvidenceRecord) => path.has(record.id), attempt = (record: ConversationEvidenceRecord) => !path.has(record.id)
  const kilobytes = Math.ceil(Buffer.byteLength(JSON.stringify(sealed(value)), 'utf8') / 1000)
  const summary = `试做记录原有 ${original.length} 条、约 ${kilobytes} KB，超过 ${CONVERSATION_EVIDENCE_LIMITS.records} 条或 ${CONVERSATION_EVIDENCE_LIMITS.bytes / 1000} KB；` +
    '按演练用途完整保留各工具最后一次调用，较早尝试、失败调用和说明已缩短或折叠，不代表这些步骤未发生。'
  const uncertain = '存在失败、未知或摘录记录：不要当成已验证事实；未采用的记录写明排除理由，reviewItems 备注可选。'
  let current: EvidenceBody = { ...value, warnings: [...value.warnings.filter(item => item !== uncertain), uncertain, summary] }
  const withRecords = (records: ConversationEvidenceRecord[], extra: string[] = []) => ({ ...current, records, warnings: [...current.warnings, ...extra] })
  const shrink = (select: (record: ConversationEvidenceRecord) => boolean, floor: number) => {
    if (fits(current)) return
    let low: number = floor, high: number = CONVERSATION_EVIDENCE_LIMITS.recordChars
    const at = (chars: number) => withRecords(current.records.map(record => select(record) ? shorten(record, chars) : record))
    if (fits(at(low))) while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(at(mid))) low = mid; else high = mid - 1 }
    current = at(low)
  }
  const fold = (select: (record: ConversationEvidenceRecord) => boolean) => {
    if (fits(current)) return
    const folded: ConversationEvidenceRecord[] = []
    let records = current.records
    while (!fits(withRecords(records, foldWarning(folded))) && records.some(select)) {
      const index = records.findIndex(select); folded.push(records[index]!); records = records.filter((_, i) => i !== index)
    }
    current = withRecords(records, foldWarning(folded))
  }
  // Attempts give way first (shortened, then folded oldest-first); the working path last.
  shrink(attempt, 120); fold(attempt); shrink(keep, 300); fold(() => true)
  if (!current.records.length || !fits(current)) throw Object.assign(new Error(`TRIAL_EVIDENCE_TOO_LARGE：${summary}压缩后仍无法放入上限。`), { code: 'TRIAL_EVIDENCE_TOO_LARGE' })
  return sealed(current)
}
function foldWarning(folded: readonly ConversationEvidenceRecord[]): string[] {
  if (!folded.length) return []
  const tools = new Map<string, number>()
  for (const record of folded) if (record.kind === 'tool-call') tools.set(record.toolName ?? '未知工具', (tools.get(record.toolName ?? '未知工具') ?? 0) + 1)
  const calls = [...tools].map(([name, count]) => `${name}×${count}`).join('、')
  return [`为放入上限折叠了 ${folded.length} 条较早记录（${folded[0]!.id}–${folded.at(-1)!.id}${calls ? `；工具调用 ${calls}` : ''}），这些步骤已执行但不再逐条提供。`.slice(0, 1000)]
}

/** Structure and content integrity only. Restore must additionally check its
 * stored owned receipt, verification digest and parent/child authorization. */
export function validateVerifiedTrialEvidence(value: unknown): VerifiedTrialEvidence {
  const bundle = verifiedTrialEvidenceSchema.parse(value)
  const evidence = validateConversationEvidence(bundle.evidence)
  if (bundle.binding.childSessionId === bundle.binding.rootSessionId || evidence.sessionId !== bundle.binding.childSessionId || evidence.digest !== bundle.binding.evidenceDigest) throw new Error('试做证据会话身份或摘要不匹配')
  return bundle
}
