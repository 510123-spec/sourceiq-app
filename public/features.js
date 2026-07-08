// ═══════════════ Saved suppliers (shared shortlist), Compare, Inquiry, Excel ═══════════════

// -- Saved suppliers: stored server-side (data/saved.json) so all users share one list --
const savedLinks = new Set();

async function loadSavedLinks(){
  try{
    const res = await fetch('/api/saved');
    const data = await res.json();
    savedLinks.clear();
    (data.saved || []).forEach(s => savedLinks.add(s.link));
    updateSavedCount((data.saved || []).length, attentionCount(data.saved || []));
  }catch(e){}
}

function updateSavedCount(n, attn = 0){
  const el = document.getElementById('savedCount');
  if(!el) return;
  el.textContent = n > 0 ? String(n) : '';
  // Red badge when saved deals have gone quiet for 7+ days
  el.classList.toggle('saved-count-attn', attn > 0);
  const pill = el.closest('.topbar-pill');
  if(pill) pill.title = attn > 0
    ? attn + ' supplier(s) waiting 7+ days in their stage — open to follow up'
    : 'View shared shortlist';
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
      updateSavedCount((data.saved||[]).length, attentionCount(data.saved||[]));
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
      updateSavedCount((data.saved||[]).length, attentionCount(data.saved||[]));
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
      <div class="pipeline-row">${pipelinePillsHtml(s)}${agingBadgeHtml(s)}</div>
      <textarea class="saved-notes" placeholder="Notes (e.g. quoted $6,400/MT, slow to reply)…"
        onblur="saveNotes('${escapeHtml(s.link)}', this)">${escapeHtml(s.notes || '')}</textarea>
      ${dealMathHtml(s)}
    </div>`).join('') : '<p class="empty" style="padding:20px">Nothing saved yet — click the ☆ on any result card to add it here.</p>';

  const overlay = document.createElement('div');
  overlay.id = 'savedOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <h2>⭐ Saved Suppliers <span style="font-weight:400;font-size:13px;color:var(--muted)">(shared with your team)</span></h2>
        <div style="display:flex;gap:8px;align-items:center">
          ${list.length ? '<button class="saved-export-btn" onclick="document.getElementById(\'savedOverlay\').remove();showCampaign()">📣 Campaign</button>' : ''}
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

// -- Follow-up aging: how long has this supplier sat in its current stage? --
// Deals die from silence; make staleness impossible to miss.
const AGING_STATUSES = ['new', 'contacted', 'quoted', 'sampled']; // ordered/rejected are terminal
function statusAgeDays(s){
  const since = s.statusChangedAt || s.savedAt;
  if(!since) return null;
  return Math.floor((Date.now() - new Date(since).getTime()) / 86400000);
}
function agingBadgeHtml(s){
  const days = statusAgeDays(s);
  if(days == null || !AGING_STATUSES.includes(s.status || 'new')) return '';
  const cls = days >= 14 ? 'age-red' : days >= 7 ? 'age-amber' : 'age-ok';
  const label = days === 0 ? 'today' : days === 1 ? '1 day' : days + ' days';
  const nudge = days >= 14 ? ' — follow up or close!' : days >= 7 ? ' — time to follow up' : '';
  return `<span class="age-badge ${cls}" title="In this stage for ${label}${nudge}">⏱ ${label}${days >= 7 ? ' ⚠' : ''}</span>`;
}
function attentionCount(list){
  return list.filter(s => AGING_STATUSES.includes(s.status || 'new') && (statusAgeDays(s) ?? 0) >= 7).length;
}

// -- Margin quick-check: buy + freight + duties vs sell, per unit --
function dealMathHtml(s){
  const d = s.deal || {};
  const v = x => (x == null ? '' : x);
  return `
    <details class="deal-math" ${d.buy != null || d.sell != null ? 'open' : ''}>
      <summary>💹 Deal math (per MT / unit)</summary>
      <div class="deal-grid">
        <label>Buy<input type="number" min="0" step="any" value="${v(d.buy)}" data-f="buy" onchange="saveDeal('${escapeHtml(s.link)}', this)"></label>
        <label>Freight<input type="number" min="0" step="any" value="${v(d.freight)}" data-f="freight" onchange="saveDeal('${escapeHtml(s.link)}', this)"></label>
        <label>Duties<input type="number" min="0" step="any" value="${v(d.duties)}" data-f="duties" onchange="saveDeal('${escapeHtml(s.link)}', this)"></label>
        <label>Sell<input type="number" min="0" step="any" value="${v(d.sell)}" data-f="sell" onchange="saveDeal('${escapeHtml(s.link)}', this)"></label>
        <div class="deal-result" id="deal-${btoa(s.link).replace(/[^a-z0-9]/gi,'')}">${dealResultText(d)}</div>
      </div>
    </details>`;
}
function dealResultText(d){
  if(d == null || d.sell == null || d.buy == null) return 'Enter buy & sell to see margin';
  const cost = (d.buy || 0) + (d.freight || 0) + (d.duties || 0);
  const margin = d.sell - cost;
  const pct = cost > 0 ? (margin / cost * 100) : 0;
  const cls = margin > 0 ? 'deal-pos' : 'deal-neg';
  return `<span class="${cls}">Margin: ${margin.toFixed(2)} / unit (${pct.toFixed(1)}%)</span> · cost ${cost.toFixed(2)}`;
}
async function saveDeal(link, input){
  const grid = input.closest('.deal-grid');
  const deal = {};
  grid.querySelectorAll('input').forEach(i => { deal[i.dataset.f] = i.value === '' ? null : parseFloat(i.value); });
  grid.querySelector('.deal-result').innerHTML = dealResultText(deal);
  try{
    await fetch('/api/saved', {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ link, deal })
    });
  }catch(e){}
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
    loadSavedLinks(); // refresh attention badge after a stage change
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
<p style="color:#666;font-size:10pt">Supplier dossier — generated by Erez Impex Pte Ltd on ${date}</p>
${enrich.description ? `<p style="font-size:11.5pt;line-height:1.5">${esc(enrich.description)}</p>` : ''}
${section('Contact &amp; Company Details', contactRows ? '<table>' + contactRows + '</table>' : '')}
${section('Official Registry', regRows ? '<table>' + regRows + '</table>' : '')}
${section('Key People', peopleHtml)}
${section('Trust &amp; Reputation', trustHtml)}
${section('Recent News', newsHtml)}
${section('AI Assessment', aiHtml)}
<p style="font-size:9pt;color:#999;margin-top:30px;border-top:1px solid #eee;padding-top:8px">Generated by Erez Impex Pte Ltd. Verify critical details directly with the company.</p>
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

// ═══════════════ Service health indicators (Brave / Gemini) ═══════════════
// Polls /api/service-status and colors the topbar dots:
//   green = last call OK and not near a known limit
//   amber = rate-limited, erroring, or approaching the free-tier daily cap
//   red   = quota exhausted (searches/AI silently degrade until it resets)
//   gray  = not used yet this session / not configured
async function refreshServiceStatus(){
  try{
    const res = await fetch('/api/service-status');
    const s = await res.json();

    // Mini speedometer gauge: value 0..1 fills a semicircular arc whose color
    // moves green -> amber -> red as health drops. Far clearer at a glance
    // than dots or words alone.
    const gaugeSvg = (value, color) => {
      const R = 13, CX = 17, CY = 17, LEN = Math.PI * R; // semicircle length ≈ 40.8
      const v = Math.max(0.04, Math.min(1, value));      // always show a sliver
      return `<svg width="34" height="21" viewBox="0 0 34 21">
        <path d="M 4 17 A ${R} ${R} 0 0 1 30 17" fill="none" stroke="#e5e7eb" stroke-width="5" stroke-linecap="round"/>
        <path d="M 4 17 A ${R} ${R} 0 0 1 30 17" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"
          stroke-dasharray="${(v * LEN).toFixed(1)} ${LEN.toFixed(1)}" style="transition:stroke-dasharray .6s, stroke .6s"/>
        <circle cx="${CX}" cy="${CY}" r="2.2" fill="${color}"/>
      </svg>`;
    };

    const apply = (gaugeId, wordId, pillId, info, opts) => {
      const gauge = document.getElementById(gaugeId);
      const wordEl = document.getElementById(wordId);
      const pill = document.getElementById(pillId);
      if(!gauge || !pill) return;
      let value = 0, color = '#9ca3af', word = '–', tip = opts.name + ': no calls yet this session';
      if(!info.configured){
        word = 'Off';
        tip = opts.name + ': no API key configured';
      } else if(info.status === 'quota'){
        value = 0.06; color = '#dc2626'; word = 'Down';
        tip = opts.name + ' QUOTA EXHAUSTED — ' + (opts.quotaHint || 'running on fallback until it resets') +
          (info.detail ? '\n' + info.detail : '');
      } else if(info.status === 'rate-limited' || info.status === 'error'){
        value = 0.45; color = '#f59e0b'; word = 'Slow';
        tip = opts.name + ': ' + info.status + (info.detail ? ' — ' + info.detail : '');
      } else if(info.status === 'ok'){
        if(opts.limit && info.count < opts.limit){
          // Gauge shows REMAINING daily AI allowance — it visibly drains with use
          const remaining = Math.max(0, 1 - (info.count / opts.limit));
          value = remaining;
          color = remaining > 0.4 ? '#10b981' : remaining > 0.15 ? '#f59e0b' : '#dc2626';
          word = remaining > 0.4 ? 'OK' : remaining > 0.15 ? 'Low' : 'Almost out';
          tip = opts.name + ': ' + info.count + ' of ~' + opts.limit + ' free daily calls used (' + Math.round(remaining * 100) + '% left)';
        } else {
          // Either no known ceiling, or usage sailed past the free-tier limit
          // while still succeeding — that means a PAID tier is active: full green.
          value = 1; color = '#10b981'; word = 'OK';
          tip = opts.name + ': OK — ' + info.count + ' call' + (info.count === 1 ? '' : 's') + ' today' +
            (opts.limit && info.count >= opts.limit ? ' (paid tier active)' : '');
        }
      }
      gauge.innerHTML = gaugeSvg(value, color);
      if(wordEl){ wordEl.textContent = word; wordEl.style.color = color === '#9ca3af' ? '#6b7280' : color; }
      pill.title = tip;
      pill.classList.toggle('svc-word-red', color === '#dc2626');
    };

    apply('braveGauge', 'braveWord', 'braveStatusPill', s.brave, {
      name: 'Brave Search',
      quotaHint: 'searches fall back to DuckDuckGo (lower quality) — check billing at api-dashboard.search.brave.com'
    });
    apply('geminiGauge', 'geminiWord', 'geminiStatusPill', s.gemini, {
      name: 'Gemini AI',
      limit: s.gemini.freeTierDailyLimit,
      quotaHint: 'AI features paused until the daily free tier resets — enable billing at aistudio.google.com to remove the cap'
    });
  }catch(e){}
}
refreshServiceStatus();
setInterval(refreshServiceStatus, 60000);

// ═══════════════ Best Price Finder ═══════════════

async function runPriceSearch(){
  const wrap = document.getElementById('resultsWrap');
  const btn  = document.getElementById('priceSearchBtn');
  const product   = document.getElementById('priceProduct').value.trim();
  const region    = document.getElementById('priceRegion').value.trim();
  const condition = document.getElementById('priceCondition').value.trim();

  if(!product){
    wrap.innerHTML = '<p class="empty">Type the exact product model (e.g. "MacBook Air M4 13"), then click Compare Prices.</p>';
    return;
  }
  btn.disabled = true; btn.classList.add('btn-loading');
  hideAIPanel();
  document.getElementById('toolbar').style.display = 'none';
  wrap.innerHTML = buildSkeleton(4);

  try{
    const params = new URLSearchParams({ product, region });
    const res = await fetch('/api/price-search?' + params.toString());
    const data = await res.json();
    if(!res.ok || data.error){ wrap.innerHTML = `<p class="error">${escapeHtml(data.error || 'Price search failed.')}</p>`; return; }
    let offers = data.offers || [];
    if(condition === 'new')    offers = offers.filter(o => !o.refurb);
    if(condition === 'refurb') offers = offers.filter(o => o.refurb);
    renderPriceResults({ ...data, offers });
  }catch(err){
    wrap.innerHTML = buildErrorState(err.message, ()=>runPriceSearch());
  }finally{
    btn.disabled = false; btn.classList.remove('btn-loading');
  }
}

// Price-history / comparison tools, prefilled with the product
function priceToolsHtml(product, region){
  const q = encodeURIComponent(product);
  const tools = [
    ['🛍 Google Shopping', `https://www.google.com/search?q=${q}&tbm=shop`, 'live price comparison'],
    ['📉 CamelCamelCamel', `https://camelcamelcamel.com/search?sq=${q}`, 'Amazon price history — is today’s price good?'],
    ['📊 PriceSpy', `https://pricespy.co.uk/search?search=${q}`, 'price history & comparison'],
    ...(region === 'Israel' ? [['🔎 Zap.co.il', `https://www.zap.co.il/search.aspx?keyword=${q}`, 'Israeli price comparison']] : []),
    ...(region === 'Singapore' ? [['🔎 iPrice SG', `https://iprice.sg/search/?q=${q}`, 'Singapore price comparison']] : [])
  ].map(([name, url, tip]) =>
    `<a class="trade-db-link" href="${url}" target="_blank" rel="noopener" title="${tip}">${name}</a>`).join('');
  return `<div class="trade-db-row"><span class="trade-db-label">Price history &amp; comparison tools:</span>${tools}</div>`;
}

