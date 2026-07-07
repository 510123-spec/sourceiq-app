const SUGGESTIONS = ["LED bulbs", "plastic bottles", "steel pipes", "textile fabric", "electronics PCB", "wood furniture", "pharma tablets", "solar panels"];
const RECENT_KEY = "pse_recent_searches";
let currentFilter = "all";
let lastResults = [];
let lastSubject = "";

function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function getRecent(){
  try{ return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); }catch{ return []; }
}

function addRecent(q){
  let recent = getRecent().filter(r => r.toLowerCase() !== q.toLowerCase());
  recent.unshift(q);
  recent = recent.slice(0, 10);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  renderChips();
}

function renderChips(){
  const chips = document.getElementById('chips');
  const recent = getRecent();
  let html = '';
  if(recent.length){
    html += recent.map(r => {
      const display = r.startsWith('🏢:') ? `🏢 ${r.slice(3)}` : r.startsWith('👤:') ? `👤 ${r.slice(3)}` : r;
      return `<span class="chip recent" onclick="quickSearch('${escapeHtml(r)}')">🕘 ${escapeHtml(display)}</span>`;
    }).join('');
  }
  html += SUGGESTIONS.map(s => `<span class="chip" onclick="quickSearch('${escapeHtml(s)}')">${escapeHtml(s)}</span>`).join('');
  chips.innerHTML = html;
}

let searchMode = 'product';

