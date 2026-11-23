/* =========================================================
 * indicators.js — ZigZag, linear fit, Kijun, utils
 * ========================================================= */
(function (global) {
  "use strict";

  function linearFit(points) {
    const n = points.length;
    if (n < 2) return { slope: 0, intercept: points[0] ? points[0].y : 0 };
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (const p of points) {
      sx += p.x; sy += p.y; sxy += p.x * p.y; sxx += p.x * p.x;
    }
    const denom = n * sxx - sx * sx;
    const slope = Math.abs(denom) < 1e-12 ? 0 : (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    return { slope, intercept };
  }

  function evalLine(line, x) {
    return line.slope * x + line.intercept;
  }

  function getSwings(candles, depth) {
    depth = depth || 4;
    const n = candles.length;
    if (n < depth * 2 + 2) return [];

    let minH = Infinity, maxH = -Infinity;
    for (const c of candles) {
      if (c.l < minH) minH = c.l;
      if (c.h > maxH) maxH = c.h;
    }
    const range = maxH - minH || 1;
    const thr = range * 0.025;

    const raw = [];
    let lastPivot = { price: candles[0].h, i: 0, type: "H" };
    let dir = 0;
    for (let i = 1; i < n; i++) {
      const h = candles[i].h, l = candles[i].l;
      if (dir >= 0) {
        if (h >= lastPivot.price) {
          lastPivot = { price: h, i, type: "H" };
          dir = 1;
        } else if (dir === 1 && lastPivot.price - l >= thr) {
          raw.push(lastPivot);
          lastPivot = { price: l, i, type: "L" };
          dir = -1;
        } else if (dir === 0 && lastPivot.price - l >= thr) {
          lastPivot = { price: l, i, type: "L" };
          dir = -1;
        }
      }
      if (dir <= 0) {
        if (l <= lastPivot.price) {
          lastPivot = { price: l, i, type: "L" };
          dir = -1;
        } else if (dir === -1 && h - lastPivot.price >= thr) {
          raw.push(lastPivot);
          lastPivot = { price: h, i, type: "H" };
          dir = 1;
        }
      }
    }
    raw.push(lastPivot);

    let swings = raw.filter((s) => s.price != null && isFinite(s.price));
    const fDepth = Math.max(2, depth - 1);
    const fract = [];
    for (let i = fDepth; i < n - fDepth; i++) {
      let isHigh = true, isLow = true;
      const hi = candles[i].h, lo = candles[i].l;
      for (let j = i - fDepth; j <= i + fDepth; j++) {
        if (j === i) continue;
        if (candles[j].h >= hi) isHigh = false;
        if (candles[j].l <= lo) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) fract.push({ i, price: hi, type: "H" });
      else if (isLow) fract.push({ i, price: lo, type: "L" });
    }
    {
      const map = new Map();
      for (const s of swings) map.set(s.i + s.type, s);
      for (const s of fract) map.set(s.i + s.type, s);
      swings = Array.from(map.values()).sort((a, b) => a.i - b.i);
    }

    const cleaned = [];
    for (const s of swings) {
      const last = cleaned[cleaned.length - 1];
      if (last && last.type === s.type) {
        if (s.type === "H" && s.price >= last.price) cleaned[cleaned.length - 1] = s;
        else if (s.type === "L" && s.price <= last.price) cleaned[cleaned.length - 1] = s;
      } else {
        cleaned.push(s);
      }
    }
    return cleaned;
  }

  function kijun(candles, period) {
    period = period || 26;
    const out = new Array(candles.length).fill(null);
    for (let i = period - 1; i < candles.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        if (candles[j].h > hh) hh = candles[j].h;
        if (candles[j].l < ll) ll = candles[j].l;
      }
      out[i] = (hh + ll) / 2;
    }
    return out;
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

  /** Kijun trên khung H4 rồi map về nến hiện tại */
  function kijunH4(candles, currentInterval) {
    if (currentInterval === "4h" || currentInterval === "1d" || currentInterval === "1wk") {
      return kijun(candles, 26);
    }
    // 1h/15m/30m → aggregate về 4h
    const hours = currentInterval === "1h" ? 4 : currentInterval === "30m" ? 8 : 16;
    const h4 = aggregate(candles, hours);
    const k4 = kijun(h4, 26);
    const out = new Array(candles.length).fill(null);
    let p4 = 0;
    for (let i = 0; i < candles.length; i++) {
      const t = candles[i].t;
      while (p4 + 1 < h4.length && h4[p4 + 1].t <= t) p4++;
      if (h4[p4] && t >= h4[p4].t) out[i] = k4[p4];
    }
    return out;
  }

  function fmtPrice(n, digits) {
    if (n == null || !isFinite(n)) return "–";
    let d = digits;
    if (d === undefined) {
      const a = Math.abs(Number(n));
      d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 5;
    }
    return Number(n).toLocaleString("en-US", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (x) => String(x).padStart(2, "0");
    return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function gradeFromScore(score) {
    if (score >= 90) return "A+";
    if (score >= 80) return "A";
    if (score >= 70) return "B+";
    if (score >= 60) return "B";
    if (score >= 50) return "C";
    if (score >= 40) return "D";
    return "E";
  }

  global.WS_IND = {
    linearFit, evalLine, getSwings, kijun, kijunH4, aggregate,
    fmtPrice, fmtTime, gradeFromScore,
  };
})(window);
