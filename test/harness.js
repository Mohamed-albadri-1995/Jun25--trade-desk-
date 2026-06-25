'use strict';
/**
 * test/harness.js  —  Registry-First Architecture Test Harness
 * Run with:  node test/harness.js
 *
 * Loads the real popup.js inside a Node.js VM with mocked browser globals.
 * Tests the four data-flow constraints (C1–C4) and partial-refresh safety (P1–P4).
 *
 * C1  card reads ONLY from registry snapshot — never from live marketCtx
 * C2  data enters registry BEFORE any card is built
 * C3  local state changes (market refresh, hot, shortlist) propagate to registry
 * C4  registry changes always propagate to rendered cards on next render
 *
 * P1  registryUpsertLive with partial stock list leaves other rows intact
 * P2  registryRefreshContext updates context only — never stock data
 * P3  registryRefreshStale touches only non-live rows, preserves live rows
 * P4  running a single screener leaves other screeners' rows completely intact
 *
 * NF  new fields (ADR%, monthly position, PM range, PM/ADR, regime context)
 *     flow correctly: TV scanner → mapTvRowToStock → registry → buildCard
 */

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

// ─── reporting ───────────────────────────────────────────────────────────────
let _pass = 0, _fail = 0;
function pass(msg) { _pass++; process.stdout.write('  ✓ ' + msg + '\n'); }
function fail(msg, detail) {
  _fail++;
  process.stderr.write('  ✗ ' + msg + '\n');
  if (detail != null)
    process.stderr.write('    ' + JSON.stringify(detail).slice(0, 200) + '\n');
}
function ok(cond, msg, detail) { cond ? pass(msg) : fail(msg, detail); }
function eq(a, b, msg)  { ok(a === b, msg, { got: a, want: b }); }
function neq(a, b, msg) { ok(a !== b, msg, { got: a, shouldNotBe: b }); }
function section(title) { process.stdout.write('\n── ' + title + '\n'); }
function deepStr(o) { return JSON.stringify(o); }
function deepEq(a, b, msg) {
  const sa = deepStr(a), sb = deepStr(b);
  ok(sa === sb, msg, sa === sb ? undefined : { got: a, want: b });
}
function clone(o) { return JSON.parse(deepStr(o)); }

// ─── mock: chrome storage ────────────────────────────────────────────────────
let _store = {};
let _sendFn = null; // per-test override for chrome.runtime.sendMessage

const chromeMock = {
  storage: {
    local: {
      get(keys, cb) {
        const ks = Array.isArray(keys) ? keys
          : (keys && typeof keys === 'object' ? Object.keys(keys) : [keys]);
        const res = {};
        ks.forEach(k => { if (k in _store) res[k] = clone(_store[k]); });
        cb(res);
      },
      set(obj, cb) {
        Object.keys(obj).forEach(k => { _store[k] = clone(obj[k]); });
        if (cb) cb();
      }
    }
  },
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      if (_sendFn) { _sendFn(msg, cb); }
      else if (cb) { cb({ ok: false, error: 'test: no mock registered' }); }
    }
  }
};

// ─── mock: DOM ───────────────────────────────────────────────────────────────
const _elStore   = {};
const _htmlSnap  = {};     // id → last innerHTML written
const _domEvents = {};

function makeEl(id) {
  let _html = '';
  const el = {
    id, disabled: false, className: '', _delegated: false,
    style: {}, clientWidth: 720, clientHeight: 360,
    get innerHTML() { return _html; },
    set innerHTML(v) { _html = v; _htmlSnap[id] = v; },
    get textContent() { return _html.replace(/<[^>]+>/g, ''); },
    set textContent(v) { _html = v; },
    classList: {
      _c: new Set(),
      add(c) { this._c.add(c); },
      remove(c) { this._c.delete(c); },
      toggle(c, f) { f ? this._c.add(c) : this._c.delete(c); },
      contains(c) { return this._c.has(c); }
    },
    addEventListener(ev, fn) {
      const k = id + ':' + ev;
      (_domEvents[k] = _domEvents[k] || []).push(fn);
    },
    removeEventListener() {},
    querySelectorAll() { return []; },
    querySelector()    { return null; },
    closest()          { return null; },
    getAttribute(a)    { return el['_attr_' + a] != null ? el['_attr_' + a] : null; },
    setAttribute(a, v) { el['_attr_' + a] = v; },
    parentNode: null,
    children: [],
    appendChild() {},
    removeChild() {},
    getBoundingClientRect() { return { width: 720, height: 360 }; },
    remove() {},
  };
  return el;
}
function getEl(id) { return _elStore[id] || (_elStore[id] = makeEl(id)); }

