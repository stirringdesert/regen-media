// check print <target>: PDF / SVG / PNG / TIFF print files. Needs poppler (pdfinfo/pdffonts/pdfimages/pdftoppm/pdftotext), ImageMagick `identify`/`convert`, python3 + pypdf.
// Config: source, trim [w,h] mm, bleed mm, safe mm, colorspace CMYK|RGB, maxMB, dpi {warn,fail}, hairlinePt, booklet {order reading|imposed, spreads, folios}, svgMmPerUnit, zoomDpi, thumbDpi.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveSource, KIT } from '../core/util.mjs';

const MM = 25.4, PT = 72;
const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: o.buffer ? 'buffer' : 'utf8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'], ...o });
const have = c => { try { sh('which', [c]); return true; } catch { return false; } };
const r1 = x => Math.round(x * 10) / 10;
const group = a => { const m = new Map(); a.forEach((x, i) => m.set(x, [...(m.get(x) || []), i + 1])); return [...m].map(([k, p]) => p.length === a.length ? k : `${k} [p${p.join(',')}]`); };
const list = (a, n = 3) => a.slice(0, n).join('; ') + (a.length > n ? `; +${a.length - n}` : '');
const UNIT = { mm: 1, cm: 10, in: MM, pt: MM / 72, pc: MM / 6, px: MM / 96 };
const parseLen = (s, dflt) => { const m = /^\s*([\d.]+)\s*(mm|cm|in|pt|pc|px)?\s*$/.exec(s || ''); return m ? parseFloat(m[1]) * (m[2] ? UNIT[m[2]] : dflt) : null; };

// ---- source loaders: each returns { kind, pages: [{mm:[w,h], trimPx?}], ... } ----
function loadPdf(file, cfg, out) {
  const probe = JSON.parse(sh('python3', [path.join(KIT, 'lib', 'pdfprobe.py'), file]));
  const pages = probe.pages.map(p => {
    const sw = p.rotate % 180 === 90, m = p.media, w = (m[2] - m[0]) / PT * MM, h = (m[3] - m[1]) / PT * MM;
    return { ...p, mm: sw ? [h, w] : [w, h] };
  });
  const fonts = sh('pdffonts', [file]).split('\n').slice(2).filter(l => l.trim()).map(l => { const t = l.trim().split(/\s+/); const i = t.findIndex(x => /^(yes|no)$/.test(x)); return { name: t[0], emb: t[i] === 'yes' }; });
  const imgs = sh('pdfimages', ['-list', file]).split('\n').slice(2).filter(l => l.trim()).map(l => { const t = l.trim().split(/\s+/); return { page: +t[0], type: t[2], w: +t[3], h: +t[4], color: t[5], x: +t[12], y: +t[13] }; }).filter(i => i.type === 'image');
  return { kind: 'pdf', pages, fonts, imgs, probe };
}
function ident(file) {
  return sh('identify', ['-format', '%w %h %x %y %U %[colorspace]\\n', file]).split('\n').filter(Boolean).map(l => { const [w, h, x, y, u, cs] = l.split(' '); return { w: +w, h: +h, x: +x, y: +y, u, cs }; });
}
function loadRaster(file, cfg) {
  const fr = ident(file);
  const full = cfg.trim ? [cfg.trim[0] + 2 * (cfg.bleed || 0), cfg.trim[1] + 2 * (cfg.bleed || 0)] : null;
  const pages = fr.map(f => {
    const meta = f.u === 'PixelsPerInch' ? f.x : f.u === 'PixelsPerCentimeter' ? f.x * 2.54 : 0;
    const mm = meta > 1 ? [f.w / meta * MM, f.h / meta * MM] : (full ? full : [f.w / 300 * MM, f.h / 300 * MM]);
    return { mm, px: [f.w, f.h], metaDpi: meta, cs: f.cs, effDpi: full ? f.w / (full[0] / MM) : meta };
  });
  return { kind: 'raster', pages };
}
function loadSvg(file, cfg) {
  const t = fs.readFileSync(file, 'utf8'), head = (/<svg\b[^>]*>/.exec(t) || [''])[0];
  const attr = n => (new RegExp(`\\b${n}="([^"]*)"`).exec(head) || [])[1];
  const k = cfg.svgMmPerUnit || UNIT.px, vb = (attr('viewBox') || '').split(/[\s,]+/).map(Number);
  const w = parseLen(attr('width'), k) ?? (vb[2] * k), h = parseLen(attr('height'), k) ?? (vb[3] * k);
  const unitMm = vb.length === 4 && attr('width') ? w / vb[2] : k;   // mm per user unit
  const texts = (t.match(/<text\b/g) || []).length;
  const widths = [...t.matchAll(/stroke-width[=:]\s*"?([\d.]+)/g)].map(m => +m[1] * unitMm / MM * PT).filter(x => x > 0);
  const imgs = [];
  for (const m of t.matchAll(/<image\b[^>]*>/g)) {
    const tag = m[0], d = /href="data:image\/[a-z+]+;base64,([^"]+)"/.exec(tag), iw = /\bwidth="([\d.]+)"/.exec(tag), ih = /\bheight="([\d.]+)"/.exec(tag);
    if (!d || !iw) continue;
    try { const [pw] = sh('identify', ['-format', '%w %h', '-'], { input: Buffer.from(d[1], 'base64') }).split(' ').map(Number); imgs.push({ dpi: pw / (+iw[1] * unitMm / MM) }); } catch {}
  }
  return { kind: 'svg', pages: [{ mm: [w, h], unitMm, texts, minStrokePt: widths.length ? Math.min(...widths) : null, imgs }], texts, imgs };
}