function renderPriceResults(data){
  const wrap = document.getElementById('resultsWrap');
  const offers = data.offers || [];
  const v = data.verdict;

  if(!offers.length){
    wrap.innerHTML = `<p class="empty">No retailer listings found for "${escapeHtml(data.product)}" — try a shorter model name, or use the comparison tools below.</p>`
      + priceToolsHtml(data.product, data.region);
    return;
  }

  // Best value: AI's pick if given, else the cheapest priced offer
  let bestIdx = (v && typeof v.bestValue === 'number' && offers[v.bestValue - 1]) ? v.bestValue - 1
    : offers.findIndex(o => o.priceValue != null);

  const rows = offers.map((o, i) => {
    const best = i === bestIdx;
    const badges = [
      o.isRegional ? '<span class="deal-badge">📍 Regional store</span>' : '',
      o.refurb ? '<span class="deal-badge" style="background:#fef3c7;border-color:#fde68a;color:#92400e">♻️ Refurbished</span>' : '',
      o.deal ? '<span class="deal-badge deal-price">🏷 Deal / Promo</span>' : ''
    ].join('');
    return `<tr class="${best ? 'price-best' : ''}">
      <td class="price-store"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(o.store)}&sz=32" alt="" loading="lazy" onerror="this.style.display='none'"> ${escapeHtml(o.store)}</td>
      <td class="price-amt">${o.price ? '<strong>' + escapeHtml(o.price) + '</strong>' : '<span class="price-na">see site</span>'}${best ? ' <span class="best-star">⭐ Best Value</span>' : ''}</td>
      <td class="price-info"><a href="${escapeHtml(o.link)}" target="_blank" rel="noopener">${escapeHtml((o.title || '').slice(0, 75))}</a><div class="price-badges">${badges}</div></td>
      <td class="price-visit"><a class="stock-card-link" href="${escapeHtml(o.link)}" target="_blank" rel="noopener">Visit →</a></td>
    </tr>`;
  }).join('');

  const verdictHtml = v ? `
    <div class="person-profile-panel">
      <div class="profile-head">💡 <strong>Buying Verdict</strong>${v.priceRange ? `<span class="profile-role">${escapeHtml(v.priceRange)}</span>` : ''}</div>
      ${v.priceAssessment ? `<p class="profile-summary">${escapeHtml(v.priceAssessment)}</p>` : ''}
      ${v.advice ? `<p class="profile-summary" style="margin-top:2px"><strong>Advice:</strong> ${escapeHtml(v.advice)}</p>` : ''}
      <div class="profile-note">Based only on the listings below — always verify final price, shipping, and warranty on the retailer’s site before ordering.</div>
    </div>` : '';

  wrap.innerHTML = `
    <div class="stats"><div style="font-size:13px;"><strong style="color:var(--text)">${offers.length}</strong> listings for <strong style="color:#4f46e5">${escapeHtml(data.product)}</strong> — ${escapeHtml(data.region)}</div></div>
    ${verdictHtml}
    ${priceToolsHtml(data.product, data.region)}
    <div class="price-table-wrap">
      <table class="price-table">
        <thead><tr><th>Store</th><th>Price</th><th>Listing</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="profile-note" style="margin-top:10px">Prices are extracted from live search listings and may be outdated — the retailer’s site is authoritative. Shipping and delivery times are shown on each store’s page.</div>`;
}