const _domReadyFns = [];
const documentMock = {
  getElementById: getEl,
  body: { addEventListener() {}, querySelectorAll() { return []; }, appendChild() {} },
  addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') _domReadyFns.push(fn); },
  querySelectorAll() { return []; },
  querySelector()   { return null; },
  createElement(tag) { return makeEl('_' + tag + '_' + Math.random().toString(36).slice(2)); },
  createElementNS()  { return makeEl('_ns_' + Math.random().toString(36).slice(2)); },
  head: { appendChild() {} },
};

// ─── load popup.js in isolated VM context ────────────────────────────────────
const popupSrc = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

const sandbox = vm.createContext({
  // Browser env
  chrome: chromeMock, document: documentMock, window: {}, navigator: { userAgent: 'test' },
  location: { href: '' },
  // Standard JS
  Date, Math, Number, String, Boolean, Array, Object, JSON, Promise, Map, Set,
  WeakMap, WeakSet, Symbol, RegExp, Error, TypeError, RangeError, SyntaxError,
  Function, Reflect, Proxy, Uint8Array, ArrayBuffer, DataView,
  parseInt, parseFloat, isFinite, isNaN,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  setTimeout: (fn) => { try { fn(); } catch (_) {} return 0; },
  clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
  requestAnimationFrame: (fn) => { try { fn(0); } catch (_) {} return 0; },
  cancelAnimationFrame() {},
  console,
  // Third-party stubs
  LightweightCharts: {
    createChart() {
      return {
        addCandlestickSeries() { return { setData() {}, applyOptions() {} }; },
        addLineSeries()         { return { setData() {}, applyOptions() {} }; },
        timeScale()             { return { fitContent() {}, setVisibleRange() {} }; },
        applyOptions() {}, resize() {}, remove() {}
      };
    }
  },
  ResizeObserver: class { observe() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} },
});
sandbox.globalThis = sandbox;
sandbox.self       = sandbox;
sandbox.window     = sandbox;  // window.LightweightCharts lookup

try {
  vm.runInContext(popupSrc, sandbox);
} catch (e) {
  console.error('FATAL: popup.js VM load failed:\n', e.message.slice(0, 500));
  process.exit(1);
}

// ─── test helpers ─────────────────────────────────────────────────────────────
// TV_COLUMNS order (must match popup.js exactly):
// 0 ticker-view, 1 open, 2 close, 3 change, 4 rvol_10d, 5 rvol_intraday|5,
// 6 market_cap, 7 sector, 8 industry, 9 change_from_open, 10 VWAP,
// 11 High.1M, 12 Low.1M, 13 high, 14 low, 15 ATR,
// 16 short%_float, 17 float_shares, 18 EMA9, 19 EMA13, 20 EMA20, 21 EMA50,
// 22 SMA5, 23 premarket_high, 24 premarket_low
function makeTvRow(o = {}) {
  const sym   = o.symbol   != null ? o.symbol   : 'AAPL';
  const close = o.close    != null ? o.close    : 100;
  const atr   = o.atr      != null ? o.atr      : 4;
  const mh    = o.monthHigh != null ? o.monthHigh : close + 20;
  const ml    = o.monthLow  != null ? o.monthLow  : close - 20;
  const pmh   = o.pmHigh   != null ? o.pmHigh   : close + 1;
  const pml   = o.pmLow    != null ? o.pmLow    : close - 1;
  return {
    s: 'NASDAQ:' + sym,
    d: [
      { symbol: sym },                                          // 0
      o.open != null ? o.open : close - 2,                     // 1
      close,                                                    // 2
      o.change != null ? o.change : 2,                         // 3
      o.rvol10d != null ? o.rvol10d : 2,                       // 4
      o.rvol5m  != null ? o.rvol5m  : 3,                       // 5
      o.mcap != null ? o.mcap : 1e10,                          // 6
      o.sector   || 'Technology',                              // 7
      o.industry || 'Software',                                // 8
      o.changeFromOpen != null ? o.changeFromOpen : 1,         // 9
      o.vwap  != null ? o.vwap  : close - 1,                  // 10
      mh,                                                      // 11
      ml,                                                      // 12
      o.dayHigh != null ? o.dayHigh : close + 0.5,            // 13
      o.dayLow  != null ? o.dayLow  : close - 1.5,            // 14
      atr,                                                     // 15
      o.shortFloat != null ? o.shortFloat : 2,                 // 16
      o.floatSh    != null ? o.floatSh    : 1e9,              // 17
      o.ema9  != null ? o.ema9  : close - 0.5,                // 18
      o.ema13 != null ? o.ema13 : close - 1,                  // 19
      o.ema20 != null ? o.ema20 : close - 2,                  // 20
      o.ema50 != null ? o.ema50 : close - 5,                  // 21
      o.sma5  != null ? o.sma5  : close - 0.3,                // 22
      pmh,                                                     // 23
      pml,                                                     // 24
    ]
  };
}

