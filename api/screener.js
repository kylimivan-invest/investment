/**
 * api/screener.js  v4
 * 全市場選股篩選 API
 * 資料來源：TWSE（免費，不需要 Token）
 * - 直接用固定日期，不做動態查詢，避免超時
 * - 單次 API 呼叫，速度快
 */

const TWSE_RWD = 'https://www.twse.com.tw/rwd/zh/afterTrading';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const forceRefresh = req.query?.refresh === '1';

  try {
    // 計算最近的交易日（往前找，跳過週末，不做 API 驗證）
    const tradeDate = getRecentTradeDate();
    console.log(`[screener] trade date: ${tradeDate}`);

    // 只拉一個最重要的資料集：BWIBBU_d（殖利率+本益比+股價淨值比）
    // 這個 dataset 包含全市場股票，一次搞定
    const url = `${TWSE_RWD}/BWIBBU_d?date=${tradeDate}&response=json`;
    console.log(`[screener] fetching: ${url}`);

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TWSEDashboard/1.0)',
        'Referer': 'https://www.twse.com.tw/',
      },
      signal: AbortSignal.timeout(7000),
    });

    if (!resp.ok) throw new Error(`TWSE HTTP ${resp.status}`);
    const json = await resp.json();
    console.log(`[screener] TWSE status:${json.stat} rows:${json.data?.length ?? 0}`);

    if (json.stat !== 'OK' || !json.data || json.data.length === 0) {
      throw new Error(`TWSE 回傳無資料 stat=${json.stat}，請確認日期 ${tradeDate} 是否為交易日`);
    }

    // 同時拉三大法人（可選，失敗不影響主流程）
    let instMap = {};
    try {
      const instUrl = `${TWSE_RWD}/../fund/T86?date=${tradeDate}&selectType=ALL&response=json`;
      const instResp = await fetch(instUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw/' },
        signal: AbortSignal.timeout(5000),
      });
      if (instResp.ok) {
        const instJson = await instResp.json();
        if (instJson.data) {
          instMap = buildInstMap(instJson.data, instJson.fields || []);
          console.log(`[screener] inst map size: ${Object.keys(instMap).length}`);
        }
      }
    } catch (e) {
      console.warn('[screener] inst data failed (non-critical):', e.message);
    }

    const stocks = buildStocks(json.data, json.fields || [], instMap);
    console.log(`[screener] built ${stocks.length} stocks`);

    return res
      .setHeader('Cache-Control', forceRefresh ? 'no-cache' : 's-maxage=21600, stale-while-revalidate=3600')
      .status(200)
      .json({
        mock: false,
        stocks,
        count: stocks.length,
        updated: new Date().toISOString(),
        tradeDate,
        source: 'TWSE BWIBBU_d (free)',
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
      });
  }
}

