/**
 * api/screener.js
 * 全市場選股篩選 API
 * 資料來源：FinMind（需 FINMIND_TOKEN）
 *
 * 呼叫方式：
 *   GET /api/screener
 *   GET /api/screener?refresh=1   強制重新拉資料（忽略快取）
 *
 * 回傳格式：
 *   {
 *     stocks: [ { code, name, close, yield_, roe, eps, debt, cr, ... }, ... ],
 *     count: 982,
 *     updated: "2026-05-23T08:30:00Z",
 *     mock: false
 *   }
 *
 * 快取策略：
 *   Vercel Edge Cache 6小時（s-maxage=21600）
 *   第一次呼叫約 10-20 秒，之後從快取回應（毫秒級）
 */

const FINMIND_TOKEN = process.env.FINMIND_TOKEN || '';
const FINMIND_BASE  = 'https://api.finmindtrade.com/api/v4/data';

// 上市股票代號清單（TWSE 股票代號範圍）
// 用 TWSE 開放資料動態取得，不需要手動維護
const TWSE_LISTED_URL = 'https://opendata.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const TWSE_COMPANY_URL = 'https://opendata.twse.com.tw/v1/company/COMPANY';

export const config = {
  runtime: 'edge', // 使用 Edge Runtime，啟動更快
};

export default async function handler(req) {
  // ── CORS ──────────────────────────────────────────────────────
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const forceRefresh = url.searchParams.get('refresh') === '1';

  // ── 無 Token 時回傳 Mock 資料 ──────────────────────────────────
  if (!FINMIND_TOKEN) {
    return new Response(JSON.stringify({
      mock: true,
      error: 'FINMIND_TOKEN 未設定',
      message: '請在 Vercel Environment Variables 設定 FINMIND_TOKEN',
      stocks: getMockStocks(),
      count: getMockStocks().length,
      updated: new Date().toISOString(),
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'no-cache',
      },
    });
  }

  try {
    // Step 1: 取得全市場股票清單（TWSE 開放資料，免費）
    const stockList = await fetchStockList();
    if (!stockList || stockList.length === 0) {
      throw new Error('無法取得股票清單');
    }

    // Step 2: 從 FinMind 拉各類財務資料
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    // 財務資料取最近一季（3個月前）
    const quarterAgo = new Date(today);
    quarterAgo.setMonth(quarterAgo.getMonth() - 3);
    const quarterStr = quarterAgo.toISOString().split('T')[0];
    // 技術資料取最近60天（計算MA20/MA60/KD）
    const sixtyAgo = new Date(today);
    sixtyAgo.setDate(sixtyAgo.getDate() - 90);
    const sixtyStr = sixtyAgo.toISOString().split('T')[0];

    // 並行拉取所有資料
    const [perData, instData, marginData, priceData] = await Promise.allSettled([
      fetchFinMind('TaiwanStockPER', quarterStr, dateStr),          // 殖利率、本益比
      fetchFinMind('TaiwanStockInstitutionalInvestors', quarterStr, dateStr), // 三大法人
      fetchFinMind('TaiwanStockMarginPurchaseShortSale', quarterStr, dateStr),// 融資融券
      fetchFinMind('TaiwanStockPrice', sixtyStr, dateStr),          // 股價（算MA/KD）
    ]);

    // Step 3: 整合資料
    const stocks = integrateData(
      stockList,
      perData.status === 'fulfilled' ? perData.value : [],
      instData.status === 'fulfilled' ? instData.value : [],
      marginData.status === 'fulfilled' ? marginData.value : [],
      priceData.status === 'fulfilled' ? priceData.value : [],
    );

    const result = {
      mock: false,
      stocks,
      count: stocks.length,
      updated: new Date().toISOString(),
      data_sources: {
        per: perData.status,
        inst: instData.status,
        margin: marginData.status,
        price: priceData.status,
      }
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        ...corsHeaders,
        // Edge Cache: 6小時快取，允許過期後1小時內繼續使用舊資料
        'Cache-Control': forceRefresh
          ? 'no-cache, no-store'
          : 's-maxage=21600, stale-while-revalidate=3600',
      },
    });

  } catch (err) {
    console.error('[screener] Error:', err.message);
    // 出錯時回傳 Mock 資料，確保前端不會白畫面
    return new Response(JSON.stringify({
      mock: true,
      error: err.message,
      stocks: getMockStocks(),
      count: getMockStocks().length,
      updated: new Date().toISOString(),
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'no-cache',
      },
    });
  }
}

