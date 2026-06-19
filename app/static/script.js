// state
let stocks = [], crypto = [], forex = [], fg = null, indicatorsData = null;
let detailCharts = {}, detailData = null;
let compareChartInstance = null;
let compareSymbols = [];
let currentSymbol = '';
let currentTimeframe = '3mo';
let sortState = { stocks: { col: null, dir: 1 }, crypto: { col: null, dir: 1 }, forex: { col: null, dir: 1 } };
let portfolio = ls('portfolio') || [];

function ls(k, v) {
  if (v === undefined) { const r = localStorage.getItem(k); try { return JSON.parse(r) } catch { return r } }
  localStorage.setItem(k, JSON.stringify(v));
}

// ------ theme ------
function initTheme() {
  const t = ls('theme') || 'dark';
  document.body.classList.toggle('light', t === 'light');
  document.getElementById('themeToggle').textContent = t === 'light' ? '☀️' : '🌙';
}
document.getElementById('themeToggle').addEventListener('click', () => {
  const isLight = document.body.classList.toggle('light');
  const t = isLight ? 'light' : 'dark';
  document.getElementById('themeToggle').textContent = isLight ? '☀️' : '🌙';
  ls('theme', t);
});

// ------ overview ------
function renderOverview(stocks, crypto, fg, indicators) {
  const adv = stocks.filter(s => s.change_pct > 0).length;
  const dec = stocks.filter(s => s.change_pct < 0).length;
  const best = stocks.length ? stocks.reduce((a, b) => (a.change_pct ?? -999) > (b.change_pct ?? -999) ? a : b) : null;
  const worst = stocks.length ? stocks.reduce((a, b) => (a.change_pct ?? 999) < (b.change_pct ?? 999) ? a : b) : null;
  const cards = [
    { label: "Advancers", value: adv, cls: "ov-green" },
    { label: "Decliners", value: dec, cls: "ov-red" },
    { label: "Best", value: best ? `${best.symbol} ${(best.change_pct >= 0 ? '+' : '') + best.change_pct.toFixed(1)}%` : '--', cls: "ov-green" },
    { label: "Worst", value: worst ? `${worst.symbol} ${(worst.change_pct >= 0 ? '+' : '') + worst.change_pct.toFixed(1)}%` : '--', cls: "ov-red" },
    { label: "Crypto", value: `${crypto.length} assets`, cls: "ov-yellow" },
    { label: "Fear & Greed", value: fg ? `${fg.value} - ${fg.label}` : '--', cls: "" },
    { label: "Market Strength", value: indicators ? `${indicators.market_strength}%` : '--', sub: indicators ? indicators.summary : '', cls: "" },
  ];
  document.getElementById('overviewGrid').innerHTML = cards.map(c =>
    `<div class="overview-card"><div class="ov-label">${c.label}</div><div class="ov-value ${c.cls}">${c.value}</div>${c.sub ? `<div class="ov-sub">${c.sub}</div>` : ''}</div>`
  ).join('');
}

// ------ fear & greed gauge ------
function renderFearGreed(data) {
  fg = data;
  const el = document.getElementById('fearGreedGauge');
  const ctx = el.getContext('2d');
  const v = data.value, w = el.width, h = el.height, cx = w / 2, cy = h * 0.65, r = 70;
  ctx.clearRect(0, 0, w, h);
  const segments = [
    { end: 25, color: '#f85149' }, { end: 45, color: '#d29922' },
    { end: 55, color: '#8b949e' }, { end: 75, color: '#58a6ff' }, { end: 100, color: '#3fb950' }
  ];
  let start = -180;
  segments.forEach(s => {
    const endAngle = -180 + (s.end / 100) * 180;
    ctx.beginPath(); ctx.arc(cx, cy, r, start * Math.PI / 180, endAngle * Math.PI / 180);
    ctx.strokeStyle = s.color; ctx.lineWidth = 18; ctx.lineCap = 'butt'; ctx.stroke(); start = endAngle;
  });
  const angle = -180 + (v / 100) * 180;
  const arcRad = angle * Math.PI / 180;
  const nx = cx + (r - 5) * Math.cos(arcRad), ny = cy + (r - 5) * Math.sin(arcRad);
  ctx.beginPath(); ctx.moveTo(cx, cy + 37); ctx.lineTo(nx, ny); ctx.strokeStyle = '#f0f6fc'; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.arc(nx, ny, 5, 0, 2 * Math.PI); ctx.fillStyle = '#f0f6fc'; ctx.fill();
  ctx.fillStyle = '#f0f6fc'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(v, cx, cy + 85); ctx.font = '11px sans-serif'; ctx.fillStyle = '#8b949e';
  ctx.fillText(data.label, cx, cy + 100);
  document.querySelector('.fear-value').textContent = data.label;
  document.querySelector('.fear-label').textContent = `Index: ${v}`;
  document.querySelector('.fear-prev').textContent = `Previous: ${data.previous_close || '--'}`;
  document.getElementById('fearBarFill').style.width = v + '%';
  document.getElementById('fearBarFill').style.background = v < 25 ? '#f85149' : v < 45 ? '#d29922' : v < 55 ? '#8b949e' : v < 75 ? '#58a6ff' : '#3fb950';
}

