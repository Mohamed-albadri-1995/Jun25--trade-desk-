'use strict';

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════
const API = '';   // same origin

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error || JSON.stringify(j); } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

function $(id) { return document.getElementById(id); }

function etToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function fmt(v, dec = 2) {
  if (v == null || v === '') return '—';
  const n = parseFloat(v);
  return isNaN(n) ? v : n.toFixed(dec);
}

function fmtPct(v) { if (v == null) return '—'; return (parseFloat(v) >= 0 ? '+' : '') + parseFloat(v).toFixed(2) + '%'; }

function colorClass(v) {
  if (v == null) return '';
  return parseFloat(v) > 0 ? 'up' : parseFloat(v) < 0 ? 'dn' : 'flat';
}

function biasBadge(b) {
  if (!b) return '<span class="bias bias-unkn">—</span>';
  const up = b.toUpperCase();
  if (up.includes('BULL') || up === 'B') return `<span class="bias bias-bull">${up.replace('BULLISH','BULL')}</span>`;
  if (up.includes('BEAR') || up === 'S') return `<span class="bias bias-bear">${up.replace('BEARISH','BEAR')}</span>`;
  if (up === 'NEUTRAL' || up === 'N') return `<span class="bias bias-neut">NEUT</span>`;
  return `<span class="bias bias-unkn">${up.substring(0,6)}</span>`;
}

function setStatus(id, msg, type) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.className = 'io-status' + (type ? ' ' + type : '');
}

function downloadCSV(text, filename) {
  const blob = new Blob([text], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function buildCSV(headers, rows) {
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const lines = [headers.join(',')];
  rows.forEach(r => lines.push(headers.map(h => esc(r[h])).join(',')));
  return lines.join('\r\n');
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

// ══════════════════════════════════════════════════════════════════
// STATUS BAR
// ══════════════════════════════════════════════════════════════════
async function refreshStatus() {
  try {
    const s = await api('/api/status');
    $('sb-time').textContent = s.time || '--:--';
    $('sb-date').textContent = s.date || '';
    const modeEl = $('sb-mode');
    modeEl.textContent = s.mode === 'auto' ? '● AUTO' : '○ MANUAL';
    modeEl.style.color = s.mode === 'auto' ? 'var(--green)' : 'var(--muted)';

    // Settings tab
    const ni = $('info-node'); if (ni) ni.textContent = s.node || '--';
    const ti = $('info-time'); if (ti) ti.textContent = s.time || '--';
    const di = $('info-date'); if (di) di.textContent = s.date || '--';
    const wi = $('info-weekday'); if (wi) wi.textContent = s.weekday ? 'Yes' : 'No';
    const sa = $('setting-auto'); if (sa) sa.checked = s.mode === 'auto';
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════
// TAB + SUB-TAB SWITCHING
// ══════════════════════════════════════════════════════════════════
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = $('pane-' + btn.dataset.tab);
      if (pane) pane.classList.add('active');
      if (btn.dataset.tab === 'market') loadMarket();
      if (btn.dataset.tab === 'screener') loadScreener();
    });
  });

  document.querySelectorAll('.sub-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.sub-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = $('sub-' + btn.dataset.sub);
      if (pane) pane.classList.add('active');
      if (btn.dataset.sub === 'r1') loadR1();
      if (btn.dataset.sub === 'r2') loadR2();
      if (btn.dataset.sub === 'r3') loadR3();
      if (btn.dataset.sub === 'merged') loadMerged();
    });
  });
}

// ══════════════════════════════════════════════════════════════════
// MARKET TAB (R2)
// ══════════════════════════════════════════════════════════════════
const REGIME_ICONS = {
  'bull-trend':      '🚀', 'bull-pullback':   '↩', 'bull-reversal':  '🔄',
  'bear-trend':      '📉', 'bear-bounce':     '↪', 'bear-reversal':  '🔄',
  'range-top':       '⬛', 'range-bottom':    '⬛', 'range-mid':      '➡',
  'breakout-bull':   '⬆', 'breakout-bear':   '⬇',
  'transition-bull': '🌤', 'transition-bear': '⛅',
  'chop':            '〰', 'crash':            '💥', 'recovery':       '🌱'
};

let mktSnapshots = {};
let mktActiveSlot = '';

async function loadMarket() {
  const dateEl = $('mkt-date');
  const date = dateEl && dateEl.value ? dateEl.value : etToday();
  if (dateEl && !dateEl.value) dateEl.value = date;
  setStatus('mkt-status', 'Loading…');
  try {
    const data = await api(`/api/snapshots/${date}`);
    mktSnapshots = data;
    const slots = Object.keys(data).sort();
    const slotSel = $('mkt-slot-select');
    slotSel.innerHTML = '';
    slots.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      slotSel.appendChild(opt);
    });
    if (slots.length) {
      mktActiveSlot = slots[slots.length - 1];
      slotSel.value = mktActiveSlot;
      renderMarketSnap(data[mktActiveSlot]);
      setStatus('mkt-status', `${slots.length} slots loaded`, 'ok');
    } else {
      renderMarketSnap(null);
      setStatus('mkt-status', 'No snapshots for this date');
    }
  } catch (e) { setStatus('mkt-status', e.message, 'err'); }
}

