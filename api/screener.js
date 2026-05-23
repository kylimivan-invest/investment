/**
 * api/screener.js
 * 全市場選股篩選 API（TWSE 免費版）
 * 資料來源：台灣證交所開放資料平台（完全免費，不需要 Token）
 *
 * 使用的 TWSE Datasets：
 *   - STOCK_DAY_ALL     → 全市場當日成交、收盤價、漲跌幅
 *   - MI_INDEX          → 大盤指數
 *   - BWIBBU_ALL        → 全市場本益比、殖利率、股價淨值比（每日更新）
 *   - TWT38U_ALL        → 融資融券
 *   - 三大法人           → 個股三大法人買賣超
 *
 * 快取：6小時 Edge Cache
 */

const TWSE_OPEN = 'https://opendata.twse.com.tw/v1/exchangeReport';
const TWSE_MAIN = 'https://www.twse.com.tw/rwd/zh';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const forceRefresh = req.query?.refresh === '1';

  try {
    console.log('[screener] Starting TWSE data fetch...');

    // 並行拉取所有需要的資料
    const [dayAllResult, bwiResult, instResult, marginResult] = await Promise.allSettled([
      fetchJSON(`${TWSE_OPEN}/STOCK_DAY_ALL`),           // 全市場日成交
      fetchJSON(`${TWSE_OPEN}/BWIBBU_ALL`),              // 本益比/殖利率
      fetchJSON(`${TWSE_OPEN}/MI_INDEX20`),              // 三大法人（個股）
      fetchJSON(`${TWSE_OPEN}/TWT38U_ALL`),              // 融資融券
    ]);

    const dayAll  = dayAllResult.status  === 'fulfilled' ? dayAllResult.value  : [];
    const bwiData = bwiResult.status     === 'fulfilled' ? bwiResult.value     : [];
    const instData= instResult.status    === 'fulfilled' ? instResult.value    : [];
    const marginData = marginResult.status === 'fulfilled' ? marginResult.value : [];

    console.log(`[screener] dayAll:${dayAll.length} bwi:${bwiData.length} inst:${instData.length} margin:${marginData.length}`);

    if (dayAll.length === 0 && bwiData.length === 0) {
      throw new Error('TWSE 資料為空，可能非交易時間或 API 暫時無法連線');
    }

    const stocks = buildStocks(dayAll, bwiData, instData, marginData);

    console.log(`[screener] Built ${stocks.length} stocks`);

    return res
      .setHeader('Cache-Control', forceRefresh ? 'no-cache' : 's-maxage=21600, stale-while-revalidate=3600')
      .status(200)
      .json({
        mock: false,
        stocks,
        count: stocks.length,
        updated: new Date().toISOString(),
        source: 'TWSE OpenData (free)',
        debug: {
          dayAll: dayAll.length,
          bwi: bwiData.length,
          inst: instData.length,
          margin: marginData.length,
        }
      });

  } catch (err) {
    console.error('[screener] Error:', err.message);
    return res
      .setHeader('Cache-Control', 'no-cache')
      .status(200)
      .json({
        mock: true,
        error: err.message,
        stocks: getMockStocks(),
        count: getMockStocks().length,
        updated: new Date().toISOString(),
        source: 'mock fallback',
      });
  }
}

// ── Fetch helper ──────────────────────────────────────────────────
async function fetchJSON(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TWSEDashboard/1.0)',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(8000), // 8秒超時
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return await resp.json();
}

