# HANDOFF check kit (Thread A: core + web; Thread B: print, media, plugin). Kit is complete.
- Entry: `tools/check/check <web|print|media|plugin> <target> --level quick|sheet|full [--source path]`; contract + config keys in README.md (60 lines).
- Layout: core/ (type-agnostic; Thread B only added `source` to the value flags in cli.mjs), types/{web,print,media,plugin}.mjs,
  lib/pdfprobe.py (pypdf: boxes, colour ops, stroke widths, images), lib/eslint.plugin.mjs (correctness-only lint for plugins),
  checks/{home-block,landing,poster-08,booklet,jubilee-video,booklet-plugin}.json, fixtures/booklet-test-8pp.pdf, baselines/ (web only).
- Tools used (all in the container): poppler (pdffonts/pdfimages/pdftoppm/pdftotext), ImageMagick identify/convert, python3+pypdf, ffprobe/ffmpeg, eslint, tsc, zip.
- Decisions:
  - print: geometry from TrimBox when present, else trim centred in media. Bleed/safe judged on a 60 dpi render in canvas:
    bleed FAIL only when art reaches the trim edge but the bleed strip is empty; safe = pixels differing from the strip's dominant colour (>0.4% -> WARN).
    Colour = content-stream operators + image colour spaces (pypdf). Hairlines = stroke width x CTM scale. Raster DPI = px / (trim+bleed) size.
    Booklet order: folios = 1-3 digit words in top/bottom 15% of the page (pdftotext -bbox); `imposed` expects [N,1],[2,N-1],... per sheet side.
    No pixel baseline for print (sheet only). `--zoom page=N,box=x,y,w,h` (mm from media top-left) replaces the sheet with one 300 dpi crop.
  - media: frames decoded to RGBA PNG by ffmpeg; alpha = real transparency in first/mid/last frames (not just pix_fmt). Loop = first vs last frame diff,
    compared with a normal one-frame step. Zip sources: one entry extracted to $TMPDIR/check-media-cache (archive untouched).
  - plugin: everything runs on a copy in _checks/<target>/<ts>/work. Window size parsed from figma.showUI(...). Smoke = harness.html (mock Figma)
    boots with no page/console/LOG errors. `tests` scripts get NODE_PATH = global npm root so require('playwright') works.
    Zip compare honours the committed zip's top folder (`zip.dir`).
- Real-file status (2026-11-23): poster 08 OK (WARN: cube outline art is inside the 5 mm safe margin at top/bottom/right, looks intentional).
  Jubilee video (5-yubilei-lushin.mov, qtrle argb 1920x1080 30 fps 12 s) OK; first->last differs 8.5%, so it is NOT a seamless loop
  (config has loop:false; set true if it must loop). Booklet plugin OK, committed zip matches sources. Booklet: NO print export exists yet;
  checks/booklet.json falls back to the synthetic fixture (RGB + one 42 dpi image -> 2 FAILs by design). Put the real PDF at exports/booklet.pdf.
- Open issues: plugin quick takes ~15 s (th12.js sleeps). SVG print: stroke widths/images parsed from attributes only (transforms ignored).
  Imposed-order and spread checks only tested by reasoning, not on a real imposed PDF. Thread A's open issues (hover flake, CI landing baseline) unchanged.
- Test: `tools/check/check print poster-08 --level quick`, `... media jubilee-video ...`, `... plugin booklet-plugin ...`, `... print booklet ...` (expect 2 FAIL).