function renderMarketSnap(snap) {
  if (!snap) {
    $('mkt-regime').innerHTML = '<div class="empty">No snapshot data</div>';
    $('mkt-bias').innerHTML = '';
    $('mkt-indices').innerHTML = '';
    $('mkt-sectors').innerHTML = '';
    return;
  }

  // Regime
  const slug = (snap.regime && snap.regime.slug) || 'chop';
  const icon = REGIME_ICONS[slug] || '•';
  const color = snap.regime && snap.regime.color ? snap.regime.color : '#94a3b8';
  $('mkt-regime').innerHTML = `
    <div class="regime-icon">${icon}</div>
    <div>
      <div class="regime-name" style="color:${color}">${(snap.regime && snap.regime.label) || slug}</div>
      <div class="regime-sub">Regime • ${snap.slot || ''} • ${snap.capturedAt || ''}</div>
      <div style="margin-top:6px">${biasBadge(snap.regime && snap.regime.bias)}</div>
    </div>`;

  // Bias signals
  const lt = snap.longTerm || {}, mt = snap.midTerm || {}, st = snap.shortTerm || {};
  $('mkt-bias').innerHTML = `
    <div class="stat-row"><span class="stat-label">Long Term (SPY trend)</span><span>${biasBadge(lt.result)} <span class="dim" style="font-size:10px">${lt.label || ''}</span></span></div>
    <div class="stat-row"><span class="stat-label">Mid Term (QQQ stage)</span><span>${biasBadge(mt.result)} <span class="dim" style="font-size:10px">${mt.stageLabel || ''}</span></span></div>
    <div class="stat-row"><span class="stat-label">Short Term (breadth)</span><span>${biasBadge(st.result)} <span class="dim" style="font-size:10px">${st.signals ? st.signals.length + ' signals' : ''}</span></span></div>
  `;

  // Indices
  const idx = snap.indices || {};
  const tickers = ['SPY','QQQ','IWM','DIA','VIX'];
  $('mkt-indices').innerHTML = tickers.map(t => {
    const d = idx[t] || {};
    const chg = d.change != null ? parseFloat(d.change) : null;
    const cc = chg != null ? (chg > 0 ? 'up' : chg < 0 ? 'dn' : 'flat') : '';
    return `<div class="idx-card">
      <div class="idx-ticker">${t}</div>
      <div class="idx-price">${fmt(d.price)}</div>
      <div class="idx-chg ${cc}">${chg != null ? (chg > 0 ? '+' : '') + chg.toFixed(2) + '%' : '—'}</div>
    </div>`;
  }).join('');

  // Sectors
  const secs = snap.sectors || {};
  $('mkt-sectors').innerHTML = Object.keys(secs).sort().map(name => {
    const s = secs[name];
    const bias = s.bias || 'NEUTRAL';
    const cc = bias.includes('BULL') ? 'up' : bias.includes('BEAR') ? 'dn' : 'flat';
    return `<div class="sector-cell">
      <div class="sector-name dim">${name.replace('SPDR ','').replace(' ETF','').substring(0,18)}</div>
      <div class="sector-val ${cc}">${bias.replace('BULLISH','BULL').replace('BEARISH','BEAR').replace('NEUTRAL','NEUT')}</div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════
// SCREENER TAB (R1 live view)
// ══════════════════════════════════════════════════════════════════
async function loadScreener() {
  const dateEl = $('scr-date');
  const date = dateEl && dateEl.value ? dateEl.value : etToday();
  if (dateEl && !dateEl.value) dateEl.value = date;
  setStatus('scr-status', 'Loading…');
  try {
    const data = await api(`/api/screener/${date}`);
    renderScreenerTable($('scr-table-wrap'), data);
    const n = data && data.rows ? Object.keys(data.rows).length : 0;
    setStatus('scr-status', n ? `${n} stocks — ${data.capturedAt || ''}` : 'No data', n ? 'ok' : '');
  } catch (e) { setStatus('scr-status', e.message, 'err'); }
}

function renderScreenerTable(container, data) {
  if (!data || !data.rows || !Object.keys(data.rows).length) {
    container.innerHTML = '<div class="empty">No screener data for this date.</div>';
    return;
  }
  const tickers = Object.keys(data.rows).sort();
  container.innerHTML = `<table>
    <thead><tr>
      <th>Ticker</th><th>Screeners</th><th>Price</th><th>Gap%</th><th>RVOL</th>
      <th>ATR</th><th>PM High</th><th>PM Low</th><th>Sector</th>
      <th>ST Bias</th><th>LT Bias</th><th>Sec Bias</th>
    </tr></thead>
    <tbody>${tickers.map(ticker => {
      const row = data.rows[ticker];
      const s = row.stock || {};
      const ctx = row.context || {};
      const chg = s.changePct != null ? parseFloat(s.changePct) : null;
      const cc = chg != null ? (chg > 0 ? 'up' : chg < 0 ? 'dn' : 'flat') : '';
      return `<tr>
        <td><strong>${ticker}</strong></td>
        <td class="dim">${(row.screenerKeys || []).join(', ')}</td>
        <td class="mono">${fmt(s.price)}</td>
        <td class="mono ${cc}">${fmtPct(s.gapPct)}</td>
        <td class="mono">${fmt(s.rvol, 1)}x</td>
        <td class="mono">${fmt(s.atr)}</td>
        <td class="mono">${fmt(s.pmHigh)}</td>
        <td class="mono">${fmt(s.pmLow)}</td>
        <td class="dim">${s.sector || '—'}</td>
        <td>${biasBadge(ctx.shortTerm)}</td>
        <td>${biasBadge(ctx.longTerm)}</td>
        <td>${biasBadge(ctx.secBias)}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// ══════════════════════════════════════════════════════════════════
// DATA — R1
// ══════════════════════════════════════════════════════════════════
const R1_HEADERS = [
  'date','slot','captured_at','complete',
  'ticker','screeners','price','open','change_pct','prev_close','gap_pct','vwap',
  'ema9','ema13','ema20','ema50','sma5',
  'month_high','month_low','day_high','day_low','atr',
  'pm_high','pm_low','pm_range','adr_pct','month_range_pos','pm_adr_ratio',
  'mcap','float_shares','short_float','rvol','sector','industry',
  'st_bias','lt_bias','lt_label','mid_term','mid_term_label',
  'sec_bias','sec_score','market_bias'
];

async function loadR1() {
  const dateEl = $('r1-date');
  const date = dateEl && dateEl.value ? dateEl.value : etToday();
  if (dateEl && !dateEl.value) dateEl.value = date;
  const container = $('r1-table');
  container.innerHTML = '<div class="empty"><span class="spinner"></span> Loading…</div>';
  setStatus('r1-status', '');
  try {
    const data = await api(`/api/screener/${date}`);
    renderScreenerTable(container, data);
    const n = data && data.rows ? Object.keys(data.rows).length : 0;
    setStatus('r1-status', n ? `${n} stocks` : 'No data', n ? 'ok' : '');
  } catch (e) { container.innerHTML = '<div class="empty">Error loading R1.</div>'; setStatus('r1-status', e.message, 'err'); }
}

async function exportR1() {
  setStatus('r1-status', 'Building CSV…');
  try {
    const all = await api('/api/screener');
    const rows = [];
    Object.keys(all).sort().forEach(date => {
      const day = all[date];
      if (!day || !day.rows) return;
      Object.keys(day.rows).forEach(ticker => {
        const row = day.rows[ticker], s = row.stock || {}, ctx = row.context || {};
        rows.push({
          date, slot: day.slot, captured_at: day.capturedAt, complete: day.complete,
          ticker, screeners: (row.screenerKeys || []).join('|'),
          price: s.price, open: s.open, change_pct: s.changePct, prev_close: s.prevClose,
          gap_pct: s.gapPct, vwap: s.vwap,
          ema9: s.ema9, ema13: s.ema13, ema20: s.ema20, ema50: s.ema50, sma5: s.sma5,
          month_high: s.monthHigh, month_low: s.monthLow, day_high: s.dayHigh, day_low: s.dayLow, atr: s.atr,
          pm_high: s.pmHigh, pm_low: s.pmLow, pm_range: s.pmRange, adr_pct: s.adrPct,
          month_range_pos: s.monthRangePos, pm_adr_ratio: s.pmAdrRatio,
          mcap: s.mcap, float_shares: s.floatShares, short_float: s.shortFloat, rvol: s.rvol,
          sector: s.sector, industry: s.industry,
          st_bias: ctx.shortTerm, lt_bias: ctx.longTerm, lt_label: ctx.longTermLabel,
          mid_term: ctx.midTerm, mid_term_label: ctx.midTermLabel,
          sec_bias: ctx.secBias, sec_score: ctx.secScore, market_bias: ctx.marketBias
        });
      });
    });
    downloadCSV(buildCSV(R1_HEADERS, rows), 'r1-screener.csv');
    setStatus('r1-status', `Exported ${rows.length} rows`, 'ok');
  } catch (e) { setStatus('r1-status', e.message, 'err'); }
}

// ══════════════════════════════════════════════════════════════════
// DATA — R2
// ══════════════════════════════════════════════════════════════════
let r2Snapshots = {};
let r2ActiveSlot = '';

async function loadR2() {
  const dateEl = $('r2-date');
  const date = dateEl && dateEl.value ? dateEl.value : etToday();
  if (dateEl && !dateEl.value) dateEl.value = date;
  const slotsEl = $('r2-slots');
  slotsEl.innerHTML = '';
  $('r2-snap-detail').innerHTML = '';
  setStatus('r2-status', 'Loading…');
  try {
    const data = await api(`/api/snapshots/${date}`);
    r2Snapshots = data;
    const slots = Object.keys(data).sort();
    if (!slots.length) { setStatus('r2-status', 'No snapshots for this date'); return; }
    slotsEl.innerHTML = slots.map(s => `<div class="slot-pill has-data${s === slots[slots.length-1] ? ' active' : ''}" data-slot="${s}">${s}</div>`).join('');
    slotsEl.querySelectorAll('.slot-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        slotsEl.querySelectorAll('.slot-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        r2ActiveSlot = pill.dataset.slot;
        renderR2Snap(r2Snapshots[r2ActiveSlot]);
      });
    });
    r2ActiveSlot = slots[slots.length - 1];
    renderR2Snap(data[r2ActiveSlot]);
    setStatus('r2-status', `${slots.length} slots`, 'ok');
  } catch (e) { setStatus('r2-status', e.message, 'err'); }
}

function renderR2Snap(snap) {
  const el = $('r2-snap-detail');
  if (!snap) { el.innerHTML = '<div class="empty">No data for this slot.</div>'; return; }
  const idx = snap.indices || {};
  const tickers = Object.keys(idx);
  const secs = snap.sectors || {};
  el.innerHTML = `
    <div class="snap-grid">
      <div class="snap-block">
        <div class="snap-block-title">Regime</div>
        <div style="font-size:18px">${REGIME_ICONS[snap.regime && snap.regime.slug] || '•'}</div>
        <div style="font-weight:700;margin-top:4px">${(snap.regime && snap.regime.label) || '—'}</div>
        <div class="dim" style="font-size:10px;margin-top:2px">${snap.regime && snap.regime.slug || ''}</div>
      </div>
      <div class="snap-block">
        <div class="snap-block-title">Bias</div>
        <div class="stat-row"><span class="stat-label">LT</span>${biasBadge(snap.longTerm && snap.longTerm.result)}</div>
        <div class="stat-row"><span class="stat-label">MT</span>${biasBadge(snap.midTerm && snap.midTerm.result)}</div>
        <div class="stat-row"><span class="stat-label">ST</span>${biasBadge(snap.shortTerm && snap.shortTerm.result)}</div>
      </div>
      <div class="snap-block">
        <div class="snap-block-title">Meta</div>
        <div class="stat-row"><span class="stat-label">Slot</span><span class="mono">${snap.slot || '—'}</span></div>
        <div class="stat-row"><span class="stat-label">Time</span><span class="mono">${snap.capturedAt || '—'}</span></div>
        <div class="stat-row"><span class="stat-label">Complete</span><span>${snap.complete ? '<span style="color:var(--green)">Yes</span>' : '<span style="color:var(--red)">No</span>'}</span></div>
      </div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="card-title">Indices</div>
      <table><thead><tr><th>Ticker</th><th>Price</th><th>Chg%</th><th>RVOL</th><th>ATR</th></tr></thead>
      <tbody>${tickers.map(t => {
        const d = idx[t] || {};
        const chg = d.change != null ? parseFloat(d.change) : null;
        return `<tr><td><strong>${t}</strong></td><td class="mono">${fmt(d.price)}</td>
          <td class="mono ${colorClass(chg)}">${chg != null ? (chg>0?'+':'')+chg.toFixed(2)+'%' : '—'}</td>
          <td class="mono">${d.rvol != null ? parseFloat(d.rvol).toFixed(1)+'x' : '—'}</td>
          <td class="mono">${fmt(d.atr)}</td></tr>`;
      }).join('')}</tbody></table>
    </div>
    <div class="card">
      <div class="card-title">Sectors</div>
      <div class="sector-grid">${Object.keys(secs).sort().map(name => {
        const s = secs[name];
        const cc = (s.bias||'').includes('BULL') ? 'up' : (s.bias||'').includes('BEAR') ? 'dn' : 'flat';
        return `<div class="sector-cell">
          <div class="sector-name dim">${name.replace('SPDR ','').replace(' ETF','').substring(0,20)}</div>
          <div class="sector-val ${cc}" style="font-size:10px">${(s.bias||'NEUT').replace('BULLISH','BULL').replace('BEARISH','BEAR').replace('NEUTRAL','NEUT')}</div>
          ${s.score != null ? `<div class="dim" style="font-size:9px">${parseFloat(s.score).toFixed(1)}</div>` : ''}
        </div>`;
      }).join('')}</div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════
// DATA — R3 (EOD)
// ══════════════════════════════════════════════════════════════════
const R3_HEADERS = [
  'date','ticker',
  'entry35','hh35','ll35','down_r35','up_r35',
  'entry40','hh40','ll40','down_r40','up_r40',
  'eod_atr','eod_atr_source','last_bar','fetched_at','eod_status'
];

async function loadR3() {
  const dateEl = $('r3-date');
  const date = dateEl && dateEl.value ? dateEl.value : etToday();
  if (dateEl && !dateEl.value) dateEl.value = date;
  const container = $('r3-table');
  container.innerHTML = '<div class="empty"><span class="spinner"></span> Loading…</div>';
  setStatus('r3-status', '');
  try {
    const data = await api(`/api/eod/${date}`);
    if (!data || !data.rows || !Object.keys(data.rows).length) {
      container.innerHTML = '<div class="empty">No EOD data for this date.</div>';
      setStatus('r3-status', 'No data');
      return;
    }
    const tickers = Object.keys(data.rows).sort();
    container.innerHTML = `<table>
      <thead><tr>
        <th>Ticker</th><th>Status</th>
        <th>Entry35</th><th>HH35</th><th>LL35</th><th>↑R35</th><th>↓R35</th>
        <th>Entry40</th><th>HH40</th><th>LL40</th><th>↑R40</th><th>↓R40</th>
        <th>EOD ATR</th><th>Src</th><th>Last Bar</th>
      </tr></thead>
      <tbody>${tickers.map(ticker => {
        const r = data.rows[ticker];
        const stOk = r.status === 'ok';
        const stCls = stOk ? 'up' : r.status === 'partial_data' ? '' : 'dn';
        return `<tr>
          <td><strong>${ticker}</strong></td>
          <td class="${stCls} dim">${r.status || '—'}</td>
          <td class="mono">${fmt(r.entry35)}</td>
          <td class="mono">${fmt(r.hh35)}</td>
          <td class="mono">${fmt(r.ll35)}</td>
          <td class="mono up">${r.upR35 != null ? '+'+fmt(r.upR35,2)+'R' : '—'}</td>
          <td class="mono dn">${r.downR35 != null ? '-'+fmt(r.downR35,2)+'R' : '—'}</td>
          <td class="mono">${fmt(r.entry40)}</td>
          <td class="mono">${fmt(r.hh40)}</td>
          <td class="mono">${fmt(r.ll40)}</td>
          <td class="mono up">${r.upR40 != null ? '+'+fmt(r.upR40,2)+'R' : '—'}</td>
          <td class="mono dn">${r.downR40 != null ? '-'+fmt(r.downR40,2)+'R' : '—'}</td>
          <td class="mono">${fmt(r.atr)}</td>
          <td class="dim">${r.atrSource || '—'}</td>
          <td class="mono dim">${r.lastBarTime || '—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
    setStatus('r3-status', `${tickers.length} tickers — ${data.capturedAt || ''}`, 'ok');
  } catch (e) {
    container.innerHTML = '<div class="empty">Error loading R3.</div>';
    setStatus('r3-status', e.message, 'err');
  }
}

async function runR3() {
  const dateEl = $('r3-date');
  const date = dateEl && dateEl.value ? dateEl.value : etToday();
  setStatus('r3-status', 'Running EOD…');
  const btn = $('r3-run');
  btn.disabled = true;
  try {
    await api('/api/eod/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }) });
    setStatus('r3-status', 'Done — reloading…', 'ok');
    await loadR3();
  } catch (e) { setStatus('r3-status', e.message, 'err'); }
  btn.disabled = false;
}

async function exportR3() {
  setStatus('r3-status', 'Building CSV…');
  try {
    const all = await api('/api/eod');
    const rows = [];
    Object.keys(all).sort().forEach(date => {
      const day = all[date];
      if (!day || !day.rows) return;
      Object.keys(day.rows).forEach(ticker => {
        const r = day.rows[ticker];
        rows.push({
          date, ticker,
          entry35: r.entry35, hh35: r.hh35, ll35: r.ll35, down_r35: r.downR35, up_r35: r.upR35,
          entry40: r.entry40, hh40: r.hh40, ll40: r.ll40, down_r40: r.downR40, up_r40: r.upR40,
          eod_atr: r.atr, eod_atr_source: r.atrSource, last_bar: r.lastBarTime,
          fetched_at: r.fetchedAt, eod_status: r.status
        });
      });
    });
    downloadCSV(buildCSV(R3_HEADERS, rows), 'r3-eod.csv');
    setStatus('r3-status', `Exported ${rows.length} rows`, 'ok');
  } catch (e) { setStatus('r3-status', e.message, 'err'); }
}

// ══════════════════════════════════════════════════════════════════
// DATA — MERGED (R1 + R3 + R2)
// ══════════════════════════════════════════════════════════════════
const MERGED_HEADERS = [
  // R1
  'date','slot','captured_at','complete',
  'ticker','screeners','price','open','change_pct','prev_close','gap_pct','vwap',
  'ema9','ema13','ema20','ema50','sma5',
  'month_high','month_low','day_high','day_low','atr',
  'pm_high','pm_low','pm_range','adr_pct','month_range_pos','pm_adr_ratio',
  'mcap','float_shares','short_float','rvol','sector','industry',
  'st_bias','lt_bias','lt_label','mid_term','mid_term_label',
  'sec_bias','sec_score','market_bias',
  // R3
  'entry35','hh35','ll35','down_r35','up_r35',
  'entry40','hh40','ll40','down_r40','up_r40',
  'eod_atr','eod_atr_source','last_bar','fetched_at','eod_status',
  // R2 @ 09:35
  'snap935_lt','snap935_mt','snap935_st','snap935_regime','snap935_sec_bias',
  // R2 @ 09:40
  'snap940_lt','snap940_mt','snap940_st','snap940_regime','snap940_sec_bias'
];

function buildMergedRows(r1All, r3All, r2All) {
  const rows = [];
  Object.keys(r1All).sort().forEach(date => {
    const r1Day = r1All[date];
    if (!r1Day || !r1Day.rows) return;
    const r3Day = r3All[date] || {};
    const r3Rows = r3Day.rows || {};
    const r2Date = r2All[date] || {};
    const snap935 = r2Date['09:35'] || null;
    const snap940 = r2Date['09:40'] || null;

    Object.keys(r1Day.rows).forEach(ticker => {
      const row = r1Day.rows[ticker];
      const s = row.stock || {};
      const ctx = row.context || {};
      const r3 = r3Rows[ticker] || {};
      const sec = s.sector || '';
      const sb935 = snap935 && snap935.sectors && snap935.sectors[sec] ? snap935.sectors[sec].bias : null;
      const sb940 = snap940 && snap940.sectors && snap940.sectors[sec] ? snap940.sectors[sec].bias : null;
      rows.push({
        // R1
        date, slot: r1Day.slot, captured_at: r1Day.capturedAt, complete: r1Day.complete,
        ticker, screeners: (row.screenerKeys || []).join('|'),
        price: s.price, open: s.open, change_pct: s.changePct, prev_close: s.prevClose,
        gap_pct: s.gapPct, vwap: s.vwap,
        ema9: s.ema9, ema13: s.ema13, ema20: s.ema20, ema50: s.ema50, sma5: s.sma5,
        month_high: s.monthHigh, month_low: s.monthLow, day_high: s.dayHigh, day_low: s.dayLow, atr: s.atr,
        pm_high: s.pmHigh, pm_low: s.pmLow, pm_range: s.pmRange, adr_pct: s.adrPct,
        month_range_pos: s.monthRangePos, pm_adr_ratio: s.pmAdrRatio,
        mcap: s.mcap, float_shares: s.floatShares, short_float: s.shortFloat, rvol: s.rvol,
        sector: s.sector, industry: s.industry,
        st_bias: ctx.shortTerm, lt_bias: ctx.longTerm, lt_label: ctx.longTermLabel,
        mid_term: ctx.midTerm, mid_term_label: ctx.midTermLabel,
        sec_bias: ctx.secBias, sec_score: ctx.secScore, market_bias: ctx.marketBias,
        // R3
        entry35: r3.entry35, hh35: r3.hh35, ll35: r3.ll35, down_r35: r3.downR35, up_r35: r3.upR35,
        entry40: r3.entry40, hh40: r3.hh40, ll40: r3.ll40, down_r40: r3.downR40, up_r40: r3.upR40,
        eod_atr: r3.atr, eod_atr_source: r3.atrSource, last_bar: r3.lastBarTime,
        fetched_at: r3.fetchedAt, eod_status: r3.status,
        // R2 @ 09:35
        snap935_lt: snap935 && snap935.longTerm ? snap935.longTerm.result : null,
        snap935_mt: snap935 && snap935.midTerm ? snap935.midTerm.result : null,
        snap935_st: snap935 && snap935.shortTerm ? snap935.shortTerm.result : null,
        snap935_regime: snap935 && snap935.regime ? snap935.regime.slug : null,
        snap935_sec_bias: sb935,
        // R2 @ 09:40
        snap940_lt: snap940 && snap940.longTerm ? snap940.longTerm.result : null,
        snap940_mt: snap940 && snap940.midTerm ? snap940.midTerm.result : null,
        snap940_st: snap940 && snap940.shortTerm ? snap940.shortTerm.result : null,
        snap940_regime: snap940 && snap940.regime ? snap940.regime.slug : null,
        snap940_sec_bias: sb940
      });
    });
  });
  return rows;
}

async function loadMerged() {
  const dateEl = $('merged-date');
  const date = dateEl && dateEl.value ? dateEl.value : etToday();
  if (dateEl && !dateEl.value) dateEl.value = date;
  const container = $('merged-table');
  container.innerHTML = '<div class="empty"><span class="spinner"></span> Loading…</div>';
  setStatus('merged-status', '');
  try {
    const [r1All, r3All, r2All] = await Promise.all([
      api('/api/screener'), api('/api/eod'), api('/api/snapshots')
    ]);
    // Build all merged rows then filter to selected date for display
    const allRows = buildMergedRows(
      { [date]: r1All[date] },
      { [date]: r3All[date] },
      { [date]: r2All[date] }
    );
    if (!allRows.length) {
      container.innerHTML = '<div class="empty">No data for this date.</div>';
      setStatus('merged-status', 'No data');
      return;
    }
    container.innerHTML = `<table>
      <thead><tr>
        <th>Ticker</th><th>Sector</th><th>Price</th><th>Gap%</th><th>RVOL</th><th>ATR</th>
        <th>↑R40</th><th>↓R40</th><th>EOD</th>
        <th>935 LT</th><th>935 MT</th><th>935 Reg</th><th>935 Sec</th>
        <th>940 LT</th><th>940 MT</th><th>940 Reg</th><th>940 Sec</th>
      </tr></thead>
      <tbody>${allRows.map(r => `<tr>
        <td><strong>${r.ticker}</strong></td>
        <td class="dim" style="max-width:100px;overflow:hidden;text-overflow:ellipsis">${r.sector || '—'}</td>
        <td class="mono">${fmt(r.price)}</td>
        <td class="mono ${colorClass(r.gap_pct)}">${fmtPct(r.gap_pct)}</td>
        <td class="mono">${r.rvol != null ? parseFloat(r.rvol).toFixed(1)+'x' : '—'}</td>
        <td class="mono">${fmt(r.atr)}</td>
        <td class="mono up">${r.up_r40 != null ? '+'+fmt(r.up_r40,2)+'R' : '—'}</td>
        <td class="mono dn">${r.down_r40 != null ? '-'+fmt(r.down_r40,2)+'R' : '—'}</td>
        <td class="dim">${r.eod_status || '—'}</td>
        <td>${biasBadge(r.snap935_lt)}</td>
        <td>${biasBadge(r.snap935_mt)}</td>
        <td class="dim" style="font-size:9px">${r.snap935_regime || '—'}</td>
        <td>${biasBadge(r.snap935_sec_bias)}</td>
        <td>${biasBadge(r.snap940_lt)}</td>
        <td>${biasBadge(r.snap940_mt)}</td>
        <td class="dim" style="font-size:9px">${r.snap940_regime || '—'}</td>
        <td>${biasBadge(r.snap940_sec_bias)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
    setStatus('merged-status', `${allRows.length} rows for ${date}`, 'ok');
  } catch (e) {
    container.innerHTML = '<div class="empty">Error.</div>';
    setStatus('merged-status', e.message, 'err');
  }
}

async function exportMerged() {
  setStatus('merged-status', 'Building CSV…');
  try {
    const [r1All, r3All, r2All] = await Promise.all([
      api('/api/screener'), api('/api/eod'), api('/api/snapshots')
    ]);
    const rows = buildMergedRows(r1All, r3All, r2All);
    downloadCSV(buildCSV(MERGED_HEADERS, rows), 'merged-register.csv');
    setStatus('merged-status', `Exported ${rows.length} rows`, 'ok');
  } catch (e) { setStatus('merged-status', e.message, 'err'); }
}

// ══════════════════════════════════════════════════════════════════
// IMPORT / EXPORT
// ══════════════════════════════════════════════════════════════════
async function importFile() {
  const fileEl = $('import-file');
  if (!fileEl.files || !fileEl.files[0]) { setStatus('import-status', 'Select a file first', 'err'); return; }
  setStatus('import-status', 'Reading file…');
  const text = await fileEl.files[0].text();
  let json;
  try { json = JSON.parse(text); } catch (e) { setStatus('import-status', 'Invalid JSON', 'err'); return; }
  setStatus('import-status', 'Uploading…');
  try {
    const res = await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
    setStatus('import-status', `Imported ${res.count || '?'} records (type: ${res.type || '?'})`, 'ok');
  } catch (e) { setStatus('import-status', e.message, 'err'); }
}

async function exportBackup(type) {
  setStatus('export-status', `Downloading ${type}…`);
  try {
    const res = await fetch(`/api/export/${type}`);
    if (!res.ok) throw new Error(res.statusText);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${type}.json`; a.click();
    URL.revokeObjectURL(url);
    setStatus('export-status', `Downloaded ${type}.json`, 'ok');
  } catch (e) { setStatus('export-status', e.message, 'err'); }
}

// ══════════════════════════════════════════════════════════════════
// JOURNAL
// ══════════════════════════════════════════════════════════════════
let jnlEditId = null;

async function loadJournal() {
  const dateEl = $('jnl-date');
  const filter = dateEl && dateEl.value ? dateEl.value : '';
  setStatus('jnl-status', '');
  try {
    const trades = await api('/api/journal');
    let list = Object.values(trades);
    if (filter) list = list.filter(t => t.date === filter);
    list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (a.ticker || '').localeCompare(b.ticker || ''));
    renderJournalList(list);
    setStatus('jnl-status', `${list.length} trades${filter ? ' on ' + filter : ''}`, list.length ? 'ok' : '');
  } catch (e) { setStatus('jnl-status', e.message, 'err'); }
}

function renderJournalList(trades) {
  const el = $('jnl-list');
  if (!trades.length) { el.innerHTML = '<div class="empty">No trades.</div>'; return; }
  el.innerHTML = trades.map(t => {
    const sideClass = t.side === 'S' ? 'trade-side-S' : 'trade-side-L';
    const pnl = t.entry && t.exit && t.shares ?
      ((parseFloat(t.exit) - parseFloat(t.entry)) * (t.side === 'S' ? -1 : 1) * parseFloat(t.shares)).toFixed(2) : null;
    const pnlCls = pnl != null ? (parseFloat(pnl) >= 0 ? 'up' : 'dn') : '';
    return `<div class="trade-card ${sideClass}" data-id="${t.id}">
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="trade-ticker">${t.ticker || '—'}</span>
          <span class="bias ${t.side === 'L' ? 'bias-bull' : 'bias-bear'}">${t.side || '?'}</span>
          <span class="dim" style="font-size:10px">${t.date || ''}</span>
          ${t.setup ? `<span class="dim" style="font-size:10px">${t.setup}</span>` : ''}
          ${pnl != null ? `<span class="mono ${pnlCls}" style="font-size:11px;margin-left:auto">${pnl >= 0 ? '+' : ''}$${pnl}</span>` : ''}
        </div>
        <div class="trade-meta">
          ${t.entry ? `Entry: ${fmt(t.entry)} ` : ''}
          ${t.exit ? `Exit: ${fmt(t.exit)} ` : ''}
          ${t.shares ? `Shares: ${t.shares} ` : ''}
          ${t.rmult != null ? `R: ${fmt(t.rmult,2)}` : ''}
        </div>
        ${t.notes ? `<div class="trade-note">${t.notes}</div>` : ''}
      </div>
      <div class="trade-actions">
        <button class="btn" onclick="editTrade('${t.id}')">Edit</button>
        <button class="btn btn-danger" onclick="deleteTrade('${t.id}')">Del</button>
      </div>
    </div>`;
  }).join('');
}

function showJournalForm(trade) {
  jnlEditId = trade ? trade.id : null;
  $('jnl-form-title').textContent = trade ? 'Edit Trade' : 'New Trade';
  $('jf-ticker').value = trade ? (trade.ticker || '') : '';
  $('jf-date').value = trade ? (trade.date || etToday()) : etToday();
  $('jf-side').value = trade ? (trade.side || 'L') : 'L';
  $('jf-setup').value = trade ? (trade.setup || '') : '';
  $('jf-entry').value = trade ? (trade.entry || '') : '';
  $('jf-exit').value = trade ? (trade.exit || '') : '';
  $('jf-shares').value = trade ? (trade.shares || '') : '';
  $('jf-rmult').value = trade ? (trade.rmult || '') : '';
  $('jf-notes').value = trade ? (trade.notes || '') : '';
  $('jnl-form-wrap').style.display = 'block';
  $('jf-ticker').focus();
}

function hideJournalForm() {
  $('jnl-form-wrap').style.display = 'none';
  jnlEditId = null;
}

async function saveJournalTrade() {
  const ticker = ($('jf-ticker').value || '').trim().toUpperCase();
  if (!ticker) { setStatus('jnl-status', 'Ticker required', 'err'); return; }
  const data = {
    ticker, date: $('jf-date').value || etToday(),
    side: $('jf-side').value,
    setup: $('jf-setup').value.trim(),
    entry: $('jf-entry').value ? parseFloat($('jf-entry').value) : null,
    exit: $('jf-exit').value ? parseFloat($('jf-exit').value) : null,
    shares: $('jf-shares').value ? parseInt($('jf-shares').value) : null,
    rmult: $('jf-rmult').value ? parseFloat($('jf-rmult').value) : null,
    notes: $('jf-notes').value.trim()
  };
  if (jnlEditId) data.id = jnlEditId;
  try {
    await api('/api/journal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    hideJournalForm();
    await loadJournal();
  } catch (e) { setStatus('jnl-status', e.message, 'err'); }
}

async function editTrade(id) {
  try {
    const trades = await api('/api/journal');
    const trade = Object.values(trades).find(t => t.id === id);
    if (trade) showJournalForm(trade);
  } catch (e) { setStatus('jnl-status', e.message, 'err'); }
}

async function deleteTrade(id) {
  if (!confirm('Delete this trade?')) return;
  try {
    await api(`/api/journal/${id}`, { method: 'DELETE' });
    await loadJournal();
  } catch (e) { setStatus('jnl-status', e.message, 'err'); }
}

// Expose for onclick handlers
window.editTrade = editTrade;
window.deleteTrade = deleteTrade;

// ══════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════
async function saveAutoMode(enabled) {
  try {
    await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshotMode: enabled ? 'auto' : 'manual' }) });
    await refreshStatus();
  } catch (e) { console.error(e); }
}

// ══════════════════════════════════════════════════════════════════
// MARKET — run snapshot
// ══════════════════════════════════════════════════════════════════
async function runSnapshot() {
  const slotSel = $('mkt-slot-select');
  const slot = slotSel && slotSel.value ? slotSel.value : '09:35';
  setStatus('mkt-status', `Capturing ${slot}…`);
  const btn = $('mkt-run-snap');
  btn.disabled = true;
  try {
    await api('/api/snapshots/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot }) });
    setStatus('mkt-status', 'Done — reloading…', 'ok');
    await loadMarket();
  } catch (e) { setStatus('mkt-status', e.message, 'err'); }
  btn.disabled = false;
}

async function runScreenerFreeze() {
  setStatus('scr-status', 'Freezing screener…');
  const btn = $('scr-run');
  btn.disabled = true;
  try {
    await api('/api/screener/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setStatus('scr-status', 'Done — reloading…', 'ok');
    await loadScreener();
  } catch (e) { setStatus('scr-status', e.message, 'err'); }
  btn.disabled = false;
}

// ══════════════════════════════════════════════════════════════════
// WIRE ALL EVENTS
// ══════════════════════════════════════════════════════════════════
function wireEvents() {
  // Tab nav (already handled in initTabs)

  // Market
  const mktDate = $('mkt-date');
  if (mktDate) mktDate.addEventListener('change', loadMarket);
  const mktSlot = $('mkt-slot-select');
  if (mktSlot) mktSlot.addEventListener('change', () => { mktActiveSlot = mktSlot.value; renderMarketSnap(mktSnapshots[mktActiveSlot]); });
  const mktRun = $('mkt-run-snap');
  if (mktRun) mktRun.addEventListener('click', runSnapshot);

  // Screener
  const scrDate = $('scr-date');
  if (scrDate) scrDate.addEventListener('change', loadScreener);
  const scrRun = $('scr-run');
  if (scrRun) scrRun.addEventListener('click', runScreenerFreeze);

  // R1
  const r1Date = $('r1-date');
  if (r1Date) r1Date.addEventListener('change', loadR1);
  const r1Ex = $('r1-export');
  if (r1Ex) r1Ex.addEventListener('click', exportR1);

  // R2
  const r2Date = $('r2-date');
  if (r2Date) r2Date.addEventListener('change', loadR2);
  const r2Ex = $('r2-export');
  if (r2Ex) r2Ex.addEventListener('click', async () => {
    setStatus('r2-status', 'Downloading…');
    try { await exportBackup('marketSnapshots'); setStatus('r2-status', 'Downloaded', 'ok'); }
    catch (e) { setStatus('r2-status', e.message, 'err'); }
  });

  // R3
  const r3Date = $('r3-date');
  if (r3Date) r3Date.addEventListener('change', loadR3);
  const r3Run = $('r3-run');
  if (r3Run) r3Run.addEventListener('click', runR3);
  const r3Ex = $('r3-export');
  if (r3Ex) r3Ex.addEventListener('click', exportR3);

  // Merged
  const mergedDate = $('merged-date');
  if (mergedDate) mergedDate.addEventListener('change', loadMerged);
  const mergedEx = $('merged-export');
  if (mergedEx) mergedEx.addEventListener('click', exportMerged);

  // Import / export
  const importBtn = $('import-btn');
  if (importBtn) importBtn.addEventListener('click', importFile);
  document.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => exportBackup(btn.dataset.export));
  });

  // Journal
  const jnlDate = $('jnl-date');
  if (jnlDate) jnlDate.addEventListener('change', loadJournal);
  const jnlAdd = $('jnl-add');
  if (jnlAdd) jnlAdd.addEventListener('click', () => showJournalForm(null));
  const jnlSave = $('jnl-form-save');
  if (jnlSave) jnlSave.addEventListener('click', saveJournalTrade);
  ['jnl-form-cancel','jnl-form-cancel2'].forEach(id => {
    const el = $(id); if (el) el.addEventListener('click', hideJournalForm);
  });

  // Settings auto toggle
  const autoToggle = $('setting-auto');
  if (autoToggle) autoToggle.addEventListener('change', () => saveAutoMode(autoToggle.checked));
}

// ══════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════
async function init() {
  initTabs();
  wireEvents();

  // Set default dates
  const today = etToday();
  ['mkt-date','scr-date','r1-date','r2-date','r3-date','merged-date','jf-date'].forEach(id => {
    const el = $(id); if (el && !el.value) el.value = today;
  });

  await refreshStatus();
  await loadMarket();

  // Auto-refresh status every 30s
  setInterval(refreshStatus, 30000);
}

document.addEventListener('DOMContentLoaded', init);
