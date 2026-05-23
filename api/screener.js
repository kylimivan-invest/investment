/**
 * api/screener.js
 * 全市場選股篩選 API（重構版）
 * - 不依賴 TWSE 股票清單 API
 * - 用 Node.js Runtime（非 Edge），無超時限制問題
 * - 直接從 FinMind PER dataset 取得全市場清單
 * - Edge Cache 6小時
 */

const FINMIND_TOKEN = process.env.FINMIND_TOKEN || '';
const FINMIND_BASE  = 'https://api.finmindtrade.com/api/v4/data';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const forceRefresh = req.query.refresh === '1';

  if (!FINMIND_TOKEN) {
    return res.status(200)
      .setHeader('Cache-Control', 'no-cache')
      .json({ mock: true, error: 'FINMIND_TOKEN 未設定', stocks: getMockStocks(), count: getMockStocks().length, updated: new Date().toISOString() });
  }

  try {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    // 只拉最近 7 天資料（控制資料量，速度快）
    const sevenAgo = new Date(today);
    sevenAgo.setDate(sevenAgo.getDate() - 7);
    const sevenStr = sevenAgo.toISOString().split('T')[0];

    // 只拉最近 30 天股價（計算 MA20 和近期漲跌）
    const thirtyAgo = new Date(today);
    thirtyAgo.setDate(thirtyAgo.getDate() - 30);
    const thirtyStr = thirtyAgo.toISOString().split('T')[0];

    // 並行拉取（PER 包含殖利率/本益比/全市場清單）
    const [perResult, instResult, priceResult] = await Promise.allSettled([
      fetchFinMind('TaiwanStockPER', sevenStr, dateStr),
      fetchFinMind('TaiwanStockInstitutionalInvestors', sevenStr, dateStr),
      fetchFinMind('TaiwanStockPrice', thirtyStr, dateStr),
    ]);

    const perRows   = perResult.status   === 'fulfilled' ? perResult.value   : [];
    const instRows  = instResult.status  === 'fulfilled' ? instResult.value  : [];
    const priceRows = priceResult.status === 'fulfilled' ? priceResult.value : [];

    console.log(`[screener] PER: ${perRows.length}, Inst: ${instRows.length}, Price: ${priceRows.length}`);

    if (perRows.length === 0) {
      throw new Error('PER 資料為空，可能 Token 無效或 FinMind 暫時無法連線');
    }

    const stocks = buildStocks(perRows, instRows, priceRows);

    const cacheHeader = forceRefresh
      ? 'no-cache, no-store'
      : 's-maxage=21600, stale-while-revalidate=3600';

    return res
      .setHeader('Cache-Control', cacheHeader)
      .status(200)
      .json({
        mock: false,
        stocks,
        count: stocks.length,
        updated: new Date().toISOString(),
        debug: {
          per: perRows.length,
          inst: instRows.length,
          price: priceRows.length,
        }
      });

  } catch (err) {
    console.error('[screener] Error:', err.message);
    return res.status(200)
      .setHeader('Cache-Control', 'no-cache')
      .json({ mock: true, error: err.message, stocks: getMockStocks(), count: getMockStocks().length, updated: new Date().toISOString() });
  }
}

