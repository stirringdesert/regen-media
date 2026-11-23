// check media <target>: video / GIF / PNG sequence via ffprobe + ffmpeg. Frames are decoded to PNG; pixel work runs in the browser canvas.
// Config: source (file | dir of frames | .zip + zipEntry), expect {width,height,fps,fpsTol,minSec,maxSec,codecs[],maxMB,alpha,audio,loop,loopMaxPct}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveSource } from '../core/util.mjs';

const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: o.buffer ? 'buffer' : 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], ...o });
const frac = s => { const [a, b] = String(s || '0/1').split('/').map(Number); return b ? a / b : a; };
const ALPHA_FMT = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya8|ya16|ayuv|pal8$)/;

function resolveInput(cfg, opts, outDir) {
  const src = resolveSource(opts.source || cfg.source);
  if (fs.statSync(src).isDirectory()) {
    const ext = fs.readdirSync(src).filter(f => /\.(png|jpe?g|tiff?)$/i.test(f)).sort();
    if (!ext.length) throw new Error('no image frames in ' + src);
    const e = path.extname(ext[0]);
    return { kind: 'seq', files: ext.map(f => path.join(src, f)), args: ['-framerate', String(cfg.expect?.fps || 30), '-pattern_type', 'glob', '-i', path.join(src, '*' + e)], src };
  }
  if (/\.zip$/i.test(src)) {   // extract ONE entry to a temp cache outside the project; the archive is never modified
    const entry = cfg.zipEntry || sh('unzip', ['-Z1', src]).split('\n').find(f => /\.(mov|mp4|webm|gif|m4v)$/i.test(f));
    const dir = path.join(os.tmpdir(), 'check-media-cache'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, path.basename(src, '.zip') + '__' + path.basename(entry));
    if (!fs.existsSync(f)) fs.writeFileSync(f, sh('unzip', ['-p', src, entry], { buffer: true }));
    return { kind: 'file', file: f, src: f, label: `${path.basename(src)}:${entry}` };
  }
  return { kind: 'file', file: src, src };
}

function probe(inp, cfg) {
  const inArgs = inp.kind === 'seq' ? inp.args : ['-i', inp.file];
  const j = JSON.parse(sh('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', ...inArgs]));
  const v = j.streams.find(s => s.codec_type === 'video'), a = j.streams.filter(s => s.codec_type === 'audio');
  if (!v) throw new Error('no video stream');
  const fps = frac(v.avg_frame_rate) || frac(v.r_frame_rate);
  let dur = parseFloat(j.format?.duration) || parseFloat(v.duration) || 0;
  if (inp.kind === 'seq') dur = inp.files.length / fps;
  return { v, a, fps, dur, fmt: j.format, frames: inp.kind === 'seq' ? inp.files.length : (parseInt(v.nb_frames) || Math.round(dur * fps)) };
}

