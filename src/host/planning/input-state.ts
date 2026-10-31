/** Host-runtime routing only. Pending means native delivery/answer work is
 * owned by the Host; it is not an acknowledgement that a UI card is visible. */
export interface PlanningInputState {
  mode: 'native-pending' | 'settling' | 'manual'
  revision: number
  nativeQuestionPending: boolean
  manualAnswerAllowed: boolean
  nextAction: 'wait-for-host-question' | 'wait-for-task-state' | 'ask-human-then-plan-answer'
  instruction: string
}

export function planningInputState(revision: number, nativePending: boolean, active: boolean): PlanningInputState {
  if (nativePending) return { mode: 'native-pending', revision, nativeQuestionPending: true, manualAnswerAllowed: false, nextAction: 'wait-for-host-question', instruction: 'Host 正在投递或等待本批原生真人问题；pending 不保证界面已经显示。请等待并使用原 Host 问题回答，不要再调用 ask_user_question 复制问题，不调用 plan_answer、不猜 revision；原生回答会自动续接同一任务。' }
  if (active) return { mode: 'settling', revision, nativeQuestionPending: false, manualAnswerAllowed: false, nextAction: 'wait-for-task-state', instruction: '当前规划 activation 尚在清理，手动回答暂不可用。等待同 task 的状态更新后读取 input；不要重复提问、重试 plan_answer 或猜 revision。' }
  return { mode: 'manual', revision, nativeQuestionPending: false, manualAnswerAllowed: true, nextAction: 'ask-human-then-plan-answer', instruction: '当前没有 Host 原生待答过程，手动回答入口已就绪。完整转达本批 questions，保留问题 ID，取得真人回答后用同 task_id 和本次读取的 revision 调用 plan_answer；不代答、不猜 revision。' }
}

/** Operation refusal, not a failed planning task or a retry invitation. */
export class PlanningAnswerError extends Error {
  readonly retryable = false
  constructor(readonly code: string, message: string, readonly nextAction: string, readonly input?: PlanningInputState) {
    super(`${code}: ${message}`); this.name = 'PlanningAnswerError'
  }
}
