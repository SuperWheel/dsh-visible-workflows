import { z } from 'zod'
import { parseOSSecretStorageReport, type OSSecretStorageReport } from './os-secret-storage.ts'
import { brokerCodeSchema, BROKER_MESSAGES, type BrokerProbe } from './protected-secret.ts'

/** Observations are closed enums: provider strings, paths and diagnostics never cross this boundary. */
const observationsSchema = z.object({
  credentials: z.enum(['missing', 'local-file', 'unverified']),
  sandbox: z.enum(['missing', 'file-policy-only', 'unverified']),
  toolGuard: z.enum(['missing', 'present']),
  broker: z.enum(['missing', 'unverified']),
}).strict()
export type SecretBoundaryObservations = z.infer<typeof observationsSchema>
export interface SecretBoundaryCheck {
  id: 'credentials' | 'sandbox' | 'tool-guard' | 'broker' | 'trusted-authorization'
  label: string
  status: 'observed' | 'missing' | 'unverified'
  detail: string
}
export interface LegacySecretBoundaryReport {
  schemaVersion: 1
  available: false
  status: 'unavailable'
  checkedAt: string
  summary: string
  observations: SecretBoundaryObservations
  checks: SecretBoundaryCheck[]
}
export interface NativeSecretBoundaryReport extends Omit<LegacySecretBoundaryReport,'schemaVersion'|'available'|'status'> {
  schemaVersion: 2
  available: boolean
  status: 'available'|'unavailable'
  nativeProbe: BrokerProbe
}
const localDeploymentSchema = z.object({
  phase: z.literal('components-only'),
  executor: z.enum(['available', 'unsupported_platform', 'unsupported_arch', 'unsupported_os', 'windows_unverified', 'executor_missing', 'integrity_mismatch', 'insecure_executor', 'invalid_request', 'capability_failed']),
  brokerPackage: z.enum(['verified', 'missing', 'unverified']),
  globalEnforcement: z.literal(false),
  processLifetime: z.literal('unverified'),
}).strict()
export type LocalIsolationDeployment = z.infer<typeof localDeploymentSchema>
export interface LocalSecretBoundaryReport extends Omit<LegacySecretBoundaryReport, 'schemaVersion'> {
  schemaVersion: 3
  deployment: LocalIsolationDeployment
}
export type LegacyBoundaryReport = LegacySecretBoundaryReport | NativeSecretBoundaryReport | LocalSecretBoundaryReport
export type SecretBoundaryReport = LegacyBoundaryReport | OSSecretStorageReport

/** This build has no admitted Secret broker. Presence or a provider's self-report is not proof. */
export function unavailableSecretBoundaryReport(observations: SecretBoundaryObservations, checkedAt = new Date().toISOString()): LegacySecretBoundaryReport {
  const checked = observationsSchema.parse(observations)
  z.string().datetime().parse(checkedAt)
  return {
    schemaVersion: 1, available: false, status: 'unavailable', checkedAt,
    summary: 'Secret 安全存储与受控消费尚未通过隔离验收；仅可保存变量声明，不能录入或使用真实密钥。',
    observations: checked,
    checks: [
      { id: 'credentials', label: '宿主凭据服务', status: checked.credentials === 'missing' ? 'missing' : 'observed',
        detail: checked.credentials === 'local-file' ? '检测到宿主本地文件凭据提供方。文件权限不能阻止同一系统用户运行的 Agent 工具读取，不能用作受保护 Secret 存储。' : checked.credentials === 'missing' ? '未检测到可识别的宿主凭据服务接口。' : '检测到宿主凭据接口；接口存在不代表其存储可对 Agent 保密，当前提供方未通过隔离核验。' },
      { id: 'sandbox', label: 'Agent 文件与进程隔离', status: checked.sandbox === 'missing' ? 'missing' : 'unverified',
        detail: checked.sandbox === 'file-policy-only' ? '检测到宿主文件策略接口。当前 SDK 的文件模式不证明凭据读取、进程与 IPC 隔离；read-only 不等于禁止读取密钥。' : checked.sandbox === 'missing' ? '未检测到宿主沙箱接口，不能证明 Agent 的命令与文件访问受到隔离。' : '检测到无法确认契约的沙箱服务；不能据此开放 Secret。' },
      { id: 'tool-guard', label: '工具调用约束', status: checked.toolGuard === 'present' ? 'observed' : 'missing',
        detail: checked.toolGuard === 'present' ? '宿主提供工具拒绝与范围过滤接口；这只证明接口存在，尚不证明主 Agent、子 Agent、后台进程和外部工具的全部绕过路径已受控。' : '未检测到完整的工具拒绝与范围过滤接口。' },
      { id: 'broker', label: '受保护凭据代理与输出通道', status: checked.broker === 'missing' ? 'missing' : 'unverified',
        detail: checked.broker === 'missing' ? '尚未接入经核验的独立凭据代理。需要由代理持有密钥、执行限定认证请求并仅返回允许的业务结果。' : '检测到候选凭据代理，但本版本没有通过签名、调用身份、目标约束和输出隔离验收的适配器；不能采信其自行声明为可用。' },
      { id: 'trusted-authorization', label: '可信录入、授权与撤销', status: 'unverified',
        detail: '尚未建立不能被 Agent 伪造的录入、授权、轮换和撤销入口；图文件中的标识或 actor 字段不构成使用授权。' },
    ],
  }
}