// ═══════════════ Morning lead monitor ═══════════════
// Watched searches run server-side every morning; this UI shows what's NEW.

async function refreshLeadsBadge(){
  try{
    const r = await fetch('/api/monitor-report');
    const rep = await r.json();
    const n = (rep.items || []).reduce((s, i) => s + (i.newResults || []).length, 0);
    const el = document.getElementById('leadsCount');
    if(el) el.textContent = n > 0 ? String(n) : '';
  }catch(e){}
}

// Watch the search currently on screen (called from toolbar / buyers header)
async function watchCurrentSearch(mode){
  let query = '', country = '';
  if(mode === 'product'){
    query = document.getElementById('query').value.trim();
    country = document.getElementById('country').value.trim();
  } else {
    query = document.getElementById('buyersProduct').value.trim();
    country = document.getElementById('buyersCountry').value.trim();
  }
  if(!query){ alert('Run a search first, then watch it.'); return; }
  const res = await fetch('/api/watchlist', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ mode, query, country })
  });
  const data = await res.json();
  if(data.error){ alert(data.error); return; }
  alert(data.note ? 'Already on your watchlist.' :
    '🔔 Watching "' + query + '"' + (country ? ' in ' + country : '') +
    ' — new ' + (mode === 'buyers' ? 'buyers' : 'suppliers') + ' will appear in the Leads panel each morning.');
}

