# 0880 Headquarters — Panel de Dashboard Financiero

![Estado](https://img.shields.io/badge/status-activo-brightgreen)
![Docker](https://img.shields.io/badge/docker-listos-2496ED)
![Python](https://img.shields.io/badge/python-3.12-blue)
![Licencia](https://img.shields.io/badge/licencia-MIT-green)

Dashboard financiero en tiempo real con datos de mercado, indicadores técnicos y gráficos interactivos para acciones, cripto y forex. Todos los datos provienen de **APIs gratuitas** — no se requieren API keys.

<p align="center">
  <img src="assets/dashboard-preview.svg" alt="Vista previa del Dashboard" width="800">
</p>

## Funcionalidades

### 📊 Resumen del Mercado
- **Índice de Miedo y Codicia** — Medidor + barra de visualización desde alternative.me
- **Medidor de Fuerza del Mercado** — Compuesto de RSI, MACD, EMA, Bandas de Bollinger, Volumen sobre SPY
- **Tarjetas de Resumen** — Avances/Retrocesos, Mejor/Peor rendimiento, conteo de cripto

### 📈 Acciones y Cripto
- **Pool Dinámico** — 103 acciones muestreadas aleatoriamente cada actualización; 20 criptos obtenidas por capitalización de mercado desde CoinGecko
- **Símbolos Centrales** — AAPL, MSFT, NVDA, TSLA, BTC, ETH, SOL siempre garantizados en los resultados
- **Gráficos de Barras** — Distribución del % de cambio con código de colores
- **Gráfico de Eje Dual** — Barras de precio de cripto superpuestas con línea RSI
- **Rendimiento por Sector** — Gráfico de barras agrupado que muestra el cambio promedio por sector

### 💱 Forex
- 16 pares principales (EUR/USD, GBP/USD, USD/JPY, EUR/JPY, AUD/NZD, etc.)
- Mapa de calor de barras horizontales

### 🔬 Análisis Técnico
- **Modal de Detalle** — Análisis completo para cualquier símbolo:
  - Gráfico de precios con Bandas de Bollinger + pronóstico de regresión lineal
  - Historial RSI con niveles de sobrecompra/sobreventa
  - MACD + Señal + Histograma
  - Barras de volumen
  - Niveles de Soporte/Resistencia
  - Medición de volatilidad
  - Detección de divergencias (RSI alcista/bajista)
  - Desglose de rendimientos semanales
- **Múltiples Marcos de Tiempo** — 1D, 5D, 1M, 3M, 6M, 1Y
- **Radar Técnico** — RSI, MACD, cruce EMA, posición de Bollinger, Volumen

### 🛠 Herramientas
- **Búsqueda de Símbolos** — Agrega cualquier símbolo a la lista de seguimiento mediante búsqueda en Yahoo Finance
- **Lista de Seguimiento** — Persistida en localStorage, muestra precio/RSI/señal de un vistazo
- **Alertas de Precio** — Establece umbrales superior/inferior, notificación del navegador con deduplicación
- **Comparador** — Selecciona 2+ activos, superpone gráfico de rendimientos normalizados
- **Portafolio** — Realiza un seguimiento de las tenencias con P&L en vivo, % de retorno total
- **Matriz de Correlación** — Correlación de Pearson entre 15 acciones centrales (rendimientos diarios a 3 meses)
- **Exportación CSV** — Descarga datos detallados como CSV
- **Exportación PDF** — Imprime el modal de detalle
- **Tema Oscuro/Claro** — Alternar con persistencia en localStorage
- **Tablas Ordenables** — Haz clic en los encabezados para ordenar por cualquier columna
- **Mapa de Calor Semanal** — Rendimientos diarios codificados por colores en todos los activos

### 🔄 Auto-Actualización
Cada 30 segundos. Caché con TTL configurable (60-300s) para evitar límites de velocidad.

## Arquitectura

```
financial-panel/
├── docker-compose.yml          # network_mode: host
├── Dockerfile                  # Python 3.12-slim, uvicorn
├── requirements.txt            # fastapi, uvicorn, httpx
├── app/
│   ├── main.py                 # Backend FastAPI (~870 líneas)
│   └── static/
│       ├── index.html          # Diseño del dashboard
│       ├── style.css           # Tema oscuro/claro con variables CSS
│       └── script.js           # Toda la lógica del frontend (~590 líneas)
```

### Endpoints del Backend

| Endpoint | Descripción |
|----------|-------------|
| `GET /api/fear-greed` | Índice de Miedo y Codicia |
| `GET /api/stocks` | 24 acciones por abs(cambio) |
| `GET /api/crypto` | 12 criptos del top 30 de CoinGecko |
| `GET /api/forex` | 12 pares forex por abs(cambio) |
| `GET /api/indicators` | Indicadores técnicos de SPY |
| `GET /api/detail?symbol=X&timeframe=3mo` | Análisis técnico completo |
| `GET /api/compare?symbols=A,B,C` | Superposición de rendimientos normalizados |
| `GET /api/news?symbol=X` | Noticias RSS de Yahoo Finance |
| `GET /api/correlation` | Correlación de Pearson por pares |
| `GET /api/lookup?symbol=X` | Buscar cualquier símbolo |

## Inicio Rápido

```bash
# Clonar y ejecutar
git clone https://github.com/dev1lsconf/financial-panel.git
cd financial-panel

# Iniciar con Docker
docker compose up -d

# Abrir en el navegador
open http://localhost:8000
```

### Construir sin caché (después de cambios en archivos)

```bash
docker compose down
docker build --no-cache --network host -t financial-panel-panel .
docker compose up -d
```

## Fuentes de Datos

| Fuente | Endpoint | Uso | Límite de Velocidad |
|--------|----------|-----|---------------------|
| [Yahoo Finance](https://finance.yahoo.com/) | `v8/finance/chart` | OHLCV, RSI, MACD, BB | ~10 req/min por IP (suave) |
| [CoinGecko](https://www.coingecko.com/) | `/api/v3/coins/markets` | Capitalización de mercado cripto, precios | ~30 req/min (gratis) |
| [Alternative.me](https://alternative.me/crypto/fear-and-greed-index/) | `/fng/` | Índice de Miedo y Codicia | Sin límite |
| Yahoo RSS | `rss/headline` | Fuente de noticias | Sin límite |

## Limitaciones Conocidas

- Las APIs de screener/quote/tendencias de Yahoo Finance devuelven HTTP 429 desde esta red — no es posible obtener los de mayor movimiento en vivo; se utiliza un pool fijo expandido ordenado por movimiento en tiempo real
- Las criptos sin mapeo en Yahoo Finance (ej. FIGR_HELOC) se omiten
- El nivel gratuito de CoinGecko es de ≈30 llamadas/min, mitigado mediante caché
- Docker requiere `network_mode: host` para configuraciones rootless

## Tags

- `volumen-1` — Versión inicial con todas las funcionalidades principales

## Licencia

MIT
