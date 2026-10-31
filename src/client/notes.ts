import type { CanvasNote, CanvasNoteColor } from '../shared/types.ts'
export { noteSize, moveAttachedNotes, arrangeAttachedNotes } from '../shared/canvas-notes.ts'
const detach=(note:CanvasNote):CanvasNote=>{const {anchorNodeId:_,...rest}=note;return rest}

export const NOTE_COLORS:{id:CanvasNoteColor;label:string}[]=[{id:'yellow',label:'黄色'},{id:'blue',label:'蓝色'},{id:'green',label:'绿色'},{id:'purple',label:'紫色'},{id:'neutral',label:'中性色'}]
export const NOTE_TONES:Record<CanvasNoteColor,string>={yellow:'#d6b33b',blue:'#6193c9',green:'#6ba083',purple:'#a081bd',neutral:'#8e929b'}
export function noteColor(note:Pick<CanvasNote,'color'>):CanvasNoteColor{return NOTE_COLORS.some(c=>c.id===note.color)?note.color!:'yellow'}
export function noteTone(note:Pick<CanvasNote,'color'>):string{return NOTE_TONES[noteColor(note)]}
/** Whole-workflow copies pass the old-to-new node map; missing copied anchors become free notes. */
export function remapNoteAnchors(notes:readonly CanvasNote[],nodeIdMap:ReadonlyMap<string,string>):CanvasNote[]{
  return notes.map(note=>{if(!note.anchorNodeId)return {...note};const anchorNodeId=nodeIdMap.get(note.anchorNodeId);return anchorNodeId?{...note,anchorNodeId}:detach(note)})
}
