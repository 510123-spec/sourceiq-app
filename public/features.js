// ═══════════════ Saved suppliers (shared shortlist), Compare, Inquiry, Excel ═══════════════

// -- Saved suppliers: stored server-side (data/saved.json) so all users share one list --
const savedLinks = new Set();

async function loadSavedLinks(){
  try{
    const res = await fetch('/api/saved');
    const data = await res.json();
    savedLinks.clear();
    (data.saved || []).forEach(s => savedLinks.add(s.link));
    updateSavedCount((data.saved || []).length);
  }catch(e){}
}

function updateSavedCount(n){
  const el = document.getElementById('savedCount');
  if(el) el.textContent = n > 0 ? String(n) : '';
}

async function toggleSave(id, btn){
  const r = cardRegistry[id];
  if(!r) return;
  try{
    if(savedLinks.has(r.link)){
      const res = await fetch('/api/saved?link=' + encodeURIComponent(r.link), { method:'DELETE' });
      const data = await res.json();
      savedLinks.delete(r.link);
      btn.textContent = '☆'; btn.classList.remove('saved');
      updateSavedCount((data.saved||[]).length);
    }else{
      const res = await fetch('/api/saved', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          link:r.link, title:r.title, displayLink:r.displayLink, type:r.type,
          country:r.country || '', snippet:r.snippet,
          phone:r.phone || null, email:r.email || null,
          whatsapp:r.whatsapp || null, address:r.address || null
        })
      });
      const data = await res.json();
      savedLinks.add(r.link);
      btn.textContent = '★'; btn.classList.add('saved');
      updateSavedCount((data.saved||[]).length);
      runTrustOnSave(r); // background — no await, star responds instantly
    }
  }catch(e){}
}

