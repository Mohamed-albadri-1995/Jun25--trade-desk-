'use strict';

// ══════════════════════════════════════════════════════════════════════
// WINDOW MANAGEMENT (opens popup.html as a standalone window)
// ══════════════════════════════════════════════════════════════════════
var WINDOW_ID = null;

chrome.action.onClicked.addListener(function () {
  if (WINDOW_ID !== null) {
    chrome.windows.get(WINDOW_ID, function (win) {
      if (chrome.runtime.lastError || !win) {
        WINDOW_ID = null;
        openWindow();
      } else {
        chrome.windows.update(WINDOW_ID, { focused: true });
      }
    });
  } else {
    openWindow();
  }
});

function openWindow() {
  chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 960,
    height: 800,
    focused: true
  }, function (win) {
    WINDOW_ID = win.id;
  });
}

chrome.windows.onRemoved.addListener(function (windowId) {
  if (windowId === WINDOW_ID) WINDOW_ID = null;
});

// ══════════════════════════════════════════════════════════════════════
// TRADE DESK — TradingView scanner proxy
// ══════════════════════════════════════════════════════════════════════
const TV_SCAN_URL =
  'https://scanner.tradingview.com/america/scan?label-product=screener-stock';

// ══════════════════════════════════════════════════════════════════════
// TRADE DESK — Daily-bar history (Yahoo primary, Stooq fallback)
// ══════════════════════════════════════════════════════════════════════
function yahooSymbol(sym) {
  var s = String(sym || '').toUpperCase().replace(/^.*:/, '').trim();
  if (s === 'VIX' || s === '^VIX') return '%5EVIX';
  return encodeURIComponent(s);
}
function stooqSymbol(sym) {
  var s = String(sym || '').toUpperCase().replace(/^.*:/, '').trim();
  if (s === 'VIX' || s === '^VIX') return '%5Evix';
  return encodeURIComponent(s.toLowerCase()) + '.us';
}

function fetchYahoo(sym, range) {
  var hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  var path = '/v8/finance/chart/' + yahooSymbol(sym) +
    '?range=' + encodeURIComponent(range) + '&interval=1d&includePrePost=false';
  function tryHost(i) {
    if (i >= hosts.length) return Promise.reject(new Error('yahoo unreachable'));
    return fetch('https://' + hosts[i] + path, { method: 'GET' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var res = j && j.chart && j.chart.result && j.chart.result[0];
        var ts = res && res.timestamp;
        var q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
        if (!ts || !q) throw new Error('empty');
        var bars = [];
        for (var k = 0; k < ts.length; k++) {
          var o = q.open[k], h = q.high[k], l = q.low[k], c = q.close[k];
          if (o == null || h == null || l == null || c == null) continue;
          var d = new Date(ts[k] * 1000);
          bars.push({ time: d.toISOString().slice(0, 10), open: +o, high: +h, low: +l, close: +c });
        }
        if (!bars.length) throw new Error('no bars');
        return { bars: bars, source: 'yahoo' };
      })
      .catch(function () { return tryHost(i + 1); });
  }
  return tryHost(0);
}

