export interface FileEvidenceRequirements { requiredFiles?:readonly string[];requiredReadFiles?:readonly string[];requiredChangedFiles?:readonly string[] }
export interface FileFingerprint {
  path:string;status:'present'|'missing'|'unverified';sha256?:string;size?:number;reason?:string
  /** Digest of normalized line hashes; never stores document text. */
  text?:{lineCount:number;digest:string}
}
export interface FileEvidenceSnapshot { version:1;workspaceRootDigest:string;files:Record<string,FileFingerprint> }
export type NativeFileReadContract='dsh-tool-fs/read@0.2.0-rc.2'|'dsh-tool-str-replace-editor/view@0.2.0-rc.2'
export interface NativeFileReadReceipt { path:string;sha256?:string;taskId:string;tools:string[];calls:number;status:'passed'|'unverified';reason:string }
export interface FileEvidenceState { before:FileEvidenceSnapshot;after?:FileEvidenceSnapshot;reads:NativeFileReadReceipt[] }
export interface FileEvidenceVerification { status:'passed'|'failed'|'unverified';reasons:string[];files:FileEvidenceState & {after:FileEvidenceSnapshot} }
