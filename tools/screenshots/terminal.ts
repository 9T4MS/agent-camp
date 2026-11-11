/** Render a captured terminal transcript (screenshots/terminal-install.txt) as a terminal window. */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function line(raw: string): string {
  if (raw.startsWith("$ ")) {
    const body = raw.slice(2);
    const hash = body.indexOf("   #");
    const cmd = hash >= 0 ? body.slice(0, hash) : body;
    const note = hash >= 0 ? body.slice(hash) : "";
    return `<span class="ps">~ $</span> <span class="cmd">${esc(cmd)}</span><span class="c">${esc(note)}</span>`;
  }
  if (raw.startsWith("#")) return `<span class="c">${esc(raw)}</span>`;
  if (raw.startsWith("  | ")) return `<span class="log">${esc(raw)}</span>`;
  if (/^(warning| {2}note)/.test(raw)) return `<span class="warn">${esc(raw)}</span>`;
  if (/^Done\.|updated to|installed agent-office/.test(raw.trim()))
    return `<span class="ok">${esc(raw)}</span>`;
  return esc(raw);
}

export function terminalHtml(text: string, title = "agent-office — install"): string {
  const body = text.replace(/\s+$/, "").split("\n").map(line).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#3a4466}
  body{padding:28px;font:13px/1.45 "DejaVu Sans Mono","Menlo",ui-monospace,monospace}
  .win{background:#181425;border-radius:10px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.45);border:1px solid #5a6988}
  .bar{height:30px;background:#262b44;display:flex;align-items:center;gap:8px;padding:0 12px;color:#8b9bb4;font:12px system-ui,sans-serif}
  .bar i{width:12px;height:12px;border-radius:50%;display:inline-block}
  .bar span{flex:1;text-align:center;margin-right:60px}
  pre{margin:0;padding:16px 18px 20px;color:#ead4aa;white-space:pre-wrap;word-break:break-word}
  .ps{color:#63c74d}.cmd{color:#ffffff;font-weight:bold}.c{color:#8b9bb4}.log{color:#2ce8f5}
  .warn{color:#feae34}.ok{color:#63c74d}
  </style></head><body><div class="win"><div class="bar">
  <i style="background:#e43b44"></i><i style="background:#feae34"></i><i style="background:#63c74d"></i>
  <span>${esc(title)}</span></div><pre>${body}</pre></div></body></html>`;
}
