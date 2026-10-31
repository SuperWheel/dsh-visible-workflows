export const FILE_READ_CAPABILITY_UNAVAILABLE='当前宿主尚未接入可信读取回执，无法验证必读文件；请先接入可核验来源的读取能力。文件存在或工具同名不能证明已读取。'

/** Evidence is unavailable or failed; preserve the record and never infer success. */
export class FileEvidenceError extends Error {
  readonly name='FileEvidenceError'
  constructor(readonly status:'failed'|'unverified',readonly reasons:string[]){super(`文件证据${status==='unverified'?'未验证':'验证失败'}：${reasons.join('；')}`)}
}
