// Entry: check <type> <target> [--level quick|sheet|full] [--crop sel] [--hover sel] [--touch] [--baseline] [--widths a,b] [--out dir]
// Types are plain modules in tools/check/types/<type>.mjs exporting run(ctx) -> add print/media/plugin by adding a file.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { KIT, REPO, loadPlaywright, resolveConfig, stamp, kb } from './util.mjs';
import { Report } from './report.mjs';
import { makeSheet } from './sheet.mjs';
import { pixelDiff } from './imgdiff.mjs';

const FLAGS_WITH_VALUE = ['level', 'crop', 'hover', 'widths', 'out', 'zoom', 'source'];
function parse(argv) {
  const o = { level: 'quick', _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (FLAGS_WITH_VALUE.includes(k)) o[k] = argv[++i]; else o[k] = true;
    } else o._.push(a);
  }
  return o;
}

const t0 = Date.now();
const opts = parse(process.argv.slice(2));
const [type, targetArg] = opts._;
if (!type || !targetArg || !['quick', 'sheet', 'full'].includes(opts.level)) {
  const types = fs.readdirSync(path.join(KIT, 'types')).map(f => f.replace('.mjs', '')).join('|');
  console.error(`usage: check <${types}> <target> --level quick|sheet|full [--crop sel] [--hover sel] [--touch] [--baseline]`);
  process.exit(2);
}
const report = new Report();
let browser;
try {
  const tf = path.join(KIT, 'types', type + '.mjs');
  if (!fs.existsSync(tf)) throw new Error(`unknown check type "${type}"`);
  const { name, cfg } = resolveConfig(targetArg);
  const outDir = path.join(opts.out || process.env.CHECK_OUT || path.join(REPO, '_checks'), name, stamp());
  fs.mkdirSync(outDir, { recursive: true });
  const pw = loadPlaywright();
  const ctx = {
    type, target: name, cfg, level: opts.level, opts, report, outDir, kit: KIT, repo: REPO, tiles: [], pw,
    baselineDir: path.join(KIT, 'baselines', name),
    browser: async () => (browser ||= await pw.chromium.launch({ args: ['--no-sandbox'] })),
    diff: async (a, b, o) => pixelDiff(await ctx.browser(), a, b, o),
  };
  try { await (await import(pathToFileURL(tf))).run(ctx); }
  catch (e) { report.fail('error', String(e.message || e).split('\n')[0]); report.detail(e.stack || e); }
  if (ctx.tiles.length && opts.level !== 'quick') {
    const file = path.join(outDir, 'sheet.jpg');
    const s = await makeSheet(await ctx.browser(), ctx.tiles, file);
    report.note(`SHEET ${path.relative(process.cwd(), file)} (${s.w}x${s.h}, ${kb(s.bytes)})`);
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const sum = `${report.failed ? 'FAIL' : 'OK'} ${type} ${name} --level ${opts.level}: ${report.count('PASS')} PASS, ${report.count('WARN')} WARN, ${report.count('FAIL')} FAIL in ${sec}s · log ${path.relative(process.cwd(), path.join(outDir, 'log.txt'))}`;
  fs.writeFileSync(path.join(outDir, 'log.txt'), `check ${process.argv.slice(2).join(' ')}\n${new Date().toISOString()}\n\n${report.logLines.join('\n')}\n\n${sum}\n`);
  console.log(report.render(sum));
  await browser?.close();
  process.exit(report.failed ? 1 : 0);
} catch (e) {
  console.log(`FAIL error ${String(e.message || e).split('\n')[0]}`);
  await browser?.close().catch(() => 0);
  process.exit(2);
}
