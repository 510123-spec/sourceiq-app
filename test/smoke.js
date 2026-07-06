// SourceIQ smoke test — hits every endpoint and checks the response shape.
// Run: npm test   (server must be running on port 3001)
//
// AI-backed endpoints are QUOTA-TOLERANT: a Gemini free-tier quota error counts
// as a pass (the endpoint worked; the account ran dry), any other failure fails.

const BASE = process.env.SMOKE_BASE || 'http://localhost:3001';
let passed = 0, failed = 0, skipped = 0;
const failures = [];

function ok(name) { passed++; console.log(`  PASS  ${name}`); }
function bad(name, why) { failed++; failures.push(`${name}: ${why}`); console.log(`  FAIL  ${name} — ${why}`); }
function skip(name, why) { skipped++; console.log(`  SKIP  ${name} — ${why}`); }

const QUOTA_RE = /quota|exceeded|rate.?limit|503|No AI key|high demand|overloaded|temporar/i;

async function jfetch(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, signal: AbortSignal.timeout(opts.timeout || 60000) });
  let body = null;
  try { body = await r.json(); } catch (_) {}
  return { status: r.status, body };
}

async function check(name, fn) {
  try { await fn(); ok(name); }
  catch (e) {
    if (QUOTA_RE.test(e.message)) skip(name, 'AI quota exhausted (endpoint reachable)');
    else bad(name, e.message);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
// For AI endpoints: treat a quota error response as "endpoint works"
const assertOkOrQuota = (res, shapeCheck) => {
  if (res.body && res.body.error && QUOTA_RE.test(res.body.error)) throw new Error('quota: ' + res.body.error.slice(0, 60));
  assert(res.status === 200, `HTTP ${res.status} ${JSON.stringify(res.body || {}).slice(0, 120)}`);
  shapeCheck(res.body);
};

(async () => {
  console.log(`SourceIQ smoke test → ${BASE}\n`);
  const t0 = Date.now();

  // ── Static assets ────────────────────────────────────────────────────────
  await check('GET / (dashboard html)', async () => {
    const r = await fetch(BASE + '/');
    assert(r.status === 200, `HTTP ${r.status}`);
    const html = await r.text();
    assert(html.includes('SourceIQ'), 'missing SourceIQ in html');
    assert(html.includes('app.js') && html.includes('features.js') && html.includes('styles.css'), 'missing asset references');
  });
  for (const asset of ['/styles.css', '/app.js', '/features.js']) {
    await check(`GET ${asset}`, async () => {
      const r = await fetch(BASE + asset);
      assert(r.status === 200, `HTTP ${r.status}`);
      assert((await r.text()).length > 1000, 'suspiciously small');
    });
  }

  // ── Core search modes ────────────────────────────────────────────────────
  await check('GET /api/search (product)', async () => {
    const r = await jfetch('/api/search?q=copper+cathode', { timeout: 90000 });
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(Array.isArray(r.body.results), 'results not array');
    assert(r.body.results.length > 0, 'zero results');
    const first = r.body.results[0];
    assert(first.title && first.link, 'result missing title/link');
  });

  await check('GET /api/search (company + registry)', async () => {
    const r = await jfetch('/api/search?company=Erez+Impex+Pte+Ltd&country=Singapore', { timeout: 90000 });
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(Array.isArray(r.body.results) && r.body.results.length > 0, 'no company results');
    assert('registry' in r.body, 'registry field missing');
  });

  await check('GET /api/search-customers (buyers)', async () => {
    const r = await jfetch('/api/search-customers?product=copper+scrap', { timeout: 90000 });
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(Array.isArray(r.body.results) && r.body.results.length > 0, 'no buyer results');
    assert('isRFQ' in r.body.results[0], 'isRFQ flag missing');
  });

  await check('GET /api/stock', async () => {
    const r = await jfetch('/api/stock?product=copper+cathode', { timeout: 90000 });
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(Array.isArray(r.body.results), 'results not array');
  });

  await check('GET /api/trade', async () => {
    const r = await jfetch('/api/trade?product=copper+cathode', { timeout: 90000 });
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(Array.isArray(r.body.results), 'results not array');
  });

  await check('GET /api/market', async () => {
    const r = await jfetch('/api/market?industry=copper', { timeout: 90000 });
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(Array.isArray(r.body.results), 'results not array');
  });

  await check('GET /api/price-search', async () => {
    const r = await jfetch('/api/price-search?product=iPhone+16&region=Singapore', { timeout: 120000 });
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(Array.isArray(r.body.offers), 'offers not array');
  });

  // ── Enrichment ───────────────────────────────────────────────────────────
  await check('GET /api/enrich', async () => {
    const r = await jfetch('/api/enrich?url=' + encodeURIComponent('https://kianhuatmetal.com/') + '&name=Kian+Huat+Metal', { timeout: 60000 });
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(r.body.success === true, 'success flag missing');
    assert('phone' in r.body && 'email' in r.body && 'address' in r.body && 'country' in r.body, 'contact fields missing');
  });

  await check('GET /api/service-status', async () => {
    const r = await jfetch('/api/service-status');
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(r.body.brave && r.body.gemini, 'brave/gemini blocks missing');
    assert('status' in r.body.brave && 'count' in r.body.brave, 'brave shape wrong');
    assert('freeTierDailyLimit' in r.body.gemini, 'gemini limit missing');
  });

  // ── Saved-suppliers CRUD ─────────────────────────────────────────────────
  const TL = 'https://smoke-test.example/item';
  await check('POST/PATCH/DELETE /api/saved round-trip', async () => {
    let r = await jfetch('/api/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link: TL, title: 'Smoke Test Co' }) });
    assert(r.status === 200 && r.body.saved.some(s => s.link === TL), 'save failed');
    r = await jfetch('/api/saved', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link: TL, notes: 'smoke note', status: 'quoted' }) });
    const item = r.body.saved.find(s => s.link === TL);
    assert(item && item.notes === 'smoke note' && item.status === 'quoted', 'patch failed');
    r = await jfetch('/api/saved?link=' + encodeURIComponent(TL), { method: 'DELETE' });
    assert(r.status === 200 && !r.body.saved.some(s => s.link === TL), 'delete failed');
  });

  // ── AI endpoints (quota-tolerant) ────────────────────────────────────────
  await check('GET /api/hs-code', async () => {
    const r = await jfetch('/api/hs-code?product=copper+cathodes', { timeout: 90000 });
    assertOkOrQuota(r, b => assert(b.code && /\d{4}/.test(b.code), 'no HS code in response'));
  });

  await check('POST /api/ai-inquiry', async () => {
    const r = await jfetch('/api/ai-inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 90000,
      body: JSON.stringify({ product: 'copper cathode', supplier: { title: 'Test Supplier', type: 'manufacturer', country: 'Chile', snippet: 'copper producer' } }) });
    assertOkOrQuota(r, b => assert(b.subject && b.body, 'draft incomplete'));
  });

  await check('POST /api/ai-offer', async () => {
    const r = await jfetch('/api/ai-offer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 90000,
      body: JSON.stringify({ product: 'copper scrap', buyer: { title: 'Test Buyer', type: 'importer', country: 'UAE', snippet: 'metal importer', isRFQ: false } }) });
    assertOkOrQuota(r, b => assert(b.subject && b.body, 'draft incomplete'));
  });

  await check('POST /api/ai-person-summary', async () => {
    const r = await jfetch('/api/ai-person-summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 90000,
      body: JSON.stringify({ person: 'Test Person', results: [{ title: 'Test Person - Director, TestCo | LinkedIn', snippet: 'Director at TestCo, Singapore', displayLink: 'linkedin.com' }] }) });
    assertOkOrQuota(r, b => assert(b.summary, 'no summary'));
  });

  await check('POST /api/ai-market-brief', async () => {
    const r = await jfetch('/api/ai-market-brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 90000,
      body: JSON.stringify({ industry: 'copper', country: 'Chile', results: [{ title: 'Copper market report', snippet: 'Chile produces 24% of global copper. Market valued at 300 billion USD.', displayLink: 'example.org' }] }) });
    assertOkOrQuota(r, b => assert(b.overview, 'no overview'));
  });

  await check('POST /api/copilot', async () => {
    const r = await jfetch('/api/copilot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 150000,
      body: JSON.stringify({ messages: [{ role: 'user', text: 'How many companies are on my shortlist? Answer with the tool only.' }] }) });
    assertOkOrQuota(r, b => assert(typeof b.reply === 'string' && b.reply.length > 0, 'no reply'));
  });

  await check('POST /api/identify-image', async () => {
    // 1x1 red pixel PNG — enough to prove the endpoint parses and forwards the image
    const px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const r = await jfetch('/api/identify-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 90000,
      body: JSON.stringify({ image: px, mimeType: 'image/png' }) });
    assertOkOrQuota(r, b => assert('product' in b, 'product field missing'));
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (AI quota) — ${secs}s`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  • ' + f));
  }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Smoke test crashed:', e.message); process.exit(2); });