// ------ helpers ------
const CHART_TOOLTIP = {
  enabled: true,
  backgroundColor: '#1c2333',
  titleColor: '#f0f6fc',
  bodyColor: '#c9d1d9',
  borderColor: '#30363d',
  borderWidth: 1,
  padding: 8,
  cornerRadius: 6,
  displayColors: false,
};

function signal(rsi, change) {
  if (rsi == null) return '<span class="signal-neutral">--</span>';
  if (rsi > 60) return '<span class="signal-sell">Overbought</span>';
  if (rsi < 40) return '<span class="signal-buy">Oversold</span>';
  if (change > 2) return '<span class="signal-buy">Strong Up</span>';
  if (change < -2) return '<span class="signal-sell">Strong Down</span>';
  return '<span class="signal-neutral">Neutral</span>';
}
function signalText(rsi, change) {
  if (rsi == null) return '--';
  if (rsi > 60) return 'Overbought';
  if (rsi < 40) return 'Oversold';
  if (change > 2) return 'Strong Up';
  if (change < -2) return 'Strong Down';
  return 'Neutral';
}
function trendEmoji(t) { return t === 'uptrend' ? '▲' : t === 'downtrend' ? '▼' : '◆' }
function pctColor(v) { return v >= 0 ? 'green' : 'red' }
function fmtPct(v) { return v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '—' }
function spark(prices, w, h) {
  if (!prices || prices.length < 2) return '';
  const min = Math.min(...prices), max = Math.max(...prices), rng = max - min || 1;
  const pts = prices.map((p, i) => `${(i / (prices.length - 1)) * w},${h - ((p - min) / rng) * h * 0.8 - 4}`).join(' ');
  const color = prices[prices.length - 1] >= prices[0] ? '#3fb950' : '#f85149';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
}

function sortData(arr, col, dir) {
  return [...arr].sort((a, b) => {
    let va = a[col], vb = b[col];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va == null) return 1;
    if (vb == null) return -1;
    return va < vb ? -dir : va > vb ? dir : 0;
  });
}

function setupSorting(tableId, stateKey, renderFn) {
  document.querySelectorAll(`#${tableId} th.sortable`).forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      const state = sortState[stateKey];
      state.dir = state.col === col ? -state.dir : 1;
      state.col = col;
      document.querySelectorAll(`#${tableId} th.sortable .sort-arrow`).forEach(a => a.textContent = '');
      const arrow = th.querySelector('.sort-arrow');
      arrow.textContent = state.dir === 1 ? '▲' : '▼';
      renderFn();
    });
  });
}

// ------ render table rows and charts ------
function renderStocks(data) {
  stocks = data.stocks || [];
  const state = sortState.stocks;
  const items = state.col ? sortData(stocks, state.col, state.dir) : stocks;
  document.getElementById('stocksBody').innerHTML = items.map(s =>
    `<tr data-symbol="${s.symbol}" onclick="openDetail('${s.symbol}')">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="sel-stock" value="${s.symbol}" onchange="updateCompareCount()"></td>
      <td>${s.symbol} <span style="font-size:.6rem;color:var(--text3)">${spark(s.prices, 40, 20)}</span></td>
      <td>$${s.price?.toFixed(2)}</td>
      <td class="${pctColor(s.change_pct)}">${fmtPct(s.change_pct)}</td>
      <td>${trendEmoji(s.trend)}</td>
      <td>${signal(s.rsi, s.change_pct)}</td>
    </tr>`
  ).join('');
  document.getElementById('stocksSummary').textContent = `${stocks.length} stocks`;
}

function renderCrypto(data) {
  crypto = data.crypto || [];
  const state = sortState.crypto;
  const items = state.col ? sortData(crypto, state.col, state.dir) : crypto;
  document.getElementById('cryptoBody').innerHTML = items.map(s =>
    `<tr data-symbol="${s.symbol}" onclick="openDetail('${s.symbol}')">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="sel-crypto" value="${s.symbol}" onchange="updateCompareCount()"></td>
      <td>${s.symbol} <span style="font-size:.6rem;color:var(--text3)">${spark(s.prices, 40, 20)}</span></td>
      <td>$${s.price?.toFixed(4)}</td>
      <td class="${pctColor(s.change_pct)}">${fmtPct(s.change_pct)}</td>
      <td>${s.rsi?.toFixed(0) || '--'}</td>
      <td>${signal(s.rsi, s.change_pct)}</td>
    </tr>`
  ).join('');
  document.getElementById('cryptoSummary').textContent = `${crypto.length} assets`;
}

function renderForex(data) {
  forex = data.forex || [];
  const state = sortState.forex;
  const items = state.col ? sortData(forex, state.col, state.dir) : forex;
  document.getElementById('forexBody').innerHTML = items.map(s =>
    `<tr onclick="openDetail('${s.symbol}')">
      <td>${s.pair || s.symbol}</td><td>${s.price?.toFixed(5)}</td>
      <td class="${pctColor(s.change_pct)}">${fmtPct(s.change_pct)}</td>
      <td>${trendEmoji(s.trend)}</td>
    </tr>`
  ).join('');
}