// ---- rendering to ~60 dpi PNG per page ----
async function render(ctx, file, src, dpi) {
  const o = ctx.outDir, n = src.pages.length;
  if (src.kind === 'pdf') {
    sh('pdftoppm', ['-r', String(dpi), '-png', file, path.join(o, 'pg')]);
    const fs_ = fs.readdirSync(o).filter(f => /^pg-\d+\.png$/.test(f)).sort();
    return fs_.map(f => { const b = fs.readFileSync(path.join(o, f)); fs.unlinkSync(path.join(o, f)); return b; });
  }
  if (src.kind === 'raster') {
    return src.pages.map((p, i) => sh('convert', [`${file}[${i}]`, '-colorspace', 'sRGB', '-resize', `${Math.round(p.mm[0] / MM * dpi)}x`, '-background', 'white', '-alpha', 'remove', 'png:-'], { buffer: true }));
  }
  const p = src.pages[0], page = await (await ctx.browser()).newPage({ viewport: { width: Math.round(p.mm[0] / MM * dpi), height: Math.round(p.mm[1] / MM * dpi) } });
  try {
    await page.setContent(`<body style="margin:0;background:#fff"><img src="data:image/svg+xml;base64,${fs.readFileSync(file).toString('base64')}" style="width:100vw;height:100vh;display:block">`);
    await page.waitForTimeout(200);
    return [await page.screenshot({ type: 'png' })];
  } finally { await page.close(); }
}

