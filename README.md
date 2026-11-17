# regen-media

## landing-preview/

Test pages for the RE:26 landing (Safari tests etc.). Every push to `main` that
changes `landing-preview/` deploys it to the Firebase Hosting **preview channel**
`landing-mobile` (project `re26-dashboard`), never to the live site:

https://re26-dashboard--landing-mobile-6arpfa6p.web.app

The channel expires 7 days after each deploy. You can also run it by hand:
Actions > Deploy preview channel > Run workflow.

Needs the repository secret `FIREBASE_SERVICE_ACCOUNT_RE26` (the JSON key of a
service account with the Firebase Hosting Admin role). Never commit keys.

## Root files

Media used by the live landing (curator videos/posters). Leave them in place.