function renderWeekly(data) {
  let combined = [];
  if (data.stocks) combined = combined.concat(data.stocks.filter(s => s.weekly_returns).map(s => ({ symbol: s.symbol, ...s.weekly_returns })));
  if (data.crypto) combined = combined.concat(data.crypto.filter(s => s.weekly_returns).map(s => ({ symbol: s.symbol, ...s.weekly_returns })));
  if (data.forex) combined = combined.concat(data.forex.filter(s => s.weekly_returns).map(s => ({ symbol: s.symbol, ...s.weekly_returns })));
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const body = document.getElementById('weeklyBody');
  if (!combined.length) { body.innerHTML = '<tr><td colspan="7" style="color:var(--text3);text-align:center">No data</td></tr>'; return; }
  body.innerHTML = combined.map(item => {
    const vals = days.map(d => item[d] !== undefined ? item[d] : null);
    const avg = vals.filter(v => v !== null).length ? vals.reduce((a, b) => a + (b || 0), 0) / vals.filter(v => v !== null).length : 0;
    return `<tr><td style="font-weight:600">${item.symbol}</td>${
      vals.map(v => v === null ? '<td class="heat-dark">--</td>' :
        `<td class="${v > 0 ? 'heat-green' : v < 0 ? 'heat-red' : 'heat-dark'}">${v > 0 ? '+' : ''}${v.toFixed(2)}%</td>`).join('')
    }<td class="${avg > 0 ? 'heat-green' : avg < 0 ? 'heat-red' : 'heat-dark'}" style="font-weight:600">${avg > 0 ? '+' : ''}${avg.toFixed(2)}%</td></tr>`
  }).join('');
}

function renderIndicators(data) {
  indicatorsData = data;
  if (!data) return;
  document.getElementById('meterFill').style.width = data.market_strength + '%';
  document.getElementById('meterText').textContent = `${data.market_strength}% - ${data.summary}`;
  document.getElementById('indicatorsGrid').innerHTML = data.indicators.map(ind =>
    `<div class="ind-item"><div class="ind-name">${ind.name}</div><div class="ind-val ${(ind.signal||'').toLowerCase() === 'bullish' ? 'green' : (ind.signal||'').toLowerCase() === 'bearish' ? 'red' : ''}">${ind.value}${ind.signal ? ' (' + ind.signal + ')' : ''}</div></div>`
  ).join('');
}

// ------ main chart renders ------
let stockChart, cryptoChart, forexChart, sectorChart, radarChart;

function renderStockChart(data) {
  const ctx = document.getElementById('stocksChart').getContext('2d');
  if (stockChart) stockChart.destroy();
  const items = data.stocks || [];
  const symbols = items.slice(0, 20).map(s => s.symbol);
  const changes = items.slice(0, 20).map(s => s.change_pct);
  const colors = changes.map(v => v >= 0 ? '#3fb950' : '#f85149');
  stockChart = new Chart(ctx, {
    type: 'bar', data: { labels: symbols, datasets: [{ label: 'Change %', data: changes, backgroundColor: colors, borderRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false }, tooltip: CHART_TOOLTIP },
      scales: { y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 } } },
               x: { grid: { display: false }, ticks: { color: '#8b949e', font: { size: 9 } } } } }
  });
}

function renderCryptoChart(data) {
  const ctx = document.getElementById('cryptoChart').getContext('2d');
  if (cryptoChart) cryptoChart.destroy();
  const items = data.crypto || [];
  const labels = items.map(s => s.symbol);
  const prices = items.map(s => s.price || 0);
  const rsis = items.map(s => s.rsi || 50);
  cryptoChart = new Chart(ctx, {
    type: 'bar', data: { labels, datasets: [
      { label: 'Price', data: prices, backgroundColor: '#58a6ff66', borderRadius: 3, yAxisID: 'y' },
      { label: 'RSI', data: rsis, type: 'line', borderColor: '#d29922', backgroundColor: 'transparent', pointRadius: 2, tension: .3, yAxisID: 'y1' }
    ] },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: '#8b949e', font: { size: 10 } } }, tooltip: CHART_TOOLTIP },
      scales: { y: { position: 'left', grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 9 } } },
               y1: { position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { color: '#d29922', font: { size: 9 } } },
               x: { grid: { display: false }, ticks: { color: '#8b949e', font: { size: 9 } } } } }
  });
}

function renderForexChart(data) {
  const ctx = document.getElementById('forexChart').getContext('2d');
  if (forexChart) forexChart.destroy();
  const items = data.forex || [];
  forexChart = new Chart(ctx, {
    type: 'bar', data: {
      labels: items.map(s => s.pair || s.symbol),
      datasets: [{ label: 'Change %', data: items.map(s => s.change_pct), backgroundColor: items.map(s => s.change_pct >= 0 ? '#3fb95066' : '#f8514966'), borderRadius: 3 }]
    },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false }, tooltip: CHART_TOOLTIP },
      scales: { x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 9 } } },
               y: { grid: { display: false }, ticks: { color: '#8b949e', font: { size: 9 } } } } }
  });
}

