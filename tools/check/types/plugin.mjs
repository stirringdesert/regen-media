// check plugin <target>: Figma plugin folder. Works on a COPY in the output dir (sources are never touched; build output goes there too).
// Config: dir, build (shell cmd or null), tsconfig auto, limits {codeKB,uiKB,totalKB}, harness (mock-Figma html), tests [node scripts run in the copy],
//         smokeMs, window {width,height} (else read from figma.showUI), messages [pluginMessage objects sent to the UI for the sheet], zip {name,files[]}.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { resolveSource, KIT, kb } from '../core/util.mjs';

const run1 = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...o });
const first = s => String(s || '').split('\n').find(l => l.trim())?.trim().slice(0, 160) || '';
const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const EDITORS = ['figma', 'figjam', 'dev', 'slides', 'buzz'];

function copyDir(src, dst) {   // plugin sources -> work dir (skip node_modules, .bak backups, zips); node_modules is symlinked
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules') { fs.symlinkSync(path.join(src, e.name), path.join(dst, e.name)); continue; }
    if (/\.(bak|zip)$/.test(e.name) || e.name.startsWith('.')) continue;
    e.isDirectory() ? copyDir(path.join(src, e.name), path.join(dst, e.name)) : fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}
const inlineScripts = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/\bsrc=/.test(m[1]) && !/type="(?!text\/javascript|module)/.test(m[1])).map(m => m[2]);