function makeStock(sym, o = {}) {
  return sandbox.mapTvRowToStock(makeTvRow({ symbol: sym, ...o }), o.screenerKey || 'trend');
}

function today() { return sandbox.etDateStr(); }
function rid(ticker) { return sandbox.regId(ticker, today()); }

function makeRegRow(ticker, stock) {
  const id = rid(ticker);
  return {
    id, ticker, date: today(), tvSymbol: stock.tvSymbol || 'NASDAQ:' + ticker,
    firstSeen: Date.now(), lastUpdated: Date.now(), liveNow: true,
    screenerKeys: stock.screenerKey ? [stock.screenerKey] : ['trend'],
    stock: clone(stock),
    context: sandbox.computeCardContext(stock),
    news: null, inShortlist: false
  };
}

// Replace registry contents without replacing the object (popup.js funcs keep their ref)
function setRegistry(rows) {
  Object.keys(sandbox.registry).forEach(k => delete sandbox.registry[k]);
  rows.forEach(r => { sandbox.registry[r.id] = clone(r); });
}

// Update marketCtx in-place
function setMarket(o = {}) {
  const defaults = {
    marketBias: 'NEUTRAL', marketStage: 'UNKNOWN', marketLongTerm: 'UNKNOWN',
    marketBB: 'UNKNOWN', stageData: null, ltData: null, lastRefresh: Date.now(),
    sectorBiasScores: {}, hotStatus: {}, breakoutStocks: [], indices: {}, sectorETFs: {}
  };
  Object.assign(sandbox.marketCtx, defaults, o);
}

// Reset all mutable state between test groups
function reset() {
  Object.keys(sandbox.registry).forEach(k => delete sandbox.registry[k]);
  sandbox.shortlistTodaySet = {};
  sandbox.shortlists = {};
  _store = {};
  _sendFn = null;
  setMarket({});
}

// ─── test suites ─────────────────────────────────────────────────────────────

async function testC1() {
  section('C1 — card reads ONLY from registry snapshot, never from live marketCtx');
  reset();

  // Snapshot context while market is BULLISH
  setMarket({ marketBias: 'BULLISH', marketLongTerm: 'BULLISH', marketStage: 'UPTREND' });
  const s = makeStock('AAPL');
  const ctx = sandbox.computeCardContext(s);
  ok(ctx.marketBias === 'BULLISH', 'C1 setup: context snapshotted as BULLISH');
  ok(ctx.longTerm   === 'BULLISH', 'C1 setup: context.longTerm snapshotted');
  ok(ctx.midTerm    === 'UPTREND', 'C1 setup: context.midTerm snapshotted');

  // Place row in registry with BULLISH context
  const row = makeRegRow('AAPL', s);
  row.context = ctx;
  setRegistry([row]);

  // Render with BULLISH — capture HTML
  sandbox.renderScreenerFromRegistry();
  const html1 = _htmlSnap['scrResults'] || '';
  ok(html1.includes('BULLISH'), 'C1 setup: initial card shows BULLISH');

  // Change live marketCtx to BEARISH — do NOT call registryRefreshContext
  setMarket({ marketBias: 'BEARISH', marketLongTerm: 'BEARISH', marketStage: 'DOWNTREND' });

  // Re-render: card must still show the frozen BULLISH context from the registry row
  sandbox.renderScreenerFromRegistry();
  const html2 = _htmlSnap['scrResults'] || '';

  ok(html1 === html2,
    'C1: card HTML identical — frozen registry context isolated from live marketCtx change');
  ok(html2.includes('BULLISH'),
    'C1: card still shows BULLISH after live marketCtx changed to BEARISH (no registry refresh done)');
  ok(!html2.includes('DOWNTREND'),
    'C1: card does NOT show DOWNTREND from new live marketCtx before registry refresh');
}