async function showSavedPanel(){
  const old = document.getElementById('savedOverlay');
  if(old) old.remove();
  const res = await fetch('/api/saved');
  const data = await res.json();
  const list = data.saved || [];
  const rows = list.length ? list.map(s => `
    <div class="saved-item">
      <div class="saved-item-head">
        <a href="${escapeHtml(s.link)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>
        <button class="saved-remove" onclick="removeSaved('${escapeHtml(s.link)}')" title="Remove">✕</button>
      </div>
      <div class="saved-item-meta">
        ${s.type ? `<span>${escapeHtml(s.type)}</span>` : ''}
        ${s.country ? `<span>🌍 ${escapeHtml(s.country)}</span>` : ''}
        ${s.phone ? `<span>📞 ${escapeHtml(s.phone)}</span>` : ''}
        ${s.email ? `<span>✉️ <a href="mailto:${escapeHtml(s.email)}">${escapeHtml(s.email)}</a></span>` : ''}
        ${trustBadgeHtml(s.trust)}
      </div>
      <div class="pipeline-row">${pipelinePillsHtml(s)}</div>
      <textarea class="saved-notes" placeholder="Notes (e.g. quoted $6,400/MT, slow to reply)…"
        onblur="saveNotes('${escapeHtml(s.link)}', this)">${escapeHtml(s.notes || '')}</textarea>
    </div>`).join('') : '<p class="empty" style="padding:20px">Nothing saved yet — click the ☆ on any result card to add it here.</p>';

  const overlay = document.createElement('div');
  overlay.id = 'savedOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <h2>⭐ Saved Suppliers <span style="font-weight:400;font-size:13px;color:var(--muted)">(shared with your team)</span></h2>
        <div style="display:flex;gap:8px;align-items:center">
          ${list.length ? '<button class="saved-export-btn" onclick="exportSavedExcel()">📊 Export</button>' : ''}
          <button class="modal-close" onclick="document.getElementById('savedOverlay').remove()">✕</button>
        </div>
      </div>
      <div class="modal-body">${rows}</div>
    </div>`;
  overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// -- Trust badge for saved items (populated by the auto check at save time) --
function trustBadgeHtml(trust){
  if(!trust || !trust.rating) return '';
  const cls = trust.score == null ? 'trust-unknown'
    : trust.score >= 70 ? 'trust-good'
    : trust.score >= 40 ? 'trust-mid' : 'trust-bad';
  const scoreTxt = trust.score != null ? ' ' + trust.score + '/100' : '';
  return `<span class="saved-trust ${cls}" title="Automatic trust check run when saved">🛡 ${escapeHtml(trust.rating)}${scoreTxt}</span>`;
}

// -- Auto trust check: runs in the background when a supplier is starred, so the
//    shortlist accumulates risk signals without extra clicks --
async function runTrustOnSave(r){
  try{
    const params = new URLSearchParams({ url: r.link, name: r.title || '' });
    const res = await fetch('/api/trust-check?' + params.toString());
    const data = await res.json();
    if(!res.ok || data.demoMode || !data.rating) return;
    await fetch('/api/saved', {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ link: r.link, trust: { score: data.score, rating: data.rating } })
    });
    // If the Saved panel happens to be open, refresh it to show the new badge
    if(document.getElementById('savedOverlay')) showSavedPanel();
  }catch(e){}
}

// -- Excel export of the shared shortlist (incl. pipeline status + notes) --
function exportSavedExcel(){
  if(typeof XLSX === 'undefined'){ alert('Excel library still loading — try again in a second.'); return; }
  fetch('/api/saved').then(r => r.json()).then(data => {
    const list = data.saved || [];
    if(!list.length) return;
    const rows = list.map(s => ({
      'Company':  s.title || '',
      'Status':   (s.status || 'new').toUpperCase(),
      'Type':     s.type || '',
      'Country':  s.country || '',
      'Phone':    s.phone || '',
      'Email':    s.email || '',
      'WhatsApp': s.whatsapp || '',
      'Address':  s.address || '',
      'Trust':    s.trust ? (s.trust.rating + (s.trust.score != null ? ' (' + s.trust.score + '/100)' : '')) : '',
      'Notes':    s.notes || '',
      'Website':  s.link || '',
      'Saved on': (s.savedAt || '').slice(0, 10)
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0]).map(k => ({ wch: Math.min(50, Math.max(k.length, ...rows.map(r => String(r[k]).length))) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Shortlist');
    XLSX.writeFile(wb, 'sourceiq_shortlist_' + new Date().toISOString().slice(0,10) + '.xlsx');
  });
}

// -- HS code assistant (Trade tab): AI suggests the code from the product name --
async function findHSCode(btn){
  const product = document.getElementById('tradeProduct').value.trim();
  if(!product){ alert('Type a product name first, then I can suggest its HS code.'); return; }
  const hsInput = document.getElementById('tradeHS');
  btn.disabled = true; const orig = btn.textContent; btn.textContent = '✨ Looking up…';
  try{
    const res = await fetch('/api/hs-code?product=' + encodeURIComponent(product));
    const data = await res.json();
    if(!res.ok || !data.code) throw new Error(data.error || 'lookup failed');
    hsInput.value = data.code;
    let hint = document.getElementById('hsHint');
    if(!hint){
      hint = document.createElement('div');
      hint.id = 'hsHint';
      hint.className = 'hs-hint';
      hsInput.parentElement.appendChild(hint);
    }
    hint.textContent = '✓ ' + data.code + ' — ' + (data.description || '') +
      (data.alternative ? ' (alt: ' + data.alternative + ')' : '');
  }catch(e){
    alert('Could not look up the HS code: ' + e.message);
  }finally{
    btn.disabled = false; btn.textContent = orig;
  }
}

// -- Sourcing pipeline: each saved supplier moves through workflow stages --
const PIPELINE = [
  ['new',       '🆕 New'],
  ['contacted', '📨 Contacted'],
  ['quoted',    '💰 Quoted'],
  ['sampled',   '📦 Sampled'],
  ['ordered',   '✅ Ordered'],
  ['rejected',  '🚫 Rejected']
];

function pipelinePillsHtml(s){
  const current = s.status || 'new';
  return PIPELINE.map(([key, label]) =>
    `<button class="pipeline-pill${key === current ? ' active st-' + key : ''}"
      onclick="setSavedStatus('${escapeHtml(s.link)}', '${key}', this)">${label}</button>`).join('');
}

async function setSavedStatus(link, status, btn){
  try{
    await fetch('/api/saved', {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ link, status })
    });
    const row = btn.parentElement;
    row.querySelectorAll('.pipeline-pill').forEach(p => p.className = 'pipeline-pill');
    btn.className = 'pipeline-pill active st-' + status;
  }catch(e){}
}

async function saveNotes(link, ta){
  try{
    await fetch('/api/saved', {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ link, notes: ta.value })
    });
    ta.style.borderColor = '#059669';
    setTimeout(()=>{ ta.style.borderColor = ''; }, 800);
  }catch(e){}
}

async function removeSaved(link){
  await fetch('/api/saved?link=' + encodeURIComponent(link), { method:'DELETE' });
  savedLinks.delete(link);
  await loadSavedLinks();
  showSavedPanel();
}

// -- Compare: pick 2–4 results, view side by side --
const compareIds = new Set();

function toggleCompare(id, cb){
  if(cb.checked){
    if(compareIds.size >= 4){ cb.checked = false; return; }
    compareIds.add(id);
  }else{
    compareIds.delete(id);
  }
  updateCompareBar();
}

function updateCompareBar(){
  let bar = document.getElementById('compareBar');
  if(compareIds.size < 2){ if(bar) bar.remove(); return; }
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'compareBar';
    document.body.appendChild(bar);
  }
  bar.innerHTML = `<span>${compareIds.size} selected</span>
    <button onclick="showCompare()">⚖ Compare</button>
    <button class="cmp-clear" onclick="clearCompare()">Clear</button>`;
}

function clearCompare(){
  compareIds.clear();
  document.querySelectorAll('.cmp-label input').forEach(cb => cb.checked = false);
  updateCompareBar();
}

function showCompare(){
  const items = [...compareIds].map(id => cardRegistry[id]).filter(Boolean);
  if(items.length < 2) return;
  const FIELDS = [
    ['Type',       r => r.type || '—'],
    ['Country',    r => r.country || '—'],
    ['Phone',      r => r.phone || '—'],
    ['Email',      r => r.email || '—'],
    ['WhatsApp',   r => r.whatsapp || '—'],
    ['Address',    r => r.address || '—'],
    ['Founded',    r => r.founded || '—'],
    ['Size',       r => r.companySize || (r.employeeCount ? '~' + r.employeeCount + ' employees' : '—')],
    ['Confidence', r => r.confidence != null ? r.confidence + '%' : '—']
  ];
  const head = items.map(r => `<th><a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a><div class="cmp-domain">${escapeHtml(r.displayLink||'')}</div></th>`).join('');
  const body = FIELDS.map(([label, fn]) =>
    `<tr><td class="cmp-field">${label}</td>${items.map(r => `<td>${escapeHtml(String(fn(r)))}</td>`).join('')}</tr>`).join('');
  const old = document.getElementById('compareOverlay');
  if(old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'compareOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box modal-wide">
      <div class="modal-head">
        <h2>⚖ Compare Suppliers</h2>
        <button class="modal-close" onclick="document.getElementById('compareOverlay').remove()">✕</button>
      </div>
      <div class="modal-body" style="overflow-x:auto">
        <table class="cmp-table"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>
      </div>
    </div>`;
  overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// -- Draft inquiry email: AI-personalized via Gemini, static RFQ template as fallback --
function staticInquiry(r, product){
  const subject = 'Inquiry: ' + product + ' — request for quotation';
  const body = [
    'Dear ' + (r.title || 'Sir/Madam') + ',',
    '',
    'We found your company while sourcing ' + product + ' and are interested in receiving a quotation.',
    '',
    'Could you please provide:',
    '1. Product specifications and available grades',
    '2. Pricing (FOB / CIF, per unit or per MT)',
    '3. Minimum order quantity (MOQ)',
    '4. Lead time and delivery terms',
    '5. Certifications (ISO, etc.)',
    '',
    'We look forward to your reply.',
    '',
    'Best regards,'
  ].join('\n');
  return { subject, body };
}

async function draftInquiry(id, btn){
  const r = cardRegistry[id];
  if(!r) return;
  const product = lastSubject || 'your products';
  let draft;
  if(btn){ btn.disabled = true; btn.textContent = '✨ Drafting…'; }
  try{
    const res = await fetch('/api/ai-inquiry', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        product,
        supplier: { title:r.title, type:r.type, country:r.country || '', snippet:r.snippet }
      })
    });
    const data = await res.json();
    if(!res.ok || !data.subject) throw new Error(data.error || 'no draft');
    draft = data;
  }catch(e){
    // No AI key, quota, or timeout — the static template still gets the job done.
    draft = staticInquiry(r, product);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '✍️ Inquiry'; }
  }
  window.location.href = 'mailto:' + encodeURIComponent(r.email || '') +
    '?subject=' + encodeURIComponent(draft.subject) +
    '&body=' + encodeURIComponent(draft.body);
}

