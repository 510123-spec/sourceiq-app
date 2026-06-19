# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SourceIQ (package name `product-source-search-engine`) is a B2B supplier/partner intelligence tool. A user searches a product, company, or person and the app surfaces and classifies live web results — manufacturer vs. distributor, contact info, key people, trust signals, stock availability, trade data, and market data. It's a 2-file app: a single Express backend (`server.js`) and a single-page vanilla-JS frontend (`public/index.html`). There is no build step, bundler, or frontend framework.

## Commands

```bash
npm install     # install dependencies
npm start        # node server.js — runs the whole app (backend + serves public/)
```

There is no test suite, lint config, or build script in this repo (`package.json` only defines `start`). Open `http://localhost:3000` (or `$PORT`) after starting.

To exercise live search behavior locally, copy `.env.example` to `.env` and set keys (see "Live mode vs. demo mode" below), then restart the server — env vars are read once at process startup via `dotenv`.

Deployment is via Railway (`railway.toml`): nixpacks builder, `node server.js` start command, restart-on-failure.

## Architecture

### Two files, no framework
- **`server.js`** (~2100 lines) — Express app, all API routes, all search/scoring/classification logic, and bundled demo data, in one file.
- **`public/index.html`** (~4200 lines) — the entire frontend: inline `<style>`, inline `<script>`, no build step. Served statically by Express (`express.static`). Uses D3 + topojson (via CDN) for a world-map visualization and Tesseract.js (loaded lazily) for business-card OCR.

When making changes, expect to edit large single files rather than navigate a module tree — use `grep`/line offsets to jump to the relevant section rather than reading either file end-to-end.

### Live mode vs. demo mode
The app works with **zero API keys** by serving bundled `DEMO_DATA`/`DEMO_STOCK` arrays (in `server.js`), so it's always runnable. It switches to live search automatically once keys are present:

- `LIVE_MODE = Boolean((GOOGLE_API_KEY && GOOGLE_CX) || BRAVE_API_KEY)` — gates every route between demo and live.
- **Brave Search API** (`BRAVE_API_KEY`) is the primary live search engine (`searchBrave`, `braveMulti`) — used by nearly every endpoint. Google Custom Search (`GOOGLE_API_KEY`/`GOOGLE_CX`) is the legacy/fallback path referenced in the README but Brave is what most current routes call.
- `GOOGLE_API_KEY` (if present) is also reused for Google Safe Browsing checks in `/api/trust-check`, independent of which search engine is active.
- `AI_PROVIDER` is `'openai'` (if `OPENAI_API_KEY` set) else `'gemini'` (if `GEMINI_API_KEY` set) else `null`. `callAI()` dispatches to whichever provider is configured; `/api/ai-analyze` 503s if neither is set.

When adding a new search-backed route, follow the existing pattern: check `LIVE_MODE`/relevant key, return demo data or a "requires live API keys" message if absent, otherwise call `searchBrave`/`braveMulti`.