function fetchStooq(sym, range) {
  var url = 'https://stooq.com/q/d/l/?s=' + stooqSymbol(sym) + '&i=d';
  return fetch(url, { method: 'GET' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(function (txt) {
      var lines = String(txt || '').trim().split(/\r?\n/);
      if (lines.length < 2 || lines[0].indexOf('Date') === -1) throw new Error('stooq bad csv');
      var bars = [];
      for (var i = 1; i < lines.length; i++) {
        var p = lines[i].split(',');
        if (p.length < 5) continue;
        var o = parseFloat(p[1]), h = parseFloat(p[2]), l = parseFloat(p[3]), c = parseFloat(p[4]);
        if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
        bars.push({ time: p[0], open: o, high: h, low: l, close: c });
      }
      if (!bars.length) throw new Error('stooq empty');
      var n = range === '3mo' ? 63 : 126;
      if (bars.length > n) bars = bars.slice(bars.length - n);
      return { bars: bars, source: 'stooq' };
    });
}

function fetchDeskHistory(sym, range) {
  return fetchYahoo(sym, range).catch(function () { return fetchStooq(sym, range); });
}

// ══════════════════════════════════════════════════════════════════════
// TRADE DESK — News proxy (Finnhub + TradingView)
// ══════════════════════════════════════════════════════════════════════
var NEWS_NOISE = ['motley fool', 'zacks', 'seeking alpha', 'investorplace', 'tipranks', 'simply wall'];
function isNoisySource(src) {
  var s = String(src || '').toLowerCase();
  return NEWS_NOISE.some(function (n) { return s.indexOf(n) !== -1; });
}
function ymd(d) { return d.toISOString().slice(0, 10); }

function fetchFinnhubNews(symbol, key) {
  if (!key || !symbol) return Promise.resolve([]);
  var to = new Date(), from = new Date(Date.now() - 2 * 864e5);
  var url = 'https://finnhub.io/api/v1/company-news?symbol=' + encodeURIComponent(symbol) +
    '&from=' + ymd(from) + '&to=' + ymd(to) + '&token=' + encodeURIComponent(key);
  return fetch(url)
    .then(function (r) { if (!r.ok) throw new Error('finnhub HTTP ' + r.status); return r.json(); })
    .then(function (arr) {
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(function (n) { return n && n.headline && n.url && !isNoisySource(n.source); })
        .sort(function (a, b) { return (b.datetime || 0) - (a.datetime || 0); })
        .slice(0, 3)
        .map(function (n) {
          return {
            headline: String(n.headline), summary: String(n.summary || '').slice(0, 280),
            url: String(n.url), source: String(n.source || ''), ts: (n.datetime || 0) * 1000
          };
        });
    })
    .catch(function () { return []; });
}

var __tvClient = null;
function _tvFetchItems(sym, client) {
  var url = 'https://news-headlines.tradingview.com/v2/headlines?client=' +
    encodeURIComponent(client) + '&lang=en&symbol=' + encodeURIComponent(sym);
  return fetch(url)
    .then(function (r) { if (!r.ok) throw new Error('tv HTTP ' + r.status); return r.json(); })
    .then(function (j) {
      return Array.isArray(j) ? j
        : (j && Array.isArray(j.data)) ? j.data
          : (j && Array.isArray(j.items)) ? j.items : [];
    });
}
function _tvParse(items) {
  var cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
  return (items || []).map(function (n) {
    n = n || {};
    var title = String(n.title || n.headline || '').trim();
    if (!title) return null;
    var pub = (typeof n.published === 'number') ? n.published
      : (typeof n.published_at === 'number') ? n.published_at : 0;
    var sec = pub > 1e11 ? Math.floor(pub / 1000) : pub;
    if (sec && sec < cutoff) return null;
    var srcRaw = n.source || n.provider || '';
    var src = (srcRaw && typeof srcRaw === 'object') ? (srcRaw.name || srcRaw.id || 'TradingView') : String(srcRaw || 'TradingView');
    if (isNoisySource(src)) return null;
    var link = n.link || '';
    if (!link && n.storyPath) link = 'https://www.tradingview.com' + n.storyPath;
    if (!link) return null;
    return {
      title: title.slice(0, 200), url: link, source: src.slice(0, 40),
      summary: String(n.shortDescription || n.summary || '').slice(0, 280),
      ts: (sec || Math.floor(Date.now() / 1000)) * 1000
    };
  }).filter(Boolean);
}
function fetchTVNews(tvSymbol, bareTicker) {
  var syms = [];
  if (tvSymbol) syms.push(tvSymbol);
  if (bareTicker && bareTicker !== tvSymbol) syms.push(bareTicker);
  if (!syms.length) return Promise.resolve([]);
  var clients = __tvClient ? [__tvClient] : ['symbol', 'overview', 'landing_page', 'widget'];
  function tryCombo(ci, si) {
    if (ci >= clients.length) return Promise.resolve([]);
    if (si >= syms.length) return tryCombo(ci + 1, 0);
    return _tvFetchItems(syms[si], clients[ci])
      .then(function (items) {
        var parsed = _tvParse(items);
        if (parsed.length) { __tvClient = clients[ci]; return parsed.slice(0, 3); }
        return tryCombo(ci, si + 1);
      })
      .catch(function () { return tryCombo(ci, si + 1); });
  }
  return tryCombo(0, 0);
}

// ══════════════════════════════════════════════════════════════════════
// TRADE JOURNAL — Candle fetcher (Yahoo / Polygon / Finnhub)
// ══════════════════════════════════════════════════════════════════════
async function bg_fetchCandles(ticker, fromMs, toMs, resolution, polygonKey, finnhubKey, dailyRange) {
  if (resolution === 'daily') {
    var rangeStr = /^(1mo|3mo|6mo|1y|2y)$/.test(dailyRange || '') ? dailyRange : '1mo';
    var yhUrl = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
      '?interval=1d&range=' + rangeStr + '&includePrePost=false';
    var yr = await fetch(yhUrl, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if (!yr.ok) throw new Error('Yahoo daily HTTP ' + yr.status);
    var yd = await yr.json();
    var result = yd && yd.chart && yd.chart.result && yd.chart.result[0];
    if (!result || !result.timestamp || !result.timestamp.length) throw new Error('Yahoo: no daily data for ' + ticker);
    var q = result.indicators.quote[0];
    return result.timestamp.map(function (ts, i) {
      if (q.close[i] == null) return null;
      return { time: ts, open: q.open[i] || q.close[i], high: q.high[i] || q.close[i], low: q.low[i] || q.close[i], close: q.close[i], volume: q.volume[i] || 0 };
    }).filter(Boolean);
  }
  var yhError = null;
  try {
    var interval = resolution <= 1 ? '1m' : resolution <= 2 ? '2m' : resolution <= 5 ? '5m' : '15m';
    var range = (resolution || 1) <= 1 ? '5d' : '1mo';
    var yhUrl2 = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
      '?interval=' + interval + '&range=' + range + '&includePrePost=true';
    var yr2 = await fetch(yhUrl2, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if (yr2.ok) {
      var yd2 = await yr2.json();
      var result2 = yd2 && yd2.chart && yd2.chart.result && yd2.chart.result[0];
      if (result2 && result2.timestamp && result2.timestamp.length) {
        var allTs = result2.timestamp, q2 = result2.indicators.quote[0], candles = [];
        for (var i = 0; i < allTs.length; i++) {
          var tMs = allTs[i] * 1e3;
          if (tMs < fromMs || tMs > toMs) continue;
          if (q2.open[i] == null || q2.close[i] == null) continue;
          candles.push({ time: allTs[i], open: q2.open[i], high: q2.high[i], low: q2.low[i], close: q2.close[i], volume: q2.volume[i] || 0 });
        }
        if (candles.length) return candles;
        yhError = 'no data for ' + new Date(fromMs).toISOString().slice(0, 10);
      } else {
        var errCode = yd2 && yd2.chart && yd2.chart.error && yd2.chart.error.code;
        yhError = errCode ? 'Yahoo error: ' + errCode : 'empty result';
      }
    } else { yhError = 'HTTP ' + yr2.status; }
  } catch (e) { yhError = e.message; }
  if (polygonKey) {
    var fromDate = new Date(fromMs).toISOString().slice(0, 10);
    var toDate = new Date(toMs).toISOString().slice(0, 10);
    var url = 'https://api.polygon.io/v2/aggs/ticker/' + encodeURIComponent(ticker) +
      '/range/' + resolution + '/minute/' + fromDate + '/' + toDate +
      '?adjusted=false&sort=asc&limit=5000&apiKey=' + encodeURIComponent(polygonKey);
    var r = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('Polygon HTTP ' + r.status + '. Yahoo also failed: ' + (yhError || 'no data'));
    var data = await r.json();
    if (!data.results || !data.results.length) throw new Error('Polygon: no data for ' + ticker);
    return data.results.map(function (b) { return { time: Math.floor(b.t / 1e3), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }; });
  }
  if (finnhubKey) {
    var url2 = 'https://finnhub.io/api/v1/stock/candle?symbol=' + encodeURIComponent(ticker) +
      '&resolution=' + (resolution === 1 ? '1' : resolution === 5 ? '5' : '1') +
      '&from=' + Math.floor(fromMs / 1e3) + '&to=' + Math.floor(toMs / 1e3) +
      '&token=' + encodeURIComponent(finnhubKey);
    var r2 = await fetch(url2, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!r2.ok) throw new Error('Finnhub HTTP ' + r2.status);
    var data2 = await r2.json();
    if (data2.s !== 'ok' || !data2.t || !data2.t.length) throw new Error('Finnhub: no data for ' + ticker);
    return data2.t.map(function (ts, i) { return { time: ts, open: data2.o[i], high: data2.h[i], low: data2.l[i], close: data2.c[i], volume: data2.v[i] }; });
  }
  throw new Error('No chart data available. Yahoo only covers last 7 days. Add a Finnhub key under Chart data in the Journal tab for ~1 month of history.' + (yhError ? ' (' + yhError + ')' : ''));
}

// ══════════════════════════════════════════════════════════════════════
// AUTO SNAPSHOT — captures market state at 09:30-10:00 ET in auto mode
// ══════════════════════════════════════════════════════════════════════
var BG_SNAPSHOT_SLOTS = ['09:30','09:35','09:40','09:45','09:50','09:55','10:00','12:00','15:45'];

var BG_STOCK_FILTER2 = {
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
        { expression: { left: 'type', operation: 'equal', right: 'dr' } } ] } },
      { operation: { operator: 'and', operands: [
        { expression: { left: 'type', operation: 'equal', right: 'fund' } },
        { expression: { left: 'typespecs', operation: 'has_none_of', right: ['etf', 'mutual', 'closedend'] } } ] } }
    ] } },
    { expression: { left: 'typespecs', operation: 'has_none_of', right: ['pre-ipo'] } }
  ]
};