async function testC2() {
  section('C2 — data enters registry BEFORE any card is built');
  reset();
  setMarket({ marketBias: 'NEUTRAL', lastRefresh: Date.now() });

  // Registry is empty to start
  ok(sandbox.regTodayRows().length === 0, 'C2 setup: registry is empty before scan');

  const stocks = [makeStock('AAPL'), makeStock('MSFT', { symbol: 'MSFT' })];
  const keysByTicker = { AAPL: ['trend'], MSFT: ['trend'] };

  // Step 1: upsert live stocks — the ONLY path into the registry
  sandbox.registryUpsertLive(stocks, keysByTicker);

  // Registry must contain stocks NOW, before any render is called
  ok(sandbox.regTodayRows().length === 2, 'C2: registry has 2 rows immediately after upsert');
  ok(!!sandbox.registry[rid('AAPL')], 'C2: AAPL in registry before any card render');
  ok(!!sandbox.registry[rid('MSFT')], 'C2: MSFT in registry before any card render');
  ok(sandbox.registry[rid('AAPL')].stock.ticker === 'AAPL', 'C2: AAPL stock.ticker correct');
  ok(sandbox.registry[rid('MSFT')].stock.ticker === 'MSFT', 'C2: MSFT stock.ticker correct');

  // Step 2: save and render — must build cards from registry (which already has data)
  await sandbox.saveRegistry();
  const shown = sandbox.renderScreenerFromRegistry();
  ok(shown === 2, 'C2: renderScreenerFromRegistry returns 2 (from registry, not directly from scan)');

  const html = _htmlSnap['scrResults'] || '';
  ok(html.includes('AAPL'), 'C2: card shows AAPL (sourced from registry)');
  ok(html.includes('MSFT'), 'C2: card shows MSFT (sourced from registry)');
}

async function testC3() {
  section('C3 — local state changes propagate to registry');
  reset();
  setMarket({ marketBias: 'NEUTRAL', marketLongTerm: 'UNKNOWN', marketStage: 'UNKNOWN' });

  const s = makeStock('AAPL');
  setRegistry([makeRegRow('AAPL', s)]);
  const rowBefore = clone(sandbox.registry[rid('AAPL')]);

  ok(rowBefore.context.marketBias === 'NEUTRAL',  'C3 setup: context.marketBias = NEUTRAL');
  ok(rowBefore.context.longTerm   === 'UNKNOWN',  'C3 setup: context.longTerm = UNKNOWN');
  ok(rowBefore.context.midTerm    === 'UNKNOWN',  'C3 setup: context.midTerm = UNKNOWN');

  // Change market — registry must NOT auto-update (requires explicit registryRefreshContext)
  setMarket({ marketBias: 'BULLISH', marketLongTerm: 'BULLISH', marketStage: 'UPTREND' });
  ok(sandbox.registry[rid('AAPL')].context.marketBias === 'NEUTRAL',
    'C3: registry still NEUTRAL before explicit context refresh');

  // Trigger context refresh (this is what refreshMarket calls after updating marketCtx)
  await sandbox.registryRefreshContext();

  ok(sandbox.registry[rid('AAPL')].context.marketBias === 'BULLISH', 'C3: context.marketBias updated to BULLISH');
  ok(sandbox.registry[rid('AAPL')].context.longTerm   === 'BULLISH', 'C3: context.longTerm updated to BULLISH');
  ok(sandbox.registry[rid('AAPL')].context.midTerm    === 'UPTREND', 'C3: context.midTerm updated to UPTREND');
  ok(sandbox.registry[rid('AAPL')].context.shortTerm  === 'BULLISH', 'C3: context.shortTerm updated');
  ok(sandbox.registry[rid('AAPL')].context.regime != null,           'C3: context.regime snapshotted');

  // Stock data must be untouched by context refresh
  deepEq(sandbox.registry[rid('AAPL')].stock, rowBefore.stock,
    'C3: stock data unchanged by registryRefreshContext');

  // Shortlist propagation via registrySyncShortlist
  sandbox.shortlistTodaySet = { AAPL: true };
  sandbox.registrySyncShortlist();
  ok(sandbox.registry[rid('AAPL')].inShortlist === true,
    'C3: inShortlist stamped true from shortlistTodaySet');

  sandbox.shortlistTodaySet = {};
  sandbox.registrySyncShortlist();
  ok(sandbox.registry[rid('AAPL')].inShortlist === false,
    'C3: inShortlist cleared when removed from shortlist');
}

