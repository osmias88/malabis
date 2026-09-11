# Malabis — Product Scraper PoC

Proof of concept for aggregating live product data (pricing, variants/sizes, stock)
from Pakistani clothing brand storefronts, ahead of the PostgreSQL + frontend build.

## What was verified against the live sites

| Brand | Storefront | Platform | Source used |
| --- | --- | --- | --- |
| Khaadi | pk / us / uk .khaadi.com | Salesforce Commerce Cloud | Category listings + PDP HTML |
| Sapphire | pk.sapphireonline.pk | Salesforce Commerce Cloud | Category listing + product sitemap + PDP HTML |
| Generation | generation.com.pk | Shopify | `/products.json`, `/products/<handle>.js` |

Khaadi and Sapphire are **not** Shopify — they run SFCC, whose `robots.txt`
disallows the internal `/on/demandware.store/` controllers (and, on Sapphire,
`?start=`/`?sz=` paging). The SFCC adapter therefore extracts everything from
crawlable pages and only touches the `Product-Variation` controller if
robots.txt actually permits it.

Khaadi runs one storefront per market and **the same product path resolves in
every one of them**, which is what makes cross-market price comparison exact
rather than fuzzy-matched.

## Design

```
src/
  cli.ts                 CLI entry (scrape | compare | serve | brands | probe | product)
  server.ts              Dashboard HTTP server + JSON API
  config/brands.ts       Brand registry, one entry per brand x market
  core/
    types.ts             Domain model + zod schemas (the future DB shape)
    http.ts              Fetch wrapper: robots.txt, retries, backoff, throttling, proxy
    limiter.ts           Concurrency + rate limiting
    normalize.ts         Money (minor units), size/colour tokens, stock rollup
    normalize.test.ts    Unit tests for the normalisation rules
    pipeline.ts          Adapter detection, orchestration, validation, stats
  adapters/
    types.ts             ScraperAdapter interface
    sfcc.ts              Salesforce Commerce Cloud (Khaadi, Sapphire)
    shopify.ts           Public Shopify JSON endpoints
    jsonld.ts            schema.org fallback for Magento/Woo/custom stores
  compare/
    compare.ts           Same-SKU cross-market price comparison
    fx.ts                USD-pivot FX with live rates and manual overrides
  output/                JSON + CSV writers, console reports
public/                  Dashboard UI (no build step, plain HTML/CSS/JS)
```

Adding a brand = one object in `config/brands.ts`.
Adding a platform = one class implementing `ScraperAdapter`.

## Usage

```bash
npm install

npm run serve                                     # dashboard on http://127.0.0.1:5173
npm run doctor                                    # egress IP + geo-redirect check
npm run brands                                    # list registry
npm run probe -- --brand sapphire-pk              # which adapter matches
npm run scrape -- --brand cambridge-pk --limit 10 # scrape + write ./output
npm run scrape -- --all --limit 5 --dry-run
npm run ingest -- --brand cambridge-pk --limit 10 # scrape + upsert to Supabase
npm run ingest -- --all --limit 10                # ingest every active brand
npm run db:verify -- cambridge-pk                  # verify latest DB run and row counts
npm run compare -- --base khaadi-us --targets khaadi-uk --limit 10
npm run dev -- product https://<store>/.../<product>.html
npm test
```

Useful flags: `--concurrency`, `--format json,csv`, `--out <dir>`,
`--log-level debug`, `--no-robots` (development only).

## Scheduled ingestion

`.github/workflows/ingest.yml` refreshes every active brand daily at 02:30 UTC.
It can also be started manually from **GitHub → Actions → Refresh product
catalog → Run workflow**, where a brand and product limit can be selected.

Add these secrets to the GitHub environment named `malabis` under **GitHub →
Settings → Environments → malabis → Environment secrets** before running the
workflow:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

