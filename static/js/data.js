/* =========================================================
 * data.js — Nguồn nến nhiều lớp (client-side, CORS-friendly)
 * Yahoo via jina · Binance Vision · Coinbase · Bitstamp · CoinGecko
 * Hỗ trợ interval: 15m 30m 1h 4h 1d 1wk
 * ========================================================= */
(function (global) {
  "use strict";

  const YAHOO_INTERVAL = {
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "4h": "1h", // aggregate
    "1d": "1d",
    "1wk": "1wk",
  };

  const YAHOO_RANGE = {
    "15m": "1mo",
    "30m": "2mo",
    "1h": "3mo",
    "4h": "3mo",
    "1d": "1y",
    "1wk": "2y",
  };

  const BINANCE_STEP = {
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
    "1wk": "1w",
  };

  async function fetchJSON(url, opts, timeoutMs) {
    timeoutMs = timeoutMs || 14000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchText(url, opts, timeoutMs) {
    timeoutMs = timeoutMs || 18000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  function parseYahoo(json) {
    const r = json && json.chart && json.chart.result && json.chart.result[0];
    if (!r || !r.timestamp) throw new Error("Yahoo: empty");
    const q = r.indicators.quote[0];
    const out = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
      if (o == null || h == null || l == null || c == null) continue;
      out.push({ t: r.timestamp[i] * 1000, o: +o, h: +h, l: +l, c: +c, v: (q.volume && q.volume[i]) || 0 });
    }
    if (out.length < 20) throw new Error("Yahoo: too few bars");
    return out;
  }

  async function loadYahoo(symbol, intervalKey, viaJina) {
    const yi = YAHOO_INTERVAL[intervalKey] || "1h";
    const range = YAHOO_RANGE[intervalKey] || "3mo";
    const url =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?interval=" + yi + "&range=" + range + "&includePrePost=false";
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

    let bars;
    if (viaJina) {
      const text = await fetchText("https://r.jina.ai/" + url, { headers }, 20000);
      const idx = text.indexOf('{"chart"');
      bars = parseYahoo(JSON.parse(idx >= 0 ? text.slice(idx) : text));
    } else {
      bars = parseYahoo(await fetchJSON(url, { headers }, 12000));
    }

    // 4h: lấy 1h rồi aggregate
    if (intervalKey === "4h") {
      const url1h =
        "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodeURIComponent(symbol) + "?interval=1h&range=3mo&includePrePost=false";
      let b1;
      if (viaJina) {
        const text = await fetchText("https://r.jina.ai/" + url1h, { headers }, 20000);
        const idx = text.indexOf('{"chart"');
        b1 = parseYahoo(JSON.parse(idx >= 0 ? text.slice(idx) : text));
      } else {
        b1 = parseYahoo(await fetchJSON(url1h, { headers }, 12000));
      }
      return aggregate(b1, 4);
    }
    return bars;
  }

  async function loadBinance(symbol, intervalKey) {
    const step = BINANCE_STEP[intervalKey];
    if (!step) throw new Error("Binance: bad interval");
    const url =
      "https://data-api.binance.vision/api/v3/klines?symbol=" +
      symbol + "&interval=" + step + "&limit=500";
    const rows = await fetchJSON(url, {}, 12000);
    if (!Array.isArray(rows) || !rows.length) throw new Error("Binance: empty");
    return rows.map((r) => ({
      t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5],
    }));
  }

  async function loadCoinbase(product, intervalKey) {
    const map = { "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400, "1wk": 604800 };
    const g = map[intervalKey] || 3600;
    const url =
      "https://api.exchange.coinbase.com/products/" + product +
      "/candles?granularity=" + g;
    const rows = await fetchJSON(url, { headers: { Accept: "application/json" } }, 12000);
    if (!Array.isArray(rows) || !rows.length) throw new Error("Coinbase: empty");
    return rows
      .map((r) => ({ t: r[0] * 1000, l: +r[1], h: +r[2], o: +r[3], c: +r[4], v: +r[5] }))
      .sort((a, b) => a.t - b.t);
  }

  async function loadBitstamp(pair, limit) {
    const url =
      "https://www.bitstamp.net/api/v2/ohlc/" + pair +
      "/?step=3600&limit=" + (limit || 500);
    const json = await fetchJSON(url, {}, 12000);
    const arr = json && json.data && json.data.ohlc;
    if (!arr || !arr.length) throw new Error("Bitstamp: empty");
    return arr
      .map((r) => ({
        t: +r.timestamp * 1000, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume,
      }))
      .sort((a, b) => a.t - b.t);
  }

  async function loadCoinGecko(id, days) {
    const url =
      "https://api.coingecko.com/api/v3/coins/" + id +
      "/ohlc?vs_currency=usd&days=" + (days || 30);
    const rows = await fetchJSON(url, {}, 12000);
    if (!Array.isArray(rows) || !rows.length) throw new Error("CoinGecko: empty");
    return rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: 0 }));
  }

  function aggregate(candles, hours) {
    if (hours <= 1) return candles.slice();
    const ms = hours * 3600 * 1000;
    const map = new Map();
    const out = [];
    for (const c of candles) {
      const bucket = Math.floor(c.t / ms) * ms;
      let b = map.get(bucket);
      if (!b) {
        b = { t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 };
        map.set(bucket, b);
        out.push(b);
      } else {
        b.h = Math.max(b.h, c.h);
        b.l = Math.min(b.l, c.l);
        b.c = c.c;
        b.v += c.v || 0;
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /** Nguồn theo ticker Yahoo */
  function sourcesFor(ticker) {
    const t = ticker;
    // Crypto pair → try binance first (CORS *)
    const binanceMap = {
      "BTC-USD": "BTCUSDT",
      "ETH-USD": "ETHUSDT",
      "XRP-USD": "XRPUSDT",
      "SOL-USD": "SOLUSDT",
      "ADA-USD": "ADAUSDT",
    };
    const coinbaseMap = {
      "BTC-USD": "BTC-USD",
      "ETH-USD": "ETH-USD",
      "XRP-USD": "XRP-USD",
      "SOL-USD": "SOL-USD",
      "ADA-USD": "ADA-USD",
    };
    const bitstampMap = {
      "BTC-USD": "btcusd",
      "ETH-USD": "ethusd",
      "XRP-USD": "xrpusd",
    };
    const cgMap = {
      "BTC-USD": "bitcoin",
      "ETH-USD": "ethereum",
      "XRP-USD": "ripple",
      "SOL-USD": "solana",
      "ADA-USD": "cardano",
    };

    const list = [];
    if (binanceMap[t]) list.push({ type: "binance", symbol: binanceMap[t] });
    if (coinbaseMap[t]) list.push({ type: "coinbase", symbol: coinbaseMap[t] });
    if (bitstampMap[t]) list.push({ type: "bitstamp", symbol: bitstampMap[t] });
    if (cgMap[t]) list.push({ type: "coingecko", id: cgMap[t] });

    // Yahoo via jina (CORS) trước, direct sau
    list.push({ type: "jina", symbol: t });
    list.push({ type: "yahoo", symbol: t, via: true });
    list.push({ type: "yahoo", symbol: t, via: false });
    return list;
  }

  function cleanBars(bars) {
    bars = (bars || []).filter(
      (b) => isFinite(b.o) && isFinite(b.h) && isFinite(b.l) && isFinite(b.c) && b.h >= b.l
    );
    bars.sort((a, b) => a.t - b.t);
    const dedup = [];
    for (const b of bars) {
      if (dedup.length && dedup[dedup.length - 1].t === b.t) dedup[dedup.length - 1] = b;
      else dedup.push(b);
    }
    return dedup;
  }

  async function loadCandles(ticker, intervalKey) {
    const errors = [];
    for (const src of sourcesFor(ticker)) {
      try {
        let bars;
        if (src.type === "jina") bars = await loadYahoo(src.symbol, intervalKey, true);
        else if (src.type === "yahoo")
          bars = await loadYahoo(src.symbol, intervalKey, !!src.via);
        else if (src.type === "binance") bars = await loadBinance(src.symbol, intervalKey);
        else if (src.type === "coinbase") bars = await loadCoinbase(src.symbol, intervalKey);
        else if (src.type === "bitstamp") bars = await loadBitstamp(src.symbol, 500);
        else if (src.type === "coingecko")
          bars = await loadCoinGecko(src.id, intervalKey === "1d" || intervalKey === "1wk" ? 90 : 30);
        else continue;

        bars = cleanBars(bars);
        if (bars.length >= 40) {
          return {
            candles: bars,
            source: src.type + ":" + (src.symbol || src.id),
          };
        }
        errors.push(src.type + ": few (" + bars.length + ")");
      } catch (e) {
        errors.push(src.type + ": " + (e.message || e));
      }
    }
    throw new Error("Không load được " + ticker + " — " + errors.join(" | "));
  }

  global.WS_DATA = { loadCandles, aggregate, sourcesFor, YAHOO_INTERVAL, YAHOO_RANGE };
})(window);