// ── 整合所有資料 ──────────────────────────────────────────────────
function buildStocks(dayAll, bwiData, instData, marginData) {
  // 1. BWI map（本益比/殖利率/PBR）
  // TWSE BWIBBU_ALL 欄位：Code, StockName, PERatio, DividendYield, PBRatio
  const bwiMap = {};
  for (const r of bwiData) {
    const code = r.Code || r['代號'] || r.stock_id;
    if (!code || !/^\d{4}$/.test(code)) continue;
    bwiMap[code] = {
      yield_: parseFloat(r.DividendYield || r['殖利率(%)'] || 0),
      pe:     parseFloat(r.PERatio       || r['本益比']    || 0),
      pb:     parseFloat(r.PBRatio       || r['股價淨值比'] || 0),
      name:   r.StockName || r['股票名稱'] || code,
    };
  }

  // 2. 法人 map（近日買賣超）
  // TWSE MI_INDEX20 或三大法人資料
  const instMap = {};
  for (const r of instData) {
    const code = r.Code || r['股票代號'] || r.stock_id;
    if (!code || !/^\d{4}$/.test(code)) continue;
    if (!instMap[code]) instMap[code] = { foreignNet: 0, trustNet: 0 };
    // 外資買賣超
    const fNet = parseInt((r['外陸資買賣超股數(千股)'] || r.foreignNet || '0').replace(/,/g, '')) || 0;
    const tNet = parseInt((r['投信買賣超股數(千股)']   || r.trustNet   || '0').replace(/,/g, '')) || 0;
    instMap[code].foreignNet += fNet;
    instMap[code].trustNet   += tNet;
  }

  // 3. 融資 map
  // TWSE TWT38U_ALL 欄位：Code, MarginPurchase, MarginLimit...
  const marginMap = {};
  for (const r of marginData) {
    const code = r.Code || r['股票代號'];
    if (!code || !/^\d{4}$/.test(code)) continue;
    const purchase = parseInt((r.MarginPurchase || r['融資買進'] || '0').replace(/,/g, '')) || 0;
    const limit    = parseInt((r.MarginLimit    || r['融資限額'] || '1').replace(/,/g, '')) || 1;
    marginMap[code] = { ratio: limit > 0 ? (purchase / limit * 100) : 0 };
  }

  // 4. 整合 dayAll（全市場日成交）
  // TWSE STOCK_DAY_ALL 欄位：Code, StockName, TradeVolume, Transaction,
  //   TradeValue, OpeningPrice, HighestPrice, LowestPrice, ClosingPrice, Change, Spread
  return dayAll
    .filter(r => {
      const code = r.Code || r['證券代號'];
      return code && /^\d{4}$/.test(code); // 只要4碼上市普通股
    })
    .map(r => {
      const code  = r.Code || r['證券代號'];
      const name  = r.StockName || r['證券名稱'] || bwiMap[code]?.name || code;
      const close = parseFloat((r.ClosingPrice || r['收盤價'] || '0').replace(/,/g, '')) || 0;
      const open  = parseFloat((r.OpeningPrice || r['開盤價'] || '0').replace(/,/g, '')) || 0;
      const high  = parseFloat((r.HighestPrice || r['最高價'] || '0').replace(/,/g, '')) || 0;
      const low   = parseFloat((r.LowestPrice  || r['最低價'] || '0').replace(/,/g, '')) || 0;
      const chgRaw= (r.Change || r['漲跌價差'] || '0').replace(/,/g, '').replace(/▲|▼/g, '');
      const chgSign = (r.Change || r['漲跌價差'] || '').includes('▼') ? -1 : 1;
      const chg1d = parseFloat(chgRaw) * chgSign || 0;
      const prevClose = close - chg1d;
      const chg1dPct  = prevClose > 0 ? chg1d / prevClose * 100 : 0;
      const vol = parseInt((r.TradeVolume || r['成交股數'] || '0').replace(/,/g, '')) || 0;

      const bwi    = bwiMap[code]    || {};
      const inst   = instMap[code]   || {};
      const margin = marginMap[code] || {};

      const yield_  = bwi.yield_ || 0;
      const pe      = bwi.pe     || 0;
      const pb      = bwi.pb     || 0;

      // 估算 ROE：ROE ≈ PB / PE * 100（近似）
      const roe = (pb > 0 && pe > 0) ? +(pb / pe * 100).toFixed(1) : 8;
      // EPS 估算
      const eps = (pe > 0 && close > 0) ? +(close / pe).toFixed(2) : 0;

      const isFinance = FINANCE_CODES.includes(code);
      const foreignNet = inst.foreignNet || 0;
      const trustNet   = inst.trustNet   || 0;
      const marginRatio = margin.ratio   || 0;

      if (close <= 0) return null;

      return {
        code,
        name,
        sector:   mapSector(code),
        close:    +close.toFixed(2),
        open:     +open.toFixed(2),
        high:     +high.toFixed(2),
        low:      +low.toFixed(2),
        vol,
        yield_:   +yield_.toFixed(2),
        roe,
        eps,
        pe:       +pe.toFixed(1),
        pb:       +pb.toFixed(2),
        debt:     isFinance ? 85 : 45,
        cr:       isFinance ? null : 150,
        fcf:      true,
        // 技術面（無歷史資料，用當日資訊估算）
        ma20:     close > open,       // 收盤 > 開盤視為短線偏多（簡化）
        ma60:     chg1dPct > 0,       // 今日上漲視為中線偏多（簡化）
        kd:       chg1dPct > 0 && close > low + (high - low) * 0.5,
        foreign:  foreignNet > 0,
        trust:    trustNet   > 0,
        foreignNet,
        trustNet,
        margin:   +marginRatio.toFixed(1),
        divYears: yield_ >= 5 ? 8 : yield_ >= 3 ? 5 : 2,
        chg1w:    +chg1dPct.toFixed(2),  // 暫用當日漲跌幅（無歷史）
        chg1m:    +chg1dPct.toFixed(2),
        chg3m:    +chg1dPct.toFixed(2),
        chg1y:    0,
        w52lo:    +low.toFixed(2),
        w52hi:    +high.toFixed(2),
        grossMargin:    20,
        revenueGrowth:  5,
        largeCap: LARGE_CAP_CODES.includes(code),
        ytd:      0,
        price_jan: close,
      };
    })
    .filter(Boolean);
}

