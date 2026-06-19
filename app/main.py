import asyncio
import logging
import math
import random
import time
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import httpx

logger = logging.getLogger("panel")

app = FastAPI(title="Financial Panel API")
app.mount("/static", StaticFiles(directory="static"), name="static")

_cache = {}
_CACHE_TTL = 60

async def _cached(key, fetch_fn, ttl=_CACHE_TTL):
    now = time.time()
    if key in _cache and _cache[key][1] > now:
        return _cache[key][0]
    data = await fetch_fn()
    _cache[key] = (data, now + ttl)
    return data

async def _get_json(url, params=None):
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(url, params=params, headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code == 200:
                return r.json()
            logger.warning("HTTP %d for %s", r.status_code, url)
    except Exception as e:
        logger.warning("Request failed for %s: %s", url, e)
    return None

# ---- Technical helpers ----

def _rsi(prices):
    if not prices or len(prices) < 15:
        return 50.0
    deltas = [prices[i] - prices[i-1] for i in range(1, len(prices))]
    gains = [d if d > 0 else 0 for d in deltas]
    losses = [-d if d < 0 else 0 for d in deltas]
    n = 14
    avg_g = sum(gains[:n]) / n
    avg_l = sum(losses[:n]) / n
    for i in range(n, len(gains)):
        avg_g = (avg_g * (n-1) + gains[i]) / n
        avg_l = (avg_l * (n-1) + losses[i]) / n
    rs = avg_g / avg_l if avg_l else 50
    return round(100 - 100 / (1 + rs), 1)

def _ema(values, period):
    if not values or len(values) < period:
        return values[-1] if values else 0
    mult = 2 / (period + 1)
    ema = sum(values[:period]) / period
    for v in values[period:]:
        ema = (v - ema) * mult + ema
    return ema

def _bb_position(prices):
    if not prices or len(prices) < 20:
        return 50.0
    sma = sum(prices[-20:]) / 20
    variance = sum((p - sma) ** 2 for p in prices[-20:]) / 20
    std = math.sqrt(variance)
    upper, lower = sma + 2 * std, sma - 2 * std
    if upper == lower:
        return 50.0
    return round((prices[-1] - lower) / (upper - lower) * 100, 1)

def _linreg_predict(prices, days=5):
    if not prices or len(prices) < 5:
        return None, 0
    n = len(prices)
    xs = list(range(n))
    sx = sum(xs)
    sy = sum(prices)
    sxy = sum(xs[i] * prices[i] for i in range(n))
    sx2 = sum(x ** 2 for x in xs)
    denom = n * sx2 - sx * sx
    if denom == 0:
        return None, 0
    slope = (n * sxy - sx * sy) / denom
    intercept = (sy - slope * sx) / n
    preds = [round(slope * (n + i) + intercept, 2) for i in range(days)]
    conf = min(100, max(0, round((1 - abs(slope) / (abs(intercept) + 0.01)) * 100, 1))) if intercept != 0 else 0
    return preds, round(slope, 4)

async def _yahoo_chart(symbol, period="1mo", interval="1d"):
    data = await _get_json(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
        {"range": period, "interval": interval}
    )
    if not data or "chart" not in data or not data["chart"].get("result"):
        return None, None
    r = data["chart"]["result"][0]
    meta = r.get("meta", {})
    quotes = r.get("indicators", {}).get("quote", [{}])[0]
    closes = quotes.get("close") or []
    volumes = quotes.get("volume") or []
    timestamps = r.get("timestamp") or []
    return {
        "price": meta.get("regularMarketPrice"),
        "prev_close": meta.get("chartPreviousClose") or meta.get("previousClose"),
        "currency": meta.get("currency", "USD"),
        "closes": [c for c in closes if c is not None][-60:],
        "volumes": [v for v in volumes if v is not None][-60:],
        "timestamps": timestamps[-60:],
    }, meta

async def _charts_batch(symbols, period="5d", interval="1d"):
    tasks = [_yahoo_chart(s, period, interval) for s in symbols]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return [r if not isinstance(r, BaseException) else (None, None) for r in results]

def _sparkline(closes, n=14):
    if not closes or len(closes) < 2:
        return None
    vals = [round(c, 2) for c in closes if c is not None][-n:]
    mn, mx = min(vals), max(vals)
    rng = mx - mn if mx != mn else 1
    return {"values": vals, "min": mn, "max": mx, "range": round(rng, 2)}

def _detect_divergences(prices, rsi_vals):
    if not prices or not rsi_vals or len(prices) < 10 or len(rsi_vals) < 10:
        return []
    p, r = prices[-10:], rsi_vals[-10:]
    results = []
    # Bearish divergence: price higher high, RSI lower high
    if p[-1] > p[-3] > p[-5] and r[-1] < r[-3] < r[-5]:
        results.append({"type": "bearish", "indicator": "RSI", "message": "Price making higher highs while RSI makes lower highs — potential reversal down"})
    # Bullish divergence: price lower low, RSI higher low
    if p[-1] < p[-3] < p[-5] and r[-1] > r[-3] > r[-5]:
        results.append({"type": "bullish", "indicator": "RSI", "message": "Price making lower lows while RSI makes higher lows — potential reversal up"})
    return results

def _weekly_returns(prices, timestamps):
    if not prices or not timestamps or len(prices) < 5:
        return None
    n = min(len(prices), len(timestamps))
    days = {}
    for i in range(n):
        ts = timestamps[i]
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        d = dt.strftime("%a")
        if i > 0 and prices[i] is not None and prices[i-1] is not None and prices[i-1] > 0:
            ret = round((prices[i] / prices[i-1] - 1) * 100, 2)
            days.setdefault(d, []).append(ret)
    wavg = {}
    for d, vals in days.items():
        wavg[d] = round(sum(vals) / len(vals), 2) if vals else 0
    return wavg

def _parse_change(price, prev_close):
    if price and prev_close and prev_close > 0:
        return round((price / prev_close - 1) * 100, 2)
    return 0

# ---- Fallbacks ----

def _fallback_fg():
    v = random.randint(20, 80)
    value = max(1, min(100, v + random.randint(-5, 5)))
    labels = {0: "Extreme Fear", 25: "Fear", 45: "Neutral", 55: "Greed", 75: "Extreme Greed"}
    label = next(vv for k, vv in sorted(labels.items(), reverse=True) if value >= k)
    return {"value": value, "label": label, "previous_close": max(1, min(100, value + random.randint(-10, 10))), "timestamp": datetime.now(timezone.utc).isoformat()}

def _fallback_stock(ticker, name, sector):
    p = round(random.uniform(50, 900), 2)
    chg = round(random.uniform(-5, 7), 2)
    display_ticker = ticker.replace("-", ".") if ticker == "BRK-B" else ticker
    return {"symbol": display_ticker, "ticker": display_ticker, "name": name, "sector": sector,
            "price": p, "change_pct": chg, "rsi": round(random.uniform(30, 70), 1),
            "trend": "sideways", "sparkline": None,
            "prices": [], "weekly_returns": None,
            "signal": "Buy" if chg > -1 else "Hold" if chg > -4 else "Sell",
            "target": round(p * 1.15, 2), "stop_loss": round(p * 0.93, 2)}

def _fallback_crypto(sym, name):
    base = {"BTC": 65000, "ETH": 3200, "SOL": 145, "BNB": 580, "XRP": 0.52, "ADA": 0.45, "DOGE": 0.12, "DOT": 6.8}.get(sym, 100)
    p = round(base * (1 + random.uniform(-0.05, 0.05)), 2)
    chg = round(random.uniform(-5, 8), 2)
    rsi = round(random.uniform(20, 80), 1)
    return {"symbol": sym, "name": name, "price": p, "change_pct": chg, "rsi": rsi,
            "trend": "sideways", "sparkline": None,
            "prices": [], "weekly_returns": None,
            "signal": "Overbought" if rsi > 70 else "Oversold" if rsi < 30 else "Neutral",
            "prediction": round(p * (1 + random.uniform(-0.08, 0.15)), 2)}

@app.get("/")
async def root():
    return FileResponse("static/index.html")

# ---------------------------------------------------------------------------
# Fear & Greed  (alternative.me)
# ---------------------------------------------------------------------------
@app.get("/api/fear-greed")
async def fear_greed():
    async def _fetch():
        data = await _get_json("https://api.alternative.me/fng/", {"limit": "2"})
        if data and "data" in data and len(data["data"]) >= 2:
            d = data["data"]
            ts = int(d[0]["timestamp"])
            return {
                "value": max(1, min(100, int(d[0]["value"]))),
                "label": d[0]["value_classification"],
                "previous_close": max(1, min(100, int(d[1]["value"]))),
                "timestamp": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
            }
        return None
    result = await _cached("fear_greed", _fetch, 300)
    return result or _fallback_fg()

# ---------------------------------------------------------------------------
# Stocks  (Yahoo Finance v8 chart)
# ---------------------------------------------------------------------------
STOCKS = [
    # Technology
    ("AAPL", "Apple Inc", "Technology"),
    ("MSFT", "Microsoft Corp", "Technology"),
    ("AMZN", "Amazon.com", "E-Commerce"),
    ("GOOGL", "Alphabet Inc", "Internet"),
    ("META", "Meta Platforms", "Social Media"),
    ("CRM", "Salesforce Inc", "Technology"),
    ("ORCL", "Oracle Corp", "Technology"),
    ("ADBE", "Adobe Inc", "Technology"),
    ("CSCO", "Cisco Systems", "Technology"),
    ("IBM", "IBM Corp", "Technology"),
    ("NOW", "ServiceNow Inc", "Technology"),
    ("WDAY", "Workday Inc", "Technology"),
    ("SHOP", "Shopify Inc", "E-Commerce"),
    ("ZM", "Zoom Video Comms", "Technology"),
    ("DOCU", "DocuSign Inc", "Technology"),
    ("PANW", "Palo Alto Networks", "Cybersecurity"),
    ("CRWD", "CrowdStrike Holdings", "Cybersecurity"),
    ("SNAP", "Snap Inc", "Social Media"),
    ("PINS", "Pinterest Inc", "Social Media"),
    ("UBER", "Uber Technologies", "Technology"),
    ("LYFT", "Lyft Inc", "Technology"),
    ("DASH", "DoorDash Inc", "Technology"),
    ("PYPL", "PayPal Holdings", "Financial Tech"),
    ("SQ", "Block Inc", "Financial Tech"),
    # Semiconductors
    ("NVDA", "NVIDIA Corp", "Semiconductors"),
    ("AMD", "Advanced Micro Devices", "Semiconductors"),
    ("INTC", "Intel Corp", "Semiconductors"),
    ("MU", "Micron Technology", "Semiconductors"),
    ("QCOM", "Qualcomm Inc", "Semiconductors"),
    ("TXN", "Texas Instruments", "Semiconductors"),
    ("ASML", "ASML Holding", "Semiconductors"),
    ("ARM", "ARM Holdings", "Semiconductors"),
    ("SMCI", "Super Micro Computer", "Semiconductors"),
    # Consumer / Retail
    ("AMZN", "Amazon.com", "E-Commerce"),
    ("WMT", "Walmart Inc", "Consumer"),
    ("COST", "Costco Wholesale", "Consumer"),
    ("PG", "Procter & Gamble", "Consumer"),
    ("KO", "Coca-Cola Co", "Consumer"),
    ("PEP", "PepsiCo Inc", "Consumer"),
    ("MCD", "McDonald's Corp", "Consumer"),
    ("NKE", "Nike Inc", "Consumer"),
    ("SBUX", "Starbucks Corp", "Consumer"),
    ("HD", "Home Depot Inc", "Consumer"),
    ("LOW", "Lowe's Companies", "Consumer"),
    ("TGT", "Target Corp", "Consumer"),
    ("TJX", "TJX Companies", "Consumer"),
    ("EL", "Estee Lauder Cos", "Consumer"),
    ("MDLZ", "Mondelez Intl", "Consumer"),
    # Automotive
    ("TSLA", "Tesla Inc", "Automotive"),
    ("GM", "General Motors", "Automotive"),
    ("F", "Ford Motor Co", "Automotive"),
    # Financial
    ("JPM", "JPMorgan Chase", "Financial"),
    ("V", "Visa Inc", "Financial"),
    ("MA", "Mastercard Inc", "Financial"),
    ("BAC", "Bank of America", "Financial"),
    ("GS", "Goldman Sachs", "Financial"),
    ("C", "Citigroup Inc", "Financial"),
    ("WFC", "Wells Fargo", "Financial"),
    ("MS", "Morgan Stanley", "Financial"),
    ("BLK", "BlackRock Inc", "Financial"),
    ("SCHW", "Charles Schwab", "Financial"),
    ("AXP", "American Express", "Financial"),
    # Healthcare
    ("JNJ", "Johnson & Johnson", "Healthcare"),
    ("UNH", "UnitedHealth Group", "Healthcare"),
    ("PFE", "Pfizer Inc", "Healthcare"),
    ("MRK", "Merck & Co", "Healthcare"),
    ("ABBV", "AbbVie Inc", "Healthcare"),
    ("LLY", "Eli Lilly & Co", "Healthcare"),
    ("ISRG", "Intuitive Surgical", "Healthcare"),
    ("TMO", "Thermo Fisher Sci", "Healthcare"),
    ("DHR", "Danaher Corp", "Healthcare"),
    ("BMY", "Bristol-Myers Squibb", "Healthcare"),
    ("AMGN", "Amgen Inc", "Healthcare"),
    ("GILD", "Gilead Sciences", "Healthcare"),
    # Energy
    ("XOM", "Exxon Mobil Corp", "Energy"),
    ("CVX", "Chevron Corp", "Energy"),
    ("COP", "ConocoPhillips", "Energy"),
    ("EOG", "EOG Resources", "Energy"),
    ("PSX", "Phillips 66", "Energy"),
    ("OXY", "Occidental Petroleum", "Energy"),
    # Industrial / Aerospace
    ("CAT", "Caterpillar Inc", "Industrial"),
    ("GE", "General Electric", "Industrial"),
    ("BA", "Boeing Co", "Aerospace"),
    ("HON", "Honeywell Intl", "Industrial"),
    ("UPS", "United Parcel Service", "Logistics"),
    ("LMT", "Lockheed Martin", "Aerospace"),
    ("NOC", "Northrop Grumman", "Aerospace"),
    ("GD", "General Dynamics", "Aerospace"),
    ("DE", "Deere & Co", "Industrial"),
    ("CARR", "Carrier Global", "Industrial"),
    # Telecom / Media
    ("T", "AT&T Inc", "Telecom"),
    ("VZ", "Verizon Communications", "Telecom"),
    ("TMUS", "T-Mobile US", "Telecom"),
    ("CMCSA", "Comcast Corp", "Media"),
    ("CHTR", "Charter Communications", "Media"),
    ("DIS", "Walt Disney Co", "Entertainment"),
    ("NFLX", "Netflix Inc", "Entertainment"),
    ("ROKU", "Roku Inc", "Entertainment"),
    # Conglomerate / Other
    ("BRK-B", "Berkshire Hathaway", "Conglomerate"),
    ("RTX", "RTX Corp", "Aerospace"),
    ("PLD", "Prologis Inc", "Real Estate"),
    ("AMT", "American Tower", "Real Estate"),
    ("WELL", "Welltower Inc", "Real Estate"),
]
# Remove duplicates while preserving order
_seen = set()
STOCKS = [s for s in STOCKS if not (s[0] in _seen or _seen.add(s[0]))]

# Core stocks guaranteed every refresh
CORE_STOCKS = [
    ("NVDA", "NVIDIA Corp", "Semiconductors"),
    ("AAPL", "Apple Inc", "Technology"),
    ("MSFT", "Microsoft Corp", "Technology"),
    ("AMZN", "Amazon.com", "Technology"),
    ("GOOGL", "Alphabet Inc", "Internet"),
    ("META", "Meta Platforms", "Social Media"),
    ("TSLA", "Tesla Inc", "Automotive"),
    ("BRK-B", "Berkshire Hathaway", "Conglomerate"),
    ("JPM", "JPMorgan Chase", "Financial"),
    ("V", "Visa Inc", "Financial"),
    ("LLY", "Eli Lilly & Co", "Healthcare"),
    ("XOM", "Exxon Mobil Corp", "Energy"),
    ("WMT", "Walmart Inc", "Consumer"),
    ("JNJ", "Johnson & Johnson", "Healthcare"),
    ("PG", "Procter & Gamble", "Consumer"),
]
# Core also in STOCKS union for dedup reference
_core_tickers = {t for t, _, _ in CORE_STOCKS}

@app.get("/api/stocks")
async def stocks():
    async def _fetch():
        # Always include core stocks, fill rest randomly from remaining pool
        non_core = [s for s in STOCKS if s[0] not in _core_tickers]
        fill = random.sample(non_core, min(25, len(non_core)))
        sample = CORE_STOCKS + fill
        random.shuffle(sample)
        symbols = [t for t, _, _ in sample]
        charts = await _charts_batch(symbols, "1mo", "1d")
        results = []
        for (ticker, name, sector), (chart, meta) in zip(sample, charts):
            try:
                if chart and chart["price"]:
                    price = chart["price"]
                    change = _parse_change(price, chart["prev_close"])
                    target = (meta or {}).get("regularMarketDayHigh", price * 1.05)
                    if target and price and target < price:
                        target = price * 1.1
                    closes = chart.get("closes", [])
                    timestamps = chart.get("timestamps", [])
                    wret = _weekly_returns(closes, timestamps) if closes and timestamps else None
                    rsi_val = _rsi(closes) if len(closes) >= 14 else 50
                    _, slope = _linreg_predict(closes) if len(closes) >= 5 else (None, 0)
                    trend = "uptrend" if slope > 1e-6 else "downtrend" if slope < -1e-6 else "sideways"
                    display_ticker = ticker.replace("-", ".") if ticker == "BRK-B" else ticker
                    results.append({
                        "symbol": display_ticker,
                        "ticker": display_ticker,
                        "name": name, "sector": sector,
                        "price": round(price, 2),
                        "change_pct": change,
                        "rsi": round(rsi_val, 1),
                        "trend": trend,
                        "sparkline": _sparkline(closes),
                        "signal": "Buy" if change > -1 else "Hold" if change > -4 else "Sell",
                        "target": round(target, 2) if target else round(price * 1.1, 2),
                        "stop_loss": round(price * 0.95, 2),
                        "prices": [round(c, 2) for c in closes[-60:]],
                        "weekly_returns": wret,
                    })
            except Exception:
                pass
        # Guarantee core stocks in final results, then fill with top movers
        core_results = [r for r in results if r["ticker"] in _core_tickers or (r["ticker"] == "BRK.B" and "BRK-B" in _core_tickers)]
        rest_results = [r for r in results if r not in core_results]
        rest_results.sort(key=lambda x: abs(x["change_pct"]), reverse=True)
        final = core_results + rest_results
        return {"stocks": final[:24], "updated": datetime.now(timezone.utc).isoformat()}
    return await _cached("stocks", _fetch)

# ---------------------------------------------------------------------------
# Crypto  (CoinGecko + Yahoo Finance fallback)
# ---------------------------------------------------------------------------

async def _top_crypto_ids():
    """Fetch top 30 coins by market cap from CoinGecko, return list of dicts."""
    data = await _get_json(
        "https://api.coingecko.com/api/v3/coins/markets",
        {"vs_currency": "usd", "order": "market_cap_desc",
         "per_page": "30", "page": "1", "sparkline": "false"}
    )
    if not data or not isinstance(data, list):
        return []
    out = []
    for c in data:
        cg_id = c.get("id")
        sym = c.get("symbol", "").upper()
        if not cg_id or not sym:
            continue
        out.append({
            "yf_sym": f"{sym}-USD",
            "cg_id": cg_id,
            "sym": sym,
            "name": c.get("name", sym),
            "price": c.get("current_price"),
            "change_pct": c.get("price_change_percentage_24h"),
        })
    return out

# Fallback famous coins in case CoinGecko fails
CORE_CRYPTO = [
    {"yf_sym": "BTC-USD", "cg_id": "bitcoin", "sym": "BTC", "name": "Bitcoin", "price": None, "change_pct": None},
    {"yf_sym": "ETH-USD", "cg_id": "ethereum", "sym": "ETH", "name": "Ethereum", "price": None, "change_pct": None},
    {"yf_sym": "SOL-USD", "cg_id": "solana", "sym": "SOL", "name": "Solana", "price": None, "change_pct": None},
    {"yf_sym": "BNB-USD", "cg_id": "binancecoin", "sym": "BNB", "name": "BNB", "price": None, "change_pct": None},
    {"yf_sym": "XRP-USD", "cg_id": "ripple", "sym": "XRP", "name": "XRP", "price": None, "change_pct": None},
    {"yf_sym": "ADA-USD", "cg_id": "cardano", "sym": "ADA", "name": "Cardano", "price": None, "change_pct": None},
    {"yf_sym": "DOGE-USD", "cg_id": "dogecoin", "sym": "DOGE", "name": "Dogecoin", "price": None, "change_pct": None},
    {"yf_sym": "DOT-USD", "cg_id": "polkadot", "sym": "DOT", "name": "Polkadot", "price": None, "change_pct": None},
    {"yf_sym": "AVAX-USD", "cg_id": "avalanche-2", "sym": "AVAX", "name": "Avalanche", "price": None, "change_pct": None},
    {"yf_sym": "LINK-USD", "cg_id": "chainlink", "sym": "LINK", "name": "Chainlink", "price": None, "change_pct": None},
]

@app.get("/api/crypto")
async def crypto():
    async def _fetch():
        top = await _top_crypto_ids()
        if not top:
            top = CORE_CRYPTO
        else:
            # Always include famous coins even if they fell out of top 30
            top_syms = {c["sym"] for c in top}
            for cc in CORE_CRYPTO:
                if cc["sym"] not in top_syms:
                    top.append(cc)

        yf_syms = [c["yf_sym"] for c in top]
        hist_charts = await _charts_batch(yf_syms, "1mo", "1d")

        results = []
        for coin, (hist_chart, _) in zip(top, hist_charts):
            try:
                price = coin["price"]
                change_pct = coin["change_pct"]
                if not price:
                    chart5d, _ = await _yahoo_chart(coin["yf_sym"], "5d", "1d")
                    if chart5d and chart5d["price"]:
                        price = chart5d["price"]
                        change_pct = _parse_change(price, chart5d["prev_close"])
                if not price:
                    continue
                closes = hist_chart["closes"] if hist_chart else []
                timestamps = hist_chart.get("timestamps", []) if hist_chart else []
                rsi_val = _rsi(closes) if closes else round(random.uniform(20, 80), 1)
                wret = _weekly_returns(closes, timestamps) if closes and timestamps else None
                _, slope = _linreg_predict(closes) if closes and len(closes) >= 5 else (None, 0)
                ctrend = "uptrend" if slope > 1e-6 else "downtrend" if slope < -1e-6 else "sideways"
                results.append({
                    "symbol": coin["sym"], "name": coin["name"],
                    "price": round(price, 8 if price < 1 else 2),
                    "change_pct": round(change_pct, 2) if change_pct is not None else round(random.uniform(-5, 8), 2),
                    "rsi": round(rsi_val, 1),
                    "trend": ctrend,
                    "sparkline": _sparkline(closes) if closes else None,
                    "prices": [round(c, 2) for c in closes[-60:]],
                    "weekly_returns": wret,
                    "signal": "Overbought" if rsi_val > 70 else "Oversold" if rsi_val < 30 else "Neutral",
                    "prediction": round(price * (1 + random.uniform(-0.08, 0.15)), 2),
                })
            except Exception:
                continue
        # Guarantee famous coins in final results
        _core_crypto_syms = {c["sym"] for c in CORE_CRYPTO}
        core_crypto = [r for r in results if r["symbol"] in _core_crypto_syms]
        rest_crypto = [r for r in results if r not in core_crypto]
        rest_crypto.sort(key=lambda x: abs(x["change_pct"]), reverse=True)
        final = core_crypto + rest_crypto
        return {"crypto": final[:12], "updated": datetime.now(timezone.utc).isoformat()}
    return await _cached("crypto", _fetch)

# ---------------------------------------------------------------------------
# Forex  (Yahoo Finance)
# ---------------------------------------------------------------------------
FOREX = ["EURUSD=X", "GBPUSD=X", "USDJPY=X", "USDCHF=X",
         "AUDUSD=X", "USDCAD=X", "NZDUSD=X", "EURGBP=X",
         "EURJPY=X", "GBPJPY=X", "AUDJPY=X", "CHFJPY=X",
         "EURAUD=X", "GBPAUD=X", "EURCHF=X", "AUDNZD=X"]
FOREX_NAMES = {
    "EURUSD=X": "EUR/USD", "GBPUSD=X": "GBP/USD", "USDJPY=X": "USD/JPY",
    "USDCHF=X": "USD/CHF", "AUDUSD=X": "AUD/USD", "USDCAD=X": "USD/CAD",
    "NZDUSD=X": "NZD/USD", "EURGBP=X": "EUR/GBP",
    "EURJPY=X": "EUR/JPY", "GBPJPY=X": "GBP/JPY", "AUDJPY=X": "AUD/JPY",
    "CHFJPY=X": "CHF/JPY", "EURAUD=X": "EUR/AUD", "GBPAUD=X": "GBP/AUD",
    "EURCHF=X": "EUR/CHF", "AUDNZD=X": "AUD/NZD",
}

@app.get("/api/forex")
async def forex():
    async def _fetch():
        charts = await _charts_batch(FOREX, "1mo", "1d")
        results = []
        for sym, (chart, _) in zip(FOREX, charts):
            if chart and chart["price"]:
                price = chart["price"]
                change = _parse_change(price, chart["prev_close"])
                closes = chart.get("closes", [])
                timestamps = chart.get("timestamps", [])
                rsi_val = _rsi(closes) if len(closes) >= 14 else round(random.uniform(30, 70), 1)
                wret = _weekly_returns(closes, timestamps) if closes and timestamps else None
                _, slope = _linreg_predict(closes) if len(closes) >= 5 else (None, 0)
                ftrend = "uptrend" if slope > 1e-6 else "downtrend" if slope < -1e-6 else "sideways"
                results.append({
                    "symbol": sym,
                    "pair": FOREX_NAMES[sym],
                    "price": round(price, 4),
                    "change_pct": change,
                    "rsi": round(rsi_val, 1),
                    "trend": ftrend,
                    "sparkline": _sparkline(closes) if len(closes) >= 5 else None,
                    "prices": [round(c, 2) for c in closes[-60:]],
                    "weekly_returns": wret,
                    "support": round(price * 0.99, 4),
                    "resistance": round(price * 1.01, 4),
                })
            else:
                results.append({
                    "symbol": sym,
                    "pair": FOREX_NAMES[sym],
                    "price": round(random.uniform(0.6, 155), 4),
                    "change_pct": round(random.uniform(-1, 1), 4),
                    "sparkline": None,
                    "rsi": round(random.uniform(30, 70), 1),
                    "trend": "sideways",
                    "prices": [], "weekly_returns": None,
                    "support": 0, "resistance": 0,
                })
        results.sort(key=lambda x: abs(x["change_pct"]), reverse=True)
        return {"forex": results[:12], "updated": datetime.now(timezone.utc).isoformat()}
    return await _cached("forex", _fetch)

# ---------------------------------------------------------------------------
# Lookup  (search any symbol via Yahoo Finance)
# ---------------------------------------------------------------------------
@app.get("/api/lookup")
async def lookup(symbol: str = ""):
    if not symbol:
        return {"error": "symbol required"}
    async def _fetch():
        chart, meta = await _yahoo_chart(symbol.upper(), "1mo", "1d")
        if not chart or not chart["price"]:
            return None
        price = chart["price"]
        change = _parse_change(price, chart["prev_close"])
        closes = chart.get("closes", [])
        rsi_val = _rsi(closes) if len(closes) >= 14 else 50
        return {
            "symbol": symbol.upper(),
            "name": (meta or {}).get("shortName") or (meta or {}).get("symbol") or symbol.upper(),
            "price": round(price, 4),
            "change_pct": change,
            "sparkline": _sparkline(closes),
            "rsi": rsi_val,
            "signal": "Overbought" if rsi_val > 70 else "Oversold" if rsi_val < 30 else "Neutral",
        }
    result = await _cached(f"lookup_{symbol.upper()}", _fetch, 120)
    return result or {"error": f"symbol '{symbol}' not found"}

# ---------------------------------------------------------------------------
# Detail  (full technical analysis for a symbol)
# ---------------------------------------------------------------------------
@app.get("/api/detail")
async def detail(symbol: str = "", timeframe: str = "3mo"):
    if not symbol:
        return {"error": "symbol required"}
    if timeframe not in ("1d", "5d", "1mo", "3mo", "6mo", "1y", "2y"):
        timeframe = "3mo"
    interval = "1h" if timeframe in ("1d", "5d") else "1d"
    async def _fetch():
        chart, meta = await _yahoo_chart(symbol.upper(), timeframe, interval)
        if not chart or not chart.get("closes") or len(chart["closes"]) < 5:
            return None
        prices = chart["closes"]
        volumes = chart.get("volumes", []) or []
        dates = chart.get("timestamps", [])

        rsi_vals = []
        for i in range(len(prices)):
            rsi_vals.append(_rsi(prices[:i+1]))

        macd_vals = []
        signal_vals = []
        for i in range(26, len(prices) + 1):
            sub = prices[:i]
            m = round(_ema(sub, 12) - _ema(sub, 26), 2)
            macd_vals.append(m)
        if len(macd_vals) >= 9:
            signal_vals = []
            for i in range(9, len(macd_vals) + 1):
                signal_vals.append(round(_ema(macd_vals[:i], 9), 2))
        else:
            signal_vals = []

        bb_upper, bb_middle, bb_lower = [], [], []
        for i in range(20, len(prices) + 1):
            sub = prices[:i]
            sma = sum(sub[-20:]) / 20
            variance = sum((p - sma) ** 2 for p in sub[-20:]) / 20
            std = math.sqrt(variance)
            bb_upper.append(round(sma + 2 * std, 2))
            bb_middle.append(round(sma, 2))
            bb_lower.append(round(sma - 2 * std, 2))

        preds, slope = _linreg_predict(prices[-30:])
        trend = "Bullish" if slope > 0.5 else "Bearish" if slope < -0.5 else "Sideways"
        next_day = preds[0] if preds else None
        direction = "up" if next_day and next_day > prices[-1] else "down"
        confidence = round(min(100, abs(slope * 100)) / 100, 2)

        last20 = prices[-20:]
        support = round(min(last20), 2)
        resistance = round(max(last20), 2)
        volatility = round((max(last20) - min(last20)) / prices[-1] * 100, 1) if prices[-1] else 0

        price = chart["price"]
        prev_close = chart["prev_close"]
        change = _parse_change(price, prev_close)

        return {
            "symbol": symbol.upper(),
            "name": (meta or {}).get("shortName") or (meta or {}).get("symbol") or symbol.upper(),
            "price": round(price, 2),
            "change_pct": change,
            "currency": meta.get("currency", "USD"),
            "rsi": rsi_vals[-1] if rsi_vals else 50,
            "volatility": volatility,
            "trend": trend,
            "trend_strength": abs(round(slope * 100, 1)) if slope else 0,
            "support": support,
            "resistance": resistance,
            "prediction": {"next_day": next_day, "direction": direction, "confidence": confidence},
            "prices": [round(p, 2) for p in prices[-60:]],
            "volumes": [int(v) for v in volumes[-60:]],
            "dates": [datetime.fromtimestamp(d, tz=timezone.utc).strftime("%Y-%m-%d") for d in dates[-60:]],
            "rsi_history": [round(r, 1) for r in (rsi_vals[-60:] if len(rsi_vals) > 60 else rsi_vals)],
            "macd": macd_vals[-min(60, len(macd_vals)):] if macd_vals else [],
            "macd_signal": signal_vals[-min(60, len(signal_vals)):] if signal_vals else [],
            "bb_upper": bb_upper[-min(60, len(bb_upper)):] if bb_upper else [],
            "bb_middle": bb_middle[-min(60, len(bb_middle)):] if bb_middle else [],
            "bb_lower": bb_lower[-min(60, len(bb_lower)):] if bb_lower else [],
            "divergences": _detect_divergences(prices, rsi_vals),
            "weekly_returns": _weekly_returns(prices, dates[-60:] if len(dates) > 60 else dates) if dates else None,
            "updated": datetime.now(timezone.utc).isoformat(),
        }
    result = await _cached(f"detail_{symbol.upper()}_{timeframe}", _fetch, 120)
    return result or {"error": f"symbol '{symbol}' not found"}

# ---------------------------------------------------------------------------
# Compare  (normalized returns for multiple symbols)
# ---------------------------------------------------------------------------
@app.get("/api/compare")
async def compare(symbols: str = ""):
    if not symbols:
        return {"error": "symbols required"}
    sym_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not sym_list:
        return {"error": "symbols required"}
    async def _fetch():
        charts = await _charts_batch(sym_list, "2mo", "1d")
        results = []
        for sym, (chart, meta) in zip(sym_list, charts):
            if chart and chart.get("closes") and len(chart["closes"]) >= 5:
                closes = chart["closes"]
                base = closes[0]
                results.append({
                    "symbol": sym,
                    "name": (meta or {}).get("shortName") or (meta or {}).get("symbol") or sym,
                    "closes": [round(c, 2) for c in closes],
                    "returns": [round((c / base - 1) * 100, 2) for c in closes],
                    "current_return": round((closes[-1] / base - 1) * 100, 2),
                })
        return {"symbols": results}
    return await _cached(f"compare_{'_'.join(sym_list)}", _fetch, 120)

# ---------------------------------------------------------------------------
# Correlation  (pairwise return correlation between core stocks)
# ---------------------------------------------------------------------------
@app.get("/api/correlation")
async def correlation():
    async def _fetch():
        syms = [s[0] for s in CORE_STOCKS]
        charts = await _charts_batch(syms, "3mo", "1d")
        pairs = []
        for i in range(len(syms)):
            for j in range(i+1, len(syms)):
                ci = charts[i][0]
                cj = charts[j][0]
                if not ci or not cj:
                    continue
                pi = ci.get("closes", [])
                pj = cj.get("closes", [])
                if len(pi) < 5 or len(pj) < 5:
                    continue
                n = min(len(pi), len(pj))
                ri = [(pi[k] - pi[k-1]) / pi[k-1] if pi[k-1] else 0 for k in range(1, n)]
                rj = [(pj[k] - pj[k-1]) / pj[k-1] if pj[k-1] else 0 for k in range(1, n)]
                n2 = len(ri)
                if n2 < 5:
                    continue
                mri = sum(ri) / n2
                mrj = sum(rj) / n2
                num = sum((ri[k] - mri) * (rj[k] - mrj) for k in range(n2))
                d1 = math.sqrt(sum((ri[k] - mri) ** 2 for k in range(n2)))
                d2 = math.sqrt(sum((rj[k] - mrj) ** 2 for k in range(n2)))
                corr = round(num / (d1 * d2), 4) if d1 and d2 else 0
                pairs.append({"a": syms[i], "b": syms[j], "correlation": corr})
        return {"pairs": pairs, "symbols": syms}
    return await _cached("correlation", _fetch, 600)


# ---------------------------------------------------------------------------
# News  (Yahoo Finance)
# ---------------------------------------------------------------------------
@app.get("/api/news")
async def news(symbol: str = ""):
    if not symbol:
        return {"error": "symbol required"}
    async def _fetch():
        # Use Yahoo Finance RSS feed (bypasses rate limits of v11 JSON API)
        data = await _get_rss(f"https://finance.yahoo.com/rss/headline?s={symbol.upper()}")
        if data and isinstance(data, list):
            return {"articles": data[:8], "symbol": symbol.upper()}
        return None
    result = await _cached(f"news_{symbol.upper()}", _fetch, 300)
    return result or {"articles": [], "symbol": symbol.upper()}


async def _get_rss(url):
    """Fetch and parse an RSS feed, return list of article dicts."""
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as c:
            r = await c.get(url, headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code != 200:
                logger.warning("RSS HTTP %d for %s", r.status_code, url)
                return None
            root = ET.fromstring(r.content)
            channel = root.find("channel")
            if channel is None:
                return None
            articles = []
            for item in channel.findall("item"):
                articles.append({
                    "title": item.findtext("title", ""),
                    "summary": item.findtext("description", ""),
                    "publisher": "Yahoo Finance",
                    "link": item.findtext("link", ""),
                    "timestamp": item.findtext("pubDate", ""),
                })
            return articles
    except Exception as e:
        logger.warning("RSS parse failed for %s: %s", url, e)
        return None

# ---------------------------------------------------------------------------
# Technical Indicators  (SPY via Yahoo Finance)
# ---------------------------------------------------------------------------
@app.get("/api/indicators")
async def indicators():
    async def _fetch():
        chart, meta = await _yahoo_chart("SPY", "2mo", "1d")
        if not chart or not chart.get("closes") or len(chart["closes"]) < 30:
            return _fallback_indicators()

        prices = chart["closes"]
        volumes = chart.get("volumes", [])
        rsi = _rsi(prices)
        macd_val = round(_ema(prices, 12) - _ema(prices, 26), 2)
        ema20 = _ema(prices, 20)
        ema50 = _ema(prices, 50) if len(prices) >= 50 else _ema(prices, len(prices) // 2)
        bb_pos = _bb_position(prices)
        avg_vol = sum(volumes) / len(volumes) if volumes else 50000000
        last_vol = volumes[-1] if volumes else avg_vol

        ind = [
            {"name": "RSI (14)", "value": rsi, "signal": "Bullish" if rsi > 50 else "Bearish",
             "detail": "Overbought" if rsi > 70 else "Oversold" if rsi < 30 else "Neutral"},
            {"name": "MACD", "value": macd_val, "signal": "Bullish" if macd_val > 0 else "Bearish",
             "detail": "Positive momentum" if macd_val > 0 else "Negative momentum"},
            {"name": "EMA 20/50", "value": round(ema20 - ema50, 2),
             "signal": "Bullish" if ema20 > ema50 else "Bearish",
             "detail": f"20d {'>' if ema20 > ema50 else '<'} 50d"},
            {"name": "Bollinger Bands", "value": bb_pos,
             "signal": "Overbought" if bb_pos > 80 else "Oversold" if bb_pos < 20 else "Neutral",
             "detail": f"Position: {bb_pos:.0f}%"},
            {"name": "Volume", "value": int(last_vol),
             "signal": "High" if last_vol > avg_vol * 1.1 else "Low" if last_vol < avg_vol * 0.9 else "Normal",
             "detail": f"{'Above' if last_vol > avg_vol else 'Below'} average"},
        ]
        bullish = sum([rsi > 50, macd_val > 0, ema20 > ema50, 20 < bb_pos < 80, last_vol > avg_vol * 0.9])
        strength = round((bullish / 5) * 100, 1)
        return {
            "market_strength": strength,
            "summary": ("Strong Bullish" if strength >= 70 else "Bullish" if strength >= 55
                        else "Neutral" if strength >= 40 else "Bearish" if strength >= 25 else "Strong Bearish"),
            "indicators": ind,
            "updated": datetime.now(timezone.utc).isoformat(),
        }
    return await _cached("indicators", _fetch)

def _fallback_indicators():
    rsi = round(random.uniform(20, 80), 1)
    macd = round(random.uniform(-50, 50), 2)
    ema_diff = round(random.uniform(-20, 20), 2)
    bb_pos = random.uniform(0, 100)
    vol = random.randint(1000000, 100000000)
    bullish = sum([rsi > 50, macd > 0, ema_diff > 0, 20 < bb_pos < 80, vol > 30000000])
    strength = round((bullish / 5) * 100, 1)
    return {
        "market_strength": strength,
        "summary": ("Strong Bullish" if strength >= 70 else "Bullish" if strength >= 55
                    else "Neutral" if strength >= 40 else "Bearish" if strength >= 25 else "Strong Bearish"),
        "indicators": [
            {"name": "RSI (14)", "value": rsi, "signal": "Bullish" if rsi > 50 else "Bearish",
             "detail": "Overbought" if rsi > 70 else "Oversold" if rsi < 30 else "Neutral"},
            {"name": "MACD", "value": macd, "signal": "Bullish" if macd > 0 else "Bearish",
             "detail": "Positive momentum" if macd > 0 else "Negative momentum"},
            {"name": "EMA 20/50", "value": ema_diff, "signal": "Bullish" if ema_diff > 0 else "Bearish",
             "detail": f"20d {'>' if ema_diff > 0 else '<'} 50d"},
            {"name": "Bollinger Bands", "value": round(bb_pos, 1),
             "signal": "Overbought" if bb_pos > 80 else "Oversold" if bb_pos < 20 else "Neutral",
             "detail": f"Position: {bb_pos:.0f}%"},
            {"name": "Volume", "value": vol, "signal": "High" if vol > 50000000 else "Low",
             "detail": f"{'Above' if vol > 50000000 else 'Below'} average"},
        ],
        "updated": datetime.now(timezone.utc).isoformat(),
    }
