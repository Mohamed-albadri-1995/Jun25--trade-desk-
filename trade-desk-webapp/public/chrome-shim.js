'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   chrome-shim.js  — Chrome Extension API compatibility layer for browser
   Intercepts chrome.storage.local and chrome.runtime calls and routes
   them to the Trade Desk REST API (server.js).
   Load this BEFORE popup.js / app.js.
   ═══════════════════════════════════════════════════════════════════════ */

var _msgListeners = [];

// ── per-key REST routing ──────────────────────────────────────────────────
async function _kvGet(key) {
  try {
    if (key === 'settings') {
      const d = await fetch('/api/settings').then(r => r.json());
      return d;                                        // plain object
    }
    if (key === 'registry') {
      return await fetch('/api/registry').then(r => r.json());
    }
    if (key === 'frozenScreener') {
      return await fetch('/api/screener').then(r => r.json());
    }
    if (key === 'marketSnapshots') {
      return await fetch('/api/snapshots').then(r => r.json());
    }
    if (key === 'eodOutcome') {
      return await fetch('/api/eod').then(r => r.json());
    }
    if (key === 'shortlists') {
      return await fetch('/api/shortlists').then(r => r.json());
    }
    if (key === 'smb_journal') {
      // Extension stores this as JSON.stringify(trades[]).
      const trades = await fetch('/api/journal').then(r => r.json());
      return JSON.stringify(Array.isArray(trades) ? trades : []);
    }
    // Generic KV (fee profiles, day notes, API keys, checklist res, …)
    const r = await fetch('/api/kv/' + encodeURIComponent(key));
    if (!r.ok) return undefined;
    const d = await r.json();
    return d.value !== undefined ? d.value : undefined;
  } catch (_) { return undefined; }
}

async function _kvSet(key, value) {
  try {
    if (key === 'settings') {
      await fetch('/api/settings', { method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value) });
      return;
    }
    if (key === 'registry') {
      // value = { 'TICKER|DATE': rowObj, … } — upsert all rows
      const rows = Object.values(value || {});
      await fetch('/api/registry/sync', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }) });
      return;
    }
    if (key === 'frozenScreener') {
      await fetch('/api/import', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _type: 'frozenScreener', data: value }) });
      return;
    }
    if (key === 'marketSnapshots') {
      await fetch('/api/import', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _type: 'marketSnapshots', data: value }) });
      return;
    }
    if (key === 'eodOutcome') {
      await fetch('/api/import', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _type: 'eodOutcome', data: value }) });
      return;
    }
    if (key === 'shortlists') {
      await fetch('/api/shortlists', { method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value) });
      return;
    }
    if (key === 'smb_journal') {
      // value = JSON.stringify(trades[])  — full replace (handles deletes)
      let trades;
      try { trades = typeof value === 'string' ? JSON.parse(value) : value; }
      catch (_) { trades = []; }
      if (!Array.isArray(trades)) trades = Object.values(trades || {});
      await fetch('/api/journal/sync', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trades: trades.filter(t => t && t.id) }) });
      return;
    }
    // Generic KV — store value as string
    const strVal = (value !== null && value !== undefined)
      ? (typeof value === 'string' ? value : JSON.stringify(value))
      : '';
    await fetch('/api/kv/' + encodeURIComponent(key), { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: strVal }) });
  } catch (_) {}
}