// ── BG Screener scan — column set and screener configs (mirrors popup.js) ──
var BG_TV_COLUMNS = [
  'ticker-view', 'open', 'close', 'change', 'relative_volume_10d_calc',
  'relative_volume_intraday|5', 'market_cap_basic', 'sector', 'industry',
  'change_from_open', 'VWAP',
  'High.1M', 'Low.1M', 'high', 'low', 'ATR',
  'short_percentage_of_float', 'float_shares_outstanding',
  'EMA9', 'EMA13', 'EMA20', 'EMA50', 'SMA5',
  'premarket_high', 'premarket_low'
];
var BG_SCREENER_CONFIGS = {
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

var BG_MARKET_TICKERS = ['AMEX:SPY','NASDAQ:QQQ','AMEX:DIA','AMEX:IWM','TVC:VIX'];
var BG_SECTOR_ETF_MAP = {
  'Technology':'AMEX:XLK','Finance':'AMEX:XLF','Energy Minerals':'AMEX:XLE',
  'Health Technology':'AMEX:XLV','Producer Manufacturing':'AMEX:XLI',
  'Communications':'AMEX:XLC','Consumer Durables':'AMEX:XLY',
  'Consumer Non-Durables':'AMEX:XLP','Non-Energy Minerals':'AMEX:XLB',
  'Finance/Real Estate':'AMEX:XLRE','Utilities':'AMEX:XLU',
  'Electronic Technology':'AMEX:SMH','Health Services':'AMEX:IBB',
  'Retail Trade':'AMEX:XRT','Transportation':'AMEX:XTN'
};
var BG_SECTOR_ETF_REVERSE = {};
Object.keys(BG_SECTOR_ETF_MAP).forEach(function (k) { BG_SECTOR_ETF_REVERSE[BG_SECTOR_ETF_MAP[k]] = k; });

var BG_REGIME_MATRIX = {
  'BULLISH|UPTREND':'STRONG_UP','BULLISH|PULLBACK':'PULLBACK_BULL','BULLISH|REBOUND':'UP',
  'BULLISH|SIDEWAYS':'CHOP_BULL','BULLISH|DOWNTREND':'CORRECTION',
  'RECOVERING|UPTREND':'WEAK_UP','RECOVERING|PULLBACK':'RECOVERY','RECOVERING|REBOUND':'RECOVERY',
  'RECOVERING|SIDEWAYS':'BASING','RECOVERING|DOWNTREND':'DOWN',
  'WEAKENING|UPTREND':'RECOVERY','WEAKENING|PULLBACK':'TOPPING','WEAKENING|REBOUND':'BEAR_RALLY',
  'WEAKENING|SIDEWAYS':'CHOP_BEAR','WEAKENING|DOWNTREND':'DOWN',
  'BEARISH|UPTREND':'BEAR_RALLY','BEARISH|PULLBACK':'DOWN','BEARISH|REBOUND':'BEAR_RALLY',
  'BEARISH|SIDEWAYS':'BASING','BEARISH|DOWNTREND':'STRONG_DOWN'
};
var BG_REGIME_CATALOG = {
  EXTENDED_UP:{label:'Extended uptrend',bias:'LONG'}, STRONG_UP:{label:'Strong uptrend',bias:'LONG'},
  UP:{label:'Uptrend (resuming)',bias:'LONG'}, WEAK_UP:{label:'Early uptrend (unconfirmed)',bias:'LONG'},
  PULLBACK_BULL:{label:'Bull-market pullback',bias:'LONG'}, RECOVERY:{label:'Recovery attempt',bias:'NEUTRAL'},
  BASING:{label:'Basing / bottoming',bias:'NEUTRAL'}, CHOP_BULL:{label:'Choppy range (above 200DMA)',bias:'NEUTRAL'},
  CHOP_BEAR:{label:'Choppy range (below 200DMA)',bias:'NEUTRAL'}, CORRECTION:{label:'Correction (bull intact)',bias:'NEUTRAL'},
  TOPPING:{label:'Topping / breaking down',bias:'SHORT'}, BEAR_RALLY:{label:'Bear-market rally',bias:'NEUTRAL'},
  DOWN:{label:'Downtrend',bias:'SHORT'}, STRONG_DOWN:{label:'Strong downtrend',bias:'SHORT'},
  CAPITULATION:{label:'Capitulation / oversold',bias:'SHORT'}, UNKNOWN:{label:'Unknown',bias:'NEUTRAL'}
};

function bg_num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function bg_clampN(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function bg_storageGet(keys) {
  return new Promise(function (resolve) {
    try { chrome.storage.local.get(keys, function (r) { resolve(chrome.runtime.lastError ? {} : (r || {})); }); }
    catch (_) { resolve({}); }
  });
}
function bg_storageSet(obj) {
  return new Promise(function (resolve) {
    try { chrome.storage.local.set(obj, function () { resolve(!chrome.runtime.lastError); }); }
    catch (_) { resolve(false); }
  });
}

function bg_etDateStr() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
  catch (_) { return new Date().toISOString().slice(0, 10); }
}
function bg_etTimeStr() {
  try { return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch (_) { return '??:??:??'; }
}
function bg_isWeekdayET() {
  try { var d = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' }); return d !== 'Sat' && d !== 'Sun'; }
  catch (_) { return true; }
}
function bg_getActiveSlot() {
  try {
    var t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: 'numeric', minute: '2-digit' });
    var p = t.split(':'), etMin = parseInt(p[0]) * 60 + parseInt(p[1]);
    var best = null, bestDiff = Infinity;
    BG_SNAPSHOT_SLOTS.forEach(function (s) {
      var sp = s.split(':'), sm = parseInt(sp[0]) * 60 + parseInt(sp[1]), diff = Math.abs(etMin - sm);
      if (diff < bestDiff) { bestDiff = diff; best = s; }
    });
    return bestDiff <= 5 ? best : null;
  } catch (_) { return null; }
}

// Pure computation functions — must stay in sync with popup.js equivalents
function bg_computeMarketBiasDetail(ix) {
  var sigs = [];
  function addDay(ticker, d) {
    if (!d || d.change == null) { sigs.push({ label: ticker + ' day', value: null, state: 'unknown', pts: 0 }); return; }
    var pts = d.change > 0.3 ? 1 : d.change < -0.3 ? -1 : 0;
    sigs.push({ label: ticker + ' day ' + (d.change >= 0 ? '+' : '') + d.change.toFixed(2) + '%', value: d.change, state: pts > 0 ? 'bull' : pts < 0 ? 'bear' : 'neu', pts: pts });
  }
  addDay('SPY', ix.SPY); addDay('QQQ', ix.QQQ); addDay('IWM', ix.IWM);
  var vixPts = 0;
  if (ix.VIX && ix.VIX.change != null) {
    if (ix.VIX.change > 3) vixPts = -2; else if (ix.VIX.change > 1) vixPts = -1; else if (ix.VIX.change < -2) vixPts = 1;
    sigs.push({ label: 'VIX day ' + (ix.VIX.change >= 0 ? '+' : '') + ix.VIX.change.toFixed(2) + '%', value: ix.VIX.change, state: vixPts > 0 ? 'bull' : vixPts < 0 ? 'bear' : 'neu', pts: vixPts });
  } else { sigs.push({ label: 'VIX day', value: null, state: 'unknown', pts: 0 }); }
  function addWeek(ticker, d) {
    if (!d || d.weekChg == null) { sigs.push({ label: ticker + ' week', value: null, state: 'unknown', pts: 0 }); return; }
    var pts = d.weekChg > 1 ? 1 : d.weekChg < -1 ? -1 : 0;
    sigs.push({ label: ticker + ' week ' + (d.weekChg >= 0 ? '+' : '') + d.weekChg.toFixed(2) + '%', value: d.weekChg, state: pts > 0 ? 'bull' : pts < 0 ? 'bear' : 'neu', pts: pts });
  }
  addWeek('SPY', ix.SPY); addWeek('QQQ', ix.QQQ);
  var score = sigs.reduce(function (acc, x) { return acc + x.pts; }, 0);
  return { result: score >= 3 ? 'BULLISH' : score <= -3 ? 'BEARISH' : 'NEUTRAL', score: score, signals: sigs };
}

function bg_computeMarketStage(ix) {
  var n = bg_num, src = ix.SPY, name = 'SPY';
  function ok(d) { return d && n(d.close) != null && n(d.sma5) != null && n(d.sma20) != null; }
  if (!ok(src)) { if (ok(ix.QQQ)) { src = ix.QQQ; name = 'QQQ'; } else return { stage: 'UNKNOWN', stageLabel: 'Indicators unavailable', bb: 'UNKNOWN', bbPct: null, signals: [], bull: 0, unk: 0, src: '' }; }
  var sig = [];
  function add(label, lhs, rhs, tf) {
    if (n(lhs) == null || n(rhs) == null) { sig.push({ label: label, state: 'unknown', tf: tf }); return; }
    sig.push({ label: label, state: lhs > rhs ? 'bull' : 'bear', tf: tf });
  }
  add('Close > 5DMA', src.close, src.sma5, 'D'); add('Close > 20DMA', src.close, src.sma20, 'D');
  add('5DMA > 20DMA', src.sma5, src.sma20, 'D'); add('20DMA > 50DMA', src.sma20, src.sma50, 'D');
  add('1H Close > 20MA', src.closeH, src.sma20H, 'H'); add('1H 5MA > 20MA', src.sma5H, src.sma20H, 'H');
  var bull = sig.filter(function (x) { return x.state === 'bull'; }).length;
  var unk = sig.filter(function (x) { return x.state === 'unknown'; }).length;
  var ca5 = n(src.close) != null && n(src.sma5) != null ? src.close > src.sma5 : null;
  var s5a20 = n(src.sma5) != null && n(src.sma20) != null ? src.sma5 > src.sma20 : null;
  var stage, label;
  if (bull >= 5) { stage = 'UPTREND'; label = 'Uptrend — buyers in control'; }
  else if (bull === 4 && ca5 === true) { stage = 'UPTREND'; label = 'Uptrend — buyers in control'; }
  else if (bull >= 3 && bull <= 4 && ca5 === false && s5a20 === true) { stage = 'PULLBACK'; label = 'Pullback — uptrend correction'; }
  else if (bull >= 2 && bull <= 3 && ca5 === true && s5a20 === false) { stage = 'REBOUND'; label = 'Rebound — counter-rally in downtrend'; }
  else if (bull >= 2 && bull <= 3) { stage = 'SIDEWAYS'; label = 'Sideways — no clear edge'; }
  else { stage = 'DOWNTREND'; label = 'Downtrend — sellers in control'; }
  var bb = 'UNKNOWN', bbPct = null;
  var up = src.bbUpper, lo = src.bbLower, cl = src.close;
  if (n(up) == null || n(lo) == null) { up = src.bbUpperH; lo = src.bbLowerH; cl = src.closeH; }
  if (n(up) != null && n(lo) != null && n(cl) != null && up > lo) {
    var p = (cl - lo) / (up - lo); p = Math.max(0, Math.min(1, p));
    bbPct = p; bb = p >= 0.75 ? 'UPPER' : p <= 0.25 ? 'LOWER' : 'MID';
  }
  return { stage: stage, stageLabel: label, bb: bb, bbPct: bbPct, signals: sig, bull: bull, unk: unk, src: name };
}

function bg_computeLongTermBias(ix) {
  var n = bg_num, src = ix.SPY, name = 'SPY';
  function ok(d) { return d && n(d.close) != null && n(d.sma200) != null && n(d.sma50) != null; }
  if (!ok(src)) { if (ok(ix.QQQ)) { src = ix.QQQ; name = 'QQQ'; } else return { bias: 'UNKNOWN', label: '200DMA unavailable', dist: null, src: 'SPY' }; }
  var above = src.close > src.sma200, golden = src.sma50 > src.sma200;
  var dist = src.sma200 > 0 ? (src.close - src.sma200) / src.sma200 * 100 : null;
  var bias, label;
  if (above && golden) { bias = 'BULLISH'; label = 'Long-term uptrend (above 200DMA + golden cross)'; }
  else if (above && !golden) { bias = 'RECOVERING'; label = 'Recovering — above 200DMA but 50<200 (death cross)'; }
  else if (!above && golden) { bias = 'WEAKENING'; label = 'Weakening — below 200DMA but 50>200 (golden cross intact)'; }
  else { bias = 'BEARISH'; label = 'Long-term downtrend (below 200DMA + death cross)'; }
  return { bias: bias, label: label, dist: dist, src: name };
}

function bg_sectorShortTermBias(name, etf, spy) {
  var e = etf[name], n = bg_num;
  if (!e) return { dir: 'NEUTRAL', score: 0, dRS: 0, wRS: 0 };
  var spyD = n(spy && spy.change) || 0, spyW = n(spy && spy.weekChg) || 0;
  var eD = n(e.change) || 0, eW = n(e.weekChg) || 0;
  var dRS = eD - spyD, wRS = eW - spyW, s = 0, c;
  c = bg_clampN(eD / 1.5, -1, 1) * 18; s += c;
  c = bg_clampN(eW / 4, -1, 1) * 14; s += c;
  c = bg_clampN(dRS / 1.2, -1, 1) * 20; s += c;
  c = bg_clampN(wRS / 3, -1, 1) * 16; s += c;
  if (n(e.close) != null && n(e.vwap) != null && e.vwap > 0) { c = e.close > e.vwap ? 10 : -10; s += c; }
  if (n(e.adx) != null && e.adx > 20) { c = (eD >= 0 ? 1 : -1) * Math.min((e.adx - 20) / 30, 1) * 12; s += c; }
  if (n(e.rvol) != null && e.rvol >= 1.2) { c = (eD >= 0 ? 1 : -1) * 10; s += c; }
  s = bg_clampN(s, -100, 100);
  var dir = s >= 18 ? 'BULLISH' : s <= -18 ? 'BEARISH' : 'NEUTRAL';
  return { dir: dir, score: Math.round(s), dRS: Math.round(dRS * 100) / 100, wRS: Math.round(wRS * 100) / 100 };
}
function bg_computeSectorBiasScores(etf, spy) {
  var out = {};
  Object.keys(etf).forEach(function (k) { out[k] = bg_sectorShortTermBias(k, etf, spy); });
  return out;
}

function bg_regimeClassify(longTerm, stage, bb, shortBias) {
  var L = String(longTerm || '').toUpperCase(), S = String(stage || '').toUpperCase();
  var B = String(bb || '').toUpperCase(), SH = String(shortBias || '').toUpperCase();
  if (SH !== 'BULLISH' && SH !== 'BEARISH') SH = 'NEUTRAL';
  var slug = BG_REGIME_MATRIX[L + '|' + S] || 'UNKNOWN';
  if (slug === 'STRONG_UP' && B === 'UPPER') slug = 'EXTENDED_UP';
  if (slug === 'STRONG_DOWN' && B === 'LOWER') slug = 'CAPITULATION';
  var cat = BG_REGIME_CATALOG[slug] || BG_REGIME_CATALOG.UNKNOWN;
  return { slug: slug, label: cat.label, bias: cat.bias };
}

function bg_rowObj(item, cols) {
  var d = item.d || [], o = {};
  cols.forEach(function (c, i) { o[c] = d[i]; });
  return o;
}

function bg_fetchMarketData() {
  var n = bg_num;
  var cols = ['close','change','Perf.W','VWAP','ADX','SMA5','SMA20','SMA50','SMA200',
    'BB.upper','BB.lower','close|60','SMA5|60','SMA20|60','BB.upper|60','BB.lower|60'];
  return fetch(TV_SCAN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: { tickers: BG_MARKET_TICKERS }, columns: cols, options: { lang: 'en' } }) })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      var out = {};
      (data.data || []).forEach(function (item) {
        var r = bg_rowObj(item, cols), short = String(item.s || '').replace(/^.*:/, '');
        out[short] = { change: n(r['change']), weekChg: n(r['Perf.W']), vwap: n(r['VWAP']), adx: n(r['ADX']),
          close: n(r['close']), sma5: n(r['SMA5']), sma20: n(r['SMA20']), sma50: n(r['SMA50']), sma200: n(r['SMA200']),
          bbUpper: n(r['BB.upper']), bbLower: n(r['BB.lower']), closeH: n(r['close|60']),
          sma5H: n(r['SMA5|60']), sma20H: n(r['SMA20|60']), bbUpperH: n(r['BB.upper|60']), bbLowerH: n(r['BB.lower|60']) };
      });
      return out;
    });
}

