import { z } from 'zod'
import { isReviewedFileWriteTarget } from './planning-review-recipe.ts'

const literal=z.string().refine(value=>!value.includes('{{'),'模块参数仅接受字面文本，不接受工作流引用')
const field=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/).refine(value=>!['constructor','prototype','__proto__'].includes(value))
export const businessModuleParametersSchema=z.object({
  title:literal.pipe(z.string().min(1).max(160)),
  columns:z.array(z.object({key:field,label:literal.pipe(z.string().min(1).max(100))}).strict()).min(1).max(10).refine(columns=>new Set(columns.map(column=>column.key)).size===columns.length,'列 key 必须唯一'),
  emptyText:literal.pipe(z.string().max(1000)).default('暂无数据'),
}).strict()
export const reviewedFileWriteParametersSchema=z.object({
  target:literal.refine(isReviewedFileWriteTarget,'目标必须是字面量工作区根相对文件路径，不能是草稿目录或通配符'),
  producer:z.object({text:z.string().max(400_000).describe('正文模板；可引用 reviewBase（上次表单正文）和 reviewNote（退回意见）。不调用模型。')}).strict(),
  maxIterations:z.number().int().min(1).max(100).default(3),
}).strict()
export const BUSINESS_MODULE_INSTANCE_KEY_MAX_LENGTH=24
export const BUSINESS_MODULE_INSTANCE_KEY_PATTERN=new RegExp(`^[A-Za-z][A-Za-z0-9_-]{0,${BUSINESS_MODULE_INSTANCE_KEY_MAX_LENGTH-1}}$`)
export const BUSINESS_MODULE_INSTANCE_KEY_RULE=`英文字母开头，仅含英文字母、数字、_、-，1–${BUSINESS_MODULE_INSTANCE_KEY_MAX_LENGTH} 字符（${BUSINESS_MODULE_INSTANCE_KEY_PATTERN.source}）`
const instanceKey=z.string().regex(BUSINESS_MODULE_INSTANCE_KEY_PATTERN,BUSINESS_MODULE_INSTANCE_KEY_RULE)
export const businessModuleRequestSchema=z.discriminatedUnion('moduleId',[z.object({
  moduleId:z.literal('structured-result-table'),version:z.literal('1.0.0'),
  instanceKey,
  parameters:businessModuleParametersSchema,
}).strict(),z.object({
  moduleId:z.literal('reviewed-file-write'),version:z.literal('1.0.0'),instanceKey,
  parameters:reviewedFileWriteParametersSchema,
}).strict()])
export type BusinessModuleRequest=z.infer<typeof businessModuleRequestSchema>
