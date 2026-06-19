# 0880 Headquarters — Financial Dashboard Panel

![Dashboard Preview](https://img.shields.io/badge/status-active-brightgreen)
![Docker](https://img.shields.io/badge/docker-ready-2496ED)
![Python](https://img.shields.io/badge/python-3.12-blue)
![License](https://img.shields.io/badge/license-MIT-green)

Real-time financial dashboard with live market data, technical indicators, and interactive charts for stocks, crypto, and forex. All data from **free APIs** — no API keys required.

<p align="center">
  <img src="assets/dashboard-preview.svg" alt="Dashboard Preview" width="800">
</p>

## Features

### 📊 Market Overview
- **Fear & Greed Index** — Gauge + bar visualization from alternative.me
- **Market Strength Meter** — Composite of RSI, MACD, EMA, Bollinger Bands, Volume on SPY
- **Overview Cards** — Advancers/Decliners, Best/Worst performers, Crypto count

### 📈 Stocks & Crypto
- **Dynamic Pool** — 103 stocks sampled randomly each refresh; 20 cryptos fetched by market cap from CoinGecko
- **Core Symbols** — AAPL, MSFT, NVDA, TSLA, BTC, ETH, SOL always guaranteed in results
- **Bar Charts** — Change % distribution with color coding
- **Dual-Axis Chart** — Crypto price bars overlayed with RSI line
- **Sector Performance** — Grouped bar chart showing average change by sector

### 💱 Forex
- 16 major pairs (EUR/USD, GBP/USD, USD/JPY, EUR/JPY, AUD/NZD, etc.)
- Horizontal bar heatmap

### 🔬 Technical Analysis
- **Detail Modal** — Full analysis for any symbol:
  - Price chart with Bollinger Bands + linear regression forecast
  - RSI history with overbought/oversold levels
  - MACD + Signal + Histogram
  - Volume bars
  - Support/Resistance levels
  - Volatility measurement
  - Divergence detection (RSI bullish/bearish)
  - Weekly returns breakdown
- **Multiple Timeframes** — 1D, 5D, 1M, 3M, 6M, 1Y
- **Technical Radar** — RSI, MACD, EMA crossover, Bollinger position, Volume

### 🛠 Tools
- **Symbol Search** — Add any symbol to watchlist via Yahoo Finance lookup
- **Watchlist** — Persisted in localStorage, shows price/RSI/signal at a glance
- **Price Alerts** — Set above/below thresholds, browser notification with dedup
- **Compare Tool** — Select 2+ assets, overlay normalized returns chart
- **Portfolio Tracker** — Track holdings with live P&L, total return %
- **Correlation Matrix** — Pearson correlation between 15 core stocks (3-month daily returns)
- **CSV Export** — Download detail data as CSV
- **PDF Export** — Print detail modal
- **Dark/Light Theme** — Toggle with localStorage persistence
- **Sortable Tables** — Click headers to sort by any column
- **Weekly Heatmap** — Color-coded daily returns across all assets

### 🔄 Auto-Refresh
Every 30 seconds. Cache with configurable TTL (60-300s) to avoid rate limits.

## Architecture

```
financial-panel/
├── docker-compose.yml          # network_mode: host
├── Dockerfile                  # Python 3.12-slim, uvicorn
├── requirements.txt            # fastapi, uvicorn, httpx
├── app/
│   ├── main.py                 # FastAPI backend (~870 lines)
│   └── static/
│       ├── index.html          # Dashboard layout
│       ├── style.css           # Dark/light theme with CSS variables
│       └── script.js           # All frontend logic (~590 lines)
```

### Backend Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/fear-greed` | Fear & Greed Index |
| `GET /api/stocks` | 24 stocks by abs(change) |
| `GET /api/crypto` | 12 cryptos from CoinGecko top 30 |
| `GET /api/forex` | 12 forex pairs by abs(change) |
| `GET /api/indicators` | SPY technical indicators |
| `GET /api/detail?symbol=X&timeframe=3mo` | Full technical analysis |
| `GET /api/compare?symbols=A,B,C` | Normalized returns overlay |
| `GET /api/news?symbol=X` | Yahoo Finance RSS news |
| `GET /api/correlation` | Pairwise Pearson correlation |
| `GET /api/lookup?symbol=X` | Search any symbol |

## Quick Start

```bash
# Clone and run
git clone https://github.com/dev1lsconf/financial-panel.git
cd financial-panel

# Start with Docker
docker compose up -d

# Open browser
open http://localhost:8000
```

### Build without cache (after file changes)

```bash
docker compose down
docker build --no-cache --network host -t financial-panel-panel .
docker compose up -d
```

## Data Sources

| Source | Endpoint | Usage | Rate Limit |
|--------|----------|-------|------------|
| [Yahoo Finance](https://finance.yahoo.com/) | `v8/finance/chart` | OHLCV, RSI, MACD, BB | ~10 req/min per IP (soft) |
| [CoinGecko](https://www.coingecko.com/) | `/api/v3/coins/markets` | Crypto market cap, prices | ~30 req/min (free) |
| [Alternative.me](https://alternative.me/crypto/fear-and-greed-index/) | `/fng/` | Fear & Greed Index | No limit |
| Yahoo RSS | `rss/headline` | News feed | No limit |

## Known Limitations

- Yahoo Finance screener/quote/trending APIs return HTTP 429 from this network — cannot fetch live top-movers; uses expanded hardcoded pool sorted by real-time movement
- Crypto without Yahoo Finance mapping (e.g., FIGR_HELOC) are skipped
- CoinGecko free tier ≈30 calls/min, mitigated by caching
- Docker requires `network_mode: host` for rootless setups

## Tags

- `volumen 1` — Initial release with all core features

## License

MIT
