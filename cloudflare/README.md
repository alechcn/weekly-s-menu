# Weekly Menu on Cloudflare

Shared copy for both phones: the page plus a small Worker with a D1 database, behind a household code.

## Deploy from the Cloudflare dashboard (no token needed)

1. Cloudflare dashboard → Workers & Pages → Create → Import a repository.
2. Connect GitHub and pick `alechcn/weekly-s-menu`.
3. Set the root directory to `cloudflare`, keep the default build/deploy commands, and deploy.

Wrangler creates the D1 database on the first deploy. The Worker creates its tables and loads the
catalog recipes on the first visit. The first household code typed in on any phone is kept (4+ characters);
a `HOUSEHOLD_CODE` secret, if set, overrides it. Every push to `main` redeploys.

Personal links: `https://<worker>.workers.dev/?me=Ale` and `https://<worker>.workers.dev/?me=Anatole`

## Rebuild the page

    python3 build.py ../path/to/weekly-menu.html <recipes-export-dir>

Writes `public/` and `src/seed.json`.
