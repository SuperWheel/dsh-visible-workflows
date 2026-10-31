import { z } from 'zod'

export const httpCacheSettingsSchema=z.object({httpCacheLimitMB:z.number().int().min(20).max(5000),httpCacheImmediateCleanup:z.boolean()}).strict()
export type HttpCacheSettings=z.infer<typeof httpCacheSettingsSchema>
export const DEFAULT_HTTP_CACHE_SETTINGS:HttpCacheSettings={httpCacheLimitMB:200,httpCacheImmediateCleanup:false}