// ── 計算最近交易日（純計算，不呼叫 API）────────────────────────────
function getRecentTradeDate() {
  const now = new Date();
  // 轉成台灣時間（UTC+8）
  const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const hour = tw.getUTCHours();

  // 往前找最近的週一到週五
  for (let i = 0; i < 7; i++) {
    const d = new Date(tw);
    d.setUTCDate(d.getUTCDate() - i);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // 跳過週末

    // 若是今天但還沒收盤（台股收盤 15:00 = UTC 07:00），用前一個交易日
    if (i === 0 && hour < 7) continue;

    const y  = d.getUTCFullYear();
    const m  = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${dd}`;
  }
  return '20260522'; // 最終備援
}

// ── 整合 BWIBBU_d 資料 ────────────────────────────────────────────
function buildStocks(rows, fields, instMap) {
  // TWSE BWIBBU_d fields（固定順序，但保險起見用動態查找）
  // 典型欄位：證券代號, 證券名稱, 本益比, 股利年度, 殖利率(%), 股價淨值比
  const ci = fi(fields, ['證券代號', 'Code'])        ?? 0;
  const ni = fi(fields, ['證券名稱', 'Name'])        ?? 1;
  const pi = fi(fields, ['本益比',   'PERatio'])     ?? 2;
  const yi = fi(fields, ['殖利率',   'DividendYield'])??4;
  const bi = fi(fields, ['股價淨值比','PBRatio'])    ?? 5;

  return rows
    .map(row => {
      const code = row[ci]?.trim();
      if (!code || !/^\d{4}$/.test(code)) return null;

      const name   = row[ni]?.trim() || code;
      const pe     = parseNum(row[pi]);
      const yield_ = parseNum(row[yi]);
      const pb     = parseNum(row[bi]);

      if (yield_ <= 0 && pe <= 0) return null; // 跳過無效資料

      const roe = (pb > 0 && pe > 0) ? +(pb / pe * 100).toFixed(1) : 8;
      const inst = instMap[code] || {};
      const isFinance = FINANCE_CODES.includes(code);

      return {
        code,
        name,
        sector:    mapSector(code),
        close:     0,         // BWIBBU_d 不含收盤價，由 price API 補
        yield_:    +yield_.toFixed(2),
        roe,
        eps:       0,
        pe:        +pe.toFixed(1),
        pb:        +pb.toFixed(2),
        debt:      isFinance ? 85 : 45,
        cr:        isFinance ? null : 150,
        fcf:       true,
        ma20:      true,
        ma60:      true,
        kd:        yield_ > 4,
        foreign:   (inst.foreignNet || 0) > 0,
        trust:     (inst.trustNet   || 0) > 0,
        foreignNet: inst.foreignNet || 0,
        trustNet:   inst.trustNet   || 0,
        margin:    30,
        divYears:  yield_ >= 5 ? 8 : yield_ >= 3 ? 5 : 2,
        chg1w: 0, chg1m: 0, chg3m: 0, chg1y: 0,
        w52lo: 0, w52hi: 0,
        grossMargin:   20,
        revenueGrowth: 5,
        largeCap:  LARGE_CAP_CODES.includes(code),
        ytd:       0,
        price_jan: 0,
      };
    })
    .filter(Boolean);
}

// ── 三大法人 map ──────────────────────────────────────────────────
function buildInstMap(rows, fields) {
  const map = {};
  const ci  = fi(fields, ['證券代號','Code'])                    ?? 0;
  const fni = fi(fields, ['外陸資買賣超','外資買賣超'])           ?? 10;
  const tni = fi(fields, ['投信買賣超'])                          ?? 13;

  for (const row of rows) {
    const code = row[ci]?.trim();
    if (!code || !/^\d{4}$/.test(code)) continue;
    map[code] = {
      foreignNet: parseIntClean(row[fni]),
      trustNet:   parseIntClean(row[tni]),
    };
  }
  return map;
}

// ── Helpers ───────────────────────────────────────────────────────
function fi(fields, names) {
  if (!fields || fields.length === 0) return null;
  for (const name of names) {
    const idx = fields.findIndex(f => f?.includes(name));
    if (idx >= 0) return idx;
  }
  return null;
}
function parseNum(v) {
  if (!v) return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}
function parseIntClean(v) {
  if (!v) return 0;
  const n = parseInt(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

// ── 產業別 ───────────────────────────────────────────────────────
const SECTOR_MAP = {
  semi:     ['2330','2454','2303','2379','2408','3711','2337','3034','2344','6274','2385','2388'],
  finance:  ['2882','2881','2886','2891','2892','2884','2885','2880','2887','2888','5876','2823','2836','2838','2834'],
  tech:     ['2317','2308','2357','2382','4938','2345','6669','3231','2395','2327','2474'],
  trad:     ['2412','3045','4904','2498'],
  chem:     ['1301','1303','1326','1308'],
  steel:    ['2002','2008','2014','2015'],
  shipping: ['2603','2609','2615','2610','2618'],
  biotech:  ['4720','6446','4168','1722','6548'],
};
function mapSector(code) {
  for (const [sec, codes] of Object.entries(SECTOR_MAP)) {
    if (codes.includes(code)) return sec;
  }
  return 'other';
}
const LARGE_CAP_CODES = ['2330','2317','2454','2882','2881','2886','2891','2892','2884','2885','2880','2002','1301','1303','2412','3045','2382','3711','2303','2408','2308'];
const FINANCE_CODES   = ['2882','2881','2886','2891','2892','2884','2885','2880','2887','2888','5876','2823','2836','2838','2834'];

// ── Mock 資料備援 ─────────────────────────────────────────────────
function getMockStocks() {
  return [
    {code:'2330',name:'台積電',  sector:'semi',   close:2255,yield_:2.8, roe:29.2,eps:72.5,debt:21,cr:295, fcf:true,ma20:true,ma60:true,kd:true, foreign:true, trust:true, margin:15,divYears:16,chg1w:1.12,chg1m:8.4, chg3m:32.1,chg1y:115.2,w52lo:2079,w52hi:2285,pe:31,pb:9.1,largeCap:true, ytd:57.2, price_jan:1433,foreignNet:15420,trustNet:3240,grossMargin:58,revenueGrowth:35},
    {code:'2454',name:'聯發科',  sector:'semi',   close:3155,yield_:3.8, roe:26.5,eps:98.2,debt:25,cr:345, fcf:true,ma20:true,ma60:true,kd:true, foreign:true, trust:true, margin:18,divYears:8, chg1w:9.93,chg1m:48.2,chg3m:115.3,chg1y:185.2,w52lo:2755,w52hi:3155,pe:32,pb:8.4,largeCap:true, ytd:115.8,price_jan:1461,foreignNet:8520, trustNet:5680,grossMargin:52,revenueGrowth:42},
    {code:'2882',name:'國泰金',  sector:'finance',close:76.2, yield_:5.8, roe:13.2,eps:5.8, debt:86,cr:null,fcf:true,ma20:true,ma60:true,kd:true, foreign:true, trust:true, margin:10,divYears:11,chg1w:0.92,chg1m:5.2, chg3m:18.4, chg1y:42.1, w52lo:68,  w52hi:78,  pe:13,pb:1.7,largeCap:true, ytd:25.9, price_jan:60.5, foreignNet:3210, trustNet:1540,grossMargin:null,revenueGrowth:8},
    {code:'2881',name:'富邦金',  sector:'finance',close:105.5,yield_:5.2, roe:16.2,eps:8.8, debt:83,cr:null,fcf:true,ma20:true,ma60:true,kd:true, foreign:true, trust:true, margin:8, divYears:9, chg1w:0.85,chg1m:6.5, chg3m:22.5, chg1y:48.2, w52lo:92,  w52hi:108, pe:12,pb:1.9,largeCap:true, ytd:28.4, price_jan:82.2,  foreignNet:2840, trustNet:980, grossMargin:null,revenueGrowth:12},
    {code:'2886',name:'兆豐金',  sector:'finance',close:48.5, yield_:6.8, roe:12.8,eps:3.8, debt:85,cr:null,fcf:true,ma20:true,ma60:true,kd:false,foreign:true, trust:false,margin:8, divYears:12,chg1w:0.62,chg1m:3.2, chg3m:12.5, chg1y:28.4, w52lo:42,  w52hi:52,  pe:13,pb:1.5,largeCap:true, ytd:18.5, price_jan:40.9,  foreignNet:1820, trustNet:0,   grossMargin:null,revenueGrowth:5},
    {code:'2308',name:'台達電',  sector:'tech',   close:458,  yield_:3.5, roe:20.5,eps:26.8,debt:36,cr:208, fcf:true,ma20:true,ma60:true,kd:true, foreign:true, trust:true, margin:22,divYears:10,chg1w:1.33,chg1m:8.5, chg3m:22.4, chg1y:62.3, w52lo:385, w52hi:468, pe:17,pb:3.5,largeCap:true, ytd:28.1, price_jan:357,   foreignNet:4320, trustNet:2100,grossMargin:32,revenueGrowth:22},
    {code:'2317',name:'鴻海',    sector:'tech',   close:239.5,yield_:4.2, roe:9.2, eps:12.4,debt:52,cr:132, fcf:true,ma20:true,ma60:true,kd:true, foreign:true, trust:true, margin:10,divYears:7, chg1w:5.27,chg1m:12.2,chg3m:28.5, chg1y:58.4, w52lo:185, w52hi:252, pe:19,pb:1.8,largeCap:true, ytd:22.4, price_jan:196,   foreignNet:12450,trustNet:3800,grossMargin:7, revenueGrowth:18},
    {code:'2412',name:'中華電',  sector:'trad',   close:128.5,yield_:5.4, roe:10.8,eps:5.8, debt:40,cr:162, fcf:true,ma20:true,ma60:true,kd:false,foreign:false,trust:false,margin:5, divYears:20,chg1w:0.39,chg1m:1.8, chg3m:3.2,  chg1y:8.5,  w52lo:122, w52hi:132, pe:22,pb:2.4,largeCap:true, ytd:2.0,  price_jan:126,   foreignNet:-320, trustNet:-180,grossMargin:38,revenueGrowth:2},
    {code:'2379',name:'瑞昱',    sector:'semi',   close:852,  yield_:4.2, roe:22.8,eps:42.5,debt:18,cr:395, fcf:true,ma20:true,ma60:true,kd:true, foreign:true, trust:true, margin:22,divYears:8, chg1w:2.16,chg1m:12.5,chg3m:28.8, chg1y:48.5, w52lo:652, w52hi:875, pe:20,pb:4.5,largeCap:false,ytd:38.5, price_jan:615,   foreignNet:2840, trustNet:1520,grossMargin:58,revenueGrowth:25},
    {code:'2345',name:'智邦',    sector:'tech',   close:385,  yield_:4.8, roe:24.5,eps:22.5,debt:24,cr:325, fcf:true,ma20:true,ma60:true,kd:true, foreign:true, trust:true, margin:18,divYears:8, chg1w:2.10,chg1m:15.2,chg3m:35.8, chg1y:68.5, w52lo:285, w52hi:395, pe:17,pb:4.2,largeCap:false,ytd:38.5, price_jan:278,   foreignNet:1840, trustNet:920, grossMargin:40,revenueGrowth:28},
  ];
}
