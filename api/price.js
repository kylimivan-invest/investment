/**
 * api/price.js
 * 台股即時/快照股價 API（上市 TSE + 上櫃 OTC，免 Token）
 * 資料來源：TWSE MIS 即時行情端點，批次抓取
 *
 * 設計重點（快照式）：
 *   1. 一次請求用 "|" 串接多檔，減少對 TWSE 的呼叫次數
 *   2. 自動判斷上市/上櫃：先以 tse_ 批次抓，未命中者再以 otc_ 重試
 *   3. 單檔失敗不會讓整批 500（逐批 try/catch，最後一律回 200）
 *   4. 收盤後 z='-' 時，依 pz(前次成交) → y(昨收) 取值
 *   5. 邊緣快取（見 vercel.json）：所有使用者共用快照
 *
 * 呼叫：
 *   GET /api/price?code=2330
 *   GET /api/price?codes=2330,5011,00878   （上市上櫃可混）
 */

const MIS = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const BATCH_SIZE = 40;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const base = `https://${req.headers.host || 'localhost'}`;
  const { searchParams } = new URL(req.url, base);
  const raw = searchParams.get('codes') || searchParams.get('code') || '';
  const codes = raw.split(',').map((c) => c.trim()).filter(Boolean);

  if (codes.length === 0) {
    return res.status(400).json({ error: '請提供 code 或 codes 參數' });
  }

  try {
    const map = await fetchSnapshot(codes);
    const out = codes.map((c) => map[c] || { code: c, error: 'no_data' });
    return res.status(200).json(out.length === 1 ? out[0] : out);
  } catch (err) {
    console.error('[price.js] Error:', err.message);
    const fb = codes.map((c) => ({ code: c, error: err.message }));
    return res.status(200).json(fb.length === 1 ? fb[0] : fb);
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function misBatch(exChs) {
  const url = `${MIS}?ex_ch=${exChs.join('|')}&json=1&delay=0&_=${Date.now()}`;
  const opts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TWSEDashboard/2.0)',
      Referer: 'https://mis.twse.com.tw/stock/index.html',
    },
  };
  let resp = await fetch(url, opts);
  if (!resp.ok) throw new Error(`MIS request failed: ${resp.status}`);
  let data = await resp.json();
  let arr = data && data.msgArray;
  if (!arr || arr.length === 0) {
    await new Promise((r) => setTimeout(r, 300));
    resp = await fetch(`${url}&r=2`, opts);
    if (resp.ok) {
      data = await resp.json();
      arr = (data && data.msgArray) || [];
    } else {
      arr = [];
    }
  }
  return arr || [];
}

async function fetchSnapshot(codes) {
  const result = {};

  for (const grp of chunk(codes, BATCH_SIZE)) {
    try {
      const arr = await misBatch(grp.map((c) => `tse_${c}.tw`));
      arr.forEach((s) => addRow(result, s));
    } catch (e) {
      console.warn('[price.js] tse batch skip:', e.message);
    }
  }

  const missing = codes.filter((c) => !result[c]);
  for (const grp of chunk(missing, BATCH_SIZE)) {
    try {
      const arr = await misBatch(grp.map((c) => `otc_${c}.tw`));
      arr.forEach((s) => addRow(result, s));
    } catch (e) {
      console.warn('[price.js] otc batch skip:', e.message);
    }
  }

  return result;
}

function addRow(result, s) {
  const code = s.c;
  if (!code) return;

  const last = num(s.z) ?? num(s.pz) ?? num(s.y);
  const prev = num(s.y);
  const change = last != null && prev != null ? +(last - prev).toFixed(2) : null;
  const changePct = change != null && prev > 0 ? +((change / prev) * 100).toFixed(2) : null;

  result[code] = {
    code,
    name: s.n || code,
    close: last,
    open: num(s.o),
    high: num(s.h),
    low: num(s.l),
    prevClose: prev,
    volume: num(s.v),
    change,
    changePct,
    date: s.d || null,
    market: s.ex || null,
    source: 'twse_mis',
  };
}
