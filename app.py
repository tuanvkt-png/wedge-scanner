"""
Wedge Scanner — Flask backend cho Render (giống trang tham chiếu):
  GET  /                     → index.html tĩnh
  GET  /api/symbols          → danh mục mã
  GET  /api/settings         → settings (file JSON)
  POST /api/settings         → lưu settings
  GET  /api/scan?symbol=&interval=  → phân tích 1 mã
  GET  /api/scan-all?interval=      → quét tất cả
  GET  /api/watchlist-scan?interval=&only_beautiful=true
Dữ liệu nến: Yahoo Finance (server-side, không CORS).
"""
from __future__ import annotations

import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from math import isfinite
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder="static", static_url_path="/static")
CORS(app)

ROOT = Path(__file__).resolve().parent
SETTINGS_FILE = ROOT / "settings.json"
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

# ---------------------------------------------------------------- symbols
SYMBOLS = [
    # Ngoại hối
    {"t": "EURUSD=X", "name": "EUR/USD", "sub": "Euro / US Dollar", "cat": "Ngoại hối", "unit": "pip"},
    {"t": "GBPUSD=X", "name": "GBP/USD", "sub": "British Pound / US Dollar", "cat": "Ngoại hối", "unit": "pip"},
    {"t": "USDJPY=X", "name": "USD/JPY", "sub": "US Dollar / Japanese Yen", "cat": "Ngoại hối", "unit": "pip"},
    {"t": "AUDUSD=X", "name": "AUD/USD", "sub": "Australian Dollar / US Dollar", "cat": "Ngoại hối", "unit": "pip"},
    {"t": "USDCAD=X", "name": "USD/CAD", "sub": "US Dollar / Canadian Dollar", "cat": "Ngoại hối", "unit": "pip"},
    {"t": "USDCHF=X", "name": "USD/CHF", "sub": "US Dollar / Swiss Franc", "cat": "Ngoại hối", "unit": "pip"},
    # Kim loại
    {"t": "GC=F", "name": "Vàng giao sau", "sub": "XAUUSD · Gold Futures", "cat": "Kim loại", "unit": "USD/oz"},
    {"t": "SI=F", "name": "Bạc giao sau", "sub": "XAGUSD · Silver Futures", "cat": "Kim loại", "unit": "USD/oz"},
    {"t": "HG=F", "name": "Đồng giao sau", "sub": "Copper Futures", "cat": "Kim loại", "unit": "USD/lb"},
    # Năng lượng
    {"t": "CL=F", "name": "Dầu thô WTI", "sub": "WTI Crude Oil", "cat": "Năng lượng", "unit": "USD/bbl"},
    {"t": "BZ=F", "name": "Dầu Brent", "sub": "Brent Crude", "cat": "Năng lượng", "unit": "USD/bbl"},
    {"t": "NG=F", "name": "Khí tự nhiên", "sub": "Natural Gas", "cat": "Năng lượng", "unit": "USD/MMBtu"},
    # Crypto
    {"t": "BTC-USD", "name": "Bitcoin", "sub": "BTC/USD", "cat": "Tiền mã hoá", "unit": "USD"},
    {"t": "ETH-USD", "name": "Ethereum", "sub": "ETH/USD", "cat": "Tiền mã hoá", "unit": "USD"},
    {"t": "XRP-USD", "name": "Ripple", "sub": "XRP/USD", "cat": "Tiền mã hoá", "unit": "USD"},
    {"t": "SOL-USD", "name": "Solana", "sub": "SOL/USD", "cat": "Tiền mã hoá", "unit": "USD"},
    {"t": "ADA-USD", "name": "Cardano", "sub": "ADA/USD", "cat": "Tiền mã hoá", "unit": "USD"},
    # Chỉ số
    {"t": "^DJI", "name": "Dow Jones 30", "sub": "US30 / DJIA", "cat": "Chỉ số", "unit": "đ"},
    {"t": "^IXIC", "name": "Nasdaq Composite", "sub": "US100 / NASDAQ", "cat": "Chỉ số", "unit": "đ"},
    {"t": "^GSPC", "name": "S&P 500", "sub": "SPX", "cat": "Chỉ số", "unit": "đ"},
    {"t": "^N225", "name": "Nikkei 225", "sub": "JP225", "cat": "Chỉ số", "unit": "đ"},
    {"t": "^VIX", "name": "VIX", "sub": "Volatility Index", "cat": "Chỉ số", "unit": "đ"},
    # Cổ phiếu
    {"t": "AAPL", "name": "Apple Inc.", "sub": "AAPL", "cat": "Cổ phiếu", "unit": "USD"},
    {"t": "TSLA", "name": "Tesla Inc.", "sub": "TSLA", "cat": "Cổ phiếu", "unit": "USD"},
    {"t": "NVDA", "name": "NVIDIA Corp.", "sub": "NVDA", "cat": "Cổ phiếu", "unit": "USD"},
    {"t": "MSFT", "name": "Microsoft Corp.", "sub": "MSFT", "cat": "Cổ phiếu", "unit": "USD"},
    {"t": "AMZN", "name": "Amazon.com Inc.", "sub": "AMZN", "cat": "Cổ phiếu", "unit": "USD"},
]
SYM_MAP = {s["t"]: s for s in SYMBOLS}