// ── 取得 TWSE 全上市股票清單 ─────────────────────────────────────
async function fetchStockList() {
  try {
    const res = await fetch(TWSE_COMPANY_URL, {
      headers: { 'User-Agent': 'TWSEDashboard/1.0' },
    });
    if (!res.ok) throw new Error(`TWSE company list error: ${res.status}`);
    const data = await res.json();

    // TWSE 欄位：公司代號, 公司簡稱, 產業別...
    return (data || [])
      .filter(s => s['公司代號'] && /^\d{4}$/.test(s['公司代號'])) // 只取4碼上市
      .map(s => ({
        code: s['公司代號'],
        name: s['公司簡稱'] || s['公司代號'],
        sector: s['產業別'] || '其他',
        capital: parseFloat(s['實收資本額'] || 0),
      }));
  } catch (err) {
    console.warn('[screener] TWSE list fallback:', err.message);
    // 備援：用固定的主要股票清單
    return FALLBACK_STOCK_LIST;
  }
}

// ── 從 FinMind 拉指定 Dataset ─────────────────────────────────────
async function fetchFinMind(dataset, startDate, endDate) {
  const params = new URLSearchParams({
    dataset,
    start_date: startDate,
    end_date: endDate,
    token: FINMIND_TOKEN,
  });

  const res = await fetch(`${FINMIND_BASE}?${params}`, {
    headers: { 'User-Agent': 'TWSEDashboard/1.0' },
  });

  if (!res.ok) throw new Error(`FinMind ${dataset} error: ${res.status}`);
  const json = await res.json();

  if (json.status !== 200) {
    throw new Error(`FinMind ${dataset}: ${json.msg || 'error'}`);
  }

  return json.data || [];
}

// ── 整合各資料來源 ────────────────────────────────────────────────
function integrateData(stockList, perRows, instRows, marginRows, priceRows) {
  // 建立各資料的 lookup map（取最新一筆）
  const perMap     = buildLatestMap(perRows,    'stock_id', 'date');
  const instMap    = buildInstMap(instRows);
  const marginMap  = buildLatestMap(marginRows, 'stock_id', 'date');
  const priceMap   = buildPriceMap(priceRows);

  return stockList
    .map(s => {
      const per    = perMap[s.code]    || {};
      const inst   = instMap[s.code]   || {};
      const margin = marginMap[s.code] || {};
      const price  = priceMap[s.code]  || {};

      // 殖利率
      const yield_ = parseFloat(per.dividend_yield) || 0;
      // 本益比
      const pe = parseFloat(per.PER) || 0;
      // 股價淨值比
      const pb = parseFloat(per.PBR) || 0;
      // 收盤價
      const close = price.close || 0;
      // 漲跌幅（近1週/1月）
      const chg1w = price.chg1w || 0;
      const chg1m = price.chg1m || 0;
      const chg3m = price.chg3m || 0;

      // MA 位置（由 priceMap 預計算）
      const ma20 = price.ma20Above || false;
      const ma60 = price.ma60Above || false;
      const kd   = price.kdGoldenCross || false;

      // 三大法人（近5日合計）
      const foreign = inst.foreignNet5d > 0;
      const trust   = inst.trustNet5d > 0;
      const foreignNet = inst.foreignNet5d || 0;
      const trustNet   = inst.trustNet5d   || 0;

      // 融資
      const marginRatio = parseFloat(margin.MarginPurchaseLimit)
        ? (parseFloat(margin.MarginPurchase) / parseFloat(margin.MarginPurchaseLimit) * 100)
        : 0;

      // 52週高低（由 priceMap 計算）
      const w52hi = price.w52hi || close;
      const w52lo = price.w52lo || close;

      // 注意：ROE、EPS、負債比需要財報資料（TaiwanStockFinancialStatements）
      // FinMind 免費版對此 dataset 有限制，用 PBR 和 PER 估算
      // 真正的 ROE = EPS / 每股淨值 ≈ (close/PBR) 的倒數概念
      // 這裡用 per.ROE 如果有的話，否則用估算
      const roe  = parseFloat(per.ROE)  || estimateROE(yield_, pe, pb);
      const eps  = parseFloat(per.EPS)  || (pe > 0 ? close / pe : 0);
      // 負債比需要財報，暫用 50 作為預設（真實串接後會更新）
      const debt = parseFloat(per.debt_ratio) || 50;
      const cr   = parseFloat(per.current_ratio) || 150;

      // 連續配息年數（需要歷史股利資料，目前用 0 作預設）
      const divYears = per.divYears || 0;

      if (close <= 0) return null; // 過濾無效資料

      return {
        code:    s.code,
        name:    s.name,
        sector:  mapSector(s.sector),
        close,
        yield_:  +yield_.toFixed(2),
        roe:     +roe.toFixed(2),
        eps:     +eps.toFixed(2),
        debt:    +debt.toFixed(1),
        cr:      s.sector.includes('金融') ? null : +cr.toFixed(0),
        fcf:     true, // 需財報資料，暫為 true
        ma20, ma60, kd,
        foreign, trust,
        margin:  +marginRatio.toFixed(1),
        divYears,
        chg1w:   +chg1w.toFixed(2),
        chg1m:   +chg1m.toFixed(2),
        chg3m:   +chg3m.toFixed(2),
        chg1y:   price.chg1y || 0,
        w52lo, w52hi,
        pe:      +pe.toFixed(1),
        grossMargin: 20, // 需財報
        revenueGrowth: 0,
        largeCap: s.capital > 100000000000, // 股本 > 1000億
        ytd:      price.ytd || 0,
        price_jan: price.price_jan || close,
        foreignNet, trustNet,
      };
    })
    .filter(Boolean) // 移除 null
    .filter(s => s.close > 0);
}