// ── FinMind fetch helper ──────────────────────────────────────────
async function fetchFinMind(dataset, startDate, endDate) {
  const params = new URLSearchParams({ dataset, start_date: startDate, end_date: endDate, token: FINMIND_TOKEN });
  const resp = await fetch(`${FINMIND_BASE}?${params}`, {
    headers: { 'User-Agent': 'TWSEDashboard/1.0' },
  });
  if (!resp.ok) throw new Error(`FinMind ${dataset}: HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.status !== 200) throw new Error(`FinMind ${dataset}: ${json.msg}`);
  return json.data || [];
}

// ── 整合資料 ──────────────────────────────────────────────────────
function buildStocks(perRows, instRows, priceRows) {
  // 1. PER map（取每檔股票最新一筆）
  const perMap = {};
  for (const r of perRows) {
    const id = r.stock_id;
    if (!id || !/^\d{4}$/.test(id)) continue; // 只要4碼上市
    if (!perMap[id] || r.date > perMap[id].date) perMap[id] = r;
  }

  // 2. 法人買賣超 map（近5日合計）
  const instMap = buildInstMap(instRows);

  // 3. 股價 map（計算 MA20、漲跌幅）
  const priceMap = buildPriceMap(priceRows);

  // 4. 整合
  return Object.entries(perMap).map(([code, per]) => {
    const inst  = instMap[code]  || {};
    const price = priceMap[code] || {};

    const close  = price.close  || parseFloat(per.stock_price) || 0;
    const yield_ = parseFloat(per.dividend_yield) || 0;
    const pe     = parseFloat(per.PER) || 0;
    const pb     = parseFloat(per.PBR) || 0;

    // 估算 ROE（無財報時用 PBR/PER 近似）
    const roe = (pb > 0 && pe > 0) ? +(pb / pe * 100).toFixed(1) : 10;
    const eps = pe > 0 && close > 0 ? +(close / pe).toFixed(2) : 0;

    const isFinance = FINANCE_CODES.includes(code);

    return {
      code,
      name:    per.stock_name || code,
      sector:  mapSector(code),
      close:   +close.toFixed(2),
      yield_:  +yield_.toFixed(2),
      roe,
      eps,
      debt:    isFinance ? 85 : 45,   // 財報資料，暫用預設
      cr:      isFinance ? null : 150,
      fcf:     true,
      ma20:    price.ma20Above  || false,
      ma60:    price.ma60Above  || false,
      kd:      price.kd         || false,
      foreign: (inst.foreignNet || 0) > 0,
      trust:   (inst.trustNet   || 0) > 0,
      foreignNet: inst.foreignNet || 0,
      trustNet:   inst.trustNet   || 0,
      margin:  30,
      divYears: yield_ > 3 ? 5 : 2,  // 簡化估算
      chg1w:   price.chg1w || 0,
      chg1m:   price.chg1m || 0,
      chg3m:   price.chg3m || 0,
      chg1y:   price.chg1y || 0,
      w52lo:   price.w52lo || close * 0.7,
      w52hi:   price.w52hi || close * 1.3,
      pe:      +pe.toFixed(1),
      pb:      +pb.toFixed(2),
      grossMargin: 20,
      revenueGrowth: 5,
      largeCap: LARGE_CAP_CODES.includes(code),
      ytd:       price.ytd || 0,
      price_jan: price.price_jan || close,
    };
  }).filter(s => s.close > 0);
}

// ── 法人買賣超（近5日各別合計）────────────────────────────────────
function buildInstMap(rows) {
  const map = {};
  // 取最新5個交易日
  const dates = [...new Set(rows.map(r => r.date))].sort().slice(-5);

  for (const r of rows) {
    if (!dates.includes(r.date)) continue;
    const id = r.stock_id;
    if (!id || !/^\d{4}$/.test(id)) continue;
    if (!map[id]) map[id] = { foreignNet: 0, trustNet: 0 };

    // FinMind TaiwanStockInstitutionalInvestors 欄位
    // name 欄位: 外資及陸資, 投信, 自營商
    const name = r.name || '';
    const buy  = parseInt(r.buy  || 0);
    const sell = parseInt(r.sell || 0);
    const net  = buy - sell;

    if (name.includes('外資')) map[id].foreignNet += net;
    else if (name.includes('投信')) map[id].trustNet += net;
  }
  return map;
}

// ── 股價資料（MA20、漲跌幅）──────────────────────────────────────
function buildPriceMap(rows) {
  // 分組
  const byStock = {};
  for (const r of rows) {
    const id = r.stock_id;
    if (!id || !/^\d{4}$/.test(id)) continue;
    if (!byStock[id]) byStock[id] = [];
    byStock[id].push({ date: r.date, close: parseFloat(r.close || r.Close || 0) });
  }

  const map = {};
  for (const [id, arr] of Object.entries(byStock)) {
    const sorted = arr.filter(r => r.close > 0).sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length < 2) continue;

    const closes = sorted.map(r => r.close);
    const n = closes.length;
    const latest = closes[n - 1];

    // MA
    const ma20  = n >= 20 ? avg(closes.slice(-20)) : avg(closes);
    const ma60  = n >= 60 ? avg(closes.slice(-60)) : ma20;

    // 漲跌幅
    const chg1w = pct(closes, Math.min(5,  n - 1));
    const chg1m = pct(closes, Math.min(20, n - 1));
    const chg3m = pct(closes, Math.min(60, n - 1));
    const chg1y = pct(closes, Math.min(252,n - 1));

    // 52W 高低
    const slice52 = closes.slice(-252);
    const w52hi = Math.max(...slice52);
    const w52lo = Math.min(...slice52);

    // YTD
    const ytdEntry = sorted.find(r => r.date >= '2026-01-01');
    const price_jan = ytdEntry ? ytdEntry.close : closes[0];
    const ytd = price_jan > 0 ? +((latest - price_jan) / price_jan * 100).toFixed(2) : 0;

    // KD（簡化）
    const kd = computeKD(closes);

    map[id] = {
      close: +latest.toFixed(2),
      ma20Above:  latest > ma20,
      ma60Above:  latest > ma60,
      kd,
      chg1w: +chg1w.toFixed(2),
      chg1m: +chg1m.toFixed(2),
      chg3m: +chg3m.toFixed(2),
      chg1y: +chg1y.toFixed(2),
      w52hi: +w52hi.toFixed(2),
      w52lo: +w52lo.toFixed(2),
      ytd, price_jan: +price_jan.toFixed(2),
    };
  }
  return map;
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function pct(closes, periods) {
  const n = closes.length;
  if (n <= periods || periods <= 0) return 0;
  const prev = closes[n - 1 - periods];
  return prev > 0 ? (closes[n - 1] - prev) / prev * 100 : 0;
}
function computeKD(closes, period = 9) {
  if (closes.length < period + 2) return false;
  const sl = closes.slice(-(period + 2));
  let k = 50, d = 50;
  for (let i = period - 1; i < sl.length; i++) {
    const w = sl.slice(i - period + 1, i + 1);
    const hi = Math.max(...w), lo = Math.min(...w);
    const rsv = hi === lo ? 50 : (sl[i] - lo) / (hi - lo) * 100;
    k = (2/3) * k + (1/3) * rsv;
    d = (2/3) * d + (1/3) * k;
  }
  return k > d && k > 20 && k < 80;
}

// ── 產業別對應 ────────────────────────────────────────────────────
const SECTOR_MAP = {
  semi:     ['2330','2454','2303','2379','2408','3711','2337','3034','2344','6274'],
  finance:  ['2882','2881','2886','2891','2892','2884','2885','2880','2887','2888','5876','2823','2836'],
  tech:     ['2317','2308','2357','2382','4938','2345','6669','2382','3231','2395'],
  trad:     ['2412','3045','4904','2498'],
  chem:     ['1301','1303','1326'],
  steel:    ['2002','2008','2014'],
  shipping: ['2603','2609','2615','2610'],
  biotech:  ['4720','6446','4168','1722'],
};
function mapSector(code) {
  for (const [sec, codes] of Object.entries(SECTOR_MAP)) {
    if (codes.includes(code)) return sec;
  }
  return 'other';
}

// ── 大型股清單（股本 > 500億）────────────────────────────────────
const LARGE_CAP_CODES = ['2330','2317','2454','2882','2881','2886','2891','2892','2884','2885','2880','2002','1301','1303','2412','3045','2382','3711','2303','2408','2308'];
const FINANCE_CODES   = ['2882','2881','2886','2891','2892','2884','2885','2880','2887','2888','5876','2823','2836','2838'];

// ── Mock 資料 ─────────────────────────────────────────────────────
function getMockStocks() {
  return [
    { code:'2330',name:'台積電',  sector:'semi',   close:2255,yield_:2.8, roe:29.2,eps:72.5,debt:21,cr:295, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:15,divYears:16,chg1w:1.12, chg1m:8.4,  chg3m:32.1, chg1y:115.2,w52lo:785, w52hi:2285,pe:31,largeCap:true, ytd:57.2, price_jan:1433,foreignNet:15420,trustNet:3240,grossMargin:58,revenueGrowth:35,pb:9.1 },
    { code:'2454',name:'聯發科',  sector:'semi',   close:3155,yield_:3.8, roe:26.5,eps:98.2,debt:25,cr:345, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:18,divYears:8, chg1w:9.93, chg1m:48.2, chg3m:115.3,chg1y:185.2,w52lo:992, w52hi:3155,pe:32,largeCap:true, ytd:115.8,price_jan:1461,foreignNet:8520, trustNet:5680,grossMargin:52,revenueGrowth:42,pb:8.4 },
    { code:'2882',name:'國泰金',  sector:'finance',close:76.2, yield_:5.8, roe:13.2,eps:5.8, debt:86,cr:null,fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:10,divYears:11,chg1w:0.92, chg1m:5.2,  chg3m:18.4, chg1y:42.1, w52lo:58,  w52hi:78,  pe:13,largeCap:true, ytd:25.9, price_jan:60.5, foreignNet:3210, trustNet:1540,grossMargin:null,revenueGrowth:8,pb:1.7 },
    { code:'2881',name:'富邦金',  sector:'finance',close:105.5,yield_:5.2, roe:16.2,eps:8.8, debt:83,cr:null,fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:8, divYears:9, chg1w:0.85, chg1m:6.5,  chg3m:22.5, chg1y:48.2, w52lo:78,  w52hi:108, pe:12,largeCap:true, ytd:28.4, price_jan:82.2,  foreignNet:2840, trustNet:980, grossMargin:null,revenueGrowth:12,pb:1.9},
    { code:'2886',name:'兆豐金',  sector:'finance',close:48.5, yield_:6.8, roe:12.8,eps:3.8, debt:85,cr:null,fcf:true,ma20:true, ma60:true, kd:false,foreign:true, trust:false,margin:8, divYears:12,chg1w:0.62, chg1m:3.2,  chg3m:12.5, chg1y:28.4, w52lo:38,  w52hi:52,  pe:13,largeCap:true, ytd:18.5, price_jan:40.9,  foreignNet:1820, trustNet:0,   grossMargin:null,revenueGrowth:5, pb:1.5},
    { code:'2308',name:'台達電',  sector:'tech',   close:458,  yield_:3.5, roe:20.5,eps:26.8,debt:36,cr:208, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:22,divYears:10,chg1w:1.33, chg1m:8.5,  chg3m:22.4, chg1y:62.3, w52lo:285, w52hi:468, pe:17,largeCap:true, ytd:28.1, price_jan:357,   foreignNet:4320, trustNet:2100,grossMargin:32,revenueGrowth:22,pb:3.5 },
    { code:'2317',name:'鴻海',    sector:'tech',   close:239.5,yield_:4.2, roe:9.2, eps:12.4,debt:52,cr:132, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:10,divYears:7, chg1w:5.27, chg1m:12.2, chg3m:28.5, chg1y:58.4, w52lo:152, w52hi:252, pe:19,largeCap:true, ytd:22.4, price_jan:196,   foreignNet:12450,trustNet:3800,grossMargin:7, revenueGrowth:18,pb:1.8 },
    { code:'2412',name:'中華電',  sector:'trad',   close:128.5,yield_:5.4, roe:10.8,eps:5.8, debt:40,cr:162, fcf:true,ma20:true, ma60:true, kd:false,foreign:false,trust:false,margin:5, divYears:20,chg1w:0.39, chg1m:1.8,  chg3m:3.2,  chg1y:8.5,  w52lo:120, w52hi:132, pe:22,largeCap:true, ytd:2.0,  price_jan:126,   foreignNet:-320, trustNet:-180,grossMargin:38,revenueGrowth:2, pb:2.4 },
    { code:'2379',name:'瑞昱',    sector:'semi',   close:852,  yield_:4.2, roe:22.8,eps:42.5,debt:18,cr:395, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:22,divYears:8, chg1w:2.16, chg1m:12.5, chg3m:28.8, chg1y:48.5, w52lo:542, w52hi:875, pe:20,largeCap:false,ytd:38.5, price_jan:615,   foreignNet:2840, trustNet:1520,grossMargin:58,revenueGrowth:25,pb:4.5 },
    { code:'2345',name:'智邦',    sector:'tech',   close:385,  yield_:4.8, roe:24.5,eps:22.5,debt:24,cr:325, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:18,divYears:8, chg1w:2.10, chg1m:15.2, chg3m:35.8, chg1y:68.5, w52lo:198, w52hi:395, pe:17,largeCap:false,ytd:38.5, price_jan:278,   foreignNet:1840, trustNet:920, grossMargin:40,revenueGrowth:28,pb:4.2 },
  ];
}