function bg_fetchSectorETFs() {
  var n = bg_num;
  var cols = ['close','change','Perf.W','VWAP','ADX','relative_volume_intraday|5'];
  return fetch(TV_SCAN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: { tickers: Object.values(BG_SECTOR_ETF_MAP) }, columns: cols, options: { lang: 'en' } }) })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      var out = {};
      (data.data || []).forEach(function (item) {
        var sym = String(item.s || ''), r = bg_rowObj(item, cols);
        var name = BG_SECTOR_ETF_REVERSE[sym] || sym.replace(/^.*:/, '');
        out[name] = { etf: sym.replace(/^.*:/, ''), close: n(r['close']), change: n(r['change']),
          weekChg: n(r['Perf.W']), vwap: n(r['VWAP']), adx: n(r['ADX']), rvol: n(r['relative_volume_intraday|5']) };
      });
      return out;
    });
}

function bg_fetchBreakoutStocks() {
  var body = { columns: ['ticker-view'],
    filter: [
      { left: 'close', operation: 'egreater', right: 1 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 2 },
      { left: 'Perf.W', operation: 'egreater', right: 2 }
    ],
    filter2: BG_STOCK_FILTER2, ignore_unknown_fields: false, markets: ['america'],
    options: { lang: 'en' }, range: [0, 100], sort: { sortBy: 'Perf.W', sortOrder: 'desc' }, symbols: {} };
  return fetch(TV_SCAN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      return (data.data || []).map(function (item) {
        var tv = bg_rowObj(item, ['ticker-view'])['ticker-view'], t = '';
        if (tv && typeof tv === 'object' && tv.symbol) t = tv.symbol; else if (typeof tv === 'string') t = tv; else t = String(item.s || '');
        return { ticker: t.replace(/^.*:/, '').trim() };
      }).filter(function (s) { return s.ticker; });
    });
}