export async function run(ctx) {
  const { cfg, report, level, opts, outDir } = ctx;
  const srcDir = resolveSource(opts.source || cfg.dir), work = path.join(outDir, 'work');
  copyDir(srcDir, work);
  report.note(`DIR ${path.relative(process.cwd(), srcDir)}`);

  // 1. build
  let buildOk = true;
  if (cfg.build) {
    const t = Date.now(), r = run1('sh', ['-c', cfg.build], { cwd: work, timeout: 180000 });
    buildOk = r.status === 0;
    fs.writeFileSync(path.join(outDir, 'build.log'), (r.stdout || '') + (r.stderr || ''));
    buildOk ? report.pass('build', `${cfg.build} ok (${((Date.now() - t) / 1000).toFixed(1)}s)`) : report.fail('build', first(r.stderr || r.stdout) || `exit ${r.status}`);
  } else report.pass('build', 'no build step (plain JS, shipped as is)');

  // 2. manifest
  const mf = path.join(work, 'manifest.json'); let m = null;
  try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { report.fail('manifest', fs.existsSync(mf) ? 'manifest.json is not valid JSON: ' + e.message : 'manifest.json missing'); }
  let mainF = null, uiF = null;
  if (m) {
    const bad = [], warn = [];
    for (const k of ['name', 'id', 'api', 'main']) if (!m[k]) bad.push('missing ' + k);
    if (m.api && !/^\d+\.\d+\.\d+$/.test(m.api)) bad.push(`api "${m.api}" is not x.y.z`);
    if (!Array.isArray(m.editorType) || !m.editorType.length) bad.push('editorType must be an array');
    else if (m.editorType.some(e => !EDITORS.includes(e))) bad.push('unknown editorType ' + m.editorType.join(','));
    mainF = m.main && path.join(work, m.main); uiF = typeof m.ui === 'string' ? path.join(work, m.ui) : null;
    if (mainF && !fs.existsSync(mainF)) bad.push(`main ${m.main} not found`);
    if (m.ui && typeof m.ui === 'string' && !fs.existsSync(uiF)) bad.push(`ui ${m.ui} not found`);
    if (!m.networkAccess?.allowedDomains?.length) warn.push('networkAccess.allowedDomains missing (required to publish; ["none"] if offline)');
    if (m.documentAccess !== 'dynamic-page') warn.push('documentAccess is not "dynamic-page" (required for new plugins)');
    bad.length ? report.fail('manifest', bad.join('; ')) : warn.length ? report.warn('manifest', warn.join('; ')) : report.pass('manifest', `${m.name} · api ${m.api} · ${m.editorType.join('/')} · main+ui exist · network ${JSON.stringify(m.networkAccess.allowedDomains)}`);
  }

  // 3. typecheck / syntax / lint
  if (fs.existsSync(path.join(work, 'tsconfig.json'))) {
    const tsc = run1('tsc', ['--noEmit', '-p', work], { cwd: work });
    tsc.status === 0 ? report.pass('types', 'tsc --noEmit clean') : report.fail('types', first(tsc.stdout) + ` (${(tsc.stdout.match(/error TS/g) || []).length} errors)`);
  }
  const files = [];   // [{label, path}] sources for lint, ui scripts extracted
  if (mainF && fs.existsSync(mainF)) files.push({ label: m.main, path: mainF, kind: 'main' });
  if (uiF && fs.existsSync(uiF)) inlineScripts(fs.readFileSync(uiF, 'utf8')).forEach((s, i) => { const p = path.join(outDir, `ui-script-${i}.ui.js`); fs.writeFileSync(p, s); files.push({ label: `${m.ui} <script ${i + 1}>`, path: p, kind: 'ui' }); });
  const syn = [];
  for (const f of files) { try { new vm.Script(fs.readFileSync(f.path, 'utf8'), { filename: f.label }); } catch (e) { syn.push(`${f.label}: ${e.message}`); } }
  syn.length ? report.fail('syntax', syn[0]) : report.pass('syntax', `${files.length} script(s) parse (${files.map(f => f.label).join(', ')})`);
  try {
    const targets = files.map(f => { if (f.kind !== 'main') return f.path; const p = path.join(outDir, 'main-copy.main.js'); fs.copyFileSync(f.path, p); return p; });
    const r = run1('eslint', ['--no-config-lookup', '-c', path.join(KIT, 'lib', 'eslint.plugin.mjs'), '-f', 'json', ...targets], { cwd: outDir });
    const j = JSON.parse(r.stdout || '[]'); const msgs = j.flatMap(x => x.messages.map(mm => ({ ...mm, file: path.basename(x.filePath) })));
    const errs = msgs.filter(x => x.severity === 2), warns = msgs.length - errs.length;
    msgs.forEach(x => report.detail(`${x.file}:${x.line} ${x.ruleId || 'parse'} ${x.message}`));
    errs.length ? report.fail('lint', `${errs.length} error(s): ${errs.slice(0, 2).map(x => `${x.ruleId || 'parse'} ${x.file}:${x.line}`).join('; ')}`) : report.pass('lint', `0 errors, ${warns} warning(s) (eslint, correctness rules; see log)`);
  } catch (e) { report.warn('lint', 'eslint not available: ' + String(e.message).split('\n')[0]); }

  // 4. bundle size
  const L = { codeKB: 500, uiKB: 500, totalKB: 1024, ...(cfg.limits || {}) };
  const size = f => (f && fs.existsSync(f) ? fs.statSync(f).size : 0), cs = size(mainF), us = size(uiF), tot = cs + us + size(mf);
  const over = [cs / 1024 > L.codeKB && `code ${kb(cs)} > ${L.codeKB} KB`, us / 1024 > L.uiKB && `ui ${kb(us)} > ${L.uiKB} KB`, tot / 1024 > L.totalKB && `total > ${L.totalKB} KB`].filter(Boolean);
  over.length ? report.warn('bundle', over.join('; ')) : report.pass('bundle', `code ${kb(cs)}, ui ${kb(us)}, total ${kb(tot)} (limits ${L.codeKB}/${L.uiKB}/${L.totalKB} KB)`);

  // 5. mock-Figma tests + 6. UI render
  const win = cfg.window || (() => { const w = /showUI\([^)]*?width\s*:\s*(\d+)[^)]*?height\s*:\s*(\d+)/s.exec(mainF ? fs.readFileSync(mainF, 'utf8') : ''); return w ? { width: +w[1], height: +w[2] } : { width: 300, height: 500 }; })();
  const hs = cfg.harness && (() => { try { return resolveSource(cfg.harness); } catch { return null; } })();
  if (hs) fs.copyFileSync(hs, path.join(work, 'harness.html'));
  const pw = ctx.pw, br = await ctx.browser();
  if (hs) {
    const pg = await br.newPage({ viewport: { width: win.width + 20, height: win.height + 20 } }), errs = [];
    pg.on('pageerror', e => errs.push('PAGEERR ' + e.message)); pg.on('console', c => { if (c.type() === 'error') errs.push('console ' + c.text().slice(0, 120)); });
    await pg.goto('file://' + path.join(work, 'harness.html')); await pg.waitForTimeout(cfg.smokeMs || 1500);
    await pg.evaluate(([w, h]) => { const i = document.querySelector('iframe'); if (i) { i.style.width = w + 'px'; i.style.height = h + 'px'; } }, [win.width, win.height]); await pg.waitForTimeout(400);
    const info = await pg.evaluate(() => ({ iframe: !!document.querySelector('iframe'), log: (window.LOG || []).filter(l => l[0] === 'ERR').map(l => l.join(' ').slice(0, 160)), n: (window.LOG || []).length }));
    const bad = [...errs, ...info.log];
    !info.iframe ? report.fail('smoke', 'plugin never called figma.showUI (no UI iframe)') : bad.length ? report.fail('smoke', `${bad.length} error(s): ${bad[0]}`) : report.pass('smoke', `code.js + ui.html boot in mock Figma, ${info.n} messages, no errors`);
    // sheet tiles: UI at window size, then after mocked messages
    if (level !== 'quick') {
      const clip = { x: 0, y: 0, width: win.width, height: win.height };
      ctx.tiles.push({ label: `ui.html ${win.width}x${win.height} (initial)`, png: await pg.screenshot({ clip }), w: win.width, h: win.height });
      if (cfg.messages?.length) {
        for (const msg of cfg.messages) await pg.evaluate(m => document.querySelector('iframe').contentWindow.postMessage({ pluginMessage: m }, '*'), msg);
        await pg.waitForTimeout(600);
        ctx.tiles.push({ label: `ui.html after ${cfg.messages.map(x => x.type).join('+')}`, png: await pg.screenshot({ clip }), w: win.width, h: win.height });
      }
    }
    await pg.close();
  } else if (uiF && fs.existsSync(uiF)) {   // no mock harness: render ui.html alone with a stubbed parent.postMessage
    const pg = await br.newPage({ viewport: win }), errs = []; pg.on('pageerror', e => errs.push(e.message));
    await pg.goto('file://' + uiF); await pg.waitForTimeout(cfg.smokeMs || 1000);
    errs.length ? report.fail('smoke', `ui.html: ${errs[0]}`) : report.pass('smoke', 'ui.html renders alone without script errors (no mock harness configured)');
    if (level !== 'quick') ctx.tiles.push({ label: `ui.html ${win.width}x${win.height}`, png: await pg.screenshot(), w: win.width, h: win.height });
    await pg.close();
  }
  for (const s of cfg.tests || []) {
    const sp = (() => { try { return resolveSource(s); } catch { return null; } })();
    if (!sp) { report.warn('test', `script not found: ${s}`); continue; }
    const dst = path.join(work, path.basename(sp)); fs.copyFileSync(sp, dst);
    const npmRoot = (() => { try { return execSync('npm root -g').toString().trim(); } catch { return ''; } })();
    const r = run1('node', [dst], { cwd: work, timeout: 120000, env: { ...process.env, NODE_PATH: npmRoot } });
    const out = (r.stdout || '') + (r.stderr || ''); fs.writeFileSync(path.join(outDir, `test-${path.basename(sp)}.log`), out);
    const flag = out.split('\n').find(l => /PLUGIN ERR|OVERFLOW|!! |PAGEERR|Error:|errors \[\s*['"A-Za-z]/.test(l));
    r.status === 0 && !flag ? report.pass('test', `${path.basename(sp)} exit 0, ${out.split('\n').filter(Boolean).length} lines, no error markers`) : report.fail('test', `${path.basename(sp)}: ${flag?.trim().slice(0, 130) || first(r.stderr) || 'exit ' + r.status}`);
  }

  // 7. zip: committed zip vs sources (always), fresh import zip (full)
  const z = cfg.zip;
  if (z && m) {
    const names = z.files || ['manifest.json', m.main, m.ui].filter(Boolean), have = names.filter(n => fs.existsSync(path.join(work, n)));
    const committed = z.compareTo && (() => { try { return resolveSource([path.join(cfg.dir, z.compareTo)]); } catch { return null; } })();
    if (committed) {
      const tmp = path.join(outDir, 'committed-zip'); fs.mkdirSync(tmp, { recursive: true }); execFileSync('unzip', ['-qo', committed, '-d', tmp]);
      const diff = have.filter(n => { const p = path.join(tmp, z.dir || '', n); return !fs.existsSync(p) || sha(p) !== sha(path.join(work, n)); });
      diff.length ? report.warn('zip', `${z.compareTo} is stale: ${diff.join(', ')} differ from the sources`) : report.pass('zip', `${z.compareTo} matches the sources`);
    }
    if (level === 'full') {
      const out = path.join(outDir, z.name || (m.name.toLowerCase().replace(/\W+/g, '-') + '.zip'));
      const stage = path.join(outDir, 'zipstage'), top = path.join(stage, z.dir || ''); fs.mkdirSync(top, { recursive: true });
      for (const n of have) fs.copyFileSync(path.join(work, n), path.join(top, n));
      execFileSync('zip', ['-qr', out, z.dir || '.'], { cwd: stage });
      report.note(`ZIP ${path.relative(process.cwd(), out)} (${kb(fs.statSync(out).size)}, ${have.join(' + ')})`);
      report.pass('buildzip', `import zip built from ${have.length} files`);
    }
  }
}
