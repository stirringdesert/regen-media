// ONE contact sheet per run: labelled tiles, <= 1600px wide, <= ~400 KB (jpeg). Used by every check type.
// tile = { label, png: Buffer, w, h (source css px), clipH?: visible height, status?: 'ok'|'warn'|'fail' }
import fs from 'node:fs';

const PAD = 10, GAP = 12, LAB = 20;
function layout(tiles, s, maxW) {
  const rows = []; let row = [], x = PAD;
  for (const t of tiles) {
    const tw = Math.round(t.w * s);
    if (row.length && x + tw > maxW - PAD) { rows.push(row); row = []; x = PAD; }
    row.push({ t, tw, th: Math.round(Math.min(t.clipH || t.h, t.h) * s) }); x += tw + GAP;
  }
  if (row.length) rows.push(row);
  let y = PAD, W = 0; const placed = [];
  for (const r of rows) {
    let x2 = PAD;
    for (const c of r) { placed.push({ ...c, x: x2, y }); x2 += c.tw + GAP; }
    W = Math.max(W, x2 - GAP + PAD); y += Math.max(...r.map(c => c.th)) + LAB + GAP;
  }
  return { placed, W: Math.min(W, maxW), H: y - GAP + PAD };
}

export async function makeSheet(browser, tiles, file, { maxW = 1600, maxBytes = 400 * 1024 } = {}) {
  const natW = tiles.reduce((a, t) => Math.max(a, t.w), 0);
  let best = null;
  for (const s of [0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15]) {
    const L = layout(tiles, Math.min(s, maxW / natW), maxW);
    best = L; if (L.H <= 1150) break;
  }
  const col = { ok: '#9ad', warn: '#fc4', fail: '#f66' };
  const html = `<body style="margin:0;background:#1b1b1b;width:${best.W}px;height:${best.H}px;position:relative;font:12px/${LAB}px ui-monospace,monospace;color:#ddd">` +
    best.placed.map(p => `<div style="position:absolute;left:${p.x}px;top:${p.y}px;width:${p.tw}px"><div style="height:${LAB}px;white-space:nowrap;overflow:hidden;color:${col[p.t.status || 'ok']}">${p.t.label}</div>` +
      `<div style="width:${p.tw}px;height:${p.th}px;overflow:hidden;outline:1px solid #444"><img src="data:image/png;base64,${p.t.png.toString('base64')}" style="width:${p.tw}px;display:block"></div></div>`).join('') + '</body>';
  const page = await browser.newPage({ viewport: { width: best.W, height: best.H } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => 0))));
  let buf, q;
  for (q of [80, 68, 56, 44, 32]) { buf = await page.screenshot({ type: 'jpeg', quality: q }); if (buf.length <= maxBytes) break; }
  await page.close();
  fs.writeFileSync(file, buf);
  return { w: best.W, h: best.H, bytes: buf.length, q };
}