function bg_buildMarketSnapshot(ix, etf, hot) {
  var stDetail = bg_computeMarketBiasDetail(ix);
  var midData  = bg_computeMarketStage(ix);
  var ltData   = bg_computeLongTermBias(ix);
  var rg       = bg_regimeClassify(ltData.bias, midData.stage, midData.bb, stDetail.result);
  var scores   = bg_computeSectorBiasScores(etf, ix.SPY);
  var sectors  = {};
  Object.keys(etf).forEach(function (name) {
    var e = etf[name], sc = scores[name] || { dir: 'NEUTRAL', score: 0, dRS: 0, wRS: 0 };
    sectors[name] = { etf: e.etf, close: e.close, change: e.change, weekChg: e.weekChg,
      adx: e.adx, bias: sc.dir, score: sc.score, dRS: sc.dRS, wRS: sc.wRS };
  });
  var indices = {};
  ['SPY','QQQ','IWM','DIA','VIX'].forEach(function (k) {
    if (!ix[k]) return;
    indices[k] = { close: ix[k].close, change: ix[k].change, weekChg: ix[k].weekChg,
      sma5: ix[k].sma5 || null, sma20: ix[k].sma20 || null, sma50: ix[k].sma50 || null,
      sma200: ix[k].sma200 || null, closeH: ix[k].closeH || null,
      sma5H: ix[k].sma5H || null, sma20H: ix[k].sma20H || null };
  });
  var ltSrc = ix[ltData.src] || {};
  return {
    indices: indices,
    shortTerm: { result: stDetail.result, score: stDetail.score, signals: stDetail.signals },
    midTerm: { result: midData.stage, stageLabel: midData.stageLabel, src: midData.src,
      bull: midData.bull, unk: midData.unk || 0, bb: midData.bb, bbPct: midData.bbPct,
      signals: midData.signals },
    longTerm: { result: ltData.bias, label: ltData.label, src: ltData.src, dist: ltData.dist,
      above200: ltSrc.close != null && ltSrc.sma200 != null ? ltSrc.close > ltSrc.sma200 : null,
      goldenCross: ltSrc.sma50 != null && ltSrc.sma200 != null ? ltSrc.sma50 > ltSrc.sma200 : null },
    regime: { slug: rg.slug, label: rg.label, bias: rg.bias },
    sectors: sectors,
    breakoutNames: (hot || []).map(function (s) { return s.ticker; })
  };
}

function bg_checkMarketSnapshotComplete(snap) {
  if (!snap) return { ok: false, reason: 'No snapshot data' };
  if (!snap.indices || !snap.indices.SPY || snap.indices.SPY.close == null || snap.indices.SPY.change == null)
    return { ok: false, reason: 'SPY data missing' };
  if (!snap.indices.QQQ || snap.indices.QQQ.close == null) return { ok: false, reason: 'QQQ data missing' };
  if (!snap.indices.VIX || snap.indices.VIX.change == null) return { ok: false, reason: 'VIX data missing' };
  if (!snap.shortTerm || !snap.shortTerm.signals || snap.shortTerm.signals.length !== 6)
    return { ok: false, reason: 'Short-term signals incomplete' };
  if (!snap.midTerm || !snap.midTerm.signals || snap.midTerm.signals.length !== 6 || !snap.midTerm.src)
    return { ok: false, reason: 'Mid-term signals incomplete' };
  if (!snap.longTerm || snap.longTerm.dist == null) return { ok: false, reason: '200DMA unavailable' };
  var nSectors = Object.keys(snap.sectors || {}).length;
  if (nSectors < 10) return { ok: false, reason: 'Sectors incomplete (' + nSectors + ' loaded)' };
  return { ok: true, reason: '' };
}

