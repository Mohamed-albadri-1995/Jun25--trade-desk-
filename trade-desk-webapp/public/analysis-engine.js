// analysis-engine.js — pure computation shared between browser (factor-analysis.html)
// and Node.js server (autoUpdateModel in server.js). No DOM dependencies.

// ── Helpers ──────────────────────────────────────────────────────────────────

function pf(row, col) { return parseFloat(row[col]); }

function numBrackets(get, brackets) {
  return function(rows) {
    const result = brackets.map(b => ({
      label: b.label,
      rows: rows.filter(r => { const v = get(r); return isFinite(v) && b.test(v); }),
      _numericPlaceholder: true
    }));
    const naRows = rows.filter(r => !isFinite(get(r)));
    if (naRows.length) result.push({ label: 'N/A (missing)', rows: naRows, _numericPlaceholder: true });
    return result;
  };
}

function catBrackets(get) {
  return function(rows) {
    const map = {};
    rows.forEach(r => {
      const v = String(get(r) || 'Unknown');
      if (!map[v]) map[v] = [];
      map[v].push(r);
    });
    return Object.keys(map).sort((a, b) => map[b].length - map[a].length)
      .map(k => ({ label: k, rows: map[k] }));
  };
}

function emaStack(row) {
  const p=pf(row,'price'), e9=pf(row,'ema9'), e13=pf(row,'ema13'), e20=pf(row,'ema20'), e50=pf(row,'ema50');
  if (!isFinite(p)||!isFinite(e9)||!isFinite(e13)||!isFinite(e20)||!isFinite(e50)) return 'N/A';
  const A=p>e9, B=e9>e13, C=e13>e20, D=e20>e50;
  if ( A &&  B &&  C &&  D) return 'p>9>13>20>50 (full bull)';
  if (!A && !B && !C && !D) return 'p<9<13<20<50 (full bear)';
  if (!A &&  B &&  C &&  D) return '9>13>20>50, p below EMA9';
  if ( A &&  B &&  C && !D) return 'p>9>13>20, below EMA50';
  if (!A &&  B &&  C && !D) return '9>13>20, p below EMA9, below EMA50';
  if ( A && !B &&  C &&  D) return 'p>EMA9, 13>20>50, EMA9 lagging';
  if (!A && !B &&  C &&  D) return '13>20>50, price & EMA9 lagging';
  if ( A && !B && !C &&  D) return 'p>EMA9, EMA20>50, middle mixed';
  if (!A && !B && !C &&  D) return 'EMA20>50 only, rest bearish';
  if ( A &&  B && !C && !D) return 'p>EMA9>13, below EMA20/50';
  if ( A && !B && !C && !D) return 'p>EMA9 only, EMAs bearish';
  return 'Mixed stack';
}

function priceVsEMA(row, ema) {
  const p=pf(row,'price'), e=pf(row,ema);
  if (!isFinite(p)||!isFinite(e)) return 'N/A';
  return p > e ? 'Above' : 'Below';
}

function priceVsVWAP(row) {
  const p=pf(row,'price'), v=pf(row,'vwap');
  if (!isFinite(p)||!isFinite(v)) return 'N/A';
  return p > v ? 'Above VWAP' : 'Below VWAP';
}

function monthPosBucket(row) {
  const v = pf(row,'month_range_pos');
  if (!isFinite(v)) return 'N/A';
  if (v < 20) return '0–20% (near low)';
  if (v < 40) return '20–40%';
  if (v < 60) return '40–60% (mid)';
  if (v < 80) return '60–80%';
  return '80–100% (near high)';
}

// ── Factor Groups ─────────────────────────────────────────────────────────────

