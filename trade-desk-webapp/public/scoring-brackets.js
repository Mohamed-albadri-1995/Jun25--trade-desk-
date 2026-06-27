'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   scoring-brackets.js
   Shared bracket definitions used by both factor-analysis.html (to run
   analysis) and app.js (to score live screener cards against a saved model).

   Each entry has:
     id           — matches FACTOR_GROUPS factor ids in factor-analysis.html
     getValue(row) — extracts the factor value from a live registry card row
     matchBracket(val, brackets) — maps a value to the right bracket label
                    so the screener can look up the correct WoE from the model
   ═══════════════════════════════════════════════════════════════════════ */

var SCORE_FACTORS = [

  // ── Market Context (snapshot at entry) ──────────────────────────────
  {
    id: 'snap_regime',
    getValue: function(row) {
      return row.context && row.context.regime && row.context.regime.slug || null;
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  },
  {
    id: 'snap_lt',
    getValue: function(row) { return row.context && row.context.longTerm || null; },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  },
  {
    id: 'snap_mt',
    getValue: function(row) { return row.context && row.context.midTerm || null; },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  },
  {
    id: 'snap_st',
    getValue: function(row) { return row.context && row.context.shortTerm || null; },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  },
  {
    id: 'snap_sec',
    getValue: function(row) { return row.context && row.context.secBias || null; },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  },

  // ── Screener & Sector ────────────────────────────────────────────────
  {
    id: 'screeners',
    getValue: function(row) { return (row.screenerKeys || []).join(' / ') || null; },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  },
  {
    id: 'sector',
    getValue: function(row) { return (row.stock && row.stock.sector) || null; },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  },
  {
    id: 'industry',
    getValue: function(row) { return (row.stock && row.stock.industry) || null; },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  },
  {
    id: 'sec_bias',
    getValue: function(row) { return (row.context && row.context.secBias) || null; },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  },
  {
    id: 'sec_hot',
    getValue: function(row) {
      var hot = row.context && row.context.secHot;
      return hot ? '🔥 Hot' : 'Not hot';
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  },
  {
    id: 'catalyst',
    getValue: function(row) {
      return (row.catalyst && row.catalyst.label) || 'None';
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  },

  // ── Price Action ─────────────────────────────────────────────────────
  {
    id: 'price',
    getValue: function(row) { return row.stock && row.stock.price; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return null;
      if (val < 2)   return brackets.find(function(b){return b.label==='<$2';});
      if (val < 5)   return brackets.find(function(b){return b.label==='$2–5';});
      if (val < 10)  return brackets.find(function(b){return b.label==='$5–10';});
      if (val < 20)  return brackets.find(function(b){return b.label==='$10–20';});
      if (val < 50)  return brackets.find(function(b){return b.label==='$20–50';});
      return           brackets.find(function(b){return b.label==='$50+';});
    }
  },
  {
    id: 'change_pct',
    getValue: function(row) { return row.stock && row.stock.change; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return null;
      if (val < 0)    return brackets.find(function(b){return b.label==='Negative';});
      if (val < 10)   return brackets.find(function(b){return b.label==='<10%';});
      if (val < 25)   return brackets.find(function(b){return b.label==='10–25%';});
      if (val < 50)   return brackets.find(function(b){return b.label==='25–50%';});
      if (val < 100)  return brackets.find(function(b){return b.label==='50–100%';});
      return            brackets.find(function(b){return b.label==='>100%';});
    }
  },
  {
    id: 'gap_pct',
    getValue: function(row) { return row.stock && row.stock.gapPct; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return null;
      if (val < 0)    return brackets.find(function(b){return b.label==='Neg gap';});
      if (val < 10)   return brackets.find(function(b){return b.label==='0–10%';});
      if (val < 30)   return brackets.find(function(b){return b.label==='10–30%';});
      if (val < 50)   return brackets.find(function(b){return b.label==='30–50%';});
      if (val < 100)  return brackets.find(function(b){return b.label==='50–100%';});
      return            brackets.find(function(b){return b.label==='>100%';});
    }
  },
  {
    id: 'vs_vwap',
    getValue: function(row) {
      var s = row.stock;
      if (!s || s.price == null || s.vwap == null) return null;
      return s.price >= s.vwap ? 'Above VWAP' : 'Below VWAP';
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b){return b.label === val;}) || null;
    }
  },
  {
    id: 'vs_ema50',
    getValue: function(row) {
      var s = row.stock;
      if (!s || s.price == null || s.ema50 == null) return null;
      return s.price >= s.ema50 ? 'Above EMA50' : 'Below EMA50';
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b){return b.label === val;}) || null;
    }
  },
  {
    id: 'vs_sma5',
    getValue: function(row) {
      var s = row.stock;
      if (!s || s.price == null || s.sma5 == null) return null;
      return s.price >= s.sma5 ? 'Above SMA5' : 'Below SMA5';
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b){return b.label === val;}) || null;
    }
  },

  // ── Technical Setup (EMAs) ───────────────────────────────────────────
  {
    id: 'ema_stack',
    getValue: function(row) {
      var s = row.stock;
      if (!s || s.price == null) return null;
      var above50 = s.ema50 != null && s.price > s.ema50;
      var e9ok  = s.ema9  != null && s.ema9  > s.ema13;
      var e13ok = s.ema13 != null && s.ema13 > s.ema20;
      if (e9ok && e13ok && above50) return '9>13>20, above 50';
      if (e9ok && e13ok)            return '9>13>20, below 50';
      if (above50)                  return 'Above 50 only';
      return 'Mixed / bearish stack';
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b){return b.label === val;}) || null;
    }
  },
  {
    id: 'vs_ema9',
    getValue: function(row) {
      var s = row.stock;
      if (!s || s.price == null || s.ema9 == null) return null;
      return s.price >= s.ema9 ? 'Above EMA9' : 'Below EMA9';
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b){return b.label === val;}) || null;
    }
  },
  {
    id: 'vs_ema13',
    getValue: function(row) {
      var s = row.stock;
      if (!s || s.price == null || s.ema13 == null) return null;
      return s.price >= s.ema13 ? 'Above EMA13' : 'Below EMA13';
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b){return b.label === val;}) || null;
    }
  },
  {
    id: 'vs_ema20',
    getValue: function(row) {
      var s = row.stock;
      if (!s || s.price == null || s.ema20 == null) return null;
      return s.price >= s.ema20 ? 'Above EMA20' : 'Below EMA20';
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b){return b.label === val;}) || null;
    }
  },
  {
    id: 'month_pos',
    getValue: function(row) {
      var v = row.stock && row.stock.monthRangePos;
      if (v == null || !isFinite(v)) return null;
      if (v <= 25)  return 'Low (≤25%)';
      if (v <= 50)  return 'Mid-low (25–50%)';
      if (v <= 75)  return 'Mid-high (50–75%)';
      return                'High (>75%)';
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b){return b.label === val;}) || null;
    }
  },

  // ── Volume & Float ───────────────────────────────────────────────────
  {
    id: 'rvol',
    getValue: function(row) { return row.stock && row.stock.rvol; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return null;
      if (val < 5)    return brackets.find(function(b){return b.label==='<5x';});
      if (val < 20)   return brackets.find(function(b){return b.label==='5–20x';});
      if (val < 50)   return brackets.find(function(b){return b.label==='20–50x';});
      if (val < 200)  return brackets.find(function(b){return b.label==='50–200x';});
      return            brackets.find(function(b){return b.label==='>200x';});
    }
  },
  {
    id: 'mcap',
    getValue: function(row) { return row.stock && row.stock.mcap; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return null;
      if (val < 10e6)   return brackets.find(function(b){return b.label==='<$10M';});
      if (val < 50e6)   return brackets.find(function(b){return b.label==='$10–50M';});
      if (val < 200e6)  return brackets.find(function(b){return b.label==='$50–200M';});
      if (val < 1e9)    return brackets.find(function(b){return b.label==='$200M–1B';});
      return              brackets.find(function(b){return b.label==='>$1B';});
    }
  },
  {
    id: 'float',
    getValue: function(row) { return row.stock && row.stock.floatShares; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return null;
      if (val < 1e6)    return brackets.find(function(b){return b.label==='<1M';});
      if (val < 5e6)    return brackets.find(function(b){return b.label==='1–5M';});
      if (val < 20e6)   return brackets.find(function(b){return b.label==='5–20M';});
      if (val < 100e6)  return brackets.find(function(b){return b.label==='20–100M';});
      return              brackets.find(function(b){return b.label==='>100M';});
    }
  },
  {
    id: 'short_float',
    getValue: function(row) { return row.stock && row.stock.shortFloat; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return brackets.find(function(b){return b.label==='Unknown';}) || null;
      if (val < 5)   return brackets.find(function(b){return b.label==='<5%';});
      if (val < 15)  return brackets.find(function(b){return b.label==='5–15%';});
      if (val < 30)  return brackets.find(function(b){return b.label==='15–30%';});
      return           brackets.find(function(b){return b.label==='>30%';});
    }
  },

  // ── Volatility & Range ───────────────────────────────────────────────
  {
    id: 'atr',
    getValue: function(row) { return row.stock && row.stock.atr; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return null;
      if (val < 0.2)  return brackets.find(function(b){return b.label==='<$0.20';});
      if (val < 0.5)  return brackets.find(function(b){return b.label==='$0.20–0.50';});
      if (val < 1)    return brackets.find(function(b){return b.label==='$0.50–1';});
      if (val < 3)    return brackets.find(function(b){return b.label==='$1–3';});
      return            brackets.find(function(b){return b.label==='>$3';});
    }
  },
  {
    id: 'adr_pct',
    getValue: function(row) { return row.stock && row.stock.adrPct; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return null;
      if (val < 5)   return brackets.find(function(b){return b.label==='<5%';});
      if (val < 10)  return brackets.find(function(b){return b.label==='5–10%';});
      if (val < 20)  return brackets.find(function(b){return b.label==='10–20%';});
      if (val < 30)  return brackets.find(function(b){return b.label==='20–30%';});
      return           brackets.find(function(b){return b.label==='>30%';});
    }
  },
  {
    id: 'pm_range',
    getValue: function(row) { return row.stock && row.stock.pmRange; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return null;
      if (val < 0.3)  return brackets.find(function(b){return b.label==='<$0.3';});
      if (val < 1)    return brackets.find(function(b){return b.label==='$0.3–1';});
      if (val < 3)    return brackets.find(function(b){return b.label==='$1–3';});
      return            brackets.find(function(b){return b.label==='>$3';});
    }
  },
  {
    id: 'pm_adr',
    getValue: function(row) { return row.stock && row.stock.pmAdrRatio; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return null;
      if (val < 0.5)  return brackets.find(function(b){return b.label==='<0.5';});
      if (val < 1)    return brackets.find(function(b){return b.label==='0.5–1';});
      if (val < 2)    return brackets.find(function(b){return b.label==='1–2';});
      if (val < 5)    return brackets.find(function(b){return b.label==='2–5';});
      return            brackets.find(function(b){return b.label==='>5';});
    }
  },

  // ── Sector Score ─────────────────────────────────────────────────────
  {
    id: 'sec_score',
    getValue: function(row) { return row.context && row.context.secScore; },
    matchBracket: function(val, brackets) {
      if (val === null || !isFinite(val)) return null;
      if (val < -50)       return brackets.find(function(b){return b.label==='<−50 (very bearish)';});
      if (val < -20)       return brackets.find(function(b){return b.label==='−50 to −20';});
      if (val <= 20)       return brackets.find(function(b){return b.label==='−20 to +20 (neutral)';});
      if (val <= 50)       return brackets.find(function(b){return b.label==='+20 to +50';});
      return                 brackets.find(function(b){return b.label==='>+50 (very bullish)';});
    }
  },

  // ── Time / Calendar ─────────────────────────────────────────────────
  {
    id: 'day_of_week',
    getValue: function(row) {
      var d = row.date || (row.stock && row.stock.date);
      if (!d) return null;
      var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      // date string is YYYY-MM-DD; parse as local date to avoid UTC offset shift
      var parts = String(d).split('-');
      if (parts.length < 3) return null;
      var dt = new Date(+parts[0], +parts[1] - 1, +parts[2]);
      return days[dt.getDay()] || null;
    },
    matchBracket: function(val, brackets) {
      return brackets.find(function(b) { return b.label === val; }) || null;
    }
  }
];

// Look up a SCORE_FACTORS entry by factor id
function scoreFactor(id) {
  for (var i = 0; i < SCORE_FACTORS.length; i++) {
    if (SCORE_FACTORS[i].id === id) return SCORE_FACTORS[i];
  }
  return null;
}

// Compute a 0–100 score for a registry card row given a saved scoring model.
// Returns null if no model or no factors matched.
function scoreCard(row, model) {
  if (!model || !model.factors || !model.factors.length) return null;
  var weightedWoE = 0, totalWeight = 0;
  model.factors.forEach(function(mf) {
    var sf = scoreFactor(mf.id);
    if (!sf) return;
    var val = sf.getValue(row);
    if (val === null || val === undefined) return;
    var bracket = sf.matchBracket(val, mf.brackets);
    if (!bracket) return;
    weightedWoE  += mf.V * bracket.woe;
    totalWeight  += mf.V;
  });
  if (totalWeight === 0) return null;
  var raw = weightedWoE / totalWeight;         // typically −2 to +2
  var score = Math.round((raw + 2) / 4 * 100); // normalise to 0–100
  return Math.max(0, Math.min(100, score));
}