async function testC4() {
  section('C4 — registry changes always propagate to rendered cards on next render');
  reset();
  setMarket({ marketBias: 'NEUTRAL', marketLongTerm: 'UNKNOWN', marketStage: 'UNKNOWN' });

  const s = makeStock('AAPL');
  setRegistry([makeRegRow('AAPL', s)]);

  // Render with NEUTRAL — baseline
  sandbox.renderScreenerFromRegistry();
  const html_neutral = _htmlSnap['scrResults'] || '';

  // Change market, refresh registry context, re-render
  setMarket({ marketBias: 'BEARISH', marketLongTerm: 'BEARISH', marketStage: 'DOWNTREND' });
  await sandbox.registryRefreshContext();
  sandbox.renderScreenerFromRegistry();
  const html_bearish = _htmlSnap['scrResults'] || '';

  neq(html_neutral, html_bearish, 'C4: card HTML changes after registryRefreshContext + re-render');
  ok(html_bearish.includes('BEARISH'),   'C4: card shows BEARISH from updated registry context');
  ok(html_bearish.includes('DOWNTREND'), 'C4: card shows DOWNTREND from updated registry context');

  // Shortlist star propagation
  sandbox.shortlistTodaySet = { AAPL: true };
  sandbox.renderScreenerFromRegistry(); // registrySyncShortlist called inside
  const html_starred = _htmlSnap['scrResults'] || '';
  ok(html_starred.includes('sl-star on') || html_starred.includes('★ In list'),
    'C4: card shows starred state after shortlist update + re-render');

  sandbox.shortlistTodaySet = {};
  sandbox.renderScreenerFromRegistry();
  const html_unstarred = _htmlSnap['scrResults'] || '';
  ok(!html_unstarred.includes('sl-star on'),
    'C4: card unstarred after shortlist cleared + re-render');
}

async function testP1() {
  section('P1 — registryUpsertLive partial update leaves other rows completely intact');
  reset();
  setMarket({ marketBias: 'NEUTRAL', lastRefresh: Date.now() });

  const sA = makeStock('AAPL', { close: 100 });
  const sB = makeStock('MSFT', { symbol: 'MSFT', close: 200 });
  const sC = makeStock('GOOG', { symbol: 'GOOG', close: 300 });

  setRegistry([makeRegRow('AAPL', sA), makeRegRow('MSFT', sB), makeRegRow('GOOG', sC)]);

  // Deep-freeze snapshot of B and C before the partial upsert
  const b_before = clone(sandbox.registry[rid('MSFT')]);
  const c_before = clone(sandbox.registry[rid('GOOG')]);

  // Only upsert AAPL with a new price
  const sA_v2 = makeStock('AAPL', { close: 150 });
  sandbox.registryUpsertLive([sA_v2], { AAPL: ['trend'] });

  // AAPL must be updated
  eq(sandbox.registry[rid('AAPL')].stock.price, 150, 'P1: AAPL price updated to 150');

  // MSFT — stock, context, id, date, screenerKeys, liveNow, news all unchanged
  const b_after = clone(sandbox.registry[rid('MSFT')]);
  delete b_before.inShortlist; delete b_after.inShortlist; // inShortlist is stamped at render time
  deepEq(b_after.stock,       b_before.stock,       'P1: MSFT stock data unchanged');
  deepEq(b_after.context,     b_before.context,     'P1: MSFT context unchanged');
  eq(b_after.screenerKeys[0], b_before.screenerKeys[0], 'P1: MSFT screenerKeys unchanged');
  eq(b_after.liveNow,         b_before.liveNow,     'P1: MSFT liveNow unchanged');
  deepEq(b_after,             b_before,             'P1: MSFT row identical — no field touched');

  // GOOG — same verification
  const c_after = clone(sandbox.registry[rid('GOOG')]);
  delete c_before.inShortlist; delete c_after.inShortlist;
  deepEq(c_after, c_before, 'P1: GOOG row identical — no field touched');
}