The scheduled run ingests up to 25 products per brand. Scrape failures are
recorded in `scrape_runs`, and a failing brand does not prevent later brands
from being attempted.

## Render deployment

The repository includes `render.yaml`. In Render, create a **Blueprint**,
connect `osmias88/malabis`, and enter `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` when prompted. Render builds the TypeScript app,
starts the dashboard using its assigned port, and monitors `/api/health`. The
build explicitly includes TypeScript development dependencies even though the
service runtime uses `NODE_ENV=production`.

## Price comparison

`compare` scrapes a baseline market, resolves the identical SKU in the other
market storefronts, converts everything to one reporting currency and reports
the markup per item plus the median spread:

```
product                                    base    khaadi-uk      x
-------------------------------------------------------------------
Cambric Longline Kurta                    35.00        40.55  1.16x
Paisley Floral Kurta                      40.00        47.31  1.18x

Median vs khaadi-uk: 1.16x  (+5.55 USD per item)
```

FX rates come from `open.er-api.com` with an offline fallback table; pin your
real blended rate with `--rate PKR=280,GBP=0.75` when modelling margin.

### Reaching PK pricing

`pk.khaadi.com` geo-redirects to the nearest export storefront, so from outside
Pakistan the PK baseline silently returns USD/GBP prices. The comparison run
detects this and emits a warning rather than reporting a bogus gap. To get real
PKR pricing, route the run through an egress in Pakistan:

```powershell
$env:HTTPS_PROXY = "http://user:pass@<pk-proxy-host>:<port>"
npm run doctor
npm run compare -- --base khaadi-pk --targets khaadi-us,khaadi-uk --limit 20
```

`doctor` reports your egress IP and country, then checks every storefront for a
geo-redirect or currency mismatch. It exits non-zero when any storefront failed
to serve its own market, so it can gate a scheduled comparison run:

```
Egress
  proxy    : none (direct connection)
  ip       : 75.73.203.72
  location : Bloomington, US

Storefronts
  WARN khaadi-pk      pk.khaadi.com   -> us.khaadi.com   Sites-Khaadi_US-Site
       geo-redirected to us.khaadi.com
  OK   khaadi-uk      uk.khaadi.com   -> uk.khaadi.com   Sites-Khaadi_UK-Site
```

Note the proxy agent supports HTTP/HTTPS proxies, not SOCKS5. A system-wide VPN
needs no configuration at all.

## Dashboard

`npm run serve` starts a local dashboard with two pages:

- **Catalogue** (`/`) — run stats, a product grid with images, price ranges,
  stock badges and per-size chips (struck through when sold out), plus a detail
  view with the full variant table. Search, stock filter and price sorting run
  client-side; previously saved runs in `./output` can be reloaded.
- **Price gap** (`/compare.html`) — pick the market you buy in and the markets
  you sell into, and get the per-item markup, median gross spread and both the
  local and normalised price for each SKU.

API, if you want to drive it yourself:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/brands` | Registry contents |
| `GET /api/scrape?brand=<key>&limit=<n>` | Live scrape, returns `{ products, stats }` |
| `GET /api/compare?base=<key>&targets=<keys>&limit=<n>&currency=<code>` | Cross-market price gap |
| `GET /api/runs` | Saved JSON runs in `./output` |
| `GET /api/run?file=<name>.json` | Load one saved run |

## Notes

- Prices are integer minor units (paisa/cents) so the future DB never sees float drift.
- `stockStatus` is rolled up from per-size availability:
  `in_stock` / `partially_in_stock` / `out_of_stock`.
- Every record is validated with zod before it is emitted, so malformed pages show up
  as `failures` in the run stats instead of corrupt rows.
- `(brandKey, externalId)` is the natural key for the future `products` table; the CSV
  export is already one row per variant.
- The client honours `robots.txt`, sends an identifiable user agent, retries with
  backoff, and throttles per host. Confirm each brand's terms before running this at
  scale or commercially.
