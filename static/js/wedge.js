/* =========================================================
 * wedge.js — Wedge + High/Low + Breakout + Setup Entry/SL/TP
 * ========================================================= */
(function (global) {
  "use strict";

  const IND = global.WS_IND;

  const CFG = {
    zigzagDepth: 4,
    minBars: 50,
    wedgeMinSwings: 4,
    wedgeConvergeRatio: 0.88,
    breakoutBufferPct: 0.0015,
    retestWindow: 24,
  };

  function detectWedges(candles) {
    const n = candles.length;
    if (!n || n < CFG.minBars) return [];

    const swings = IND.getSwings(candles, CFG.zigzagDepth);
    const results = [];

    for (let end = CFG.wedgeMinSwings; end <= swings.length; end++) {
      const winSize = Math.min(8, Math.max(CFG.wedgeMinSwings, end));
      const start = Math.max(0, end - winSize);
      const win = swings.slice(start, end);
      const highs = win.filter((s) => s.type === "H");
      const lows = win.filter((s) => s.type === "L");
      if (highs.length < 2 || lows.length < 2) continue;

      const fitH = IND.linearFit(highs.map((s) => ({ x: s.i, y: s.price })));
      const fitL = IND.linearFit(lows.map((s) => ({ x: s.i, y: s.price })));

      const iMin = Math.min(...win.map((s) => s.i));
      const iMax = Math.max(...win.map((s) => s.i));

      const gapStart = IND.evalLine(fitH, iMin) - IND.evalLine(fitL, iMin);
      const gapEnd = IND.evalLine(fitH, iMax) - IND.evalLine(fitL, iMax);
      if (!(gapStart > 0 && gapEnd > 0)) continue;
      if (gapEnd >= gapStart * CFG.wedgeConvergeRatio) continue;

      const slopeH = fitH.slope, slopeL = fitL.slope;
      let wtype, bias;
      if (slopeH < 0 && slopeL < 0) {
        wtype = "Falling Wedge"; bias = "bullish";
      } else if (slopeH > 0 && slopeL > 0) {
        wtype = "Rising Wedge"; bias = "bearish";
      } else if (slopeH < 0 && slopeL >= 0) {
        wtype = "Contracting Wedge"; bias = "bullish";
      } else if (slopeH >= 0 && slopeL < 0) {
        wtype = "Expanding-to-Contract"; bias = "neutral";
      } else {
        wtype = "Symmetrical Wedge"; bias = "neutral";
      }

      let high = -Infinity, low = Infinity, highI = iMax, lowI = iMax;
      for (let i = iMin; i <= iMax; i++) {
        if (candles[i].h > high) { high = candles[i].h; highI = i; }
        if (candles[i].l < low) { low = candles[i].l; lowI = i; }
      }

      const range = high - low;
      const buf = range * CFG.breakoutBufferPct + range * 0.002;
      let breakout = null;
      const lookStart = Math.max(iMax + 1, Math.floor((iMin + iMax) / 2));
      for (let i = lookStart; i < n; i++) {
        const upLine = IND.evalLine(fitH, i);
        const dnLine = IND.evalLine(fitL, i);
        if (candles[i].c > upLine + buf) {
          breakout = { index: i, type: "up", price: candles[i].c, line: upLine };
          break;
        }
        if (candles[i].c < dnLine - buf) {
          breakout = { index: i, type: "down", price: candles[i].c, line: dnLine };
          break;
        }
      }
      if (!breakout) continue;

      const signal = buildSignal(candles, { iMin, iMax, high, low, fitH, fitL, breakout });
      const score = scorePattern({
        gapStart, gapEnd, win, breakout, signal, n, iMax, bias, wtype, highI, lowI,
      });

      const iEnd = Math.max(iMax, breakout.index);
      results.push({
        wtype, bias,
        iMin, iMax, iHigh: highI, iLow: lowI,
        high, low, fitH, fitL, swings: win, breakout, signal, score,
        lines: {
          upper: [
            { i: iMin, p: IND.evalLine(fitH, iMin) },
            { i: iEnd + 4, p: IND.evalLine(fitH, iEnd + 4) },
          ],
          lower: [
            { i: iMin, p: IND.evalLine(fitL, iMin) },
            { i: iEnd + 4, p: IND.evalLine(fitL, iEnd + 4) },
          ],
        },
      });
    }

    results.sort((a, b) => b.score - a.score || b.iMax - a.iMax);
    const picked = [];
    for (const r of results) {
      const overlap = picked.some(
        (p) => !(r.iMax < p.iMin || r.iMin > p.iMax) &&
          Math.abs(r.high - p.high) / (p.high || 1) < 0.01
      );
      if (!overlap) picked.push(r);
      if (picked.length >= 3) break;
    }
    return picked;
  }

  function buildSignal(candles, ctx) {
    const { iMin, iMax, high, low, fitH, fitL, breakout } = ctx;
    const n = candles.length;
    const bi = breakout.index;
    const windowEnd = Math.min(n - 1, bi + CFG.retestWindow);
    const mid = (high + low) / 2;
    const range = high - low || 1;

    if (breakout.type === "down") {
      let retestHigh = -Infinity, retestHighI = bi;
      for (let i = bi; i <= windowEnd; i++) {
        if (candles[i].h > retestHigh) { retestHigh = candles[i].h; retestHighI = i; }
      }
      for (let i = retestHighI + 1; i <= windowEnd; i++) {
        const c = candles[i];
        const lower = IND.evalLine(fitL, i);
        const failLevel = Math.min(retestHigh * 0.998, Math.max(mid, lower));
        if (c.c < failLevel && c.c < candles[i - 1].c) {
          const entry = c.c;
          const stop = Math.max(retestHigh, high) * 1.002;
          const tp = entry - (stop - entry) * 2; // R:R 1:2
          return {
            type: "SELL", index: i, price: entry,
            retestHigh, retestHighI, level: failLevel,
            stop, tp,
            rr: 2,
            reason: "Breakdown → retest " + fmt(retestHigh) + " → close fail → SELL",
          };
        }
      }
      const entry = breakout.price;
      const stop = Math.max(high, retestHigh) * 1.002;
      return {
        type: "WATCH_SELL", index: bi, price: entry,
        retestHigh, retestHighI, level: mid,
        stop, tp: entry - (stop - entry) * 2, rr: 2,
        reason: "Đã breakdown — chờ retest thất bại để SELL",
      };
    }

    if (breakout.type === "up") {
      let retestLow = Infinity, retestLowI = bi;
      for (let i = bi; i <= windowEnd; i++) {
        if (candles[i].l < retestLow) { retestLow = candles[i].l; retestLowI = i; }
      }
      for (let i = retestLowI + 1; i <= windowEnd; i++) {
        const c = candles[i];
        const upper = IND.evalLine(fitH, i);
        const failLevel = Math.max(retestLow * 1.002, Math.min(mid, upper));
        if (c.c > failLevel && c.c > candles[i - 1].c) {
          const entry = c.c;
          const stop = Math.min(retestLow, low) * 0.998;
          const tp = entry + (entry - stop) * 2;
          return {
            type: "BUY", index: i, price: entry,
            retestLow, retestLowI, level: failLevel,
            stop, tp, rr: 2,
            reason: "Breakout ↑ → retest " + fmt(retestLow) + " → hold → BUY",
          };
        }
      }
      const entry = breakout.price;
      const stop = Math.min(low, retestLow) * 0.998;
      return {
        type: "WATCH_BUY", index: bi, price: entry,
        retestLow, retestLowI, level: mid,
        stop, tp: entry + (entry - stop) * 2, rr: 2,
        reason: "Đã breakout lên — chờ pullback hold để BUY",
      };
    }
    return null;
  }

  function fmt(x) {
    return Number(x).toFixed(2);
  }

  function scorePattern(p) {
    let s = 0;
    const conv = 1 - p.gapEnd / p.gapStart;
    s += Math.min(35, conv * 50);
    s += Math.min(15, (p.win.length - 3) * 3);
    if (p.signal && (p.signal.type === "SELL" || p.signal.type === "BUY")) s += 30;
    else if (p.signal && p.signal.type.indexOf("WATCH") === 0) s += 18;
    const dist = p.n - p.breakout.index;
    s += Math.max(0, 15 - dist * 0.5);
    if (p.bias === "bearish" && p.breakout.type === "down") s += 8;
    if (p.bias === "bullish" && p.breakout.type === "up") s += 8;
    if (p.highI !== p.lowI) s += 4;
    return Math.max(0, Math.min(100, Math.round(s)));
  }

  /**
   * Build full analysis payload cho UI (giống cấu trúc /api/scan tham chiếu)
   */
  function buildAnalysis(candles, ticker, name, sub, cat, interval, kijunArr) {
    const patterns = detectWedges(candles);
    const p = patterns[0] || null;
    const last = candles[candles.length - 1];
    const current_price = last ? last.c : null;

    // Gắn timestamp cho trendline ( Lightweight Charts cần unix seconds )
    patterns.forEach((pat) => {
      const c0 = candles[pat.lines.upper[0].i];
      const c1 = candles[pat.lines.upper[1].i];
      pat._t0 = c0 ? Math.floor(c0.t / 1000) : null;
      pat._t1 = c1 ? Math.floor(c1.t / 1000) : null;
      pat._from = c0 ? new Date(c0.t).toISOString() : "";
      // slope % trên cửa sổ
      const span = pat.lines.upper[1].i - pat.lines.upper[0].i || 1;
      const y0 = pat.lines.upper[0].p;
      const y1 = pat.lines.upper[1].p;
      pat.slope_pct = y0 ? (((y1 - y0) / y0) * 100) / (span / 10) : 0;
    });

    // RSI 14 nhanh cho chart info
    let rsi = null;
    if (candles.length > 15) {
      let gain = 0, loss = 0;
      const period = 14;
      for (let i = candles.length - period; i < candles.length; i++) {
        const d = candles[i].c - candles[i - 1].c;
        if (d >= 0) gain += d;
        else loss -= d;
      }
      const avgG = gain / period, avgL = loss / period;
      rsi = avgL === 0 ? 100 : +(100 - 100 / (1 + avgG / avgL)).toFixed(1);
    }

    const patternsOut = patterns.map((x) => ({
      type: x.wtype,
      price: x.high,
      bias: x.bias === "bearish" ? "BEARISH" : x.bias === "bullish" ? "BULLISH" : "NEUTRAL",
      score: x.score,
    }));

    if (!p) {
      return {
        symbol: ticker, name, sub, cat, interval,
        current_price, rsi, atr: null,
        unit: "",
        setups: [],
        patterns: patternsOut,
        support_trendline: null,
        resistance_trendline: null,
        supports: [],
        resistances: [],
        candles,
        kijun: kijunArr,
        grade: "—",
      };
    }

    const sig = p.signal;
    const isConfirm = sig && (sig.type === "SELL" || sig.type === "BUY");
    const side = sig && (sig.type === "SELL" || sig.type === "WATCH_SELL") ? "SELL" : "BUY";

    // Checklist 4+ điều kiện
    const checklist = [];
    const convPct = ((1 - 0) * 100); // placeholder
    const convRatio = 1; // recompute
    // recompute from pattern — store on p
    checklist.push({
      ok: true,
      text: "Mẫu hình Wedge hội tụ",
      value: p.wtype + " · hội tụ " + Math.round((1 - 0) * 100) + "%",
    });
    // Better: use gap info if available
    checklist[0].value = p.wtype + " · swing " + p.swings.length + " · bias " + p.bias;

    checklist.push({
      ok: !!p.breakout,
      text: "Breakout / Breakdown khỏi wedge",
      value: p.breakout
        ? (p.breakout.type === "down" ? "↓ Breakdown" : "↑ Breakout") + " @ " + IND.fmtPrice(p.breakout.price)
        : "chưa có",
    });

    checklist.push({
      ok: isConfirm,
      text: "Retest xác nhận close (entry)",
      value: sig
        ? (isConfirm ? sig.type + " close" : sig.type.replace("WATCH_", "chờ ")) + " · " + sig.reason
        : "chưa có tín hiệu",
    });

    checklist.push({
      ok: p.score >= 60,
      text: "Điểm mẫu hình ≥ 60",
      value: p.score + "/100 · " + IND.gradeFromScore(p.score),
    });

    checklist.push({
      ok: p.high > p.low && p.iHigh !== p.iLow,
      text: "Có High / Low rõ của wedge",
      value: "H " + IND.fmtPrice(p.high) + " · L " + IND.fmtPrice(p.low),
    });

    // Kijun filter
    let kijunOk = false;
    if (kijunArr && kijunArr.length && current_price != null) {
      const k = kijunArr[kijunArr.length - 1];
      if (k != null) {
        kijunOk = side === "SELL" ? current_price < k : current_price > k;
        checklist.push({
          ok: kijunOk,
          text: "Giá so với Kijun H4",
          value: "K " + IND.fmtPrice(k) + " · giá " + IND.fmtPrice(current_price) +
            (kijunOk ? " (thuận hướng)" : " (ngược hướng)"),
        });
      }
    }

    const passed = checklist.filter((c) => c.ok).length;
    const total = checklist.length;
    let score = p.score;
    if (kijunOk) score = Math.min(100, score + 5);
    if (!isConfirm) score = Math.max(0, score - 10);

    const entry = sig ? sig.price : current_price;
    const sl = sig ? sig.stop : side === "SELL" ? p.high * 1.002 : p.low * 0.998;
    const tp = sig && sig.tp != null
      ? sig.tp
      : side === "SELL"
        ? entry - (sl - entry) * 2
        : entry + (entry - sl) * 2;
    const risk = Math.abs(sl - entry) || 1;
    const reward = Math.abs(tp - entry);
    const rr = +(reward / risk).toFixed(2);
    const rr_ok = rr >= 1.5;

    const reasons = [];
    reasons.push(p.wtype + " trên " + interval + " (" + p.bias + ")");
    if (p.breakout) {
      reasons.push(
        (p.breakout.type === "down" ? "Breakdown" : "Breakout") +
          " nến " + IND.fmtTime(candles[p.breakout.index].t)
      );
    }
    if (sig) reasons.push(sig.reason);
    reasons.push("High/Low wedge: " + IND.fmtPrice(p.high) + " / " + IND.fmtPrice(p.low));

    const grade = IND.gradeFromScore(score);

    const setup = {
      type: side === "SELL" ? "SELL" : "BUY",
      source: "Wedge Scanner · " + p.wtype,
      pattern: p.wtype + " · " + (p.breakout && p.breakout.type === "down" ? "breakdown" : "breakout"),
      grade,
      score,
      passed,
      total,
      entry: +entry.toFixed(6),
      sl: +sl.toFixed(6),
      tp: +tp.toFixed(6),
      rr,
      rr_ok,
      confirmed: isConfirm,
      checklist,
      reasons,
      // extras cho chart
      patternObj: p,
      kijunOk,
    };

    // Supports/resistances từ High/Low + signal levels
    const supports = [p.low];
    const resistances = [p.high];
    if (sig && sig.level) {
      if (side === "SELL") resistances.push(sig.level);
      else supports.push(sig.level);
    }

    return {
      symbol: ticker,
      name,
      sub,
      cat,
      interval,
      current_price,
      rsi,
      atr: null,
      unit: "",
      grade,
      setups: isConfirm || sig ? [setup] : [],
      patterns: patternsOut,
      supports,
      resistances,
      support_trendline: trendlineFrom(p, "lower"),
      resistance_trendline: trendlineFrom(p, "upper"),
      candles,
      kijun: kijunArr,
      patternMain: p,
      setupMain: setup,
    };
  }

  function trendlineFrom(p, which) {
    const line = p.lines[which];
    if (!line || line.length < 2) return null;
    if (!p._t0 || !p._t1) return null;
    return {
      x1_ts: p._t0,
      x2_ts: p._t1,
      y1: line[0].p,
      y_end: line[1].p,
      slope_pct: p.slope_pct || 0,
      broken: !!p.breakout &&
        ((which === "lower" && p.breakout.type === "down") ||
         (which === "upper" && p.breakout.type === "up")),
      from: p._from || "",
      kind: which === "lower" ? "support" : "resistance",
    };
  }

  global.WS_WEDGE = {
    detectWedges,
    buildAnalysis,
    buildSignal,
    kijun: IND.kijun,
    kijunH4: IND.kijunH4,
    CFG,
  };
})(window);
