import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors()); // allow the GitHub Pages frontend (or any origin) to call this API

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; ReductionTape/1.0)' };

// ---- tiny in-memory cache so repeated requests don't hammer Yahoo ----
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function getCached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.data;
  return null;
}
function setCached(key, data) {
  cache.set(key, { data, time: Date.now() });
}

// ---- company name -> ticker search ----
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'missing query param "q"' });

  const cacheKey = `search:${q.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `${YAHOO_SEARCH}?q=${encodeURIComponent(q)}&quotesCount=7&newsCount=0`;
    const r = await fetch(url, { headers: YAHOO_HEADERS });
    if (!r.ok) throw new Error(`Yahoo search HTTP ${r.status}`);
    const data = await r.json();

    const ALLOWED_TYPES = new Set(['EQUITY', 'ETF', 'INDEX']);
    const quotes = (data.quotes || [])
      .filter(x => x.symbol && ALLOWED_TYPES.has(x.quoteType))
      .slice(0, 7)
      .map(x => ({
        symbol: x.symbol,
        name: x.shortname || x.longname || x.symbol,
        exchange: x.exchDisp || x.exchange || '',
        type: x.quoteType,
      }));

    setCached(cacheKey, quotes);
    res.json(quotes);
  } catch (err) {
    res.status(502).json({ error: 'search failed', detail: err.message });
  }
});

// ---- digital root reduction ----
function digitalRootSteps(n) {
  const steps = [];
  let cur = Math.round(n);
  if (cur === 0) return { steps, root: 0 };
  while (cur >= 10) {
    const digits = String(cur).split('').map(Number);
    const next = digits.reduce((a, b) => a + b, 0);
    steps.push(`${digits.join(' + ')} = ${next}`);
    cur = next;
  }
  return { steps, root: cur };
}

const TIMEFRAMES = [
  { key: '5D', label: '5-Day', sub: 'Last 5 daily bars', range: '1mo', interval: '1d' },
  { key: '5W', label: '5-Week', sub: 'Last 5 weekly bars', range: '6mo', interval: '1wk' },
  { key: '5M', label: '5-Month', sub: 'Last 5 monthly bars', range: '2y', interval: '1mo' },
];

// Fetch raw bars (date/high/low/close) for a symbol using either a relative
// range ("1mo","6mo",...) or an explicit period1/period2 unix-second window.
async function fetchRawBars(symbol, { range, interval, period1, period2 }) {
  let url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=${interval}`;
  url += (period1 != null && period2 != null)
    ? `&period1=${period1}&period2=${period2}`
    : `&range=${range}`;

  const r = await fetch(url, { headers: YAHOO_HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (data.chart.error) throw new Error(data.chart.error.description || 'Unknown symbol');

  const result = data.chart.result && data.chart.result[0];
  if (!result) throw new Error('No data returned');

  const timestamps = result.timestamp || [];
  const quote = result.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < quote.high.length; i++) {
    if (quote.high[i] != null && quote.low[i] != null) {
      bars.push({
        date: timestamps[i] ? new Date(timestamps[i] * 1000).toISOString().slice(0, 10) : null,
        high: quote.high[i],
        low: quote.low[i],
        close: quote.close[i] != null ? quote.close[i] : null,
      });
    }
  }
  return bars;
}

async function fetchBars(symbol, range, interval, count = 5) {
  const bars = await fetchRawBars(symbol, { range, interval });
  const lastN = bars.slice(-count);
  if (lastN.length === 0) throw new Error('No complete bars in range');

  const high = Math.max(...lastN.map(b => b.high));
  const low = Math.min(...lastN.map(b => b.low));
  return { high, low, barsUsed: lastN.length };
}

// Most recent completed trading day's OHLC, used as the "last day" reference
// for the derived metrics (uptdpt, lptdpt, SP, BP).
async function fetchLastDayBar(symbol) {
  const bars = await fetchRawBars(symbol, { range: '5d', interval: '1d' });
  const withClose = bars.filter(b => b.close != null);
  if (withClose.length === 0) throw new Error('No recent daily bar available');
  return withClose[withClose.length - 1];
}

