"use strict";

/* ============================================================
 * app.js — gọi backend /api/* khi deploy Render;
 * fallback phân tích client-side nếu không có API (GitHub Pages).
 * ============================================================ */

const state = {
  chart: null,
  series: null,
  priceLines: [],
  extraSeries: [],
  watchlist: [],
  currentSymbol: null,
  scanSeq: 0,
  cache: new Map(),
  hasApi: null, // null = chưa biết
  symbolInfo: {},
};

const $ = (id) => document.getElementById(id);
const symbolSelect = $("symbolSelect");
const intervalSelect = $("intervalSelect");
const cycleSelect = $("cycleSelect");
const btnScan = $("btnScan");
const btnScanAll = $("btnScanAll");
const btnPretty = $("btnPretty");
const statusBar = $("statusBar");
const setupsList = $("setupsList");
const prettyList = $("prettyList");
const watchList = $("watchList");
const chartInfo = $("chartInfo");
const chartContainer = $("chartContainer");
const assetBadge = $("assetBadge");

const SYMBOL_META = [
  { t: "EURUSD=X", name: "EUR/USD", sub: "Euro / US Dollar", cat: "Ngoại hối", unit: "pip" },
  { t: "GBPUSD=X", name: "GBP/USD", sub: "British Pound / US Dollar", cat: "Ngoại hối", unit: "pip" },
  { t: "USDJPY=X", name: "USD/JPY", sub: "US Dollar / Japanese Yen", cat: "Ngoại hối", unit: "pip" },
  { t: "AUDUSD=X", name: "AUD/USD", sub: "Australian Dollar / US Dollar", cat: "Ngoại hối", unit: "pip" },
  { t: "USDCAD=X", name: "USD/CAD", sub: "US Dollar / Canadian Dollar", cat: "Ngoại hối", unit: "pip" },
  { t: "USDCHF=X", name: "USD/CHF", sub: "US Dollar / Swiss Franc", cat: "Ngoại hối", unit: "pip" },
  { t: "GC=F", name: "Vàng giao sau", sub: "XAUUSD · Gold Futures", cat: "Kim loại", unit: "USD/oz" },
  { t: "SI=F", name: "Bạc giao sau", sub: "XAGUSD · Silver Futures", cat: "Kim loại", unit: "USD/oz" },
  { t: "HG=F", name: "Đồng giao sau", sub: "Copper Futures", cat: "Kim loại", unit: "USD/lb" },
  { t: "CL=F", name: "Dầu thô WTI", sub: "WTI Crude Oil", cat: "Năng lượng", unit: "USD/bbl" },
  { t: "BZ=F", name: "Dầu Brent", sub: "Brent Crude", cat: "Năng lượng", unit: "USD/bbl" },
  { t: "NG=F", name: "Khí tự nhiên", sub: "Natural Gas", cat: "Năng lượng", unit: "USD/MMBtu" },
  { t: "BTC-USD", name: "Bitcoin", sub: "BTC/USD", cat: "Tiền mã hoá", unit: "USD" },
  { t: "ETH-USD", name: "Ethereum", sub: "ETH/USD", cat: "Tiền mã hoá", unit: "USD" },
  { t: "XRP-USD", name: "Ripple", sub: "XRP/USD", cat: "Tiền mã hoá", unit: "USD" },
  { t: "SOL-USD", name: "Solana", sub: "SOL/USD", cat: "Tiền mã hoá", unit: "USD" },
  { t: "ADA-USD", name: "Cardano", sub: "ADA/USD", cat: "Tiền mã hoá", unit: "USD" },
  { t: "^DJI", name: "Dow Jones 30", sub: "US30 / DJIA", cat: "Chỉ số", unit: "đ" },
  { t: "^IXIC", name: "Nasdaq Composite", sub: "US100 / NASDAQ", cat: "Chỉ số", unit: "đ" },
  { t: "^GSPC", name: "S&P 500", sub: "SPX", cat: "Chỉ số", unit: "đ" },
  { t: "^N225", name: "Nikkei 225", sub: "JP225", cat: "Chỉ số", unit: "đ" },
  { t: "^VIX", name: "VIX", sub: "Volatility Index", cat: "Chỉ số", unit: "đ" },
  { t: "AAPL", name: "Apple Inc.", sub: "AAPL", cat: "Cổ phiếu", unit: "USD" },
  { t: "TSLA", name: "Tesla Inc.", sub: "TSLA", cat: "Cổ phiếu", unit: "USD" },
  { t: "NVDA", name: "NVIDIA Corp.", sub: "NVDA", cat: "Cổ phiếu", unit: "USD" },
  { t: "MSFT", name: "Microsoft Corp.", sub: "MSFT", cat: "Cổ phiếu", unit: "USD" },
  { t: "AMZN", name: "Amazon.com Inc.", sub: "AMZN", cat: "Cổ phiếu", unit: "USD" },
];
SYMBOL_META.forEach((s) => { state.symbolInfo[s.t] = s; });