const FACTOR_GROUPS = [
  {
    title: '🌊 Market Context (snapshot at entry)',
    factors: [
      { id:'snap_regime', label:'Regime',              fn: catBrackets(r => r._regime) },
      { id:'snap_lt',     label:'Long-term',           fn: catBrackets(r => r._lt) },
      { id:'snap_mt',     label:'Mid-term',            fn: catBrackets(r => r._mt) },
      { id:'snap_st',     label:'Short-term',          fn: catBrackets(r => r._st) },
      { id:'snap_sec',    label:'Sector bias (snapshot)', fn: catBrackets(r => r._secBias) },
    ]
  },
  {
    title: '🏷 Screener & Sector',
    factors: [
      { id:'screeners', label:'Screener(s) matched', fn: catBrackets(r => r.screeners ? r.screeners.split('|').sort().join(' + ') : null) },
      { id:'sector',    label:'Sector',              fn: catBrackets(r => r.sector) },
      { id:'industry',  label:'Industry',            fn: catBrackets(r => r.industry) },
      { id:'sec_bias',  label:'Sector bias (capture)', fn: catBrackets(r => r.sec_bias) },
      { id:'sec_hot',   label:'Sector hot',          fn: catBrackets(r => r.sec_hot === 'true' ? '🔥 Hot' : 'Not hot') },
      { id:'catalyst',  label:'Catalyst',            fn: catBrackets(r => r.catalyst || 'None') },
    ]
  },
  {
    title: '📈 Price Action',
    factors: [
      { id:'price', label:'Price ($)', getValue: r => pf(r,'price'), fn: numBrackets(r => pf(r,'price'), [
          {label:'<$2',     test:v=>v<2},
          {label:'$2–5',    test:v=>v>=2&&v<5},
          {label:'$5–10',   test:v=>v>=5&&v<10},
          {label:'$10–20',  test:v=>v>=10&&v<20},
          {label:'$20–50',  test:v=>v>=20&&v<50},
          {label:'$50+',    test:v=>v>=50},
        ])},
      { id:'change_pct', label:'Change % (day)', getValue: r => pf(r,'change_pct'), fn: numBrackets(r => pf(r,'change_pct'), [
          {label:'<10%',     test:v=>v>=0&&v<10},
          {label:'10–25%',   test:v=>v>=10&&v<25},
          {label:'25–50%',   test:v=>v>=25&&v<50},
          {label:'50–100%',  test:v=>v>=50&&v<100},
          {label:'>100%',    test:v=>v>=100},
          {label:'Negative', test:v=>v<0},
        ])},
      { id:'gap_pct', label:'Gap % (vs prev close)', getValue: r => pf(r,'gap_pct'), fn: numBrackets(r => pf(r,'gap_pct'), [
          {label:'Neg gap',   test:v=>v<0},
          {label:'0–10%',     test:v=>v>=0&&v<10},
          {label:'10–30%',    test:v=>v>=10&&v<30},
          {label:'30–50%',    test:v=>v>=30&&v<50},
          {label:'50–100%',   test:v=>v>=50&&v<100},
          {label:'>100%',     test:v=>v>=100},
        ])},
      { id:'vs_vwap',  label:'Price vs VWAP',  fn: catBrackets(priceVsVWAP) },
      { id:'vs_ema50', label:'Price vs EMA50', fn: catBrackets(r => priceVsEMA(r,'ema50')) },
      { id:'vs_sma5',  label:'Price vs SMA5',  fn: catBrackets(r => priceVsEMA(r,'sma5')) },
    ]
  },
  {
    title: '🔧 Technical Setup (EMAs)',
    factors: [
      { id:'ema_stack', label:'EMA Stack (9/13/20 vs 50)', fn: catBrackets(emaStack) },
      { id:'vs_ema9',   label:'Price vs EMA9',  fn: catBrackets(r => priceVsEMA(r,'ema9')) },
      { id:'vs_ema13',  label:'Price vs EMA13', fn: catBrackets(r => priceVsEMA(r,'ema13')) },
      { id:'vs_ema20',  label:'Price vs EMA20', fn: catBrackets(r => priceVsEMA(r,'ema20')) },
      { id:'month_pos', label:'Monthly range position', fn: catBrackets(monthPosBucket) },
    ]
  },
  {
    title: '📊 Volume & Float',
    factors: [
      { id:'rvol', label:'RVOL (10d)', getValue: r => pf(r,'rvol'), fn: numBrackets(r => pf(r,'rvol'), [
          {label:'<5x',     test:v=>v<5},
          {label:'5–20x',   test:v=>v>=5&&v<20},
          {label:'20–50x',  test:v=>v>=20&&v<50},
          {label:'50–200x', test:v=>v>=50&&v<200},
          {label:'>200x',   test:v=>v>=200},
        ])},
      { id:'mcap', label:'Market Cap', getValue: r => pf(r,'mcap'), fn: numBrackets(r => pf(r,'mcap'), [
          {label:'<$10M',    test:v=>v<10e6},
          {label:'$10–50M',  test:v=>v>=10e6&&v<50e6},
          {label:'$50–200M', test:v=>v>=50e6&&v<200e6},
          {label:'$200M–1B', test:v=>v>=200e6&&v<1e9},
          {label:'>$1B',     test:v=>v>=1e9},
        ])},
      { id:'float', label:'Float shares', getValue: r => pf(r,'float_shares'), fn: numBrackets(r => pf(r,'float_shares'), [
          {label:'<1M',     test:v=>v<1e6},
          {label:'1–5M',    test:v=>v>=1e6&&v<5e6},
          {label:'5–20M',   test:v=>v>=5e6&&v<20e6},
          {label:'20–100M', test:v=>v>=20e6&&v<100e6},
          {label:'>100M',   test:v=>v>=100e6},
        ])},
      { id:'short_float', label:'Short float %', getValue: r => pf(r,'short_float'), fn: numBrackets(r => pf(r,'short_float'), [
          {label:'Unknown', test:v=>!isFinite(v)},
          {label:'<5%',     test:v=>isFinite(v)&&v<5},
          {label:'5–15%',   test:v=>v>=5&&v<15},
          {label:'15–30%',  test:v=>v>=15&&v<30},
          {label:'>30%',    test:v=>v>=30},
        ])},
    ]
  },
  {
    title: '🌋 Volatility & Range',
    factors: [
      { id:'atr', label:'ATR ($)', getValue: r => pf(r,'atr'), fn: numBrackets(r => pf(r,'atr'), [
          {label:'<$0.20',     test:v=>v<0.2},
          {label:'$0.20–0.50', test:v=>v>=0.2&&v<0.5},
          {label:'$0.50–1',    test:v=>v>=0.5&&v<1},
          {label:'$1–3',       test:v=>v>=1&&v<3},
          {label:'>$3',        test:v=>v>=3},
        ])},
      { id:'adr_pct', label:'ADR %', getValue: r => pf(r,'adr_pct'), fn: numBrackets(r => pf(r,'adr_pct'), [
          {label:'<5%',    test:v=>v<5},
          {label:'5–10%',  test:v=>v>=5&&v<10},
          {label:'10–20%', test:v=>v>=10&&v<20},
          {label:'20–30%', test:v=>v>=20&&v<30},
          {label:'>30%',   test:v=>v>=30},
        ])},
      { id:'pm_range', label:'PM Range ($)', getValue: r => pf(r,'pm_range'), fn: numBrackets(r => pf(r,'pm_range'), [
          {label:'<$0.3',  test:v=>v<0.3},
          {label:'$0.3–1', test:v=>v>=0.3&&v<1},
          {label:'$1–3',   test:v=>v>=1&&v<3},
          {label:'>$3',    test:v=>v>=3},
        ])},
      { id:'pm_adr', label:'PM Range / ADR ratio', getValue: r => pf(r,'pm_adr_ratio'), fn: numBrackets(r => pf(r,'pm_adr_ratio'), [
          {label:'<0.5', test:v=>v<0.5},
          {label:'0.5–1',test:v=>v>=0.5&&v<1},
          {label:'1–2',  test:v=>v>=1&&v<2},
          {label:'2–5',  test:v=>v>=2&&v<5},
          {label:'>5',   test:v=>v>=5},
        ])},
    ]
  },
  {
    title: '🗺 Sector Score',
    factors: [
      { id:'sec_score', label:'Sector score', getValue: r => pf(r,'sec_score'), fn: numBrackets(r => pf(r,'sec_score'), [
          {label:'<−50 (very bearish)', test:v=>v<-50},
          {label:'−50 to −20',         test:v=>v>=-50&&v<-20},
          {label:'−20 to +20 (neutral)',test:v=>v>=-20&&v<=20},
          {label:'+20 to +50',         test:v=>v>20&&v<=50},
          {label:'>+50 (very bullish)', test:v=>v>50},
        ])},
    ]
  },
  {
    title: '📅 Calendar',
    factors: [
      { id:'day_of_week', label:'Day of week', fn: catBrackets(r => {
          const d = r.date;
          if (!d) return null;
          const parts = String(d).split('-');
          if (parts.length < 3) return null;
          const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
          return days[new Date(+parts[0], +parts[1]-1, +parts[2]).getDay()] || null;
        })
      },
    ]
  },
];