YAHOO_INTERVAL = {
    "15m": ("15m", "1mo"),
    "30m": ("30m", "2mo"),
    "1h": ("1h", "3mo"),
    "4h": ("1h", "3mo"),  # aggregate
    "1d": ("1d", "1y"),
    "1wk": ("1wk", "2y"),
}


# ---------------------------------------------------------------- data
def fetch_yahoo(symbol: str, interval: str) -> list[dict]:
    yi, rng = YAHOO_INTERVAL.get(interval, ("1h", "3mo"))
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{requests.utils.quote(symbol, safe='')}?interval={yi}&range={rng}&includePrePost=false"
    )
    r = requests.get(url, headers=UA, timeout=20)
    r.raise_for_status()
    data = r.json()
    res = (data.get("chart") or {}).get("result") or []
    if not res:
        raise ValueError(f"Yahoo empty for {symbol}")
    res0 = res[0]
    ts = res0.get("timestamp") or []
    q = (res0.get("indicators") or {}).get("quote") or [{}]
    q0 = q[0]
    bars = []
    for i, t in enumerate(ts):
        o = q0.get("open", [None] * len(ts))[i]
        h = q0.get("high", [None] * len(ts))[i]
        l = q0.get("low", [None] * len(ts))[i]
        c = q0.get("close", [None] * len(ts))[i]
        v = (q0.get("volume") or [0] * len(ts))[i]
        if None in (o, h, l, c):
            continue
        bars.append({"t": t * 1000, "o": float(o), "h": float(h), "l": float(l), "c": float(c), "v": float(v or 0)})
    if len(bars) < 30:
        raise ValueError(f"too few bars {symbol}")
    if interval == "4h":
        bars = aggregate(bars, 4)
    return bars