### Multi-query fan-out + scoring + dedup pipeline
Every real search endpoint (`/api/search`, `/api/stock`, `/api/trade`, `/api/market`, `/api/company-people`) follows the same shape, not a single query:
1. Build several differently-angled Brave query strings (e.g. for product search: manufacturer-direct, distributor, marketplace site-restricted, exporter, industry-directory, broad fallback, contact/quote-intent, cert/capacity-signal, page-2 — see `/api/search`'s product branch for the canonical 9-query example).
2. Fire them concurrently with `braveMulti` (uses `Promise.allSettled` so one failing query never kills the batch).
3. Score every result with a weighted heuristic (`_qs` query-source weight + bonuses/penalties for subject/country/domain/signal matches) — scoring always happens **before** deduplication so the best-scoring page per domain survives.
4. Deduplicate via `deduplicateResults` (caps results per domain, optional noise-domain filtering) or an inline equivalent.
5. Optionally apply `applyCountryFilter` (keeps in-country results; if that empties the set, returns the original with a `countryNote` so the UI never shows an empty state from over-filtering).

Reuse this pipeline shape for new search modes instead of inventing a different pattern.

### Classification & heuristics (keyword/domain-based, not ML)
- `classify()` tags each result `manufacturer` / `distributor` / `unclassified` using `MANUFACTURER_HINTS` / `DISTRIBUTOR_HINTS` keyword lists plus `DOMAIN_HINTS` (known directory/marketplace domains) — all near the top of `server.js`. Tune these lists rather than rewriting the classifier.
- `categorise()` separately tags results `direct` / `marketplace` / `linkedin` for UI sectioning (independent of manufacturer/distributor classification).
- `extractSignals()` regex-extracts business signals from title/snippet: price, MOQ, certifications (ISO/CE/RoHS/...), lead time, location, year established, production capacity, export mentions. These feed into result scoring and the "signals" badges in the UI.
- `NOISE_DOMAINS` (social/news/review sites) are filtered out of supplier results; `AGGREGATOR_DOMAINS` (ZoomInfo, Crunchbase, D&B, etc.) are flagged (`isAggregator`/`isAggregatorHost`) rather than filtered, because they're useful as links but their scraped contact details often belong to the wrong entity on a multi-company directory page.
- `INDIAN_SEO_DOMAINS` + related scoring penalties exist specifically to down-rank Indian stainless-steel/metal SEO farms that keyword-stuff unrelated target countries — a known noise pattern worth preserving when touching country-filter logic.
- Country matching (`countryMatchers`, `resultInCountry`, `COUNTRY_TLD`, `COUNTRY_ALIASES`, `COUNTRY_META`) combines ccTLD detection, country/alias/city name mentions, and Brave's native `country` param.

### API surface (`server.js`)
| Route | Purpose |
|---|---|
| `GET /api/search` | Core search — branches on query params into **product** (`q`+`country`), **company** (`company`, optional `website`), or **person** (`person`, optional `gender`) search, each with its own query-fan-out/scoring strategy. |
| `GET /api/company-people` | Finds executives/leadership for a company via regex extraction (`"Name, Title"` / `"Title Name"` patterns) over LinkedIn, Crunchbase, and general web results; rejects names that are just company-name tokens or non-name words (`NON_NAME_WORDS`). |
| `GET /api/enrich` | Best-effort scrape of a company's own site (homepage + `/contact`, `/about`, etc.) for phone/email/address/WhatsApp/key people, merged with `enrichFromExternalSources` (Wikipedia REST summary, DuckDuckGo Instant Answer, Brave for employee count/revenue/LinkedIn URL/news). Returns a `note` explaining *why* data is missing (bot-blocked, unreachable, or genuinely no published contact info) rather than failing silently. |
| `GET /api/trust-check` | Heuristic trust score (starts at 100, deducted) from HTTPS presence, domain age via RDAP, Google Safe Browsing (if `GOOGLE_API_KEY` set), and scam/fraud/complaint web searches; can also background-check up to 4 named people. |
| `GET /api/stock` | Finds suppliers with physical ready-to-ship inventory; classifies hits into `direct`/`warehouse`/`surplus` subtypes by keyword signal strength. |
| `GET /api/trade` | Import/export trade-data search (HS code aware), scored toward known trade-data sites (Panjiva, ImportGenius, etc.). |
| `GET /api/market` | Industry/market-research search (size, trends, key players), scored toward known market-research publishers (Statista, Mordor Intelligence, etc.). |
| `POST /api/ai-analyze` | Sends current result snippets + query to `callAI()` (OpenAI or Gemini) and expects back strict JSON: `summary`, `topPicks`, `keyInsights`, `suggestions`, `warning`. Mode-aware prompt context (`product`/`company`/`person`/`stock`/`image`). |

### Frontend (`public/index.html`)
Single page with a **mode-tab** UI (`setMode()`): product, company, person, stock, image, trade, market — each mode has its own input box and calls the matching backend route. Key behaviors to know before touching it:
- All API calls are plain `fetch('/api/...')` — no client framework, no state library; UI state lives in module-level JS variables and is mutated directly, then re-rendered via functions like `render()`, `renderStockTable()`, `renderTradeResults()`, `renderMarketResults()`.
- `renderDetailsHtml`/`loadDetails`/`autoEnrichCard`/`loadKeyPeople`/`runTrustCheck` progressively enrich a result card on demand (lazy network calls triggered by user interaction, not all upfront) — follow this lazy-enrichment pattern for new per-result data rather than fetching everything on initial search.
- Export functions (`exportCsv`, `exportWord`, `exportEmail`) build output client-side from already-rendered result data.
- Image mode supports drag-drop business-card OCR (Tesseract.js, lazy-loaded via `loadTesseract()`) and a Google Lens hand-off (`openGoogleLens`).
- `getRecent`/`addRecent` persist recent searches (likely `localStorage` — check before assuming).

## Conventions worth preserving
- **Resilience over correctness-by-construction**: nearly every external call is wrapped in try/catch with a timeout (`AbortSignal.timeout` or manual `AbortController`) and a graceful fallback (empty array, `null` field, or a user-facing `note`) — never let one failed sub-fetch take down a whole API response. New external calls should follow this.
- **Score-then-dedup, not dedup-then-score**: when merging multiple query result sets, always rank first so the best version of a duplicated page wins before `deduplicateResults`/manual dedup discards the rest.
- Demo data (`DEMO_DATA`, `DEMO_STOCK`) must stay shape-compatible with live results so the frontend doesn't need demo-mode-specific rendering branches.
- Comments in `server.js` tend to explain *why* a heuristic exists (e.g. why certain keywords were removed from `DISTRIBUTOR_HINTS`, why aggregator addresses aren't trustworthy) — keep that pattern when adding new heuristics rather than just describing what the code does.
