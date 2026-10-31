/** Only workflow Select portals match their trigger; other host/plugin menus retain their own size. */
export const selectStyles = `
.vdw-select-list.vdw-menu { width:var(--vdw-select-trigger-width,180px); min-width:0; max-width:calc(100vw - 24px); box-sizing:border-box; overflow-x:hidden; }
.vdw-select-list.vdw-menu [role=menuitem] { width:100%; min-width:0; height:auto; white-space:normal; align-items:flex-start; }
.vdw-select-list.vdw-menu [role=menuitem] > span { min-width:0; max-width:100%; white-space:normal; overflow:visible; text-overflow:clip; overflow-wrap:anywhere; }
`
