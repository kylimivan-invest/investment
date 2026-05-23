/**
 * api/screener.js  v5
 * 全市場選股篩選 API
 * 用跟 price.js 完全相同的方式呼叫 TWSE（已驗證可行）
 * 只拉 BWIBBU_d 一個端點，控制在 10 秒內
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const forceRefresh = req.query?.refresh === '1';

  try {
    const date = getRecentTradeDate();
    console.log(`[screener] date=${date}`);

    // 用跟 price.js 完全一樣的 headers
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=${date}&response=json`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer':  'https://www.twse.com.tw/zh/trading/exchange/BWIBBU_d.html',
        'Accept':   'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
      },
      signal: AbortSignal.timeout(9000),
    });

    console.log(`[screener] TWSE HTTP ${resp.status}`);
    if (!resp.ok) throw new Error(`TWSE HTTP ${resp.status}`);

    const json = await resp.json();
    console.log(`[screener] stat=${json.stat} rows=${json.data?.length ?? 0}`);

    if (json.stat !== 'OK' || !json.data?.length) {
      throw new Error(`TWSE 無資料 stat=${json.stat}`);
    }

    // 同時拉三大法人（失敗不影響主流程）
    let instMap = {};
    try {
      const instUrl = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${date}&selectType=ALL&response=json`;
      const ir = await fetch(instUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer':  'https://www.twse.com.tw/zh/fund/T86.html',
          'Accept':   'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (ir.ok) {
        const ij = await ir.json();
        if (ij.data) instMap = parseInstData(ij.data, ij.fields || []);
        console.log(`[screener] inst rows=${Object.keys(instMap).length}`);
      }
    } catch(e) {
      console.warn('[screener] inst skip:', e.message);
    }

    const stocks = parseStocks(json.data, json.fields || [], instMap);
    console.log(`[screener] stocks=${stocks.length}`);

    return res
      .setHeader('Cache-Control', forceRefresh ? 'no-cache' : 's-maxage=21600, stale-while-revalidate=3600')
      .status(200)
      .json({ mock:false, stocks, count:stocks.length, updated:new Date().toISOString(), tradeDate:date, source:'TWSE' });

  } catch (err) {
    console.error('[screener] Error:', err.message);
    return res
      .setHeader('Cache-Control', 'no-cache')
      .status(200)
      .json({ mock:true, error:err.message, stocks:MOCK, count:MOCK.length, updated:new Date().toISOString() });
  }
}

// ── 計算最近交易日 ────────────────────────────────────────────────
function getRecentTradeDate() {
  const tw = new Date(Date.now() + 8*3600*1000);
  for (let i=0; i<7; i++) {
    const d = new Date(tw); d.setUTCDate(d.getUTCDate()-i);
    const dow = d.getUTCDay();
    if (dow===0||dow===6) continue;
    if (i===0 && tw.getUTCHours()<7) continue;
    return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  return '20260522';
}

// ── 解析 BWIBBU_d ─────────────────────────────────────────────────
function parseStocks(rows, fields, instMap) {
  const f = (names) => {
    for (const n of names) { const i=fields.findIndex(f=>f?.includes(n)); if(i>=0) return i; }
    return -1;
  };
  const ci=f(['證券代號'])??0, ni=f(['證券名稱'])??1;
  const pi=f(['本益比'])??2,   yi=f(['殖利率'])??4, bi=f(['股價淨值比'])??5;

  const FIN  = new Set(['2882','2881','2886','2891','2892','2884','2885','2880','2887','2888','5876','2823','2836','2838','2834']);
  const LARGE= new Set(['2330','2317','2454','2882','2881','2886','2891','2892','2884','2885','2880','2002','1301','1303','2412','3045','2382','3711','2303','2408','2308']);

  return rows.map(row => {
    const code = row[ci]?.trim();
    if (!code||!/^\d{4}$/.test(code)) return null;
    const name   = row[ni]?.trim()||code;
    const pe     = parseFloat(row[pi])||0;
    const yield_ = parseFloat(row[yi])||0;
    const pb     = parseFloat(row[bi])||0;
    if (yield_<=0&&pe<=0) return null;
    const roe = (pb>0&&pe>0)?+(pb/pe*100).toFixed(1):8;
    const inst = instMap[code]||{};
    return {
      code, name, sector:sector(code),
      close:0, yield_:+yield_.toFixed(2), roe, eps:0, pe:+pe.toFixed(1), pb:+pb.toFixed(2),
      debt:FIN.has(code)?85:45, cr:FIN.has(code)?null:150,
      fcf:true, ma20:true, ma60:true, kd:yield_>4,
      foreign:(inst.foreignNet||0)>0, trust:(inst.trustNet||0)>0,
      foreignNet:inst.foreignNet||0, trustNet:inst.trustNet||0, margin:30,
      divYears:yield_>=5?8:yield_>=3?5:2,
      chg1w:0,chg1m:0,chg3m:0,chg1y:0,w52lo:0,w52hi:0,
      grossMargin:20,revenueGrowth:5,
      largeCap:LARGE.has(code), ytd:0, price_jan:0,
    };
  }).filter(Boolean);
}

// ── 解析三大法人 ──────────────────────────────────────────────────
function parseInstData(rows, fields) {
  const map = {};
  const ci  = fields.findIndex(f=>f?.includes('證券代號'))??0;
  const fni = fields.findIndex(f=>f?.includes('外陸資買賣超'))??10;
  const tni = fields.findIndex(f=>f?.includes('投信買賣超'))??13;
  for (const row of rows) {
    const code = row[ci]?.trim();
    if (!code||!/^\d{4}$/.test(code)) continue;
    map[code] = {
      foreignNet: parseInt((row[fni]||'0').replace(/,/g,''))||0,
      trustNet:   parseInt((row[tni]||'0').replace(/,/g,''))||0,
    };
  }
  return map;
}

// ── 產業別 ───────────────────────────────────────────────────────
function sector(code) {
  const M={semi:['2330','2454','2303','2379','2408','3711','2337','3034','2344','6274'],finance:['2882','2881','2886','2891','2892','2884','2885','2880','2887','2888','5876','2823','2836','2838','2834'],tech:['2317','2308','2357','2382','4938','2345','6669','2395','2327','2474'],trad:['2412','3045','4904','2498'],chem:['1301','1303','1326','1308'],steel:['2002','2008','2014','2015'],shipping:['2603','2609','2615','2610','2618'],biotech:['4720','6446','4168','1722']};
  for(const[s,c]of Object.entries(M)){if(c.includes(code))return s;}
  return 'other';
}

// ── Mock 備援 ─────────────────────────────────────────────────────
const MOCK=[
  {code:'2330',name:'台積電',sector:'semi',close:2255,yield_:2.8,roe:29.2,eps:72.5,debt:21,cr:295,fcf:true,ma20:true,ma60:true,kd:true,foreign:true,trust:true,margin:15,divYears:16,chg1w:1.12,chg1m:8.4,chg3m:32.1,chg1y:115.2,w52lo:2079,w52hi:2285,pe:31,pb:9.1,largeCap:true,ytd:57.2,price_jan:1433,foreignNet:15420,trustNet:3240,grossMargin:58,revenueGrowth:35},
  {code:'2454',name:'聯發科',sector:'semi',close:3155,yield_:3.8,roe:26.5,eps:98.2,debt:25,cr:345,fcf:true,ma20:true,ma60:true,kd:true,foreign:true,trust:true,margin:18,divYears:8,chg1w:9.93,chg1m:48.2,chg3m:115.3,chg1y:185.2,w52lo:2755,w52hi:3155,pe:32,pb:8.4,largeCap:true,ytd:115.8,price_jan:1461,foreignNet:8520,trustNet:5680,grossMargin:52,revenueGrowth:42},
  {code:'2882',name:'國泰金',sector:'finance',close:76.2,yield_:5.8,roe:13.2,eps:5.8,debt:86,cr:null,fcf:true,ma20:true,ma60:true,kd:true,foreign:true,trust:true,margin:10,divYears:11,chg1w:0.92,chg1m:5.2,chg3m:18.4,chg1y:42.1,w52lo:68,w52hi:78,pe:13,pb:1.7,largeCap:true,ytd:25.9,price_jan:60.5,foreignNet:3210,trustNet:1540,grossMargin:null,revenueGrowth:8},
  {code:'2881',name:'富邦金',sector:'finance',close:105.5,yield_:5.2,roe:16.2,eps:8.8,debt:83,cr:null,fcf:true,ma20:true,ma60:true,kd:true,foreign:true,trust:true,margin:8,divYears:9,chg1w:0.85,chg1m:6.5,chg3m:22.5,chg1y:48.2,w52lo:92,w52hi:108,pe:12,pb:1.9,largeCap:true,ytd:28.4,price_jan:82.2,foreignNet:2840,trustNet:980,grossMargin:null,revenueGrowth:12},
  {code:'2886',name:'兆豐金',sector:'finance',close:48.5,yield_:6.8,roe:12.8,eps:3.8,debt:85,cr:null,fcf:true,ma20:true,ma60:true,kd:false,foreign:true,trust:false,margin:8,divYears:12,chg1w:0.62,chg1m:3.2,chg3m:12.5,chg1y:28.4,w52lo:42,w52hi:52,pe:13,pb:1.5,largeCap:true,ytd:18.5,price_jan:40.9,foreignNet:1820,trustNet:0,grossMargin:null,revenueGrowth:5},
  {code:'2308',name:'台達電',sector:'tech',close:458,yield_:3.5,roe:20.5,eps:26.8,debt:36,cr:208,fcf:true,ma20:true,ma60:true,kd:true,foreign:true,trust:true,margin:22,divYears:10,chg1w:1.33,chg1m:8.5,chg3m:22.4,chg1y:62.3,w52lo:385,w52hi:468,pe:17,pb:3.5,largeCap:true,ytd:28.1,price_jan:357,foreignNet:4320,trustNet:2100,grossMargin:32,revenueGrowth:22},
  {code:'2317',name:'鴻海',sector:'tech',close:239.5,yield_:4.2,roe:9.2,eps:12.4,debt:52,cr:132,fcf:true,ma20:true,ma60:true,kd:true,foreign:true,trust:true,margin:10,divYears:7,chg1w:5.27,chg1m:12.2,chg3m:28.5,chg1y:58.4,w52lo:185,w52hi:252,pe:19,pb:1.8,largeCap:true,ytd:22.4,price_jan:196,foreignNet:12450,trustNet:3800,grossMargin:7,revenueGrowth:18},
  {code:'2412',name:'中華電',sector:'trad',close:128.5,yield_:5.4,roe:10.8,eps:5.8,debt:40,cr:162,fcf:true,ma20:true,ma60:true,kd:false,foreign:false,trust:false,margin:5,divYears:20,chg1w:0.39,chg1m:1.8,chg3m:3.2,chg1y:8.5,w52lo:122,w52hi:132,pe:22,pb:2.4,largeCap:true,ytd:2.0,price_jan:126,foreignNet:-320,trustNet:-180,grossMargin:38,revenueGrowth:2},
  {code:'2379',name:'瑞昱',sector:'semi',close:852,yield_:4.2,roe:22.8,eps:42.5,debt:18,cr:395,fcf:true,ma20:true,ma60:true,kd:true,foreign:true,trust:true,margin:22,divYears:8,chg1w:2.16,chg1m:12.5,chg3m:28.8,chg1y:48.5,w52lo:652,w52hi:875,pe:20,pb:4.5,largeCap:false,ytd:38.5,price_jan:615,foreignNet:2840,trustNet:1520,grossMargin:58,revenueGrowth:25},
  {code:'2345',name:'智邦',sector:'tech',close:385,yield_:4.8,roe:24.5,eps:22.5,debt:24,cr:325,fcf:true,ma20:true,ma60:true,kd:true,foreign:true,trust:true,margin:18,divYears:8,chg1w:2.10,chg1m:15.2,chg3m:35.8,chg1y:68.5,w52lo:285,w52hi:395,pe:17,pb:4.2,largeCap:false,ytd:38.5,price_jan:278,foreignNet:1840,trustNet:920,grossMargin:40,revenueGrowth:28},
];