async function testP2() {
  section('P2 — registryRefreshContext updates context only, never stock data or other fields');
  reset();
  setMarket({ marketBias: 'NEUTRAL' });

  const sA = makeStock('AAPL', { close: 100 });
  const sB = makeStock('MSFT', { symbol: 'MSFT', close: 200 });
  const rowA = makeRegRow('AAPL', sA);
  const rowB = makeRegRow('MSFT', sB);
  rowB.liveNow = false; // MSFT is a stale row — refreshContext must still update it
  setRegistry([rowA, rowB]);

  // Freeze stock data before context refresh
  const stock_A_before = clone(sandbox.registry[rid('AAPL')].stock);
  const stock_B_before = clone(sandbox.registry[rid('MSFT')].stock);
  const ctx_A_before   = clone(sandbox.registry[rid('AAPL')].context);

  // Change market and refresh context
  setMarket({ marketBias: 'BULLISH', marketLongTerm: 'BULLISH', marketStage: 'UPTREND' });
  await sandbox.registryRefreshContext();

  // Context must be updated for BOTH rows (live and stale)
  eq(sandbox.registry[rid('AAPL')].context.marketBias, 'BULLISH', 'P2: AAPL context.marketBias → BULLISH');
  eq(sandbox.registry[rid('MSFT')].context.marketBias, 'BULLISH', 'P2: MSFT (stale) context.marketBias → BULLISH');
  eq(sandbox.registry[rid('AAPL')].context.longTerm,  'BULLISH', 'P2: AAPL context.longTerm → BULLISH');
  eq(sandbox.registry[rid('MSFT')].context.midTerm,   'UPTREND', 'P2: MSFT context.midTerm → UPTREND');

  // Context changed — not a no-op
  neq(deepStr(sandbox.registry[rid('AAPL')].context), deepStr(ctx_A_before),
    'P2: context DID change (confirming refresh ran)');

  // Stock data must be exactly unchanged
  deepEq(sandbox.registry[rid('AAPL')].stock, stock_A_before,
    'P2: AAPL stock data completely unchanged by registryRefreshContext');
  deepEq(sandbox.registry[rid('MSFT')].stock, stock_B_before,
    'P2: MSFT stock data completely unchanged by registryRefreshContext');

  // Non-context row fields must be unchanged
  eq(sandbox.registry[rid('AAPL')].id,                rowA.id,                'P2: AAPL id unchanged');
  eq(sandbox.registry[rid('AAPL')].ticker,            rowA.ticker,            'P2: AAPL ticker unchanged');
  eq(sandbox.registry[rid('AAPL')].date,              rowA.date,              'P2: AAPL date unchanged');
  eq(sandbox.registry[rid('AAPL')].screenerKeys[0],   rowA.screenerKeys[0],   'P2: AAPL screenerKeys unchanged');
  eq(sandbox.registry[rid('MSFT')].liveNow,           false,                  'P2: MSFT liveNow (false) unchanged');
}

async function testP3() {
  section('P3 — registryRefreshStale updates only stale rows, leaves live rows completely intact');
  reset();
  setMarket({ marketBias: 'NEUTRAL', lastRefresh: Date.now() });

  // AAPL = live, MSFT = stale (was live earlier today)
  const sA = makeStock('AAPL', { close: 100 });
  const sB = makeStock('MSFT', { symbol: 'MSFT', close: 200 });
  const rowA = makeRegRow('AAPL', sA);
  const rowB = makeRegRow('MSFT', sB);
  rowB.liveNow = false;
  setRegistry([rowA, rowB]);

  const a_before = clone(sandbox.registry[rid('AAPL')]);

  // Mock sendMessage to return updated MSFT data when fetchBySymbols is called
  const msftFreshRow = makeTvRow({ symbol: 'MSFT', close: 210, open: 208 });
  _sendFn = (msg, cb) => {
    if (msg.action === 'tvScan') cb({ ok: true, data: { data: [msftFreshRow] } });
  };

  await sandbox.registryRefreshStale({ AAPL: true }); // AAPL is live, MSFT is not
  _sendFn = null;

  // AAPL (live) — every field completely unchanged
  const a_after = clone(sandbox.registry[rid('AAPL')]);
  delete a_before.inShortlist; delete a_after.inShortlist;
  deepEq(a_after, a_before, 'P3: AAPL (live) row completely unchanged by refreshStale');

  // MSFT (stale) — price updated, liveNow stays false
  eq(sandbox.registry[rid('MSFT')].stock.price, 210, 'P3: MSFT price refreshed to 210');
  eq(sandbox.registry[rid('MSFT')].liveNow, false,   'P3: MSFT liveNow remains false after refreshStale');
  ok(sandbox.registry[rid('MSFT')].lastUpdated >= rowB.lastUpdated,
    'P3: MSFT lastUpdated advanced after refreshStale');
}

