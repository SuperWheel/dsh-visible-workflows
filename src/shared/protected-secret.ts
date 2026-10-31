import { z } from 'zod'

export const PROTECTED_OPERATION = 'deepseek.account-status.v1' as const
export const brokerCodes = ['available','unsupported_platform','signing_untrusted','runtime_unsafe','profile_invalid','access_group_invalid','biometric_unavailable','invalid_request','cancelled','authentication_failed','authorization_required','item_missing','item_invalid','keychain_failed','network_denied','network_failed','busy','internal_error','broker_missing','timeout','invalid_response'] as const
export const brokerCodeSchema = z.enum(brokerCodes)
export type BrokerCode = z.infer<typeof brokerCodeSchema>
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)
export const brokerScopeSchema = z.object({workspaceId:id,workflowId:id,variableId:id,nodeId:id}).strict()
export type BrokerScope = z.infer<typeof brokerScopeSchema>
export const brokerRequestSchema = z.union([
  z.object({version:z.literal(1),command:z.literal('probe')}).strict(),
  z.object({version:z.literal(1),command:z.enum(['status','manage','execute']),operation:z.literal(PROTECTED_OPERATION),scope:brokerScopeSchema}).strict(),
])
export type BrokerRequest = z.infer<typeof brokerRequestSchema>
export type BrokerProbe = {ok:true;available:boolean;code:BrokerCode}
export const BROKER_MESSAGES:Record<BrokerCode,string> = {
  available:'系统凭据库已就绪；管理和首次授权需验证本人身份，已授权的固定目标请求可自动执行。',
  unsupported_platform:'当前平台尚未启用系统凭据管理；可以保存 Secret 声明。',
  signing_untrusted:'缺少受信任的应用签名；当前构建只能检查状态，不能录入或使用密钥。',
  runtime_unsafe:'原生代理的运行时保护未通过检查，已禁用密钥访问。',
  profile_invalid:'缺少有效的应用授权描述文件，不能启用独立 Keychain 访问组。',
  access_group_invalid:'原生代理的专用 Keychain 访问组未通过核验。',
  biometric_unavailable:'系统身份验证暂不可用；请检查系统账户的密码或生物认证设置。',
  invalid_request:'凭据操作参数不符合受控协议。',cancelled:'已取消凭据操作。',
  authentication_failed:'系统身份验证未通过，凭据操作未完成。',
  authorization_required:'此 Secret 尚未授权自动使用，请在系统凭据窗口授权当前工作流和请求目标。',
  item_missing:'当前工作流的凭据尚未在原生代理中配置。',item_invalid:'凭据记录无效，请在原生窗口重新配置。',
  keychain_failed:'受保护存储不可用；没有回退到文件存储。',
  network_denied:'目标或 TLS 校验未通过，受控请求已拒绝。',network_failed:'受控请求未完成；不会自动重试。',
  busy:'原生代理正在处理另一个操作，请稍后重试。',internal_error:'原生代理未完成操作。',
  broker_missing:'尚未安装原生凭据代理。',timeout:'凭据操作已超时；不会自动重试。',invalid_response:'原生代理返回不符合安全协议，结果已丢弃。',
}
