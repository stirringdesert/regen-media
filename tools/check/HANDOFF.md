# HANDOFF check kit (Thread A done: core + web). Thread B starts here.
- Entry: `tools/check/check <type> <target> --level quick|sheet|full`; usage and contract in tools/check/README.md (43 lines).
- Layout: core/{cli,report,sheet,imgdiff,util}.mjs (type-agnostic), types/web.mjs (only type so far), checks/<target>.json, baselines/<target>/<width>.png (committed, ~1 MB each).
- Add a type = add types/<type>.mjs exporting `run(ctx)`; DO NOT edit core/. ctx: cfg, level, opts, report.pass/warn/fail/detail, outDir, baselineDir, tiles (push {label,png,w,h,clipH?,status?}), browser(), diff(a,b).
  core builds the single sheet.jpg from ctx.tiles (<=1600px, <=400 KB, auto-scales) and prints the SHEET line; it never prints images.
- Node + the preinstalled Playwright 1.63 only (core/util.mjs loadPlaywright). Browser is shared (ctx.browser()); use page.evaluate/canvas for image work (no image libs installed; PIL exists in Python, ffprobe/ffmpeg: check `which` before relying).
- Pixel diff runs in browser canvas (core/imgdiff.mjs); reports pct + changed bbox (log). Reusable for print pages / video frames if you pass PNG buffers.
- Config resolution: name -> tools/check/checks/<name>.json, or any path. `source` candidates resolve against repo root then $CHECK_ROOT (default /mnt/project-files) - big sources stay in project files.
- Decisions:
  - Output rows per check type, aggregated over views (not per view) to stay <=30 lines; identical messages grouped with [widths].
  - External-host request failures = WARN, local (file/same origin) = FAIL.
  - Baseline/full runs use virtual time (page.clock), seeded Math.random, reduced motion. Home block still animated (physics art) -> `diffCss` hides .rgtd-art/.rgtd-bm/.rgtd-bg/.rgtd-fg in diff runs only; after that diffs are 0%.
  - Landing preview.html has only hero + 5 shows + about (later sections are empty placeholders): required list reflects that. 959x900 counts as landscape -> desktop layout, mobile header only <=640.
  - Mobile emulation (isMobile+hasTouch) for widths <=640 or --touch.
- Open issues: `--hover .rgtd-c` is flaky on the home block (style change seen at 1920, not at 1440; cards' hover may live on children). CI job .github/workflows/check-web.yml runs landing full on push; its source falls back to landing-preview/s/w.html, so its diff vs the preview.html baseline will WARN until a baseline is saved from that file. home-block source is not in the repo, so no CI job for it.
- Thread B types to add: print, media, plugin (configs checks/poster-08.json, booklet.json, jubilee-video.json, booklet-plugin.json). Then update README (keep <=60 lines) and add the one-line pointer in project memory.
- Test: `tools/check/check web home-block --level quick` and `... landing --level quick` (both OK, ~6-10 s). `--baseline` after an intended visual change.