// -- Excel export (.xlsx via SheetJS), includes enriched contact fields --
function exportExcel(){
  if(!lastResults.length) return;
  if(typeof XLSX === 'undefined'){ alert('Excel library still loading — try again in a second.'); return; }
  const rows = lastResults.map(r => ({
    'Company':     r.title || '',
    'Type':        r.type || '',
    'Confidence':  r.confidence != null ? r.confidence + '%' : '',
    'Country':     r.country || '',
    'Phone':       r.phone || '',
    'Email':       r.email || '',
    'WhatsApp':    r.whatsapp || '',
    'Fax':         r.fax || '',
    'Address':     r.address || '',
    'Founded':     r.founded || '',
    'Size':        r.companySize || '',
    'Website':     r.link || '',
    'Domain':      r.displayLink || '',
    'Description': (r.snippet || '').slice(0, 500)
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = Object.keys(rows[0]).map(k => ({ wch: Math.min(50, Math.max(k.length, ...rows.map(r => String(r[k]).length))) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Suppliers');
  XLSX.writeFile(wb, (lastSubject||'suppliers').replace(/[^a-z0-9]+/gi,'_') + '_sourceiq.xlsx');
}

// ═══════════════ Company dossier, person profile, cross-links ═══════════════

// -- One-click company dossier: enrich + people + trust + AI, out to one Word doc --
async function generateDossier(btn){
  const company = window.lastCompanyName || lastSubject || '';
  const anchor = lastResults.find(r => r.isOfficial) || lastResults[0];
  if(!anchor){ alert('Run a company search first.'); return; }
  btn.disabled = true; const orig = btn.textContent;
  const step = t => { btn.textContent = t; };

  try{
    step('⏳ Gathering data…');
    const enrichP = fetch('/api/enrich?url=' + encodeURIComponent(anchor.link) +
      '&name=' + encodeURIComponent(company || anchor.title || '') +
      (anchor.country ? '&country=' + encodeURIComponent(anchor.country) : ''))
      .then(r => r.json()).catch(() => ({}));
    const peopleP = fetch('/api/company-people?company=' + encodeURIComponent(company || anchor.title || ''))
      .then(r => r.json()).catch(() => ({ people: [] }));
    const trustP = fetch('/api/trust-check?url=' + encodeURIComponent(anchor.link) +
      '&name=' + encodeURIComponent(company || anchor.title || ''))
      .then(r => r.json()).catch(() => ({}));
    const [enrich, peopleData, trust] = await Promise.all([enrichP, peopleP, trustP]);

    step('✨ AI summary…');
    let ai = null;
    try{
      const aiRes = await fetch('/api/ai-analyze', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ query: company || anchor.title, results: lastResults.slice(0, 10), mode: 'company' })
      });
      const aiData = await aiRes.json();
      if(aiRes.ok && aiData.analysis) ai = aiData.analysis;
    }catch(e){}

    step('📄 Building document…');
    const esc = escapeHtml;
    const reg = window.lastRegistry;
    const row = (label, val) => val ? `<tr><td style="font-weight:bold;padding:4px 14px 4px 0;vertical-align:top;white-space:nowrap">${label}</td><td style="padding:4px 0">${esc(String(val))}</td></tr>` : '';
    const section = (title, inner) => inner ? `<h2 style="font-size:14pt;color:#1a2040;border-bottom:1px solid #ddd;padding-bottom:4px;margin:24px 0 8px">${title}</h2>${inner}` : '';

    const contactRows = [
      row('Website', enrich.website || anchor.link),
      row('Phone', enrich.phone), row('Fax', enrich.fax),
      row('Email', enrich.email), row('WhatsApp', enrich.whatsapp),
      row('Address', enrich.address), row('Country', enrich.country || anchor.country),
      row('Founded', enrich.founded), row('Employees', enrich.employeeCount),
      row('Company size', enrich.companySize), row('Hiring', enrich.hiringStatus)
    ].join('');

    const regRows = reg ? [
      row('Registration No / UEN', reg.uen), row('Incorporated', reg.incorporated),
      row('Status', reg.status), row('Entity type', reg.entityType),
      row('Registry source', reg.source)
    ].join('') : '';

    const peopleHtml = (peopleData.people || []).slice(0, 8).map(p =>
      `<p style="margin:3px 0">• <b>${esc(p.name)}</b>${p.title ? ' — ' + esc(p.title) : ''}${p.source ? ' <span style="color:#888">(' + esc(p.source) + ')</span>' : ''}</p>`).join('');

    const trustHtml = trust.rating ? (
      `<p><b>Rating:</b> ${esc(trust.rating)}${trust.score != null ? ' (' + trust.score + '/100)' : ''}</p>` +
      (trust.findings || []).slice(0, 8).map(f => `<p style="margin:3px 0;color:#444">${esc(f.text || '')}</p>`).join('')
    ) : '';

    const newsHtml = (enrich.news || []).slice(0, 5).map(n =>
      `<p style="margin:3px 0">• ${esc(n.title)}${n.age ? ' <span style="color:#888">(' + esc(n.age) + ')</span>' : ''}</p>`).join('');

    const aiHtml = ai ? (
      (ai.summary ? `<p>${esc(ai.summary)}</p>` : '') +
      (ai.keyInsights || []).slice(0, 6).map(k => `<p style="margin:3px 0">• ${esc(k)}</p>`).join('')
    ) : '';

    const date = new Date().toLocaleDateString();
    const html = `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#222;margin:40px;}h1{font-size:20pt;color:#1a2040;margin-bottom:2px;}table{border-collapse:collapse;font-size:11pt;}</style>
</head><body>
<h1>${esc(company || anchor.title || 'Company Dossier')}</h1>
<p style="color:#666;font-size:10pt">Supplier dossier — generated by SourceIQ on ${date}</p>
${enrich.description ? `<p style="font-size:11.5pt;line-height:1.5">${esc(enrich.description)}</p>` : ''}
${section('Contact &amp; Company Details', contactRows ? '<table>' + contactRows + '</table>' : '')}
${section('Official Registry', regRows ? '<table>' + regRows + '</table>' : '')}
${section('Key People', peopleHtml)}
${section('Trust &amp; Reputation', trustHtml)}
${section('Recent News', newsHtml)}
${section('AI Assessment', aiHtml)}
<p style="font-size:9pt;color:#999;margin-top:30px;border-top:1px solid #eee;padding-top:8px">Generated by SourceIQ. Verify critical details directly with the company.</p>
</body></html>`;

    const blob = new Blob(['﻿' + html], { type: 'application/msword' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (company || anchor.title || 'company').replace(/[^a-z0-9]+/gi, '_').slice(0, 40) + '_dossier.doc';
    a.click();
    URL.revokeObjectURL(a.href);
  }catch(e){
    alert('Dossier failed: ' + e.message);
  }finally{
    btn.disabled = false; btn.textContent = orig;
  }
}

// -- AI person profile: synthesizes person-search results into a mini-profile --
async function runPersonProfile(person, results){
  const wrap = document.getElementById('resultsWrap');
  if(!wrap) return;
  const holder = document.createElement('div');
  holder.id = 'personProfilePanel';
  holder.className = 'person-profile-panel loading';
  holder.innerHTML = '<span class="loading-dot"></span> Building profile of ' + escapeHtml(person) + '…';
  wrap.prepend(holder);
  try{
    const res = await fetch('/api/ai-person-summary', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ person, results: results.slice(0, 12).map(r => ({ title:r.title, snippet:r.snippet, displayLink:r.displayLink })) })
    });
    const data = await res.json();
    if(!res.ok || !data.summary){ holder.remove(); return; }
    const confCls = data.confidence === 'high' ? 'conf-high' : data.confidence === 'low' ? 'conf-low' : 'conf-mid';
    const companies = (data.companies || []).map(c =>
      `<button class="profile-company-chip" onclick="searchCompanyByName(this.dataset.co)" data-co="${escapeHtml(c.name)}" title="Search this company">🏢 ${escapeHtml(c.name)}${c.role ? ' · ' + escapeHtml(c.role) : ''}</button>`).join('');
    holder.className = 'person-profile-panel';
    holder.innerHTML = `
      <div class="profile-head">👤 <strong>${escapeHtml(person)}</strong>
        ${data.currentRole ? `<span class="profile-role">${escapeHtml(data.currentRole)}</span>` : ''}
        <span class="profile-conf ${confCls}">${escapeHtml(data.confidence)} confidence</span>
      </div>
      <p class="profile-summary">${escapeHtml(data.summary)}</p>
      ${companies ? `<div class="profile-companies">${companies}</div>` : ''}
      <div class="profile-note">AI summary from the search results below — verify via the source links.</div>`;
  }catch(e){ holder.remove(); }
}

// -- Draft sales offer to a buyer (mirror of draftInquiry): AI-personalized,
//    falls back to a static pitch template if AI is unavailable --
function staticOffer(r, product){
  const subject = 'Offer: ' + product + ' — competitive supply available';
  const body = [
    'Dear ' + (r.title || 'Sir/Madam') + ',',
    '',
    'We are a trading company supplying ' + product + ' and understand your company purchases this product.',
    '',
    'We can offer:',
    '- Competitive FOB / CIF pricing',
    '- Full product specifications and certificates on request',
    '- Samples available',
    '- Reliable delivery terms',
    '',
    'Could you share your target specifications and monthly quantity so we can quote accurately?',
    '',
    'Best regards,'
  ].join('\n');
  return { subject, body };
}

async function draftOffer(id, btn){
  const r = cardRegistry[id];
  if(!r) return;
  const product = (window.lastBuyerData && window.lastBuyerData.product) || lastSubject || 'our products';
  let draft;
  if(btn){ btn.disabled = true; btn.textContent = '✨ Drafting…'; }
  try{
    const res = await fetch('/api/ai-offer', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        product,
        buyer: { title:r.title, type:r.type, country:r.country || '', snippet:r.snippet, isRFQ: !!r.isRFQ }
      })
    });
    const data = await res.json();
    if(!res.ok || !data.subject) throw new Error(data.error || 'no draft');
    draft = data;
  }catch(e){
    draft = staticOffer(r, product);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '✍️ Offer'; }
  }
  window.location.href = 'mailto:' + encodeURIComponent(r.email || '') +
    '?subject=' + encodeURIComponent(draft.subject) +
    '&body=' + encodeURIComponent(draft.body);
}