// ── Row transformer ───────────────────────────────────────────────────────────
// mode: 'up' | 'down' | 'max'

function makeWorkingRow(row, suffix, snapPfx, mode) {
  const upR   = parseFloat(row['up_r'   + suffix]);
  const downR = parseFloat(row['down_r' + suffix]);
  if (mode === 'up'   && !isFinite(upR))   return null;
  if (mode === 'down' && !isFinite(downR))  return null;
  if (mode === 'max'  && (!isFinite(upR) || !isFinite(downR))) return null;
  const output = mode === 'up'   ? upR
               : mode === 'down' ? downR
               : Math.max(upR, downR);
  return {
    ...row,
    _entrySlot: suffix === '35' ? '09:35' : '09:40',
    _upR:     upR,
    _downR:   downR,
    _output:  output,
    _regime:  row[snapPfx + '_regime']   || '',
    _lt:      row[snapPfx + '_lt']       || '',
    _mt:      row[snapPfx + '_mt']       || '',
    _st:      row[snapPfx + '_st']       || '',
    _secBias: row[snapPfx + '_sec_bias'] || '',
  };
}

// ── Statistics ────────────────────────────────────────────────────────────────

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z >= 0 ? 1 - p : p;
}

function chiSquarePValue(chi2, df) {
  if (df <= 0 || chi2 <= 0) return 1;
  const mu    = 1 - 2 / (9 * df);
  const sigma = Math.sqrt(2 / (9 * df));
  const z     = (Math.cbrt(chi2 / df) - mu) / sigma;
  return 1 - normalCDF(z);
}