// ── Helper: 取各 stock_id 最新一筆 ──────────────────────────────
function buildLatestMap(rows, idField, dateField) {
  const map = {};
  for (const row of rows) {
    const id = row[idField];
    if (!id) continue;
    if (!map[id] || row[dateField] > map[id][dateField]) {
      map[id] = row;
    }
  }
  return map;
}

// ── Helper: 法人買賣超（近5日合計）─────────────────────────────
function buildInstMap(rows) {
  const map = {};
  // 按日期排序，取最近5個交易日
  const sorted = [...rows].sort((a, b) => b.date.localeCompare(a.date));
  const dates = [...new Set(sorted.map(r => r.date))].slice(0, 5);

  for (const row of sorted) {
    if (!dates.includes(row.date)) continue;
    const id = row.stock_id;
    if (!map[id]) map[id] = { foreignNet5d: 0, trustNet5d: 0, dealerNet5d: 0 };

    const name = row.name || '';
    const buy  = parseInt(row.buy  || row.Foreign_Investor_Buy  || 0);
    const sell = parseInt(row.sell || row.Foreign_Investor_Sell || 0);
    const net  = parseInt(row.diff || (buy - sell) || 0);

    if (name.includes('外資') || row.Foreign_Investor_Buy !== undefined) {
      map[id].foreignNet5d += net;
    } else if (name.includes('投信') || row.Investment_Trust_Buy !== undefined) {
      map[id].trustNet5d += net;
    }
  }
  return map;
}