// ---- pixel analysis (browser canvas): bleed content, safe-margin intrusion, overlay for sheet tile ----
async function analyse(ctx, pngs, geo, cfg, dpi) {
  const page = await (await ctx.browser()).newPage();
  try {
    return await page.evaluate(async ([items, K]) => {
      const res = [];
      for (const it of items) {
        const im = new Image(); im.src = 'data:image/png;base64,' + it.b64; await im.decode();
        const W = im.width, H = im.height, c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.drawImage(im, 0, 0);
        const D = x.getImageData(0, 0, W, H).data, mm = K.dpi / 25.4;
        const T = { x: Math.round(it.trim[0] * mm), y: Math.round(it.trim[1] * mm), w: Math.round(it.trim[2] * mm), h: Math.round(it.trim[3] * mm) };
        const px = (i) => [D[i], D[i + 1], D[i + 2]];
        const ink = i => Math.min(D[i], D[i + 1], D[i + 2]) < 225;
        const scan = (x0, y0, x1, y1, f) => { x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1); for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) f((yy * W + xx) * 4); };
        const frac = (x0, y0, x1, y1) => { let n = 0, t = 0; scan(x0, y0, x1, y1, i => { t++; if (ink(i)) n++; }); return t ? n / t : 0; };
        const bl = Math.min(T.x, T.y), e = Math.max(2, Math.round(1.5 * mm)), s = Math.round(K.safe * mm);
        const sides = {
          top: { b: [0, 0, W, T.y], e: [T.x, T.y, T.x + T.w, T.y + e], s: [T.x, T.y, T.x + T.w, T.y + s] },
          bottom: { b: [0, T.y + T.h, W, H], e: [T.x, T.y + T.h - e, T.x + T.w, T.y + T.h], s: [T.x, T.y + T.h - s, T.x + T.w, T.y + T.h] },
          left: { b: [0, 0, T.x, H], e: [T.x, T.y, T.x + e, T.y + T.h], s: [T.x, T.y, T.x + s, T.y + T.h] },
          right: { b: [T.x + T.w, 0, W, H], e: [T.x + T.w - e, T.y, T.x + T.w, T.y + T.h], s: [T.x + T.w - s, T.y, T.x + T.w, T.y + T.h] },
        };
        const r = { bleedMissing: [], bleedEdge: [], safeViol: [], W, H };
        for (const [nm, g] of Object.entries(sides)) {
          if (bl >= 2) { const eg = frac(...g.e), bg = frac(...g.b); if (eg > 0.15) { r.bleedEdge.push(nm); if (bg < eg * 0.5) r.bleedMissing.push(nm); } }
          // safe strip: dominant colour = background, count pixels that differ
          const cnt = new Map(); let tot = 0; scan(...g.s, i => { const k = (D[i] >> 4) * 256 + (D[i + 1] >> 4) * 16 + (D[i + 2] >> 4); cnt.set(k, (cnt.get(k) || 0) + 1); tot++; });
          const [bk] = [...cnt].sort((a, b) => b[1] - a[1])[0] || [0]; const bc = [(bk >> 8) << 4, ((bk >> 4) & 15) << 4, (bk & 15) << 4];
          let d = 0; scan(...g.s, i => { if (Math.max(Math.abs(D[i] - bc[0]), Math.abs(D[i + 1] - bc[1]), Math.abs(D[i + 2] - bc[2])) > 56) d++; });
          if (tot && d / tot > 0.004) r.safeViol.push(`${nm} ${(d / tot * 100).toFixed(1)}%`);
        }
        // overlay for the contact-sheet tile: trim (cyan) and safe line (magenta dashed)
        x.lineWidth = 1; x.strokeStyle = '#00e5ff'; x.strokeRect(T.x + .5, T.y + .5, T.w, T.h);
        x.strokeStyle = '#ff3df2'; x.setLineDash([6, 4]); x.strokeRect(T.x + s + .5, T.y + s + .5, T.w - 2 * s, T.h - 2 * s);
        r.png = c.toDataURL('image/png').split(',')[1];
        res.push(r);
      }
      return res;
    }, [pngs.map((b, i) => ({ b64: b.toString('base64'), trim: geo[i] })), { dpi, safe: cfg.safe ?? 5 }]);
  } finally { await page.close(); }
}

// ---- spread / folio order via pdftotext -bbox ----
function folios(file, n) {
  const res = [];
  for (let p = 1; p <= n; p++) {
    let x = ''; try { x = sh('pdftotext', ['-f', String(p), '-l', String(p), '-bbox', file, '-']); } catch { res.push(null); continue; }
    const pg = /<page width="([\d.]+)" height="([\d.]+)"/.exec(x); if (!pg) { res.push(null); continue; }
    const PW = +pg[1], PH = +pg[2], L = [], R = [];
    for (const m of x.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(\d{1,3})<\/word>/g)) {
      const yc = (+m[2] + +m[4]) / 2; if (yc > PH * 0.15 && yc < PH * 0.85) continue;
      ((+m[1] + +m[3]) / 2 < PW / 2 ? L : R).push(+m[5]);
    }
    res.push({ L: L[0] ?? null, R: R[0] ?? null, all: [...L, ...R] });
  }
  return res;
}

