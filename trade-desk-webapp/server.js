'use strict';

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const path    = require('path');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'trade-desk.db');

// ══════════════════════════════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════════════════════════════
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS registry (
    ticker     TEXT NOT NULL,
    date       TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (ticker, date)
  );
  CREATE TABLE IF NOT EXISTS frozen_screener (
    date TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS market_snapshots (
    date TEXT NOT NULL,
    slot TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (date, slot)
  );
  CREATE TABLE IF NOT EXISTS eod_outcome (
    date TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal_trades (
    id         TEXT PRIMARY KEY,
    ticker     TEXT NOT NULL,
    date       TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// ── DB helpers ────────────────────────────────────────────────────
function getSetting(key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : (def !== undefined ? def : null);
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(value));
}
function getAllSettings() {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const out = {};
  rows.forEach(r => { out[r.key] = r.value; });
  return out;
}

function getRegistry() {
  const rows = db.prepare('SELECT ticker,date,data,updated_at FROM registry ORDER BY updated_at DESC').all();
  const out = {};
  rows.forEach(r => { out[r.ticker + '|' + r.date] = JSON.parse(r.data); });
  return out;
}
function upsertRegistryRow(ticker, date, data) {
  db.prepare('INSERT OR REPLACE INTO registry (ticker,date,data,updated_at) VALUES (?,?,?,?)')
    .run(ticker, date, JSON.stringify(data), Date.now());
}

function getFrozenScreener(date) {
  const row = db.prepare('SELECT data FROM frozen_screener WHERE date=?').get(date);
  return row ? JSON.parse(row.data) : null;
}
function getAllFrozenScreener() {
  const rows = db.prepare('SELECT date,data FROM frozen_screener ORDER BY date DESC').all();
  const out = {};
  rows.forEach(r => { out[r.date] = JSON.parse(r.data); });
  return out;
}
function saveFrozenScreener(date, obj) {
  db.prepare('INSERT OR REPLACE INTO frozen_screener (date,data) VALUES (?,?)').run(date, JSON.stringify(obj));
}

function getMarketSnapshotsForDate(date) {
  const rows = db.prepare('SELECT slot,data FROM market_snapshots WHERE date=?').all(date);
  const out = {};
  rows.forEach(r => { out[r.slot] = JSON.parse(r.data); });
  return out;
}
function getAllMarketSnapshots() {
  const rows = db.prepare('SELECT date,slot,data FROM market_snapshots ORDER BY date DESC, slot ASC').all();
  const out = {};
  rows.forEach(r => {
    if (!out[r.date]) out[r.date] = {};
    out[r.date][r.slot] = JSON.parse(r.data);
  });
  return out;
}
function saveMarketSnapshot(date, slot, obj) {
  db.prepare('INSERT OR REPLACE INTO market_snapshots (date,slot,data) VALUES (?,?,?)')
    .run(date, slot, JSON.stringify(obj));
}

function getEodOutcome(date) {
  const row = db.prepare('SELECT data FROM eod_outcome WHERE date=?').get(date);
  return row ? JSON.parse(row.data) : null;
}
function getAllEodOutcome() {
  const rows = db.prepare('SELECT date,data FROM eod_outcome ORDER BY date DESC').all();
  const out = {};
  rows.forEach(r => { out[r.date] = JSON.parse(r.data); });
  return out;
}
function saveEodOutcome(date, obj) {
  db.prepare('INSERT OR REPLACE INTO eod_outcome (date,data) VALUES (?,?)').run(date, JSON.stringify(obj));
}

function getJournalTrades() {
  return db.prepare('SELECT data FROM journal_trades ORDER BY date DESC, updated_at DESC').all()
    .map(r => JSON.parse(r.data));
}
function saveJournalTrade(trade) {
  db.prepare('INSERT OR REPLACE INTO journal_trades (id,ticker,date,data,updated_at) VALUES (?,?,?,?,?)')
    .run(trade.id, trade.ticker || '', trade.date || '', JSON.stringify(trade), Date.now());
}
function deleteJournalTrade(id) {
  db.prepare('DELETE FROM journal_trades WHERE id=?').run(id);
}

// ══════════════════════════════════════════════════════════════════
// ET TIME HELPERS
// ══════════════════════════════════════════════════════════════════
function etDateStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function etTimeStr() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}
function isWeekdayET() {
  const d = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return d !== 'Sat' && d !== 'Sun';
}

// ══════════════════════════════════════════════════════════════════
// TRADINGVIEW SCANNER
// ══════════════════════════════════════════════════════════════════
const TV_SCAN_URL = 'https://scanner.tradingview.com/america/scan?label-product=screener-stock';

const TV_COLUMNS = [
  'ticker-view', 'open', 'close', 'change', 'relative_volume_10d_calc',
  'relative_volume_intraday|5', 'market_cap_basic', 'sector', 'industry',
  'change_from_open', 'VWAP',
  'High.1M', 'Low.1M', 'high', 'low', 'ATR',
  'short_percentage_of_float', 'float_shares_outstanding',
  'EMA9', 'EMA13', 'EMA20', 'EMA50', 'SMA5',
  'premarket_high', 'premarket_low'
];

const STOCK_FILTER2 = {
  operator: 'and',
  operands: [
    { operation: { operator: 'or', operands: [
      { operation: { operator: 'and', operands: [
        { expression: { left: 'type', operation: 'equal', right: 'stock' } },
        { expression: { left: 'typespecs', operation: 'has', right: ['common'] } } ] } },
      { operation: { operator: 'and', operands: [
        { expression: { left: 'type', operation: 'equal', right: 'stock' } },
        { expression: { left: 'typespecs', operation: 'has', right: ['preferred'] } } ] } },
      { operation: { operator: 'and', operands: [
        { expression: { left: 'type', operation: 'equal', right: 'dr' } } ] } }
    ] } },
    { expression: { left: 'typespecs', operation: 'has_none_of', right: ['pre-ipo'] } }
  ]
};

const SCREENER_CONFIGS = {
  trend: {
    filters: [
      { left: 'close', operation: 'egreater', right: 20 },
      { left: 'close', operation: 'egreater', right: 'SMA5' },
      { left: 'close', operation: 'egreater', right: 'VWAP' },
      { left: 'close|1W', operation: 'greater', right: 'VWAP|1W' },
      { left: 'close|1M', operation: 'greater', right: 'VWAP|1M' },
      { left: 'EMA50|1', operation: 'greater', right: 'EMA120|1' },
      { left: 'close|1', operation: 'egreater', right: 'EMA50|1' },
      { left: 'average_volume_90d_calc', operation: 'greater', right: 1000000 },
      { left: 'VWAP', operation: 'egreater', right: 'SMA75|5' },
      { left: 'relative_volume_intraday|5', operation: 'greater', right: 3 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
      { left: 'close', operation: 'egreater', right: 1 }
    ],
    sort: { sortBy: 'change', sortOrder: 'desc' }
  },
  premarket: {
    filters: [
      { left: 'close', operation: 'egreater', right: 0.5 },
      { left: 'close', operation: 'egreater', right: 1 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 3 },
      { left: 'premarket_volume', operation: 'greater', right: 1500000 }
    ],
    sort: { sortBy: 'premarket_volume', sortOrder: 'desc' }
  },
  bigmoves: {
    filters: [
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 10 },
      { left: 'close', operation: 'egreater', right: 2 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 }
    ],
    sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' }
  }
};

function rowObj(item, cols) {
  const d = item.d || [], o = {};
  cols.forEach((c, i) => { o[c] = d[i]; });
  return o;
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

function mapTvRowToStock(item, screenerKey) {
  const r = rowObj(item, TV_COLUMNS), n = num;
  let tv = r['ticker-view'], t = '';
  if (tv && typeof tv === 'object' && tv.symbol) t = tv.symbol;
  else if (typeof tv === 'string') t = tv;
  else t = String(item.s || '');
  t = t.replace(/^.*:/, '').trim();
  const close = n(r['close']), change = n(r['change']), cfo = n(r['change_from_open']);
  const monthHigh = n(r['High.1M']), monthLow = n(r['Low.1M']), atr = n(r['ATR']);
  const pmHigh = n(r['premarket_high']), pmLow = n(r['premarket_low']);
  const pmRange = (pmHigh != null && pmLow != null) ? pmHigh - pmLow : null;
  const adrPct = (atr != null && close != null && close > 0) ? atr / close * 100 : null;
  const monthRangePos = (monthHigh != null && monthLow != null && (monthHigh - monthLow) > 0 && close != null)
    ? (close - monthLow) / (monthHigh - monthLow) * 100 : null;
  const pmAdrRatio = (pmRange != null && atr != null && atr > 0) ? pmRange / atr : null;
  return {
    ticker: t, screenerKey: screenerKey || null, tvSymbol: String(item.s || ''),
    price: close, open: n(r['open']), change: change,
    prevClose: (close != null && change != null && (1 + change / 100) !== 0) ? close / (1 + change / 100) : null,
    gapPct: (change != null && cfo != null) ? change - cfo : null,
    vwap: n(r['VWAP']),
    ema9: n(r['EMA9']), ema13: n(r['EMA13']), ema20: n(r['EMA20']), ema50: n(r['EMA50']), sma5: n(r['SMA5']),
    monthHigh, monthLow, dayHigh: n(r['high']), dayLow: n(r['low']), atr,
    pmHigh, pmLow, pmRange, adrPct, monthRangePos, pmAdrRatio,
    mcap: n(r['market_cap_basic']), floatShares: n(r['float_shares_outstanding']),
    shortFloat: n(r['short_percentage_of_float']),
    rvol: n(r['relative_volume_intraday|5']) || n(r['relative_volume_10d_calc']),
    sector: r['sector'] || '', industry: r['industry'] || ''
  };
}

async function tvScanDirect(body) {
  const r = await fetch(TV_SCAN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('TV scan HTTP ' + r.status);
  return r.json();
}

async function runScreener(key) {
  const cfg = SCREENER_CONFIGS[key];
  const body = {
    columns: TV_COLUMNS, filter: cfg.filters, filter2: STOCK_FILTER2,
    ignore_unknown_fields: false, markets: ['america'], options: { lang: 'en' },
    range: [0, 50], sort: cfg.sort, symbols: {}
  };
  const data = await tvScanDirect(body);
  return (data.data || []).map(item => mapTvRowToStock(item, key)).filter(s => s.ticker);
}

// ══════════════════════════════════════════════════════════════════
// MARKET SNAPSHOT — computation (ported from background.js)
// ══════════════════════════════════════════════════════════════════
const MARKET_TICKERS = ['AMEX:SPY','NASDAQ:QQQ','AMEX:DIA','AMEX:IWM','TVC:VIX'];
const SECTOR_ETF_MAP = {
  'Technology':'AMEX:XLK','Finance':'AMEX:XLF','Energy Minerals':'AMEX:XLE',
  'Health Technology':'AMEX:XLV','Producer Manufacturing':'AMEX:XLI',
  'Communications':'AMEX:XLC','Consumer Durables':'AMEX:XLY',
  'Consumer Non-Durables':'AMEX:XLP','Non-Energy Minerals':'AMEX:XLB',
  'Finance/Real Estate':'AMEX:XLRE','Utilities':'AMEX:XLU',
  'Electronic Technology':'AMEX:SMH','Health Services':'AMEX:IBB',
  'Retail Trade':'AMEX:XRT','Transportation':'AMEX:XTN'
};
const SECTOR_ETF_REVERSE = {};
Object.keys(SECTOR_ETF_MAP).forEach(k => { SECTOR_ETF_REVERSE[SECTOR_ETF_MAP[k]] = k; });

const REGIME_MATRIX = {
  'BULLISH|UPTREND':'STRONG_UP','BULLISH|PULLBACK':'PULLBACK_BULL','BULLISH|REBOUND':'UP',
  'BULLISH|SIDEWAYS':'CHOP_BULL','BULLISH|DOWNTREND':'CORRECTION',
  'RECOVERING|UPTREND':'WEAK_UP','RECOVERING|PULLBACK':'RECOVERY','RECOVERING|REBOUND':'RECOVERY',
  'RECOVERING|SIDEWAYS':'BASING','RECOVERING|DOWNTREND':'DOWN',
  'WEAKENING|UPTREND':'RECOVERY','WEAKENING|PULLBACK':'TOPPING','WEAKENING|REBOUND':'BEAR_RALLY',
  'WEAKENING|SIDEWAYS':'CHOP_BEAR','WEAKENING|DOWNTREND':'DOWN',
  'BEARISH|UPTREND':'BEAR_RALLY','BEARISH|PULLBACK':'DOWN','BEARISH|REBOUND':'BEAR_RALLY',
  'BEARISH|SIDEWAYS':'BASING','BEARISH|DOWNTREND':'STRONG_DOWN'
};
const REGIME_CATALOG = {
  EXTENDED_UP:{label:'Extended uptrend',icon:'🚀',color:'#4ade80',bias:'LONG'},
  STRONG_UP:{label:'Strong uptrend',icon:'📈',color:'#4ade80',bias:'LONG'},
  UP:{label:'Uptrend (resuming)',icon:'⬆️',color:'#86efac',bias:'LONG'},
  WEAK_UP:{label:'Early uptrend',icon:'🌱',color:'#86efac',bias:'LONG'},
  PULLBACK_BULL:{label:'Bull pullback',icon:'↩️',color:'#fbbf24',bias:'LONG'},
  RECOVERY:{label:'Recovery attempt',icon:'🔄',color:'#94a3b8',bias:'NEUTRAL'},
  BASING:{label:'Basing',icon:'⚖️',color:'#94a3b8',bias:'NEUTRAL'},
  CHOP_BULL:{label:'Choppy (above 200DMA)',icon:'〰️',color:'#94a3b8',bias:'NEUTRAL'},
  CHOP_BEAR:{label:'Choppy (below 200DMA)',icon:'〰️',color:'#94a3b8',bias:'NEUTRAL'},
  CORRECTION:{label:'Correction',icon:'📉',color:'#fbbf24',bias:'NEUTRAL'},
  TOPPING:{label:'Topping',icon:'🔻',color:'#f87171',bias:'SHORT'},
  BEAR_RALLY:{label:'Bear rally',icon:'🐻',color:'#f59e0b',bias:'NEUTRAL'},
  DOWN:{label:'Downtrend',icon:'⬇️',color:'#f87171',bias:'SHORT'},
  STRONG_DOWN:{label:'Strong downtrend',icon:'💥',color:'#ef4444',bias:'SHORT'},
  CAPITULATION:{label:'Capitulation',icon:'🆘',color:'#ef4444',bias:'SHORT'},
  UNKNOWN:{label:'Unknown',icon:'❔',color:'#475569',bias:'NEUTRAL'}
};

function clampN(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function computeShortTermBias(ix) {
  const sigs = [];
  function addDay(t, d) {
    if (!d || d.change == null) { sigs.push({ label: t + ' day', value: null, state: 'unknown', pts: 0 }); return; }
    const pts = d.change > 0.3 ? 1 : d.change < -0.3 ? -1 : 0;
    sigs.push({ label: t + ' day ' + (d.change >= 0 ? '+' : '') + d.change.toFixed(2) + '%', value: d.change, state: pts > 0 ? 'bull' : pts < 0 ? 'bear' : 'neu', pts });
  }
  addDay('SPY', ix.SPY); addDay('QQQ', ix.QQQ); addDay('IWM', ix.IWM);
  let vixPts = 0;
  if (ix.VIX && ix.VIX.change != null) {
    if (ix.VIX.change > 3) vixPts = -2; else if (ix.VIX.change > 1) vixPts = -1; else if (ix.VIX.change < -2) vixPts = 1;
    sigs.push({ label: 'VIX day ' + (ix.VIX.change >= 0 ? '+' : '') + ix.VIX.change.toFixed(2) + '%', value: ix.VIX.change, state: vixPts > 0 ? 'bull' : vixPts < 0 ? 'bear' : 'neu', pts: vixPts });
  } else sigs.push({ label: 'VIX day', value: null, state: 'unknown', pts: 0 });
  function addWeek(t, d) {
    if (!d || d.weekChg == null) { sigs.push({ label: t + ' week', value: null, state: 'unknown', pts: 0 }); return; }
    const pts = d.weekChg > 1 ? 1 : d.weekChg < -1 ? -1 : 0;
    sigs.push({ label: t + ' week ' + (d.weekChg >= 0 ? '+' : '') + d.weekChg.toFixed(2) + '%', value: d.weekChg, state: pts > 0 ? 'bull' : pts < 0 ? 'bear' : 'neu', pts });
  }
  addWeek('SPY', ix.SPY); addWeek('QQQ', ix.QQQ);
  const score = sigs.reduce((a, x) => a + x.pts, 0);
  return { result: score >= 3 ? 'BULLISH' : score <= -3 ? 'BEARISH' : 'NEUTRAL', score, signals: sigs };
}

function computeMidTermBias(ix) {
  const n = num;
  let src = ix.SPY, name = 'SPY';
  function ok(d) { return d && n(d.close) != null && n(d.sma5) != null && n(d.sma20) != null; }
  if (!ok(src)) { if (ok(ix.QQQ)) { src = ix.QQQ; name = 'QQQ'; } else return { stage:'UNKNOWN', stageLabel:'Unavailable', bb:'UNKNOWN', bbPct:null, signals:[], bull:0, unk:0, src:'' }; }
  const sig = [];
  function add(label, lhs, rhs, tf) {
    if (n(lhs) == null || n(rhs) == null) { sig.push({ label, state:'unknown', tf }); return; }
    sig.push({ label, state: lhs > rhs ? 'bull' : 'bear', tf });
  }
  add('Close > 5DMA', src.close, src.sma5, 'D'); add('Close > 20DMA', src.close, src.sma20, 'D');
  add('5DMA > 20DMA', src.sma5, src.sma20, 'D'); add('20DMA > 50DMA', src.sma20, src.sma50, 'D');
  add('1H Close > 20MA', src.closeH, src.sma20H, 'H'); add('1H 5MA > 20MA', src.sma5H, src.sma20H, 'H');
  const bull = sig.filter(x => x.state === 'bull').length;
  const unk  = sig.filter(x => x.state === 'unknown').length;
  const ca5 = n(src.close) != null && n(src.sma5) != null ? src.close > src.sma5 : null;
  const s5a20 = n(src.sma5) != null && n(src.sma20) != null ? src.sma5 > src.sma20 : null;
  let stage, stageLabel;
  if (bull >= 5) { stage = 'UPTREND'; stageLabel = 'Uptrend — buyers in control'; }
  else if (bull === 4 && ca5 === true) { stage = 'UPTREND'; stageLabel = 'Uptrend — buyers in control'; }
  else if (bull >= 3 && bull <= 4 && ca5 === false && s5a20 === true) { stage = 'PULLBACK'; stageLabel = 'Pullback — uptrend correction'; }
  else if (bull >= 2 && bull <= 3 && ca5 === true && s5a20 === false) { stage = 'REBOUND'; stageLabel = 'Rebound — counter-rally in downtrend'; }
  else if (bull >= 2 && bull <= 3) { stage = 'SIDEWAYS'; stageLabel = 'Sideways — no clear edge'; }
  else { stage = 'DOWNTREND'; stageLabel = 'Downtrend — sellers in control'; }
  let bb = 'UNKNOWN', bbPct = null;
  let up = src.bbUpper, lo = src.bbLower, cl = src.close;
  if (n(up) == null || n(lo) == null) { up = src.bbUpperH; lo = src.bbLowerH; cl = src.closeH; }
  if (n(up) != null && n(lo) != null && n(cl) != null && up > lo) {
    let p = (cl - lo) / (up - lo); p = Math.max(0, Math.min(1, p));
    bbPct = p; bb = p >= 0.75 ? 'UPPER' : p <= 0.25 ? 'LOWER' : 'MID';
  }
  return { stage, stageLabel, bb, bbPct, signals: sig, bull, unk, src: name };
}

function computeLongTermBias(ix) {
  const n = num;
  let src = ix.SPY, name = 'SPY';
  function ok(d) { return d && n(d.close) != null && n(d.sma200) != null && n(d.sma50) != null; }
  if (!ok(src)) { if (ok(ix.QQQ)) { src = ix.QQQ; name = 'QQQ'; } else return { bias:'UNKNOWN', label:'200DMA unavailable', dist:null, src:'SPY' }; }
  const above = src.close > src.sma200, golden = src.sma50 > src.sma200;
  const dist = src.sma200 > 0 ? (src.close - src.sma200) / src.sma200 * 100 : null;
  let bias, label;
  if (above && golden)   { bias = 'BULLISH';    label = 'Long-term uptrend (above 200DMA + golden cross)'; }
  else if (above)        { bias = 'RECOVERING'; label = 'Recovering — above 200DMA but death cross'; }
  else if (golden)       { bias = 'WEAKENING';  label = 'Weakening — below 200DMA but golden cross'; }
  else                   { bias = 'BEARISH';    label = 'Long-term downtrend (below 200DMA + death cross)'; }
  return { bias, label, dist, src: name };
}

function sectorShortTermBias(name, etf, spy) {
  const e = etf[name], n = num;
  if (!e) return { dir: 'NEUTRAL', score: 0 };
  const spyD = n(spy && spy.change) || 0, spyW = n(spy && spy.weekChg) || 0;
  const eD = n(e.change) || 0, eW = n(e.weekChg) || 0;
  const dRS = eD - spyD, wRS = eW - spyW;
  let s = 0;
  s += clampN(eD / 1.5, -1, 1) * 18;
  s += clampN(eW / 4, -1, 1) * 14;
  s += clampN(dRS / 1.2, -1, 1) * 20;
  s += clampN(wRS / 3, -1, 1) * 16;
  if (n(e.close) != null && n(e.vwap) != null && e.vwap > 0) s += e.close > e.vwap ? 10 : -10;
  if (n(e.adx) != null && e.adx > 20) s += (eD >= 0 ? 1 : -1) * Math.min((e.adx - 20) / 30, 1) * 12;
  if (n(e.rvol) != null && e.rvol >= 1.2) s += (eD >= 0 ? 1 : -1) * 10;
  s = clampN(s, -100, 100);
  return { dir: s >= 18 ? 'BULLISH' : s <= -18 ? 'BEARISH' : 'NEUTRAL', score: Math.round(s), dRS: Math.round(dRS * 100) / 100 };
}

function regimeClassify(ltBias, stage, bb) {
  const L = String(ltBias || '').toUpperCase(), S = String(stage || '').toUpperCase();
  let slug = REGIME_MATRIX[L + '|' + S] || 'UNKNOWN';
  if (slug === 'STRONG_UP'   && bb === 'UPPER') slug = 'EXTENDED_UP';
  if (slug === 'STRONG_DOWN' && bb === 'LOWER') slug = 'CAPITULATION';
  const cat = REGIME_CATALOG[slug] || REGIME_CATALOG.UNKNOWN;
  return { slug, label: cat.label, icon: cat.icon, color: cat.color, bias: cat.bias };
}

async function fetchMarketData() {
  const n = num;
  const cols = ['close','change','Perf.W','VWAP','ADX','SMA5','SMA20','SMA50','SMA200',
    'BB.upper','BB.lower','close|60','SMA5|60','SMA20|60','BB.upper|60','BB.lower|60'];
  const r = await fetch(TV_SCAN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ symbols: { tickers: MARKET_TICKERS }, columns: cols, options: { lang: 'en' } })
  });
  if (!r.ok) throw new Error('marketData HTTP ' + r.status);
  const data = await r.json();
  const out = {};
  (data.data || []).forEach(item => {
    const ro = rowObj(item, cols), short = String(item.s || '').replace(/^.*:/, '');
    out[short] = { change: n(ro['change']), weekChg: n(ro['Perf.W']), vwap: n(ro['VWAP']), adx: n(ro['ADX']),
      close: n(ro['close']), sma5: n(ro['SMA5']), sma20: n(ro['SMA20']), sma50: n(ro['SMA50']), sma200: n(ro['SMA200']),
      bbUpper: n(ro['BB.upper']), bbLower: n(ro['BB.lower']),
      closeH: n(ro['close|60']), sma5H: n(ro['SMA5|60']), sma20H: n(ro['SMA20|60']),
      bbUpperH: n(ro['BB.upper|60']), bbLowerH: n(ro['BB.lower|60']) };
  });
  return out;
}

async function fetchSectorETFs() {
  const n = num;
  const cols = ['close','change','Perf.W','VWAP','ADX','relative_volume_intraday|5'];
  const r = await fetch(TV_SCAN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ symbols: { tickers: Object.values(SECTOR_ETF_MAP) }, columns: cols, options: { lang: 'en' } })
  });
  if (!r.ok) throw new Error('sectorETFs HTTP ' + r.status);
  const data = await r.json();
  const out = {};
  (data.data || []).forEach(item => {
    const sym = String(item.s || ''), ro = rowObj(item, cols);
    const name = SECTOR_ETF_REVERSE[sym] || sym.replace(/^.*:/, '');
    out[name] = { etf: sym.replace(/^.*:/, ''), close: n(ro['close']), change: n(ro['change']),
      weekChg: n(ro['Perf.W']), vwap: n(ro['VWAP']), adx: n(ro['ADX']), rvol: n(ro['relative_volume_intraday|5']) };
  });
  return out;
}

