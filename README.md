# TEC Route Lookup

GeezerGeek Pilot app — Tower Enroute Control routes from the FAA's preferred-routes database.
Live: https://tec-route-lookup.netlify.app/

- `public/` — what Netlify publishes (index.html, manifest.json, icons/)
- `netlify/functions/tec-lookup.js` — fetches and caches the FAA CSV (fly.faa.gov) server-side; dependency-free
- `netlify.toml` — publish dir `public`, functions dir; no build step

Every push to `main` redeploys the site.
