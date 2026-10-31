import { businessModuleCatalog } from '../../src/shared/planning-business-modules.ts'

// Explicit route decision for new design-entry fixtures; historical evidence stays verbatim.
export const moduleCheck={checked:businessModuleCatalog().map(row=>`${row.id}@${row.version}`),notApplicable:'此夹具需要自定义业务逻辑，目录中的固定表格及审核写入结构均不适用'}