function setMode(mode){
  searchMode = mode;
  document.querySelectorAll('.mode-tab').forEach(b => {
    const active = b.dataset.mode === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.getElementById('productSearchBox').style.display   = mode === 'product'   ? 'flex' : 'none';
  document.getElementById('companySearchBox').style.display   = mode === 'company'   ? 'flex' : 'none';
  document.getElementById('personSearchBox').style.display    = mode === 'person'    ? 'flex' : 'none';
  document.getElementById('stockSearchBox').style.display     = mode === 'stock'     ? 'flex' : 'none';
  document.getElementById('imageSearchBox').style.display     = mode === 'image'     ? 'flex' : 'none';
  document.getElementById('priceSearchBox').style.display     = mode === 'price'     ? 'flex' : 'none';
  document.getElementById('tradeSearchBox').style.display     = mode === 'trade'     ? 'flex' : 'none';
  document.getElementById('marketSearchBox').style.display    = mode === 'market'    ? 'flex' : 'none';
  document.getElementById('buyersSearchBox').style.display    = mode === 'buyers'    ? 'flex' : 'none';
  const hints = {
    product:   'Search by product, by country, or both — leave either field blank to broaden the search.',
    company:   'Search for a specific company by name to find its details directly.',
    person:    'Search by a person\'s name to find which company they work for and their role.',
    stock:     'Search for a specific product to find suppliers who have it physically in stock right now — inventory, MOQ, unit price, and ready-to-ship status.',
    image:     'Upload a business card to extract details, or a photo to reverse-search on Google Lens.',
    trade:     'Find importers, exporters, and trade data by product or HS code — with optional country and direction filters.',
    market:    'Explore market size, key players, trends, and industry outlook for any sector or region.',
    buyers:    'Find companies that BUY your product — importers, retailers, wholesalers, and procurement teams by country.',
    price:     'Enter an exact product model to compare prices across trusted retailers in your region — lowest price, deals, and an AI buying verdict.'
  };
  document.getElementById('searchHint').textContent = hints[mode];
  if(mode !== 'image'){
    document.getElementById('imgResultArea').innerHTML = '';
    document.getElementById('imgFileInput').value = '';
  }
  if(mode !== 'stock'){
    document.getElementById('resultsWrap').innerHTML = '<p class="empty">Type a subject and click Search to see segregated results.</p>';
    document.getElementById('toolbar').style.display = 'none';
    lastResults = [];
  }
}

function quickSearch(q){
  if(q.startsWith('🏢:')){
    setMode('company');
    document.getElementById('companyQuery').value = q.slice(3);
  }else if(q.startsWith('👤:')){
    setMode('person');
    document.getElementById('personQuery').value = q.slice(3);
  }else if(q.includes(' — ')){
    setMode('product');
    const [product, country] = q.split(' — ');
    document.getElementById('query').value = product;
    document.getElementById('country').value = country;
  }else{
    setMode('product');
    document.getElementById('query').value = q;
  }
  runSearch();
}

async function runSearch(){
  const wrap = document.getElementById('resultsWrap');
  const toolbar = document.getElementById('toolbar');
  const banner = document.getElementById('demoBanner');
  const btn = searchMode === 'company' ? document.getElementById('companySearchBtn')
            : searchMode === 'person'  ? document.getElementById('personSearchBtn')
            : document.getElementById('searchBtn');

  const q       = searchMode === 'product' ? document.getElementById('query').value.trim() : '';
  const country = searchMode === 'product' ? document.getElementById('country').value.trim()
                : searchMode === 'company' ? document.getElementById('companyCountry').value.trim()
                : searchMode === 'person'  ? document.getElementById('personCountry').value.trim() : '';
  const company = searchMode === 'company' ? document.getElementById('companyQuery').value.trim() : '';
  const website = searchMode === 'company' ? document.getElementById('companyWebsite').value.trim() : '';
  const regno   = searchMode === 'company' ? document.getElementById('companyRegno').value.trim() : '';
  const person  = searchMode === 'person'  ? document.getElementById('personQuery').value.trim() : '';
  const gender  = searchMode === 'person'  ? document.getElementById('personGender').value.trim() : '';

  if(searchMode === 'product' && !q && !country){
    wrap.innerHTML = '<p class="empty">Type a product, pick a country, or both — then click Search.</p>';
    toolbar.style.display = 'none';
    return;
  }
  if(searchMode === 'company' && !company && !regno){
    wrap.innerHTML = '<p class="empty">Type a company name, then click Search.</p>';
    toolbar.style.display = 'none';
    return;
  }
  if(searchMode === 'person' && !person){
    wrap.innerHTML = '<p class="empty">Type a person\'s name, then click Search.</p>';
    toolbar.style.display = 'none';
    return;
  }

  btn.disabled = true;
  btn.classList.add('btn-loading');
  hideAIPanel();
  wrap.innerHTML = buildSkeleton(6);
  toolbar.style.display = 'none';
  banner.style.display = 'none';

  try{
    const params = new URLSearchParams();
    if(q) params.set('q', q);
    if(country) params.set('country', country);
    if(company) params.set('company', company);
    if(website) params.set('website', website);
    if(regno) params.set('regno', regno);
    if(person) params.set('person', person);
    if(gender) params.set('gender', gender);
    const res = await fetch('/api/search?' + params.toString());
    const data = await res.json();

    if(!res.ok || data.error){
      wrap.innerHTML = `<p class="error">${escapeHtml(data.error || 'Search failed.')}</p>`;
      return;
    }

    lastResults = data.results || [];
    lastSubject = data.subject || company || q;
    window.lastRegistry = data.registry || null;
    window.lastCompanyName = company || '';
    banner.style.display = data.demoMode ? 'block' : 'none';
    toolbar.style.display = lastResults.length ? 'flex' : 'none';
    currentFilter = 'all';
    setActiveFilterButton('all');
    document.getElementById('sortBy').value = 'relevance';

    const label = person ? `👤:${person}` : company ? `🏢:${company}` : regno ? `🏢:${regno}` : (q && country ? `${q} — ${country}` : (q || country));
    addRecent(label);
    render();
    showCountryNote(data.countryNote);
    // AI analysis runs after render so it can highlight cards
    if (lastResults.length) {
      const aiQuery = person || company || regno || (q && country ? `${q} ${country}` : q || country);
      runAIAnalysis(aiQuery, lastResults, searchMode);
      // Person mode also gets a synthesized profile panel above the raw results
      if (person) runPersonProfile(person, lastResults);
    }
  }catch(err){
    wrap.innerHTML = buildErrorState(err.message, ()=>runSearch());
  }finally{
    btn.disabled = false;
    btn.classList.remove('btn-loading');
  }
}

// ── Physical Stock Search ─────────────────────────────────────────────────────
async function runStockSearch(){
  const wrap    = document.getElementById('resultsWrap');
  const toolbar = document.getElementById('toolbar');
  const banner  = document.getElementById('demoBanner');
  const btn     = document.getElementById('stockSearchBtn');

  const product = document.getElementById('stockQuery').value.trim();
  const minQty  = document.getElementById('stockMinQty').value.trim();
  const unit    = document.getElementById('stockUnit').value.trim();
  const country = document.getElementById('stockCountry').value.trim();

  if(!product){
    wrap.innerHTML = '<p class="empty">Enter a product name, then click Search Stock.</p>';
    return;
  }

  btn.disabled = true;
  btn.classList.add('btn-loading');
  hideAIPanel();
  wrap.innerHTML = buildSkeleton(4);
  toolbar.style.display = 'none';
  banner.style.display = 'none';

  try{
    const params = new URLSearchParams();
    params.set('product', product);
    if(country) params.set('country', country);
    if(minQty)  params.set('minQty', minQty);
    if(unit)    params.set('unit', unit);
    const res  = await fetch('/api/stock?' + params.toString());
    const data = await res.json();

    if(!res.ok || data.error){
      wrap.innerHTML = `<p class="error">${escapeHtml(data.error || 'Search failed.')}</p>`;
      return;
    }

    banner.style.display = data.demoMode ? 'block' : 'none';
    renderStockTable(data);
    if (data.results && data.results.length) {
      runAIAnalysis(product + (country ? ' ' + country : ''), data.results, 'stock');
    }

  }catch(err){
    wrap.innerHTML = buildErrorState(err.message, ()=>runStockSearch());
  }finally{
    btn.disabled = false;
    btn.classList.remove('btn-loading');
  }
}

const STOCK_SUBTYPE_LABELS = { direct:'In Stock', warehouse:'Warehouse Stock', surplus:'Surplus / Clearance', listing:'General Listing' };
const STOCK_SUBTYPE_ICONS  = { direct:'✅', warehouse:'🏭', surplus:'🏷️', listing:'📋' };

function extractAvailability(snippet){
  const s = (snippet || '').toLowerCase();
  if(/in stock|ex.?stock|ready to ship|available now|immediate delivery/.test(s)) return '✅ In Stock';
  if(/warehouse|bulk stock|stock available/.test(s)) return '🏭 Warehouse';
  if(/surplus|clearance|overstocked/.test(s)) return '🏷️ Surplus';
  const moq = snippet.match(/MOQ[:\s]*[\d,]+\s*\w+/i);
  if(moq) return moq[0];
  return '';
}

function renderStockTable(data){
  const wrap    = document.getElementById('resultsWrap');
  const results = data.results || [];
  if(!results.length){
    wrap.innerHTML = '<p class="empty">No stock listings found. Try a different product name or remove the country filter.</p>';
    return;
  }

  const inStock   = results.filter(r => r.subtype === 'direct');
  const warehouse = results.filter(r => r.subtype === 'warehouse');
  const surplus   = results.filter(r => r.subtype === 'surplus');
  const general   = results.filter(r => !['direct','warehouse','surplus'].includes(r.subtype));

  let html = `
    <div class="stock-stats">
      <div style="font-size:13px;"><strong style="color:var(--text)">${results.length}</strong> listings for <strong style="color:#34d399">${escapeHtml(data.product || '')}</strong>${data.country ? ' · <span style="color:#60a5fa">' + escapeHtml(data.country) + '</span>' : ''}</div>
      <div class="ss-item"><span class="ss-badge">✅ ${inStock.length} In Stock</span></div>
      <div class="ss-item"><span class="ss-badge warehouse">🏭 ${warehouse.length} Warehouse</span></div>
      <div class="ss-item"><span class="ss-badge surplus">🏷️ ${surplus.length} Surplus</span></div>
    </div>`;

  const sections = [
    { label:'✅ In Stock — Ready to Ship',   subtype:'direct',    items:inStock },
    { label:'🏭 Warehouse & Bulk Inventory', subtype:'warehouse', items:warehouse },
    { label:'🏷️ Surplus & Clearance',        subtype:'surplus',   items:surplus },
    { label:'📋 General Listings',           subtype:'listing',   items:general }
  ];

  for(const sec of sections){
    if(!sec.items.length) continue;
    html += `<div class="group-title">${sec.label}</div><div class="stock-grid">`;

    for(const r of sec.items){
      const subtype = r.subtype || 'listing';
      const label   = STOCK_SUBTYPE_LABELS[subtype] || 'Listing';
      const icon    = STOCK_SUBTYPE_ICONS[subtype]  || '📋';
      const avail   = extractAvailability(r.snippet || '');
      const domain  = r.displayLink || '';
      const snippet = (r.snippet || '').slice(0, 160) + ((r.snippet||'').length > 160 ? '…' : '');
      const faviconSrc = domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32` : '';
      const faviconImg = faviconSrc
        ? `<img src="${faviconSrc}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span style=font-size:18px>${icon}</span>'" />`
        : `<span style="font-size:18px">${icon}</span>`;

      // Register for save/star like other card types
      const id = 'stk-' + Math.random().toString(36).slice(2,8);
      cardRegistry[id] = { ...r, _id: id, country: r.country || data.country || '' };

      // Structured deal numbers extracted server-side (price / MOQ / qty / lead time)
      const d = r.dealInfo || {};
      const dealBadges = [
        d.price    ? `<span class="deal-badge deal-price">💰 ${escapeHtml(d.price)}</span>` : '',
        d.moq      ? `<span class="deal-badge">📦 MOQ ${escapeHtml(d.moq)}</span>` : '',
        d.quantity ? `<span class="deal-badge">🏭 ${escapeHtml(d.quantity)}</span>` : '',
        d.leadTime ? `<span class="deal-badge">🚚 ${escapeHtml(d.leadTime)}</span>` : ''
      ].join('');

      html += `
        <div class="stock-card ${subtype}" id="${id}">
          <div class="stock-card-top">
            <div class="stock-card-favicon">${faviconImg}</div>
            <div class="stock-card-title-wrap">
              <a class="stock-card-title" href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>
              <div class="stock-card-domain">${escapeHtml(domain)}</div>
            </div>
            ${avail ? `<div class="stock-card-avail ${subtype}">${escapeHtml(avail)}</div>` : ''}
            <button class="card-save-btn${savedLinks.has(r.link) ? ' saved' : ''}" onclick="toggleSave('${id}', this)" title="Save to shared shortlist">${savedLinks.has(r.link) ? '★' : '☆'}</button>
          </div>
          ${dealBadges ? `<div class="deal-badges">${dealBadges}</div>` : ''}
          ${snippet ? `<div class="stock-card-snippet">${escapeHtml(snippet)}</div>` : ''}
          <div class="stock-card-footer">
            <span class="stock-card-badge">${icon} ${escapeHtml(label)}</span>
            <a class="stock-card-link" href="${escapeHtml(r.link)}" target="_blank" rel="noopener">
              Visit →
            </a>
          </div>
        </div>`;
    }

    html += `</div>`;
  }

  wrap.innerHTML = html;
}

// ── Trade Search ─────────────────────────────────────────────────────────────
async function runTradeSearch(){
  const wrap    = document.getElementById('resultsWrap');
  const toolbar = document.getElementById('toolbar');
  const banner  = document.getElementById('demoBanner');
  const btn     = document.getElementById('tradeSearchBtn');

  const product  = document.getElementById('tradeProduct').value.trim();
  const hsCode   = document.getElementById('tradeHS').value.trim();
  const country  = document.getElementById('tradeCountry').value.trim();
  const tradeDir = document.getElementById('tradeDir').value.trim();

  if(!product && !hsCode){
    wrap.innerHTML = '<p class="empty">Enter a product or HS code, then click Search Trade.</p>';
    return;
  }

  btn.disabled = true; btn.classList.add('btn-loading');
  hideAIPanel();
  wrap.innerHTML = buildSkeleton(5);
  toolbar.style.display = 'none'; banner.style.display = 'none';

  try{
    const params = new URLSearchParams();
    if(product)  params.set('product', product);
    if(hsCode)   params.set('hs', hsCode);
    if(country)  params.set('country', country);
    if(tradeDir) params.set('dir', tradeDir);
    const res  = await fetch('/api/trade?' + params.toString());
    const data = await res.json();
    if(!res.ok || data.error){ wrap.innerHTML = `<p class="error">${escapeHtml(data.error || 'Trade search failed.')}</p>`; return; }
    banner.style.display = data.demoMode ? 'block' : 'none';
    renderTradeResults(data);
    if(data.results && data.results.length) runAIAnalysis((product || hsCode) + (country ? ' ' + country : ''), data.results, 'trade');
  }catch(err){
    wrap.innerHTML = buildErrorState(err.message, ()=>runTradeSearch());
  }finally{
    btn.disabled = false; btn.classList.remove('btn-loading');
  }
}

function tradeDbLinksHtml(data){
  // Direct links into the major trade-record databases, pre-filled with this
  // search — these have actual customs/shipment records that generic web
  // results can only point at. Shown even (especially) when web search finds
  // nothing, since these databases are where the real records live.
  const q = encodeURIComponent(data.product || data.hsCode || '');
  // HS code beats a product-name search where the database understands it —
  // customs records are filed by HS heading, not by marketing names.
  const hs = (data.hsCode || '').replace(/[^\d.]/g, '');
  const iyQuery = encodeURIComponent(data.product || data.hsCode || '');
  const links = [
    ['📦 ImportYeti',  `https://www.importyeti.com/search?q=${iyQuery}`,   'US customs records — free'],
    ...(hs ? [['#️⃣ ImportYeti HS ' + hs, `https://www.importyeti.com/search?q=${encodeURIComponent(hs)}`, 'customs records by HS code']] : []),
    ['🌐 UN Comtrade', 'https://comtradeplus.un.org/',                     'official global trade statistics'],
    ['📊 Trade Map',   'https://www.trademap.org/Index.aspx',              'import/export flows by country'],
    ['🚢 Volza',       `https://www.volza.com/global-trade-data/`,         'global shipment data']
  ].map(([name, url, tip]) =>
    `<a class="trade-db-link" href="${url}" target="_blank" rel="noopener" title="${tip}">${name}</a>`).join('');
  return `<div class="trade-db-row"><span class="trade-db-label">Search trade databases directly:</span>${links}</div>`;
}

function renderTradeResults(data){
  const wrap = document.getElementById('resultsWrap');
  const results = data.results || [];
  if(!results.length){
    const msg = data.message || 'No trade data found on the open web — but the trade databases below have the actual customs records:';
    wrap.innerHTML = `<p class="empty">${escapeHtml(msg)}</p>` + tradeDbLinksHtml(data);
    return;
  }
  const dirLabel = data.tradeDir === 'import' ? '📥 Importers' : data.tradeDir === 'export' ? '📤 Exporters' : '🔄 Trade Data';
  let html = `<div class="stats">
    <div style="font-size:13px;"><strong style="color:var(--text)">${results.length}</strong> results for <strong style="color:#22d3ee">${escapeHtml(data.product || data.hsCode || '')}</strong>${data.country ? ' · <span style="color:#60a5fa">' + escapeHtml(data.country) + '</span>' : ''} — ${dirLabel}</div>
  </div>
  ${tradeDbLinksHtml(data)}
  <div class="card-grid">`;
  for(const r of results){
    const id = 'tc-' + Math.random().toString(36).slice(2,8);
    cardRegistry[id] = { ...r, _id: id, country: r.country || data.country || '' };
    const domain = r.displayLink || '';
    const favicon = domain ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32" onerror="this.style.display='none'" loading="lazy" />` : '';
    const dirIcon = (r.snippet||'').toLowerCase().includes('import') ? '📥' : (r.snippet||'').toLowerCase().includes('export') ? '📤' : '🔄';
    html += `<div class="card trade-card" id="${id}">
      <div class="card-inner">
        <div class="card-header">
          <div class="card-favicon">${favicon || '<span class="card-favicon-fallback">🔄</span>'}</div>
          <div class="card-header-info">
            <div class="card-title"><a href="${escapeHtml(r.link||'#')}" target="_blank" rel="noopener">${escapeHtml(r.title||'')}</a></div>
            <div class="card-domain">${escapeHtml(domain)}</div>
          </div>
          <span class="card-badge trade-badge">${dirIcon} Trade</span>
          <button class="card-save-btn${savedLinks.has(r.link) ? ' saved' : ''}" onclick="toggleSave('${id}', this)" title="Save to shared shortlist">${savedLinks.has(r.link) ? '★' : '☆'}</button>
        </div>
        <p class="card-snippet">${escapeHtml(r.snippet||'')}</p>
        <div class="card-actions">
          <a class="card-btn" href="${escapeHtml(r.link||'#')}" target="_blank" rel="noopener">View Source</a>
        </div>
      </div>
    </div>`;
  }
  html += '</div>';
  wrap.innerHTML = html;
}

// ── Market Search ─────────────────────────────────────────────────────────────
async function runMarketSearch(){
  const wrap    = document.getElementById('resultsWrap');
  const toolbar = document.getElementById('toolbar');
  const banner  = document.getElementById('demoBanner');
  const btn     = document.getElementById('marketSearchBtn');

  const industry = document.getElementById('marketIndustry').value.trim();
  const country  = document.getElementById('marketCountry').value.trim();
  const focus    = document.getElementById('marketFocus').value.trim();

  if(!industry){
    wrap.innerHTML = '<p class="empty">Enter an industry or sector, then click Search Market.</p>';
    return;
  }

  btn.disabled = true; btn.classList.add('btn-loading');
  hideAIPanel();
  wrap.innerHTML = buildSkeleton(5);
  toolbar.style.display = 'none'; banner.style.display = 'none';

  try{
    const params = new URLSearchParams();
    params.set('industry', industry);
    if(country) params.set('country', country);
    if(focus)   params.set('focus', focus);
    const res  = await fetch('/api/market?' + params.toString());
    const data = await res.json();
    if(!res.ok || data.error){ wrap.innerHTML = `<p class="error">${escapeHtml(data.error || 'Market search failed.')}</p>`; return; }
    banner.style.display = data.demoMode ? 'block' : 'none';
    renderMarketResults(data);
    if(data.results && data.results.length){
      runAIAnalysis(industry + (country ? ' ' + country : ''), data.results, 'market');
      runMarketBrief(industry, country, data.results);
    }
  }catch(err){
    wrap.innerHTML = buildErrorState(err.message, ()=>runMarketSearch());
  }finally{
    btn.disabled = false; btn.classList.remove('btn-loading');
  }
}

function renderMarketResults(data){
  const wrap = document.getElementById('resultsWrap');
  const results = data.results || [];
  if(!results.length){
    if(data.message){ wrap.innerHTML = `<p class="empty">${escapeHtml(data.message)}</p>`; return; }
    wrap.innerHTML = '<p class="empty">No market data found. Try a different industry term.</p>';
    return;
  }
  const focusLabel = data.focus === 'size' ? '📊 Market Size' : data.focus === 'trends' ? '📈 Trends' : data.focus === 'players' ? '🏆 Key Players' : '🔍 Market Intelligence';
  let html = `<div class="stats">
    <div style="font-size:13px;"><strong style="color:var(--text)">${results.length}</strong> results for <strong style="color:#a78bfa">${escapeHtml(data.industry||'')}</strong>${data.country ? ' · <span style="color:#60a5fa">' + escapeHtml(data.country) + '</span>' : ''} — ${focusLabel}</div>
  </div><div class="card-grid">`;
  for(const r of results){
    const id = 'mc-' + Math.random().toString(36).slice(2,8);
    const domain = r.displayLink || '';
    const favicon = domain ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32" onerror="this.style.display='none'" loading="lazy" />` : '';
    const isReport = /statista|grandview|mordor|marketsandmarkets|ibisworld|precedence|fortune|coherent|verified/i.test(domain);
    html += `<div class="card market-card" id="${id}">
      <div class="card-inner">
        <div class="card-header">
          <div class="card-favicon">${favicon || '<span class="card-favicon-fallback">📊</span>'}</div>
          <div class="card-header-info">
            <div class="card-title"><a href="${escapeHtml(r.link||'#')}" target="_blank" rel="noopener">${escapeHtml(r.title||'')}</a></div>
            <div class="card-domain">${escapeHtml(domain)}</div>
          </div>
          <span class="card-badge market-badge">${isReport ? '📊 Report' : '🔍 Insight'}</span>
        </div>
        <p class="card-snippet">${escapeHtml(r.snippet||'')}</p>
        <div class="card-actions">
          <a class="card-btn" href="${escapeHtml(r.link||'#')}" target="_blank" rel="noopener">View Report</a>
        </div>
      </div>
    </div>`;
  }
  html += '</div>';
  wrap.innerHTML = html;
}

// ── Buyers / Customers Search ─────────────────────────────────────────────────

async function runBuyersSearch(){
  const wrap    = document.getElementById('resultsWrap');
  const toolbar = document.getElementById('toolbar');
  const banner  = document.getElementById('demoBanner');
  const btn     = document.getElementById('buyersSearchBtn');

  const product = document.getElementById('buyersProduct').value.trim();
  const country = document.getElementById('buyersCountry').value.trim();
  const btype   = document.getElementById('buyersType').value.trim();

  if(!product){
    wrap.innerHTML = '<p class="empty">Enter a product name, then click Find Buyers.</p>';
    return;
  }

  btn.disabled = true; btn.classList.add('btn-loading');
  hideAIPanel();
  wrap.innerHTML = buildSkeleton(6);
  toolbar.style.display = 'none'; banner.style.display = 'none';

  try{
    const params = new URLSearchParams({ product });
    if(country) params.set('country', country);
    const res  = await fetch('/api/search-customers?' + params.toString());
    const data = await res.json();
    if(!res.ok || data.error){
      wrap.innerHTML = `<p class="error">${escapeHtml(data.error || 'Buyers search failed.')}</p>`;
      return;
    }
    banner.style.display = data.demoMode ? 'block' : 'none';
    let results = data.results || [];
    if(btype) results = results.filter(r => r.type === btype);
    // Keep the full set + context so the type-filter pills can re-render locally
    window.lastBuyerData = { results, product, country, total: data.total, note: data.note };
    window.buyerFilter = 'all';
    renderBuyerResults(results, { product, country, total: data.total, note: data.note });
  }catch(err){
    wrap.innerHTML = buildErrorState(err.message, ()=>runBuyersSearch());
  }finally{
    btn.disabled = false; btn.classList.remove('btn-loading');
  }
}

const BUYER_TYPE_META = {
  importer:    { label:'Importer',    icon:'🚢', color:'#38bdf8' },
  retailer:    { label:'Retailer',    icon:'🛒', color:'#a5b4fc' },
  wholesaler:  { label:'Wholesaler',  icon:'📦', color:'#67e8f9' },
  procurement: { label:'Procurement', icon:'📋', color:'#d8b4fe' },
  buyer:       { label:'Buyer',       icon:'🏢', color:'#7dd3fc' }
};

// Quick links into the buy-leads / RFQ sections of the big B2B portals — these
// list companies actively asking to buy, which search results only sample.
function rfqLinksHtml(product){
  const q = encodeURIComponent(product || '');
  const links = [
    ['🅰 Alibaba RFQ',    `https://sourcing.alibaba.com/rfq_search_list.htm?searchText=${q}`, 'live buy requests on Alibaba'],
    ['🌍 Go4WorldBusiness', `https://www.go4worldbusiness.com/find?searchText=${q}&doctype=buyer`, 'buyer directory + buy leads'],
    ['🛞 TradeWheel Buyers', 'https://www.tradewheel.com/buyers/', 'buy offers by category'],
    ['🔑 TradeKey Buy Offers', 'https://www.tradekey.com/buyoffers/', 'posted buying leads']
  ].map(([name, url, tip]) =>
    `<a class="trade-db-link" href="${url}" target="_blank" rel="noopener" title="${tip}">${name}</a>`).join('');
  return `<div class="trade-db-row"><span class="trade-db-label">Active buy requests on B2B portals:</span>${links}</div>`;
}

// Local re-filter by buyer type (pills) — no re-fetch needed
function setBuyerFilter(t){
  window.buyerFilter = t;
  const d = window.lastBuyerData;
  if(!d) return;
  const filtered = t === 'all' ? d.results : d.results.filter(r => r.type === t);
  renderBuyerResults(filtered, d);
}

function renderBuyerResults(results, { product, country, total, note }){
  const wrap = document.getElementById('resultsWrap');
  if(!results.length){
    wrap.innerHTML = '<p class="empty">No buyers found. Try a broader product term or remove the country filter.</p>' + rfqLinksHtml(product);
    return;
  }

  const all = (window.lastBuyerData && window.lastBuyerData.results) || results;
  const activeF = window.buyerFilter || 'all';
  const countryLabel = country ? ` in <strong style="color:#38bdf8">${escapeHtml(country)}</strong>` : '';
  let html = `<div class="stats">`;
  if(note) html += `<div class="country-note" style="margin:0 0 8px;font-size:12px;">${escapeHtml(note)}</div>`;
  html += `<div style="font-size:13px;">Found <strong style="color:var(--text)">${results.length}</strong> buyers for <strong style="color:#38bdf8">${escapeHtml(product)}</strong>${countryLabel}</div>
    <div class="stats-counts">
      <button class="stats-pill buyer-filter-pill" onclick="watchCurrentSearch('buyers')" title="Get notified of NEW buyers for this search every morning">🔔 Watch</button>
      <button class="stats-pill buyer-filter-pill${activeF==='all'?' active':''}" onclick="setBuyerFilter('all')">All (${all.length})</button>
      ${Object.entries(BUYER_TYPE_META).map(([t,m]) => {
        const n = all.filter(r=>r.type===t).length;
        return n ? `<button class="stats-pill buyer-filter-pill${activeF===t?' active':''}" style="background:${m.color}18;color:${m.color};border:1px solid ${m.color}33" onclick="setBuyerFilter('${t}')">${m.icon} ${n} ${m.label}${n>1?'s':''}</button>` : '';
      }).join('')}
    </div>
  </div>
  ${rfqLinksHtml(product)}
  <div class="card-grid">`;

  // Assign stable IDs before rendering so we can reference them after innerHTML
  const enrichQueue = [];

  for(const r of results){
    const id   = 'byr-' + Math.random().toString(36).slice(2,8);
    const meta = BUYER_TYPE_META[r.type] || BUYER_TYPE_META.buyer;
    const domain = r.displayLink || '';
    const favicon = domain
      ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32" onerror="this.parentElement.innerHTML='<span class=\\'card-favicon-fallback\\'>${meta.icon}</span>'" loading="lazy" />`
      : `<span class="card-favicon-fallback">${meta.icon}</span>`;

    // Register card — _id is required by autoEnrichCard; carry the full result
    // data so save/compare/offer work exactly like on supplier cards
    const regEntry = { ...r, country: r.country || country || '', _id: id };
    cardRegistry[id] = regEntry;
    enrichQueue.push(regEntry);

    // ImportYeti customs records for this company — verify they actually import
    const iyUrl = 'https://www.importyeti.com/search?q=' + encodeURIComponent((r.title || '').replace(/\s*[-–|].*$/, '').trim());

    html += `<div class="card buyer-card" id="${id}" style="animation-delay:${results.indexOf(r)*0.05}s">
      <div class="card-inner">
        <div class="card-header">
          <div class="card-favicon">${favicon}</div>
          <div class="card-header-info">
            <h3><a href="${escapeHtml(r.link||'#')}" target="_blank" rel="noopener">${escapeHtml(r.title||'Unnamed Company')}</a></h3>
            <div class="card-domain">
              <a href="${escapeHtml(r.link||'#')}" target="_blank" rel="noopener">${escapeHtml(domain)}</a>
            </div>
          </div>
        </div>
        <div class="badge-row">
          <span class="badge ${r.type||'buyer'}" style="gap:5px">${meta.icon} ${meta.label}</span>
          ${r.isRFQ ? '<span class="badge rfq-badge">📣 Active Buy Request</span>' : ''}
          ${r.confidence ? `<span class="confidence" style="font-size:11px;color:var(--muted)">${r.confidence}% match</span>` : ''}
          <button class="card-save-btn${savedLinks.has(r.link) ? ' saved' : ''}" onclick="toggleSave('${id}', this)" title="Save to shared shortlist">${savedLinks.has(r.link) ? '★' : '☆'}</button>
          <label class="cmp-label" title="Select to compare"><input type="checkbox" onchange="toggleCompare('${id}', this)"> ⚖</label>
        </div>
        <p class="desc">${escapeHtml(r.snippet||'')}</p>
        <div class="card-divider"></div>
        <div class="qc-loading" id="${id}-loading" style="font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:5px;margin-top:4px">
          <span class="loading-dot"></span> Loading contact info…
        </div>
        <div class="quick-contact" id="${id}-qc"></div>
        <div class="details-slot" id="${id}-slot"></div>
        <div class="card-export-row">
          <button class="card-export-btn" onclick="draftOffer('${id}', this)" title="Draft a personalized sales offer to this buyer">✍️ Offer</button>
          <a class="card-export-btn" href="${escapeHtml(iyUrl)}" target="_blank" rel="noopener" title="Check this company's US customs import records on ImportYeti">🚢 Import records</a>
        </div>
      </div>
    </div>`;
  }

  html += '</div>';
  wrap.innerHTML = html;

  // Auto-enrich all buyer cards in batches (same as product search)
  (async () => {
    const BATCH = 8;
    for(let i = 0; i < enrichQueue.length; i += BATCH){
      await Promise.allSettled(enrichQueue.slice(i, i + BATCH).map(r => autoEnrichCard(r)));
    }
  })();
}

// ─────────────────────────────────────────────────────────────────────────────

function setFilter(f){
  currentFilter = f;
  setActiveFilterButton(f);
  render();
}

function setActiveFilterButton(f){
  document.querySelectorAll('#filters button').forEach(b=>{
    b.classList.toggle('active', b.dataset.filter === f);
  });
}

function sortResults(list){
  const sortBy = document.getElementById('sortBy').value;
  const copy = [...list];
  if(sortBy === 'confidence') copy.sort((a,b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  else if(sortBy === 'name') copy.sort((a,b) => (a.title || '').localeCompare(b.title || ''));
  return copy;
}

// Prepend a small banner when the country filter couldn't confirm matches.
function showCountryNote(note){
  if(!note) return;
  const wrap = document.getElementById('resultsWrap');
  if(!wrap || !wrap.firstChild) return;
  const div = document.createElement('div');
  div.className = 'country-note';
  div.innerHTML = `🌍 ${escapeHtml(note)}`;
  wrap.insertBefore(div, wrap.firstChild);
}

function renderCompany(){
  const wrap = document.getElementById('resultsWrap');
  // Keep the server's relevance order; just float the official site to the very top
  // and push directory/aggregator listings to the bottom.
  const list = [...lastResults].sort((a,b) => {
    const rank = r => (r.isOfficial ? 0 : (r.isAggregator ? 2 : 1));
    return rank(a) - rank(b);
  });
  const official = list.filter(r => r.isOfficial);
  const profiles = list.filter(r => !r.isOfficial && !r.isAggregator);
  const directory = list.filter(r => r.isAggregator);

  let html = `<div class="stats"><span><strong>${list.length}</strong> result${list.length!==1?'s':''} for this company</span>`
    + `<div class="stats-counts">`
    + (official.length ? `<span class="stats-pill manu">🏢 Official site</span>` : '')
    + (profiles.length ? `<span class="stats-pill person">🔗 ${profiles.length} Profile${profiles.length>1?'s':''}</span>` : '')
    + (directory.length ? `<span class="stats-pill unk">📇 ${directory.length} Director${directory.length>1?'ies':'y'}</span>` : '')
    + `<button class="dossier-btn" onclick="generateDossier(this)">📋 Full Dossier</button>`
    + `</div></div>`;

  // Verified registry facts parsed from official-registry listings (ACRA etc.)
  const reg = window.lastRegistry;
  if(reg){
    const cells = [];
    if(reg.uen)          cells.push(`<span class="reg-cell"><span class="reg-label">Reg. No / UEN</span><strong>${escapeHtml(reg.uen)}</strong></span>`);
    if(reg.incorporated) cells.push(`<span class="reg-cell"><span class="reg-label">Incorporated</span><strong>${escapeHtml(reg.incorporated)}</strong></span>`);
    if(reg.status)       cells.push(`<span class="reg-cell"><span class="reg-label">Status</span><strong class="${/live|active/i.test(reg.status)?'reg-ok':'reg-warn'}">${escapeHtml(reg.status)}</strong></span>`);
    if(reg.entityType)   cells.push(`<span class="reg-cell"><span class="reg-label">Entity Type</span><strong>${escapeHtml(reg.entityType)}</strong></span>`);
    html += `<div class="registry-strip">🏛 <span class="reg-title">Official Registry</span>${cells.join('')}`
      + (reg.sourceLink ? `<a class="reg-src" href="${escapeHtml(reg.sourceLink)}" target="_blank" rel="noopener">source: ${escapeHtml(reg.source||'')} ↗</a>` : '')
      + `</div>`;
  }

  if(official.length)  html += `<div class="group-title"><span class="group-title-dot manu"></span>Official Company Website</div><div class="card-grid">${official.map(cardHtml).join('')}</div>`;
  if(profiles.length)  html += `<div class="group-title"><span class="group-title-dot dist"></span>Company Pages &amp; Mentions</div><div class="card-grid">${profiles.map(cardHtml).join('')}</div>`;
  if(directory.length) html += `<div class="group-title"><span class="group-title-dot mkt"></span>Directory &amp; Data Listings</div><div class="card-grid">${directory.map(cardHtml).join('')}</div>`;

  wrap.innerHTML = html;
  staggerCards(wrap);
  autoEnrichAll();
}

function render(){
  const wrap = document.getElementById('resultsWrap');

  if(lastResults.length === 0){
    wrap.innerHTML = '<p class="empty">No results found for that subject.</p>';
    return;
  }

  // Company lookup: render a single relevance-ranked list (official site first, then
  // profiles, then directory listings) instead of supplier-style manufacturer/
  // distributor grouping — which doesn't apply to a company search and can promote a
  // misclassified directory page above the real company site.
  if(searchMode === 'company'){
    renderCompany();
    return;
  }

  let filtered = currentFilter === 'all' ? lastResults : lastResults.filter(r => r.type === currentFilter);
  filtered = sortResults(filtered);

  const people = filtered.filter(r => r.type === 'person');
  const manus = filtered.filter(r => r.type === 'manufacturer');
  const dists = filtered.filter(r => r.type === 'distributor');
  const unk = filtered.filter(r => r.type === 'unclassified');

  const total = filtered.length;
  let statsPills = '';
  if(people.length) statsPills += `<span class="stats-pill person">👤 ${people.length} Profile${people.length>1?'s':''}</span>`;
  if(manus.length)  statsPills += `<span class="stats-pill manu">🏭 ${manus.length} Manufacturer${manus.length>1?'s':''}</span>`;
  if(dists.length)  statsPills += `<span class="stats-pill dist">📦 ${dists.length} Distributor${dists.length>1?'s':''}</span>`;
  if(unk.length)    statsPills += `<span class="stats-pill unk">🔍 ${unk.length} Other</span>`;
  let html = `<div class="stats"><span><strong>${total}</strong> result${total!==1?'s':''} found</span><div class="stats-counts">${statsPills}</div></div>`;

  if(people.length){
    html += `<div class="group-title">👤 People / Profiles</div><div class="card-grid">${people.map(personCardHtml).join('')}</div>`;
  }

  // Split non-person results: direct company sites first, marketplace listings after
  const nonPeople = [...manus, ...dists, ...unk];
  const directResults = nonPeople.filter(r => r.category !== 'marketplace');
  const mktplResults  = nonPeople.filter(r => r.category === 'marketplace');

  if(directResults.length){
    const manuDirect = directResults.filter(r => r.type === 'manufacturer');
    const distDirect = directResults.filter(r => r.type !== 'manufacturer');
    if(manuDirect.length) html += `<div class="group-title"><span class="group-title-dot manu"></span>Manufacturers — Direct Websites</div><div class="card-grid">${manuDirect.map(cardHtml).join('')}</div>`;
    if(distDirect.length) html += `<div class="group-title"><span class="group-title-dot dist"></span>Distributors &amp; Suppliers — Direct Websites</div><div class="card-grid">${distDirect.map(cardHtml).join('')}</div>`;
  }
  if(mktplResults.length){
    html += `<div class="group-title"><span class="group-title-dot mkt"></span>Marketplace &amp; Directory Listings</div><div class="card-grid">${mktplResults.map(cardHtml).join('')}</div>`;
  }

  wrap.innerHTML = html;
  staggerCards(wrap);
  // Auto-fetch contact details for all live results in background
  autoEnrichAll();
}

let cardCounter = 0;
const cardRegistry = {};

function faviconHtml(domain, fallback){
  if(!domain) return `<div class="card-favicon"><span class="card-favicon-fallback">${fallback}</span></div>`;
  const src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  return `<div class="card-favicon"><img src="${src}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=card-favicon-fallback>${fallback}</span>'" /></div>`;
}

function personCardHtml(r){
  const id = 'card-' + (cardCounter++);
  r._id = id;
  cardRegistry[id] = r;

  const domain = r.displayLink || '';
  const snippet = r.snippet || '';
  const initials = (r.title || '?').split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();
  const photoHtml = r.thumbnail
    ? `<img class="person-photo" src="${escapeHtml(r.thumbnail)}" alt="profile photo"
         onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
       /><div class="person-avatar" style="display:none">${escapeHtml(initials)}</div>`
    : `<div class="person-avatar">${escapeHtml(initials)}</div>`;

  return `
    <div class="card person-card" id="${id}">
      <div class="card-inner">
        <div class="person-header">
          <div class="person-photo-wrap">${photoHtml}</div>
          <div class="person-info">
            <div class="badge-row">
              <span class="badge person-badge">👤 Profile</span>
            </div>
            <h3><a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></h3>
            <div class="card-domain">
              ${faviconHtml(domain,'🌐')}
              <span class="card-domain-dot"></span>
              <a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(domain)}</a>
            </div>
          </div>
        </div>
        <div class="card-divider"></div>
        <div class="desc">${escapeHtml(snippet)}</div>
        ${personAffiliationHtml(r)}
        <div class="details-slot" id="${id}-slot"></div>
        <button class="trust-btn" onclick="runTrustCheck('${id}', this)">🛡 Check Trust &amp; Reputation</button>
        <div class="trust-slot" id="${id}-trust"></div>
      </div>
    </div>
  `;
}

const SIGNAL_ICONS = { price:'💰', moq:'📦', cert:'✅', leadtime:'🚚', since:'📅', capacity:'🏭', location:'📍', export:'🌍' };

function signalsHtml(signals) {
  if (!signals || !signals.length) return '';
  return '<div class="signals-row">' +
    signals.map(s => `<span class="signal-chip ${escapeHtml(s.type)}" title="${escapeHtml(s.label)}">${SIGNAL_ICONS[s.type]||''} ${escapeHtml(s.label)}</span>`).join('') +
    '</div>';
}

function quickContactHtml(r) {
  let btns = '';
  if (r.email)    btns += `<a class="qc-btn email"    href="mailto:${escapeHtml(r.email)}"    title="${escapeHtml(r.email)}">✉️ Email</a>`;
  if (r.phone)    btns += `<a class="qc-btn phone"    href="tel:${escapeHtml(r.phone)}"       title="${escapeHtml(r.phone)}">📞 Call</a>`;
  if (r.whatsapp) btns += `<a class="qc-btn whatsapp" href="https://wa.me/${escapeHtml(r.whatsapp.replace(/[^\d]/g,''))}" target="_blank" rel="noopener" title="WhatsApp ${escapeHtml(r.whatsapp)}">💬 WhatsApp</a>`;
  if (!btns) return '';
  return `<div class="quick-contact">${btns}</div>`;
}

function cardHtml(r){
  const labels    = { manufacturer:'Manufacturer', distributor:'Distributor', unclassified:'Supplier' };
  const typeIcons = { manufacturer:'🏭', distributor:'📦', unclassified:'🔍' };
  const conf = (r.confidence != null && r.type !== 'unclassified') ? `<span class="confidence">${r.confidence}%</span>` : '';

  const id = 'card-' + (cardCounter++);
  r._id = id;
  cardRegistry[id] = r;

  const domain  = r.displayLink || '';
  const snippet = r.snippet || '';
  const isMktpl = r.category === 'marketplace';
  const snippetShort = snippet.length > 220 ? snippet.slice(0, 220) + '…' : snippet;
  const hasLong = snippet.length > 220;

  const hasInlineContact = r.phone || r.email || r.address || r.whatsapp || r.employeeCount || r.founded || (r.keyPeople && r.keyPeople.length);
  const detailsInner = hasInlineContact ? renderDetailsHtml(r, r.link) : '';

  return `
    <div class="card ${r.type}${isMktpl ? ' marketplace-card' : ''}" id="${id}">
      <div class="card-inner">
        <div class="card-header">
          ${faviconHtml(domain, typeIcons[r.type]||'🔍')}
          <div class="card-header-info">
            <div class="badge-row">
              <span class="badge ${r.type}">${typeIcons[r.type]} ${labels[r.type]||'Supplier'}</span>
              ${isMktpl ? '<span class="badge unclassified">🏪 Directory</span>' : ''}
              ${conf}
              <button class="card-save-btn${savedLinks.has(r.link) ? ' saved' : ''}" onclick="toggleSave('${id}', this)" title="Save to shared shortlist">${savedLinks.has(r.link) ? '★' : '☆'}</button>
              <label class="cmp-label" title="Select to compare"><input type="checkbox" ${compareIds.has(id) ? 'checked' : ''} onchange="toggleCompare('${id}', this)"> ⚖</label>
            </div>
            <h3><a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></h3>
            <div class="card-domain">
              <a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(domain)}</a>
            </div>
          </div>
        </div>
        ${signalsHtml(r.signals)}
        <div class="desc">
          <span class="snippet-short" id="${id}-short">${escapeHtml(snippetShort)}</span>
          ${hasLong ? `<span class="snippet-full" id="${id}-full">${escapeHtml(snippet)}</span>
          <button class="snippet-toggle" onclick="toggleSnippet('${id}')">Show more ▾</button>` : ''}
        </div>
        <div class="qc-loading" id="${id}-loading"><span class="loading-dot"></span> Loading contact info…</div>
        <div id="${id}-qc"></div>
        <div class="details-slot" id="${id}-slot">${detailsInner}</div>
        <div class="card-divider"></div>
        <button class="people-btn" onclick="loadKeyPeople('${id}', this)">👥 Find Key People</button>
        <div class="people-slot" id="${id}-people"></div>
        <div class="card-export-row">
          <button class="card-export-btn" onclick="exportCardWord('${id}')">📄 Word</button>
          <button class="card-export-btn" onclick="exportCardEmail('${id}')">📧 Email</button>
          <button class="card-export-btn" onclick="draftInquiry('${id}')" title="Open a pre-written RFQ email to this supplier">✍️ Inquiry</button>
          <button class="card-export-btn card-copy-btn" onclick="copyCard('${id}', this)" title="Copy all details to clipboard">📋 Copy</button>
          <button class="card-export-btn card-cut-btn" onclick="cutCard('${id}')" title="Remove this card">✂️ Cut</button>
        </div>
        <button class="trust-btn" onclick="runTrustCheck('${id}', this)">🛡 Trust Check</button>
        <div class="trust-slot" id="${id}-trust"></div>
      </div>
    </div>
  `;
}

function toggleSnippet(id) {
  const s = document.getElementById(id + '-short');
  const f = document.getElementById(id + '-full');
  const btn = s && s.parentElement.querySelector('.snippet-toggle');
  if (!s || !f) return;
  const isExpanded = f.style.display === 'block';
  f.style.display = isExpanded ? 'none' : 'block';
  s.style.display = isExpanded ? 'block' : 'none';
  if (btn) btn.textContent = isExpanded ? 'Show more ▾' : 'Show less ▴';
}

function renderDetailsHtml(d, website){
  const rows = [];

  // Company Brain: flag if we've dealt with this company before
  if(d.memory && d.memory.known){
    const when = d.memory.lastSeen ? new Date(d.memory.lastSeen).toLocaleDateString() : '';
    const tr = d.memory.trustRating ? ' · trust: ' + escapeHtml(d.memory.trustRating) : '';
    rows.push(['📓 Seen before', `<span style="color:#b45309;font-weight:600">You've looked at this company ${d.memory.interactionCount}× (last ${escapeHtml(when)})${tr}</span>`]);
  }

  // Description from Wikipedia / DuckDuckGo
  if(d.description){
    const srcLinks = [];
    if(d.wikipedia) srcLinks.push(`<a href="${escapeHtml(d.wikipedia)}" target="_blank" rel="noopener">Wikipedia ↗</a>`);
    const srcNote = srcLinks.length ? ` <span style="font-size:11px;color:var(--muted)">(${srcLinks.join(', ')})</span>` : '';
    rows.push(['📝 Overview', `<span style="font-size:12.5px;line-height:1.6;color:var(--text-2)">${escapeHtml(d.description)}</span>${srcNote}`]);
  }

  if(d.phone) rows.push(['📞 Tel', escapeHtml(d.phone)]);
  if(d.fax) rows.push(['📠 Fax', escapeHtml(d.fax)]);
  if(d.whatsapp){
    const waLink = 'https://wa.me/' + d.whatsapp.replace(/[^\d]/g, '');
    rows.push(['💬 WhatsApp', `<a href="${waLink}" target="_blank" rel="noopener">${escapeHtml(d.whatsapp)}</a>`]);
  }
  if(d.email) rows.push(['✉️ Email', `<a href="mailto:${escapeHtml(d.email)}">${escapeHtml(d.email)}</a>`]);
  if(website) rows.push(['🌐 Website', `<a href="${escapeHtml(website)}" target="_blank" rel="noopener">${escapeHtml(website)}</a>`]);
  if(d.linkedin) rows.push(['in LinkedIn', `<a href="${escapeHtml(d.linkedin)}" target="_blank" rel="noopener">${escapeHtml(d.linkedin.replace(/^https?:\/\//,''))}</a>`]);
  if(d.address) rows.push(['📍 Address', escapeHtml(d.address)]);
  // No full address found, but we could still pin down a country (from JSON-LD,
  // page text, a search-result hint, or the domain's ccTLD) — show that instead
  // of nothing. Skip if the address text already mentions it, to avoid repeating.
  else if(d.country) rows.push(['🌍 Country', escapeHtml(d.country)]);
  if(d.founders && d.founders.length){
    rows.push(['🚀 Founders', escapeHtml(d.founders.join(', '))]);
  }
  if(d.fundingStage) rows.push(['💼 Funding', escapeHtml(d.fundingStage)]);
  if(d.industry) rows.push(['🏭 Industry', escapeHtml(d.industry)]);
  if(d.revenue) rows.push(['💰 Revenue', escapeHtml(d.revenue)]);
  if(d.companySize){
    const sizeLabel = d.companySize.replace(/\s*\(.*?\)\s*$/, '');
    rows.push(['🏢 Company Size', escapeHtml(sizeLabel) + (d.employeeCount ? ` — ~${escapeHtml(d.employeeCount)} employees` : '')]);
  }else if(d.employeeCount){
    rows.push(['🏢 Employees', `~${escapeHtml(d.employeeCount)}`]);
  }
  if(d.founded) rows.push(['📅 Founded', escapeHtml(d.founded)]);
  if(d.hiringStatus){
    const isHiring = d.hiringStatus === 'Actively hiring';
    rows.push(['💼 Hiring', `<span style="color:${isHiring?'#047857':'#b45309'};font-weight:600">${escapeHtml(d.hiringStatus)}</span>`]);
  }
  if(d.keyPeople && d.keyPeople.length){
    rows.push(['👤 Key People', d.keyPeople.map(p => `${escapeHtml(p.name)} (${escapeHtml(p.title)})`).join(', ')]);
  }

  // Directory/aggregator listing — warn that details may belong to a different entity.
  const aggregatorNote = d.isAggregator
    ? `<div class="detail-note" style="border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.07);color:#fcd34d">⚠️ ${escapeHtml(d.note || 'Third-party directory listing — details may not match this exact company.')}</div>`
    : '';

  const hasContact = rows.length > 0;
  if(!hasContact && !d.news?.length){
    const msg = d.note || 'No contact details were published on this website.';
    const visit = website ? ` <a href="${escapeHtml(website)}" target="_blank" rel="noopener" style="color:#60a5fa;font-weight:600">Open website ↗</a>` : '';
    return `<div class="detail-note"${d.isAggregator ? ' style="border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.07);color:#fcd34d"':''}>${d.isAggregator?'⚠️ ':''}${escapeHtml(msg)}${visit}</div>`;
  }

  const grid = hasContact
    ? `<div class="details-grid">${rows.map(([label,val]) => `<div class="detail-row"><span class="detail-label">${label}</span><span class="detail-value">${val}</span></div>`).join('')}</div>`
    : '';

  // Recent news section
  let newsHtml = '';
  if(d.news && d.news.length){
    const newsItems = d.news.map(n =>
      `<div class="detail-row" style="flex-direction:column;gap:2px;padding:6px 0;border-bottom:1px solid var(--line)">` +
      `<a href="${escapeHtml(n.url)}" target="_blank" rel="noopener" style="color:var(--accent-hi);font-size:13px;font-weight:500;line-height:1.4">${escapeHtml(n.title)}</a>` +
      (n.age ? `<span style="font-size:11px;color:var(--muted)">${escapeHtml(n.age)}</span>` : '') +
      (n.snippet ? `<span style="font-size:12px;color:var(--text-2)">${escapeHtml(n.snippet)}</span>` : '') +
      `</div>`
    ).join('');
    newsHtml = `<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(15,23,42,.08)">` +
      `<div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">Recent News</div>` +
      newsItems + `</div>`;
  }

  return aggregatorNote + grid + newsHtml;
}

async function loadDetails(id, btn){
  const r = cardRegistry[id];
  if(!r) return;
  const card = document.getElementById(id);
  const slot = card.querySelector('.details-slot');

  btn.disabled = true;
  btn.textContent = 'Looking up...';

  try{
    const enrichUrl = '/api/enrich?url=' + encodeURIComponent(r.link) + (r.title ? '&name=' + encodeURIComponent(r.title) : '') + (r.country ? '&country=' + encodeURIComponent(r.country) : '');
    const res = await fetch(enrichUrl);
    const data = await res.json();

    if(!res.ok || data.error){
      slot.innerHTML = `<div class="detail-error">${escapeHtml(data.error || 'Lookup failed.')}</div>`;
      btn.remove();
      return;
    }

    slot.innerHTML = renderDetailsHtml(data, data.website || r.link);
    btn.remove();
  }catch(err){
    slot.innerHTML = `<div class="detail-error">Lookup failed: ${escapeHtml(err.message)}</div>`;
    btn.remove();
  }
}

function exportCsv(){
  if(!lastResults.length) return;
  const rows = [["Type","Confidence","Title","Link","Snippet","Domain","Phone","WhatsApp","Email","Address","Company Size","Employees","Founded","Key People"]];
  sortResults(currentFilter === 'all' ? lastResults : lastResults.filter(r => r.type === currentFilter))
    .forEach(r => rows.push([
      r.type, r.confidence ?? '', r.title, r.link, r.snippet, r.displayLink,
      r.phone ?? '', r.whatsapp ?? '', r.email ?? '', r.address ?? '',
      r.companySize ?? '', r.employeeCount ?? '', r.founded ?? '',
      (r.keyPeople || []).map(p => `${p.name} (${p.title})`).join('; ')
    ]));

  const csv = rows.map(row =>
    row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(lastSubject || 'results').replace(/[^a-z0-9]+/gi, '_')}_results.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function buildResultsText(includeHtml){
  const results = currentFilter === 'all' ? lastResults : lastResults.filter(r => r.type === currentFilter);
  const sorted = sortResults(results);
  const manus = sorted.filter(r=>r.type==='manufacturer');
  const dists = sorted.filter(r=>r.type==='distributor');
  const unk   = sorted.filter(r=>r.type==='unclassified');
  const date  = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'});

  if(includeHtml){
    const cardBlock = (r,idx) => {
      const typeLabel = r.type==='manufacturer'?'MANUFACTURER':r.type==='distributor'?'DISTRIBUTOR':'UNCLASSIFIED';
      const typeColor = r.type==='manufacturer'?'#1a7a4a':r.type==='distributor'?'#b87a00':'#666';
      const rows = [];
      if(r.phone)        rows.push(['Tel', r.phone]);
      if(r.whatsapp)     rows.push(['WhatsApp', r.whatsapp]);
      if(r.email)        rows.push(['Email', r.email]);
      if(r.link)         rows.push(['Website', r.link]);
      if(r.address)      rows.push(['Address', r.address]);
      if(r.companySize)  rows.push(['Company Size', r.companySize.replace(/\s*\(.*?\)\s*$/,'') + (r.employeeCount?` — ~${r.employeeCount} employees`:'')]);
      if(r.founded)      rows.push(['Founded', r.founded]);
      if(r.keyPeople&&r.keyPeople.length) rows.push(['Key People', r.keyPeople.map(p=>`${p.name} (${p.title})`).join(', ')]);
      const tableRows = rows.map(([l,v])=>`<tr><td style="font-weight:600;color:#555;width:110px;padding:4px 8px;border:1px solid #ddd;">${l}</td><td style="padding:4px 8px;border:1px solid #ddd;">${v}</td></tr>`).join('');
      return `<div style="margin-bottom:18px;padding:14px;border:1px solid #ddd;border-left:4px solid ${typeColor};border-radius:4px;page-break-inside:avoid;">
        <div style="margin-bottom:6px;"><span style="background:${typeColor}22;color:${typeColor};font-weight:700;font-size:10px;padding:2px 10px;border-radius:20px;letter-spacing:.5px;">${typeLabel}</span>${r.confidence?`<span style="font-size:10px;color:#888;margin-left:8px;">${r.confidence}% confidence</span>`:''}</div>
        <div style="font-size:14px;font-weight:700;margin-bottom:4px;">${r.title||''}</div>
        <div style="font-size:11px;color:#555;margin-bottom:4px;">${r.displayLink||''}</div>
        <div style="font-size:12px;color:#444;margin-bottom:8px;">${r.snippet||''}</div>
        ${tableRows?`<table style="border-collapse:collapse;width:100%;font-size:12px;">${tableRows}</table>`:''}
      </div>`;
    };
    const section = (title,color,items) => items.length?`<h2 style="font-size:14pt;color:${color};border-bottom:2px solid ${color};padding-bottom:4px;margin-top:24px;">${title}</h2>${items.map((r,i)=>cardBlock(r,i)).join('')}`:'';
    return `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'><title>Search Results</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#222;margin:40px;}h1{font-size:18pt;}p{margin:4px 0;}</style>
</head><body>
<h1 style="color:#1a2040;">Product Source Search Results</h1>
<p style="color:#666;font-size:10pt;">Subject: <b>${escapeHtml(lastSubject)}</b> &nbsp;|&nbsp; Generated: ${date} &nbsp;|&nbsp; ${sorted.length} result(s)</p>
<hr style="border:none;border-top:1px solid #ddd;margin:12px 0;">
${section('🏭 Manufacturers','#1a7a4a',manus)}
${section('📦 Distributors','#b87a00',dists)}
${section('❓ Unclassified','#666',unk)}
<p style="font-size:9pt;color:#999;margin-top:30px;border-top:1px solid #eee;padding-top:8px;">Generated by Product Source Search Engine. Classification is heuristic — always verify independently.</p>
</body></html>`;
  }

  // Plain text version for email
  const fmt = (r) => {
    const lines = [`${r.title||''} [${(r.type||'').toUpperCase()}${r.confidence?` ${r.confidence}%`:''}]`];
    if(r.displayLink) lines.push(`Website: ${r.displayLink}`);
    if(r.phone)       lines.push(`Tel: ${r.phone}`);
    if(r.whatsapp)    lines.push(`WhatsApp: ${r.whatsapp}`);
    if(r.email)       lines.push(`Email: ${r.email}`);
    if(r.address)     lines.push(`Address: ${r.address}`);
    if(r.founded)     lines.push(`Founded: ${r.founded}`);
    if(r.keyPeople&&r.keyPeople.length) lines.push(`Key People: ${r.keyPeople.map(p=>`${p.name} (${p.title})`).join(', ')}`);
    if(r.snippet)     lines.push(`About: ${r.snippet}`);
    return lines.join('\n');
  };
  const sections = [];
  if(manus.length) sections.push(`===== MANUFACTURERS (${manus.length}) =====\n\n${manus.map((r,i)=>`${i+1}. ${fmt(r)}`).join('\n\n')}`);
  if(dists.length) sections.push(`===== DISTRIBUTORS (${dists.length}) =====\n\n${dists.map((r,i)=>`${i+1}. ${fmt(r)}`).join('\n\n')}`);
  if(unk.length)   sections.push(`===== UNCLASSIFIED (${unk.length}) =====\n\n${unk.map((r,i)=>`${i+1}. ${fmt(r)}`).join('\n\n')}`);
  return `Product Source Search Results\nSubject: ${lastSubject}\nDate: ${date}\nTotal: ${sorted.length} result(s)\n\n${sections.join('\n\n')}\n\n---\nClassification is heuristic — always verify independently.`;
}

// ── Single-card export helpers ────────────────────────────
function buildCardHtmlBlock(r) {
  const typeLabel = r.type==='manufacturer'?'MANUFACTURER':r.type==='distributor'?'DISTRIBUTOR':r.type==='person'?'PROFILE':'UNCLASSIFIED';
  const typeColor = r.type==='manufacturer'?'#1a7a4a':r.type==='distributor'?'#b87a00':r.type==='person'?'#7c3aed':'#666';
  const rows = [];
  if(r.phone)       rows.push(['Tel', r.phone]);
  if(r.whatsapp)    rows.push(['WhatsApp', r.whatsapp]);
  if(r.email)       rows.push(['Email', r.email]);
  if(r.link)        rows.push(['Website', r.link]);
  if(r.address)     rows.push(['Address', r.address]);
  if(r.companySize) rows.push(['Company Size', r.companySize.replace(/\s*\(.*?\)\s*$/,'') + (r.employeeCount?` — ~${r.employeeCount} employees`:'')]);
  if(r.founded)     rows.push(['Founded', r.founded]);
  if(r.keyPeople&&r.keyPeople.length) rows.push(['Key People', r.keyPeople.map(p=>`${p.name} (${p.title})`).join(', ')]);
  const tableRows = rows.map(([l,v])=>`<tr><td style="font-weight:600;color:#555;width:110px;padding:4px 8px;border:1px solid #ddd;">${l}</td><td style="padding:4px 8px;border:1px solid #ddd;">${v}</td></tr>`).join('');
  return `<div style="margin-bottom:18px;padding:14px;border:1px solid #ddd;border-left:4px solid ${typeColor};border-radius:4px;">
    <div style="margin-bottom:6px;"><span style="background:${typeColor}22;color:${typeColor};font-weight:700;font-size:10px;padding:2px 10px;border-radius:20px;letter-spacing:.5px;">${typeLabel}</span></div>
    <div style="font-size:14px;font-weight:700;margin-bottom:4px;">${r.title||''}</div>
    <div style="font-size:11px;color:#555;margin-bottom:4px;">${r.displayLink||''}</div>
    <div style="font-size:12px;color:#444;margin-bottom:8px;">${r.snippet||''}</div>
    ${tableRows?`<table style="border-collapse:collapse;width:100%;font-size:12px;">${tableRows}</table>`:''}
  </div>`;
}

function buildCardPlainText(r) {
  const lines = [`${r.title||''} [${(r.type||'').toUpperCase()}]`];
  if(r.displayLink) lines.push(`Website: ${r.displayLink}`);
  if(r.phone)       lines.push(`Tel: ${r.phone}`);
  if(r.whatsapp)    lines.push(`WhatsApp: ${r.whatsapp}`);
  if(r.email)       lines.push(`Email: ${r.email}`);
  if(r.address)     lines.push(`Address: ${r.address}`);
  if(r.companySize) lines.push(`Company Size: ${r.companySize.replace(/\s*\(.*?\)\s*$/,'')}`);
  if(r.founded)     lines.push(`Founded: ${r.founded}`);
  if(r.keyPeople&&r.keyPeople.length) lines.push(`Key People: ${r.keyPeople.map(p=>`${p.name} (${p.title})`).join(', ')}`);
  if(r.snippet)     lines.push(`About: ${r.snippet}`);
  return lines.join('\n');
}

function copyInputValue(inputId, btn) {
  const val = document.getElementById(inputId)?.value || '';
  if (!val) return;
  navigator.clipboard.writeText(val).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = '✅ Copied!';
    setTimeout(() => { btn.innerHTML = orig; }, 1800);
  });
}

async function pasteInputValue(inputId) {
  try {
    const text = await navigator.clipboard.readText();
    const el = document.getElementById(inputId);
    if (el && text) { el.value = text; el.focus(); }
  } catch { alert('Paste blocked by browser — use Ctrl+V instead.'); }
}

function copyCard(id, btn) {
  const r = cardRegistry[id];
  if (!r) return;
  const lines = [];
  if (r.title)   lines.push(r.title);
  if (r.link)    lines.push(r.link);
  if (r.snippet) lines.push(r.snippet);
  if (r.phone)   lines.push('Tel: ' + r.phone);
  if (r.fax)     lines.push('Fax: ' + r.fax);
  if (r.whatsapp) lines.push('WhatsApp: ' + r.whatsapp);
  if (r.email)   lines.push('Email: ' + r.email);
  if (r.address) lines.push('Address: ' + r.address);
  if (r.founded) lines.push('Founded: ' + r.founded);
  if (r.founders && r.founders.length) lines.push('Founders: ' + r.founders.join(', '));
  if (r.industry) lines.push('Industry: ' + r.industry);
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = '✅ Copied!';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
  });
}

function cutCard(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.transition = 'opacity .25s, transform .25s';
  el.style.opacity = '0';
  el.style.transform = 'scale(.95)';
  setTimeout(() => el.remove(), 260);
  delete cardRegistry[id];
}

function exportCardWord(id) {
  const r = cardRegistry[id];
  if (!r) return;
  const date = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'});
  const body = buildCardHtmlBlock(r);
  const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'><title>${r.title||'Company'}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#222;margin:40px;}</style>
</head><body>
<h1 style="color:#1a2040;">${r.title||'Company Details'}</h1>
<p style="color:#666;font-size:10pt;">Generated: ${date}</p>
<hr style="border:none;border-top:1px solid #ddd;margin:12px 0;">
${body}
<p style="font-size:9pt;color:#999;margin-top:30px;border-top:1px solid #eee;padding-top:8px;">Generated by Product Source Search Engine.</p>
</body></html>`;
  const blob = new Blob(['﻿'+html], {type:'application/msword'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(r.title||'company').replace(/[^a-z0-9]+/gi,'_').slice(0,40)}.doc`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportCardEmail(id) {
  const r = cardRegistry[id];
  if (!r) return;
  const text = buildCardPlainText(r);
  const subject = encodeURIComponent(`Company Info: ${r.title||''}`);
  const maxLen = 6000;
  const body = text.length > maxLen ? encodeURIComponent(text.slice(0,maxLen)+'\n\n[truncated]') : encodeURIComponent(text);
  const link = document.createElement('a');
  link.href = `mailto:?subject=${subject}&body=${body}`;
  link.click();
}

function exportWord(){
  if(!lastResults.length) return;
  const html = buildResultsText(true);
  const blob = new Blob(['﻿'+html], {type:'application/msword'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(lastSubject||'results').replace(/[^a-z0-9]+/gi,'_')}_results.doc`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportEmail(){
  if(!lastResults.length) return;
  const text = buildResultsText(false);
  const subject = encodeURIComponent(`Product Source Search: ${lastSubject}`);
  // mailto body has a browser limit; truncate gracefully
  const maxLen = 6000;
  const body = text.length > maxLen
    ? encodeURIComponent(text.slice(0, maxLen) + '\n\n[Full results truncated — export Word doc for complete list]')
    : encodeURIComponent(text);
  const link = document.createElement('a');
  link.href = `mailto:?subject=${subject}&body=${body}`;
  link.click();
}

document.getElementById('query').addEventListener('keydown', e=>{ if(e.key==='Enter') runSearch(); });
document.getElementById('companyQuery').addEventListener('keydown', e=>{ if(e.key==='Enter') runSearch(); });
document.getElementById('companyWebsite').addEventListener('keydown', e=>{ if(e.key==='Enter') runSearch(); });
document.getElementById('companyCountry').addEventListener('change', ()=>{ if(document.getElementById('companyQuery').value.trim()) runSearch(); });
document.getElementById('personCountry').addEventListener('change', ()=>{ if(document.getElementById('personQuery').value.trim()) runSearch(); });
document.getElementById('personQuery').addEventListener('keydown', e=>{ if(e.key==='Enter') runSearch(); });

// ── Auto-enrich all cards after search ───────────────────
async function autoEnrichCard(r) {
  const id = r._id;
  if (!id || !r.link) return;

  const loadEl = document.getElementById(id + '-loading');
  const qcEl   = document.getElementById(id + '-qc');

  // Already has contact info — show it immediately, hide loader
  if (r.phone || r.email || r.whatsapp) {
    if (loadEl) loadEl.remove();
    if (qcEl) qcEl.innerHTML = quickContactHtml(r);
    const slot = document.getElementById(id + '-slot');
    if (slot && !slot.innerHTML.trim()) slot.innerHTML = renderDetailsHtml(r, r.link);
    return;
  }

  try {
    const res  = await fetch('/api/enrich?url=' + encodeURIComponent(r.link) + (r.country ? '&country=' + encodeURIComponent(r.country) : ''));
    const data = await res.json();
    if (loadEl) loadEl.remove();
    if (!data.success) return;

    // Merge into registry
    const entry = cardRegistry[id];
    if (entry) Object.assign(entry, {
      phone: data.phone, whatsapp: data.whatsapp, email: data.email,
      address: data.address, keyPeople: data.keyPeople || [],
      employeeCount: data.employeeCount, companySize: data.companySize, founded: data.founded
    });

    // Quick-contact buttons — most visible, shown first
    if (qcEl && (data.email || data.phone || data.whatsapp)) {
      qcEl.innerHTML = quickContactHtml(data);
    }

    // Full details grid below
    const slot = document.getElementById(id + '-slot');
    if (slot) {
      const html = renderDetailsHtml(data, r.link);
      if (html) slot.innerHTML = html;
    }
  } catch (_) {
    if (loadEl) loadEl.remove();
  }
}

async function autoEnrichAll() {
  // Tag companies the app already has permanent memory of (Company Brain)
  if (typeof annotateKnownCompanies === 'function') annotateKnownCompanies();
  const toEnrich = lastResults.filter(r =>
    r._id && r.link && r.type !== 'person' && r.category !== 'marketplace'
  );
  // Cards we don't auto-enrich (marketplace/directory listings) would otherwise
  // show a "Loading contact info…" spinner forever — clear those loaders now.
  lastResults
    .filter(r => r._id && (r.category === 'marketplace' || !r.link))
    .forEach(r => { const el = document.getElementById(r._id + '-loading'); if (el) el.remove(); });
  // Process in concurrent batches so all cards enrich quickly (instead of a slow
  // one-at-a-time trickle). 8 at a time keeps the browser/server responsive.
  const BATCH = 14;
  for (let i = 0; i < toEnrich.length; i += BATCH) {
    const batch = toEnrich.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(r => autoEnrichCard(r)));
  }
}

// ── Key People Lookup ────────────────────────────────────
async function loadKeyPeople(id, btn) {
  const r = cardRegistry[id];
  if (!r) return;
  const slot = document.getElementById(id + '-people');
  if (!slot) return;

  // Use the company name from the card title (strip common suffixes for cleaner query)
  const companyName = (r.title || '').replace(/\s*[-–|].*$/, '').trim() || r.title;

  btn.disabled = true;
  btn.textContent = '⏳ Searching…';
  slot.innerHTML = '';

  try {
    const resp = await fetch('/api/company-people?company=' + encodeURIComponent(companyName));
    const data = await resp.json();

    if (!data.people || data.people.length === 0) {
      slot.innerHTML = `<div class="people-panel" style="text-align:center">
        <div style="font-size:22px;margin-bottom:6px">🔍</div>
        <div style="font-size:12.5px;color:var(--text);font-weight:600;margin-bottom:3px">No key people found</div>
        <div style="font-size:11.5px;color:var(--muted);line-height:1.5">We couldn't identify named executives for this company from public sources. Try the company's LinkedIn or About page directly.</div>
      </div>`;
      btn.textContent = '👥 Find Key People';
      btn.disabled = false;
      return;
    }

    const chips = data.people.map(p => {
      const initials = (p.name || '?').split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();
      const isLinkedIn = /linkedin/i.test(p.source || '');
      const searchPersonBtn = `<button class="pc-btn" onclick="setMode('person');document.getElementById('personQuery').value=${JSON.stringify(p.name)};runSearch()">🔍 Search</button>`;
      const trustBtn = `<button class="pc-btn" onclick="runPersonTrustCheck(${JSON.stringify(p.name)}, ${JSON.stringify(companyName)}, this)">🛡 Check</button>`;
      const sourceLink = p.sourceUrl
        ? `<a class="pc-source-link" href="${escapeHtml(p.sourceUrl)}" target="_blank" rel="noopener">${isLinkedIn ? '🔗 LinkedIn' : '🌐 ' + escapeHtml(p.source)} ↗</a>`
        : `<span class="pc-source-link">${escapeHtml(p.source)}</span>`;
      return `<div class="person-chip">
        <div class="pc-top">
          <div class="pc-avatar">${escapeHtml(initials)}</div>
          <div class="pc-id">
            <div class="pc-name">${escapeHtml(p.name)}</div>
            <div class="pc-title">${escapeHtml(p.title)}</div>
          </div>
        </div>
        <div class="pc-source">${sourceLink}</div>
        <div class="pc-actions">${searchPersonBtn}${trustBtn}</div>
      </div>`;
    }).join('');

    slot.innerHTML = `<div class="people-panel">
      <div class="people-panel-head">
        <span class="people-panel-icon">👥</span>
        <div>
          <h4>Key People at ${escapeHtml(companyName)}</h4>
          <span class="people-panel-count">${data.people.length} ${data.people.length===1?'person':'people'} found</span>
        </div>
      </div>
      <div class="people-grid">${chips}</div>
    </div>`;

    btn.textContent = '👥 Key People ✓';
  } catch(err) {
    slot.innerHTML = `<p style="font-size:12.5px;color:#f87171;margin:8px 0 0">Error: ${escapeHtml(err.message)}</p>`;
    btn.textContent = '👥 Find Key People';
    btn.disabled = false;
  }
}

async function runPersonTrustCheck(personName, companyName, btn) {
  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    const url = '/api/trust-check?url=' + encodeURIComponent('https://www.google.com/search?q=' + encodeURIComponent(personName)) +
                '&name=' + encodeURIComponent(companyName);
    const resp = await fetch(url);
    const data = await resp.json();
    const panel = btn.closest('.person-chip');
    if (!panel) return;
    let existing = panel.querySelector('.mini-trust');
    if (!existing) { existing = document.createElement('div'); existing.className = 'mini-trust'; panel.appendChild(existing); }
    const color = data.score >= 70 ? '#34d399' : data.score >= 40 ? '#fbbf24' : '#f87171';
    const flagged = (data.findings || []).filter(f => f.type === 'danger' || f.type === 'warn');
    existing.innerHTML = `<div style="margin-top:6px;font-size:11px;color:${color};font-weight:600">Trust score: ${data.score}/100</div>` +
      (flagged.length ? flagged.map(f=>`<div style="font-size:10.5px;color:#f87171;margin-top:2px">${escapeHtml(f.text)}</div>`).join('') : `<div style="font-size:10.5px;color:#34d399;margin-top:2px">✅ No issues found</div>`);
    btn.textContent = '🛡 Check';
    btn.disabled = false;
  } catch(e) {
    btn.textContent = '🛡 Check'; btn.disabled = false;
  }
}

// ── Trust Check ──────────────────────────────────────────
async function runTrustCheck(id, btn){
  const r = cardRegistry[id];
  if(!r) return;
  const slot = document.getElementById(id + '-trust');

  btn.disabled = true;
  btn.textContent = '🔍 Checking…';
  slot.innerHTML = '';

  try{
    const params = new URLSearchParams();
    if(r.link)  params.set('url', r.link);
    if(r.title) params.set('name', r.title);
    if(r.keyPeople && r.keyPeople.length) params.set('people', JSON.stringify(r.keyPeople.map(p=>p.name)));
    const res = await fetch('/api/trust-check?' + params.toString());
    const data = await res.json();

    if(!res.ok || data.error){
      slot.innerHTML = `<div class="trust-panel"><div class="trust-finding danger">${escapeHtml(data.error||'Trust check failed.')}</div></div>`;
      btn.remove(); return;
    }

    const badgeHtml = `<span class="trust-badge ${escapeHtml(data.ratingClass)}">${escapeHtml(data.rating)}</span>`;
    const scoreHtml = data.score !== null ? `<div class="trust-score">Trust score: ${data.score}/100</div>` : '';

    const findingsHtml = (data.findings||[]).length
      ? `<div class="trust-findings">${data.findings.map(f=>`<div class="trust-finding ${escapeHtml(f.type)}">${escapeHtml(f.text)}</div>`).join('')}</div>`
      : '';

    let scamHtml = '';
    if(data.searchLinks && data.searchLinks.length){
      scamHtml = `<div class="trust-section-title">⚠️ Complaint / Scam Results</div>`
        + data.searchLinks.map(l=>`<div class="trust-link-item"><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.title)}</a>${l.snippet?`<div class="tl-snippet">${escapeHtml(l.snippet.slice(0,120))}…</div>`:''}</div>`).join('');
    }

    let reviewHtml = '';
    if(data.reviewLinks && data.reviewLinks.length){
      reviewHtml = `<div class="trust-section-title">⭐ Reviews &amp; Ratings</div>`
        + data.reviewLinks.map(l=>`<div class="trust-link-item"><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.title)}</a></div>`).join('');
    }

    // Per-person background check results
    let peopleHtml = '';
    if(data.peopleResults && data.peopleResults.length){
      peopleHtml = `<div class="trust-section-title">👤 Key People Background Check</div>`;
      peopleHtml += data.peopleResults.map(person => {
        const riskIcon = person.risk === 'flagged' ? '⚠️' : person.risk === 'clean' ? '✅' : 'ℹ️';
        const riskClass = person.risk === 'flagged' ? 'trust-warn' : person.risk === 'clean' ? 'trust-good' : 'trust-info';
        const personFindings = (person.findings || []).map(f => {
          const linksHtml = (f.links||[]).length
            ? `<div class="trust-links">${f.links.map(l=>`<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.title)}</a>`).join('')}</div>`
            : '';
          return `<div class="trust-finding ${escapeHtml(f.type)}">${escapeHtml(f.text)}${linksHtml}</div>`;
        }).join('');
        return `<div class="person-check-block">
          <div class="person-check-header">
            <span class="trust-badge ${riskClass}" style="font-size:11px;padding:3px 10px;">${riskIcon} ${escapeHtml(person.name)}</span>
          </div>
          <div style="margin-top:6px;">${personFindings}</div>
        </div>`;
      }).join('');
    }

    const disclaimer = `<div class="trust-disclaimer">⚠️ This is an automated check — not a legal or financial assessment. Always verify independently before doing business.</div>`;

    slot.innerHTML = `<div class="trust-panel">${badgeHtml}${scoreHtml}${findingsHtml}${scamHtml}${reviewHtml}${peopleHtml}${disclaimer}</div>`;
    btn.remove();
  }catch(err){
    slot.innerHTML = `<div class="trust-panel"><div class="trust-finding danger">Trust check failed: ${escapeHtml(err.message)}</div></div>`;
    btn.remove();
  }
}

// ── Image / Card tab ─────────────────────────────────────
let currentImageType = 'product';
let currentImageFile = null;

function setImageType(type){
  currentImageType = type;
  ['product','card','person','company'].forEach(t => {
    const el = document.getElementById('itc-'+t);
    if(el) el.classList.toggle('selected', t === type);
  });
  const zone = document.getElementById('uploadZone');
  if(type === 'product'){
    zone.querySelector('.uz-label').textContent = 'Click to upload a photo of the product';
    zone.querySelector('.uz-hint').textContent = 'AI identifies what it is, then searches suppliers automatically';
  } else if(type === 'card'){
    zone.querySelector('.uz-label').textContent = 'Click to upload a business card image';
    zone.querySelector('.uz-hint').textContent = 'We\'ll extract name, phone, email, company & address automatically';
  } else if(type === 'person'){
    zone.querySelector('.uz-label').textContent = 'Click to upload a photo of the person';
    zone.querySelector('.uz-hint').textContent = 'Opens Google Lens reverse image search';
  } else {
    zone.querySelector('.uz-label').textContent = 'Click to upload a company photo or logo';
    zone.querySelector('.uz-hint').textContent = 'Opens Google Lens reverse image search';
  }
  if(currentImageFile) handleImageFile(currentImageFile);
}

function handleImageDrop(e){
  e.preventDefault();
  document.getElementById('uploadZone').classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if(file && file.type.startsWith('image/')) handleImageFile(file);
}

function handleImageFile(file){
  if(!file) return;
  currentImageFile = file;
  const area = document.getElementById('imgResultArea');

  const objectUrl = URL.createObjectURL(file);
  const previewHtml = `<div class="img-preview-wrap"><img src="${objectUrl}" alt="preview"></div>`;

  if(currentImageType === 'product'){
    area.innerHTML = previewHtml + `
      <div class="ocr-status" id="idStatus"><span class="loading-dot"></span> AI is identifying the product…</div>
      <div class="ocr-result" id="idResult"></div>`;
    identifyProductImage(file);
  } else if(currentImageType === 'card'){
    area.innerHTML = previewHtml + `
      <div class="ocr-status" id="ocrStatus">Preparing OCR engine…</div>
      <div class="ocr-bar-wrap"><div class="ocr-bar-fill" id="ocrBar"></div></div>
      <div class="ocr-result" id="ocrResult"></div>`;
    runBusinessCardOCR(file);
  } else {
    const label = currentImageType === 'person' ? 'person' : 'company / logo';
    area.innerHTML = previewHtml + `
      <div class="ocr-actions">
        <button class="lens-btn" onclick="openGoogleLens()">🔍 Search this ${label} on Google Lens</button>
      </div>
      <div class="ocr-status" style="margin-top:8px;">Google Lens will open in a new tab — it can identify people, logos, and companies from photos.</div>`;
  }
}

function loadTesseract(){
  return new Promise((resolve, reject) => {
    if(window.Tesseract){ resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/tesseract.js@v4.1.1/dist/tesseract.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load OCR engine. Check your internet connection.'));
    document.head.appendChild(s);
  });
}

async function runBusinessCardOCR(file){
  const statusEl = document.getElementById('ocrStatus');
  const barEl    = document.getElementById('ocrBar');
  const resultEl = document.getElementById('ocrResult');
  try{
    await loadTesseract();
    statusEl.textContent = 'Loading language data…';
    const worker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if(m.status === 'recognizing text'){
          const pct = Math.round((m.progress || 0) * 100);
          barEl.style.width = pct + '%';
          statusEl.textContent = `Reading text… ${pct}%`;
        } else if(m.status){
          statusEl.textContent = m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…';
        }
      }
    });
    const { data: { text } } = await worker.recognize(file);
    await worker.terminate();
    barEl.style.width = '100%';
    statusEl.textContent = 'Done ✓';
    const parsed = parseBusinessCard(text);
    resultEl.innerHTML = renderBusinessCardResult(parsed);
  } catch(err){
    statusEl.textContent = '⚠ ' + err.message;
    barEl.style.width = '0%';
  }
}

function parseBusinessCard(text){
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 1);

  const emailMatch = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  const email = emailMatch ? emailMatch[0] : null;

  const webMatch = text.match(/(?:https?:\/\/|www\.)[^\s,<>]+/i);
  const website = webMatch ? webMatch[0] : null;

  const phoneMatches = [...text.matchAll(/(\+?[\d][\d\s().\-]{5,17}\d)/g)].map(m => m[1].trim());
  const phone = phoneMatches.find(p => { const d = p.replace(/\D/g,''); return d.length >= 7 && d.length <= 15; }) || null;

  const companyRe = /\b(Ltd\.?|Limited|Inc\.?|Corp\.?|LLC|L\.L\.C|Co\.|Group|GmbH|S\.A\.?|B\.V\.|PLC|Industries|Solutions|Technologies|Tech|Services|Trading|International|Global|Holdings|Consulting)\b/i;
  const company = lines.find(l => companyRe.test(l)) || null;

  const nameRe = /^([A-Z][a-zÀ-ÿ'\-]{1,20}(\s[A-Z][a-zÀ-ÿ'\-]{1,20}){1,3})$/;
  const name = lines.find(l => nameRe.test(l)) || null;

  const titleRe = /\b(CEO|CTO|COO|CFO|CMO|Founder|Co[\-\s]Founder|President|Vice President|VP|Director|Manager|Executive|Officer|Engineer|Sales|Marketing|Account|Business Development|Partner|Principal|Head of|Lead)\b/i;
  const title = lines.find(l => titleRe.test(l) && l !== name) || null;

  const addrRe = /\d{1,5}[^,\n]{3,40}(Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Blvd|Boulevard|Lane|Drive|Suite|Floor|Building)[^,\n]{0,40},[^\n]{3,80}/i;
  const addrMatch = text.match(addrRe);
  const address = addrMatch ? addrMatch[0].trim() : null;

  return { name, title, company, phone, email, website, address, rawText: text };
}

function renderBusinessCardResult(p){
  const fields = [];
  if(p.name)    fields.push(['👤 Name',    escapeHtml(p.name)]);
  if(p.title)   fields.push(['🏷 Title',   escapeHtml(p.title)]);
  if(p.company) fields.push(['🏢 Company', escapeHtml(p.company)]);
  if(p.phone)   fields.push(['📞 Phone',   escapeHtml(p.phone)]);
  if(p.email)   fields.push(['✉️ Email',   `<a href="mailto:${escapeHtml(p.email)}">${escapeHtml(p.email)}</a>`]);
  if(p.website) fields.push(['🌐 Website', `<a href="${escapeHtml(p.website.startsWith('http') ? p.website : 'https://'+p.website)}" target="_blank" rel="noopener">${escapeHtml(p.website)}</a>`]);
  if(p.address) fields.push(['📍 Address', escapeHtml(p.address)]);

  const noResults = !fields.length;
  const grid = noResults
    ? `<div class="detail-note">No contact details could be extracted — try a clearer or higher-resolution photo.</div>`
    : `<div class="details-grid">${fields.map(([l,v]) => `<div class="detail-row"><span class="detail-label">${l}</span><span class="detail-value">${v}</span></div>`).join('')}</div>`;

  const searchBtnHtml = p.company
    ? `<button class="lens-btn-secondary" onclick="setMode('company');document.getElementById('companyQuery').value=${JSON.stringify(p.company)};runSearch()">🔎 Search this company</button>`
    : p.name
    ? `<button class="lens-btn-secondary" onclick="setMode('person');document.getElementById('personQuery').value=${JSON.stringify(p.name)};runSearch()">🔎 Search this person</button>`
    : '';

  const rawToggle = `<details style="margin-top:10px;"><summary style="cursor:pointer;font-size:12px;color:var(--muted);">Show raw OCR text</summary><pre style="font-size:11px;color:var(--muted);white-space:pre-wrap;margin-top:6px;">${escapeHtml(p.rawText)}</pre></details>`;

  return `<div class="ocr-result">${grid}${searchBtnHtml ? `<div class="ocr-actions" style="margin-top:10px;">${searchBtnHtml}</div>` : ''}${rawToggle}</div>`;
}

async function openGoogleLens(){
  if(!currentImageFile){ alert('No image selected.'); return; }

  // Method 1: Upload via FormData POST to Google Lens (works on most desktop browsers)
  try {
    const form = new FormData();
    form.append('encoded_image', currentImageFile, currentImageFile.name);
    const area = document.getElementById('imgResultArea');
    const statusDiv = area.querySelector('.ocr-status') || area.appendChild(Object.assign(document.createElement('div'), {className:'ocr-status', textContent:'Opening Google Lens…'}));
    statusDiv.textContent = 'Uploading to Google Lens…';

    const resp = await fetch('https://lens.google.com/upload?ep=gsbubb&hl=en&re=df', {
      method: 'POST', body: form, mode: 'no-cors'
    });
    // no-cors means we can't read the response but the POST goes through;
    // Google Lens will have received the image — open the results page
    window.open('https://lens.google.com/', '_blank');
    statusDiv.textContent = '✅ Opened Google Lens in a new tab. If it shows an empty search, use the upload button there to re-upload your image.';
    return;
  } catch(_) {}

  // Method 2: Hidden form submit fallback
  try {
    const dt = new DataTransfer();
    dt.items.add(currentImageFile);
    document.getElementById('gLensFile').files = dt.files;
    document.getElementById('gLensForm').submit();
    return;
  } catch(_) {}

  // Method 3: Last resort — open Google Lens and tell user to upload manually
  window.open('https://lens.google.com/', '_blank');
  const area = document.getElementById('imgResultArea');
  area.insertAdjacentHTML('beforeend', `<div class="ocr-status" style="color:var(--accent);margin-top:8px;">📷 Google Lens opened in a new tab. Click the camera icon there and upload your image manually.</div>`);
}

renderChips();

// ── AI Analysis ──────────────────────────────────────────────────────────────

let aiPanelCollapsed = false;

function showAILoading() {
  const wrap = document.getElementById('aiPanelWrap');
  wrap.style.display = 'block';
  wrap.innerHTML = `
    <div class="ai-panel" style="max-width:960px;margin:0 auto 24px;padding:18px 28px;">
      <div class="ai-loading">
        <div class="ai-spinner"></div>
        <span>AI is analyzing your results…</span>
      </div>
    </div>`;
}

function hideAIPanel() {
  const wrap = document.getElementById('aiPanelWrap');
  wrap.style.display = 'none';
  wrap.innerHTML = '';
}

async function runAIAnalysis(query, results, mode) {
  showAILoading();
  try {
    const res = await fetch('/api/ai-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, results, mode })
    });
    const data = await res.json();
    if (data.error) { hideAIPanel(); return; }
    renderAIPanel(data.analysis, data.provider, query, mode);
    highlightTopPicks(data.analysis.topPicks || []);
  } catch(e) {
    hideAIPanel();
  }
}

function renderAIPanel(a, provider, query, mode) {
  const wrap = document.getElementById('aiPanelWrap');
  if (!a) { wrap.style.display = 'none'; return; }

  const providerLabel = provider === 'openai' ? 'GPT-4o' : 'Gemini';
  const providerIcon  = provider === 'openai'
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.28 9.28a5.67 5.67 0 0 0-.49-4.65 5.74 5.74 0 0 0-6.17-2.75A5.67 5.67 0 0 0 11.35 0a5.74 5.74 0 0 0-5.48 3.98 5.67 5.67 0 0 0-3.79 2.75 5.74 5.74 0 0 0 .71 6.73 5.67 5.67 0 0 0 .49 4.65 5.74 5.74 0 0 0 6.17 2.75A5.67 5.67 0 0 0 12.65 24a5.74 5.74 0 0 0 5.48-3.98 5.67 5.67 0 0 0 3.79-2.75 5.74 5.74 0 0 0-.71-6.73l.07-.26z"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`;

  const insights = (a.keyInsights || []).map(i =>
    `<div class="ai-insight"><div class="ai-insight-dot"></div><span>${escapeHtml(i)}</span></div>`
  ).join('');

  const suggestions = (a.suggestions || []).map(s =>
    `<button class="ai-suggestion" onclick="aiSuggest('${escapeHtml(s)}', '${mode}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      ${escapeHtml(s)}
    </button>`
  ).join('');

  const warning = a.warning
    ? `<div class="ai-warning">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" flex-shrink="0" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>${escapeHtml(a.warning)}</span>
       </div>`
    : '';

  const bodyHtml = `
    <p class="ai-summary">${escapeHtml(a.summary || '')}</p>
    <div class="ai-grid">
      <div>
        <div class="ai-section-title">Key Insights</div>
        ${insights || '<p style="color:var(--muted);font-size:13px">No insights available.</p>'}
      </div>
      <div>
        <div class="ai-section-title">Smarter Follow-up Searches</div>
        <div style="display:flex;flex-direction:column;gap:7px;">
          ${suggestions || '<p style="color:var(--muted);font-size:13px">No suggestions.</p>'}
        </div>
      </div>
    </div>
    ${warning}`;

  wrap.style.display = 'block';
  wrap.innerHTML = `
    <div class="ai-panel">
      <div class="ai-header">
        <div class="ai-title">
          <div class="ai-logo" aria-hidden="true">${providerIcon}</div>
          AI Intelligence · <em style="font-style:normal;color:#a78bfa">${escapeHtml(query)}</em>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="ai-provider-badge ${provider}">${providerLabel}</span>
          <button class="ai-collapse-btn" onclick="toggleAIPanel(this)" aria-label="Toggle AI panel">
            ${aiPanelCollapsed ? 'Show ▾' : 'Hide ▴'}
          </button>
        </div>
      </div>
      <div id="aiPanelBody">${aiPanelCollapsed ? '' : bodyHtml}</div>
    </div>`;

  if (aiPanelCollapsed) document.getElementById('aiPanelBody').style.display = 'none';
  wrap._bodyHtml = bodyHtml;
}

