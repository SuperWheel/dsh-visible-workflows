import { t, useLocale } from './i18n.ts'
import type { NodeExecution, WorkflowRun } from '../shared/types.ts'
import { DataViewer } from './data-viewer.tsx'
import type { FileEvidenceState,FileFingerprint } from '../shared/file-evidence.ts'

export const runStatusLabel: Record<string, string> = {waiting:'等待输入',running:'运行中',paused:'已暂停',pausing:'暂停中',budget_waiting:'旧运行已暂停',success:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断',pending:'等待执行',skipped:'已跳过'}
export function executionDuration(start?: string, end?: string) {
  if (!start || !end) return undefined
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return undefined
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}
export function StatusBadge({status}: {status: string}) {useLocale(); return <span className="vdw-result-status" data-status={status}><span className="vdw-status-dot" data-status={status}/>{t(runStatusLabel[status] || status)}</span> }
export function ExecutionSummary({execution, revision}: {execution: Omit<Pick<NodeExecution, 'status'|'startedAt'|'endedAt'|'model'|'effort'|'tokenEstimate'>, 'status'> & {status: string}; revision?: number}) {useLocale();
  const duration = executionDuration(execution.startedAt, execution.endedAt)
  return <div className="vdw-result-summary"><div className="vdw-result-summary-top"><StatusBadge status={execution.status}/>{duration && <span className="vdw-result-duration">{duration}</span>}{revision !== undefined && <small>{t("源版本 v")}{revision}</small>}</div>{(execution.model || execution.effort || execution.tokenEstimate) && <dl className="vdw-result-metadata">{execution.model && <><dt>{t("模型")}</dt><dd>{execution.model.model}<small>{execution.model.provider}</small></dd></>}{execution.effort && <><dt>{t("思考强度")}</dt><dd>{execution.effort}</dd></>}{execution.tokenEstimate && <><dt>{t("估算用量")}</dt><dd>{execution.tokenEstimate.tokens.toLocaleString('zh-CN')} tokens<small>{t("轻量估算")}</small></dd></>}</dl>}</div>
}
export function ExecutionDetails({execution, summary = true}: {execution: NodeExecution; summary?: boolean}) {useLocale();
  return <div className="vdw-result-details">{summary && <ExecutionSummary execution={execution}/>}<DataViewer title={t("输入")} value={execution.input}/><DataViewer title={t("输出")} value={execution.output}/>{execution.data !== undefined && <DataViewer title={t("结构化输出")} value={execution.data}/>} {execution.subagentId&&<div className="vdw-result-agent"><strong>{t("宿主子 Agent")}</strong><code>{execution.subagentId}</code></div>}{execution.reusedFromRunId&&<p className="vdw-muted">{t("已复用历史结果 ·")}{execution.reusedFromRunId}</p>}{execution.childRunId&&<p className="vdw-muted">{t("子运行：")}<code>{execution.childRunId}</code></p>}{execution.subagentId&&<p className="vdw-muted">{t("修复次数：")}{execution.repairTaskIds?.length??0}</p>}{!!execution.repairTaskIds?.length&&<DataViewer title={t("修复任务")} value={execution.repairTaskIds}/>} {execution.verification&&<><p className="vdw-muted">{t("结果验证：")}{{passed:t("通过"),failed:t("验证失败"),unverified:t("未验证")}[execution.verification.status]}</p>{!!execution.verification.reasons.length&&<DataViewer title={t("验证说明")} value={execution.verification.reasons}/>}</>}{execution.fileEvidence&&<FileEvidenceDetails evidence={execution.fileEvidence}/>} {execution.tokenUsage!==undefined&&<DataViewer title={t("实际模型用量")} value={execution.tokenUsage}/>} {execution.error && <div className="vdw-result-error" role="alert"><strong>{t("执行错误")}</strong><p>{execution.error}</p></div>}</div>
}
export function FileEvidenceDetails({evidence}:{evidence:FileEvidenceState}){useLocale();
 const paths=[...new Set([...Object.keys(evidence.before.files),...Object.keys(evidence.after?.files??{})])].sort()
 const fingerprint=(file:FileFingerprint|undefined)=>!file?t('尚未采集'):file.status==='present'?`SHA-256 ${file.sha256??t('不可用')} · ${t('{size} 字节','{size} bytes',{size:file.size??0})}`:file.status==='missing'?t('文件不存在'):t('未验证：{reason}','Unverified: {reason}',{reason:file.reason??t('缺少可信证据')})
 return <section className="vdw-file-evidence" aria-label={t("文件验收证据")}><strong>{t("文件验收证据")}</strong><p className="vdw-muted">{t("这里只展示文件指纹与读取回执摘要，不保存或展示文件正文。内容变化不表示已证明修改者身份。")}</p>{paths.map(path=>{const reads=evidence.reads.filter(read=>read.path===path);return <article key={path} className="vdw-config-group vdw-file-evidence-card"><code className="vdw-file-evidence-path">{path}</code><p>{t("执行前：")}{fingerprint(evidence.before.files[path])}</p><p>{t("执行后：")}{fingerprint(evidence.after?.files[path])}</p>{reads.map((read,index)=><div key={index}><p>{t("资料读取：")}{read.status==='passed'?t("已取得完整成功回执"):t("未验证")} · {read.calls} {t("次")}</p><p>{read.reason}</p><small>{t("任务")}{read.taskId} {t("· 工具")}{read.tools.join('、')||t('无可信回执')}</small></div>)}</article>})}</section>
}
export function RunOutputs({run}: {run: WorkflowRun}) {useLocale(); return <div className="vdw-run-output"><h3>{t("运行结果")}</h3>{Object.entries(run.outputs).map(([name, value]) => <DataViewer key={name} title={name} value={value}/>)}</div> }
