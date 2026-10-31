import type { JsonValue } from '../shared/types.ts'
import type { FileEvidenceRequirements, FileEvidenceSnapshot } from '../shared/file-evidence.ts'
import type { DocumentSource } from './document-files.ts'

/** Typed file operations used by execution adapters. Implementations must retain
 * the workspace/path checks of the ordinary document and evidence handlers. */
export interface WorkflowFileEffects {
  extractDocument(root: string, source: JsonValue, signal: AbortSignal): Promise<Record<string, JsonValue>>
  prepareDocumentSources(root: string, source: JsonValue, signal: AbortSignal): Promise<DocumentSource[]>
  captureFileEvidence(root: string, requirements: FileEvidenceRequirements, signal: AbortSignal): Promise<FileEvidenceSnapshot>
  verifyRequiredFiles(root: string, paths: readonly string[], signal: AbortSignal): Promise<void>
}