async function bg_saveSnapshotRecord(date, slot, capturedAt, snap, complete, reason) {
  var r = await bg_storageGet(['marketSnapshots']);
  var all = r.marketSnapshots || {};
  if (!all[date]) all[date] = {};
  if (all[date][slot] && all[date][slot].complete === true) return;
  all[date][slot] = Object.assign({ slot: slot, capturedAt: capturedAt, ts: Date.now(),
    complete: complete, reason: reason || '' }, snap || {});
  await bg_storageSet({ marketSnapshots: all });
}

async function bg_captureAndSaveSnapshot(slot) {
  var date = bg_etDateStr();
  var r = await bg_storageGet(['marketSnapshots']);
  var snaps = (r.marketSnapshots || {})[date] || {};
  if (snaps[slot] && snaps[slot].complete === true) return;
  var t0 = Date.now(), ix = {}, etf = {}, hot = [];
  try {
    var res = await Promise.all([
      bg_fetchMarketData().catch(function () { return {}; }),
      bg_fetchSectorETFs().catch(function () { return {}; }),
      bg_fetchBreakoutStocks().catch(function () { return []; })
    ]);
    ix = res[0]; etf = res[1]; hot = res[2];
  } catch (e) {
    await bg_saveSnapshotRecord(date, slot, bg_etTimeStr(), null, false, 'Fetch failed: ' + e.message);
    return;
  }
  var fetchDuration = Date.now() - t0;
  if (fetchDuration > 90000) {
    await bg_saveSnapshotRecord(date, slot, bg_etTimeStr(), null, false, 'Fetch took ' + Math.round(fetchDuration / 1000) + 's — data may reflect wrong time');
    return;
  }
  var snap = bg_buildMarketSnapshot(ix, etf, hot);
  var check = bg_checkMarketSnapshotComplete(snap);
  await bg_saveSnapshotRecord(date, slot, bg_etTimeStr(), snap, check.ok, check.reason);
  try {
    chrome.runtime.sendMessage({ type: 'SNAPSHOT_UPDATED', date: date, slot: slot }, function () {
      if (chrome.runtime.lastError) {}
    });
  } catch (_) {}
}

// ── BG Screener helpers ────────────────────────────────────────────────
function bg_getETHHMM() { return bg_etTimeStr().slice(0, 5); }