function buildMarketSnapshot(ix, etf, hot) {
  const st  = computeShortTermBias(ix);
  const mid = computeMidTermBias(ix);
  const lt  = computeLongTermBias(ix);
  const rg  = regimeClassify(lt.bias, mid.stage, mid.bb);
  const sectors = {};
  Object.keys(etf).forEach(name => {
    const e = etf[name], sc = sectorShortTermBias(name, etf, ix.SPY);
    sectors[name] = { etf: e.etf, close: e.close, change: e.change, weekChg: e.weekChg,
      adx: e.adx, bias: sc.dir, score: sc.score, dRS: sc.dRS };
  });
  const indices = {};
  ['SPY','QQQ','IWM','DIA','VIX'].forEach(k => {
    if (!ix[k]) return;
    indices[k] = { close: ix[k].close, change: ix[k].change, weekChg: ix[k].weekChg,
      sma5: ix[k].sma5, sma20: ix[k].sma20, sma50: ix[k].sma50, sma200: ix[k].sma200 };
  });
  const ltSrc = ix[lt.src] || {};
  return {
    indices,
    shortTerm: { result: st.result, score: st.score, signals: st.signals },
    midTerm: { result: mid.stage, stageLabel: mid.stageLabel, src: mid.src,
      bull: mid.bull, unk: mid.unk, bb: mid.bb, bbPct: mid.bbPct, signals: mid.signals },
    longTerm: { result: lt.bias, label: lt.label, src: lt.src, dist: lt.dist,
      above200: ltSrc.close != null && ltSrc.sma200 != null ? ltSrc.close > ltSrc.sma200 : null,
      goldenCross: ltSrc.sma50 != null && ltSrc.sma200 != null ? ltSrc.sma50 > ltSrc.sma200 : null },
    regime: rg,
    sectors,
    breakoutNames: (hot || []).map(x => x.ticker)
  };
}