function chiSquareAndV(brackets, successTest) {
  const activeBrackets = brackets.filter(b => b.rows.length > 0);
  const k = activeBrackets.length;
  if (k < 2) return { chi2: 0, V: 0, p: 1, df: 0 };

  const n      = activeBrackets.reduce((s, b) => s + b.rows.length, 0);
  const totalS = activeBrackets.reduce((s, b) => s + b.rows.filter(successTest).length, 0);
  const totalF = n - totalS;
  if (totalS === 0 || totalF === 0) return { chi2: 0, V: 0, p: 1, df: k - 1 };

  let chi2 = 0;
  activeBrackets.forEach(b => {
    const obsS = b.rows.filter(successTest).length;
    const obsF = b.rows.length - obsS;
    const expS = b.rows.length * totalS / n;
    const expF = b.rows.length * totalF / n;
    if (expS > 0.5) chi2 += (obsS - expS) ** 2 / expS;
    if (expF > 0.5) chi2 += (obsF - expF) ** 2 / expF;
  });

  const df = k - 1;
  const V  = Math.min(Math.sqrt(chi2 / n), 1);
  const p  = chiSquarePValue(chi2, df);
  return { chi2, V, p, df };
}

// WoE statistics constants. A bracket's WoE must scale with how much evidence
// backs it — otherwise a 2-row bracket shouts as loudly as a 200-row one.
//   WOE_SMOOTH — Laplace/Haldane add-one(-half) smoothing. Adding a constant to
//     every cell before the ratio means an empty cell can never produce log(0).
//     This replaces the old `|| 1e-9` fallback that yielded WoE ≈ ±20 and forced
//     a downstream ±2 clamp that only hid the symptom.
//   WOE_CRED_K — credibility weight. Each bracket's WoE is shrunk toward 0
//     (neutral) by n/(n+K), so a bracket is ~half-trusted once it holds K rows.
const WOE_SMOOTH = 0.5;
const WOE_CRED_K = 20;

function infoValue(brackets, successTest) {
  const totalS = brackets.reduce((s, b) => s + b.rows.filter(successTest).length, 0);
  const totalF = brackets.reduce((s, b) => s + b.rows.filter(r => !successTest(r)).length, 0);
  if (!totalS || !totalF) return { iv: 0, detail: [] };

  const k = brackets.length;
  let iv = 0;
  const detail = brackets.map(b => {
    const s  = b.rows.filter(successTest).length;
    const f  = b.rows.length - s;
    const ds = (s + WOE_SMOOTH) / (totalS + WOE_SMOOTH * k);  // smoothed success share
    const df = (f + WOE_SMOOTH) / (totalF + WOE_SMOOTH * k);  // smoothed failure share
    const cred = b.rows.length / (b.rows.length + WOE_CRED_K); // sample-size credibility
    const woe    = Math.log(ds / df) * cred;
    const contrib = (ds - df) * woe;
    iv += contrib;
    return { label: b.label, n: b.rows.length, s, f, ds, df, woe, contrib };
  });

  return { iv: Math.max(0, iv), detail };
}