async function removeWatch(key){
  await fetch('/api/watchlist?key=' + encodeURIComponent(key), { method: 'DELETE' });
  showLeadsPanel();
}

async function runMonitorNow(btn){
  btn.disabled = true; btn.textContent = '⏳ Running…';
  await fetch('/api/monitor-run', { method: 'POST' });
  // Poll until the report regenerates (watches are paced ~3s apart)
  const started = Date.now();
  const poll = setInterval(async () => {
    const rep = await (await fetch('/api/monitor-report')).json();
    const fresh = rep.generatedAt && (Date.now() - new Date(rep.generatedAt).getTime()) < 30000;
    if(fresh || Date.now() - started > 180000){
      clearInterval(poll);
      refreshLeadsBadge();
      showLeadsPanel();
    }
  }, 4000);
}

async function showLeadsPanel(){
  const old = document.getElementById('leadsOverlay');
  if(old) old.remove();
  const [repR, wlR] = await Promise.all([fetch('/api/monitor-report'), fetch('/api/watchlist')]);
  const rep = await repR.json();
  const wl = (await wlR.json()).watchlist || [];

  const watchRows = wl.length ? wl.map(w => {
    const key = (w.mode + '|' + w.query + '|' + (w.country || '')).toLowerCase();
    return `<div class="watch-row">
      <span>${w.mode === 'buyers' ? '🛒' : '🔍'} <strong>${escapeHtml(w.query)}</strong>${w.country ? ' · ' + escapeHtml(w.country) : ''}</span>
      <button class="saved-remove" onclick="removeWatch('${escapeHtml(key)}')" title="Stop watching">✕</button>
    </div>`;
  }).join('') : '<p class="empty" style="padding:8px 0">No watched searches yet — run a Product or Buyers search and click "🔔 Watch this search".</p>';

  let leadsHtml = '';
  if(rep.date){
    const groups = (rep.items || []).map(i => {
      if(i.error) return `<div class="leads-group"><div class="leads-group-head">⚠️ ${escapeHtml(i.watch.query)} — ${escapeHtml(i.error)}</div></div>`;
      if(i.firstRun) return `<div class="leads-group"><div class="leads-group-head">📌 ${escapeHtml(i.watch.query)} — baseline captured (${i.totalResults} results). New items appear from tomorrow.</div></div>`;
      if(!(i.newResults || []).length) return `<div class="leads-group"><div class="leads-group-head">✓ ${escapeHtml(i.watch.query)} — nothing new</div></div>`;
      const rows = i.newResults.map(x => `
        <div class="lead-item">
          <a href="${escapeHtml(x.link)}" target="_blank" rel="noopener">${escapeHtml(x.title)}</a>
          ${x.isRFQ ? '<span class="badge rfq-badge" style="font-size:10px">📣 Buy Request</span>' : ''}
          <div class="lead-snippet">${escapeHtml(x.snippet || '')}</div>
          <div class="lead-domain">${escapeHtml(x.displayLink || '')}</div>
        </div>`).join('');
      return `<div class="leads-group"><div class="leads-group-head leads-new">🆕 ${escapeHtml(i.watch.query)} — ${i.newResults.length} new</div>${rows}</div>`;
    }).join('');
    leadsHtml = `<div class="leads-date">Last run: ${escapeHtml(rep.generatedAt ? new Date(rep.generatedAt).toLocaleString() : rep.date)}</div>` + groups;
  } else {
    leadsHtml = '<p class="empty" style="padding:8px 0">No runs yet — the monitor runs automatically every morning after 7:00, or click Run Now.</p>';
  }

  const overlay = document.createElement('div');
  overlay.id = 'leadsOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <h2>🔔 Lead Monitor <span style="font-weight:400;font-size:13px;color:var(--muted)">(runs every morning)</span></h2>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="saved-export-btn" onclick="runMonitorNow(this)">▶ Run Now</button>
          <button class="modal-close" onclick="document.getElementById('leadsOverlay').remove()">✕</button>
        </div>
      </div>
      <div class="modal-body">
        ${leadsHtml}
        <div class="leads-watch-head">Watched searches (${wl.length}/10)</div>
        ${watchRows}
      </div>
    </div>`;
  overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

refreshLeadsBadge();

// ═══════════════ Erez Assistant (AI copilot) chat ═══════════════
const copilotHistory = [];

function toggleCopilot(){
  let box = document.getElementById('copilotBox');
  if(box){ box.remove(); return; }
  box = document.createElement('div');
  box.id = 'copilotBox';
  box.innerHTML = `
    <div class="cp-head">🧠 Erez Assistant
      <button class="modal-close" onclick="document.getElementById('copilotBox').remove()">✕</button>
    </div>
    <div class="cp-msgs" id="cpMsgs">
      <div class="cp-msg cp-bot">Ask me anything — I answer trade questions AND work inside the app for you.<br><br>
      <strong>Trade knowledge:</strong> <em>"What's the HS code for copper wire scrap?" · "Explain FOB vs CIF" · "What documents do I need to export copper cathode to India?" · "How does a Letter of Credit protect me?"</em><br><br>
      <strong>Do things:</strong> <em>"Which of my deals are going stale?" · "Find aluminium scrap buyers in India and save the best two."</em></div>
    </div>
    <div class="cp-input-row">
      <input id="cpInput" type="text" placeholder="Ask the Copilot…" onkeydown="if(event.key==='Enter')sendCopilot()">
      <button id="cpSend" onclick="sendCopilot()">➤</button>
    </div>`;
  document.body.appendChild(box);
  // Re-render history if the panel was closed and reopened
  copilotHistory.forEach(m => appendCopilotMsg(m.role === 'user' ? 'cp-user' : 'cp-bot', m.text));
  document.getElementById('cpInput').focus();
}

function appendCopilotMsg(cls, html){
  const msgs = document.getElementById('cpMsgs');
  if(!msgs) return null;
  const div = document.createElement('div');
  div.className = 'cp-msg ' + cls;
  div.innerHTML = html;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

const TOOL_LABELS = {
  search_suppliers:'🔍 Searched suppliers', search_buyers:'🛒 Searched buyers',
  get_shortlist:'⭐ Read shortlist', save_supplier:'⭐ Saved to shortlist',
  update_supplier:'✏️ Updated shortlist', enrich_company:'📇 Fetched contact details',
  trust_check:'🛡 Ran trust check', get_new_leads:'🔔 Checked new leads'
};

async function sendCopilot(){
  const input = document.getElementById('cpInput');
  const btn = document.getElementById('cpSend');
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  input.disabled = true; btn.disabled = true;
  appendCopilotMsg('cp-user', escapeHtml(text));
  copilotHistory.push({ role:'user', text });
  const thinking = appendCopilotMsg('cp-bot cp-thinking', '<span class="loading-dot"></span> Working — this can take up to a minute when I search…');
  try{
    const res = await fetch('/api/copilot', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ messages: copilotHistory.slice(-10) })
    });
    const data = await res.json();
    if(thinking) thinking.remove();
    if(!res.ok || data.error){
      appendCopilotMsg('cp-bot cp-err', '⚠️ ' + escapeHtml(data.error || 'Copilot failed — try again.'));
      copilotHistory.pop(); // let the user retry the same question
      return;
    }
    const actionsHtml = (data.actions || []).length
      ? '<div class="cp-actions">' + data.actions.map(a =>
          `<span>${TOOL_LABELS[a.tool] || a.tool}${a.ok ? '' : ' ⚠️'}</span>`).join('') + '</div>'
      : '';
    appendCopilotMsg('cp-bot', escapeHtml(data.reply).replace(/\n/g, '<br>') + actionsHtml);
    copilotHistory.push({ role:'model', text: data.reply });
    // Shortlist may have changed — refresh badges
    loadSavedLinks();
  }catch(e){
    if(thinking) thinking.remove();
    appendCopilotMsg('cp-bot cp-err', '⚠️ ' + escapeHtml(e.message));
    copilotHistory.pop();
  }finally{
    input.disabled = false; btn.disabled = false;
    input.focus();
  }
}

// Floating launcher button
(function(){
  const b = document.createElement('button');
  b.id = 'copilotFab';
  b.title = 'Erez Assistant — ask anything';
  b.textContent = '🧠';
  b.onclick = toggleCopilot;
  document.body.appendChild(b);
})();

// ═══════════════ Marketing: kit generator + outreach campaign ═══════════════

function showMarketingKit(){
  const old = document.getElementById('mkOverlay');
  if(old){ old.remove(); return; }
  const overlay = document.createElement('div');
  overlay.id = 'mkOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <h2>📣 Marketing Kit <span style="font-weight:400;font-size:13px;color:var(--muted)">(for a product you sell)</span></h2>
        <button class="modal-close" onclick="document.getElementById('mkOverlay').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="mk-form">
          <label>Product you sell *<input id="mkProduct" type="text" placeholder='e.g. "Copper scrap, Grade A (Millberry)"'></label>
          <label>Details (specs, quality, quantities — only what is TRUE)<textarea id="mkDetails" rows="2" placeholder="e.g. 99.9% purity, 25MT monthly, ISO-certified supplier network"></textarea></label>
          <div class="mk-row">
            <label>Origin<input id="mkOrigin" type="text" placeholder="e.g. Singapore / mixed Asia"></label>
            <label>Terms<input id="mkTerms" type="text" placeholder="e.g. FOB Singapore, CIF on request"></label>
          </div>
          <button class="mk-generate" onclick="generateMarketingKit(this)">✨ Generate Kit</button>
        </div>
        <div id="mkResult"></div>
      </div>
    </div>`;
  overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  document.getElementById('mkProduct').focus();
}