// ══════════════════════════════════════════════════════════════════
// EOD OUTCOME (R3) — ported from background.js
// ══════════════════════════════════════════════════════════════════
function yahooSymbol(sym) {
  const s = String(sym || '').toUpperCase().replace(/^.*:/, '').trim();
  if (s === 'VIX' || s === '^VIX') return '%5EVIX';
  return encodeURIComponent(s);
}

const _etHhmmFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false
});
function _toEtHhmm(epochSec) {
  const parts = _etHhmmFmt.formatToParts(new Date(epochSec * 1000));
  return parts.find(p => p.type === 'hour').value + ':' + parts.find(p => p.type === 'minute').value;
}

async function fetchYahooIntraday(sym, fromMs, toMs, intervalMin) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const interval = (!intervalMin || intervalMin <= 1) ? '1m' : '5m';
  const p1 = Math.floor((fromMs || (Date.now() - 86400000)) / 1000);
  const p2 = Math.floor((toMs || Date.now()) / 1000);
  const path = '/v8/finance/chart/' + yahooSymbol(sym) +
    '?period1=' + p1 + '&period2=' + p2 +
    '&interval=' + interval + '&includePrePost=true';
  for (const host of hosts) {
    try {
      const r = await fetch('https://' + host + path, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      const ts = res && res.timestamp;
      const q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
      if (!ts || !q) continue;
      const bars = [];
      for (let k = 0; k < ts.length; k++) {
        const o = q.open[k], h = q.high[k], l = q.low[k], c = q.close[k];
        if (o == null || h == null || l == null || c == null) continue;
        // time: UTC epoch seconds (for LightweightCharts); hhmm: ET "HH:MM" (for R3 entry matching)
        bars.push({ time: ts[k], hhmm: _toEtHhmm(ts[k]), open: +o, high: +h, low: +l, close: +c });
      }
      if (bars.length) return bars;
    } catch (_) {}
  }
  return null;
}

