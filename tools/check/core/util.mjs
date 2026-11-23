// Shared helpers: Playwright loader, path/config resolution. No check logic here.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(KIT, '..', '..');
// Large source files may live outside the repo (project files); candidates are tried in order.
export const ROOTS = [REPO, process.env.CHECK_ROOT || '/mnt/project-files'];

export function loadPlaywright() {
  try { return createRequire(import.meta.url)('playwright'); } catch {}
  try { return createRequire(execSync('npm root -g').toString().trim() + '/')('playwright'); } catch {}
  throw new Error('playwright not found (use the pre-installed one; do not install another browser)');
}

export function resolveConfig(arg) {
  const tries = [arg, path.join(KIT, arg), path.join(KIT, 'checks', arg), path.join(KIT, 'checks', arg + '.json')];
  for (const p of tries) if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    const file = path.resolve(p);
    return { file, name: path.basename(file, '.json'), cfg: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  throw new Error(`target config not found: ${arg} (looked in cwd, tools/check, tools/check/checks)`);
}

export function resolveSource(src) {
  for (const s of [].concat(src)) {
    if (path.isAbsolute(s) && fs.existsSync(s)) return s;
    for (const r of ROOTS) { const p = path.join(r, s); if (fs.existsSync(p)) return p; }
  }
  throw new Error('source not found: ' + [].concat(src).join(' | ') + ' (set CHECK_ROOT to the project-files folder)');
}

export const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
export const kb = n => Math.round(n / 1024) + ' KB';
