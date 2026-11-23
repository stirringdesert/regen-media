# check - shared check kit

One entry point for every thread. Use it instead of writing your own Playwright/render/screenshot code.

    tools/check/check <type> <target> --level quick|sheet|full [options]
    tools/check/check web home-block --level quick
    tools/check/check web landing --level sheet --crop '#about'

`<target>` = name of `checks/<name>.json`, or a path to a config. `<type>` = a module in `types/` (now: `web`).

## Output contract (all types)
- One line per check: `PASS|WARN|FAIL name reason`, then one summary line. Exit code 0 = no FAIL (1 = FAIL, 2 = tool error).
- <= ~30 stdout lines. Details: `_checks/<target>/<timestamp>/log.txt` - read it only when something fails.
- Images are never printed. sheet/full write exactly ONE `sheet.jpg` (<=1600px wide, <=~400 KB); its path is printed.

## Levels
- quick: text checks, default views. Run after every edit.
- sheet: quick + one contact sheet. Once per round, when you need to judge visually. `--crop <selector>` tiles only that element.
- full: all views + pixel diff vs baseline (% changed per view) + sheet. Before a Tilda push / export / delivery.
- `--baseline`: saves the current render of all full views as the new baseline (`baselines/<target>/<width>.png`).
  A diff image goes into the sheet only for a view above `diffThreshold` (default 1%); otherwise numbers only.

## web checks
Views: quick 1440/959/390, full 1920/1440/1200/960/959/640/390/360 (`--widths a,b` overrides). Widths <=640 (or `--touch`) emulate a phone.
Checks: load, horizontal overflow, console errors, failed requests (local = FAIL, external host = WARN), fonts loaded,
required selectors visible, overlap of listed element pairs (getBoundingClientRect), touch emulation + tap targets >=44px,
optional `--hover <selector>` (computed-style change). Fragments (Tilda blocks) are wrapped in a Tilda-like page
(background, base font, `#allrecords/.t-rec`); full pages are loaded as they are.
Baseline runs and `full` use virtual time + seeded Math.random + reduced motion, so animated pages diff reproducibly.

## Config (checks/<target>.json) - adding a target = adding one file
`source` (list; tried in repo root, then `$CHECK_ROOT` = /mnt/project-files), `mode` fragment|page (auto), `wrapper` {background,font,css,head},
`fonts`, `required` ("sel" or {sel,min,max} width range), `overlap` ([a,b] or {a,b,tol}), `tapTargets`, `ignoreConsole` (regex list),
`widths` {quick,full}, `settleMs`, `capture` {maxHeight,sheetHeight}, `diffThreshold`, `diffFailAt`, `diffCss` (hide
non-deterministic animated art in baseline/diff runs only), `reducedMotion`, `clock`.

## Adding a type (print, media, plugin)
Add `types/<type>.mjs` exporting `async run(ctx)`; do not touch `core/`. ctx gives `cfg, level, opts, report` (`pass/warn/fail/detail`),
`outDir`, `baselineDir`, `tiles` (push `{label,png,w,h,clipH?,status?}` - core builds the sheet), `browser()`, `diff(a,b)`.

## Notes
- Needs the pre-installed Playwright (Node). No other install. `_checks/` is git-ignored; baselines are committed (~1 MB per target).
- Sources are never edited by the kit. Home block / landing sources live in project files, hence `$CHECK_ROOT`.