async function fetchDailyHistory(sym, range) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const path = '/v8/finance/chart/' + yahooSymbol(sym) + '?range=' + (range || '1mo') + '&interval=1d&includePrePost=false';
  for (const host of hosts) {
    try {
      const r = await fetch('https://' + host + path, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      const ts = res && res.timestamp;
      const q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
      if (!ts || !q) continue;
      const bars = [];
      for (let k = 0; k < ts.length; k++) {
        const o = q.open[k], h = q.high[k], l = q.low[k], c = q.close[k];
        if (o == null || h == null || l == null || c == null) continue;
        const d = new Date(ts[k] * 1000);
        bars.push({ time: d.toISOString().slice(0, 10), open: +o, high: +h, low: +l, close: +c });
      }
      if (bars.length) return bars;
    } catch (_) {}
  }
  return null;
}

function computeAtr14(bars) {
  if (!bars || bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high || bars[i].close, l = bars[i].low || bars[i].close, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < 14) return null;
  let atr = trs.slice(0, 14).reduce((a, x) => a + x, 0) / 14;
  for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
  return atr;
}

function hhll(bars, fromHhmm, toHhmm) {
  let hh = -Infinity, ll = Infinity;
  for (const bar of bars) {
    if (bar.hhmm < fromHhmm || bar.hhmm > toHhmm) continue;
    if (bar.high > hh) hh = bar.high;
    if (bar.low < ll) ll = bar.low;
  }
  return { hh: hh === -Infinity ? null : hh, ll: ll === Infinity ? null : ll };
}

async function runEodOutcome(date) {
  const r1Day = getFrozenScreener(date);
  if (!r1Day || !r1Day.rows || !Object.keys(r1Day.rows).length)
    throw new Error('No R1 data for ' + date + '. Run screener first.');

  const existing = getEodOutcome(date) || {};
  const store = { rows: existing.rows || {}, capturedAt: etTimeStr(), complete: false };
  const tickers = Object.keys(r1Day.rows);

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 600));
    const r1Row = r1Day.rows[ticker];
    const r1Atr = (r1Row.stock && r1Row.stock.atr != null) ? +r1Row.stock.atr : null;

    const [intradayBars, dailyBars] = await Promise.all([
      fetchYahooIntraday(ticker),
      fetchDailyHistory(ticker, '1mo').catch(() => null)
    ]);

    const prevBars = dailyBars ? dailyBars.filter(b => b.time < date) : [];
    const histAtr = computeAtr14(prevBars);
    const atr = histAtr != null ? histAtr : r1Atr;
    const atrSource = histAtr != null ? 'hist14' : (r1Atr != null ? 'r1_fallback' : 'unknown');

    if (!intradayBars || !intradayBars.length) {
      store.rows[ticker] = { ticker, atr, atrSource, status: 'no_data', fetchedAt: Date.now() };
      continue;
    }

    const lastBar = intradayBars[intradayBars.length - 1];
    const status = lastBar && lastBar.hhmm >= '15:55' ? 'ok' : 'partial_data';

    let bar35 = null, bar40 = null;
    for (const b of intradayBars) { if (b.hhmm >= '09:35' && !bar35) bar35 = b; if (b.hhmm >= '09:40' && !bar40) bar40 = b; }

    const e35 = bar35 ? bar35.open : null, e40 = bar40 ? bar40.open : null;
    const r35 = hhll(intradayBars, '09:35', '16:00'), r40 = hhll(intradayBars, '09:40', '16:00');

    store.rows[ticker] = {
      ticker, atr, atrSource,
      entry35: e35, hh35: r35.hh, ll35: r35.ll,
      downR35: (atr && r35.ll != null && e35 != null) ? (e35 - r35.ll) / atr : null,
      upR35:   (atr && r35.hh != null && e35 != null) ? (r35.hh - e35) / atr : null,
      entry40: e40, hh40: r40.hh, ll40: r40.ll,
      downR40: (atr && r40.ll != null && e40 != null) ? (e40 - r40.ll) / atr : null,
      upR40:   (atr && r40.hh != null && e40 != null) ? (r40.hh - e40) / atr : null,
      lastBarTime: lastBar ? lastBar.hhmm : null,
      fetchedAt: Date.now(), status
    };
  }

  store.complete = true;
  store.capturedAt = etTimeStr();
  saveEodOutcome(date, store);
  return store;
}