function toggleAIPanel(btn) {
  aiPanelCollapsed = !aiPanelCollapsed;
  const body = document.getElementById('aiPanelBody');
  const wrap = document.getElementById('aiPanelWrap');
  if (aiPanelCollapsed) {
    body.style.display = 'none';
    btn.textContent = 'Show ▾';
  } else {
    body.innerHTML = wrap._bodyHtml || '';
    body.style.display = '';
    btn.textContent = 'Hide ▴';
  }
}

function highlightTopPicks(indices) {
  const cards = document.querySelectorAll('.card');
  indices.forEach(i => {
    const card = cards[i - 1];
    if (!card) return;
    const h3 = card.querySelector('h3');
    if (h3 && !h3.querySelector('.ai-top-pick-badge')) {
      h3.insertAdjacentHTML('beforeend', '<span class="ai-top-pick-badge">✦ AI Pick</span>');
    }
    card.style.borderColor = 'rgba(139,92,246,.35)';
  });
}

function aiSuggest(query, mode) {
  if (mode === 'product' || mode === 'company' || mode === 'person') {
    const inputId = mode === 'product' ? 'query' : mode === 'company' ? 'companyQuery' : 'personQuery';
    const input = document.getElementById(inputId);
    if (input) {
      input.value = query;
      input.focus();
    }
    setMode(mode);
    setTimeout(() => runSearch(), 100);
  } else if (mode === 'stock') {
    const input = document.getElementById('stockQuery');
    if (input) input.value = query;
    setMode('stock');
    setTimeout(() => runStockSearch(), 100);
  }
}