function bg_tvScanDirect(body) {
  return fetch('https://scanner.tradingview.com/america/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
}

function bg_rowObj(item, cols) {
  var obj = {};
  (cols || []).forEach(function (k, i) { obj[k] = item.d && item.d[i] !== undefined ? item.d[i] : null; });
  return obj;
}

function bg_mapTvRowToStock(item, screenerKey) {
  var r = bg_rowObj(item, BG_TV_COLUMNS), n = bg_num;
  var tv = r['ticker-view'], t = '';
  if (tv && typeof tv === 'object' && tv.symbol) t = tv.symbol;
  else if (typeof tv === 'string') t = tv;
  else t = String(item.s || '');
  t = t.replace(/^.*:/, '').trim();
  var close = n(r['close']), change = n(r['change']), cfo = n(r['change_from_open']);
  var monthHigh = n(r['High.1M']), monthLow = n(r['Low.1M']), atr = n(r['ATR']);
  var pmHigh = n(r['premarket_high']), pmLow = n(r['premarket_low']);
  var pmRange = (pmHigh != null && pmLow != null) ? (pmHigh - pmLow) : null;
  var adrPct = (atr != null && close != null && close > 0) ? (atr / close * 100) : null;
  var monthRangePos = (monthHigh != null && monthLow != null && (monthHigh - monthLow) > 0 && close != null)
    ? (close - monthLow) / (monthHigh - monthLow) * 100 : null;
  var pmAdrRatio = (pmRange != null && atr != null && atr > 0) ? (pmRange / atr) : null;
  return {
    ticker: t, screenerKey: screenerKey || null, tvSymbol: String(item.s || ''),
    price: close, open: n(r['open']), change: change,
    prevClose: (close != null && change != null && (1 + change / 100) !== 0) ? close / (1 + change / 100) : null,
    gapPct: (change != null && cfo != null) ? (change - cfo) : null,
    vwap: n(r['VWAP']),
    ema9: n(r['EMA9']), ema13: n(r['EMA13']), ema20: n(r['EMA20']), ema50: n(r['EMA50']), sma5: n(r['SMA5']),
    monthHigh: monthHigh, monthLow: monthLow, dayHigh: n(r['high']), dayLow: n(r['low']), atr: atr,
    pmHigh: pmHigh, pmLow: pmLow, pmRange: pmRange,
    adrPct: adrPct, monthRangePos: monthRangePos, pmAdrRatio: pmAdrRatio,
    mcap: n(r['market_cap_basic']), floatShares: n(r['float_shares_outstanding']),
    shortFloat: n(r['short_percentage_of_float']),
    rvol: n(r['relative_volume_intraday|5']) || n(r['relative_volume_10d_calc']),
    sector: r['sector'] || '', industry: r['industry'] || ''
  };
}

function bg_runScreener(key) {
  var cfg = BG_SCREENER_CONFIGS[key];
  var body = { columns: BG_TV_COLUMNS, filter: cfg.filters, filter2: BG_STOCK_FILTER2,
    ignore_unknown_fields: false, markets: ['america'], options: { lang: 'en' },
    range: [0, 50], sort: cfg.sort, symbols: {} };
  return bg_tvScanDirect(body).then(function (data) {
    return (data.data || []).map(function (item) { return bg_mapTvRowToStock(item, key); })
      .filter(function (s) { return s.ticker; });
  });
}

// Run all 3 screeners, upsert results into registry storage.
var BG_SCAN_SLOTS = ['07:00', '08:00', '09:00', '09:20', '09:28'];
var bg_preScanDoneSlots = {};  // "YYYY-MM-DD|HH:MM" → true
var bg_eodOutcomeDoneDate = null;
async function bg_preScan() {
  var today = bg_etDateStr(), now = Date.now();
  try {
    var lists = await Promise.all([
      bg_runScreener('trend').catch(function () { return []; }),
      bg_runScreener('premarket').catch(function () { return []; }),
      bg_runScreener('bigmoves').catch(function () { return []; })
    ]);
    var scrKeys = ['trend', 'premarket', 'bigmoves'], byTicker = {};
    scrKeys.forEach(function (k, i) {
      lists[i].forEach(function (s) {
        if (!byTicker[s.ticker]) byTicker[s.ticker] = { stock: s, screenerKeys: [] };
        if (byTicker[s.ticker].screenerKeys.indexOf(k) === -1) byTicker[s.ticker].screenerKeys.push(k);
      });
    });
    var r = await bg_storageGet(['registry']);
    var registry = r.registry || {};
    var liveSet = {};
    Object.keys(byTicker).forEach(function (ticker) {
      liveSet[ticker] = true;
      var e = byTicker[ticker], id = ticker + '|' + today, s = e.stock, row = registry[id];
      if (row) {
        row.stock = s; row.tvSymbol = s.tvSymbol || row.tvSymbol;
        row.lastUpdated = now; row.liveNow = true;
        e.screenerKeys.forEach(function (k) { if (row.screenerKeys.indexOf(k) === -1) row.screenerKeys.push(k); });
      } else {
        registry[id] = { id: id, ticker: ticker, date: today, tvSymbol: s.tvSymbol || '',
          firstSeen: now, lastUpdated: now, liveNow: true,
          screenerKeys: e.screenerKeys.slice(), stock: s, context: null, news: null };
      }
    });
    Object.keys(registry).forEach(function (id) {
      var row = registry[id];
      if (row.date === today && !liveSet[row.ticker]) row.liveNow = false;
    });
    await bg_storageSet({ registry: registry });
    chrome.runtime.sendMessage({ type: 'BG_SCAN_COMPLETE', date: today, count: Object.keys(byTicker).length }, function () {
      if (chrome.runtime.lastError) {}
    });
  } catch (_) {}
}

// Build and save the frozen screener entry from registry + the just-captured market snapshot.
// Uses a 15-min staleness window (scan runs 11 min before freeze).
async function bg_buildAndSaveFrozenScreener(slot) {
  var date = bg_etDateStr();
  var r = await bg_storageGet(['frozenScreener']);
  var store = r.frozenScreener || {};
  if (store[date] && store[date].complete === true) return;

  var r2 = await bg_storageGet(['registry', 'marketSnapshots']);
  var registry = r2.registry || {};
  var snap = ((r2.marketSnapshots || {})[date] || {})[slot]
          || ((r2.marketSnapshots || {})[date] || {})['09:30'] || null;

  var now = Date.now(), rows = {};
  Object.keys(registry).forEach(function (id) {
    var row = registry[id];
    if (row.date !== date || !row.stock) return;
    var ctx = null;
    if (snap) {
      var sc = (snap.sectors && snap.sectors[row.stock.sector || '']) || { bias: 'NEUTRAL', score: 0 };
      ctx = {
        secBias: sc.bias || 'NEUTRAL', secScore: sc.score,
        secHot: (snap.breakoutNames || []).indexOf(row.ticker) !== -1,
        shortTerm: (snap.shortTerm && snap.shortTerm.result) || 'NEUTRAL',
        marketBias: (snap.shortTerm && snap.shortTerm.result) || 'NEUTRAL',
        longTerm: (snap.longTerm && snap.longTerm.result) || 'UNKNOWN',
        longTermLabel: (snap.longTerm && snap.longTerm.label) || '',
        midTerm: (snap.midTerm && snap.midTerm.result) || 'UNKNOWN',
        midTermLabel: (snap.midTerm && snap.midTerm.stageLabel) || ''
      };
    }
    rows[row.stock.ticker] = Object.assign({}, row, {
      context: ctx || row.context, _stockTime: row.lastUpdated, _contextTime: now
    });
  });

  if (!Object.keys(rows).length) return;

  var complete = true, reason = '';
  var rKeys = Object.keys(rows);
  for (var i = 0; i < rKeys.length; i++) {
    var row = rows[rKeys[i]];
    if (!row.stock || row.stock.price == null) { complete = false; reason = 'Ghost row: ' + rKeys[i]; break; }
    if (!row.context || row.context.longTerm === 'UNKNOWN') { complete = false; reason = 'Market snapshot unavailable'; break; }
    if (row.lastUpdated && (now - row.lastUpdated) > 15 * 60 * 1000) { complete = false; reason = 'Stock data stale: ' + rKeys[i]; break; }
  }

  store[date] = { slot: slot, capturedAt: bg_etTimeStr(), ts: now, _ctxTime: now,
    rows: rows, complete: complete, reason: reason };
  await bg_storageSet({ frozenScreener: store });
  chrome.runtime.sendMessage({ type: 'SNAPSHOT_UPDATED', date: date, slot: slot }, function () {
    if (chrome.runtime.lastError) {}
  });
}

// ── Register 3: EOD Outcome ───────────────────────────────────────────────

// Fetch today's 1-minute bars from Yahoo Finance (ET timezone labels).
async function bg_fetchYahooIntraday(sym) {
  var hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  var path = '/v8/finance/chart/' + yahooSymbol(sym) + '?range=1d&interval=1m&includePrePost=false';
  var fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  for (var i = 0; i < hosts.length; i++) {
    try {
      var resp = await fetch('https://' + hosts[i] + path);
      if (!resp.ok) continue;
      var j = await resp.json();
      var res = j && j.chart && j.chart.result && j.chart.result[0];
      var ts = res && res.timestamp;
      var q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
      if (!ts || !q) continue;
      var bars = [];
      for (var k = 0; k < ts.length; k++) {
        var o = q.open[k], h = q.high[k], l = q.low[k], c = q.close[k];
        if (o == null || h == null || l == null || c == null) continue;
        bars.push({ hhmm: fmt.format(new Date(ts[k] * 1000)), open: +o, high: +h, low: +l, close: +c });
      }
      if (bars.length) return bars;
    } catch (e) {}
  }
  return null;
}

// Wilder's ATR14 from daily bars (oldest→newest). Caller must exclude today's bar.
function bg_computeAtr14(bars) {
  if (!bars || bars.length < 2) return null;
  var trs = [];
  for (var i = 1; i < bars.length; i++) {
    var h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  var period = 14;
  if (trs.length < period) return null;
  var atr = 0;
  for (var j = 0; j < period; j++) atr += trs[j];
  atr /= period;
  for (var j = period; j < trs.length; j++) atr = (atr * (period - 1) + trs[j]) / period;
  return atr;
}

// Scan a bar array [oldest→newest] for HH and LL within a hhmm window.
function bg_hhll(bars, fromHhmm, toHhmm) {
  var hh = -Infinity, ll = Infinity;
  for (var b = 0; b < bars.length; b++) {
    var bar = bars[b];
    if (bar.hhmm < fromHhmm || bar.hhmm > toHhmm) continue;
    if (bar.high > hh) hh = bar.high;
    if (bar.low < ll) ll = bar.low;
  }
  return { hh: hh === -Infinity ? null : hh, ll: ll === Infinity ? null : ll };
}

async function bg_runEodOutcome(date) {
  var r = await bg_storageGet(['frozenScreener', 'eodOutcome']);
  var frozen = (r.frozenScreener || {})[date];
  if (!frozen || !frozen.rows || !Object.keys(frozen.rows).length) {
    try { chrome.runtime.sendMessage({ type: 'EOD_OUTCOME_COMPLETE', date: date, error: 'No Register 1 data for ' + date }, function () { if (chrome.runtime.lastError) {} }); } catch (_) {}
    return;
  }
  var store = r.eodOutcome || {};
  if (!store[date]) store[date] = { rows: {}, capturedAt: bg_etTimeStr(), complete: false };
  var tickers = Object.keys(frozen.rows);
  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    var frozenRow = frozen.rows[ticker];
    var r1Atr = (frozenRow.stock && frozenRow.stock.atr != null) ? +frozenRow.stock.atr : null;
    if (i > 0) await new Promise(function (resolve) { setTimeout(resolve, 800); });

    // Fetch intraday (1m) and daily history in parallel — daily used for historical ATR
    var results = await Promise.all([
      bg_fetchYahooIntraday(ticker),
      fetchDeskHistory(ticker, '1mo').catch(function () { return null; })
    ]);
    var intradayBars = results[0];
    var dailyResult = results[1];

    // Historical ATR14: exclude today's bar so today's volatility doesn't inflate ATR
    var histAtr = null;
    if (dailyResult && dailyResult.bars && dailyResult.bars.length) {
      var prevBars = dailyResult.bars.filter(function (b) { return b.time < date; });
      histAtr = bg_computeAtr14(prevBars);
    }
    var atr = histAtr != null ? histAtr : r1Atr;
    var atrSource = histAtr != null ? 'hist14' : (r1Atr != null ? 'r1_fallback' : 'unknown');

    if (!intradayBars || !intradayBars.length) {
      store[date].rows[ticker] = { ticker: ticker, atr: atr, atrSource: atrSource, status: 'no_data', fetchedAt: Date.now() };
      continue;
    }

    // Data quality: last bar must be >= 15:55 to confirm full session was captured
    var lastBar = intradayBars[intradayBars.length - 1];
    var dataComplete = lastBar && lastBar.hhmm >= '15:55';
    var status = dataComplete ? 'ok' : 'partial_data';

    // Entry at 9:35 — open of the first 1-min bar at or after 09:35
    var bar35 = null;
    for (var b = 0; b < intradayBars.length; b++) {
      if (intradayBars[b].hhmm >= '09:35') { bar35 = intradayBars[b]; break; }
    }
    // Entry at 9:40 — open of the first 1-min bar at or after 09:40
    var bar40 = null;
    for (var b = 0; b < intradayBars.length; b++) {
      if (intradayBars[b].hhmm >= '09:40') { bar40 = intradayBars[b]; break; }
    }

    var e35 = bar35 ? bar35.open : null;
    var e40 = bar40 ? bar40.open : null;

    var range35 = bg_hhll(intradayBars, '09:35', '16:00');
    var range40 = bg_hhll(intradayBars, '09:40', '16:00');

    store[date].rows[ticker] = {
      ticker: ticker,
      atr: atr, atrSource: atrSource,
      // 9:35 entry set
      entry35: e35,
      hh35: range35.hh, ll35: range35.ll,
      downR35: (atr && range35.ll != null && e35 != null) ? (e35 - range35.ll) / atr : null,
      upR35:   (atr && range35.hh != null && e35 != null) ? (range35.hh - e35) / atr : null,
      // 9:40 entry set
      entry40: e40,
      hh40: range40.hh, ll40: range40.ll,
      downR40: (atr && range40.ll != null && e40 != null) ? (e40 - range40.ll) / atr : null,
      upR40:   (atr && range40.hh != null && e40 != null) ? (range40.hh - e40) / atr : null,
      // meta
      lastBarTime: lastBar ? lastBar.hhmm : null,
      fetchedAt: Date.now(),
      status: status
    };
  }
  store[date].complete = true;
  store[date].capturedAt = bg_etTimeStr();
  await bg_storageSet({ eodOutcome: store });
  try { chrome.runtime.sendMessage({ type: 'EOD_OUTCOME_COMPLETE', date: date }, function () { if (chrome.runtime.lastError) {} }); } catch (_) {}
}

function setupSnapshotAlarms() {
  chrome.alarms.get('snapshotCheck', function (existing) {
    if (!existing) chrome.alarms.create('snapshotCheck', { periodInMinutes: 1 });
  });
}

chrome.runtime.onInstalled.addListener(function () { setupSnapshotAlarms(); });
chrome.runtime.onStartup.addListener(function () { setupSnapshotAlarms(); });

chrome.alarms.onAlarm.addListener(async function (alarm) {
  if (alarm.name !== 'snapshotCheck') return;
  if (!bg_isWeekdayET()) return;
  var r = await bg_storageGet(['settings']);
  var mode = (r.settings && r.settings.snapshotMode) || 'manual';
  if (mode !== 'auto') return;

  var hhmm = bg_getETHHMM();
  if (BG_SCAN_SLOTS.indexOf(hhmm) !== -1) {
    var today = bg_etDateStr();
    var slotKey = today + '|' + hhmm;
    if (!bg_preScanDoneSlots[slotKey]) {
      bg_preScanDoneSlots[slotKey] = true;
      await bg_preScan();
    }
  }

  // 16:05 ET: collect EOD outcome for all Register 1 tickers via Yahoo 1-min data.
  if (hhmm === '16:05') {
    var today2 = bg_etDateStr();
    if (bg_eodOutcomeDoneDate !== today2) {
      bg_eodOutcomeDoneDate = today2;
      bg_runEodOutcome(today2);
    }
  }

  var slot = bg_getActiveSlot();
  if (!slot) return;
  await bg_captureAndSaveSnapshot(slot);

  if (slot === '09:35') {
    // Background builds the frozen screener from stored registry + this snapshot.
    // If popup is also open it receives AUTO_FREEZE_REQUEST as a fallback, but
    // saveFrozenScreener in popup will be blocked if bg already saved complete=true.
    await bg_buildAndSaveFrozenScreener('09:35');
    try {
      chrome.runtime.sendMessage({ type: 'AUTO_FREEZE_REQUEST', slot: slot }, function () {
        if (chrome.runtime.lastError) {}
      });
    } catch (_) {}
  }
});

// ══════════════════════════════════════════════════════════════════════
// MESSAGE ROUTER — handles all actions from popup.js
// ══════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;

  // Trade Desk: TradingView screener proxy
  if (msg.action === 'tvScan') {
    fetch(TV_SCAN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.body || {})
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) { sendResponse({ ok: true, data: data }); })
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // Trade Desk: daily OHLC history for market/sector charts
  if (msg.action === 'chartHistory') {
    var range = (msg.range === '3mo' || msg.range === '6mo') ? msg.range : '6mo';
    fetchDeskHistory(msg.symbol, range)
      .then(function (out) { sendResponse({ ok: true, bars: out.bars, source: out.source }); })
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // Register 3: EOD outcome — fetch intraday data + compute metrics
  if (msg.action === 'runEodOutcome') {
    bg_runEodOutcome(msg.date || bg_etDateStr())
      .then(function () { sendResponse({ ok: true }); })
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // Trade Desk: news (Finnhub + TradingView)
  if (msg.action === 'news') {
    Promise.all([
      fetchFinnhubNews(msg.symbol, msg.finnhubKey),
      fetchTVNews(msg.tvSymbol, msg.symbol)
    ])
      .then(function (res) { sendResponse({ ok: true, finnhub: res[0], tradingview: res[1] }); })
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // Trade Journal: intraday / daily candles for per-trade charts
  if (msg.action === 'fetchCandles') {
    bg_fetchCandles(msg.ticker, msg.fromMs, msg.toMs, msg.resolution, msg.polygonKey, msg.finnhubKey, msg.range)
      .then(function (result) { sendResponse({ ok: true, candles: result }); })
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // Trade Journal: sector + industry lookup for journal card context section
  if (msg.action === 'fetchTickerProfile') {
    var _ticker = encodeURIComponent(msg.ticker || '');
    var _hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
    function _tryProfileHost(i) {
      if (i >= _hosts.length) return Promise.reject(new Error('Yahoo unreachable'));
      return fetch('https://' + _hosts[i] + '/v10/finance/quoteSummary/' + _ticker + '?modules=assetProfile', {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        var res = d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
        var ap = res && res.assetProfile;
        return { sector: (ap && ap.sector) || '', industry: (ap && ap.industry) || '' };
      }).catch(function () { return _tryProfileHost(i + 1); });
    }
    _tryProfileHost(0)
      .then(function (r) { sendResponse(r); })
      .catch(function () { sendResponse({ sector: '', industry: '' }); });
    return true;
  }
});
