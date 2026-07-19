// Split a long reply on paragraph boundaries so WhatsApp gets a few whole
// messages instead of one truncated wall. Dep-free so it stays self-checkable.
export function splitMessage(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let cur = "";
  for (const para of text.split("\n\n")) {
    const pieces =
      para.length > max ? para.match(new RegExp(`.{1,${max}}`, "gs")) : [para];
    for (const p of pieces) {
      if (cur && cur.length + p.length + 2 > max) {
        parts.push(cur);
        cur = "";
      }
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}