async function testP4() {
  section('P4 — running a single screener leaves other screeners\' rows completely intact');
  reset();
  setMarket({ marketBias: 'NEUTRAL', lastRefresh: Date.now() });

  // Pre-populate registry: AAPL from trend, MSFT from premarket
  const sA = makeStock('AAPL', { close: 100 });
  const sB = makeStock('MSFT', { symbol: 'MSFT', close: 200 });
  const rowA = makeRegRow('AAPL', sA); rowA.screenerKeys = ['trend'];
  const rowB = makeRegRow('MSFT', sB); rowB.screenerKeys = ['premarket']; rowB.liveNow = false;
  setRegistry([rowA, rowB]);

  const a_before = clone(sandbox.registry[rid('AAPL')]);
  const b_before = clone(sandbox.registry[rid('MSFT')]);

  // Mock scan to return only GOOG (a new stock matched by bigmoves)
  const googRow = makeTvRow({ symbol: 'GOOG', close: 300 });
  _sendFn = (msg, cb) => {
    if (msg.action === 'tvScan') cb({ ok: true, data: { data: [googRow] } });
  };

  // runSingle flow: run one screener → upsertLive its results only → save → render
  const list = await sandbox.runScreener('bigmoves').catch(() => []);
  _sendFn = null;

  const keysByTicker = {};
  list.forEach(s => { keysByTicker[s.ticker] = ['bigmoves']; });
  sandbox.registryUpsertLive(list, keysByTicker);

  // AAPL row — completely unchanged
  const a_after = clone(sandbox.registry[rid('AAPL')]);
  delete a_before.inShortlist; delete a_after.inShortlist;
  deepEq(a_after, a_before, 'P4: AAPL row completely unchanged after single bigmoves scan');

  // MSFT row — completely unchanged
  const b_after = clone(sandbox.registry[rid('MSFT')]);
  delete b_before.inShortlist; delete b_after.inShortlist;
  deepEq(b_after, b_before, 'P4: MSFT row completely unchanged after single bigmoves scan');

  // GOOG — newly added by bigmoves
  ok(!!sandbox.registry[rid('GOOG')],                                    'P4: GOOG added to registry');
  ok(sandbox.registry[rid('GOOG')].screenerKeys.includes('bigmoves'),    'P4: GOOG has bigmoves screenerKey');
  eq(sandbox.registry[rid('GOOG')].liveNow, true,                        'P4: GOOG liveNow = true');
}

