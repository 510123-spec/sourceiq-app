# Product Source Search Engine

Search a product/subject and see live web results segregated into **Manufacturers** vs **Distributors**, using Google Custom Search under the hood.

## Setup

1. **Install Node.js** (if not already): https://nodejs.org (LTS version).

2. **Get Google Custom Search credentials:**
   - API key: https://console.cloud.google.com/apis/credentials → enable "Custom Search API" → create an API key.
   - Search Engine ID (CX): https://programmablesearchengine.google.com/ → create a search engine → set "Search the entire web" → copy the Search engine ID.

3. **Configure:**
   - Copy `.env.example` to `.env`
   - Fill in `GOOGLE_API_KEY` and `GOOGLE_CX`

4. **Install dependencies and run:**
   ```
   npm install
   npm start
   ```

5. Open http://localhost:3000 in your browser.

## How classification works

The server inspects each result's title/snippet for manufacturer-type words (factory, OEM, producer, mill...) vs distributor-type words (distributor, wholesaler, dealer, trading co...) and tags the result accordingly. Results with no matching keywords are marked "Unclassified". This is a heuristic, not perfect — refine the keyword lists in `server.js` (`MANUFACTURER_HINTS` / `DISTRIBUTOR_HINTS`) as needed.