function mkCopyBtn(text){
  return `<button class="mk-copy" onclick="navigator.clipboard.writeText(this.dataset.t).then(()=>{this.textContent='✓ Copied';setTimeout(()=>this.textContent='📋 Copy',1200)})" data-t="${escapeHtml(text)}">📋 Copy</button>`;
}

async function generateMarketingKit(btn){
  const product = document.getElementById('mkProduct').value.trim();
  if(!product){ alert('Enter the product you sell.'); return; }
  const result = document.getElementById('mkResult');
  btn.disabled = true; btn.textContent = '✨ Writing…';
  result.innerHTML = '<p class="empty" style="padding:10px">Generating your kit — a few seconds…</p>';
  try{
    const res = await fetch('/api/marketing-kit', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        product,
        details: document.getElementById('mkDetails').value.trim(),
        origin: document.getElementById('mkOrigin').value.trim(),
        terms: document.getElementById('mkTerms').value.trim()
      })
    });
    const kit = await res.json();
    if(!res.ok || kit.error) throw new Error(kit.error || 'generation failed');
    window._lastKit = { product, kit };
    const sec = (title, text) => `
      <div class="mk-section">
        <div class="mk-sec-head">${title}${mkCopyBtn(text)}</div>
        <div class="mk-sec-body">${escapeHtml(text).replace(/\n/g,'<br>')}</div>
      </div>`;
    result.innerHTML = `
      ${sec('🏷 Portal Listing Title', kit.listingTitle)}
      ${sec('📝 Portal Listing (TradeWheel / Alibaba / Go4WorldBusiness)', kit.listingBody)}
      ${sec('💼 LinkedIn Post', kit.linkedinPost)}
      ${sec('✉️ Outreach Email', 'Subject: ' + kit.outreachEmail.subject + '\n\n' + kit.outreachEmail.body)}
      <div class="mk-section"><div class="mk-sec-head">#️⃣ HS Code &amp; Buyer Keywords</div>
        <div class="mk-sec-body"><strong>${escapeHtml(kit.hsCode)}</strong> · ${kit.keywords.map(escapeHtml).join(' · ')}</div></div>
      <div class="mk-actions">
        <button class="saved-export-btn" onclick="exportKitWord()">📄 Export all to Word</button>
        <a class="saved-export-btn" style="text-decoration:none" href="https://www.tradewheel.com/sell/" target="_blank" rel="noopener">Post on TradeWheel ↗</a>
        <a class="saved-export-btn" style="text-decoration:none" href="https://www.go4worldbusiness.com/register" target="_blank" rel="noopener">Post on Go4WorldBusiness ↗</a>
      </div>`;
  }catch(e){
    result.innerHTML = `<p class="error">⚠️ ${escapeHtml(e.message)}</p>`;
  }finally{
    btn.disabled = false; btn.textContent = '✨ Generate Kit';
  }
}

