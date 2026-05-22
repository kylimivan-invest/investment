/**
 * api/price.js
 * 即時/收盤股價 API
 * 資料來源：TWSE（台灣證券交易所）公開 API，免 Token
 *
 * 呼叫方式：
 *   GET /api/price?code=2330
 *   GET /api/price?codes=2330,2454,2882   (批次，逗號分隔)
 *
 * 回傳格式：
 *   單支: { code, name, close, open, high, low, volume, change, changePct, date }
 *   批次: [ { ...同上 }, ... ]
 */

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code, codes } = req.query;

  // 支援單筆或批次
  const codeList = codes
    ? codes.split(',').map(c => c.trim()).filter(Boolean)
    : code
      ? [code.trim()]
      : [];

  if (codeList.length === 0) {
    return res.status(400).json({ error: '請提供 code 或 codes 參數' });
  }

  try {
    const results = await Promise.all(codeList.map(fetchStockPrice));

    // 單筆直接回傳物件，批次回傳陣列
    if (codeList.length === 1) {
      return res.status(200).json(results[0]);
    }
    return res.status(200).json(results);
  } catch (err) {
    console.error('[price.js] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * 從 TWSE 取得個股即時/收盤資料
 * TWSE 公開端點，不需要 API Key
 */
async function fetchStockPrice(code) {
  // TWSE 個股即時行情（盤中及收盤後均可用）
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${code}.tw&json=1&delay=0`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TWSEDashboard/1.0)',
      'Referer': 'https://mis.twse.com.tw/',
    },
  });

  if (!resp.ok) {
    throw new Error(`TWSE request failed for ${code}: ${resp.status}`);
  }

  const data = await resp.json();
  const msgArray = data?.msgArray;

  if (!msgArray || msgArray.length === 0) {
    // 非交易時間可能無即時資料，改用歷史收盤
    return await fetchClosingPrice(code);
  }

  const s = msgArray[0];

  // TWSE 欄位說明：
  // n  = 股票名稱
  // z  = 最新成交價 (盤中) or 收盤價
  // o  = 開盤價
  // h  = 最高價
  // l  = 最低價
  // v  = 成交量（張）
  // y  = 昨收
  // d  = 日期 (YYYYMMDD)
  const close = parseFloat(s.z) || parseFloat(s.y);
  const prevClose = parseFloat(s.y);
  const change = close - prevClose;
  const changePct = prevClose > 0 ? (change / prevClose * 100) : 0;

  return {
    code,
    name: s.n || code,
    close: close,
    open: parseFloat(s.o) || null,
    high: parseFloat(s.h) || null,
    low: parseFloat(s.l) || null,
    volume: parseInt(s.v) || null,
    prevClose,
    change: +change.toFixed(2),
    changePct: +changePct.toFixed(2),
    date: s.d || null,
    source: 'twse_realtime',
  };
}

/**
 * 備援：使用 TWSE 歷史日成交資料取得最近收盤價
 * 在非交易日或盤後使用
 */
async function fetchClosingPrice(code) {
  // 取近一個月資料，拿最後一筆
  const today = new Date();
  const yyyymm = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}`;

  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${code}&date=${yyyymm}01&response=json`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TWSEDashboard/1.0)' },
  });

  if (!resp.ok) throw new Error(`TWSE history fallback failed for ${code}`);

  const data = await resp.json();
  const rows = data?.data;

  if (!rows || rows.length === 0) {
    throw new Error(`No price data found for ${code}`);
  }

  // 最後一筆為最近交易日
  // 欄位順序：日期, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌價差, 成交筆數
  const last = rows[rows.length - 1];
  const close = parseFloat(last[6].replace(/,/g, ''));
  const open  = parseFloat(last[3].replace(/,/g, ''));
  const high  = parseFloat(last[4].replace(/,/g, ''));
  const low   = parseFloat(last[5].replace(/,/g, ''));
  const change = parseFloat(last[7].replace(/,/g, '')) || 0;
  const prevClose = close - change;

  return {
    code,
    name: data.title?.split(' ')[1] || code,
    close,
    open,
    high,
    low,
    volume: null,
    prevClose,
    change: +change.toFixed(2),
    changePct: prevClose > 0 ? +(change / prevClose * 100).toFixed(2) : 0,
    date: last[0],
    source: 'twse_history',
  };
}
