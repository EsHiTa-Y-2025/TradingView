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

    const quotes = (data.quotes || [])
      .filter(x => x.symbol && (x.quoteType === 'EQUITY' || x.quoteType === 'ETF'))
      .slice(0, 7)
      .map(x => ({
        symbol: x.symbol,
        name: x.shortname || x.longname || x.symbol,
        exchange: x.exchDisp || x.exchange || '',
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

async function fetchBars(symbol, range, interval) {
  const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const r = await fetch(url, { headers: YAHOO_HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (data.chart.error) throw new Error(data.chart.error.description || 'Unknown symbol');

  const result = data.chart.result && data.chart.result[0];
  if (!result) throw new Error('No data returned');

  const quote = result.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < quote.high.length; i++) {
    if (quote.high[i] != null && quote.low[i] != null) {
      bars.push({ high: quote.high[i], low: quote.low[i] });
    }
  }
  const last5 = bars.slice(-5);
  if (last5.length === 0) throw new Error('No complete bars in range');

  const high5 = Math.max(...last5.map(b => b.high));
  const low5 = Math.min(...last5.map(b => b.low));
  return { high5, low5, barsUsed: last5.length };
}

// ---- main endpoint: symbol -> all three timeframes, fully computed ----
app.get('/api/tape', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'missing query param "symbol"' });

  const cacheKey = `tape:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const out = { symbol, timeframes: {} };

  await Promise.all(TIMEFRAMES.map(async (tf) => {
    try {
      const { high5, low5, barsUsed } = await fetchBars(symbol, tf.range, tf.interval);
      const spread = high5 - low5;
      const { steps, root } = digitalRootSteps(spread);
      const effectiveRoot = root === 0 ? 9 : root;
      const result = spread / effectiveRoot;

      out.timeframes[tf.key] = {
        label: tf.label,
        sub: tf.sub,
        high5,
        low5,
        barsUsed,
        spread,
        steps,
        root: effectiveRoot,
        rootWasZero: root === 0,
        result,
      };
    } catch (err) {
      out.timeframes[tf.key] = { label: tf.label, sub: tf.sub, error: err.message };
    }
  }));

  setCached(cacheKey, out);
  res.json(out);
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/', (req, res) => res.send('Reduction Tape API is running. Try /api/tape?symbol=AAPL'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Reduction Tape backend listening on port ${PORT}`));
