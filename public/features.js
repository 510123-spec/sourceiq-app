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

// Load the shared shortlist state on startup
loadSavedLinks();
