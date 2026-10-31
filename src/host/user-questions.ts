/** Native business clarification and quality review; no execution budget interview. */
export interface WorkflowQuestion { id: string; question: string; header?: string; detail?: string; options?: { label: string; description?: string }[] }
export interface WorkflowQuestionAnswer { answers: { id: string; selected: string[]; custom?: string }[] }