export async function run(ctx) {
  const { cfg, report, level, opts } = ctx;
  const file = resolveSource(opts.source || cfg.source);
  const ext = path.extname(file).toLowerCase().slice(1);
  const fmt = ext === 'pdf' ? 'pdf' : ext === 'svg' ? 'svg' : ['png', 'tif', 'tiff', 'jpg', 'jpeg'].includes(ext) ? 'raster' : null;
  if (!fmt) throw new Error('unsupported print file type: .' + ext);
  for (const c of fmt === 'pdf' ? ['pdfinfo', 'pdffonts', 'pdfimages', 'pdftoppm', 'python3'] : fmt === 'raster' ? ['identify', 'convert'] : []) if (!have(c)) throw new Error(`missing tool: ${c}`);
  const src = fmt === 'pdf' ? loadPdf(file, cfg, ctx.outDir) : fmt === 'raster' ? loadRaster(file, cfg) : loadSvg(file, cfg);
  const pages = src.pages, n = pages.length, bleed = cfg.bleed ?? 0, trim = cfg.trim, tol = cfg.tolMm ?? 0.5, bk = cfg.booklet;
  const spreads = !!bk?.spreads, exp = trim ? [(trim[0] * (spreads ? 2 : 1)) + 2 * bleed, trim[1] + 2 * bleed] : null;
  const dpi = cfg.thumbDpi || 60;
  const st = fs.statSync(file);
  report.note(`FILE ${path.relative(process.cwd(), file)} (${fmt}, ${n} page${n > 1 ? 's' : ''})`);

  // size
  if (exp) {
    const bad = pages.map((p, i) => [i, Math.abs(p.mm[0] - exp[0]) > tol || Math.abs(p.mm[1] - exp[1]) > tol]).filter(x => x[1]).map(x => x[0]);
    const sizes = group(pages.map(p => `${r1(p.mm[0])}x${r1(p.mm[1])}`));
    if (bad.length) report.fail('size', `${list(sizes)} mm, expected ${exp[0]}x${exp[1]} (trim ${trim.join('x')} + ${bleed} bleed)`);
    else if (src.kind === 'raster' && pages.some(p => !p.metaDpi)) report.warn('size', `no DPI metadata in file; size taken from config (${list(sizes)} mm assumed)`);
    else report.pass('size', `${list(sizes)} mm = trim ${trim.join('x')}${spreads ? ' x2 (spread)' : ''} + ${bleed} mm bleed`);
  } else report.warn('size', `no trim in config; sizes ${list(group(pages.map(p => `${r1(p.mm[0])}x${r1(p.mm[1])}`)))} mm`);

  // trim box (PDF) / geometry for analysis
  const geo = pages.map(p => {
    if (src.kind === 'pdf' && p.trim) { const m = p.media, t = p.trim, s = dpi / PT; return [(t[0] - m[0]) / PT * MM, (m[3] - t[3]) / PT * MM, (t[2] - t[0]) / PT * MM, (t[3] - t[1]) / PT * MM]; }
    const w = trim ? trim[0] * (spreads ? 2 : 1) : p.mm[0] - 2 * bleed, h = trim ? trim[1] : p.mm[1] - 2 * bleed;
    return [(p.mm[0] - w) / 2, (p.mm[1] - h) / 2, w, h];
  });
  if (src.kind === 'pdf') {
    const miss = pages.filter(p => !p.trim).length;
    if (miss) report.warn('trimbox', `${miss}/${n} page(s) without TrimBox (printer cannot locate trim; set TrimBox)`);
    else if (trim) {
      const off = pages.map((p, i) => Math.abs(geo[i][2] - trim[0] * (spreads ? 2 : 1)) > tol || Math.abs(geo[i][3] - trim[1]) > tol || Math.abs(geo[i][0] - bleed) > tol);
      off.some(Boolean) ? report.fail('trimbox', `TrimBox differs from ${trim.join('x')} mm centred at ${bleed} mm [p${off.map((o, i) => o ? i + 1 : 0).filter(Boolean).join(',')}]`) : report.pass('trimbox', 'TrimBox = trim size, bleed offset ok');
    }
  }

  // render + pixel analysis (bleed, safe margin)
  const pngs = await render(ctx, file, src, dpi);
  const an = await analyse(ctx, pngs, geo, cfg, dpi);
  if (bleed > 0) {
    const m = an.map((a, i) => a.bleedMissing.length ? `p${i + 1}:${a.bleedMissing.join('/')}` : null).filter(Boolean);
    const edge = an.some(a => a.bleedEdge.length);
    if (m.length) report.fail('bleed', `artwork touches trim but bleed area is empty: ${list(m)}`);
    else report.pass('bleed', edge ? `bleed filled where artwork reaches the edge (${bleed} mm)` : 'no artwork at the trim edge (nothing to bleed)');
  }
  const sv = an.map((a, i) => a.safeViol.length ? `p${i + 1}:${a.safeViol.join('/')}` : null).filter(Boolean);
  sv.length ? report.warn('safe', `content within ${cfg.safe ?? 5} mm of trim: ${list(sv)}`) : report.pass('safe', `nothing within ${cfg.safe ?? 5} mm of trim`);

  // fonts
  if (src.kind === 'pdf') {
    const bad = src.fonts.filter(f => !f.emb);
    src.fonts.length === 0 ? report.pass('fonts', 'no fonts (text outlined)') : bad.length ? report.fail('fonts', `not embedded: ${list(bad.map(f => f.name))}`) : report.pass('fonts', `${src.fonts.length} embedded`);
  } else if (src.kind === 'svg') src.texts ? report.warn('fonts', `${src.texts} live <text> elements (outline before print)`) : report.pass('fonts', 'no live text');
  else report.pass('fonts', 'raster, no fonts');

  // effective DPI of raster images
  const dw = cfg.dpi?.warn ?? 300, df = cfg.dpi?.fail ?? 150;
  let dpis = [];
  if (src.kind === 'pdf') dpis = src.imgs.map(i => Math.min(i.x, i.y));
  else if (src.kind === 'svg') dpis = src.imgs.map(i => i.dpi);
  else dpis = pages.map(p => p.effDpi).filter(Boolean);
  if (!dpis.length) report.pass('dpi', 'no raster images (vector only)');
  else { const m = Math.round(Math.min(...dpis)); const msg = `${dpis.length} image(s), lowest ${m} dpi (warn <${dw}, fail <${df})`; m < df ? report.fail('dpi', msg) : m < dw ? report.warn('dpi', msg) : report.pass('dpi', msg); }

  // colour space
  if (cfg.colorspace) {
    let rgb = 0, cmyk = 0, other = 0;
    if (src.kind === 'pdf') for (const p of pages) { rgb += p.rgb; cmyk += p.cmyk; other += p.other; for (const [k, c] of Object.entries(p.imgcs)) { if (/RGB|ICCBased3/.test(k)) rgb += c; else if (/CMYK|ICCBased4/.test(k)) cmyk += c; } }
    else if (src.kind === 'svg') rgb = 1;
    else for (const p of pages) { if (/cmyk/i.test(p.cs)) cmyk++; else rgb++; }
    const want = cfg.colorspace.toUpperCase(), got = `${rgb ? 'RGB' : ''}${rgb && cmyk ? '+' : ''}${cmyk ? 'CMYK' : ''}` || 'gray/none';
    const ok = want === 'CMYK' ? rgb === 0 : cmyk === 0;
    ok ? report.pass('color', `${got}, printer wants ${want}`) : report.fail('color', `${got} found, printer wants ${want}${other ? ` (+${other} other)` : ''}`);
  }

  // hairlines (stroke < 0.25pt)
  const hl = cfg.hairlinePt ?? 0.25;
  if (src.kind === 'pdf') { const t = pages.reduce((a, p) => a + p.thin, 0), mn = Math.min(...pages.map(p => p.min ?? 1e9)); t ? report.warn('hairline', `${t} stroke(s) under ${hl} pt (thinnest ${mn.toFixed(2)} pt)`) : report.pass('hairline', mn < 1e8 ? `thinnest stroke ${mn.toFixed(2)} pt` : 'no strokes'); }
  else if (src.kind === 'svg') { const m = pages[0].minStrokePt; m != null && m < hl ? report.warn('hairline', `thinnest stroke ${m.toFixed(2)} pt < ${hl}`) : report.pass('hairline', m != null ? `thinnest stroke ${m.toFixed(2)} pt` : 'no strokes'); }
  if (src.kind === 'pdf' && cfg.noTransparency) { const t = pages.reduce((a, p) => a + p.smask + p.alpha, 0); t ? report.warn('transp', `${t} soft-mask / alpha state(s); flatten for the printer`) : report.pass('transp', 'no transparency'); }

  // pages / booklet
  if (bk) {
    n % 4 === 0 || (bk.order === 'imposed' && n % 2 === 0 && bk.sheetsOnly) ? report.pass('pages', `${n} pages (multiple of 4)`) : report.fail('pages', `${n} pages; booklet needs a multiple of 4`);
    if (src.kind === 'pdf' && bk.folios !== false) {
      const f = folios(file, n), found = f.filter(x => x && x.all.length).length;
      if (!found) report.warn('order', 'no page numbers found; spread order not verifiable (set booklet.folios=false to silence)');
      else {
        const N = bk.order === 'imposed' ? n * 2 : n, errs = [];
        f.forEach((x, i) => {
          if (!x) return;
          if (bk.order === 'imposed') { const s = i, ex = s % 2 === 0 ? [N - s, s + 1] : [s + 1, N - s]; if ((x.L != null && x.L !== ex[0]) || (x.R != null && x.R !== ex[1])) errs.push(`p${i + 1}: ${x.L ?? '-'}|${x.R ?? '-'} expected ${ex[0]}|${ex[1]}`); }
          else if (x.all.length && !x.all.includes(i + 1)) errs.push(`p${i + 1}: folio ${x.all[0]}`);
        });
        errs.length ? report.fail('order', `${bk.order || 'reading'} order wrong: ${list(errs, 2)}`) : report.pass('order', `${bk.order || 'reading'} order ok (${found}/${n} pages carry folios)`);
      }
    } else if (src.kind !== 'pdf') report.warn('order', 'order check needs a PDF');
  } else if (n > 1) report.pass('pages', `${n} pages`);

  // file size
  const mb = st.size / 1048576, mx = cfg.maxMB ?? 100;
  mb > mx ? report.warn('filesize', `${mb.toFixed(1)} MB > ${mx} MB`) : report.pass('filesize', `${mb < 1 ? Math.round(st.size / 1024) + ' KB' : mb.toFixed(1) + ' MB'} (limit ${mx} MB)`);

  // sheet: all pages as labelled thumbnails, or one zoom crop
  const status = i => (an[i].bleedMissing.length ? 'fail' : an[i].safeViol.length ? 'warn' : 'ok');
  if (opts.zoom) ctx.tiles.push(await zoomTile(ctx, file, src, opts.zoom, cfg));
  else for (let i = 0; i < n; i++) ctx.tiles.push({ label: `p${i + 1}  ${r1(pages[i].mm[0])}x${r1(pages[i].mm[1])} mm  (cyan=trim, magenta=safe)`, png: Buffer.from(an[i].png, 'base64'), w: an[i].W, h: an[i].H, status: status(i) });
  if (level === 'full' && opts.baseline) report.note('baseline: print uses the sheet only; no pixel baseline stored');
}

