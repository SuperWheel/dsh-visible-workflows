import { z } from 'zod'
import { brokerCodeSchema, BROKER_MESSAGES, type BrokerCode, type BrokerProbe } from './protected-secret.ts'

export const OS_SECRET_MESSAGES: Record<BrokerCode, string> = {
  ...BROKER_MESSAGES,
  available: '系统凭据库已就绪。管理密钥和首次授权时验证本人身份；已授权的固定目标请求可自动执行。',
  unsupported_platform: '当前平台尚未启用系统凭据管理；可以保存 Secret 声明。',
  biometric_unavailable: '系统身份验证暂不可用；请检查系统账户的密码或生物认证设置。',
  authentication_failed: '系统身份验证未通过，凭据操作未完成。',
  runtime_unsafe: '凭据管理组件未通过完整性检查；普通工作流和其他插件不受影响。',
  broker_missing: '尚未安装系统凭据管理组件；可以保存 Secret 声明。',
  keychain_failed: '系统凭据库不可用；没有回退到文件或普通环境变量。',
}
const probeSchema = z.object({ ok: z.literal(true), available: z.boolean(), code: brokerCodeSchema }).strict()
  .refine(value => value.available === (value.code === 'available'))
const platformSchema = z.enum(['macos', 'windows', 'unsupported'])
const checkSchema = z.object({ id: z.enum(['storage', 'authentication', 'interface', 'host', 'platform']), label: z.string(), status: z.enum(['observed', 'missing', 'unverified']), detail: z.string() }).strict()
const storageReportSchema = z.object({
  schemaVersion: z.literal(4), mode: z.literal('os-credential-store'), platform: platformSchema,
  available: z.boolean(), status: z.enum(['available', 'unavailable']), checkedAt: z.string().datetime(),
  nativeProbe: probeSchema, summary: z.string(), checks: z.array(checkSchema).length(5),
  protection: z.literal('workflow-interfaces'), arbitraryLocalCodeIsolation: z.literal(false),
}).strict().refine(value => value.available === value.nativeProbe.available && value.status === (value.available ? 'available' : 'unavailable'))
  .refine(value => value.platform === 'macos' || !value.available)
export type OSSecretStorageReport = z.infer<typeof storageReportSchema>

/** Reports component readiness, never an authentication grant or whole-device isolation. */
export function osSecretStorageReport(platform: OSSecretStorageReport['platform'], probe: BrokerProbe, checkedAt = new Date().toISOString()): OSSecretStorageReport {
  platformSchema.parse(platform); z.string().datetime().parse(checkedAt)
  const nativeProbe = probeSchema.parse(probe)
  if (platform !== 'macos' && nativeProbe.available) throw new Error('该平台的凭据组件尚未验收')
  const available = nativeProbe.available
  return {
    schemaVersion: 4, mode: 'os-credential-store', platform, available, status: available ? 'available' : 'unavailable', checkedAt, nativeProbe,
    protection: 'workflow-interfaces', arbitraryLocalCodeIsolation: false,
    summary: platform === 'windows' ? 'Windows 凭据管理器与系统认证尚待 Windows 实机验收；当前只保存声明，不阻碍其他功能。' : OS_SECRET_MESSAGES[nativeProbe.code],
    checks: [
      { id: 'storage', label: '系统凭据库', status: available ? 'observed' : 'unverified', detail: platform === 'macos' ? '密钥保存在 macOS 登录钥匙串；不写入工作流文件、JSON、运行快照或进程环境变量。' : 'Windows 方案使用凭据管理器；尚未完成实机验收，不启用未验证后端。' },
      { id: 'authentication', label: '本人管理', status: available ? 'observed' : 'unverified', detail: '用户在独立原生窗口查看、编辑、保存和删除；由系统确认身份。原值不会返回画布接口。' },
      { id: 'interface', label: 'Agent 引用', status: 'observed', detail: '主 Agent、子 Agent 的工作流接口只取得声明与引用；受控操作在原生组件内使用密钥，返回限定业务结果。当前提供 DeepSeek 账户连接检查。自动使用须由用户在原生窗口授权，可随时撤销；修改凭据或目标后需重新授权。' },
      { id: 'host', label: '正常使用', status: 'observed', detail: '不接管 DSH 启动，不修改其他插件、普通工具和用户环境变量。此方案不承诺抵御同账户任意本机代码或用户主动显示后的屏幕读取。' },
      { id: 'platform', label: '平台验证', status: available ? 'observed' : 'unverified', detail: available ? '启动检查通过；实际凭据管理仍需本人完成系统认证。' : OS_SECRET_MESSAGES[nativeProbe.code] },
    ],
  }
}

export function parseOSSecretStorageReport(value: unknown): OSSecretStorageReport {
  const parsed = storageReportSchema.parse(value)
  if (new Set(parsed.checks.map(check => check.id)).size !== 5) throw new Error('凭据存储检查项不完整')
  return osSecretStorageReport(parsed.platform, parsed.nativeProbe, parsed.checkedAt)
}