const reportSchema = z.object({
  schemaVersion: z.literal(1), available: z.literal(false), status: z.literal('unavailable'), checkedAt: z.string().datetime(),
  observations: observationsSchema, summary: z.string(),
  checks: z.array(z.object({ id: z.enum(['credentials', 'sandbox', 'tool-guard', 'broker', 'trusted-authorization']), label: z.string(), status: z.enum(['observed', 'missing', 'unverified']), detail: z.string() }).strict()).length(5),
}).strict()
const nativeProbeSchema=z.object({ok:z.literal(true),available:z.boolean(),code:brokerCodeSchema}).strict().refine(probe=>probe.available===(probe.code==='available'),'原生代理启动状态不一致')
const nativeReportSchema=reportSchema.extend({schemaVersion:z.literal(2),available:z.boolean(),status:z.enum(['available','unavailable']),nativeProbe:nativeProbeSchema}).refine(report=>report.available===report.nativeProbe.available&&report.status===(report.available?'available':'unavailable'),'原生代理报告状态不一致')
const localReportSchema = reportSchema.extend({ schemaVersion: z.literal(3), deployment: localDeploymentSchema })

/** Installed components are not global enforcement or permission to access a credential. */
export function localSecretBoundaryReport(legacy: LegacyBoundaryReport, deployment: LocalIsolationDeployment): LocalSecretBoundaryReport {
  const safe = unavailableSecretBoundaryReport(legacy.observations, legacy.checkedAt)
  const checked = localDeploymentSchema.parse(deployment)
  const executor = checked.executor === 'available'
    ? '本机 MXC 执行器已通过完整性和启动检查。'
    : checked.executor === 'windows_unverified'
      ? 'Windows 隔离尚未完成实机验证。'
      : '本机 MXC 执行器未通过完整性或兼容性检查。'
  return { ...safe, schemaVersion: 3, deployment: checked,
    summary: '本地隔离组件已接入，Secret 仍禁用：全局工具隔离和后台子进程生命周期尚未通过验收。现有 CLI、MCP 与普通工作流保持原有运行方式。',
    checks: safe.checks.map(check => check.id === 'sandbox' ? { ...check, status: 'unverified', detail: `${executor} 尚未接管主 Agent、子 Agent 的全部文件、进程和工具入口；执行器可启动不等于凭据已隔离。` }
      : check.id === 'broker' ? { ...check, status: 'unverified', detail: checked.brokerPackage === 'verified' ? '本地凭据代理文件已通过完整性检查，但尚未取得宿主隔离许可；录入、读取与受控请求全部关闭。' : '本地凭据代理文件未通过完整性检查；录入、读取与受控请求全部关闭。' }
      : check.id === 'trusted-authorization' ? { ...check, status: 'unverified', detail: '后台进程脱离原进程组后仍可能存活，不能把停止按钮或进程退出报告作为隔离完成证明。未通过完整宿主检查时，不会打开凭据录入窗口。' }
      : check),
  }
}

/** Readiness opens only the native UI; it is never a credential binding or grant. */
export function nativeSecretBoundaryReport(legacy:LegacyBoundaryReport,probe:BrokerProbe):NativeSecretBoundaryReport {
  const safe=unavailableSecretBoundaryReport(legacy.observations,legacy.checkedAt),nativeProbe=nativeProbeSchema.parse(probe)
  const detail=BROKER_MESSAGES[nativeProbe.code]
  return {...safe,schemaVersion:2,available:nativeProbe.available,status:nativeProbe.available?'available':'unavailable',nativeProbe,
    summary:`${detail} 启动检查不代表已通过真实凭据隔离验收；每次管理和使用仍须取得原生批准。`,
    checks:safe.checks.map<SecretBoundaryCheck>(check=>check.id==='broker'?{...check,status:nativeProbe.available?'observed':'unverified',detail}:check.id==='trusted-authorization'?{...check,status:'unverified',detail:'凭据只在原生窗口录入，工作流只保存声明。每次管理和使用需要本人进行系统生物认证；流程文件、状态报告和历史结果均不是授权。'}:check),
  }
}

/** Rebuild all displayed text from closed observations; never render remote exception/provider text. */
export function parseSecretBoundaryReport(value: unknown): SecretBoundaryReport {
  if (value && typeof value === 'object' && (value as {schemaVersion?: unknown}).schemaVersion === 4) return parseOSSecretStorageReport(value)
  if (value && typeof value === 'object' && (value as {schemaVersion?: unknown}).schemaVersion === 3) {
    const parsed = localReportSchema.parse(value)
    if (new Set(parsed.checks.map(check => check.id)).size !== 5) throw new Error('Secret 隔离检查项不完整')
    return localSecretBoundaryReport(unavailableSecretBoundaryReport(parsed.observations, parsed.checkedAt), parsed.deployment)
  }
  if(value&&typeof value==='object'&&(value as {schemaVersion?:unknown}).schemaVersion===2){
    const parsed=nativeReportSchema.parse(value)
    if(new Set(parsed.checks.map(check=>check.id)).size!==5)throw new Error('Secret 隔离检查项不完整')
    return nativeSecretBoundaryReport(unavailableSecretBoundaryReport(parsed.observations,parsed.checkedAt),parsed.nativeProbe)
  }
  const parsed = reportSchema.parse(value)
  const safe = unavailableSecretBoundaryReport(parsed.observations, parsed.checkedAt)
  if (new Set(parsed.checks.map(check => check.id)).size !== safe.checks.length) throw new Error('Secret 隔离检查项不完整')
  return safe
}