// Shared helper: jump into company mode and search a name (used by cross-links)
function searchCompanyByName(name){
  if(!name) return;
  setMode('company');
  document.getElementById('companyQuery').value = name;
  runSearch();
}

// -- Person card → company cross-link: pull an affiliation out of the title --
function personAffiliationHtml(r){
  const t = r.title || '';
  // "Allan Shepherdson - Director, Erez Impex | LinkedIn" → company after the role
  const m = t.match(/[-–—]\s*(?:Managing\s+)?(?:Director|CEO|CFO|COO|CTO|Founder|Co-?Founder|Owner|President|Chairman|Chairwoman|Manager|Partner|VP|Head)[^,|@]*(?:,|@|\sat\s)\s*([^|–—]{2,60})/i);
  if(!m) return '';
  const company = m[1].trim().replace(/\s*\|.*$/, '').trim();
  if(!company || company.length < 2) return '';
  return `<div class="person-affiliation"><button class="profile-company-chip" onclick="searchCompanyByName(this.dataset.co)" data-co="${escapeHtml(company)}" title="Search this company">🏢 ${escapeHtml(company)}</button></div>`;
}

// ═══════════════ Image identification & market brief ═══════════════

// -- Product photo → Gemini Vision identifies it → auto supplier search --
async function identifyProductImage(file){
  const statusEl = document.getElementById('idStatus');
  const resultEl = document.getElementById('idResult');
  try{
    // Downscale large photos client-side: identification doesn't need 12MP,
    // and smaller payloads keep the request fast and under the server limit.
    const dataUrl = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1280;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Could not read the image'));
      img.src = URL.createObjectURL(file);
    });
    const base64 = dataUrl.split(',')[1];

    const res = await fetch('/api/identify-image', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ image: base64, mimeType: 'image/jpeg' })
    });
    const data = await res.json();
    if(!res.ok || data.error) throw new Error(data.error || 'identification failed');

    if(!data.product){
      statusEl.innerHTML = '🤔 Could not identify a sellable product in this photo.';
      resultEl.innerHTML = data.description ? `<div class="id-desc">${escapeHtml(data.description)}</div>` : '';
      return;
    }

    const confCls = data.confidence === 'high' ? 'conf-high' : data.confidence === 'low' ? 'conf-low' : 'conf-mid';
    statusEl.innerHTML = '✅ Identified';
    resultEl.innerHTML = `
      <div class="id-card">
        <div class="id-product">📦 <strong>${escapeHtml(data.product)}</strong>
          <span class="profile-conf ${confCls}">${escapeHtml(data.confidence)} confidence</span></div>
        ${data.brand ? `<div class="id-brand">Brand visible: ${escapeHtml(data.brand)}</div>` : ''}
        ${data.description ? `<div class="id-desc">${escapeHtml(data.description)}</div>` : ''}
        <div class="id-actions">
          <button class="id-search-btn" onclick="searchIdentifiedProduct(this.dataset.kw)" data-kw="${escapeHtml(data.keywords)}">🔍 Find suppliers of &quot;${escapeHtml(data.keywords)}&quot;</button>
          <button class="id-search-btn id-buyers" onclick="searchIdentifiedBuyers(this.dataset.kw)" data-kw="${escapeHtml(data.keywords)}">🛒 Find buyers</button>
        </div>
      </div>`;
  }catch(e){
    statusEl.innerHTML = '⚠️ ' + escapeHtml(e.message);
  }
}