function metaOf(ticker) {
  return state.symbolInfo[ticker] || { t: ticker, name: ticker, sub: "", cat: "Khác", unit: "" };
}

function setStatus(msg, kind) {
  statusBar.textContent = msg;
  statusBar.className = "status-bar" + (kind ? " " + kind : "");
}

function fmt(n, digits) {
  return WS_IND.fmtPrice(n, digits);
}

async function apiAvailable() {
  if (state.hasApi !== null) return state.hasApi;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch("/api/settings", { signal: ctrl.signal });
    clearTimeout(t);
    state.hasApi = r.ok;
  } catch (e) {
    state.hasApi = false;
  }
  return state.hasApi;
}

/* ======================================================= chart */
function initChart() {
  if (typeof LightweightCharts === "undefined") {
    chartContainer.innerHTML =
      '<div class="chart-error">Không tải được thư viện biểu đồ. Hãy tải lại trang (Ctrl+F5).</div>';
    return false;
  }
  state.chart = LightweightCharts.createChart(chartContainer, {
    layout: { background: { type: "solid", color: "#ffffff" }, textColor: "#1f2937", fontSize: 12 },
    grid: { vertLines: { color: "#eef1f5" }, horzLines: { color: "#eef1f5" } },
    rightPriceScale: { borderColor: "#e5e7eb", scaleMargins: { top: 0.12, bottom: 0.12 } },
    timeScale: { borderColor: "#e5e7eb", timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    width: chartContainer.clientWidth,
    height: chartContainer.clientHeight || 520,
  });
  state.series = state.chart.addCandlestickSeries({
    upColor: "#16a34a",
    downColor: "#dc2626",
    wickUpColor: "#16a34a",
    wickDownColor: "#dc2626",
    borderVisible: false,
  });
  const ro = new ResizeObserver(() => {
    if (!state.chart) return;
    state.chart.applyOptions({
      width: chartContainer.clientWidth,
      height: chartContainer.clientHeight || 520,
    });
  });
  ro.observe(chartContainer);
  return true;
}

function clearOverlays() {
  state.priceLines.forEach((l) => {
    try { state.series.removePriceLine(l); } catch (e) {}
  });
  state.priceLines = [];
  state.extraSeries.forEach((s) => {
    try { state.chart.removeSeries(s); } catch (e) {}
  });
  state.extraSeries = [];
}

function addLine(price, color, style, title, width) {
  if (price == null || !isFinite(Number(price))) return;
  try {
    state.priceLines.push(
      state.series.createPriceLine({
        price: Number(price),
        color,
        lineWidth: width || 1,
        lineStyle: style,
        axisLabelVisible: true,
        title,
      })
    );
  } catch (e) {}
}

function addTrendline(line, color, title) {
  if (!line || !line.x1_ts || !line.x2_ts) return;
  const broken = !!line.broken;
  try {
    const s = state.chart.addLineSeries({
      color: broken ? color + "80" : color,
      lineWidth: broken ? 1 : 2,
      lineStyle: broken ? LightweightCharts.LineStyle.Dashed : LightweightCharts.LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      title: broken ? title + " — đã bị phá" : title,
    });
    s.setData([
      { time: line.x1_ts, value: Number(line.y1) },
      { time: line.x2_ts, value: Number(line.y_end) },
    ]);
    state.extraSeries.push(s);
  } catch (e) {}
}

function toChartData(candles) {
  const out = [];
  let last = 0;
  (candles || []).forEach((c) => {
    const rawT = c.t != null ? c.t : c.time;
    let sec = typeof rawT === "number" ? (rawT > 1e11 ? Math.floor(rawT / 1000) : Math.floor(rawT)) : null;
    if (!sec || sec <= last) return;
    last = sec;
    out.push({
      time: sec,
      open: Number(c.o != null ? c.o : c.open),
      high: Number(c.h != null ? c.h : c.high),
      low: Number(c.l != null ? c.l : c.low),
      close: Number(c.c != null ? c.c : c.close),
    });
  });
  return out;
}

function drawChart(data) {
  if (!state.chart) return;
  const bars = toChartData(data.candles);
  clearOverlays();
  try { state.series.setMarkers([]); } catch (e) {}

  try {
    const ps = state.series.priceScale();
    if (ps && ps.applyOptions) ps.applyOptions({ autoScale: true });
  } catch (e) {}
  try { state.chart.priceScale("right").applyOptions({ autoScale: true }); } catch (e) {}

  if (!bars.length) {
    chartInfo.textContent = "Không có dữ liệu nến để vẽ.";
    return;
  }

  state.series.setData(bars);
  const dashed = LightweightCharts.LineStyle.Dashed;
  const solid = LightweightCharts.LineStyle.Solid;

  (data.supports || []).forEach((p) => addLine(p, "#16a34a", dashed, "Low / Hỗ trợ"));
  (data.resistances || []).forEach((p) => addLine(p, "#dc2626", dashed, "High / Kháng"));
  if (data.support_trendline) addTrendline(data.support_trendline, "#2563eb", "Đường dưới wedge");
  if (data.resistance_trendline) addTrendline(data.resistance_trendline, "#f97316", "Đường trên wedge");

  if (data.kijun && data.kijun.length) {
    const kPts = [];
    for (let i = 0; i < data.candles.length; i++) {
      const k = data.kijun[i];
      const c = data.candles[i];
      if (k == null || !c) continue;
      const sec = Math.floor((c.t != null ? c.t : c.time) / 1000);
      if (sec > (kPts.length ? kPts[kPts.length - 1].time : 0)) {
        kPts.push({ time: sec, value: Number(k) });
      }
    }
    if (kPts.length > 1) {
      try {
        const ks = state.chart.addLineSeries({
          color: "#f59e0b",
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          title: "Kijun H4",
        });
        ks.setData(kPts);
        state.extraSeries.push(ks);
      } catch (e) {}
    }
  }

  (data.setups || []).forEach((s) => {
    addLine(s.entry, "#2563eb", solid, "Entry " + s.type, 2);
    addLine(s.sl, "#dc2626", dashed, "SL " + s.type);
    addLine(s.tp, "#16a34a", dashed, "TP " + s.type);
  });

  // markers từ patterns nếu server gửi kèm (optional)
  const markers = [];
  if (data._markers) {
    data._markers.forEach((m) => markers.push(m));
  } else if (data.patterns && data.patterns.length && data.candles) {
    // fallback nhẹ: không có index pattern → bỏ qua markers chi tiết
  }
  if (markers.length) {
    markers.sort((a, b) => a.time - b.time);
    try { state.series.setMarkers(markers); } catch (e) {}
  }

  state.chart.timeScale().fitContent();
  try { state.chart.priceScale("right").applyOptions({ autoScale: true }); } catch (e) {}

  chartInfo.innerHTML =
    "<strong>" + data.name + "</strong> · " + data.sub + " · " + data.interval +
    " · Giá: <strong>" + fmt(data.current_price) + " " + (data.unit || "") + "</strong>" +
    (data.rsi != null ? " · RSI " + data.rsi : "") +
    " · " + bars.length + " nến";
}

function renderBadge(data) {
  assetBadge.innerHTML =
    '<span class="badge-cat">' + (data.cat || "—") + "</span>" +
    '<span class="badge-name">' + (data.name || data.symbol) + "</span>" +
    '<span class="badge-sub">' + (data.sub || "") + "</span>" +
    '<span class="badge-ticker">Ticker: ' + (data.symbol || "") + "</span>" +
    '<span class="badge-unit">Đơn vị: ' + (data.unit || "—") + "</span>";
}

/* =========================================================== UI cards */
function checklistHTML(s) {
  const rows = (s.checklist || [])
    .map(
      (c, i) =>
        '<li class="ck-item ' + (c.ok ? "ok" : "no") + '">' +
        '<span class="ck-icon">' + (c.ok ? "✔" : "✘") + "</span>" +
        '<span class="ck-body"><span class="ck-text">' + (i + 1) + ". " + c.text +
        '</span><span class="ck-value">' + c.value + "</span></span></li>"
    )
    .join("");
  return '<ul class="ck-list">' + rows + "</ul>";
}

function gradeCls(g) {
  g = g || "";
  if (g.startsWith("A+")) return "gp";
  if (g.startsWith("A")) return "g";
  if (g.startsWith("B")) return "b";
  if (g.startsWith("C")) return "c";
  return "d";
}

function setupCardHTML(s) {
  const confirmed = !!s.confirmed;
  const side = s.type === "BUY" ? "buy" : "sell";
  const sideCls = confirmed ? side : "";
  const tag = confirmed
    ? s.type === "BUY" ? "▲ MUA (BUY)" : "▼ BÁN (SELL)"
    : s.type === "SELL" ? "◔ CHỜ SELL" : "◔ CHỜ BUY";

  return (
    '<div class="setup-card ' + sideCls + '">' +
    '<div class="setup-head">' +
    '<span class="setup-type ' + sideCls + '">' + tag + "</span>" +
    '<span class="grade ' + gradeCls(s.grade) + '">' + (s.grade || "—") + "</span></div>" +
    '<div class="setup-meta"><span class="setup-source">' + (s.source || "") + "</span>" +
    '<span class="ck-score">' + s.passed + "/" + s.total + " điều kiện · Điểm " + s.score + "/100</span></div>" +
    (s.pattern ? '<div class="pattern-tag">📐 ' + s.pattern + "</div>" : "") +
    '<table class="setup-table">' +
    "<tr><td>Entry</td><td class=\"mono\">" + fmt(s.entry) + "</td></tr>" +
    "<tr><td>Stop Loss</td><td class=\"mono red\">" + fmt(s.sl) + "</td></tr>" +
    "<tr><td>Take Profit</td><td class=\"mono green\">" + fmt(s.tp) + "</td></tr>" +
    "<tr><td>R:R</td><td class=\"mono\"><strong>1 : " + s.rr + "</strong> " +
    (s.rr_ok ? '<span class="rr-ok">✔ ≥1:2</span>' : '<span class="rr-bad">✘ &lt;1:2</span>') +
    "</td></tr></table>" +
    '<div class="ck-title">✅ <span class="step-num">4</span> Hội tụ điều kiện Wedge ' +
    '<span class="step-note-inline">(W1 mẫu hình · W2 breakout · W3 retest · W4 High/Low)</span></div>' +
    checklistHTML(s) +
    '<ul class="reasons">' + (s.reasons || []).map((r) => "<li>" + r + "</li>").join("") + "</ul></div>"
  );
}

function patternBoxHTML(data) {
  if (!data.patterns || !data.patterns.length) return "";
  return (
    '<div class="pattern-box"><strong>Mẫu hình phát hiện:</strong><br>' +
    data.patterns.map((x) => "• " + x.type + " @ " + fmt(x.price) + " (" + x.bias + ") · " + x.score + "đ").join("<br>") +
    "</div>"
  );
}

function trendlineHTML(data) {
  const sup = data.support_trendline;
  const res = data.resistance_trendline;
  if (!sup && !res) return "";
  const row = (L, name, cls) => {
    if (!L) return "";
    const tag = L.broken
      ? '<span class="tl-broken">⚠ ĐÃ BỊ PHÁ</span>'
      : '<span class="tl-live">✔ Còn hiệu lực</span>';
    return (
      '<div class="tl-row ' + cls + '"><span class="tl-name">' + name + "</span>" + tag +
      '<span class="tl-detail">nối biên wedge · hội tụ · từ ' + String(L.from || "").slice(0, 10) + "</span></div>"
    );
  };
  return (
    '<div class="step-block tl-block"><div class="step-head"><span class="step-num">📏</span>' +
    "<span>Đường biên Wedge (đối chiếu chart)</span></div>" +
    row(sup, "Đường dưới", "sup") + row(res, "Đường trên", "res") +
    '<div class="step-note">Hai đường fit qua đỉnh/đáy swing và HỘI TỤ — nến close vượt biên = breakout/breakdown.</div></div>'
  );
}

function levelsHTML(data) {
  // lấy High/Low từ patterns[0] nếu có
  const p = data.patterns && data.patterns[0];
  const s = data.setups && data.setups[0];
  if (!p && !s) return "";
  return (
    '<div class="step-block"><div class="step-head"><span class="step-num">📍</span>' +
    "<span>Mức High / Low của Wedge</span></div>" +
    (p ? '<div class="of-line bad"><b>HIGH</b> ' + fmt(p.price) + " — đỉnh vùng wedge</div>" : "") +
    (p ? '<div class="of-line ok"><b>LOW</b> — đáy vùng wedge (xem levels)</div>' : "") +
    (s
      ? '<div class="of-line sig"><b>Tín hiệu</b> ' + (s.confirmed ? s.type : "CHỜ " + s.type) +
        " · entry " + fmt(s.entry) + " · SL " + fmt(s.sl) +
        (s.reasons && s.reasons[2] ? " · " + s.reasons[2] : "") + "</div>"
      : '<div class="of-line warn"><b>Tín hiệu</b> chưa có setup trên khung này</div>') +
    "</div>"
  );
}

function renderSetups(data) {
  setupsList.innerHTML = "";
  [trendlineHTML(data), levelsHTML(data)].forEach((html) => {
    if (!html) return;
    const d = document.createElement("div");
    d.innerHTML = html;
    if (d.firstElementChild) setupsList.appendChild(d.firstElementChild);
  });

  const setups = data.setups || [];
  if (!setups.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML =
      "Không có setup đạt điều kiện cho mã này ở khung thời gian đã chọn.<br>" +
      "Thử đổi sang khung lớn hơn (4h, 1 ngày) hoặc mã khác.";
    setupsList.appendChild(empty);
  } else {
    setups.forEach((s) => {
      const wrap = document.createElement("div");
      wrap.innerHTML = setupCardHTML(s);
      if (wrap.firstElementChild) setupsList.appendChild(wrap.firstElementChild);
    });
  }

  const pb = document.createElement("div");
  pb.innerHTML = patternBoxHTML(data);
  if (pb.firstElementChild) setupsList.appendChild(pb.firstElementChild);
}

/* ============================================================ load data */
async function fetchScanAPI(ticker, interval) {
  const r = await fetch(
    "/api/scan?symbol=" + encodeURIComponent(ticker) + "&interval=" + encodeURIComponent(interval)
  );
  if (!r.ok) {
    let detail = "HTTP " + r.status;
    try {
      const err = await r.json();
      if (err && err.detail) detail = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
    } catch (e) {}
    throw new Error(detail);
  }
  return r.json();
}

async function fetchScanClient(ticker, interval) {
  const key = ticker + "|" + interval;
  if (state.cache.has(key)) return state.cache.get(key);
  const meta = metaOf(ticker);
  const { candles, source } = await WS_DATA.loadCandles(ticker, interval);
  const kijunArr = WS_WEDGE.kijunH4(candles, interval);
  const analysis = WS_WEDGE.buildAnalysis(candles, ticker, meta.name, meta.sub, meta.cat, interval, kijunArr);
  analysis.source = source;
  analysis.unit = meta.unit;
  state.cache.set(key, analysis);
  return analysis;
}

async function loadAnalysis(ticker, interval) {
  const useApi = await apiAvailable();
  if (useApi) return fetchScanAPI(ticker, interval);
  return fetchScanClient(ticker, interval);
}

async function scanOne(ticker, interval) {
  const seq = ++state.scanSeq;
  state.currentSymbol = ticker;
  const mode = (await apiAvailable()) ? "server" : "client";
  setStatus("Đang phân tích " + ticker + " (" + interval + ") · " + mode + "…", "loading");
  btnScan.disabled = true;
  try {
    const data = await loadAnalysis(ticker, interval);
    if (seq !== state.scanSeq) return;
    renderBadge(data);
    drawChart(data);
    renderSetups(data);
    const n = (data.setups || []).length;
    setStatus(
      "Đã phân tích " + data.name + " · " + interval + " · " + n +
        " setup (" + (data.grade || "—") + ") · " + (data.source || (mode === "server" ? "Render API" : "client")),
      "ok"
    );
    saveSettings();
  } catch (err) {
    if (seq !== state.scanSeq) return;
    setStatus("Lỗi: " + err.message, "error");
    setupsList.innerHTML =
      '<div class="empty">Không lấy được dữ liệu cho ' + ticker + ".<br>" + err.message + "</div>";
    console.error(err);
  } finally {
    if (seq === state.scanSeq) btnScan.disabled = false;
  }
}

async function scanAll() {
  const interval = intervalSelect.value;
  const useApi = await apiAvailable();
  setStatus(
    "Đang quét tất cả mã (" + interval + ") · " + (useApi ? "Render API" : "client") + "…",
    "loading"
  );
  btnScanAll.disabled = true;
  try {
    if (useApi) {
      const r = await fetch("/api/scan-all?interval=" + encodeURIComponent(interval));
      if (!r.ok) throw new Error("HTTP " + r.status);
      const results = await r.json();
      renderScanRows(Object.entries(results).map(([t, d]) => ({ t, d, error: d && d.error })), interval);
      const hits = Object.values(results).filter((d) => d && d.setups && d.setups.length).length;
      setStatus("Đã quét xong " + Object.keys(results).length + " mã · " + hits + " có setup", "ok");
      return;
    }

    const targets = state.watchlist.length ? state.watchlist : SYMBOL_META.map((s) => s.t);
    let done = 0;
    const rows = await Promise.all(
      targets.map(async (t) => {
        try {
          const d = await fetchScanClient(t, interval);
          done++;
          setStatus("Quét " + done + "/" + targets.length + " — " + t + "…", "loading");
          return { t, d, error: null };
        } catch (e) {
          done++;
          return { t, d: null, error: e.message };
        }
      })
    );
    renderScanRows(rows, interval);
    const hits = rows.filter((r) => r.d && r.d.setups && r.d.setups.length).length;
    setStatus("Đã quét xong " + rows.length + " mã · " + hits + " có setup", "ok");
  } catch (err) {
    setStatus("Lỗi quét tất cả: " + err.message, "error");
  } finally {
    btnScanAll.disabled = false;
  }
}

function renderScanRows(results, interval) {
  results.sort((a, b) => {
    const sa = a.d && a.d.setups && a.d.setups[0] ? (a.d.setups[0].confirmed ? 2 : 1) : 0;
    const sb = b.d && b.d.setups && b.d.setups[0] ? (b.d.setups[0].confirmed ? 2 : 1) : 0;
    if (sa !== sb) return sb - sa;
    const na = a.d && a.d.setups && a.d.setups[0] ? a.d.setups[0].score || 0 : 0;
    const nb = b.d && b.d.setups && b.d.setups[0] ? b.d.setups[0].score || 0 : 0;
    return nb - na;
  });

  setupsList.innerHTML =
    '<div class="scan-all-title">📊 ' + results.length + " mã · " + interval +
    " — sắp xếp theo chất lượng setup</div>";

  results.forEach(({ t, d, error }) => {
    const row = document.createElement("div");
    row.className = "scan-row";
    if (error || !d) {
      row.innerHTML = "<strong>" + t + "</strong> — <span class=\"red\">" + (error || "lỗi") + "</span>";
    } else {
      const first = d.setups && d.setups[0];
      const meta = metaOf(t);
      row.innerHTML =
        '<span class="row-name"><strong>' + (d.name || meta.name) + "</strong><br><small>" +
        t + " · " + (d.cat || meta.cat) + "</small></span>" +
        "<span>" + fmt(d.current_price) + "</span>" +
        (first
          ? '<span class="badge ' + (first.type === "BUY" ? "buy" : "sell") + '">' +
            (first.confirmed ? first.type : "W:" + first.type) +
            " · " + first.grade + " · " + first.score + "đ</span>"
          : d.patterns && d.patterns.length
            ? '<span class="badge none">' + d.patterns[0].type + "</span>"
            : '<span class="badge none">Không có wedge</span>');
      row.style.cursor = "pointer";
      row.addEventListener("click", () => {
        symbolSelect.value = t;
        activateTab("setup");
        scanOne(t, intervalSelect.value);
      });
    }
    setupsList.appendChild(row);
  });
}

/* ==================================================== pretty / watch */
async function scanPretty() {
  const interval = intervalSelect.value;
  const useApi = await apiAvailable();
  setStatus("Đang quét watchlist để tìm setup đẹp…", "loading");
  btnPretty.disabled = true;
  prettyList.innerHTML = '<div class="empty">Đang quét…</div>';
  try {
    let list = [];
    let scanned = 0;

    if (useApi) {
      const r = await fetch(
        "/api/watchlist-scan?interval=" + encodeURIComponent(interval) + "&only_beautiful=true"
      );
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      list = data.results || [];
      scanned = data.scanned || 0;
    } else {
      const targets = state.watchlist.length ? state.watchlist : SYMBOL_META.map((s) => s.t);
      const rows = await Promise.all(
        targets.map(async (t) => {
          try {
            const d = await fetchScanClient(t, interval);
            scanned++;
            setStatus("Quét setup đẹp " + scanned + "/" + targets.length + "…", "loading");
            return { t, d };
          } catch (e) {
            scanned++;
            return { t, d: null };
          }
        })
      );
      rows.forEach(({ t, d }) => {
        if (!d || !d.setups || !d.setups[0]) return;
        const s = d.setups[0];
        if (s.passed >= Math.min(3, s.total - 1) && s.rr >= 1.5 && s.score >= 55) {
          list.push({
            ticker: t,
            name: d.name,
            cat: d.cat,
            direction: s.type,
            grade: s.grade,
            rr: s.rr,
            passed: s.passed,
            total: s.total,
            score: s.score,
            entry: s.entry,
            sl: s.sl,
            tp: s.tp,
          });
        }
      });
    }

    list.sort((a, b) => b.score - a.score);

    if (!list.length) {
      prettyList.innerHTML =
        '<div class="empty">Không có mã nào đạt tiêu chí “setup đẹp”.<br>' +
        "(Yêu cầu: ≥3 điều kiện · R:R ≥ 1.5 · Điểm ≥ 55)<br><br>Đã quét " +
        scanned + " mã · " + interval + "</div>";
      setStatus("Đã quét " + scanned + " mã — chưa có setup đẹp nào", "ok");
      return;
    }

    prettyList.innerHTML =
      '<div class="scan-all-title">⭐ ' + list.length + " mã có setup đẹp / " +
      scanned + " mã · " + interval + "</div>";

    list.forEach((r) => {
      const meta = metaOf(r.ticker);
      const row = document.createElement("div");
      row.className = "pretty-row";
      const side = r.direction === "BUY" ? "buy" : "sell";
      row.innerHTML =
        '<div class="pretty-top"><span class="pretty-name">' + (r.name || meta.name) +
        "<br><small>" + r.ticker + " · " + (r.cat || meta.cat) + "</small></span>" +
        '<span class="grade ' + gradeCls(r.grade) + '">' + r.grade + "</span></div>" +
        '<div class="pretty-mid"><span class="badge ' + side + '">' + r.direction +
        " · R:R 1:" + r.rr + "</span>" +
        '<span class="pretty-checks">' + r.passed + "/" + r.total +
        " điều kiện · " + r.score + " điểm</span></div>" +
        '<div class="pretty-prices mono">E ' + fmt(r.entry) + " · SL " + fmt(r.sl) +
        " · TP " + fmt(r.tp) + "</div>";
      row.addEventListener("click", () => {
        symbolSelect.value = r.ticker;
        scanOne(r.ticker, intervalSelect.value);
        activateTab("setup");
      });
      prettyList.appendChild(row);
    });
    setStatus("Tìm được " + list.length + " mã có setup đẹp", "ok");
  } catch (err) {
    setStatus("Lỗi quét setup đẹp: " + err.message, "error");
    prettyList.innerHTML = '<div class="empty">Lỗi: ' + err.message + "</div>";
  } finally {
    btnPretty.disabled = false;
  }
}

function loadWatchlistLocal() {
  try {
    const raw = localStorage.getItem("ws_watchlist");
    if (raw) state.watchlist = JSON.parse(raw) || [];
    else state.watchlist = ["GC=F", "CL=F", "BTC-USD", "EURUSD=X", "^GSPC"];
  } catch (e) {
    state.watchlist = ["GC=F", "CL=F", "BTC-USD"];
  }
}

function saveWatchlistLocal() {
  try {
    localStorage.setItem("ws_watchlist", JSON.stringify(state.watchlist));
  } catch (e) {}
}

function renderWatchlist() {
  watchList.innerHTML = "";
  const groups = {};
  SYMBOL_META.forEach((s) => {
    (groups[s.cat] = groups[s.cat] || []).push(s);
  });
  Object.entries(groups).forEach(([cat, items]) => {
    const h = document.createElement("div");
    h.className = "watch-group-title";
    h.textContent = cat;
    watchList.appendChild(h);
    items.forEach((s) => {
      const row = document.createElement("label");
      const on = state.watchlist.includes(s.t);
      row.className = "watch-item" + (on ? "on" : "");
      row.innerHTML =
        '<input type="checkbox" value="' + s.t + '"' + (on ? " checked" : "") + ">" +
        '<span class="w-name">' + s.name + "</span>" +
        '<span class="w-sub">' + s.sub + "</span>";
      row.querySelector("input").addEventListener("change", (e) => {
        const t = e.target.value;
        if (e.target.checked) {
          if (!state.watchlist.includes(t)) state.watchlist.push(t);
        } else {
          state.watchlist = state.watchlist.filter((x) => x !== t);
        }
        row.classList.toggle("on", e.target.checked);
      });
      watchList.appendChild(row);
    });
  });
}

async function saveSettings() {
  const payload = {
    favorite_symbols: [symbolSelect.value],
    interval: intervalSelect.value,
    scan_cycle: cycleSelect.value,
    auto_scan: cycleSelect.value !== "manual",
    watchlist: state.watchlist,
  };
  try {
    localStorage.setItem("ws_settings", JSON.stringify(payload));
  } catch (e) {}
  if (await apiAvailable()) {
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {}
  }
}

async function loadSettings() {
  if (await apiAvailable()) {
    try {
      const r = await fetch("/api/settings");
      if (r.ok) {
        const s = await r.json();
        applySettings(s);
        return;
      }
    } catch (e) {}
  }
  try {
    const s = JSON.parse(localStorage.getItem("ws_settings") || "{}");
    applySettings(s);
  } catch (e) {}
}

function applySettings(s) {
  if (!s) return;
  if (s.interval) intervalSelect.value = s.interval;
  if (s.scan_cycle) cycleSelect.value = s.scan_cycle;
  if (s.favorite_symbols && s.favorite_symbols[0]) {
    const opt = symbolSelect.querySelector('option[value="' + s.favorite_symbols[0] + '"]');
    if (opt) symbolSelect.value = s.favorite_symbols[0];
  }
  if (Array.isArray(s.watchlist) && s.watchlist.length) {
    state.watchlist = s.watchlist;
  }
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name)
  );
  document.querySelectorAll(".tab-body").forEach((b) =>
    b.classList.toggle("active", b.id === "tab-" + name)
  );
}