// ── 產業別對應 ────────────────────────────────────────────────────
const SECTOR_MAP = {
  semi:      ['2330','2454','2303','2379','2408','3711','2337','3034','2344','6274','2385','2388'],
  finance:   ['2882','2881','2886','2891','2892','2884','2885','2880','2887','2888','5876','2823','2836','2838','2834'],
  tech:      ['2317','2308','2357','2382','4938','2345','6669','3231','2395','2327','2474'],
  trad:      ['2412','3045','4904','2498'],
  chem:      ['1301','1303','1326','1308'],
  steel:     ['2002','2008','2014','2015'],
  shipping:  ['2603','2609','2615','2610','2618'],
  biotech:   ['4720','6446','4168','1722','6548'],
  real_estate:['2511','5522','2912'],
};
function mapSector(code) {
  for (const [sec, codes] of Object.entries(SECTOR_MAP)) {
    if (codes.includes(code)) return sec;
  }
  return 'other';
}

const LARGE_CAP_CODES = [
  '2330','2317','2454','2882','2881','2886','2891','2892','2884','2885',
  '2880','2002','1301','1303','2412','3045','2382','3711','2303','2408',
  '2308','2603','2609','4904','3045','1326','2395'
];
const FINANCE_CODES = [
  '2882','2881','2886','2891','2892','2884','2885','2880','2887','2888',
  '5876','2823','2836','2838','2834'
];

