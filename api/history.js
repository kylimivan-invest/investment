/**
 * api/history.js
 * 個股歷史日K資料 API
 * 資料來源：FinMind（需要 Token）
 *
 * 呼叫方式：
 *   GET /api/history?code=2330&start=2026-01-02&end=2026-03-27
 *   GET /api/history?code=2330&start=2021-01-01   (不傳 end 預設今天)
 *
 * 回傳格式：
 *   {
 *     code, name,
 *     data: [ { date, open, high, low, close, volume, change, changePct }, ... ]
 *   }
 */

// ── FinMind Token 設定 ─────────────────────────────────────────────
// 申請地址：https://finmindtrade.com/analysis/#/Finmind_token
// 申請後填入下方，或設定為 Vercel 環境變數 FINMIND_TOKEN
// 建議做法：在 Vercel Dashboard → Settings → Environment Variables 加入
//           FINMIND_TOKEN = your_token_here
// 免費方案限制：每分鐘 30 次請求，每次最多回傳 1800 筆（約5年日K）
const FINMIND_TOKEN = process.env.FINMIND_TOKEN || '';
// ──────────────────────────────────────────────────────────────────

const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4/data';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code, start, end } = req.query;

  if (!code) {
    return res.status(400).json({ error: '請提供 code 參數（股票代號）' });
  }

  // 預設起始日期：2026-01-02（今年年初）
  const startDate = start || '2026-01-02';
  // 預設結束日期：今天
  const endDate = end || new Date().toISOString().split('T')[0];

  // 如果沒有 Token，回傳說明
  if (!FINMIND_TOKEN) {
    return res.status(503).json({
      error: 'FINMIND_TOKEN 未設定',
      message: '請至 https://finmindtrade.com 申請 Token，並設定 Vercel 環境變數 FINMIND_TOKEN',
      // 開發期間回傳假資料供前端測試
      mock: true,
      code,
      data: generateMockHistory(code, startDate, endDate),
    });
  }

  try {
    const params = new URLSearchParams({
      dataset: 'TaiwanStockPrice',
      data_id: code,
      start_date: startDate,
      end_date: endDate,
      token: FINMIND_TOKEN,
    });

    const resp = await fetch(`${FINMIND_BASE}?${params}`, {
      headers: { 'User-Agent': 'TWSEDashboard/1.0' },
    });

    if (!resp.ok) {
      throw new Error(`FinMind API error: ${resp.status}`);
    }

    const json = await resp.json();

    if (json.status !== 200) {
      throw new Error(`FinMind error: ${json.msg || 'Unknown error'}`);
    }

    // 整理資料格式
    const rows = json.data || [];
    const processed = rows.map((r, i) => {
      const prevClose = i > 0 ? rows[i-1].close : r.open;
      const change = r.close - prevClose;
      return {
        date: r.date,
        open: r.open,
        high: r.max,
        low: r.min,
        close: r.close,
        volume: r.Trading_Volume,
        change: +change.toFixed(2),
        changePct: prevClose > 0 ? +(change / prevClose * 100).toFixed(2) : 0,
      };
    });

    return res.status(200).json({
      code,
      name: rows[0]?.stock_id || code,
      start: startDate,
      end: endDate,
      count: processed.length,
      data: processed,
    });

  } catch (err) {
    console.error('[history.js] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * 無 Token 時的假資料產生器（開發/Demo 用）
 * 用於前端 UI 測試，讓儀表板在沒有 Token 時也能正常顯示
 */
function generateMockHistory(code, startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);

  // 各股票的近似基準價（Demo 用）
  const basePrices = {
    '2330': 980, '2454': 1200, '2317': 220, '2882': 60,
    '2881': 85, '2886': 39, '2892': 30, '2308': 350,
    '2412': 126, '2357': 475, '2379': 580, '2345': 265,
    '2891': 29, '2002': 27, '6669': 1500, '1301': 83,
  };
  const base = basePrices[code] || 100;

  const rows = [];
  let price = base * 0.92; // 從年初較低點開始
  const current = new Date(start);

  while (current <= end) {
    const dow = current.getDay();
    if (dow !== 0 && dow !== 6) { // 跳過週末
      const change = (Math.random() - 0.47) * base * 0.022;
      price = Math.max(base * 0.6, Math.min(base * 1.5, price + change));
      const open  = +(price * (1 + (Math.random() - 0.5) * 0.01)).toFixed(1);
      const high  = +(Math.max(open, price) * (1 + Math.random() * 0.008)).toFixed(1);
      const low   = +(Math.min(open, price) * (1 - Math.random() * 0.008)).toFixed(1);
      const close = +price.toFixed(1);
      const prevClose = rows.length > 0 ? rows[rows.length-1].close : base;
      rows.push({
        date: current.toISOString().split('T')[0],
        open, high, low, close,
        volume: Math.floor(Math.random() * 50000 + 5000),
        change: +(close - prevClose).toFixed(2),
        changePct: +((close - prevClose) / prevClose * 100).toFixed(2),
      });
    }
    current.setDate(current.getDate() + 1);
  }

  // 最後一天對齊基準價
  if (rows.length > 0) {
    rows[rows.length - 1].close = base;
  }

  return rows;
}
