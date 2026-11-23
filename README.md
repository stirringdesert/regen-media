# regen-media

## landing-preview/

Test pages for the RE:26 landing. Kept: `s/index.html` + `s/page.html` (test kit), `s/f.html` (early scroll-fix build), `s/v.html` (previous), `s/w.html` (current); `t/`, `tilt.html`, `index.html`. Every push to `main` that
changes `landing-preview/` deploys it to the Firebase Hosting **preview channel**
`landing-mobile` (project `re26-dashboard`), never to the live site:

https://re26-dashboard--landing-mobile-6arpfa6p.web.app

The channel expires 7 days after each deploy. You can also run it by hand:
Actions > Deploy preview channel > Run workflow.

Sign-in is keyless (Workload Identity Federation): only pushes to `main` of
this repo may act as `github-preview@re26-dashboard`, which has only the
Firebase Hosting Admin role. There are no secrets in this repo. Never commit keys.

## Root files

Media used by the live landing (curator videos/posters). Leave them in place.

## `tt-home-art/`

Six card graphics (SVG) for the takoy-teatr home page RE:26 block (copied to the Tilda CDN).

## Keep it small

- One version of each file, overwritten in place; git keeps history. No `-v2`/`-final`/timestamped copies.
- New test page: overwrite the oldest in `landing-preview/s/`; keep only current, previous and one early. Delete test pages when a round is done.
- No screenshots, built previews, caches or test dumps in the repo (see `.gitignore`); keep them in a temp dir.
- Media only if the live landing uses it. Never commit keys or applicant data.