def aggregate(bars: list[dict], hours: int) -> list[dict]:
    ms = hours * 3600 * 1000
    out: list[dict] = []
    idx: dict[int, int] = {}
    for b in sorted(bars, key=lambda x: x["t"]):
        bucket = (b["t"] // ms) * ms
        if bucket not in idx:
            idx[bucket] = len(out)
            out.append({**b, "t": bucket})
        else:
            p = out[idx[bucket]]
            p["h"] = max(p["h"], b["h"])
            p["l"] = min(p["l"], b["l"])
            p["c"] = b["c"]
            p["v"] += b["v"]
    return out


# ---------------------------------------------------------------- indicators
def linear_fit(points: list[tuple[float, float]]) -> tuple[float, float]:
    n = len(points)
    if n < 2:
        return 0.0, points[0][1] if points else 0.0
    sx = sum(p[0] for p in points)
    sy = sum(p[1] for p in points)
    sxy = sum(p[0] * p[1] for p in points)
    sxx = sum(p[0] * p[0] for p in points)
    den = n * sxx - sx * sx
    slope = 0.0 if abs(den) < 1e-12 else (n * sxy - sx * sy) / den
    intercept = (sy - slope * sx) / n
    return slope, intercept


def eval_line(line: tuple[float, float], x: float) -> float:
    return line[0] * x + line[1]


def get_swings(candles: list[dict], depth: int = 4) -> list[dict]:
    n = len(candles)
    if n < depth * 2 + 2:
        return []
    lo = min(c["l"] for c in candles)
    hi = max(c["h"] for c in candles)
    rng = (hi - lo) or 1.0
    thr = rng * 0.025

    raw: list[dict] = []
    last = {"price": candles[0]["h"], "i": 0, "type": "H"}
    direction = 0
    for i in range(1, n):
        h, l = candles[i]["h"], candles[i]["l"]
        if direction >= 0:
            if h >= last["price"]:
                last = {"price": h, "i": i, "type": "H"}
                direction = 1
            elif direction == 1 and last["price"] - l >= thr:
                raw.append(last)
                last = {"price": l, "i": i, "type": "L"}
                direction = -1
            elif direction == 0 and last["price"] - l >= thr:
                last = {"price": l, "i": i, "type": "L"}
                direction = -1
        if direction <= 0:
            if l <= last["price"]:
                last = {"price": l, "i": i, "type": "L"}
                direction = -1
            elif direction == -1 and h - last["price"] >= thr:
                raw.append(last)
                last = {"price": h, "i": i, "type": "H"}
                direction = 1
    raw.append(last)

    swings = [s for s in raw if s.get("price") is not None and not math.isnan(s["price"])]
    fdepth = max(2, depth - 1)
    fmap: dict[str, dict] = {f"{s['i']}{s['type']}": s for s in swings}
    for i in range(fdepth, n - fdepth):
        is_h = all(candles[j]["h"] < candles[i]["h"] for j in range(i - fdepth, i + fdepth + 1) if j != i)
        is_l = all(candles[j]["l"] > candles[i]["l"] for j in range(i - fdepth, i + fdepth + 1) if j != i)
        if is_h:
            fmap[f"{i}H"] = {"i": i, "price": candles[i]["h"], "type": "H"}
        elif is_l:
            fmap[f"{i}L"] = {"i": i, "price": candles[i]["l"], "type": "L"}
    swings = sorted(fmap.values(), key=lambda s: s["i"])

    cleaned: list[dict] = []
    for s in swings:
        if cleaned and cleaned[-1]["type"] == s["type"]:
            if (s["type"] == "H" and s["price"] >= cleaned[-1]["price"]) or (
                s["type"] == "L" and s["price"] <= cleaned[-1]["price"]
            ):
                cleaned[-1] = s
        else:
            cleaned.append(s)
    return cleaned


def kijun(candles: list[dict], period: int = 26) -> list[float | None]:
    out: list[float | None] = [None] * len(candles)
    for i in range(period - 1, len(candles)):
        hh = max(c["h"] for c in candles[i - period + 1 : i + 1])
        ll = min(c["l"] for c in candles[i - period + 1 : i + 1])
        out[i] = (hh + ll) / 2
    return out


def kijun_for(candles: list[dict], interval: str) -> list[float | None]:
    if interval in ("4h", "1d", "1wk"):
        return kijun(candles, 26)
    hours = {"1h": 4, "30m": 8, "15m": 16}.get(interval, 4)
    h4 = aggregate(candles, hours)
    k4 = kijun(h4, 26)
    out: list[float | None] = [None] * len(candles)
    p4 = 0
    for i, c in enumerate(candles):
        t = c["t"]
        while p4 + 1 < len(h4) and h4[p4 + 1]["t"] <= t:
            p4 += 1
        if h4[p4]["t"] <= t:
            out[i] = k4[p4]
    return out


def rsi14(candles: list[dict]) -> float | None:
    if len(candles) < 16:
        return None
    period = 14
    gains = losses = 0.0
    for i in range(len(candles) - period, len(candles)):
        d = candles[i]["c"] - candles[i - 1]["c"]
        if d >= 0:
            gains += d
        else:
            losses -= d
    ag, al = gains / period, losses / period
    if al == 0:
        return 100.0
    return round(100 - 100 / (1 + ag / al), 1)


def grade(score: int) -> str:
    if score >= 90:
        return "A+"
    if score >= 80:
        return "A"
    if score >= 70:
        return "B+"
    if score >= 60:
        return "B"
    if score >= 50:
        return "C"
    if score >= 40:
        return "D"
    return "E"


# ---------------------------------------------------------------- wedge
def detect_wedges(candles: list[dict]) -> list[dict]:
    n = len(candles)
    if n < 50:
        return []
    swings = get_swings(candles, 4)
    results: list[dict] = []

    for end in range(4, len(swings) + 1):
        win_size = min(8, max(4, end))
        win = swings[max(0, end - win_size) : end]
        highs = [s for s in win if s["type"] == "H"]
        lows = [s for s in win if s["type"] == "L"]
        if len(highs) < 2 or len(lows) < 2:
            continue
        fit_h = linear_fit([(s["i"], s["price"]) for s in highs])
        fit_l = linear_fit([(s["i"], s["price"]) for s in lows])
        i_min = min(s["i"] for s in win)
        i_max = max(s["i"] for s in win)
        gap0 = eval_line(fit_h, i_min) - eval_line(fit_l, i_min)
        gap1 = eval_line(fit_h, i_max) - eval_line(fit_l, i_max)
        if not (gap0 > 0 and gap1 > 0 and gap1 < gap0 * 0.88):
            continue

        sh, sl = fit_h[0], fit_l[0]
        if sh < 0 and sl < 0:
            wtype, bias = "Falling Wedge", "bullish"
        elif sh > 0 and sl > 0:
            wtype, bias = "Rising Wedge", "bearish"
        elif sh < 0 and sl >= 0:
            wtype, bias = "Contracting Wedge", "bullish"
        elif sh >= 0 and sl < 0:
            wtype, bias = "Expanding-to-Contract", "neutral"
        else:
            wtype, bias = "Symmetrical Wedge", "neutral"

        high = -1e18
        low = 1e18
        high_i = low_i = i_max
        for i in range(i_min, i_max + 1):
            if candles[i]["h"] > high:
                high = candles[i]["h"]
                high_i = i
            if candles[i]["l"] < low:
                low = candles[i]["l"]
                low_i = i

        rng = high - low
        buf = rng * 0.0015 + rng * 0.002
        breakout = None
        look = max(i_max + 1, (i_min + i_max) // 2)
        for i in range(look, n):
            up = eval_line(fit_h, i)
            dn = eval_line(fit_l, i)
            if candles[i]["c"] > up + buf:
                breakout = {"index": i, "type": "up", "price": candles[i]["c"]}
                break
            if candles[i]["c"] < dn - buf:
                breakout = {"index": i, "type": "down", "price": candles[i]["c"]}
                break
        if not breakout:
            continue

        signal = build_signal(candles, i_min, i_max, high, low, fit_h, fit_l, breakout)
        conv = 1 - gap1 / gap0
        score = min(35, conv * 50) + min(15, (len(win) - 3) * 3)
        if signal and signal["type"] in ("SELL", "BUY"):
            score += 30
        elif signal and signal["type"].startswith("WATCH"):
            score += 18
        dist = n - breakout["index"]
        score += max(0, 15 - dist * 0.5)
        if bias == "bearish" and breakout["type"] == "down":
            score += 8
        if bias == "bullish" and breakout["type"] == "up":
            score += 8
        if high_i != low_i:
            score += 4
        score = max(0, min(100, int(round(score))))

        results.append(
            {
                "wtype": wtype,
                "bias": bias,
                "iMin": i_min,
                "iMax": i_max,
                "iHigh": high_i,
                "iLow": low_i,
                "high": high,
                "low": low,
                "fitH": fit_h,
                "fitL": fit_l,
                "swings": win,
                "breakout": breakout,
                "signal": signal,
                "score": score,
                "lines": {
                    "upper": [
                        {"i": i_min, "p": eval_line(fit_h, i_min)},
                        {"i": max(i_max, breakout["index"]) + 4, "p": eval_line(fit_h, max(i_max, breakout["index"]) + 4)},
                    ],
                    "lower": [
                        {"i": i_min, "p": eval_line(fit_l, i_min)},
                        {"i": max(i_max, breakout["index"]) + 4, "p": eval_line(fit_l, max(i_max, breakout["index"]) + 4)},
                    ],
                },
            }
        )

    results.sort(key=lambda r: (-r["score"], -r["iMax"]))
    picked: list[dict] = []
    for r in results:
        if any(
            not (r["iMax"] < p["iMin"] or r["iMin"] > p["iMax"])
            and abs(r["high"] - p["high"]) / (p["high"] or 1) < 0.01
            for p in picked
        ):
            continue
        picked.append(r)
        if len(picked) >= 3:
            break
    return picked


def build_signal(candles, i_min, i_max, high, low, fit_h, fit_l, breakout) -> dict | None:
    n = len(candles)
    bi = breakout["index"]
    window_end = min(n - 1, bi + 24)
    mid = (high + low) / 2

    if breakout["type"] == "down":
        retest_high = -1e18
        retest_high_i = bi
        for i in range(bi, window_end + 1):
            if candles[i]["h"] > retest_high:
                retest_high = candles[i]["h"]
                retest_high_i = i
        for i in range(retest_high_i + 1, window_end + 1):
            c = candles[i]
            lower = eval_line(fit_l, i)
            fail = min(retest_high * 0.998, max(mid, lower))
            if c["c"] < fail and c["c"] < candles[i - 1]["c"]:
                entry = c["c"]
                stop = max(retest_high, high) * 1.002
                tp = entry - (stop - entry) * 2
                return {
                    "type": "SELL",
                    "index": i,
                    "price": entry,
                    "retestHigh": retest_high,
                    "retestHighI": retest_high_i,
                    "level": fail,
                    "stop": stop,
                    "tp": tp,
                    "rr": 2,
                    "reason": f"Breakdown → retest {retest_high:.2f} → close fail → SELL",
                }
        entry = breakout["price"]
        stop = max(high, retest_high) * 1.002
        return {
            "type": "WATCH_SELL",
            "index": bi,
            "price": entry,
            "retestHigh": retest_high,
            "retestHighI": retest_high_i,
            "level": mid,
            "stop": stop,
            "tp": entry - (stop - entry) * 2,
            "rr": 2,
            "reason": "Đã breakdown — chờ retest thất bại để SELL",
        }

    if breakout["type"] == "up":
        retest_low = 1e18
        retest_low_i = bi
        for i in range(bi, window_end + 1):
            if candles[i]["l"] < retest_low:
                retest_low = candles[i]["l"]
                retest_low_i = i
        for i in range(retest_low_i + 1, window_end + 1):
            c = candles[i]
            upper = eval_line(fit_h, i)
            fail = max(retest_low * 1.002, min(mid, upper))
            if c["c"] > fail and c["c"] > candles[i - 1]["c"]:
                entry = c["c"]
                stop = min(retest_low, low) * 0.998
                tp = entry + (entry - stop) * 2
                return {
                    "type": "BUY",
                    "index": i,
                    "price": entry,
                    "retestLow": retest_low,
                    "retestLowI": retest_low_i,
                    "level": fail,
                    "stop": stop,
                    "tp": tp,
                    "rr": 2,
                    "reason": f"Breakout ↑ → retest {retest_low:.2f} → hold → BUY",
                }
        entry = breakout["price"]
        stop = min(low, retest_low) * 0.998
        return {
            "type": "WATCH_BUY",
            "index": bi,
            "price": entry,
            "retestLow": retest_low,
            "retestLowI": retest_low_i,
            "level": mid,
            "stop": stop,
            "tp": entry + (entry - stop) * 2,
            "rr": 2,
            "reason": "Đã breakout lên — chờ pullback hold để BUY",
        }
    return None


# ---------------------------------------------------------------- analysis payload
def fmt_price(n: float | None) -> str:
    if n is None or not isfinite(n):
        return "–"
    a = abs(n)
    d = 2 if a >= 1000 else 3 if a >= 10 else 4 if a >= 1 else 5
    return f"{n:,.{d}f}"


def fmt_time(ts_ms: float) -> str:
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    return dt.strftime("%d/%m %H:%M")


def iso_date(ts_ms: float) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def analyze(ticker: str, interval: str) -> dict:
    meta = SYM_MAP.get(ticker, {"t": ticker, "name": ticker, "sub": "", "cat": "Khác", "unit": ""})
    candles = fetch_yahoo(ticker, interval)
    kijun_arr = kijun_for(candles, interval)
    patterns = detect_wedges(candles)
    p = patterns[0] if patterns else None
    last = candles[-1]
    current_price = last["c"]
    rsi = rsi14(candles)

    patterns_out = [
        {
            "type": x["wtype"],
            "price": x["high"],
            "bias": "BEARISH" if x["bias"] == "bearish" else "BULLISH" if x["bias"] == "bullish" else "NEUTRAL",
            "score": x["score"],
        }
        for x in patterns
    ]

    def tl(which: str) -> dict | None:
        if not p:
            return None
        line = p["lines"][which]
        broken = bool(p["breakout"]) and (
            (which == "lower" and p["breakout"]["type"] == "down")
            or (which == "upper" and p["breakout"]["type"] == "up")
        )
        return {
            "x1_ts": int(candles[line[0]["i"]]["t"] / 1000),
            "x2_ts": int(candles[line[1]["i"]]["t"] / 1000),
            "y1": line[0]["p"],
            "y_end": line[1]["p"],
            "slope_pct": 0.0,
            "broken": broken,
            "from": iso_date(candles[line[0]["i"]]["t"]),
            "kind": "support" if which == "lower" else "resistance",
        }

    base = {
        "symbol": ticker,
        "name": meta["name"],
        "sub": meta["sub"],
        "cat": meta["cat"],
        "unit": meta["unit"],
        "interval": interval,
        "current_price": current_price,
        "rsi": rsi,
        "atr": None,
        "setups": [],
        "patterns": patterns_out,
        "supports": [],
        "resistances": [],
        "support_trendline": tl("lower"),
        "resistance_trendline": tl("upper"),
        "candles": candles,
        "kijun": kijun_arr,
        "grade": "—",
        "support_touches": len(p["swings"]) if p else 0,
        "resistance_touches": len(p["swings"]) if p else 0,
    }

    if not p:
        return base

    sig = p["signal"]
    confirmed = bool(sig and sig["type"] in ("SELL", "BUY"))
    side = "SELL" if (sig and sig["type"] in ("SELL", "WATCH_SELL")) else "BUY"

    checklist = [
        {"ok": True, "text": "Mẫu hình Wedge hội tụ", "value": f"{p['wtype']} · swing {len(p['swings'])} · bias {p['bias']}"},
        {
            "ok": bool(p["breakout"]),
            "text": "Breakout / Breakdown khỏi wedge",
            "value": (
                ("↓ Breakdown" if p["breakout"]["type"] == "down" else "↑ Breakout")
                + f" @ {fmt_price(p['breakout']['price'])}"
                if p["breakout"]
                else "chưa có"
            ),
        },
        {
            "ok": confirmed,
            "text": "Retest xác nhận close (entry)",
            "value": (
                (sig["type"] + " close" if confirmed else sig["type"].replace("WATCH_", "chờ ")) + " · " + sig["reason"]
                if sig
                else "chưa có tín hiệu"
            ),
        },
        {"ok": p["score"] >= 60, "text": "Điểm mẫu hình ≥ 60", "value": f"{p['score']}/100 · {grade(p['score'])}"},
        {
            "ok": p["high"] > p["low"] and p["iHigh"] != p["iLow"],
            "text": "Có High / Low rõ của wedge",
            "value": f"H {fmt_price(p['high'])} · L {fmt_price(p['low'])}",
        },
    ]

    kijun_ok = False
    k = kijun_arr[-1] if kijun_arr else None
    if k is not None:
        kijun_ok = current_price < k if side == "SELL" else current_price > k
        checklist.append(
            {
                "ok": kijun_ok,
                "text": "Giá so với Kijun H4",
                "value": f"K {fmt_price(k)} · giá {fmt_price(current_price)}" + (" (thuận hướng)" if kijun_ok else " (ngược hướng)"),
            }
        )

    passed = sum(1 for c in checklist if c["ok"])
    total = len(checklist)
    score = p["score"]
    if kijun_ok:
        score = min(100, score + 5)
    if not confirmed:
        score = max(0, score - 10)

    entry = sig["price"] if sig else current_price
    if sig:
        sl = sig["stop"]
        tp = sig.get("tp")
        if tp is None:
            tp = entry - (sl - entry) * 2 if side == "SELL" else entry + (entry - sl) * 2
    else:
        sl = p["high"] * 1.002 if side == "SELL" else p["low"] * 0.998
        tp = entry - (sl - entry) * 2 if side == "SELL" else entry + (entry - sl) * 2

    risk = abs(sl - entry) or 1.0
    reward = abs(tp - entry)
    rr = round(reward / risk, 2)

    reasons = [
        f"{p['wtype']} trên {interval} ({p['bias']})",
    ]
    if p["breakout"]:
        reasons.append(
            ("Breakdown" if p["breakout"]["type"] == "down" else "Breakout")
            + " nến "
            + fmt_time(candles[p["breakout"]["index"]]["t"])
        )
    if sig:
        reasons.append(sig["reason"])
    reasons.append(f"High/Low wedge: {fmt_price(p['high'])} / {fmt_price(p['low'])}")

    setup = {
        "type": "SELL" if side == "SELL" else "BUY",
        "source": f"Wedge Scanner · {p['wtype']}",
        "pattern": p["wtype"] + " · " + ("breakdown" if p["breakout"]["type"] == "down" else "breakout"),
        "grade": grade(score),
        "score": score,
        "passed": passed,
        "total": total,
        "entry": round(entry, 6),
        "sl": round(sl, 6),
        "tp": round(tp, 6),
        "rr": rr,
        "rr_ok": rr >= 1.5,
        "confirmed": confirmed,
        "checklist": checklist,
        "reasons": reasons,
        "pattern": p["wtype"] + " · " + ("breakdown" if p["breakout"]["type"] == "down" else "breakout"),
    }

    supports = [p["low"]]
    resistances = [p["high"]]
    if sig and sig.get("level") is not None:
        if side == "SELL":
            resistances.append(sig["level"])
        else:
            supports.append(sig["level"])

    base.update(
        {
            "setups": [setup],
            "supports": supports,
            "resistances": resistances,
            "grade": setup["grade"],
        }
    )
    return base


# ---------------------------------------------------------------- settings
def load_settings() -> dict:
    try:
        if SETTINGS_FILE.exists():
            return json.loads(SETTINGS_FILE.read_text("utf-8"))
    except Exception:
        pass
    return {
        "favorite_symbols": ["GC=F"],
        "interval": "1h",
        "scan_cycle": "manual",
        "auto_scan": False,
        "watchlist": ["GC=F", "CL=F", "BTC-USD", "EURUSD=X", "^GSPC"],
    }


def save_settings(data: dict) -> dict:
    cur = load_settings()
    cur.update(data or {})
    try:
        SETTINGS_FILE.write_text(json.dumps(cur, ensure_ascii=False, indent=2), "utf-8")
    except Exception:
        pass
    return cur


# ---------------------------------------------------------------- routes
@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/api/symbols")
def api_symbols():
    return jsonify({"symbols": SYMBOLS})


@app.get("/api/settings")
def api_get_settings():
    return jsonify(load_settings())


@app.post("/api/settings")
def api_post_settings():
    return jsonify(save_settings(request.get_json(force=True, silent=True) or {}))


@app.get("/api/scan")
def api_scan():
    symbol = request.args.get("symbol", "GC=F")
    interval = request.args.get("interval", "1h")
    try:
        data = analyze(symbol, interval)
        return jsonify(data)
    except Exception as e:
        return jsonify({"detail": str(e)}), 502


@app.get("/api/scan-all")
def api_scan_all():
    interval = request.args.get("interval", "1h")
    out = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(analyze, s["t"], interval): s["t"] for s in SYMBOLS}
        for fut in as_completed(futs):
            t = futs[fut]
            try:
                out[t] = fut.result()
            except Exception as e:
                out[t] = {"error": str(e)}
    return jsonify(out)


@app.get("/api/watchlist-scan")
def api_watchlist_scan():
    interval = request.args.get("interval", "1h")
    only_beautiful = request.args.get("only_beautiful", "false").lower() == "true"
    wl = load_settings().get("watchlist") or [s["t"] for s in SYMBOLS]
    results = []
    scanned = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(analyze, t, interval): t for t in wl}
        for fut in as_completed(futs):
            t = futs[fut]
            scanned += 1
            try:
                d = fut.result()
            except Exception:
                continue
            setups = d.get("setups") or []
            if not setups:
                continue
            s = setups[0]
            if only_beautiful and not (s["passed"] >= min(3, s["total"] - 1) and s["rr"] >= 1.5 and s["score"] >= 55):
                continue
            results.append(
                {
                    "ticker": t,
                    "name": d.get("name"),
                    "cat": d.get("cat"),
                    "direction": s["type"],
                    "grade": s["grade"],
                    "rr": s["rr"],
                    "passed": s["passed"],
                    "total": s["total"],
                    "score": s["score"],
                    "entry": s["entry"],
                    "sl": s["sl"],
                    "tp": s["tp"],
                }
            )
    results.sort(key=lambda x: -x["score"])
    return jsonify({"results": results, "scanned": scanned, "interval": interval})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
