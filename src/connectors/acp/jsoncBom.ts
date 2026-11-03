/**
 * UTF-8 BOM handling for the editor settings files the ACP installers edit
 * (#700, #709).
 *
 * Windows tools write a leading BOM: OpenCode Desktop, a PowerShell `>`
 * redirect, VS Code on ENCODING_UTF8BOM. `jsonc-parser` rejects it as
 * InvalidSymbol at offset 0, which turned the installer and the startup
 * reconcile into a silent no-op on that machine. Strip it for parse and edit,
 * then put it back on write, so the file keeps the encoding its owner gave it.
 */
const BOM = "﻿";

export function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM)
    ? { bom: BOM, body: text.slice(1) }
    : { bom: "", body: text };
}