async function zoomTile(ctx, file, src, spec, cfg) {
  const m = /page=(\d+),box=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(spec);
  if (!m) throw new Error('--zoom page=N,box=x,y,w,h (mm from the page top-left, incl. bleed)');
  const [pg, x, y, w, h] = m.slice(1).map(Number), dpi = Math.min(cfg.zoomDpi || 300, 1500 / (w / MM)), mm = dpi / MM, p = src.pages[pg - 1];
  if (!p) throw new Error(`page ${pg} not in file`);
  let png;
  if (src.kind === 'pdf') {
    const o = path.join(ctx.outDir, 'zoom');
    sh('pdftoppm', ['-r', String(Math.round(dpi)), '-f', String(pg), '-l', String(pg), '-x', String(Math.round(x * mm)), '-y', String(Math.round(y * mm)), '-W', String(Math.round(w * mm)), '-H', String(Math.round(h * mm)), '-png', '-singlefile', file, o]);
    png = fs.readFileSync(o + '.png');
  } else if (src.kind === 'raster') {
    const s = p.px[0] / p.mm[0];
    png = sh('convert', [`${file}[${pg - 1}]`, '-crop', `${Math.round(w * s)}x${Math.round(h * s)}+${Math.round(x * s)}+${Math.round(y * s)}`, '+repage', 'png:-'], { buffer: true });
  } else {
    const page = await (await ctx.browser()).newPage({ viewport: { width: Math.round(p.mm[0] * mm), height: Math.round(p.mm[1] * mm) } });
    await page.setContent(`<body style="margin:0;background:#fff"><img src="data:image/svg+xml;base64,${fs.readFileSync(file).toString('base64')}" style="width:100vw;height:100vh;display:block">`);
    png = await page.screenshot({ clip: { x: x * mm, y: y * mm, width: w * mm, height: h * mm } }); await page.close();
  }
  fs.writeFileSync(path.join(ctx.outDir, 'zoom.png'), png);
  const W = Math.round(w * mm), H = Math.round(h * mm);
  return { label: `zoom p${pg} box ${x},${y} ${w}x${h} mm @ ${Math.round(dpi)} dpi`, png, w: W, h: H };
}