// ── Mock 資料（API 失敗備援）─────────────────────────────────────
function getMockStocks() {
  return [
    { code:'2330',name:'台積電',  sector:'semi',   close:2255,yield_:2.8, roe:29.2,eps:72.5,debt:21,cr:295, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:15,divYears:16,chg1w:1.12, chg1m:8.4,  chg3m:32.1, chg1y:115.2,w52lo:2079,w52hi:2285,pe:31,pb:9.1,largeCap:true, ytd:57.2, price_jan:1433,foreignNet:15420,trustNet:3240,grossMargin:58,revenueGrowth:35 },
    { code:'2454',name:'聯發科',  sector:'semi',   close:3155,yield_:3.8, roe:26.5,eps:98.2,debt:25,cr:345, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:18,divYears:8, chg1w:9.93, chg1m:48.2, chg3m:115.3,chg1y:185.2,w52lo:2755,w52hi:3155,pe:32,pb:8.4,largeCap:true, ytd:115.8,price_jan:1461,foreignNet:8520, trustNet:5680,grossMargin:52,revenueGrowth:42 },
    { code:'2882',name:'國泰金',  sector:'finance',close:76.2, yield_:5.8, roe:13.2,eps:5.8, debt:86,cr:null,fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:10,divYears:11,chg1w:0.92, chg1m:5.2,  chg3m:18.4, chg1y:42.1, w52lo:68,  w52hi:78,  pe:13,pb:1.7,largeCap:true, ytd:25.9, price_jan:60.5, foreignNet:3210, trustNet:1540,grossMargin:null,revenueGrowth:8  },
    { code:'2881',name:'富邦金',  sector:'finance',close:105.5,yield_:5.2, roe:16.2,eps:8.8, debt:83,cr:null,fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:8, divYears:9, chg1w:0.85, chg1m:6.5,  chg3m:22.5, chg1y:48.2, w52lo:92,  w52hi:108, pe:12,pb:1.9,largeCap:true, ytd:28.4, price_jan:82.2,  foreignNet:2840, trustNet:980, grossMargin:null,revenueGrowth:12 },
    { code:'2886',name:'兆豐金',  sector:'finance',close:48.5, yield_:6.8, roe:12.8,eps:3.8, debt:85,cr:null,fcf:true,ma20:true, ma60:true, kd:false,foreign:true, trust:false,margin:8, divYears:12,chg1w:0.62, chg1m:3.2,  chg3m:12.5, chg1y:28.4, w52lo:42,  w52hi:52,  pe:13,pb:1.5,largeCap:true, ytd:18.5, price_jan:40.9,  foreignNet:1820, trustNet:0,   grossMargin:null,revenueGrowth:5  },
    { code:'2308',name:'台達電',  sector:'tech',   close:458,  yield_:3.5, roe:20.5,eps:26.8,debt:36,cr:208, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:22,divYears:10,chg1w:1.33, chg1m:8.5,  chg3m:22.4, chg1y:62.3, w52lo:385, w52hi:468, pe:17,pb:3.5,largeCap:true, ytd:28.1, price_jan:357,   foreignNet:4320, trustNet:2100,grossMargin:32,revenueGrowth:22 },
    { code:'2317',name:'鴻海',    sector:'tech',   close:239.5,yield_:4.2, roe:9.2, eps:12.4,debt:52,cr:132, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:10,divYears:7, chg1w:5.27, chg1m:12.2, chg3m:28.5, chg1y:58.4, w52lo:185, w52hi:252, pe:19,pb:1.8,largeCap:true, ytd:22.4, price_jan:196,   foreignNet:12450,trustNet:3800,grossMargin:7, revenueGrowth:18 },
    { code:'2412',name:'中華電',  sector:'trad',   close:128.5,yield_:5.4, roe:10.8,eps:5.8, debt:40,cr:162, fcf:true,ma20:true, ma60:true, kd:false,foreign:false,trust:false,margin:5, divYears:20,chg1w:0.39, chg1m:1.8,  chg3m:3.2,  chg1y:8.5,  w52lo:122, w52hi:132, pe:22,pb:2.4,largeCap:true, ytd:2.0,  price_jan:126,   foreignNet:-320, trustNet:-180,grossMargin:38,revenueGrowth:2  },
    { code:'2379',name:'瑞昱',    sector:'semi',   close:852,  yield_:4.2, roe:22.8,eps:42.5,debt:18,cr:395, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:22,divYears:8, chg1w:2.16, chg1m:12.5, chg3m:28.8, chg1y:48.5, w52lo:652, w52hi:875, pe:20,pb:4.5,largeCap:false,ytd:38.5, price_jan:615,   foreignNet:2840, trustNet:1520,grossMargin:58,revenueGrowth:25 },
    { code:'2345',name:'智邦',    sector:'tech',   close:385,  yield_:4.8, roe:24.5,eps:22.5,debt:24,cr:325, fcf:true,ma20:true, ma60:true, kd:true, foreign:true, trust:true, margin:18,divYears:8, chg1w:2.10, chg1m:15.2, chg3m:35.8, chg1y:68.5, w52lo:285, w52hi:395, pe:17,pb:4.2,largeCap:false,ytd:38.5, price_jan:278,   foreignNet:1840, trustNet:920, grossMargin:40,revenueGrowth:28 },
  ];
}
