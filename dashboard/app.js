// Token Radar v4 — dashboard logic. No network: everything comes from
// window.RADAR, written beside this page by main.ts. Rows are arrays:
// [slug, name, category, tvl, change7d, listedAt, implied, planKey,
//  cheapestChainIdx, watchFlag, bandLo, bandHi, rankLo, rankHi, net,
//  verdict(0 skip, 1 thin, 2 farm), expected, gasTotal, fees, deposit,
//  secondChainIdx]. Live rows: [slug, name, cat, tvl, mcap].
(function () {
  var R = window.RADAR;
  var rows = R.rows;
  var live = R.live;
  var plans = R.plans;
  var chains = R.chains;
  var gasCosts = R.gasCosts;

  // ------------------------------------------------------------ formatting
  function fmtUsd(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  }
  function fmtUsd2(v) {
    var sign = v < 0 ? '−' : v > 0 ? '+' : '';
    var a = Math.abs(v);
    if (a >= 1000) return sign + fmtUsd(a);
    return sign + '$' + a.toFixed(2);
  }
  function fmtCost(v) {
    if (v >= 1000) return fmtUsd(v);
    return '$' + v.toFixed(2);
  }
  function fmtPct(c) {
    if (c === null || c === undefined) return '—';
    return (c >= 0 ? '+' : '') + c.toFixed(1) + '%';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function daysSince(listed) {
    if (!listed) return null;
    var ms = Date.parse(R.asOf + 'T00:00:00Z') - Date.parse(listed + 'T00:00:00Z');
    if (isNaN(ms)) return null;
    return Math.floor(ms / 86400000);
  }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

  // ------------------------------------------------------------ gas
  // Same tier table as lib/model.ts, read from the data file: the cheapest
  // chain decides the plan, and every board chain has an explicit entry.
  function gasCost(chain) {
    var i = chains.indexOf(chain);
    return i >= 0 ? gasCosts[i] : 0.5;
  }
  function gasLabel(chain) {
    var c = gasCost(chain);
    if (c <= 0.01) return '~$0.01';
    if (c <= 0.03) return '~$0.01–0.05';
    if (c <= 0.12) return '~$0.05–0.20';
    if (c <= 0.3) return '~$0.10–0.50';
    if (c <= 1) return '~$0.50–2.00';
    return '~$2–10';
  }
  function ratioClass(ratio) {
    if (ratio >= 0.2) return 'hi';
    if (ratio >= 0.1) return 'mid';
    return 'lo';
  }
  function verdictWord(code) {
    return code === 2 ? 'Farm' : code === 1 ? 'Thin' : 'Skip';
  }
  function verdictClass(code) {
    return code === 2 ? 'farm' : code === 1 ? 'thin' : 'skip';
  }
  // Identical to farmVerdict in lib/model.ts: same thresholds, same words,
  // recomputed here from the row's own shipped numbers.
  function verdict(row) {
    var tvl = row[3], implied = row[6], net = row[14];
    var ratio = implied / tvl;
    var word = verdictWord(row[15]);
    return word + ': net ' + fmtUsd2(net) + ' on a $' + row[19] + ' deposit ' +
      '(expected ' + fmtUsd2(row[16]) + ' − ' + fmtCost(row[17]) + ' gas on ' +
      (chains[row[8]] || 'Ethereum') + ' − ' + fmtCost(row[18]) + ' fees), ' +
      'implied ' + fmtUsd(implied) + ' (' + ratio.toFixed(2) + '× TVL)';
  }

  // ------------------------------------------------------------ plan slots
  // Same slot filling as farmStepsFor in lib/model.ts: protocol name,
  // deposit tier, tenure from days unlaunched, cadence from the 7-day move,
  // cheapest chain plus the second-cheapest as fallback.
  function depositLabel(tvl) {
    if (tvl < 100000000) return '$25–100';
    if (tvl <= 1000000000) return '$100–500';
    return '$500–2,000';
  }
  function deposit2Label(tvl) {
    if (tvl < 100000000) return '$25–50';
    if (tvl <= 1000000000) return '$50–200';
    return '$200–500';
  }
  function tenureText(row) {
    var d = daysSince(row[5]);
    if (d === null) return 'no listing date is reported, so hold the full 8 weeks before judging the farm';
    if (d < 180) return 'only ' + d + ' days unlaunched — a fresh listing, so move in week 1 and reassess at day 56';
    if (d <= 540) return d + ' days unlaunched — a seasoned wait, so hold the full 8 weeks before judging it';
    return d + ' days unlaunched (' + (d / 365.25).toFixed(1) + ' years) — a long wait, so treat this as patient accumulation and hold 8+ weeks';
  }
  function cadenceText(row) {
    var c = row[4];
    if (c === null) return 'no 7-day change reported — check every 2 weeks';
    if (c < -10) return 'TVL down ' + Math.abs(c).toFixed(1) + '% in 7 days — check weekly and shrink the next deposit if it keeps falling';
    if (c > 20) return 'TVL up ' + c.toFixed(1) + '% in 7 days — momentum is strong, compound weekly while it lasts';
    return c >= 0
      ? 'TVL up ' + c.toFixed(1) + '% in 7 days — check every 2 weeks'
      : 'TVL down ' + Math.abs(c).toFixed(1) + '% in 7 days — check every 2 weeks and watch for a deeper slide';
  }
  function fallbackText(row) {
    var second = row[20];
    if (second < 0) return 'no second chain is on record — the fallback is to wait, not to bridge blind';
    return 'keep ' + chains[second] + ' as the fallback route if ' + (chains[row[8]] || 'Ethereum') + ' stalls';
  }
  function fillSteps(row) {
    var plan = plans[row[7]];
    var chain = chains[row[8]] || 'Ethereum';
    var slots = {
      '{NAME}': row[1], '{CHAIN}': chain, '{CHAIN2}': fallbackText(row),
      '{GAS}': gasLabel(chain), '{DEP}': depositLabel(row[3]),
      '{DEP2}': deposit2Label(row[3]), '{TENURE}': tenureText(row),
      '{CADENCE}': cadenceText(row),
    };
    return plan.steps.map(function (s) {
      var out = s;
      for (var k in slots) out = out.split(k).join(slots[k]);
      return out;
    });
  }

  // ------------------------------------------------------------ model panel
  document.getElementById('statBoard').textContent = R.nBoard;
  document.getElementById('statWatch').textContent = R.nWatch + '/' + R.nWatch;
  document.getElementById('statComps').textContent = R.nComps;
  document.getElementById('statTop').textContent = fmtUsd(rows[0][6]);
  var farmCount = rows.filter(function (r) { return r[15] === 2; }).length;
  document.getElementById('statFarm').textContent = farmCount;
  var loo = R.model.loo, sp = R.model.split, wf = R.model.walk;
  document.getElementById('validText').textContent =
    'Leave-one-out on ' + loo.n + ' comps: median error ' + loo.medErr.toFixed(1) +
    '%, ' + loo.in2x.toFixed(1) + '% predicted within 2×. Blind / out-of-sample time split (cutoff ' + sp.cutoff +
    ', train ' + sp.nTrain + ' / test ' + sp.nTest + ', test half never seen while fitting): median error ' + sp.medErr.toFixed(1) +
    '%, ' + sp.in2x.toFixed(1) + '% within 2×. The model is rough — read implied values as a ranking, not a price.';
  document.getElementById('walkText').textContent =
    'Walk-forward test (fit on earlier listings, test on later ones, three expanding windows): pooled over ' +
    wf.pooled.n + ' held-out comps, median error ' + wf.pooled.medErr.toFixed(1) + '%, ' +
    wf.pooled.in2x.toFixed(1) + '% within 2×. Per fold — ' +
    wf.folds.map(function (f, i) {
      return 'fold ' + (i + 1) + ' (train ' + f.train + ' / test ' + f.test + '): ' +
        f.medErr.toFixed(1) + '% / ' + f.in2x.toFixed(1) + '%';
    }).join('; ') + '.';
  document.getElementById('bootText').textContent =
    'Uncertainty: ' + R.model.bootstrap.nRefits + ' bootstrap refits (comps resampled with replacement, seed ' +
    R.model.bootstrap.seed + ') give every row a value band (10th–90th percentile) and a rank range (5th–95th percentile), ' +
    'shown on the board and in each detail view. Thin categories widen fast under resampling — the band says how much a rank depends on one or two comps.';
  document.getElementById('netText').textContent = 'Netted farm economics: ' + R.model.netFormula;
  var fits = R.model.fits;
  var catFits = Object.keys(fits).filter(function (k) { return k !== '*' && fits[k].m === 'cat'; })
    .sort(function (a, b) { return fits[b].n - fits[a].n || (a < b ? -1 : 1); });
  var medFits = Object.keys(fits).filter(function (k) { return k !== '*' && fits[k].m === 'med'; });
  var tb = document.querySelector('#fitsTable tbody');
  function fitRow(label, f, slopeTxt) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + esc(label) + '</td><td>' + slopeTxt + '</td><td>' +
      (f === null || f.a === null ? '—' : f.a.toFixed(6)) + '</td><td>' + (f ? f.n : '—') + '</td><td>' +
      (f ? f.r.toFixed(3) : '—') + '</td>';
    tb.appendChild(tr);
  }
  catFits.forEach(function (c) { fitRow(c, fits[c], fits[c].b.toFixed(3)); });
  if (medFits.length) {
    var thinN = medFits.reduce(function (a, c) { return a + fits[c].n; }, 0);
    var thinR = medFits.map(function (c) { return fits[c].r; }).sort(function (a, b) { return a - b; });
    var mid = Math.floor(thinR.length / 2);
    var thinMed = thinR.length % 2 ? thinR[mid] : (thinR[mid - 1] + thinR[mid]) / 2;
    fitRow(medFits.length + ' thin categories · median-ratio', { a: null, n: thinN, r: thinMed }, '1.000');
  }
  fitRow('Global (all comps)', fits['*'], fits['*'].b.toFixed(3));

  // ------------------------------------------------------------ filters
  var qEl = document.getElementById('q');
  var chainEl = document.getElementById('chainSel');
  chains.forEach(function (c, i) {
    var o = document.createElement('option');
    o.value = String(i); o.textContent = c; chainEl.appendChild(o);
  });
  var catCounts = {};
  rows.forEach(function (r) { var c = r[2] || '(no category)'; catCounts[c] = (catCounts[c] || 0) + 1; });
  var catNames = Object.keys(catCounts).sort(function (a, b) { return catCounts[b] - catCounts[a]; });
  var pillsEl = document.getElementById('catPills');
  var state = { q: '', chain: '', cat: '', mode: 'board', sort: 'rank', dir: 1 };
  function pill(label, count, active, onClick) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'pill' + (active ? ' on' : '');
    b.textContent = label + (count !== null ? ' (' + count + ')' : '');
    b.addEventListener('click', onClick);
    pillsEl.appendChild(b);
  }
  function renderPills() {
    pillsEl.innerHTML = '';
    pill('All', rows.length, !state.cat, function () { setCat(''); });
    catNames.forEach(function (c) {
      pill(c, catCounts[c], state.cat === c, function () { setCat(c); });
    });
  }
  function setCat(c) {
    state.cat = c;
    renderPills(); renderBoard();
    var h = c ? '#cat=' + encodeURIComponent(c) : '#';
    if (history.replaceState) history.replaceState(null, '', h);
  }

  // ------------------------------------------------------------ board
  var tbody = document.querySelector('#board tbody');
  var countLine = document.getElementById('countLine');
  function filtered() {
    var q = state.q.toLowerCase();
    return rows.filter(function (r) {
      if (state.cat && (r[2] || '(no category)') !== state.cat) return false;
      if (state.chain !== '' && r[8] !== Number(state.chain)) return false;
      if (q && (r[0] + ' ' + r[1]).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function fitOf(row) { return fits[row[2]] || fits['*']; }
  function fitPill(row) {
    var f = fitOf(row);
    var thin = f.n < 5;
    return '<span class="fitpill' + (thin ? ' thin' : '') + '">n=' + f.n + ' comps' +
      (thin ? ' · thin fit' : '') + '</span>';
  }
  var SORTS = {
    rank: function (r) { return rows.indexOf(r) + 1; },
    name: function (r) { return r[1].toLowerCase(); },
    cat: function (r) { return (r[2] || '').toLowerCase(); },
    tvl: function (r) { return r[3]; },
    chg: function (r) { return r[4] === null ? -Infinity : r[4]; },
    days: function (r) { var d = daysSince(r[5]); return d === null ? -Infinity : d; },
    implied: function (r) { return r[6]; },
    ratio: function (r) { return r[6] / r[3]; },
    net: function (r) { return r[14]; },
    verdict: function (r) { return r[15]; },
    plan: function (r) { return plans[r[7]].title; },
  };
  function renderBoard() {
    var list = filtered().slice();
    var key = SORTS[state.sort];
    list.sort(function (a, b) {
      var va = key(a), vb = key(b);
      if (va < vb) return -1 * state.dir;
      if (va > vb) return 1 * state.dir;
      return a[0] < b[0] ? -1 : 1;
    });
    tbody.innerHTML = '';
    list.forEach(function (r, i) {
      var tr = document.createElement('tr');
      var d = daysSince(r[5]);
      var chg = r[4] === null ? '—' : '<span class="' + (r[4] >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r[4]) + '</span>';
      var ratio = r[6] / r[3];
      var netCls = r[14] < 0 ? 'neg' : 'pos';
      tr.innerHTML = '<td>' + (rows.indexOf(r) + 1) +
        '<span class="small">rank ' + r[12] + '–' + r[13] + '</span></td>' +
        '<td><span class="nm">' + esc(r[1]) + '</span>' + (r[9] ? '<span class="watch">WATCHLIST</span>' : '') + fitPill(r) + '</td>' +
        '<td>' + esc(r[2] || '—') + '</td>' +
        '<td class="num">' + fmtUsd(r[3]) + '</td>' +
        '<td class="num">' + chg + '</td>' +
        '<td class="num">' + (d === null ? '—' : d) + '</td>' +
        '<td class="num"><b>' + fmtUsd(r[6]) + '</b>' +
        '<span class="small">' + fmtUsd(r[10]) + '–' + fmtUsd(r[11]) + '</span></td>' +
        '<td class="num"><span class="ratio ' + ratioClass(ratio) + '">' + ratio.toFixed(2) + '×</span></td>' +
        '<td class="num"><span class="' + netCls + '"><b>' + fmtUsd2(r[14]) + '</b></span></td>' +
        '<td><span class="vpill ' + verdictClass(r[15]) + '">' + verdictWord(r[15]) + '</span></td>' +
        '<td>' + esc(plans[r[7]].title) + '</td>';
      tr.addEventListener('click', function () { showDetail(r[0]); });
      tbody.appendChild(tr);
    });
    countLine.textContent = 'Showing ' + list.length + ' of ' + rows.length +
      ' pre-token protocols · ranked by implied value · click a row for its detail and farm plan.';
    document.querySelectorAll('#board th[data-sort]').forEach(function (th) {
      th.classList.remove('asc', 'desc');
      if (th.dataset.sort === state.sort) th.classList.add(state.dir === 1 ? 'asc' : 'desc');
    });
  }
  document.querySelectorAll('#board th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.dataset.sort;
      if (state.sort === k) state.dir *= -1;
      else { state.sort = k; state.dir = 1; }
      renderBoard();
    });
  });

  // ------------------------------------------------------------ live table
  var liveBody = document.querySelector('#live tbody');
  live.forEach(function (r, i) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + (i + 1) + '</td><td><span class="nm">' + esc(r[1]) + '</span></td>' +
      '<td>' + esc(r[2] || '—') + '</td><td class="num">' + fmtUsd(r[3]) + '</td>' +
      '<td class="num"><b>' + fmtUsd(r[4]) + '</b></td>';
    liveBody.appendChild(tr);
  });
  function setMode(mode) {
    state.mode = mode;
    document.getElementById('modeBoard').classList.toggle('on', mode === 'board');
    document.getElementById('modeLive').classList.toggle('on', mode === 'live');
    document.getElementById('boardWrap').hidden = mode !== 'board';
    document.getElementById('liveWrap').hidden = mode !== 'live';
    document.getElementById('detail').hidden = true;
    countLine.textContent = mode === 'live'
      ? 'Live tokens: ' + live.length + ' protocols with a recorded market cap, richest first — the comparables the curve is fitted on.'
      : '';
    if (mode === 'board') renderBoard();
  }
  document.getElementById('modeBoard').addEventListener('click', function () { setMode('board'); });
  document.getElementById('modeLive').addEventListener('click', function () { setMode('live'); });
  qEl.addEventListener('input', function () { state.q = qEl.value; renderBoard(); });
  chainEl.addEventListener('change', function () { state.chain = chainEl.value; renderBoard(); });

  // ------------------------------------------------------------ detail
  var detailEl = document.getElementById('detail');
  function fitLabel(f) {
    if (f.m === 'cat') return 'category fit (shrunk toward global)';
    if (f.m === 'med') return 'median-ratio fit';
    return 'global fit';
  }
  function showDetail(slug) {
    var r = rows.filter(function (x) { return x[0] === slug; })[0];
    if (!r) return;
    var chain = chains[r[8]] || 'Ethereum';
    var plan = plans[r[7]];
    var f = fits[r[2]] || fits['*'];
    var d = daysSince(r[5]);
    var growth = r[4] === null ? 1 : clamp(1 + r[4] / 100, 0.8, 1.2);
    var age = d === null ? 1 : clamp(1 - 0.15 * Math.min(1, Math.log10(1 + d / 365.25) / Math.log10(6)), 0.85, 1.0);
    var curve = Math.pow(10, f.a + f.b * Math.log10(r[3]));
    var cap = Math.min(10 * r[3], 1e14);
    var raw = curve * growth * age;
    var ratio = r[6] / r[3];
    var steps = fillSteps(r);
    detailEl.innerHTML =
      '<button class="close" type="button">Close ×</button>' +
      '<h2>' + esc(r[1]) + (r[9] ? ' <span class="watch">WATCHLIST</span>' : '') + '</h2>' +
      '<p>' + esc(r[2] || 'No category') + ' · ' + esc(r[0]) + ' · TVL ' + fmtUsd(r[3]) +
      ' · listed ' + esc(r[5] || 'date unknown') + (d === null ? '' : ' (' + d + ' days unlaunched)') + '</p>' +
      '<p><span class="fitpill' + (f.n < 5 ? ' thin' : '') + '">n=' + f.n + ' comps' + (f.n < 5 ? ' · thin fit' : '') + '</span> ' +
      '<span class="ratio ' + ratioClass(ratio) + '">' + ratio.toFixed(2) + '× TVL</span> ' +
      '<span class="vpill ' + verdictClass(r[15]) + '">' + verdictWord(r[15]) + '</span></p>' +
      '<p class="verdict">' + esc(verdict(r)) + '</p>' +
      '<div class="grid">' +
      '<div class="cell"><b>' + fmtUsd(r[6]) + '</b><span>Implied value</span></div>' +
      '<div class="cell"><b>' + fmtUsd(r[10]) + ' – ' + fmtUsd(r[11]) + '</b><span>Value band (bootstrap p10–p90)</span></div>' +
      '<div class="cell"><b>#' + (rows.indexOf(r) + 1) + ' (range ' + r[12] + '–' + r[13] + ')</b><span>Rank (bootstrap p5–p95)</span></div>' +
      '<div class="cell"><b>' + fmtUsd(curve) + '</b><span>Curve value</span></div>' +
      '<div class="cell"><b>×' + growth.toFixed(2) + '</b><span>Growth factor</span></div>' +
      '<div class="cell"><b>×' + age.toFixed(2) + '</b><span>Age factor</span></div>' +
      '<div class="cell"><b>' + fmtUsd(cap) + '</b><span>10× TVL cap</span></div>' +
      '<div class="cell"><b>' + esc(chain) + ' ' + esc(gasLabel(chain)) + '</b><span>Cheapest chain</span></div>' +
      '<div class="cell"><b>' + fmtUsd2(r[14]) + '</b><span>Net farm value</span></div>' +
      '<div class="cell"><b>' + fmtUsd2(r[16]) + '</b><span>Expected (band low × deposit ÷ TVL)</span></div>' +
      '<div class="cell"><b>' + fmtCost(r[17]) + '</b><span>Gas (6 tx on ' + esc(chain) + ')</span></div>' +
      '<div class="cell"><b>' + fmtCost(r[18]) + '</b><span>Fees (0.5% of $' + r[19] + ' deposit)</span></div>' +
      '</div>' +
      '<p>Fit: ' + fitLabel(f) + ' — slope ' + f.b.toFixed(3) + ', intercept ' + f.a.toFixed(6) +
      ', ' + f.n + ' comps, median MC/TVL ' + f.r.toFixed(3) + '. ' +
      'Implied = curve × growth × age, capped at 10× TVL: ' + fmtUsd(curve) + ' × ' + growth.toFixed(2) +
      ' × ' + age.toFixed(2) + ' = ' + fmtUsd(raw) + (raw > cap ? ' → capped at ' + fmtUsd(cap) : '') +
      ' → ' + fmtUsd(r[6]) + '. ' +
      'Validation: leave-one-out median error ' + loo.medErr.toFixed(1) + '% (' + loo.in2x.toFixed(1) + '% within 2×); ' +
      'blind / out-of-sample time split ' + sp.medErr.toFixed(1) + '% (' + sp.in2x.toFixed(1) + '% within 2×); ' +
      'walk-forward pooled ' + wf.pooled.medErr.toFixed(1) + '% (' + wf.pooled.in2x.toFixed(1) + '% within 2×); ' +
      'bootstrap ' + R.model.bootstrap.nRefits + ' refits for the band and rank range above.</p>' +
      '<p>Netting: ' + esc(R.model.netFormula) + '</p>' +
      '<h3>' + esc(plan.title) + ' — 8 steps, Day 1 to Day 56, deposit ' + esc(depositLabel(r[3])) + '</h3>' +
      '<ol>' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="fine">Cost hint: the plan moves ' + esc(depositLabel(r[3])) + ' per step over 8 weeks on ' + esc(chain) +
      ' (' + esc(gasLabel(chain)) + ' per tx, 6 tx); the second-cheapest chain is ' +
      (r[20] < 0 ? 'not on record' : esc(chains[r[20]])) + '. ' +
      'Implied values are this entry\u2019s claim, not a launch prediction. This protocol records no token — that is the record, not proof it has none.</p>';
    detailEl.hidden = false;
    detailEl.querySelector('.close').addEventListener('click', function () {
      detailEl.hidden = true;
      if (history.replaceState) history.replaceState(null, '', '#');
    });
    if (history.replaceState) history.replaceState(null, '', '#detail=' + slug);
  }

  // ------------------------------------------------------------ deep links
  function readHash() {
    var h = location.hash || '';
    if (h.indexOf('#detail=') === 0) {
      showDetail(decodeURIComponent(h.slice(8)));
    } else if (h.indexOf('#cat=') === 0) {
      setCat(decodeURIComponent(h.slice(5)));
    }
  }
  window.addEventListener('hashchange', readHash);
  renderPills();
  renderBoard();
  document.getElementById('footNote').textContent =
    'Snapshot: ' + R.asOf + ' · watchlist floor ' + fmtUsd(R.floor) +
    ' · Data: DefiLlama protocols at or above $5M TVL. A protocol is listed as pre-token when its record carries no token; that is the record, not proof it has none.';
  readHash();
})();
