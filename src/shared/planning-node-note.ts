import { z } from 'zod'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'

export const nodeDescription = z.string().max(2000).describe('节点备注，仅作说明，不影响执行；可省略。最多2000字。')
// SDK 的字符串子集没有 maxLength；长度由上面同一字段合同在编译时强制检查。
export const nodeDescriptionWire: JsonSchemaNode = { type: 'string', description: nodeDescription.description }
export const updateDescriptionWire: JsonSchemaNode = { oneOf: [nodeDescriptionWire, { type: 'null' }], description: '节点备注，仅作说明，不影响执行；可省略。字符串设置备注（最多2000字），null 清除；省略保留原备注。' }