function searchIdentifiedProduct(keywords){
  setMode('product');
  document.getElementById('query').value = keywords;
  runSearch();
}

function searchIdentifiedBuyers(keywords){
  setMode('buyers');
  document.getElementById('buyersProduct').value = keywords;
  runBuyersSearch();
}

// -- AI market brief: structured summary panel above market results --
async function runMarketBrief(industry, country, results){
  const wrap = document.getElementById('resultsWrap');
  if(!wrap) return;
  const holder = document.createElement('div');
  holder.id = 'marketBriefPanel';
  holder.className = 'person-profile-panel loading';
  holder.innerHTML = '<span class="loading-dot"></span> Building market brief for ' + escapeHtml(industry) + '…';
  wrap.prepend(holder);
  try{
    const res = await fetch('/api/ai-market-brief', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ industry, country, results: results.slice(0, 12).map(r => ({ title:r.title, snippet:r.snippet, displayLink:r.displayLink })) })
    });
    const data = await res.json();
    if(!res.ok || !data.overview){ holder.remove(); return; }
    const confCls = data.confidence === 'high' ? 'conf-high' : data.confidence === 'low' ? 'conf-low' : 'conf-mid';
    const facts = [
      data.marketSize ? `<span class="reg-cell"><span class="reg-label">Market size</span><strong>${escapeHtml(data.marketSize)}</strong></span>` : '',
      data.growth ? `<span class="reg-cell"><span class="reg-label">Growth</span><strong>${escapeHtml(data.growth)}</strong></span>` : ''
    ].join('');
    const players = (data.keyPlayers || []).map(p =>
      `<button class="profile-company-chip" onclick="searchCompanyByName(this.dataset.co)" data-co="${escapeHtml(p)}" title="Search this company">🏢 ${escapeHtml(p)}</button>`).join('');
    const trends = (data.trends || []).map(t => `<li>${escapeHtml(t)}</li>`).join('');
    holder.className = 'person-profile-panel';
    holder.innerHTML = `
      <div class="profile-head">📈 <strong>${escapeHtml(industry)}</strong>${country ? ' — ' + escapeHtml(country) : ''}
        <span class="profile-conf ${confCls}">${escapeHtml(data.confidence)} confidence</span>
      </div>
      <p class="profile-summary">${escapeHtml(data.overview)}</p>
      ${facts ? `<div style="display:flex;gap:24px;margin:8px 0">${facts}</div>` : ''}
      ${players ? `<div class="profile-companies">${players}</div>` : ''}
      ${trends ? `<ul class="brief-trends">${trends}</ul>` : ''}
      <div class="profile-note">AI brief from the results below — figures come from those sources, verify before citing.</div>`;
  }catch(e){ holder.remove(); }
}

// Load the shared shortlist state on startup
loadSavedLinks();
