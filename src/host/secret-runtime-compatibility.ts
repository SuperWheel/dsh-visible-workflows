import type { Context } from '@deepseek-ai/cordis'

/** Retired global interception must never silently fall back to ordinary effects.
 * The current OS credential component runs independently of those Host services. */
export function assertCurrentSecretRuntime(ctx: Context): void {
  if (ctx.root.get('secretIsolationBoundary', false) || ctx.root.get('workflowIsolation', false)) {
    throw new Error('检测到已停用的全局 Secret 隔离组件，请先移除旧组件并重启 DeepSeek Harness')
  }
}