// ── Helper: 股價資料（計算MA、KD、漲跌幅）────────────────────────
function buildPriceMap(rows) {
  // 先按股票分組
  const byStock = {};
  for (const row of rows) {
    const id = row.stock_id;
    if (!byStock[id]) byStock[id] = [];
    byStock[id].push(row);
  }

  const map = {};
  for (const [id, stockRows] of Object.entries(byStock)) {
    // 按日期排序（舊到新）
    const sorted = stockRows.sort((a, b) => a.date.localeCompare(b.date));
    const closes = sorted.map(r => parseFloat(r.close || r.Close || 0)).filter(v => v > 0);
    if (closes.length < 5) continue;

    const latest = closes[closes.length - 1];
    const n = closes.length;

    // MA
    const ma20 = n >= 20 ? avg(closes.slice(-20)) : latest;
    const ma60 = n >= 60 ? avg(closes.slice(-60)) : latest;

    // 漲跌幅
    const chg1w = pctChange(closes, 5);
    const chg1m = pctChange(closes, 20);
    const chg3m = pctChange(closes, 60);
    const chg1y = pctChange(closes, Math.min(252, n-1));

    // 52W 高低
    const w52Slice = closes.slice(-252);
    const w52hi = Math.max(...w52Slice);
    const w52lo = Math.min(...w52Slice);

    // YTD（取今年1月第一個交易日）
    const ytdRow = sorted.find(r => r.date >= '2026-01-01');
    const price_jan = ytdRow ? parseFloat(ytdRow.close || ytdRow.Close || latest) : latest;
    const ytd = price_jan > 0 ? +((latest - price_jan) / price_jan * 100).toFixed(2) : 0;

    // KD（簡化版：K值高於D值且K > 50 視為黃金交叉）
    const kd = computeKD(closes);

    map[id] = {
      close: latest,
      ma20Above: latest > ma20,
      ma60Above: latest > ma60,
      kdGoldenCross: kd,
      chg1w: +chg1w.toFixed(2),
      chg1m: +chg1m.toFixed(2),
      chg3m: +chg3m.toFixed(2),
      chg1y: +chg1y.toFixed(2),
      w52hi: +w52hi.toFixed(2),
      w52lo: +w52lo.toFixed(2),
      ytd,
      price_jan: +price_jan.toFixed(2),
    };
  }
  return map;
}

// ── 計算 KD（隨機指標，簡化版 RSV/K/D）─────────────────────────
function computeKD(closes, period = 9) {
  if (closes.length < period + 3) return false;
  const slice = closes.slice(-period - 3);
  const rsvArr = [];
  for (let i = period - 1; i < slice.length; i++) {
    const window = slice.slice(i - period + 1, i + 1);
    const high = Math.max(...window);
    const low  = Math.min(...window);
    const rsv  = high === low ? 50 : (slice[i] - low) / (high - low) * 100;
    rsvArr.push(rsv);
  }
  // K/D 值（指數移動平均）
  let k = 50, d = 50;
  const prevK = [];
  for (const rsv of rsvArr) {
    k = (2/3) * k + (1/3) * rsv;
    d = (2/3) * d + (1/3) * k;
    prevK.push(k);
  }
  const prevD = d;
  // 黃金交叉：K > D 且前一期 K < D（或 K 剛上穿 D）
  return k > d && k > 20 && k < 80;
}

// ── 計算平均 ──────────────────────────────────────────────────────
function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ── 計算漲跌幅 ────────────────────────────────────────────────────
function pctChange(closes, periods) {
  const n = closes.length;
  if (n < periods + 1) return 0;
  const prev = closes[n - 1 - periods];
  const curr = closes[n - 1];
  return prev > 0 ? (curr - prev) / prev * 100 : 0;
}

// ── 估算 ROE（無財報時）──────────────────────────────────────────
function estimateROE(yield_, pe, pb) {
  if (pb > 0 && pe > 0) return (pb / pe * 100); // 近似值
  return 10; // 預設
}

// ── 產業別對應 ────────────────────────────────────────────────────
function mapSector(sector) {
  if (!sector) return 'other';
  if (sector.includes('半導體') || sector.includes('積體電路')) return 'semi';
  if (sector.includes('金融') || sector.includes('銀行') || sector.includes('保險')) return 'finance';
  if (sector.includes('電腦') || sector.includes('電子') || sector.includes('光電')) return 'tech';
  if (sector.includes('通信') || sector.includes('電信')) return 'trad';
  if (sector.includes('塑膠') || sector.includes('化學') || sector.includes('化工')) return 'chem';
  if (sector.includes('鋼鐵')) return 'steel';
  if (sector.includes('航運') || sector.includes('航空')) return 'shipping';
  if (sector.includes('建設') || sector.includes('不動產')) return 'real_estate';
  if (sector.includes('生技') || sector.includes('醫療')) return 'biotech';
  return 'other';
}