function etaSquared(brackets) {
  const allRows   = brackets.flatMap(b => b.rows);
  const n         = allRows.length;
  if (n < 2) return null;
  const grandMean = allRows.reduce((s, r) => s + r._output, 0) / n;
  const ssTotal   = allRows.reduce((s, r) => s + (r._output - grandMean) ** 2, 0);
  if (ssTotal === 0) return null;
  const ssBetween = brackets.reduce((s, b) => {
    if (!b.rows.length) return s;
    const bMean = b.rows.reduce((a, r) => a + r._output, 0) / b.rows.length;
    return s + b.rows.length * (bMean - grandMean) ** 2;
  }, 0);
  return Math.min(ssBetween / ssTotal, 1);
}

function spearmanRho(rows, getValue) {
  const pairs = rows.map(r => ({ x: getValue(r), y: r._output }))
                    .filter(p => isFinite(p.x) && isFinite(p.y));
  const n = pairs.length;
  if (n < 5) return null;

  function assignRanks(vals) {
    const sorted = vals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks  = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j < n - 1 && sorted[j + 1].v === sorted[j].v) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[sorted[k].i] = avg;
      i = j + 1;
    }
    return ranks;
  }

  const rx = assignRanks(pairs.map(p => p.x));
  const ry = assignRanks(pairs.map(p => p.y));
  let sumD2 = 0;
  for (let i = 0; i < n; i++) sumD2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

// ── Core analysis ─────────────────────────────────────────────────────────────
// Returns the same corrData array that renderCorrelationSummary builds in the browser.

function computeCorrelation(finalRows, threshold) {
  const successTest = r => r._output >= threshold;
  const nSuccess    = finalRows.filter(successTest).length;
  const corrData    = [];

  FACTOR_GROUPS.forEach(group => {
    group.factors.forEach(factor => {
      const brackets = factor.fn(finalRows).filter(b => b.rows.length >= 1);
      if (brackets.length < 2) return;

      const cv    = chiSquareAndV(brackets, successTest);
      const ivRes = infoValue(brackets, successTest);
      const η2    = etaSquared(brackets);
      const rho   = factor.getValue ? spearmanRho(finalRows, factor.getValue) : null;

      const bracketStats = ivRes.detail.map(d => ({
        ...d,
        rate: d.n ? d.s / d.n : null
      }));

      const verdict = cv.V >= 0.40                        ? 'strong'
                    : cv.V >= 0.20 || ivRes.iv >= 0.10    ? 'moderate'
                    : cv.V >= 0.10 || ivRes.iv >= 0.02    ? 'weak'
                    : 'noise';

      corrData.push({
        group:   group.title,
        factor:  factor.label,
        id:      factor.id,
        V:       cv.V,
        chi2:    cv.chi2,
        df:      cv.df,
        p:       cv.p,
        iv:      ivRes.iv,
        eta2:    η2,
        rho,
        verdict,
        bracketStats,
        basePct: nSuccess / finalRows.length,
      });
    });
  });

  corrData.sort((a, b) => b.V - a.V);
  return corrData;
}

// ── Model builder ─────────────────────────────────────────────────────────────
// settings: { slot, mode, threshold, verdictFilter, noisePct, regimes }
// Returns model object ready to POST to /api/scoring-model, or null if no factors found.

function buildScoringModel(corrData, settings) {
  const filter  = settings.verdictFilter || 'strong+moderate';
  const allowed = filter === 'strong'          ? ['strong']
                : filter === 'strong+moderate' ? ['strong', 'moderate']
                : ['strong', 'moderate', 'weak'];

  const factors = corrData
    .filter(d => allowed.includes(d.verdict))
    .map(d => ({
      id:      d.id,
      label:   d.factor,
      V:       Math.round(d.V * 10000) / 10000,
      verdict: d.verdict,
      brackets: (d.bracketStats || []).map(b => ({
        label: b.label,
        woe:   Math.round(Math.max(-2, Math.min(2, b.woe || 0)) * 10000) / 10000
      }))
    }));

  if (!factors.length) return null;

  return {
    savedAt:       new Date().toISOString(),
    slot:          settings.slot   || '09:35',
    mode:          settings.mode   || 'up',
    threshold:     settings.threshold || 1.3,
    noisePct:      settings.noisePct  || 30,
    verdictFilter: filter,
    factors
  };
}

// ── Node.js export ────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FACTOR_GROUPS, makeWorkingRow, computeCorrelation, buildScoringModel };
}