// ══════════════════════════════════════════════════════════════════
// SCREENER FREEZE (R1) — capture + save
// ══════════════════════════════════════════════════════════════════
const SNAPSHOT_SLOTS = ['09:30','09:35','09:40','09:45','09:50','09:55','10:00','12:00','15:45'];

async function captureAndSaveSnapshot(slot) {
  const date = etDateStr();
  const existing = getMarketSnapshotsForDate(date);
  if (existing[slot] && existing[slot].complete === true) return;
  try {
    const [ix, etf, hot] = await Promise.all([
      fetchMarketData(),
      fetchSectorETFs(),
      (async () => { try {
        const b = { columns: ['ticker-view'], filter: [
          { left: 'close', operation: 'egreater', right: 1 },
          { left: 'relative_volume_10d_calc', operation: 'greater', right: 2 },
          { left: 'Perf.W', operation: 'egreater', right: 2 }
        ], filter2: STOCK_FILTER2, ignore_unknown_fields: false, markets: ['america'],
          options: { lang: 'en' }, range: [0, 100], sort: { sortBy: 'Perf.W', sortOrder: 'desc' }, symbols: {} };
        const r = await tvScanDirect(b);
        return (r.data || []).map(item => {
          const tv = rowObj(item, ['ticker-view'])['ticker-view'];
          let t = '';
          if (tv && typeof tv === 'object' && tv.symbol) t = tv.symbol;
          else if (typeof tv === 'string') t = tv; else t = String(item.s || '');
          return { ticker: t.replace(/^.*:/, '').trim() };
        }).filter(x => x.ticker);
      } catch (_) { return []; } })()
    ]);
    const snap = buildMarketSnapshot(ix, etf, hot);
    const nSectors = Object.keys(snap.sectors || {}).length;
    const complete = !!(snap.indices.VIX && snap.indices.VIX.change != null &&
      snap.shortTerm && snap.shortTerm.signals && snap.shortTerm.signals.length >= 6 &&
      nSectors >= 10 && snap.longTerm && snap.longTerm.dist != null);
    const obj = Object.assign({ slot, capturedAt: etTimeStr(), ts: Date.now(), complete }, snap);
    saveMarketSnapshot(date, slot, obj);
    console.log(`[${etTimeStr()}] R2 snapshot saved: ${date} ${slot} — complete=${complete}`);
  } catch (err) {
    const obj = { slot, capturedAt: etTimeStr(), ts: Date.now(), complete: false, reason: err.message };
    saveMarketSnapshot(date, slot, obj);
    console.error(`[${etTimeStr()}] R2 snapshot failed: ${err.message}`);
  }
}