// ── runtime message handler ───────────────────────────────────────────────
async function _handleMsg(msg) {
  if (!msg || !msg.action) return { ok: false, error: 'no action' };

  if (msg.action === 'tvScan') {
    const r = await fetch('/api/tvScan', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.body) });
    return r.json();
  }

  if (msg.action === 'news') {
    const r = await fetch('/api/news/' + encodeURIComponent(msg.symbol || ''));
    const d = await r.json();
    return { ok: true, finnhub: d.finnhub || [], tradingview: d.tradingview || [] };
  }

  if (msg.action === 'runEodOutcome') {
    const r = await fetch('/api/eod/run', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: msg.date || '' }) });
    return r.json();
  }

  if (msg.action === 'chartHistory') {
    const r = await fetch('/api/chart/' + encodeURIComponent(msg.symbol || '')
      + '?range=' + (msg.range || '6mo') + '&interval=1d');
    const d = await r.json();
    if (!d.ok) return { ok: false, error: d.error || 'no data' };
    return { ok: true, bars: d.candles || d.bars || [] };  // popup.js expects 'bars' (bg.js compat)
  }

  if (msg.action === 'fetchTickerProfile') {
    const r = await fetch('/api/profile/' + encodeURIComponent(msg.ticker || ''));
    if (!r.ok) return { sector: '', industry: '' };
    return r.json();
  }

  if (msg.action === 'fetchCandles') {
    const p = new URLSearchParams({
      fromMs: msg.fromMs != null ? msg.fromMs : 0,
      toMs:   msg.toMs   != null ? msg.toMs   : Date.now(),
      resolution: msg.resolution || 'daily'
    });
    const r = await fetch('/api/candles/' + encodeURIComponent(msg.ticker || '') + '?' + p);
    return r.json();
  }

  return { ok: false, error: 'unknown action: ' + msg.action };
}

// ── chrome namespace ──────────────────────────────────────────────────────
var chrome = {
  runtime: {
    lastError: null,
    sendMessage: function (msg, callback) {
      _handleMsg(msg).then(function (resp) {
        chrome.runtime.lastError = null;
        if (callback) callback(resp);
      }).catch(function (err) {
        chrome.runtime.lastError = { message: err.message };
        if (callback) callback(null);
        chrome.runtime.lastError = null;
      });
    },
    onMessage: {
      addListener: function (fn) { _msgListeners.push(fn); }
    }
  },

  storage: {
    local: {
      get: function (keys, callback) {
        var keyArr = typeof keys === 'string'  ? [keys]
                   : Array.isArray(keys)       ? keys
                   : Object.keys(keys || {});
        Promise.all(keyArr.map(k => _kvGet(k).then(v => ({ k, v }))))
          .then(function (pairs) {
            var result = {};
            pairs.forEach(p => { if (p.v !== undefined) result[p.k] = p.v; });
            chrome.runtime.lastError = null;
            if (callback) callback(result);
          })
          .catch(function (err) {
            chrome.runtime.lastError = { message: err.message };
            if (callback) callback({});
          });
      },

      set: function (obj, callback) {
        Promise.all(Object.keys(obj).map(k => _kvSet(k, obj[k])))
          .then(function ()  { chrome.runtime.lastError = null;              if (callback) callback(); })
          .catch(function () { chrome.runtime.lastError = { message: 'set failed' }; if (callback) callback(); });
      }
    }
  }
};

// ── Polling: simulate background→popup push messages ─────────────────────
(function startPolling() {
  var _lastSnapSig  = null;
  var _lastRegCount = null;

  // Every 60 s — fire SNAPSHOT_UPDATED when snapshots change
  setInterval(function () {
    fetch('/api/snapshots').then(r => r.json()).then(function (snaps) {
      var sig = JSON.stringify(Object.keys(snaps).sort());
      if (_lastSnapSig !== null && sig !== _lastSnapSig) {
        _msgListeners.forEach(function (fn) {
          try { fn({ type: 'SNAPSHOT_UPDATED' }); } catch (_) {}
        });
      }
      _lastSnapSig = sig;
    }).catch(() => {});
  }, 60000);

  // Every 30 s — fire BG_SCAN_COMPLETE when new registry rows appear
  setInterval(function () {
    fetch('/api/registry').then(r => r.json()).then(function (reg) {
      var n = Object.keys(reg).length;
      if (_lastRegCount !== null && n !== _lastRegCount) {
        _msgListeners.forEach(function (fn) {
          try { fn({ type: 'BG_SCAN_COMPLETE' }); } catch (_) {}
        });
      }
      _lastRegCount = n;
    }).catch(() => {});
  }, 30000);
})();