// decoder args (VP9 alpha needs libvpx), then extract one RGBA PNG scaled to width
function frame(inp, pr, t, w, { last = false, n } = {}) {
  if (inp.kind === 'seq') {
    const i = last ? inp.files.length - 1 : n ?? Math.min(inp.files.length - 1, Math.round(t * pr.fps));
    return sh('ffmpeg', ['-v', 'error', '-i', inp.files[i], '-vf', `scale=${w}:-2,format=rgba`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { buffer: true });
  }
  const dec = pr.v.codec_name === 'vp9' && /alpha_mode/.test(JSON.stringify(pr.v.tags || {})) ? ['-c:v', 'libvpx-vp9'] : [];
  const pre = last ? ['-sseof', '-0.6'] : n != null ? [] : ['-ss', String(Math.max(0, t))];
  const vf = n != null && n > 0 ? `select=eq(n\\,${n}),scale=${w}:-2,format=rgba` : `scale=${w}:-2,format=rgba`;
  const post = last ? ['-update', '1'] : ['-frames:v', '1'];
  return sh('ffmpeg', ['-v', 'error', ...pre, ...dec, '-i', inp.file, '-vf', vf, ...post, '-f', 'image2pipe', '-vcodec', 'png', '-'], { buffer: true });
}

async function onChecker(browser, pngs) {   // alpha stats + the same frames composited on a checkerboard
  const page = await browser.newPage();
  try {
    return await page.evaluate(async (list) => {
      const out = [];
      for (const b64 of list) {
        const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
        const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let t = 0, p = 0;
        for (let i = 3; i < d.length; i += 4) { if (d[i] < 250) t++; if (d[i] > 5 && d[i] < 250) p++; }
        const n = d.length / 4, s = 12; x.clearRect(0, 0, c.width, c.height);
        for (let yy = 0; yy < c.height; yy += s) for (let xx = 0; xx < c.width; xx += s) { x.fillStyle = ((xx / s + yy / s) & 1) ? '#7a7a7a' : '#a8a8a8'; x.fillRect(xx, yy, s, s); }
        x.drawImage(im, 0, 0);
        out.push({ transparent: t / n, partial: p / n, w: c.width, h: c.height, png: c.toDataURL('image/png').split(',')[1] });
      }
      return out;
    }, pngs.map(b => b.toString('base64')));
  } finally { await page.close(); }
}

export async function run(ctx) {
  const { cfg, report, level, opts } = ctx, ex = cfg.expect || {};
  for (const c of ['ffprobe', 'ffmpeg']) try { sh('which', [c]); } catch { throw new Error('missing tool: ' + c); }
  const inp = resolveInput(cfg, opts, ctx.outDir), pr = probe(inp, cfg), v = pr.v;
  const size = inp.kind === 'seq' ? inp.files.reduce((a, f) => a + fs.statSync(f).size, 0) : fs.statSync(inp.file).size;
  report.note(`FILE ${inp.label || path.relative(process.cwd(), inp.src)} (${inp.kind === 'seq' ? inp.files.length + ' frames' : v.codec_name})`);

  // resolution / fps / duration / codec / size
  const res = `${v.width}x${v.height}`;
  ex.width && (v.width !== ex.width || v.height !== ex.height) ? report.fail('res', `${res}, expected ${ex.width}x${ex.height}`) : report.pass('res', res);
  const ft = ex.fpsTol ?? 0.05;
  ex.fps && Math.abs(pr.fps - ex.fps) > ft ? report.fail('fps', `${pr.fps.toFixed(3)} fps, expected ${ex.fps}`) : report.pass('fps', `${+pr.fps.toFixed(3)} fps${ex.fps ? '' : ' (no expectation in config)'}`);
  const dl = [ex.minSec, ex.maxSec], ds = `${pr.dur.toFixed(2)} s (${pr.frames} frames)`;
  (dl[0] != null && pr.dur < dl[0]) || (dl[1] != null && pr.dur > dl[1]) ? report.fail('duration', `${ds}, expected ${dl[0] ?? 0}-${dl[1] ?? 'any'} s`) : report.pass('duration', ds);
  const cod = v.codec_name + (v.profile ? ` ${v.profile}` : '') + ` ${v.pix_fmt}`;
  inp.kind === 'seq' || !ex.codecs ? report.pass('codec', cod) : ex.codecs.includes(v.codec_name) ? report.pass('codec', cod) : report.fail('codec', `${cod}, expected ${ex.codecs.join('/')}`);
  const mb = size / 1048576; ex.maxMB && mb > ex.maxMB ? report.warn('filesize', `${mb.toFixed(1)} MB > ${ex.maxMB} MB`) : report.pass('filesize', `${mb.toFixed(1)} MB${ex.maxMB ? ` (limit ${ex.maxMB})` : ''}`);
  const hasA = pr.a.length > 0;
  ex.audio === undefined ? report.pass('audio', hasA ? `${pr.a[0].codec_name} ${pr.a[0].channels}ch` : 'none') : hasA === ex.audio ? report.pass('audio', hasA ? `${pr.a[0].codec_name} present, expected` : 'absent, as expected') : report.fail('audio', hasA ? 'audio track present, expected none' : 'no audio track, expected one');

  // frames: first / middle / last (+ step frame for the loop baseline); 6 evenly spaced for the sheet
  const W = 480, t = f => pr.dur * f;
  const F = frame(inp, pr, 0, W), M = frame(inp, pr, t(.5), W), L = frame(inp, pr, 0, W, { last: true });
  const base = await onChecker(await ctx.browser(), [F, M, L]);
  const alphaSeen = Math.max(...base.map(b => b.transparent));
  const fmtAlpha = ALPHA_FMT.test(v.pix_fmt || '') && !/^pal8$/.test(v.pix_fmt) || (inp.kind === 'file' && /\.gif$/i.test(inp.file));
  if (ex.alpha === true) alphaSeen > 0.001 ? report.pass('alpha', `transparent pixels found (${(alphaSeen * 100).toFixed(1)}% in sampled frames, pix_fmt ${v.pix_fmt})`) : report.fail('alpha', `no transparency in sampled frames (pix_fmt ${v.pix_fmt}${fmtAlpha ? ', alpha-capable but fully opaque' : ', no alpha channel'})`);
  else if (ex.alpha === false) alphaSeen > 0.001 ? report.warn('alpha', `unexpected transparency (${(alphaSeen * 100).toFixed(1)}%)`) : report.pass('alpha', 'opaque, as expected');

  // seamless loop: first vs last frame, compared with a normal one-frame step
  const lim = ex.loopMaxPct ?? 1.0;
  const S = frame(inp, pr, 0, W, { n: 1 });
  const dl2 = await ctx.diff(F, L), st = await ctx.diff(F, S);
  if (dl2.note) report.warn('loop', dl2.note);
  else {
    const ok = dl2.pct <= Math.max(lim, st.pct * 1.5), msg = `first→last ${dl2.pct}% changed (normal frame step ${st.pct}%, limit ${lim}%)`;
    ex.loop ? (ok ? report.pass('loop', msg) : report.fail('loop', msg + ': visible jump at the loop point')) : report.pass('loop', msg + ' (loop not required)');
  }

  if (level !== 'quick') {
    const picks = [...Array(6)].map((_, i) => (i + 0.5) / 6), strip = [];
    for (const f of picks) strip.push(frame(inp, pr, t(f), 400));
    const cs = await onChecker(await ctx.browser(), strip);
    cs.forEach((c, i) => ctx.tiles.push({ label: `t=${t(picks[i]).toFixed(1)}s${c.transparent > 0.001 ? ` alpha ${(c.transparent * 100).toFixed(0)}%` : ''}`, png: Buffer.from(c.png, 'base64'), w: c.w, h: c.h }));
  }
}