async function freezeScreener(slot) {
  const date = etDateStr();
  const existing = getFrozenScreener(date);
  if (existing && existing.complete === true) return;
  try {
    const results = await Promise.all([
      runScreener('trend').catch(() => []),
      runScreener('premarket').catch(() => []),
      runScreener('bigmoves').catch(() => [])
    ]);
    const rows = {}, seen = {};
    const keys = ['trend', 'premarket', 'bigmoves'];
    results.forEach((stocks, i) => {
      stocks.forEach(s => {
        if (!seen[s.ticker]) { seen[s.ticker] = []; rows[s.ticker] = { stock: s, screenerKeys: [], lastUpdated: Date.now() }; }
        seen[s.ticker].push(keys[i]);
        rows[s.ticker].screenerKeys = seen[s.ticker];
      });
    });
    if (!Object.keys(rows).length) { console.log('[R1] Screener returned 0 results'); return; }

    const snaps = getMarketSnapshotsForDate(date);
    const snap = snaps[slot] || snaps['09:35'] || snaps['09:30'] || null;
    if (snap) {
      Object.keys(rows).forEach(ticker => {
        const s = rows[ticker].stock;
        const sec = (snap.sectors && snap.sectors[s.sector]) || { bias: 'NEUTRAL', score: 0 };
        rows[ticker].context = {
          secBias: sec.bias, secScore: sec.score,
          shortTerm: (snap.shortTerm && snap.shortTerm.result) || 'NEUTRAL',
          marketBias: (snap.shortTerm && snap.shortTerm.result) || 'NEUTRAL',
          longTerm: (snap.longTerm && snap.longTerm.result) || 'UNKNOWN',
          longTermLabel: (snap.longTerm && snap.longTerm.label) || '',
          midTerm: (snap.midTerm && snap.midTerm.result) || 'UNKNOWN',
          midTermLabel: (snap.midTerm && snap.midTerm.stageLabel) || ''
        };
      });
    }
    const complete = Object.keys(rows).every(t => rows[t].stock && rows[t].stock.price != null);
    saveFrozenScreener(date, { slot, capturedAt: etTimeStr(), ts: Date.now(), rows, complete, reason: complete ? '' : 'Some rows incomplete' });
    console.log(`[${etTimeStr()}] R1 frozen: ${date} ${slot} — ${Object.keys(rows).length} stocks, complete=${complete}`);
  } catch (err) {
    console.error(`[${etTimeStr()}] R1 freeze failed: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// CRON JOBS
// ══════════════════════════════════════════════════════════════════
function startCronJobs() {
  const TZ = 'America/New_York';

  // Market snapshots (R2)
  cron.schedule('30 9 * * 1-5', () => captureAndSaveSnapshot('09:30'), { timezone: TZ });
  cron.schedule('35 9 * * 1-5', () => captureAndSaveSnapshot('09:35'), { timezone: TZ });
  cron.schedule('40 9 * * 1-5', () => captureAndSaveSnapshot('09:40'), { timezone: TZ });
  cron.schedule('45 9 * * 1-5', () => captureAndSaveSnapshot('09:45'), { timezone: TZ });
  cron.schedule('50 9 * * 1-5', () => captureAndSaveSnapshot('09:50'), { timezone: TZ });
  cron.schedule('55 9 * * 1-5', () => captureAndSaveSnapshot('09:55'), { timezone: TZ });
  cron.schedule('0 10 * * 1-5', () => captureAndSaveSnapshot('10:00'), { timezone: TZ });
  cron.schedule('0 12 * * 1-5', () => captureAndSaveSnapshot('12:00'), { timezone: TZ });
  cron.schedule('45 15 * * 1-5', () => captureAndSaveSnapshot('15:45'), { timezone: TZ });

  // Screener freeze (R1) — at 09:35 and 09:40
  cron.schedule('35 9 * * 1-5', () => freezeScreener('09:35'), { timezone: TZ });
  cron.schedule('40 9 * * 1-5', () => freezeScreener('09:40'), { timezone: TZ });

  // EOD outcome (R3) at 16:05 ET
  cron.schedule('5 16 * * 1-5', async () => {
    const autoMode = getSetting('snapshotMode', 'manual');
    if (autoMode !== 'auto') return;
    const date = etDateStr();
    console.log('[EOD] Auto-running R3 for', date);
    try { await runEodOutcome(date); console.log('[EOD] Complete for', date); }
    catch (err) { console.error('[EOD] Failed:', err.message); }
  }, { timezone: TZ });

  // Daily data backup at 16:30 ET — write JSON files then git-commit if git available
  cron.schedule('30 16 * * 1-5', async () => {
    const { exec } = require('child_process');
    const fs = require('fs');
    const date = etDateStr();
    const dataRepo = process.env.DATA_BACKUP_DIR || path.join(__dirname, 'backups');
    const outDir = path.join(dataRepo, date);
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const ts = new Date().toISOString();
      const types = [
        ['frozenScreener',  getAllFrozenScreener()],
        ['marketSnapshots', getAllMarketSnapshots()],
        ['eodOutcome',      getAllEodOutcome()],
        ['registry',        getRegistry()],
        ['journalTrades',   getJournalTrades()],
      ];
      for (const [type, data] of types) {
        fs.writeFileSync(path.join(outDir, type + '.json'),
          JSON.stringify({ _type: type, _exported: ts, data }, null, 2));
      }
      console.log('[BACKUP] Wrote JSON files to', outDir);
      // Attempt git commit+push (works only if remote auth is configured on the machine)
      const repoRoot = path.join(__dirname, '..');
      const script = path.join(__dirname, 'scripts', 'backup.sh');
      if (fs.existsSync(script)) {
        exec('bash "' + script + '"', { cwd: repoRoot }, (err, stdout, stderr) => {
          if (err) console.error('[BACKUP] git push failed:', err.message);
          else console.log('[BACKUP] git push OK:', stdout.trim());
        });
      }
    } catch (err) { console.error('[BACKUP] Failed:', err.message); }
  }, { timezone: TZ });

  console.log('[CRON] All jobs scheduled (America/New_York timezone)');
}

// ══════════════════════════════════════════════════════════════════
// EXPRESS API
// ══════════════════════════════════════════════════════════════════
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
// No-cache for files that change on every deploy (app.js, chrome-shim.js)
app.use(['/app.js', '/chrome-shim.js'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Serve factor-analysis.html from repo root (lives alongside popup.html)
app.get('/factor-analysis.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'factor-analysis.html'));
});

// Merged register — same join as exportMergedRegisterCsv() in app.js, returned as JSON rows
app.get('/api/merged-register', (req, res) => {
  const allR1 = getAllFrozenScreener();
  const allR3 = getAllEodOutcome();
  const allR2 = getAllMarketSnapshots();
  const n = v => (v != null && isFinite(v)) ? Number(v).toFixed(4) : '';
  const catalystLabel = row => (row && row.catalyst && row.catalyst.label) ? row.catalyst.label : '';
  const rows = [];
  Object.keys(allR1).sort().forEach(date => {
    const r1Day = allR1[date];
    if (!r1Day || !r1Day.rows) return;
    const r3Day   = allR3[date] || {};
    const r2Day   = allR2[date] || {};
    const snap935 = r2Day['09:35'] || null;
    const snap940 = r2Day['09:40'] || null;
    Object.keys(r1Day.rows).sort().forEach(ticker => {
      const row = r1Day.rows[ticker], st = row.stock || {}, ctx = row.context || {};
      const e3  = (r3Day.rows && r3Day.rows[ticker]) || {};
      const sec = st.sector || '';
      const sb935 = snap935 && snap935.sectors && snap935.sectors[sec] ? snap935.sectors[sec].bias : '';
      const sb940 = snap940 && snap940.sectors && snap940.sectors[sec] ? snap940.sectors[sec].bias : '';
      rows.push({
        date, slot: r1Day.slot || '', captured_at: r1Day.capturedAt || '',
        last_refreshed_at: row.lastUpdated ? new Date(row.lastUpdated).toISOString() : '',
        complete: r1Day.complete ? 'true' : 'false', reason: r1Day.reason || '',
        ticker, tv_symbol: st.tvSymbol || row.tvSymbol || '',
        screeners: (row.screenerKeys || []).join('|'),
        price: n(st.price), open: n(st.open), change_pct: n(st.change),
        prev_close: n(st.prevClose), gap_pct: n(st.gapPct), vwap: n(st.vwap),
        ema9: n(st.ema9), ema13: n(st.ema13), ema20: n(st.ema20), ema50: n(st.ema50), sma5: n(st.sma5),
        month_high: n(st.monthHigh), month_low: n(st.monthLow),
        day_high: n(st.dayHigh), day_low: n(st.dayLow), atr: n(st.atr),
        pm_high: n(st.pmHigh), pm_low: n(st.pmLow), pm_range: n(st.pmRange),
        adr_pct: n(st.adrPct), month_range_pos: n(st.monthRangePos), pm_adr_ratio: n(st.pmAdrRatio),
        mcap: n(st.mcap), float_shares: n(st.floatShares), short_float: n(st.shortFloat),
        rvol: n(st.rvol), rvat: n(st.rvat), catalyst: catalystLabel(row),
        sector: sec, industry: st.industry || '',
        st_bias: ctx.shortTerm || '', lt_bias: ctx.longTerm || '',
        lt_label: ctx.longTermLabel || '', mid_term: ctx.midTerm || '',
        mid_term_label: ctx.midTermLabel || '', sec_bias: ctx.secBias || '',
        sec_score: n(ctx.secScore),
        sec_hot: ctx.secHot != null ? (ctx.secHot ? 'true' : 'false') : '',
        market_bias: ctx.marketBias || '',
        entry35: n(e3.entry35), hh35: n(e3.hh35), ll35: n(e3.ll35),
        down_r35: n(e3.downR35), up_r35: n(e3.upR35),
        entry40: n(e3.entry40), hh40: n(e3.hh40), ll40: n(e3.ll40),
        down_r40: n(e3.downR40), up_r40: n(e3.upR40),
        eod_atr: n(e3.atr), eod_atr_source: e3.atrSource || '',
        last_bar: e3.lastBarTime || '', fetched_at: e3.fetchedAt || '',
        eod_status: e3.status || '',
        snap935_lt:       snap935 ? ((snap935.longTerm  && snap935.longTerm.result)  || '') : '',
        snap935_mt:       snap935 ? ((snap935.midTerm   && snap935.midTerm.result)   || '') : '',
        snap935_st:       snap935 ? ((snap935.shortTerm && snap935.shortTerm.result) || '') : '',
        snap935_regime:   snap935 ? ((snap935.regime    && snap935.regime.slug)      || '') : '',
        snap935_sec_bias: sb935,
        snap940_lt:       snap940 ? ((snap940.longTerm  && snap940.longTerm.result)  || '') : '',
        snap940_mt:       snap940 ? ((snap940.midTerm   && snap940.midTerm.result)   || '') : '',
        snap940_st:       snap940 ? ((snap940.shortTerm && snap940.shortTerm.result) || '') : '',
        snap940_regime:   snap940 ? ((snap940.regime    && snap940.regime.slug)      || '') : '',
        snap940_sec_bias: sb940
      });
    });
  });
  res.json({ ok: true, count: rows.length, rows });
});

// Status
app.get('/api/status', (req, res) => {
  res.json({
    ok: true, time: etTimeStr(), date: etDateStr(),
    weekday: isWeekdayET(), mode: getSetting('snapshotMode', 'manual'),
    node: process.version
  });
});

// Settings
app.get('/api/settings', (req, res) => res.json(getAllSettings()));
app.put('/api/settings', (req, res) => {
  const body = req.body || {};
  Object.keys(body).forEach(k => setSetting(k, body[k]));
  res.json({ ok: true });
});

// ── R2: Market Snapshots ──────────────────────────────────────────
app.get('/api/snapshots', (req, res) => res.json(getAllMarketSnapshots()));
app.get('/api/snapshots/:date', (req, res) => res.json(getMarketSnapshotsForDate(req.params.date) || {}));
app.post('/api/snapshots/run', async (req, res) => {
  const slot = req.body && req.body.slot;
  if (!SNAPSHOT_SLOTS.includes(slot)) return res.status(400).json({ ok: false, error: 'Invalid slot' });
  try { await captureAndSaveSnapshot(slot); res.json({ ok: true, slot }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── R1: Frozen Screener ───────────────────────────────────────────
app.get('/api/screener', (req, res) => res.json(getAllFrozenScreener()));
app.get('/api/screener/:date', (req, res) => {
  const d = getFrozenScreener(req.params.date);
  if (!d) return res.status(404).json({ ok: false, error: 'No data for ' + req.params.date });
  res.json(d);
});
app.post('/api/screener/run', async (req, res) => {
  const slot = (req.body && req.body.slot) || '09:35';
  try {
    await Promise.all([captureAndSaveSnapshot(slot), new Promise(r => setTimeout(r, 1000))]);
    await freezeScreener(slot);
    const d = getFrozenScreener(etDateStr());
    res.json({ ok: true, count: d ? Object.keys(d.rows || {}).length : 0 });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── R3: EOD Outcome ───────────────────────────────────────────────
app.get('/api/eod', (req, res) => res.json(getAllEodOutcome()));
app.get('/api/eod/:date', (req, res) => {
  const d = getEodOutcome(req.params.date);
  if (!d) return res.status(404).json({ ok: false, error: 'No data for ' + req.params.date });
  res.json(d);
});
app.post('/api/eod/run', async (req, res) => {
  const date = (req.body && req.body.date) || etDateStr();
  try {
    const result = await runEodOutcome(date);
    res.json({ ok: true, count: Object.keys(result.rows || {}).length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Backfill R3 for all R1 dates that have no R3 entry yet
app.post('/api/eod/backfill', async (req, res) => {
  const r1Dates = db.prepare('SELECT date FROM frozen_screener ORDER BY date ASC').all().map(r => r.date);
  const r3Dates = new Set(db.prepare('SELECT date FROM eod_outcome').all().map(r => r.date));
  const missing = r1Dates.filter(d => !r3Dates.has(d));
  const results = { backfilled: [], skipped: [], errors: {} };
  for (const date of missing) {
    try {
      const out = await runEodOutcome(date);
      results.backfilled.push({ date, count: Object.keys(out.rows || {}).length });
    } catch (err) {
      results.errors[date] = err.message;
    }
  }
  res.json({ ok: true, ...results });
});

// Per-date coverage audit across R1/R2/R3
app.get('/api/data/audit', (req, res) => {
  const r1Rows = db.prepare('SELECT date, data FROM frozen_screener ORDER BY date ASC').all();
  const r2Rows = db.prepare('SELECT date, slot, data FROM market_snapshots ORDER BY date ASC, slot ASC').all();
  const r3Rows = db.prepare('SELECT date, data FROM eod_outcome ORDER BY date ASC').all();

  const r1ByDate = {};
  r1Rows.forEach(r => { r1ByDate[r.date] = JSON.parse(r.data); });

  const r2ByDate = {};
  r2Rows.forEach(r => {
    if (!r2ByDate[r.date]) r2ByDate[r.date] = {};
    r2ByDate[r.date][r.slot] = JSON.parse(r.data);
  });

  const r3ByDate = {};
  r3Rows.forEach(r => { r3ByDate[r.date] = JSON.parse(r.data); });

  const allDates = new Set([
    ...r1Rows.map(r => r.date),
    ...r2Rows.map(r => r.date),
    ...r3Rows.map(r => r.date),
  ]);

  const dates = Array.from(allDates).sort().reverse().map(date => {
    const r1 = r1ByDate[date];
    const r1Tickers = r1 ? Object.keys(r1.rows || {}) : [];

    const r2 = r2ByDate[date] || {};
    const r2Present = SNAPSHOT_SLOTS.filter(s => r2[s]);
    const r2Missing = SNAPSHOT_SLOTS.filter(s => !r2[s]);
    const r2CompleteCount = r2Present.filter(s => r2[s] && r2[s].complete === true).length;
    const r2IncompleteSlots = r2Present.filter(s => r2[s] && r2[s].complete !== true);

    const r3 = r3ByDate[date];
    const r3Tickers = r3 ? Object.keys(r3.rows || {}) : [];

    const warn = !r1 || !r1.complete || r2Missing.length > 0 || r2IncompleteSlots.length > 0 || !r3 || !r3.complete;
    return {
      date,
      r1: r1 ? { count: r1Tickers.length, tickers: r1Tickers, slot: r1.slot || '?', capturedAt: r1.capturedAt || '', complete: r1.complete === true } : null,
      r2: { present: r2Present, missing: r2Missing, incomplete: r2IncompleteSlots, count: r2Present.length, total: SNAPSHOT_SLOTS.length, completeCount: r2CompleteCount },
      r3: r3 ? { count: r3Tickers.length, tickers: r3Tickers, capturedAt: r3.capturedAt || '', complete: r3.complete === true } : null,
      status: warn ? 'warn' : 'ok',
    };
  });

  res.json({ ok: true, dates, expectedSlots: SNAPSHOT_SLOTS });
});

// ── Journal ───────────────────────────────────────────────────────
app.get('/api/journal', (req, res) => res.json(getJournalTrades()));
app.post('/api/journal', (req, res) => {
  const trade = req.body;
  if (!trade || !trade.id) return res.status(400).json({ ok: false, error: 'id required' });
  saveJournalTrade(trade);
  res.json({ ok: true });
});
app.delete('/api/journal/:id', (req, res) => {
  deleteJournalTrade(req.params.id);
  res.json({ ok: true });
});

// ── JSON Import (bulk restore from extension backups) ─────────────
app.post('/api/import', (req, res) => {
  const body = req.body;
  if (!body || !body._type) return res.status(400).json({ ok: false, error: 'Missing _type' });
  try {
    const data = body.data || body;
    if (body._type === 'frozenScreener') {
      Object.keys(data).forEach(date => saveFrozenScreener(date, data[date]));
      return res.json({ ok: true, type: 'frozenScreener', days: Object.keys(data).length });
    }
    if (body._type === 'marketSnapshots') {
      Object.keys(data).forEach(date => {
        Object.keys(data[date]).forEach(slot => saveMarketSnapshot(date, slot, data[date][slot]));
      });
      return res.json({ ok: true, type: 'marketSnapshots', days: Object.keys(data).length });
    }
    if (body._type === 'eodOutcome') {
      Object.keys(data).forEach(date => saveEodOutcome(date, data[date]));
      return res.json({ ok: true, type: 'eodOutcome', days: Object.keys(data).length });
    }
    if (body._type === 'journalTrades') {
      const trades = Array.isArray(data) ? data : Object.values(data);
      trades.forEach(t => { if (t && t.id) saveJournalTrade(t); });
      return res.json({ ok: true, type: 'journalTrades', count: trades.length });
    }
    if (body._type === 'registry') {
      const rows = Array.isArray(data) ? data : Object.values(data);
      rows.forEach(r => { if (r && r.ticker && r.date) upsertRegistryRow(r.ticker, r.date, r); });
      return res.json({ ok: true, type: 'registry', count: rows.length });
    }
    res.status(400).json({ ok: false, error: 'Unknown _type: ' + body._type });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Export JSON backups
app.get('/api/export/:type', (req, res) => {
  const type = req.params.type;
  if (type === 'frozenScreener') return res.json({ _type: 'frozenScreener', _exported: new Date().toISOString(), data: getAllFrozenScreener() });
  if (type === 'marketSnapshots') return res.json({ _type: 'marketSnapshots', _exported: new Date().toISOString(), data: getAllMarketSnapshots() });
  if (type === 'eodOutcome') return res.json({ _type: 'eodOutcome', _exported: new Date().toISOString(), data: getAllEodOutcome() });
  if (type === 'journalTrades') return res.json({ _type: 'journalTrades', _exported: new Date().toISOString(), data: getJournalTrades() });
  if (type === 'registry') return res.json({ _type: 'registry', _exported: new Date().toISOString(), data: getRegistry() });
  if (type === 'all') {
    const ts = new Date().toISOString();
    return res.json({
      _type: 'all', _exported: ts,
      frozenScreener:  { _type: 'frozenScreener',  _exported: ts, data: getAllFrozenScreener() },
      marketSnapshots: { _type: 'marketSnapshots', _exported: ts, data: getAllMarketSnapshots() },
      eodOutcome:      { _type: 'eodOutcome',      _exported: ts, data: getAllEodOutcome() },
      registry:        { _type: 'registry',         _exported: ts, data: getRegistry() },
      journalTrades:   { _type: 'journalTrades',    _exported: ts, data: getJournalTrades() },
    });
  }
  res.status(404).json({ ok: false, error: 'Unknown type' });
});

// ── Registry (R0) ─────────────────────────────────────────────────
app.get('/api/registry', (req, res) => res.json(getRegistry()));

app.post('/api/registry/sync', (req, res) => {
  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'rows array required' });
  rows.forEach(r => { if (r && r.ticker && r.date) upsertRegistryRow(r.ticker, r.date, r); });
  res.json({ ok: true, count: rows.length });
});

app.put('/api/registry/:key', (req, res) => {
  const parts = req.params.key.split('|');
  if (parts.length !== 2) return res.status(400).json({ ok: false, error: 'key must be TICKER|DATE' });
  upsertRegistryRow(parts[0], parts[1], req.body);
  res.json({ ok: true });
});

app.delete('/api/registry/:key', (req, res) => {
  const parts = req.params.key.split('|');
  if (parts.length === 2) db.prepare('DELETE FROM registry WHERE ticker=? AND date=?').run(parts[0], parts[1]);
  res.json({ ok: true });
});

// ── Shortlists ────────────────────────────────────────────────────
app.get('/api/shortlists', (req, res) => {
  try { res.json(JSON.parse(getSetting('shortlists', '{}'))); }
  catch { res.json({}); }
});
app.put('/api/shortlists', (req, res) => {
  setSetting('shortlists', JSON.stringify(req.body || {}));
  res.json({ ok: true });
});

// ── Generic KV store (settings table) ────────────────────────────
app.get('/api/kv/:key', (req, res) => {
  const val = getSetting('kv_' + req.params.key, null);
  if (val === null) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, value: val });
});
app.put('/api/kv/:key', (req, res) => {
  const v = req.body && req.body.value !== undefined ? req.body.value : '';
  setSetting('kv_' + req.params.key, String(v));
  res.json({ ok: true });
});

// ── Live Market Data (proxy→buildMarketSnapshot) ──────────────────
app.get('/api/market', async (req, res) => {
  try {
    const [ix, etf] = await Promise.all([fetchMarketData(), fetchSectorETFs()]);
    const snap = buildMarketSnapshot(ix, etf, []);
    res.json({ ok: true, data: snap });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── TradingView scanner proxy (generic body) ─────────────────────
app.post('/api/tvScan', async (req, res) => {
  try {
    const data = await tvScanDirect(req.body);
    res.json({ ok: true, data: data });  // return full TV response; popup.js reads resp.data.data
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Ticker profile (Yahoo quoteSummary → sector/industry) ─────────
app.get('/api/profile/:ticker', async (req, res) => {
  const ticker = encodeURIComponent(req.params.ticker);
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const host of hosts) {
    try {
      const r = await fetch(`https://${host}/v10/finance/quoteSummary/${ticker}?modules=assetProfile`,
        { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const d = await r.json();
      const res0 = d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
      const ap = res0 && res0.assetProfile;
      return res.json({ sector: (ap && ap.sector) || '', industry: (ap && ap.industry) || '' });
    } catch (_) {}
  }
  res.json({ sector: '', industry: '' });
});