// ── UI/UX Pro Max Helpers ─────────────────────────────────────────────────────

function buildSkeleton(count){
  const cards = Array.from({length:count}, () => `
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:60%;height:14px;margin-bottom:14px"></div>
      <div class="skeleton-line" style="width:90%;height:11px"></div>
      <div class="skeleton-line" style="width:75%;height:11px"></div>
      <div class="skeleton-line" style="width:50%;height:11px;margin-top:16px"></div>
    </div>`).join('');
  return `<div class="skeleton-wrap">${cards}</div>`;
}

function buildErrorState(msg, retryFn){
  const id = 'err-retry-' + Date.now();
  setTimeout(() => {
    const btn = document.getElementById(id);
    if(btn) btn.onclick = retryFn;
  }, 0);
  return `<div class="state-error">
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <p>Search failed: ${escapeHtml(msg)}<br><span style="font-size:12px;color:var(--muted)">Check your connection or try a different query.</span></p>
    <button id="${id}" class="state-retry">↺ Try Again</button>
  </div>`;
}

function staggerCards(container){
  const cards = container.querySelectorAll('.card');
  cards.forEach((card, i) => {
    card.classList.add('card-animate');
    card.style.animationDelay = `${i * 40}ms`;
  });
}

// ── Interactive Globe ─────────────────────────────────────────────────────────
(function(){
  const canvas = document.getElementById('globeCanvas');
  if(!canvas) return;

  // Resize canvas to parent
  const wrap = canvas.parentElement;
  const SIZE = wrap.offsetWidth || 400;
  canvas.width = SIZE; canvas.height = SIZE;
  const R = SIZE / 2 - 2;

  const ctx = canvas.getContext('2d');
  const proj = d3.geoOrthographic()
    .scale(R)
    .translate([SIZE/2, SIZE/2])
    .clipAngle(90);
  const path = d3.geoPath(proj, ctx);
  const sphere = { type:'Sphere' };

  // ISO numeric → display name
  const ISO = {
    4:'Afghanistan',8:'Albania',12:'Algeria',24:'Angola',32:'Argentina',
    36:'Australia',40:'Austria',50:'Bangladesh',56:'Belgium',64:'Bhutan',
    68:'Bolivia',76:'Brazil',100:'Bulgaria',104:'Myanmar',116:'Cambodia',
    120:'Cameroon',124:'Canada',144:'Sri Lanka',152:'Chile',156:'China',
    170:'Colombia',178:'Congo',180:'DRC',188:'Costa Rica',191:'Croatia',
    192:'Cuba',196:'Cyprus',203:'Czech Republic',208:'Denmark',
    214:'Dominican Republic',218:'Ecuador',818:'Egypt',222:'El Salvador',
    231:'Ethiopia',246:'Finland',250:'France',266:'Gabon',276:'Germany',
    288:'Ghana',300:'Greece',320:'Guatemala',332:'Haiti',340:'Honduras',
    348:'Hungary',356:'India',360:'Indonesia',364:'Iran',368:'Iraq',
    372:'Ireland',376:'Israel',380:'Italy',384:'Ivory Coast',388:'Jamaica',
    392:'Japan',398:'Kazakhstan',400:'Jordan',404:'Kenya',410:'South Korea',
    408:'North Korea',414:'Kuwait',418:'Laos',422:'Lebanon',430:'Liberia',
    434:'Libya',484:'Mexico',504:'Morocco',508:'Mozambique',516:'Namibia',
    524:'Nepal',528:'Netherlands',554:'New Zealand',558:'Nicaragua',
    566:'Nigeria',578:'Norway',512:'Oman',586:'Pakistan',591:'Panama',
    604:'Peru',608:'Philippines',616:'Poland',634:'Qatar',642:'Romania',
    643:'Russia',646:'Rwanda',682:'Saudi Arabia',686:'Senegal',
    694:'Sierra Leone',703:'Slovakia',706:'Somalia',710:'South Africa',
    728:'South Sudan',724:'Spain',729:'Sudan',752:'Sweden',756:'Switzerland',
    760:'Syria',158:'Taiwan',762:'Tajikistan',834:'Tanzania',764:'Thailand',
    768:'Togo',788:'Tunisia',792:'Turkey',800:'Uganda',804:'Ukraine',
    784:'UAE',826:'UK',840:'USA',858:'Uruguay',860:'Uzbekistan',
    862:'Venezuela',704:'Vietnam',887:'Yemen',894:'Zambia',716:'Zimbabwe',
    702:'Singapore',458:'Malaysia',108:'Burundi',854:'Burkina Faso',
    140:'Central African Republic',148:'Chad',174:'Comoros',214:'DR Congo',
    232:'Eritrea',270:'Gambia',324:'Guinea',624:'Guinea-Bissau',
    426:'Lesotho',454:'Malawi',466:'Mali',478:'Mauritania',516:'Namibia',
    562:'Niger',706:'Somalia',736:'Sudan',748:'Eswatini'
  };

  // Countries the dropdowns support (map display name → option value)
  const SUPPORTED = {
    'China':'China','India':'India','Israel':'Israel','Thailand':'Thailand',
    'USA':'USA','Vietnam':'Vietnam','Bangladesh':'Bangladesh','Taiwan':'Taiwan',
    'Turkey':'Turkey','Germany':'Germany','Netherlands':'Netherlands','UAE':'UAE',
    'Poland':'Poland','Brazil':'Brazil','Australia':'Australia','Spain':'Spain',
    'Singapore':'Singapore','South Africa':'South Africa','Nigeria':'Nigeria',
    'Kenya':'Kenya','Egypt':'Egypt','Ethiopia':'Ethiopia','Ghana':'Ghana',
    'Tanzania':'Tanzania','Morocco':'Morocco','Algeria':'Algeria','Angola':'Angola',
    'Ivory Coast':'Ivory Coast','Cameroon':'Cameroon','Uganda':'Uganda',
    'Mozambique':'Mozambique','Zimbabwe':'Zimbabwe','Zambia':'Zambia',
    'Senegal':'Senegal','Tunisia':'Tunisia','DRC':'DRC',
    'South Korea':'South Korea','Japan':'Japan','Indonesia':'Indonesia',
    'Malaysia':'Malaysia','Philippines':'Philippines','Pakistan':'Pakistan',
    'Saudi Arabia':'Saudi Arabia','France':'France','Italy':'Italy',
    'UK':'UK','Russia':'Russia','Mexico':'Mexico','Canada':'Canada',
    'Argentina':'Argentina','Colombia':'Colombia','Chile':'Chile','Peru':'Peru',
    'Vietnam':'Vietnam','Iran':'Iran','Iraq':'Iraq','Kazakhstan':'Kazakhstan',
    'Ukraine':'Ukraine','Romania':'Romania','Czech Republic':'Czech Republic',
    'Hungary':'Hungary','Sweden':'Sweden','Norway':'Norway','Finland':'Finland',
    'Belgium':'Belgium','Switzerland':'Switzerland','Austria':'Austria',
    'Greece':'Greece','Portugal':'Portugal','Israel':'Israel',
    'New Zealand':'New Zealand','South Africa':'South Africa'
  };

  let world = null;
  let countries = [];
  let hoveredId = null;
  let selectedId = null;
  let rotating = true;
  let rotateTimer = null;
  const rotation = [20, -25, 0];

  // Drag state
  let dragStart = null;
  let rotStart = null;

  function draw(){
    ctx.clearRect(0,0,SIZE,SIZE);

    // Atmosphere glow
    const atm = ctx.createRadialGradient(SIZE/2,SIZE/2,R*.92,SIZE/2,SIZE/2,R*1.08);
    atm.addColorStop(0,'rgba(37,99,235,.0)');
    atm.addColorStop(1,'rgba(37,99,235,.12)');
    ctx.beginPath(); ctx.arc(SIZE/2,SIZE/2,R*1.06,0,2*Math.PI);
    ctx.fillStyle=atm; ctx.fill();

    // Ocean
    const ocean = ctx.createRadialGradient(SIZE*.35,SIZE*.3,0,SIZE/2,SIZE/2,R);
    ocean.addColorStop(0,'#dbeafe');
    ocean.addColorStop(.5,'#bfdbfe');
    ocean.addColorStop(1,'#93c5fd');
    ctx.beginPath(); path(sphere); ctx.fillStyle=ocean; ctx.fill();

    // Graticule
    const grat = d3.geoGraticule()();
    ctx.beginPath(); path(grat);
    ctx.strokeStyle='rgba(37,99,235,.12)'; ctx.lineWidth=.5; ctx.stroke();

    // Countries
    if(world){
      for(const f of countries){
        const id = +f.id;
        const isHov = id === hoveredId;
        const isSel = id === selectedId;
        const inSupport = SUPPORTED[ISO[id]];

        ctx.beginPath(); path(f);
        if(isSel){
          ctx.fillStyle='rgba(37,99,235,.85)';
        } else if(isHov && inSupport){
          ctx.fillStyle='rgba(37,99,235,.45)';
        } else if(isHov){
          ctx.fillStyle='rgba(100,116,139,.35)';
        } else if(inSupport){
          ctx.fillStyle='rgba(37,99,235,.28)';
        } else {
          ctx.fillStyle='rgba(203,213,225,.9)';
        }
        ctx.fill();

        ctx.beginPath(); path(f);
        ctx.strokeStyle = isSel ? 'rgba(37,99,235,.95)'
                        : isHov ? 'rgba(37,99,235,.7)'
                        : inSupport ? 'rgba(37,99,235,.3)'
                        : 'rgba(71,85,105,.4)';
        ctx.lineWidth = isSel ? 1.5 : isHov ? 1 : .4;
        ctx.stroke();
      }
    }

    // Sphere border
    ctx.beginPath(); path(sphere);
    ctx.strokeStyle='rgba(37,99,235,.25)'; ctx.lineWidth=1.5; ctx.stroke();

    // Shine
    const shine = ctx.createRadialGradient(SIZE*.35,SIZE*.28,0,SIZE*.4,SIZE*.35,R*.55);
    shine.addColorStop(0,'rgba(255,255,255,.45)');
    shine.addColorStop(1,'rgba(255,255,255,0)');
    ctx.beginPath(); path(sphere); ctx.fillStyle=shine; ctx.fill();
  }

  function startAutoRotate(){
    if(rotateTimer) return;
    rotateTimer = d3.timer(elapsed => {
      if(!rotating){ rotateTimer.stop(); rotateTimer=null; return; }
      rotation[0] += .018;
      proj.rotate(rotation);
      draw();
    });
  }

  function stopAutoRotate(){
    rotating = false;
    if(rotateTimer){ rotateTimer.stop(); rotateTimer=null; }
  }

  function getCountryAt(x, y){
    if(!world) return null;
    const pos = proj.invert([x, y]);
    if(!pos) return null;
    for(const f of countries){
      if(d3.geoContains(f, pos)) return f;
    }
    return null;
  }

  // Mouse / touch events
  canvas.addEventListener('mouseenter', () => { rotating = false; });
  canvas.addEventListener('mouseleave', () => {
    hoveredId = null;
    document.getElementById('globeTooltip').style.opacity='0';
    rotating = true; startAutoRotate(); draw();
  });

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const x = sx * (SIZE / rect.width), y = sy * (SIZE / rect.height);

    if(dragStart){
      const dx = sx - dragStart[0], dy = sy - dragStart[1];
      rotation[0] = rotStart[0] + dx * .35;
      rotation[1] = Math.max(-60, Math.min(60, rotStart[1] - dy * .35));
      proj.rotate(rotation);
      draw(); return;
    }

    const f = getCountryAt(x, y);
    const newId = f ? +f.id : null;
    if(newId !== hoveredId){ hoveredId = newId; draw(); }

    const tip = document.getElementById('globeTooltip');
    if(f && ISO[+f.id]){
      const name = ISO[+f.id];
      const sup = SUPPORTED[name];
      tip.textContent = sup ? `📍 ${name} — click to select` : `${name}`;
      tip.style.opacity='1';
      canvas.style.cursor = sup ? 'pointer' : 'default';
    } else {
      tip.style.opacity='0';
      canvas.style.cursor = dragStart ? 'grabbing' : 'grab';
    }
  });

  canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect();
    dragStart = [e.clientX - rect.left, e.clientY - rect.top];
    rotStart = [...rotation];
    stopAutoRotate();
  });

  window.addEventListener('mouseup', () => { dragStart = null; });

  canvas.addEventListener('click', e => {
    if(dragStart && (Math.abs(e.movementX)>3 || Math.abs(e.movementY)>3)) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (SIZE/rect.width);
    const y = (e.clientY - rect.top)  * (SIZE/rect.height);
    const f = getCountryAt(x, y);
    if(!f) return;
    const name = ISO[+f.id];
    if(!name || !SUPPORTED[name]) return;
    selectedId = +f.id;
    draw();
    selectCountryInDropdowns(name);
    showGlobeToast('📍 ' + name + ' selected');
  });

  // Touch support
  let lastTouch = null;
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    lastTouch = [t.clientX - rect.left, t.clientY - rect.top];
    rotStart = [...rotation];
    stopAutoRotate();
  }, {passive:false});

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if(!lastTouch) return;
    const t = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const cx = t.clientX - rect.left, cy = t.clientY - rect.top;
    rotation[0] = rotStart[0] + (cx - lastTouch[0]) * .35;
    rotation[1] = Math.max(-60, Math.min(60, rotStart[1] - (cy - lastTouch[1]) * .35));
    proj.rotate(rotation);
    draw();
  }, {passive:false});

  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    if(e.changedTouches.length === 1){
      const t = e.changedTouches[0];
      const rect = canvas.getBoundingClientRect();
      const x = (t.clientX - rect.left) * (SIZE/rect.width);
      const y = (t.clientY - rect.top)  * (SIZE/rect.height);
      const f = getCountryAt(x, y);
      if(f && ISO[+f.id] && SUPPORTED[ISO[+f.id]]){
        selectedId = +f.id;
        draw();
        selectCountryInDropdowns(ISO[+f.id]);
        showGlobeToast('📍 ' + ISO[+f.id] + ' selected');
      }
    }
    lastTouch = null;
    rotating = true; startAutoRotate();
  }, {passive:false});

  function selectCountryInDropdowns(name){
    ['country','companyCountry','personCountry','stockCountry'].forEach(id => {
      const sel = document.getElementById(id);
      if(!sel) return;
      for(const opt of sel.options){
        if(opt.value === name || opt.value.startsWith(name.split(' ')[0])){
          sel.value = opt.value; break;
        }
      }
    });
  }

  function showGlobeToast(msg){
    const old = document.querySelector('.globe-country-toast');
    if(old) old.remove();
    const t = document.createElement('div');
    t.className='globe-country-toast'; t.textContent=msg;
    document.body.appendChild(t);
    setTimeout(()=>{ t.style.transition='opacity .4s'; t.style.opacity='0';
      setTimeout(()=>t.remove(), 400); }, 2200);
  }

  // Load world data
  d3.json('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(data => {
    world = data;
    countries = topojson.feature(data, data.objects.countries).features;
    proj.rotate(rotation);
    draw();
    rotating = true; startAutoRotate();
  }).catch(()=>{
    // Draw empty globe if fetch fails
    proj.rotate(rotation); draw(); rotating=true; startAutoRotate();
  });
})();
