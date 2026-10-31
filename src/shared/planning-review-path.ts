export const REVIEW_DRAFT_PREFIX='.dsh-drafts/{{sys.workflow_run_id}}/'
export function reviewDraftPath(value:unknown):value is string {
  if(typeof value!=='string'||!value.startsWith(REVIEW_DRAFT_PREFIX))return false
  const tail=value.slice(REVIEW_DRAFT_PREFIX.length)
  // A dynamic suffix could traverse outside the draft directory after expansion.
  return !!tail&&!/[{}\\\x00:]/.test(tail)&&!tail.startsWith('/')&&tail.split('/').every(p=>!!p&&p!=='.'&&p!=='..')
}
