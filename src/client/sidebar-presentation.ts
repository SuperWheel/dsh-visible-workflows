/** Host fullscreen is shared by every pane. Only adapt a fresh, exclusively
 * workflow-owned transition; visibility alone does not establish ownership. */
export interface WorkflowSidebarPresentation {
  sessionId: string
  tabId: string
  visible: boolean
  fullscreen: boolean
  width: number
}

export function isWorkflowExpandTransition(
  previous: WorkflowSidebarPresentation | undefined,
  current: WorkflowSidebarPresentation,
): boolean {
  return !!previous && previous.sessionId === current.sessionId && previous.tabId === current.tabId
    && previous.visible && current.visible && !previous.fullscreen && current.fullscreen
    && previous.width >= 768 && current.width >= 768
}

interface Target { sessionId: string; tabId?: string; host: string }
interface Tab { id: string; kind: string }
/** These are public, read-only host queries plus its target-scoped command. */
export interface WorkflowSidebarHost<T extends Target> {
  mounted: { getSnapshot(): string | undefined }
  active(): Tab | undefined
  tabsIn(sessionId: string): readonly Tab[]
  commandTarget(): T | undefined
  isTargetCurrent(target: T): boolean
  toggleFullscreen(target: T): void
}

export function adaptWorkflowFullscreen<T extends Target>(
  previous: WorkflowSidebarPresentation | undefined,
  current: WorkflowSidebarPresentation,
  host: WorkflowSidebarHost<T>,
  expand: () => void,
): boolean {
  if (!isWorkflowExpandTransition(previous, current) || host.mounted.getSnapshot() !== current.sessionId) return false
  const tabs = host.tabsIn(current.sessionId), active = host.active()
  // Even inactive foreign tabs share the host's mode. Leave multi-tab, split,
  // guide and floating layouts entirely to the shell, without rewriting them.
  if (tabs.length !== 1 || tabs[0]?.id !== current.tabId || tabs[0].kind !== 'visible-workflows'
    || active?.id !== current.tabId || active.kind !== 'visible-workflows') return false
  const target = host.commandTarget()
  if (!target || target.sessionId !== current.sessionId || target.tabId !== current.tabId
    || target.host !== 'dock' || !host.isTargetCurrent(target)) return false
  host.toggleFullscreen(target)
  expand()
  return true
}