/* ================================================================ boot */
document.addEventListener("DOMContentLoaded", async () => {
  initChart();
  loadWatchlistLocal();
  await loadSettings();
  renderWatchlist();

  const has = await apiAvailable();
  setStatus(
    has
      ? "Đã kết nối Render API (/api/scan) — chọn mã rồi bấm “Quét ngay”."
      : "Chế độ client-side (GitHub Pages) — phân tích ngay trên trình duyệt.",
    has ? "ok" : ""
  );

  btnScan.addEventListener("click", () => scanOne(symbolSelect.value, intervalSelect.value));
  btnScanAll.addEventListener("click", scanAll);
  btnPretty.addEventListener("click", scanPretty);
  $("btnWatchSave").addEventListener("click", async () => {
    saveWatchlistLocal();
    await saveSettings();
    setStatus("Đã lưu watchlist (" + state.watchlist.length + " mã)", "ok");
  });
  $("btnWatchAll").addEventListener("click", () => {
    state.watchlist = SYMBOL_META.map((s) => s.t);
    renderWatchlist();
  });

  symbolSelect.addEventListener("change", () => {
    setStatus("Đang tải " + symbolSelect.value + "…", "loading");
    setupsList.innerHTML = '<div class="empty">Đang tải…</div>';
    scanOne(symbolSelect.value, intervalSelect.value);
  });
  intervalSelect.addEventListener("change", () => scanOne(symbolSelect.value, intervalSelect.value));
  cycleSelect.addEventListener("change", saveSettings);
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => activateTab(b.dataset.tab))
  );

  scanOne(symbolSelect.value, intervalSelect.value);
});
