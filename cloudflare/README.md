# Weekly Menu on Cloudflare

Shared copy for both phones: static page + a Worker with a D1 document store, behind a household code.

Deploy (needs CLOUDFLARE_API_TOKEN with Workers Scripts:Edit and D1:Edit, and CLOUDFLARE_ACCOUNT_ID):

    python3 build.py ../path/to/weekly-menu.html <recipes-export-dir>
    npx wrangler d1 create weekly-menu            # put the id in wrangler.toml
    npx wrangler d1 execute weekly-menu --remote --file=schema.sql
    npx wrangler d1 execute weekly-menu --remote --file=seed.sql
    npx wrangler secret put HOUSEHOLD_CODE
    npx wrangler deploy

Personal links: https://<worker>/?me=Ale and https://<worker>/?me=Anatole
