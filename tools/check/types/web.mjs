// check web <target>: overflow, console, requests, fonts, selectors, overlap, hover, touch, baseline diff.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSource } from '../core/util.mjs';

const QUICK = [1440, 959, 390];
const FULL = [1920, 1440, 1200, 960, 959, 640, 390, 360];
const TOUCH_MAX = 640;   // views this narrow (or any, with --touch) emulate a phone: isMobile + hasTouch
const group = a => { const m = new Map(); for (const x of a) { const k = x.replace(/^\d+: /, ''), w = (x.match(/^(\d+): /) || [])[1]; m.set(k, [...(m.get(k) || []), w]); } return [...m].map(([k, w]) => `${k}${w[0] ? ` [${w.join('/')}]` : ''}`); };
const list = (a, n = 3) => a.slice(0, n).join('; ') + (a.length > n ? `; +${a.length - n}` : '');
const inRange = (c, w) => (c.min == null || w >= c.min) && (c.max == null || w <= c.max);
const norm = x => typeof x === 'string' ? { sel: x } : x;

function buildPage(cfg, outDir) {
  const src = resolveSource(cfg.source);
  const raw = fs.readFileSync(src, 'utf8');
  const isPage = (cfg.mode || (/^\s*(<!doctype|<html)/i.test(raw.slice(0, 400)) ? 'page' : 'fragment')) === 'page';
  if (isPage) return { url: pathToFileURL(src).href, how: 'page', src };
  // Fragment (a Tilda T123 block): wrap like a Tilda page - body colour, base font, #allrecords/.t-rec nesting.
  const w = { background: '#000', font: 'Arial, sans-serif', ...(cfg.wrapper || {}) };
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>html,body{margin:0;padding:0}body{background:${w.background};font-family:${w.font};-webkit-font-smoothing:antialiased}img{max-width:100%}.t-records{position:relative}.t-rec{position:relative}${w.css || ''}</style>
${w.head || ''}</head><body class="t-body"><div id="allrecords" class="t-records"><div class="r t-rec">
${raw}
</div></div></body></html>`;
  const f = path.join(outDir, 'wrapper.html'); fs.writeFileSync(f, html);
  return { url: pathToFileURL(f).href, how: 'fragment in Tilda wrapper', src };
}

// Runs in the page: measures everything for one view.
function measure(a) {
  const de = document.documentElement, tol = a.tol;
  const vis = el => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const desc = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '');
  const o = { sw: de.scrollWidth, cw: de.clientWidth, height: Math.max(de.scrollHeight, document.body.scrollHeight), offenders: [], required: [], overlap: [], taps: [] };
  if (o.sw > o.cw + tol) {
    const l = [];
    for (const el of document.body.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.width && r.right > o.cw + tol) l.push([Math.round(r.right - o.cw), desc(el)]); }
    o.offenders = l.sort((x, y) => y[0] - x[0]).slice(0, 3).map(x => `${x[1]} +${x[0]}px`);
  }
  for (const c of a.required) {
    const els = [...document.querySelectorAll(c.sel)];
    if (!els.length) o.required.push(`${c.sel} missing`); else if (!els.some(vis)) o.required.push(`${c.sel} hidden`);
  }
  for (const p of a.pairs) {
    const A = [...document.querySelectorAll(p.a)].filter(vis), B = [...document.querySelectorAll(p.b)].filter(vis), t = p.tol ?? 2;
    for (const x of A) for (const y of B) {
      if (x === y || x.contains(y) || y.contains(x)) continue;
      const r = x.getBoundingClientRect(), s = y.getBoundingClientRect();
      const ow = Math.min(r.right, s.right) - Math.max(r.left, s.left), oh = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
      if (ow > t && oh > t) o.overlap.push(`${p.a} x ${p.b} ${Math.round(ow)}x${Math.round(oh)}px (${desc(x)}/${desc(y)})`);
    }
  }
  const faces = [...document.fonts].map(f => ({ family: f.family.replace(/["']/g, ''), status: f.status }));
  o.fonts = a.fonts.map(f => { const m = faces.filter(x => x.family === f); return m.length ? (m.some(x => x.status === 'loaded') ? 'loaded' : m[0].status) : 'undeclared'; });
  if (a.isTouch) for (const sel of a.taps) for (const el of document.querySelectorAll(sel)) { if (!vis(el)) continue; const r = el.getBoundingClientRect(); if (r.width < 44 || r.height < 44) o.taps.push(`${sel} ${Math.round(r.width)}x${Math.round(r.height)}`); }
  return o;
}

const HOVER_PROPS = ['color', 'backgroundColor', 'borderColor', 'opacity', 'transform', 'boxShadow', 'filter', 'textDecorationLine', 'outlineStyle'];

export async function run(ctx) {
  const { cfg, report, level, opts } = ctx;
  const browser = await ctx.browser();
  const widths = opts.widths ? opts.widths.split(',').map(Number) : (cfg.widths?.[level === 'full' || opts.baseline ? 'full' : 'quick'] || (level === 'full' || opts.baseline ? FULL : QUICK));
  const page0 = buildPage(cfg, ctx.outDir);
  const capture = { maxHeight: 2400, sheetHeight: 1400, ...(cfg.capture || {}) };
  const wantDiff = level === 'full', wantShot = level !== 'quick' || opts.baseline;
  const required = (cfg.required || []).map(norm), pairs = (cfg.overlap || []).map(p => Array.isArray(p) ? { a: p[0], b: p[1] } : p);
  const ignore = (cfg.ignoreConsole || []).map(r => new RegExp(r));
  const th = cfg.diffThreshold ?? 1;
  const agg = { overflow: [], console: [], reqWarn: [], reqFail: [], fonts: [], required: [], overlap: [], taps: [], diff: [] };
  const logv = (...a) => report.detail(a.join(' '));
  const t0 = Date.now(); let hoverRow = null, hoverDone = false, touchViews = [], loadErr = 0;

  for (const width of widths) {
    const isTouch = !!opts.touch || width <= TOUCH_MAX;
    const bctx = await browser.newContext({ viewport: { width, height: cfg.height || 900 }, deviceScaleFactor: 1, isMobile: isTouch, hasTouch: isTouch, reducedMotion: (cfg.reducedMotion ?? (wantDiff || opts.baseline)) ? 'reduce' : 'no-preference' });
    const page = await bctx.newPage();
    const ev = { console: [], failed: [], http: [] };
    page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/Failed to load resource/.test(t) && !ignore.some(r => r.test(t))) ev.console.push(t.slice(0, 200)); });
    page.on('pageerror', e => ev.console.push('pageerror: ' + String(e.message).slice(0, 200)));
    page.on('requestfailed', r => ev.failed.push({ url: r.url(), err: r.failure()?.errorText }));
    page.on('response', r => { if (r.status() >= 400) ev.http.push({ url: r.url(), err: 'HTTP ' + r.status() }); });
    const clock = cfg.clock ?? (wantDiff || opts.baseline);   // virtual time -> deterministic frames for baseline diffs
    try {
      if (clock) { await page.clock.install({ time: 0 }); await page.clock.pauseAt(1000); await page.addInitScript(() => { let a = 123456789; Math.random = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }); }
      await page.goto(page0.url, { waitUntil: 'load', timeout: 30000 });
      await page.evaluate(() => document.fonts.ready).catch(() => 0);
      if (cfg.freezeCss) await page.addStyleTag({ content: cfg.freezeCss });
      if (cfg.diffCss && (wantDiff || opts.baseline)) await page.addStyleTag({ content: cfg.diffCss });   // hide what animates non-deterministically, only for baseline/diff runs
      if (clock) { await page.waitForTimeout(300); await page.clock.runFor(cfg.settleMs ?? 800); await page.waitForTimeout(100); }
      else await page.waitForTimeout(cfg.settleMs ?? 800);
    } catch (e) { loadErr++; agg.overflow.push(`${width}: load failed ${String(e.message).split('\n')[0]}`); await bctx.close(); continue; }
    if (isTouch) touchViews.push(width);
    const m = await page.evaluate(measure, { tol: cfg.overflowTolerance ?? 1, required: required.filter(c => inRange(c, width)), pairs: pairs.filter(c => inRange(c, width)), fonts: cfg.fonts || [], taps: cfg.tapTargets || [], isTouch });
    if (m.sw > m.cw + (cfg.overflowTolerance ?? 1)) agg.overflow.push(`${width}: scrollWidth ${m.sw} > ${m.cw}${m.offenders.length ? ' (' + m.offenders.join(', ') + ')' : ''}`);
    ev.console.forEach(t => agg.console.push(`${width}: ${t}`));
    const same = u => u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:');
    for (const f of [...ev.failed, ...ev.http]) {
      if (/^(data|blob):/.test(f.url)) continue;
      (same(f.url) ? agg.reqFail : agg.reqWarn).push(`${width}: ${f.err} ${f.url.slice(0, 90)}`);
    }
    (cfg.fonts || []).forEach((f, i) => { if (m.fonts[i] !== 'loaded') agg.fonts.push(`${f}: ${m.fonts[i]}`); });
    m.required.forEach(r => agg.required.push(`${width}: ${r}`));
    m.overlap.forEach(r => agg.overlap.push(`${width}: ${r}`));
    m.taps.forEach(r => agg.taps.push(`${width}: ${r}`));

    if (opts.hover && !isTouch && width >= 960 && !hoverDone) {
      hoverDone = true;
      try {
        const el = page.locator(opts.hover).first();
        const read = () => el.evaluate((e, ps) => { const cs = getComputedStyle(e); return Object.fromEntries(ps.map(p => [p, cs[p]])); }, HOVER_PROPS);
        const before = await read(); await el.scrollIntoViewIfNeeded(); await el.hover(); await page.waitForTimeout(500);
        const after = await read(); const ch = HOVER_PROPS.filter(p => before[p] !== after[p]);
        const sub = await el.evaluate(e => e.querySelectorAll('*').length);
        if (ch.length) hoverRow = ['pass', `${opts.hover} (${width}px): ${ch.join(', ')} change`]; if (0) report.pass('hover', `${opts.hover} (${width}px): ${ch.join(', ')} change`);
        else hoverRow = ['warn', `${opts.hover} (${width}px): no style change on the element itself (${sub} children not checked)`];
        if (level !== 'quick') ctx.tiles.push({ label: `hover ${opts.hover}`, png: await el.screenshot(), w: Math.round((await el.boundingBox()).width), h: Math.round((await el.boundingBox()).height) });
      } catch (e) { hoverRow = ['fail', `${opts.hover}: ${String(e.message).split('\n')[0]}`]; }
    }

    if (wantShot) {
      const dh = Math.min(m.height, capture.maxHeight);
      let status = 'ok', label = `${width}px`;
      try {
        const png = await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width, height: dh } });
        const bf = path.join(ctx.baselineDir, `${width}.png`);
        if (opts.baseline) { fs.mkdirSync(ctx.baselineDir, { recursive: true }); fs.writeFileSync(bf, png); label += ' · baseline saved'; }
        else if (wantDiff) {
          if (!fs.existsSync(bf)) agg.diff.push(`${width}: no baseline`);
          else {
            const d = await ctx.diff(fs.readFileSync(bf), png, { image: true });
            const over = d.pct > th; agg.diff.push(`${width}: ${d.pct}%${over ? '!' : ''}`); if (d.bbox) logv(`diff ${width}: changed bbox x${d.bbox[0]}-${d.bbox[2]} y${d.bbox[1]}-${d.bbox[3]}`);
            label += ` · diff ${d.pct}%`; if (over) { status = 'warn'; if (d.png) ctx.tiles.push({ label: `${width}px DIFF ${d.pct}%`, png: Buffer.from(d.png, 'base64'), w: width, h: dh, clipH: capture.sheetHeight, status: 'warn' }); }
            if (cfg.diffFailAt != null && d.pct > cfg.diffFailAt) agg.diffFail = true;
          }
        }
        if (opts.crop) {
          const el = page.locator(opts.crop).first();
          if (await el.count() && await el.isVisible()) { const bb = await el.boundingBox(); ctx.tiles.push({ label: `${width}px ${opts.crop}`, png: await el.screenshot(), w: Math.round(bb.width), h: Math.round(bb.height), status }); }
          else ctx.tiles.push({ label: `${width}px ${opts.crop} not visible`, png: png, w: width, h: dh, clipH: 80, status: 'fail' });
        } else if (level !== 'quick') ctx.tiles.push({ label, png, w: width, h: dh, clipH: capture.sheetHeight, status });
      } catch (e) { logv('screenshot failed', width, e.message); }
    }
    await bctx.close();
  }

  const v = widths.join('/');
  if (loadErr) report.fail('load', `${loadErr}/${widths.length} views failed to load: ${list(agg.overflow.filter(x => /load failed/.test(x)), 2)}`);
  else report.pass('load', `${page0.how} · ${path.basename(page0.src)} · ${widths.length} views (${v}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const ov = agg.overflow.filter(x => !/load failed/.test(x));
  ov.length ? report.fail('overflow', list(ov)) : report.pass('overflow', 'no horizontal scroll');
  agg.console.length ? report.fail('console', `${agg.console.length} errors: ${list(group(agg.console), 2)}`) : report.pass('console', 'no errors');
  if (agg.reqFail.length) report.fail('requests', `${agg.reqFail.length} local failures: ${list(group(agg.reqFail).map(x => x.replace(/file:\/\/\S*\//, '')), 2)}`);
  else if (agg.reqWarn.length) report.warn('requests', `${agg.reqWarn.length} external failures (blocked in sandbox?): ${list([...new Set(agg.reqWarn.map(x => x.replace(/^\d+: /, '')))], 2)}`);
  else report.pass('requests', 'none failed');
  if (cfg.fonts?.length) {
    const bad = [...new Set(agg.fonts)];
    if (!bad.length) report.pass('fonts', `loaded: ${cfg.fonts.join(', ')}`);
    else if (agg.reqWarn.length && bad.every(b => !/undeclared/.test(b))) report.warn('fonts', `${list(bad)} - font request failed, fallback font rendered`);
    else report.fail('fonts', list(bad));
  }
  if (required.length) agg.required.length ? report.fail('selectors', list(agg.required)) : report.pass('selectors', `${required.length} required visible`);
  if (pairs.length) agg.overlap.length ? report.fail('overlap', list(agg.overlap)) : report.pass('overlap', `${pairs.length} pairs clear`);
  if (touchViews.length) agg.taps.length ? report.warn('touch', `emulated ${touchViews.join('/')}; small tap targets: ${list(agg.taps)}`) : report.pass('touch', `emulated ${touchViews.join('/')}${cfg.tapTargets?.length ? '; tap targets >=44px' : ''}`);
  if (hoverRow) report[hoverRow[0]]('hover', hoverRow[1]);
  if (opts.baseline) report.pass('baseline', `saved ${widths.length} views to tools/check/baselines/${ctx.target}/`);
  else if (wantDiff) {
    const missing = agg.diff.filter(x => /no baseline/.test(x));
    const txt = agg.diff.map(x => x.replace(': ', ' ')).join(', ');
    if (agg.diffFail) report.fail('diff', `${txt} (threshold ${th}%)`);
    else if (missing.length) report.warn('diff', `${txt} - run --baseline`);
    else agg.diff.some(x => x.endsWith('!')) ? report.warn('diff', `${txt} (threshold ${th}%)`) : report.pass('diff', `${txt} (threshold ${th}%)`);
  }
  for (const k of ['overflow', 'console', 'reqWarn', 'reqFail', 'fonts', 'required', 'overlap', 'taps', 'diff']) if (agg[k].length) report.detail(`${k}:\n${agg[k].join('\n')}`);
}
