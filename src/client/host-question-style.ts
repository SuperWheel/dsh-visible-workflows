/**
 * Stopgap for the host question card (`@deepseek-ai/dsh-client-ui-user-questions`).
 * Its Markdown `detail` sits in the scroll body (no padding) but keeps the
 * 2px side margin written for the heading block, so the text touches the card
 * edge. Align it with the card title: 24px, or 18px under the host's own
 * `width<=720px` rule. The body's only role-less child is `detail` (options use
 * radiogroup/group), so no hashed host class is referenced. Remove once the
 * host gives `detail` its own inset. See DESIGN.md §31.
 */
export const hostQuestionStyles = `
[data-question-scroll] > div:not([role]) { margin-inline:24px; }
@media (width<=720px) { [data-question-scroll] > div:not([role]) { margin-inline:18px; } }
`
