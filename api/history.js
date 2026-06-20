/**
 * api/history.js
 * 個股歷史日K資料 API
 * 資料來源：TWSE STOCK_DAY（上市）／TPEx tradingStock（上櫃），免 Token
 *
 * 呼叫：
 *   GET /api/history?code=2330&start=2026-01-02&end=2026-06-18
 *   GET /api/history?code=2330&start=2026-01-02   (end 預設今天)
 *
 * 回傳：
 *   { code, name, source, data: [ { date, open, high, low, close, volume }, ... ] }   // 日期升冪
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const base = `https://${req.headers.host || 'localhost'}`;
  const { searchParams } = new URL(req.url, base);
  const code = (searchParams.get('code') || '').trim();
  if (!code) return res.status(400).json({ error: '請提供 code 參數' });

  const start = searchParams.get('start') || `${new Date().getFullYear()}-01-02`;
  const end = searchParams.get('end') || new Date().toISOString().slice(0, 10);

  try {
    const months = monthList(start, end);
    // 並行抓各月，單月失敗不影響其他月
    const settled = await Promise.allSettled(months.map((ym) => fetchMonth(code, ym)));
    let rows = [];
    let name = code;
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        if (r.value.name) name = r.value.name;
        rows = rows.concat(r.value.rows);
      }
    }
    // 去重、過濾區間、升冪
    const seen = new Set();
    rows = rows
      .filter((d) => d.date >= start && d.date <= end)
      .filter((d) => (seen.has(d.date) ? false : (seen.add(d.date), true)))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return res.status(200).json({ code, name, source: 'twse_stock_day', data: rows });
  } catch (err) {
    console.error('[history.js] Error:', err.message);
    return res.status(200).json({ code, name: code, source: 'error', data: [], error: err.message });
  }
}

/** 產生 start~end 之間每個月的 'YYYYMM' 清單 */
function monthList(start, end) {
  const out = [];
  let [y, m] = [parseInt(start.slice(0, 4)), parseInt(start.slice(5, 7))];
  const ey = parseInt(end.slice(0, 4));
  const em = parseInt(end.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function n(v) {
  const x = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(x) ? x : null;
}

/** ROC 日期 "114/06/18" 或 "115/06/18" → "2026-06-18" */
function rocToISO(s) {
  const m = String(s).trim().match(/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  const y = parseInt(m[1]) + 1911;
  return `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function mapRows(dataRows) {
  // 欄位：日期, 成交股數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌, 筆數
  const out = [];
  for (const r of dataRows) {
    const date = rocToISO(r[0]);
    const close = n(r[6]);
    if (!date || close == null) continue;
    out.push({ date, open: n(r[3]), high: n(r[4]), low: n(r[5]), close, volume: n(r[1]) });
  }
  return out;
}

/** 抓單月：先試上市 STOCK_DAY，無資料再試上櫃 TPEx */
async function fetchMonth(code, ym) {
  const ua = { 'User-Agent': 'Mozilla/5.0 (compatible; TWSEDashboard/2.0)' };

  // 上市
  try {
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${code}&date=${ym}01&response=json`;
    const resp = await fetch(url, { headers: ua });
    if (resp.ok) {
      const j = await resp.json();
      if (j.stat === 'OK' && Array.isArray(j.data) && j.data.length) {
        const nm = (j.title || '').split(' ').filter(Boolean)[1] || '';
        return { name: nm, rows: mapRows(j.data) };
      }
    }
  } catch (e) { /* fall through to OTC */ }

  // 上櫃
  try {
    const y = ym.slice(0, 4), mm = ym.slice(4, 6);
    const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${y}/${mm}/01&response=json`;
    const resp = await fetch(url, { headers: ua });
    if (resp.ok) {
      const j = await resp.json();
      const tbl = j.tables && j.tables[0];
      if (tbl && Array.isArray(tbl.data) && tbl.data.length) {
        const nm = (tbl.subtitle || '').split(' ').filter(Boolean)[1] || '';
        return { name: nm, rows: mapRows(tbl.data) };
      }
    }
  } catch (e) { /* ignore */ }

  return { name: '', rows: [] };
}