// From a trade point (spread / digital root) and the last day's OHLC, derive
// the four extra metrics the user asked for.
function deriveMetrics(tradePoint, lastDay) {
  return {
    uptdpt: tradePoint + lastDay.close,
    lptdpt: tradePoint - lastDay.close,
    SP: lastDay.low + tradePoint,
    BP: lastDay.high - tradePoint,
  };
}

function computeTradePoint(high, low) {
  const spread = high - low;
  const { steps, root } = digitalRootSteps(spread);
  const effectiveRoot = root === 0 ? 9 : root;
  const tradePoint = spread / effectiveRoot;
  return { spread, steps, root: effectiveRoot, rootWasZero: root === 0, tradePoint };
}

// ---- main endpoint: symbol -> all three timeframes, fully computed ----
app.get('/api/tape', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'missing query param "symbol"' });

  const cacheKey = `tape:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const out = { symbol, timeframes: {} };

  let lastDay = null;
  let lastDayError = null;
  try {
    lastDay = await fetchLastDayBar(symbol);
  } catch (err) {
    lastDayError = err.message;
  }

  await Promise.all(TIMEFRAMES.map(async (tf) => {
    try {
      const { high, low, barsUsed } = await fetchBars(symbol, tf.range, tf.interval, 5);
      const { spread, steps, root, rootWasZero, tradePoint } = computeTradePoint(high, low);

      const entry = {
        label: tf.label,
        sub: tf.sub,
        high5: high,
        low5: low,
        barsUsed,
        spread,
        steps,
        root,
        rootWasZero,
        tradePoint,
      };

      if (lastDay) {
        entry.lastDay = lastDay;
        Object.assign(entry, deriveMetrics(tradePoint, lastDay));
      } else {
        entry.metricsError = lastDayError || 'last-day data unavailable';
      }

      out.timeframes[tf.key] = entry;
    } catch (err) {
      out.timeframes[tf.key] = { label: tf.label, sub: tf.sub, error: err.message };
    }
  }));

  setCached(cacheKey, out);
  res.json(out);
});

// ---- custom date-range endpoint: same trade-point math over a user-chosen window ----
app.get('/api/range', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  const start = (req.query.start || '').trim();
  const end = (req.query.end || '').trim();

  if (!symbol) return res.status(400).json({ error: 'missing query param "symbol"' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: 'start and end must be dates in YYYY-MM-DD format' });
  }

  const period1 = Math.floor(new Date(`${start}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(new Date(`${end}T23:59:59Z`).getTime() / 1000);
  if (!(period1 < period2)) {
    return res.status(400).json({ error: 'start date must be before end date' });
  }

  const cacheKey = `range:${symbol}:${start}:${end}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const bars = await fetchRawBars(symbol, { interval: '1d', period1, period2 });
    if (bars.length === 0) throw new Error('No trading data in that date range');

    const high = Math.max(...bars.map(b => b.high));
    const low = Math.min(...bars.map(b => b.low));
    const { spread, steps, root, rootWasZero, tradePoint } = computeTradePoint(high, low);

    // "Last day" for a custom range means the most recent bar within that
    // range (not necessarily today), since the range may be historical.
    const withClose = bars.filter(b => b.close != null);
    if (withClose.length === 0) throw new Error('No closing prices in that date range');
    const lastDay = withClose[withClose.length - 1];

    const out = {
      symbol,
      start,
      end,
      high,
      low,
      barsUsed: bars.length,
      spread,
      steps,
      root,
      rootWasZero,
      tradePoint,
      lastDay,
      ...deriveMetrics(tradePoint, lastDay),
    };

    setCached(cacheKey, out);
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/', (req, res) => res.send('Reduction Tape API is running. Try /api/tape?symbol=AAPL'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Reduction Tape backend listening on port ${PORT}`));
