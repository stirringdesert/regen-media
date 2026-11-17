# regen-media

## landing-preview/

Test pages for the RE:26 landing (Safari tests etc.). Every push to `main` that
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