// ── 備援股票清單（TWSE API 失敗時用）────────────────────────────
const FALLBACK_STOCK_LIST = [
  {code:'2330',name:'台積電',sector:'半導體',capital:2593000000000},
  {code:'2317',name:'鴻海',sector:'電腦及週邊設備',capital:1386000000000},
  {code:'2454',name:'聯發科',sector:'半導體',capital:159000000000},
  {code:'2882',name:'國泰金',sector:'金融保險',capital:1418000000000},
  {code:'2881',name:'富邦金',sector:'金融保險',capital:1255000000000},
  {code:'2886',name:'兆豐金',sector:'金融保險',capital:1361000000000},
  {code:'2891',name:'中信金',sector:'金融保險',capital:1968000000000},
  {code:'2892',name:'第一金',sector:'金融保險',capital:929000000000},
  {code:'2884',name:'玉山金',sector:'金融保險',capital:1215000000000},
  {code:'2885',name:'元大金',sector:'金融保險',capital:1341000000000},
  {code:'2308',name:'台達電',sector:'電子零組件',capital:259000000000},
  {code:'2412',name:'中華電',sector:'通信網路',capital:775000000000},
  {code:'2002',name:'中鋼',sector:'鋼鐵',capital:1573000000000},
  {code:'1301',name:'台塑',sector:'塑膠',capital:636000000000},
  {code:'1303',name:'南亞',sector:'塑膠',capital:793000000000},
  {code:'2382',name:'廣達',sector:'電腦及週邊設備',capital:778000000000},
  {code:'2357',name:'華碩',sector:'電腦及週邊設備',capital:134000000000},
  {code:'3711',name:'日月光投',sector:'半導體',capital:775000000000},
  {code:'2379',name:'瑞昱',sector:'半導體',capital:100000000000},
  {code:'2303',name:'聯電',sector:'半導體',capital:1288000000000},
  {code:'2345',name:'智邦',sector:'通信網路',capital:75000000000},
  {code:'6669',name:'緯穎',sector:'電腦及週邊設備',capital:48000000000},
  {code:'4938',name:'和碩',sector:'電腦及週邊設備',capital:331000000000},
  {code:'5876',name:'上海商銀',sector:'金融保險',capital:381000000000},
  {code:'2408',name:'南亞科',sector:'半導體',capital:794000000000},
  {code:'2395',name:'研華',sector:'電子零組件',capital:110000000000},
  {code:'2327',name:'國巨',sector:'電子零組件',capital:118000000000},
  {code:'3045',name:'台灣大',sector:'通信網路',capital:341000000000},
  {code:'4904',name:'遠傳',sector:'通信網路',capital:326000000000},
  {code:'2474',name:'可成',sector:'電腦及週邊設備',capital:93000000000},
];