function renderSectorChart(data) {
  const stocks = data.stocks || [];
  if (!stocks.length) return;
  const bySector = {};
  stocks.forEach(s => {
    const sec = s.sector || 'Other';
    if (!bySector[sec]) bySector[sec] = [];
    bySector[sec].push(s.change_pct || 0);
  });
  const sectors = Object.keys(bySector);
  const avgChanges = sectors.map(sec => {
    const vals = bySector[sec];
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  });
  const colors = ['#3fb950','#f85149','#58a6ff','#d29922','#bc8cff','#79c0ff','#ff7b72','#8b949e','#3fb95088','#f8514988'];
  const ctx = document.getElementById('sectorChart').getContext('2d');
  if (sectorChart) sectorChart.destroy();
  sectorChart = new Chart(ctx, {
    type: 'bar', data: {
      labels: sectors,
      datasets: [{ label: 'Avg Change %', data: avgChanges, backgroundColor: avgChanges.map((v,i) => colors[i % colors.length]), borderRadius: 3 }]
    },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false }, tooltip: CHART_TOOLTIP },
      scales: { x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 9 } } },
               y: { grid: { display: false }, ticks: { color: '#8b949e', font: { size: 9 } } } } }
  });
}

function renderRadarChart(data) {
  const ind = data.indicators || [];
  if (!ind.length) return;
  const mapSignal = s => (s || '').toLowerCase() === 'bullish' ? 100 : (s || '').toLowerCase() === 'bearish' ? 0 : 50;
  const ctx = document.getElementById('radarChart').getContext('2d');
  if (radarChart) radarChart.destroy();
  radarChart = new Chart(ctx, {
    type: 'radar', data: {
      labels: ind.map(i => i.name.replace(/^SPY /, '')),
      datasets: [{ label: 'Signal', data: ind.map(i => mapSignal(i.signal)), backgroundColor: '#58a6ff22', borderColor: '#58a6ff', pointBackgroundColor: '#58a6ff', pointRadius: 3 }]
    },
    options: { responsive: true, maintainAspectRatio: true, scales: { r: { min: 0, max: 100, ticks: { display: false }, grid: { color: '#21262d' }, angleLines: { color: '#21262d' } } },
      plugins: { legend: { display: false }, tooltip: CHART_TOOLTIP } }
  });
}