async function testNewFields() {
  section('NF — new fields flow correctly: TV scanner → registry → buildCard');
  reset();

  // mapTvRowToStock computes derived fields correctly
  const item = makeTvRow({
    symbol: 'AAPL', close: 105, atr: 4,
    monthHigh: 120, monthLow: 90,
    pmHigh: 103.5, pmLow: 101.5
  });
  const s = sandbox.mapTvRowToStock(item, 'trend');

  // ADR% = ATR / close * 100 = 4/105*100 ≈ 3.81
  ok(s.adrPct != null && Math.abs(s.adrPct - (4 / 105 * 100)) < 0.01,
    'NF: adrPct = ATR/price×100 (correct computation)');

  // Monthly position = (close - low) / (high - low) × 100 = (105-90)/(120-90)*100 = 50%
  ok(s.monthRangePos != null && Math.abs(s.monthRangePos - 50) < 0.1,
    'NF: monthRangePos = 50% (price at midpoint of monthly range)');

  // PM range = 103.5 - 101.5 = 2.0
  ok(s.pmRange != null && Math.abs(s.pmRange - 2.0) < 0.01,
    'NF: pmRange = $2.00');

  // PM/ADR = pmRange / ATR = 2.0 / 4.0 = 0.5
  ok(s.pmAdrRatio != null && Math.abs(s.pmAdrRatio - 0.5) < 0.01,
    'NF: pmAdrRatio = 0.5x (PM is half of avg day range)');

  // Edge case: null when ATR is missing
  const noAtr = sandbox.mapTvRowToStock(makeTvRow({ symbol: 'TEST', atr: null }), 'trend');
  // ATR at index 15 — send 0 to force null via num()
  const noAtrRow = makeTvRow({ symbol: 'TEST' });
  noAtrRow.d[15] = null;
  const sNoAtr = sandbox.mapTvRowToStock(noAtrRow, 'trend');
  ok(sNoAtr.adrPct == null,    'NF: adrPct null when ATR missing');
  ok(sNoAtr.pmAdrRatio == null,'NF: pmAdrRatio null when ATR missing');

  // Edge case: null when monthHigh === monthLow (zero-width range)
  const flatRow = makeTvRow({ symbol: 'FLAT', monthHigh: 100, monthLow: 100 });
  const sFlat = sandbox.mapTvRowToStock(flatRow, 'trend');
  ok(sFlat.monthRangePos == null, 'NF: monthRangePos null when monthHigh === monthLow');

  // Fields must persist through the full registry → card pipeline
  setMarket({ marketBias: 'BULLISH', marketLongTerm: 'BULLISH', marketStage: 'UPTREND', lastRefresh: Date.now() });
  const nvdaItem = makeTvRow({ symbol: 'NVDA', close: 200, atr: 10, monthHigh: 250, monthLow: 150, pmHigh: 202, pmLow: 198 });
  const nvda = sandbox.mapTvRowToStock(nvdaItem, 'trend');
  sandbox.registryUpsertLive([nvda], { NVDA: ['trend'] });

  const row = sandbox.registry[rid('NVDA')];
  ok(row != null,                          'NF: NVDA upserted into registry');
  ok(row.stock.adrPct       != null,       'NF: stock.adrPct stored in registry');
  ok(row.stock.monthRangePos != null,      'NF: stock.monthRangePos stored in registry');
  ok(row.stock.pmRange       != null,      'NF: stock.pmRange stored in registry');
  ok(row.stock.pmAdrRatio    != null,      'NF: stock.pmAdrRatio stored in registry');
  ok(row.stock.pmHigh        != null,      'NF: stock.pmHigh stored in registry');
  ok(row.stock.pmLow         != null,      'NF: stock.pmLow stored in registry');

  // Context regime fields in registry
  ok(row.context.longTerm  === 'BULLISH',  'NF: context.longTerm stored in registry');
  ok(row.context.midTerm   === 'UPTREND',  'NF: context.midTerm stored in registry');
  ok(row.context.shortTerm === 'BULLISH',  'NF: context.shortTerm stored in registry');
  ok(row.context.regime    != null,        'NF: context.regime stored in registry');

  // buildCard must render all new fields from the registry row (not recomputed live)
  row.inShortlist = false;
  const html = sandbox.buildCard(row);
  ok(html.includes('ADR%'),             'NF: buildCard renders ADR%');
  ok(html.includes('Monthly position'), 'NF: buildCard renders Monthly position');
  ok(html.includes('PM Range'),         'NF: buildCard renders PM Range');
  ok(html.includes('PM / ADR'),         'NF: buildCard renders PM / ADR');
  ok(html.includes('Long term'),        'NF: buildCard renders Long term');
  ok(html.includes('Mid term'),         'NF: buildCard renders Mid term');
  ok(html.includes('Short term'),       'NF: buildCard renders Short term');
  ok(html.includes('Regime'),           'NF: buildCard renders Regime');

  // Verify card reads regime from frozen context, not live marketCtx
  const frozenHtml = html;
  setMarket({ marketBias: 'BEARISH', marketLongTerm: 'BEARISH', marketStage: 'DOWNTREND' });
  const html2 = sandbox.buildCard(row); // same row, context unchanged
  ok(html === html2,
    'NF: buildCard output unchanged when marketCtx changes but row.context is frozen');
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Trade Desk — Registry-First Architecture Test Harness');
  console.log('popup.js: ' + _pass + ' symbols loaded\n');

  const suites = [testC1, testC2, testC3, testC4, testP1, testP2, testP3, testP4, testNewFields];
  for (const suite of suites) {
    try { await suite(); }
    catch (e) {
      fail('Suite threw: ' + e.message);
      console.error(e);
    }
  }

  console.log('\n' + '─'.repeat(56));
  console.log('Results: ' + _pass + ' passed  ' + _fail + ' failed');
  if (_fail > 0) {
    console.error('FAIL');
    process.exit(1);
  } else {
    console.log('ALL TESTS PASSED ✓');
    process.exit(0);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