// ── Mock 資料（無 Token 時回傳）─────────────────────────────────
function getMockStocks() {
  return [
    { code:'2330', name:'台積電',   sector:'semi',    close:2255, yield_:2.8,  roe:29.2, eps:72.5, debt:21, cr:295,  fcf:true,  ma20:true,  ma60:true,  kd:true,  foreign:true,  trust:true,  margin:15, divYears:16, chg1w:+1.12, chg1m:+8.4,  chg3m:+32.1, chg1y:+115.2, w52lo:785,  w52hi:2285, grossMargin:58, revenueGrowth:35, pe:31, largeCap:true,  ytd:+57.2, price_jan:1433, foreignNet:15420, trustNet:3240 },
    { code:'2454', name:'聯發科',   sector:'semi',    close:3155, yield_:3.8,  roe:26.5, eps:98.2, debt:25, cr:345,  fcf:true,  ma20:true,  ma60:true,  kd:true,  foreign:true,  trust:true,  margin:18, divYears:8,  chg1w:+9.93, chg1m:+48.2, chg3m:+115.3,chg1y:+185.2, w52lo:992,  w52hi:3155, grossMargin:52, revenueGrowth:42, pe:32, largeCap:true,  ytd:+115.8,price_jan:1461, foreignNet:8520, trustNet:5680 },
    { code:'2882', name:'國泰金',   sector:'finance', close:76.2, yield_:5.8,  roe:13.2, eps:5.8,  debt:86, cr:null, fcf:true,  ma20:true,  ma60:true,  kd:true,  foreign:true,  trust:true,  margin:10, divYears:11, chg1w:+0.92, chg1m:+5.2,  chg3m:+18.4, chg1y:+42.1,  w52lo:58,   w52hi:78,   grossMargin:null,revenueGrowth:8,  pe:13, largeCap:true,  ytd:+25.9, price_jan:60.5,  foreignNet:3210, trustNet:1540 },
    { code:'2881', name:'富邦金',   sector:'finance', close:105.5,yield_:5.2,  roe:16.2, eps:8.8,  debt:83, cr:null, fcf:true,  ma20:true,  ma60:true,  kd:true,  foreign:true,  trust:true,  margin:8,  divYears:9,  chg1w:+0.85, chg1m:+6.5,  chg3m:+22.5, chg1y:+48.2,  w52lo:78,   w52hi:108,  grossMargin:null,revenueGrowth:12, pe:12, largeCap:true,  ytd:+28.4, price_jan:82.2,  foreignNet:2840, trustNet:980  },
    { code:'2886', name:'兆豐金',   sector:'finance', close:48.5, yield_:6.8,  roe:12.8, eps:3.8,  debt:85, cr:null, fcf:true,  ma20:true,  ma60:true,  kd:false, foreign:true,  trust:false, margin:8,  divYears:12, chg1w:+0.62, chg1m:+3.2,  chg3m:+12.5, chg1y:+28.4,  w52lo:38,   w52hi:52,   grossMargin:null,revenueGrowth:5,  pe:13, largeCap:true,  ytd:+18.5, price_jan:40.9,  foreignNet:1820, trustNet:0    },
    { code:'2308', name:'台達電',   sector:'tech',    close:458,  yield_:3.5,  roe:20.5, eps:26.8, debt:36, cr:208,  fcf:true,  ma20:true,  ma60:true,  kd:true,  foreign:true,  trust:true,  margin:22, divYears:10, chg1w:+1.33, chg1m:+8.5,  chg3m:+22.4, chg1y:+62.3,  w52lo:285,  w52hi:468,  grossMargin:32, revenueGrowth:22, pe:17, largeCap:true,  ytd:+28.1, price_jan:357,   foreignNet:4320, trustNet:2100 },
    { code:'2317', name:'鴻海',     sector:'tech',    close:239.5,yield_:4.2,  roe:9.2,  eps:12.4, debt:52, cr:132,  fcf:true,  ma20:true,  ma60:true,  kd:true,  foreign:true,  trust:true,  margin:10, divYears:7,  chg1w:+5.27, chg1m:+12.2, chg3m:+28.5, chg1y:+58.4,  w52lo:152,  w52hi:252,  grossMargin:7,  revenueGrowth:18, pe:19, largeCap:true,  ytd:+22.4, price_jan:196,   foreignNet:12450,trustNet:3800 },
    { code:'2412', name:'中華電',   sector:'trad',    close:128.5,yield_:5.4,  roe:10.8, eps:5.8,  debt:40, cr:162,  fcf:true,  ma20:true,  ma60:true,  kd:false, foreign:false, trust:false, margin:5,  divYears:20, chg1w:+0.39, chg1m:+1.8,  chg3m:+3.2,  chg1y:+8.5,   w52lo:120,  w52hi:132,  grossMargin:38, revenueGrowth:2,  pe:22, largeCap:true,  ytd:+2.0,  price_jan:126,   foreignNet:-320, trustNet:-180 },
    { code:'2379', name:'瑞昱',     sector:'semi',    close:852,  yield_:4.2,  roe:22.8, eps:42.5, debt:18, cr:395,  fcf:true,  ma20:true,  ma60:true,  kd:true,  foreign:true,  trust:true,  margin:22, divYears:8,  chg1w:+2.16, chg1m:+12.5, chg3m:+28.8, chg1y:+48.5,  w52lo:542,  w52hi:875,  grossMargin:58, revenueGrowth:25, pe:20, largeCap:false, ytd:+38.5, price_jan:615,   foreignNet:2840, trustNet:1520 },
    { code:'2345', name:'智邦',     sector:'tech',    close:385,  yield_:4.8,  roe:24.5, eps:22.5, debt:24, cr:325,  fcf:true,  ma20:true,  ma60:true,  kd:true,  foreign:true,  trust:true,  margin:18, divYears:8,  chg1w:+2.10, chg1m:+15.2, chg3m:+35.8, chg1y:+68.5,  w52lo:198,  w52hi:395,  grossMargin:40, revenueGrowth:28, pe:17, largeCap:false, ytd:+38.5, price_jan:278,   foreignNet:1840, trustNet:920  },
  ];
}