// ------ correlation matrix ------
async function renderCorrelation() {
  try {
    const r = await fetch('/api/correlation');
    const data = await r.json();
    if (!data.pairs || !data.symbols) return;
    const syms = data.symbols;
    const matrix = {};
    syms.forEach(s => matrix[s] = {});
    data.pairs.forEach(p => { matrix[p.a][p.b] = p.correlation; matrix[p.b][p.a] = p.correlation; });
    let html = '<table><thead><tr><th></th>';
    syms.forEach(s => { html += `<th>${s}</th>`; });
    html += '</tr></thead><tbody>';
    syms.forEach(s => {
      html += `<tr><th>${s}</th>`;
      syms.forEach(s2 => {
        if (s === s2) { html += '<td class="corr-none">1</td>'; return; }
        const v = matrix[s]?.[s2];
        if (v == null) { html += '<td class="corr-none">--</td>'; return; }
        const absv = Math.abs(v);
        const cls = absv > 0.7 ? 'corr-high' : absv > 0.4 ? 'corr-med' : absv > 0.2 ? 'corr-low' : 'corr-none';
        html += `<td class="${cls}">${v.toFixed(2)}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('correlationGrid').innerHTML = html;
  } catch {}
}

// ------ portfolio ------
function renderPortfolio() {
  portfolio = ls('portfolio') || [];
  const all = [...(stocks || []), ...(crypto || []), ...(forex || [])];
  let totalValue = 0, totalCost = 0;
  const rows = portfolio.map((h, idx) => {
    const item = all.find(a => a.symbol === h.symbol);
    const current = item?.price || 0;
    const value = current * h.qty;
    const cost = h.avg_cost * h.qty;
    const pl = value - cost;
    const ret = cost > 0 ? (pl / cost) * 100 : 0;
    totalValue += value;
    totalCost += cost;
    return `<tr>
      <td>${h.symbol}</td><td>${h.qty}</td><td>$${h.avg_cost.toFixed(2)}</td>
      <td class="${pctColor(current - h.avg_cost)}">$${current.toFixed(2)}</td>
      <td>$${value.toFixed(2)}</td>
      <td class="${pl >= 0 ? 'green' : 'red'}">${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}</td>
      <td class="${ret >= 0 ? 'green' : 'red'}">${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%</td>
      <td><button class="wl-remove" onclick="removePortfolio(${idx})">✕</button></td>
    </tr>`;
  }).join('');
  const totalPl = totalValue - totalCost;
  const totalRet = totalCost > 0 ? (totalPl / totalCost) * 100 : 0;
  document.getElementById('portfolioBody').innerHTML = rows + `<tr style="font-weight:600;border-top:2px solid var(--border)"><td>TOTAL</td><td></td><td>$${totalCost.toFixed(2)}</td><td></td><td>$${totalValue.toFixed(2)}</td><td class="${totalPl >= 0 ? 'green' : 'red'}">${totalPl >= 0 ? '+' : ''}$${totalPl.toFixed(2)}</td><td class="${totalRet >= 0 ? 'green' : 'red'}">${totalRet >= 0 ? '+' : ''}${totalRet.toFixed(2)}%</td><td></td></tr>`;
}

function addPortfolio() {
  const sym = document.getElementById('portSymbol').value.trim().toUpperCase();
  const qty = parseFloat(document.getElementById('portQty').value);
  const cost = parseFloat(document.getElementById('portPrice').value);
  if (!sym || isNaN(qty) || isNaN(cost)) return;
  portfolio = ls('portfolio') || [];
  const existing = portfolio.find(h => h.symbol === sym);
  if (existing) {
    existing.qty += qty;
    existing.avg_cost = (existing.avg_cost * existing.qty + cost * qty) / (existing.qty + qty);
  } else {
    portfolio.push({ symbol: sym, qty, avg_cost: cost });
  }
  ls('portfolio', portfolio);
  document.getElementById('portSymbol').value = '';
  document.getElementById('portQty').value = '';
  document.getElementById('portPrice').value = '';
  renderPortfolio();
}
function removePortfolio(idx) {
  portfolio = ls('portfolio') || [];
  portfolio.splice(idx, 1);
  ls('portfolio', portfolio);
  renderPortfolio();
}

document.getElementById('portAddBtn').addEventListener('click', addPortfolio);

// ------ detail modal ------
async function openDetail(symbol) {
  currentSymbol = symbol;
  currentTimeframe = '3mo';
  document.getElementById('modalOverlay').style.display = 'flex';
  document.getElementById('modalTitle').textContent = symbol;
  document.getElementById('modalSub').textContent = 'Loading...';
  detailCharts = {};
  detailData = null;
  document.getElementById('modalPred').innerHTML = '';
  document.getElementById('divergenceAlerts').innerHTML = '';
  document.getElementById('newsList').innerHTML = 'Loading...';
  document.querySelectorAll('#timeframeBar button').forEach(b => b.classList.toggle('active', b.dataset.tf === '3mo'));
  await loadDetail(symbol, currentTimeframe);
}

async function loadDetail(symbol, timeframe) {
  try {
    const r = await fetch(`/api/detail?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`);
    const data = await r.json();
    if (data.error) { document.getElementById('modalSub').textContent = data.error; return; }
    ['detailPriceChart','detailRsiChart','detailMacdChart','detailVolumeChart'].forEach(id => {
      const c = document.getElementById(id);
      if (c && c.parentNode) { const n = document.createElement('canvas'); n.id = id; c.replaceWith(n); }
    });
    detailData = data;
    document.getElementById('modalSub').textContent = `$${data.price?.toFixed(2)} | ${fmtPct(data.change_pct)} | ${data.currency}`;
    document.getElementById('modalStats').innerHTML = `
      <div>RSI: ${data.rsi?.toFixed(1) || '--'}</div>
      <div>Volatility: ${data.volatility?.toFixed(2) || '--'}%</div>
      <div>Support: $${data.support?.toFixed(2) || '--'}</div>
      <div>Resistance: $${data.resistance?.toFixed(2) || '--'}</div>
      <div>Trend: ${data.trend || '--'}</div>
      <div>Trend Str: ${data.trend_strength || '--'}</div>`;

    if (data.divergences && data.divergences.length) {
      document.getElementById('divergenceAlerts').innerHTML =
        data.divergences.map(d => `<div class="div-alert ${d.type}">${d.message}</div>`).join('');
    }

    if (data.prediction) {
      document.getElementById('modalPred').innerHTML =
        `<div class="pred-card"><div class="p-label">Next Day</div><div class="p-val ${data.prediction.next_day >= data.price ? 'green' : 'red'}">$${data.prediction.next_day?.toFixed(2) || '--'}</div></div>
         <div class="pred-card"><div class="p-label">Direction</div><div class="p-val ${data.prediction.direction === 'up' ? 'green' : 'red'}">${data.prediction.direction?.toUpperCase() || '--'}</div></div>
         <div class="pred-card"><div class="p-label">Confidence</div><div class="p-val">${(Math.abs(data.prediction.confidence || 0) * 100).toFixed(0)}%</div></div>`;
    }

    renderDetailPriceChart(data);
    renderDetailRsiChart(data);
    renderDetailMacdChart(data);
    renderDetailVolumeChart(data);
    fetchNews(symbol);
  } catch (e) {
    document.getElementById('modalSub').textContent = 'Error loading detail';
  }
}

// timeframe switching
document.getElementById('timeframeBar').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn || !btn.dataset.tf) return;
  document.querySelectorAll('#timeframeBar button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentTimeframe = btn.dataset.tf;
  if (currentSymbol) await loadDetail(currentSymbol, currentTimeframe);
});

function renderDetailPriceChart(data) {
  const ctx = document.getElementById('detailPriceChart').getContext('2d');
  const prices = data.prices || [];
  const labels = data.dates || [];
  const bbUpper = data.bb_upper || [], bbMiddle = data.bb_middle || [], bbLower = data.bb_lower || [];
  const pred = data.prediction || {};
  const nextDay = pred.next_day;
  if (!prices.length) return;
  const extLabels = nextDay ? [...labels, 'Next'] : labels;
  const extPrices = nextDay ? [...prices, nextDay] : prices;
  detailCharts.price = new Chart(ctx, {
    type: 'line', data: {
      labels: extLabels,
      datasets: [
        { label: 'BB Upper', data: [...bbUpper, null], borderColor: '#8b949e44', borderDash: [3,3], pointRadius: 0, fill: false },
        { label: 'BB Middle', data: [...bbMiddle, null], borderColor: '#8b949e44', pointRadius: 0, fill: false },
        { label: 'BB Lower', data: [...bbLower, null], borderColor: '#8b949e44', borderDash: [3,3], pointRadius: 0, fill: false },
        { label: 'Price', data: extPrices, borderColor: '#58a6ff', backgroundColor: '#58a6ff22', fill: true, pointRadius: 1, tension: .2 },
      ]
    },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: '#8b949e', font: { size: 9 } } }, tooltip: CHART_TOOLTIP },
      scales: { y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 9 } } },
               x: { grid: { display: false }, ticks: { color: '#8b949e', font: { size: 8 }, maxTicksLimit: 10 } } } }
  });
}

function renderDetailRsiChart(data) {
  const ctx = document.getElementById('detailRsiChart').getContext('2d');
  const vals = data.rsi_history || [];
  if (!vals.length) return;
  detailCharts.rsi = new Chart(ctx, {
    type: 'line', data: {
      labels: Array(vals.length).fill(''),
      datasets: [
        { label: 'RSI', data: vals, borderColor: '#d29922', pointRadius: 0, tension: .3 },
        { label: 'Overbought', data: Array(vals.length).fill(70), borderColor: '#f8514944', pointRadius: 0, borderDash: [3,3], fill: false },
        { label: 'Oversold', data: Array(vals.length).fill(30), borderColor: '#3fb95044', pointRadius: 0, borderDash: [3,3], fill: false },
      ]
    },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: '#8b949e', font: { size: 8 } } }, tooltip: CHART_TOOLTIP },
      scales: { y: { min: 0, max: 100, grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 8 } } },
               x: { grid: { display: false }, ticks: { display: false } } } }
  });
}

function renderDetailMacdChart(data) {
  const ctx = document.getElementById('detailMacdChart').getContext('2d');
  const macd = data.macd || [], signal = data.macd_signal || [];
  if (!macd.length) return;
  const hist = macd.map((m, i) => m - (signal[i] || 0));
  detailCharts.macd = new Chart(ctx, {
    type: 'bar', data: {
      labels: Array(macd.length).fill(''),
      datasets: [
        { label: 'MACD', data: macd, type: 'line', borderColor: '#58a6ff', pointRadius: 0, tension: .3 },
        { label: 'Signal', data: signal, type: 'line', borderColor: '#d29922', pointRadius: 0, tension: .3 },
        { label: 'Histogram', data: hist, backgroundColor: hist.map(h => h >= 0 ? '#3fb95066' : '#f8514966'), borderRadius: 1 },
      ]
    },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: '#8b949e', font: { size: 8 } } }, tooltip: CHART_TOOLTIP },
      scales: { y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 8 } } },
               x: { grid: { display: false }, ticks: { display: false } } } }
  });
}

function renderDetailVolumeChart(data) {
  const ctx = document.getElementById('detailVolumeChart').getContext('2d');
  const volumes = data.volumes || [];
  if (!volumes.length) return;
  detailCharts.volume = new Chart(ctx, {
    type: 'bar', data: {
      labels: Array(volumes.length).fill(''),
      datasets: [{ label: 'Volume', data: volumes, backgroundColor: volumes.map((v, i) => i > 0 && volumes[i] > volumes[i-1] ? '#3fb95044' : '#f8514944'), borderRadius: 1 }]
    },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false }, tooltip: CHART_TOOLTIP },
      scales: { y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 8 } } },
               x: { grid: { display: false }, ticks: { display: false } } } }
  });
}

async function fetchNews(symbol) {
  try {
    const r = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}`);
    const data = await r.json();
    if (!data.articles || !data.articles.length) {
      document.getElementById('newsList').innerHTML = '<span style="color:var(--text3)">No news</span>';
      return;
    }
    document.getElementById('newsList').innerHTML = data.articles.map(a =>
      `<div class="news-item"><div class="news-title"><a href="${a.link}" target="_blank">${a.title}</a></div><div class="news-meta">${a.publisher} · ${new Date(a.timestamp).toLocaleDateString()}</div></div>`
    ).join('');
  } catch { document.getElementById('newsList').innerHTML = '<span style="color:var(--text3)">Error loading news</span>'; }
}

// ------ compare ------
document.getElementById('compareStocksBtn').addEventListener('click', openCompare);
document.getElementById('compareClose').addEventListener('click', () => document.getElementById('compareOverlay').style.display = 'none');

function updateCompareCount() {
  const checked = document.querySelectorAll('.sel-stock:checked, .sel-crypto:checked');
  document.getElementById('compareStocksBtn').textContent = `Compare Selected (${checked.length})`;
}

function openCompare() {
  const checked = document.querySelectorAll('.sel-stock:checked, .sel-crypto:checked');
  const symbols = Array.from(checked).map(c => c.value);
  if (symbols.length < 2) { alert('Select at least 2 assets'); return; }
  document.getElementById('compareOverlay').style.display = 'flex';
  document.getElementById('compareSymbolsList').textContent = symbols.join(' · ');
  loadCompareChart(symbols);
}

async function loadCompareChart(symbols) {
  const ctx = document.getElementById('compareChart').getContext('2d');
  if (compareChartInstance) compareChartInstance.destroy();
  try {
    const r = await fetch(`/api/compare?symbols=${symbols.join(',')}`);
    const data = await r.json();
    if (!data.symbols || !data.symbols.length) { return; }
    const colors = ['#3fb950','#f85149','#58a6ff','#d29922','#bc8cff','#79c0ff','#ff7b72','#8b949e'];
    const datasets = data.symbols.map((s, i) => ({
      label: s.symbol,
      data: s.returns || [],
      borderColor: colors[i % colors.length],
      backgroundColor: 'transparent',
      pointRadius: 0,
      tension: .2
    }));
    compareChartInstance = new Chart(ctx, {
      type: 'line', data: { labels: Array((data.symbols[0]?.returns || []).length).fill(''), datasets },
      options: { responsive: true, maintainAspectRatio: true,
        plugins: { legend: { labels: { color: '#8b949e', font: { size: 9 } } }, tooltip: CHART_TOOLTIP },
        scales: { y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 9 } } },
                 x: { grid: { display: false }, ticks: { display: false } } } }
    });
  } catch { }
}

// ------ csv export ------
document.getElementById('csvExportBtn').addEventListener('click', () => {
  if (!detailData) return;
  const d = detailData;
  const rows = [['Date','Price','Volume','RSI','BB_Upper','BB_Middle','BB_Lower']];
  (d.dates || []).forEach((date, i) => {
    rows.push([date, d.prices?.[i] ?? '', d.volumes?.[i] ?? '', d.rsi_history?.[i] ?? '', d.bb_upper?.[i] ?? '', d.bb_middle?.[i] ?? '', d.bb_lower?.[i] ?? '']);
  });
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${d.symbol || 'data'}_detail.csv`; a.click();
  URL.revokeObjectURL(url);
});

// ------ pdf export ------
document.getElementById('pdfExportBtn').addEventListener('click', () => {
  window.print();
});

// ------ search/add symbol ------
document.getElementById('searchBtn').addEventListener('click', addSymbol);
document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') addSymbol(); });

async function addSymbol() {
  const input = document.getElementById('searchInput');
  const symbol = input.value.trim().toUpperCase();
  if (!symbol) return;
  let wl = ls('watchlist') || [];
  if (wl.includes(symbol)) { input.value = ''; return; }
  wl.push(symbol);
  ls('watchlist', wl);
  input.value = '';
  renderWatchlist();
  await refreshData();
}

async function removeSymbol(sym) {
  let wl = ls('watchlist') || [];
  wl = wl.filter(s => s !== sym);
  ls('watchlist', wl);
  renderWatchlist();
  await refreshData();
}

// ------ watchlist ------
function renderWatchlist() {
  const wl = ls('watchlist') || [];
  document.getElementById('watchlistBadge').textContent = wl.length;
  const all = [...(stocks || []), ...(crypto || []), ...(forex || [])];
  const rows = wl.map(sym => {
    const item = all.find(a => a.symbol === sym);
    if (!item) return `<tr><td>${sym}</td><td colspan="4" style="color:var(--text3)">--</td><td><button class="wl-remove" onclick="event.stopPropagation();removeSymbol('${sym}')">✕</button></td></tr>`;
    return `<tr onclick="openDetail('${item.symbol}')">
      <td>${item.symbol}</td><td>$${item.price?.toFixed(2)}</td>
      <td class="${pctColor(item.change_pct)}">${fmtPct(item.change_pct)}</td>
      <td>${item.rsi?.toFixed(0) || '--'}</td>
      <td>${signal(item.rsi || 50, item.change_pct)}</td>
      <td><button class="wl-remove" onclick="event.stopPropagation();removeSymbol('${item.symbol}')">✕</button></td>
    </tr>`;
  }).join('');
  document.getElementById('watchlistBody').innerHTML = rows || '<tr><td colspan="6" style="color:var(--text3);text-align:center">Add symbols using the search bar</td></tr>';
}

// ------ alerts ------
document.getElementById('alertAddBtn').addEventListener('click', addAlert);
document.getElementById('alertClearBtn').addEventListener('click', () => { ls('alerts', []); renderAlerts(); });
document.getElementById('alertPrice').addEventListener('keydown', e => { if (e.key === 'Enter') addAlert(); });

function addAlert() {
  const sym = document.getElementById('alertSymbol').value.trim().toUpperCase();
  const cond = document.getElementById('alertCondition').value;
  const price = parseFloat(document.getElementById('alertPrice').value);
  if (!sym || isNaN(price)) return;
  let alerts = ls('alerts') || [];
  alerts.push({ symbol: sym, condition: cond, price, id: Date.now() });
  ls('alerts', alerts);
  document.getElementById('alertSymbol').value = '';
  document.getElementById('alertPrice').value = '';
  renderAlerts();
}

function removeAlert(id) {
  let alerts = ls('alerts') || [];
  alerts = alerts.filter(a => a.id !== id);
  ls('alerts', alerts);
  renderAlerts();
}

function renderAlerts() {
  const alerts = ls('alerts') || [];
  document.getElementById('alertBadge').textContent = alerts.length;
  document.getElementById('alertList').innerHTML = alerts.map(a =>
    `<div class="alert-item"><span>${a.symbol} ${a.condition === 'above' ? '>' : '<'} $${a.price}</span><button onclick="removeAlert(${a.id})">✕</button></div>`
  ).join('');
}

const _alertFired = new Set();
function checkAlerts() {
  const alerts = ls('alerts') || [];
  if (!alerts.length || !stocks.length && !crypto.length) return;
  const all = [...(stocks || []), ...(crypto || []), ...(forex || [])];
  alerts.forEach(a => {
    const item = all.find(x => x.symbol === a.symbol);
    if (!item || item.price === undefined) return;
    const triggered = a.condition === 'above' ? item.price > a.price : item.price < a.price;
    if (triggered && !_alertFired.has(a.id)) {
      _alertFired.add(a.id);
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(`Price Alert: ${a.symbol}`, { body: `${a.symbol} is ${a.condition === 'above' ? 'above' : 'below'} $${a.price} (currently $${item.price.toFixed(2)})` });
      }
    }
    if (!triggered) _alertFired.delete(a.id);
  });
}

// ------ modal close ------
document.getElementById('modalOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) document.getElementById('modalOverlay').style.display = 'none'; });
document.getElementById('modalClose').addEventListener('click', () => document.getElementById('modalOverlay').style.display = 'none');
document.getElementById('compareOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) document.getElementById('compareOverlay').style.display = 'none'; });

// select all
document.getElementById('selectAllStocks').addEventListener('change', function() {
  document.querySelectorAll('.sel-stock').forEach(c => c.checked = this.checked);
  updateCompareCount();
});
document.getElementById('selectAllCrypto').addEventListener('change', function() {
  document.querySelectorAll('.sel-crypto').forEach(c => c.checked = this.checked);
  updateCompareCount();
});

// ------ refresh ------
async function refreshData() {
  document.getElementById('updateBadge').textContent = 'updating...';
  document.getElementById('updateBadge').className = 'update-badge';
  try {
    const endpoints = ['/api/fear-greed', '/api/stocks', '/api/crypto', '/api/forex', '/api/indicators'];
    const results = await Promise.allSettled(endpoints.map(e => fetch(e).then(r => r.json())));
    const [fgData, stocksData, cryptoData, forexData, indData] = results.map(r => r.status === 'fulfilled' ? r.value : {});
    if (fgData.value) { fg = fgData; renderFearGreed(fgData); }
    if (stocksData.stocks) { stocks = stocksData.stocks; renderStockChart(stocksData); renderStocks(stocksData); renderSectorChart(stocksData); }
    if (cryptoData.crypto) { crypto = cryptoData.crypto; renderCryptoChart(cryptoData); renderCrypto(cryptoData); }
    if (forexData.forex) { forex = forexData.forex; renderForexChart(forexData); renderForex(forexData); }
    if (indData.indicators) { indicatorsData = indData; renderRadarChart(indData); renderIndicators(indData); }
    renderOverview(stocks, crypto, fg, indicatorsData);
    renderWatchlist();
    renderWeekly({ stocks, crypto, forex });
    renderPortfolio();
    checkAlerts();

    document.getElementById('updateBadge').textContent = new Date().toLocaleTimeString();
    document.getElementById('updateBadge').className = 'update-badge ok';
    document.querySelectorAll('.skeleton').forEach(el => el.classList.remove('skeleton'));
    document.querySelectorAll('.skeleton-line').forEach(el => el.classList.remove('skeleton-line'));
    document.querySelectorAll('.skeleton-inline').forEach(el => el.classList.remove('skeleton-inline'));
  } catch (e) {
    document.getElementById('updateBadge').textContent = 'error';
    document.getElementById('updateBadge').className = 'update-badge error';
  }
}

// notification permission
if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

// init
initTheme();
setupSorting('stocksTable', 'stocks', () => renderStocks({ stocks }));
setupSorting('cryptoTable', 'crypto', () => renderCrypto({ crypto }));
setupSorting('forexTable', 'forex', () => renderForex({ forex }));
renderAlerts();
renderWatchlist();
renderPortfolio();
refreshData();
renderCorrelation();
setInterval(refreshData, 30000);
setInterval(renderCorrelation, 300000);
