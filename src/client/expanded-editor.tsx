import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

/** A large, right-aligned editing surface using the host's focus and dismissal behavior. */
export function ExpandedEditorShell({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return <Modal open headless title={label} className="vdw-modal vdw-expanded-editor" backdropBlur={false} onClose={onClose}>{children}</Modal>
}
