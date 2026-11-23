# check - shared check kit

One entry point for every thread. Use it instead of writing your own Playwright/render/screenshot code.

    tools/check/check <type> <target> --level quick|sheet|full [options]
    tools/check/check web home-block --level quick

`<target>` = `checks/<name>.json` name or a config path. `<type>` = a module in `types/`: `web`, `print`, `media`, `plugin`. `--source <path>` overrides the config's source.

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

## print checks (PDF, SVG, PNG, TIFF) - needs poppler, ImageMagick, python3+pypdf (all in the container)
    tools/check/check print poster-08 --level sheet
    tools/check/check print booklet --level sheet --zoom page=1,box=10,10,60,40     # mm from page top-left, 300 dpi crop becomes the sheet
Checks: size vs `trim`+`bleed` (PDF TrimBox too), bleed filled where art reaches the trim, nothing within `safe` mm of trim (WARN),
fonts embedded/outlined, effective DPI of rasters (WARN <300, FAIL <150), colour space vs `colorspace` (CMYK|RGB), strokes <0.25 pt (WARN),
transparency (`noTransparency`), booklet: page count %4 and folio/spread order (`booklet` {order reading|imposed, spreads, folios}), file size `maxMB`.
Sheet = every page at 60 dpi with trim (cyan) and safe line (magenta). No baseline diff for print.
Config: `source`, `trim` [w,h] mm, `bleed`, `safe`, `colorspace`, `dpi` {warn,fail}, `hairlinePt`, `maxMB`, `booklet`, `svgMmPerUnit`, `zoomDpi`.

## media checks (MP4, MOV, WebM, GIF, PNG sequence dir, .zip + `zipEntry`) - ffprobe/ffmpeg
Config `expect`: width, height, fps, minSec, maxSec, codecs[], maxMB, alpha (true = decoded frames must contain transparency), audio (true|false), loop (true = first vs last frame must match), loopMaxPct.
Rows: res, fps, duration, codec, filesize, audio, alpha, loop (first->last % vs a normal one-frame step). Sheet = 6 evenly spaced frames on a checkerboard. Zip sources: one entry extracted to a temp dir.

## plugin checks (Figma plugin folder; works on a copy, sources untouched)
Rows: build (`build` cmd or none), manifest (id/api/editorType/main/ui/networkAccess/documentAccess), types (tsc if tsconfig), syntax (code.js + inline ui scripts),
lint (eslint, correctness rules in lib/eslint.plugin.mjs), bundle size (`limits`), smoke (code.js + ui.html boot in the mock-Figma `harness`, no errors),
test (`tests` = node scripts run in the copy, fail on non-zero exit or PLUGIN ERR/OVERFLOW markers), zip (committed zip vs sources).
Sheet = ui.html at the plugin window size (read from figma.showUI, or `window`), plus a second tile after `messages`. Full = also builds the import zip and prints its path.

## Adding a type
Add `types/<type>.mjs` exporting `async run(ctx)`; do not touch `core/`. ctx gives `cfg, level, opts, report` (`pass/warn/fail/detail`),
`outDir`, `baselineDir`, `tiles` (push `{label,png,w,h,clipH?,status?}` - core builds the sheet), `browser()`, `diff(a,b)`.

## Notes
- Needs the pre-installed Playwright (Node). No other install. `_checks/` is git-ignored; baselines are committed (~1 MB per target). Sources are never edited by the kit. Big sources live in project files (`$CHECK_ROOT`).