// ── Batch open-price fetch (Yahoo Finance first 09:30 bar) ──────────────
app.post('/api/opens', async (req, res) => {
  const tickers = (req.body && Array.isArray(req.body.tickers)) ? req.body.tickers : [];
  if (!tickers.length) return res.json({});
  const results = await Promise.all(tickers.map(async (ticker) => {
    try {
      const bars = await fetchYahooIntraday(ticker, Date.now() - 86400000, Date.now(), 1);
      if (!bars || !bars.length) return [ticker, null];
      // Filter to today's ET date before searching — prevents yesterday's 09:30 bar
      // from being returned at pre-market hours (b.time is UTC epoch seconds)
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const todayBars = bars.filter(b =>
        new Date(b.time * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayET
      );
      const openBar = todayBars.find(b => b.hhmm >= '09:30');
      return [ticker, openBar ? openBar.open : null];
    } catch (_) { return [ticker, null]; }
  }));
  const out = {};
  results.forEach(([t, v]) => { out[t] = v; });
  res.json(out);
});

// ── News proxy (Finnhub + Yahoo Finance + SEC EDGAR) ─────────────
app.get('/api/news/:ticker', async (req, res) => {
  const ticker = req.params.ticker;
  const fhKey = getSetting('kv_smb_jnl_finnhub_key', '') || getSetting('finnhubKey', '');
  const toDate = new Date(), fromDate = new Date(Date.now() - 7 * 86400000);
  const fmt = d => d.toISOString().slice(0, 10);
  const YH_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

  const [finnhub, yahoo, edgar] = await Promise.all([
    // Finnhub (optional — requires API key, provides article summaries)
    fhKey ? fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${fmt(fromDate)}&to=${fmt(toDate)}&token=${fhKey}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    ).then(r => r.ok ? r.json() : []).catch(() => []) : Promise.resolve([]),

    // Yahoo Finance news — JSON search API (confirmed working from EC2)
    (async () => {
      for (const host of YH_HOSTS) {
        try {
          const r = await fetch(
            `https://${host}/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=15&quotesCount=0`,
            { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
          if (!r.ok) continue;
          const d = await r.json();
          const items = (d && d.news) || [];
          if (items.length) return items.slice(0, 15);
        } catch (_) {}
      }
      return [];
    })(),

    // SEC EDGAR recent 8-K / S-3 filings (best-effort — reveals catalyst and dilution risk)
    (async () => {
      try {
        const startdt = fmt(fromDate), enddt = fmt(toDate);
        const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22` +
          `&forms=8-K,S-3&dateRange=custom&startdt=${startdt}&enddt=${enddt}`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
        if (!r.ok) return [];
        const d = await r.json();
        const hits = (d && d.hits && d.hits.hits) || [];
        return hits.slice(0, 5).map(h => ({
          form: h._source.form_type || '',
          date: h._source.file_date || '',
          company: h._source.entity_name || '',
          url: h._source.file_url_www || ''
        }));
      } catch (_) { return []; }
    })()
  ]);

  res.json({ ok: true, finnhub: Array.isArray(finnhub) ? finnhub.slice(0, 10) : [], yahoo, edgar });
});

// ── Chart history (Yahoo: daily bars or 1m intraday) ──────────────
app.get('/api/chart/:ticker', async (req, res) => {
  const ticker = req.params.ticker;
  const range = req.query.range || '6mo';
  const interval = req.query.interval || '1d';
  try {
    const bars = interval === '1m'
      ? await fetchYahooIntraday(ticker)
      : await fetchDailyHistory(ticker, range);
    if (!bars) return res.json({ ok: true, candles: [] });
    // LightweightCharts candlestick format: { time, open, high, low, close }
    const candles = bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
    res.json({ ok: true, candles });
  } catch (err) { res.json({ ok: false, error: err.message, candles: [] }); }
});

// ── Candles for journal per-trade chart (Yahoo only fallback) ─────
app.get('/api/candles/:ticker', async (req, res) => {
  const ticker = req.params.ticker;
  const resolution = req.query.resolution || 'daily';
  const fromMs = parseInt(req.query.fromMs) || 0;
  const toMs = parseInt(req.query.toMs) || Date.now();

  try {
    if (resolution === 'daily') {
      const rangeStr = '1mo';
      const bars = await fetchDailyHistory(ticker, rangeStr);
      if (!bars) return res.json({ ok: true, candles: [] });
      const candles = bars
        .filter(b => {
          const t = new Date(b.time).getTime();
          return (!fromMs || t >= fromMs) && (!toMs || t <= toMs);
        })
        .map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
      return res.json({ ok: true, candles });
    }
    // Intraday — fetch historical data using period1/period2; use 5m for older trades
    const intervalMin = String(resolution) === '5' ? 5 : 1;
    const bars = await fetchYahooIntraday(ticker, fromMs, toMs, intervalMin);
    if (!bars) return res.json({ ok: true, candles: [] });
    // bars[].time is already a UTC Unix second from Yahoo — filter to requested window
    const fromSec = fromMs ? fromMs / 1000 : 0;
    const toSec = toMs ? toMs / 1000 : Infinity;
    const candles = bars
      .filter(b => b.time >= fromSec && b.time <= toSec)
      .map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
    // For 5m resolution requested but 1m data returned, downsample 1m → 5m
    if (intervalMin === 1 && String(resolution) === '5') {
      const grouped = {};
      candles.forEach(c => {
        const slot = Math.floor(c.time / 300) * 300;
        if (!grouped[slot]) grouped[slot] = { time: slot, open: c.open, high: c.high, low: c.low, close: c.close };
        else { grouped[slot].high = Math.max(grouped[slot].high, c.high); grouped[slot].low = Math.min(grouped[slot].low, c.low); grouped[slot].close = c.close; }
      });
      return res.json({ ok: true, candles: Object.values(grouped).sort((a,b) => a.time - b.time) });
    }
    res.json({ ok: true, candles });
  } catch (err) { res.json({ ok: false, error: err.message, candles: [] }); }
});

// ── Journal sync (full replace — handles deletes too) ─────────────
app.post('/api/journal/sync', (req, res) => {
  const trades = req.body && req.body.trades;
  if (!Array.isArray(trades)) return res.status(400).json({ ok: false, error: 'trades array required' });
  const ids = trades.filter(t => t && t.id).map(t => t.id);
  trades.filter(t => t && t.id).forEach(t => saveJournalTrade(t));
  if (ids.length > 0) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM journal_trades WHERE id NOT IN (${ph})`).run(...ids);
  } else {
    db.prepare('DELETE FROM journal_trades').run();
  }
  res.json({ ok: true, count: ids.length });
});

// ── Journal import (add/update, no deletes) ───────────────────────
app.post('/api/journal/import', (req, res) => {
  const trades = req.body && req.body.trades;
  if (!Array.isArray(trades)) return res.status(400).json({ ok: false, error: 'trades array required' });
  let count = 0;
  trades.forEach(t => { if (t && t.id) { saveJournalTrade(t); count++; } });
  res.json({ ok: true, count });
});

// Fallback → SPA
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ══════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\nTrade Desk Web App`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  ET time: ${etTimeStr()}  date: ${etDateStr()}`);
  console.log(`  Mode: ${getSetting('snapshotMode', 'manual')}\n`);
  startCronJobs();
});

module.exports = { db, REGIME_CATALOG, SNAPSHOT_SLOTS };