function exportKitWord(){
  const lk = window._lastKit;
  if(!lk) return;
  const esc = escapeHtml;
  const k = lk.kit;
  const html = `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#222;margin:40px}h1{font-size:18pt;color:#1a2040}h2{font-size:13pt;color:#1a2040;margin-top:22px}</style></head><body>
<h1>Marketing Kit — ${esc(lk.product)}</h1>
<p style="color:#666;font-size:10pt">Generated by Erez Impex Pte Ltd on ${new Date().toLocaleDateString()}</p>
<h2>Portal Listing Title</h2><p>${esc(k.listingTitle)}</p>
<h2>Portal Listing</h2><p>${esc(k.listingBody).replace(/\n/g,'<br>')}</p>
<h2>LinkedIn Post</h2><p>${esc(k.linkedinPost).replace(/\n/g,'<br>')}</p>
<h2>Outreach Email</h2><p><b>Subject:</b> ${esc(k.outreachEmail.subject)}</p><p>${esc(k.outreachEmail.body).replace(/\n/g,'<br>')}</p>
<h2>HS Code &amp; Keywords</h2><p><b>${esc(k.hsCode)}</b> — ${k.keywords.map(esc).join(', ')}</p>
</body></html>`;
  const blob = new Blob(['﻿' + html], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = lk.product.replace(/[^a-z0-9]+/gi,'_').slice(0,40) + '_marketing_kit.doc';
  a.click();
  URL.revokeObjectURL(a.href);
}

// -- Outreach campaign: batch offers for shortlisted companies --
async function showCampaign(){
  const res = await fetch('/api/saved');
  const list = ((await res.json()).saved) || [];
  if(!list.length){ alert('Save some buyers to the shortlist first (☆ on buyer cards).'); return; }
  const old = document.getElementById('campOverlay');
  if(old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'campOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <h2>📣 Outreach Campaign</h2>
        <button class="modal-close" onclick="document.getElementById('campOverlay').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="mk-form">
          <label>Product you are offering *<input id="campProduct" type="text" placeholder='e.g. "Copper scrap, Grade A"'></label>
          <div class="camp-pick-head">Send to (${list.length} on shortlist — max 15):</div>
          <div class="camp-list">
            ${list.map(s => `<label class="camp-item"><input type="checkbox" value="${escapeHtml(s.link)}" checked>
              ${escapeHtml(s.title)} <span class="camp-meta">${escapeHtml(s.type||'')}${s.country ? ' · ' + escapeHtml(s.country) : ''}${s.email ? ' · ✉️' : ' · <i>no email found</i>'}</span></label>`).join('')}
          </div>
          <button class="mk-generate" onclick="runCampaign(this)">✨ Generate Personalized Emails</button>
        </div>
        <div id="campResult"></div>
      </div>
    </div>`;
  overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

async function runCampaign(btn){
  const product = document.getElementById('campProduct').value.trim();
  if(!product){ alert('Enter the product you are offering.'); return; }
  const links = [...document.querySelectorAll('.camp-item input:checked')].map(i => i.value).slice(0, 15);
  if(!links.length){ alert('Select at least one company.'); return; }
  const result = document.getElementById('campResult');
  btn.disabled = true; btn.textContent = '✨ Writing ' + links.length + ' emails…';
  result.innerHTML = '<p class="empty" style="padding:10px">Personalizing one email per company — about ' + links.length * 3 + ' seconds…</p>';
  try{
    const res = await fetch('/api/campaign', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ product, links })
    });
    const data = await res.json();
    if(!res.ok || data.error) throw new Error(data.error || 'campaign failed');
    window._lastCampaign = data;
    result.innerHTML = `
      <div class="mk-sec-head" style="margin-top:14px">✓ ${data.rows.length} emails ready
        <button class="saved-export-btn" onclick="exportCampaignExcel()">📊 Export to Excel</button></div>
      ${data.rows.map(r => `
        <div class="mk-section">
          <div class="mk-sec-head">${escapeHtml(r.company)}${r.email ? ' · <a href="mailto:' + escapeHtml(r.email) + '?subject=' + encodeURIComponent(r.subject) + '&body=' + encodeURIComponent(r.body) + '">✉️ Open in email</a>' : ' · <i>no email — find contact first</i>'}${mkCopyBtn('Subject: ' + r.subject + '\n\n' + r.body)}</div>
          <div class="mk-sec-body"><strong>${escapeHtml(r.subject)}</strong><br>${escapeHtml(r.body).replace(/\n/g,'<br>')}${r.error ? '<br>⚠️ ' + escapeHtml(r.error) : ''}</div>
        </div>`).join('')}`;
  }catch(e){
    result.innerHTML = `<p class="error">⚠️ ${escapeHtml(e.message)}</p>`;
  }finally{
    btn.disabled = false; btn.textContent = '✨ Generate Personalized Emails';
  }
}

function exportCampaignExcel(){
  const c = window._lastCampaign;
  if(!c || typeof XLSX === 'undefined') return;
  const rows = c.rows.map(r => ({
    'Company': r.company, 'Country': r.country, 'Email': r.email,
    'Subject': r.subject, 'Body': r.body, 'Website': r.link
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{wch:30},{wch:14},{wch:28},{wch:45},{wch:80},{wch:40}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Campaign');
  XLSX.writeFile(wb, 'sourceiq_campaign_' + new Date().toISOString().slice(0,10) + '.xlsx');
}

// ═══════════════ Live commodity prices ═══════════════
async function refreshCommodities(){
  const bar = document.getElementById('commodityBar');
  if(!bar) return;
  try{
    const data = await (await fetch('/api/commodity-prices')).json();
    const arrow = p => p > 0.01 ? '▲' : p < -0.01 ? '▼' : '▬';
    const cls = p => p > 0.01 ? 'cm-up' : p < -0.01 ? 'cm-down' : 'cm-flat';
    const live = (data.live || []).map(m => `
      <span class="cm-item" title="${escapeHtml(m.name)}: ${m.price} ${escapeHtml(m.unit)}${m.pricePerMT ? ' ≈ $' + m.pricePerMT.toLocaleString() + '/MT' : ''} (live)">
        <span class="cm-name">${escapeHtml(m.name)}</span>
        <span class="cm-price">${m.price.toLocaleString(undefined,{maximumFractionDigits:2})}<small> ${escapeHtml(m.unit.replace('USD',''))}</small></span>
        <span class="cm-chg ${cls(m.changePct)}">${arrow(m.changePct)} ${Math.abs(m.changePct).toFixed(1)}%</span>
      </span>`).join('');
    const manual = (data.manual || []).map(m => `
      <span class="cm-item cm-manual" title="${escapeHtml(m.name)} — reference price you maintain. Click to update.${m.updatedAt ? ' Updated ' + new Date(m.updatedAt).toLocaleDateString() : ''}" onclick="editManualPrice('${m.key}','${escapeHtml(m.name)}','${escapeHtml(m.unit)}')">
        <span class="cm-name">${escapeHtml(m.name)}</span>
        <span class="cm-price">${m.price != null ? m.price.toLocaleString() + '<small> ' + escapeHtml(m.unit.replace('USD/','/')) + '</small>' : '<em>set price</em>'}</span>
        <span class="cm-pencil">✎</span>
      </span>`).join('');
    bar.innerHTML = `<span class="cm-label">💹 Market</span>${live}${manual}
      <span class="cm-updated">${data.live && data.live.length ? 'live · ' + new Date(data.updatedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : 'prices unavailable'}</span>`;
    bar.style.display = 'flex';
  }catch(e){ bar.style.display = 'none'; }
}

async function editManualPrice(key, name, unit){
  const val = prompt(`Reference price for ${name} (${unit}) — enter the current market figure from your broker:`, '');
  if(val === null) return;
  await fetch('/api/commodity-manual', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key, price: val.replace(/[^\d.]/g,''), unit })
  });
  refreshCommodities();
}

refreshCommodities();
setInterval(refreshCommodities, 15 * 60 * 1000);

// ═══════════════ Shareable product catalog ═══════════════
async function refreshQuoteBadge(){
  try{
    const d = await (await fetch('/api/catalog/quotes')).json();
    const el = document.getElementById('quoteCount');
    if(el){ el.textContent = d.unread > 0 ? String(d.unread) : ''; el.classList.toggle('saved-count-attn', d.unread > 0); }
  }catch(e){}
}

let _catProducts = [];
async function showCatalog(){
  const old = document.getElementById('catOverlay');
  if(old){ old.remove(); return; }
  const cat = await (await fetch('/api/catalog')).json();
  const q = await (await fetch('/api/catalog/quotes')).json();
  _catProducts = cat.products || [];
  const shareUrl = location.origin + '/catalog.html';
  const overlay = document.createElement('div');
  overlay.id = 'catOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box modal-wide">
      <div class="modal-head">
        <h2>📗 Product Catalog</h2>
        <button class="modal-close" onclick="document.getElementById('catOverlay').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="cat-share">
          <span>Your public link:</span>
          <a href="${escapeHtml(shareUrl)}" target="_blank" rel="noopener">${escapeHtml(shareUrl)}</a>
          <button class="mk-copy" onclick="navigator.clipboard.writeText('${escapeHtml(shareUrl)}').then(()=>{this.textContent='✓ Copied';setTimeout(()=>this.textContent='📋 Copy link',1200)})">📋 Copy link</button>
        </div>
        ${q.quotes && q.quotes.length ? `
          <div class="cat-quotes">
            <div class="mk-sec-head">📨 Quote Requests (${q.unread} new)
              ${q.unread ? '<button class="mk-copy" onclick="markQuotesRead(this)">Mark all read</button>' : ''}</div>
            ${q.quotes.slice(0,20).map(r=>`
              <div class="quote-req ${r.read?'':'quote-new'}">
                <strong>${escapeHtml(r.name)}</strong>${r.company?' · '+escapeHtml(r.company):''}${r.country?' · '+escapeHtml(r.country):''}
                <span class="quote-when">${new Date(r.at).toLocaleString()}</span>
                <div class="quote-body">${r.product?'<b>'+escapeHtml(r.product)+'</b> — ':''}${escapeHtml(r.message||'')}</div>
                <div class="quote-contact">↩ <a href="mailto:${escapeHtml(r.contact)}">${escapeHtml(r.contact)}</a></div>
              </div>`).join('')}
          </div>` : ''}
        <div class="mk-form" style="margin-top:14px">
          <div class="mk-sec-head">Catalog details</div>
          <div class="mk-row">
            <label>Company name<input id="catCompany" value="${escapeHtml(cat.company||'')}"></label>
            <label>Contact email<input id="catEmail" value="${escapeHtml(cat.email||'')}"></label>
          </div>
          <label>Tagline<input id="catTagline" value="${escapeHtml(cat.tagline||'')}"></label>
          <div class="mk-row">
            <label>Phone<input id="catPhone" value="${escapeHtml(cat.phone||'')}"></label>
            <label>WhatsApp<input id="catWhatsapp" value="${escapeHtml(cat.whatsapp||'')}"></label>
          </div>
          <div class="mk-sec-head" style="margin-top:6px">Products <button class="mk-copy" onclick="addCatProduct()">＋ Add product</button></div>
          <div id="catProducts"></div>
          <button class="mk-generate" onclick="saveCatalog(this)">💾 Save Catalog</button>
        </div>
      </div>
    </div>`;
  overlay.addEventListener('click', e => { if(e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  renderCatProducts();
}

function renderCatProducts(){
  const wrap = document.getElementById('catProducts');
  if(!wrap) return;
  wrap.innerHTML = _catProducts.map((p,i)=>`
    <div class="cat-prod">
      <div class="cat-prod-head">Product ${i+1} <button class="saved-remove" onclick="removeCatProduct(${i})">✕</button></div>
      <input placeholder="Product name *" value="${escapeHtml(p.name||'')}" oninput="_catProducts[${i}].name=this.value">
      <textarea placeholder="Description" rows="2" oninput="_catProducts[${i}].description=this.value">${escapeHtml(p.description||'')}</textarea>
      <div class="mk-row">
        <input placeholder="Specs (e.g. 99.9% purity)" value="${escapeHtml(p.specs||'')}" oninput="_catProducts[${i}].specs=this.value">
        <input placeholder="Origin" value="${escapeHtml(p.origin||'')}" oninput="_catProducts[${i}].origin=this.value">
        <input placeholder="Terms (e.g. FOB)" value="${escapeHtml(p.terms||'')}" oninput="_catProducts[${i}].terms=this.value">
      </div>
    </div>`).join('') || '<p class="empty" style="padding:8px 0">No products yet — click "＋ Add product".</p>';
}
function addCatProduct(){ _catProducts.push({name:'',description:'',specs:'',origin:'',terms:''}); renderCatProducts(); }
function removeCatProduct(i){ _catProducts.splice(i,1); renderCatProducts(); }

async function saveCatalog(btn){
  btn.disabled = true; btn.textContent = '💾 Saving…';
  const body = {
    company: document.getElementById('catCompany').value.trim(),
    tagline: document.getElementById('catTagline').value.trim(),
    email: document.getElementById('catEmail').value.trim(),
    phone: document.getElementById('catPhone').value.trim(),
    whatsapp: document.getElementById('catWhatsapp').value.trim(),
    products: _catProducts.filter(p=>p.name && p.name.trim())
  };
  await fetch('/api/catalog',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  btn.disabled = false; btn.textContent = '✓ Saved';
  setTimeout(()=>{ btn.textContent='💾 Save Catalog'; }, 1500);
}

async function markQuotesRead(btn){
  await fetch('/api/catalog/quotes/read',{method:'POST'});
  refreshQuoteBadge();
  btn.textContent = '✓';
}

refreshQuoteBadge();
setInterval(refreshQuoteBadge, 5 * 60 * 1000);

// ═══════════════ Company Brain: "you know this company" badges ═══════════════
// After results render, ask the server which domains it has permanent memory of
// and tag those cards — so a familiar supplier is recognized instantly.
async function annotateKnownCompanies(){
  const entries = Object.entries(cardRegistry)
    .filter(([id, r]) => r.displayLink && document.getElementById(id) && !document.getElementById(id).querySelector('.brain-badge'));
  if(!entries.length) return;
  const hosts = [...new Set(entries.map(([, r]) => r.displayLink.toLowerCase().replace(/^www\./, '')))];
  try{
    const res = await fetch('/api/company-brain/lookup', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ hosts })
    });
    const { found } = await res.json();
    if(!found) return;
    for(const [id, r] of entries){
      const rec = found[(r.displayLink || '').toLowerCase().replace(/^www\./, '')];
      if(!rec) continue;
      const card = document.getElementById(id);
      const row = card && card.querySelector('.badge-row');
      if(!row || row.querySelector('.brain-badge')) continue;
      const tip = 'Known company — first seen ' + (rec.firstSeen || '?') +
        (rec.trustRating ? ' · trust: ' + rec.trustRating : '') +
        (rec.events && rec.events.length ? '\n' + rec.events.join('\n') : '');
      const b = document.createElement('span');
      b.className = 'badge brain-badge';
      b.title = tip;
      b.textContent = '🧠 Known';
      row.appendChild(b);
    }
  }catch(e){}
}

// Load the shared shortlist state on startup
loadSavedLinks();
