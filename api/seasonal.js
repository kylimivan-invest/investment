/**
 * api/seasonal.js
 * 個股月份季節效應計算 API
 * 資料來源：FinMind 歷史日K（需要 Token）
 *
 * 呼叫方式：
 *   GET /api/seasonal?code=2330&years=5
 *   GET /api/seasonal?codes=2330,2454,2882&years=5   (批次)
 *
 * 回傳格式（單支）：
 *   {
 *     code,
 *     monthly_avg: [+2.1, -1.2, +3.8, ...],   // 12個月平均報酬 %
 *     monthly_detail: [                          // 逐年明細
 *       { month:1, year:2021, return:+3.2 },
 *       ...
 *     ],
 *     hit_rate: [0.8, 0.4, 0.6, ...],           // 各月正報酬機率
 *   }
 *
 * 計算邏輯：
 *   - 取每月第一個交易日開盤價 & 最後一個交易日收盤價
 *   - 月報酬 = (月末收盤 / 月初開盤 - 1) × 100
 *   - 平均 = 過去 N 年同月的算術平均
 */

// ── FinMind Token（同 history.js） ────────────────────────────────
const FINMIND_TOKEN = process.env.FINMIND_TOKEN || '';
const FINMIND_BASE  = 'https://api.finmindtrade.com/api/v4/data';
// ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code, codes, years = '5' } = req.query;
  const nYears = Math.min(parseInt(years) || 5, 10); // 最多10年

  const codeList = codes
    ? codes.split(',').map(c => c.trim()).filter(Boolean)
    : code ? [code.trim()] : [];

  if (codeList.length === 0) {
    return res.status(400).json({ error: '請提供 code 或 codes 參數' });
  }

  // 計算起始日期：N年前的1月1日
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - nYears;
  const startDate = `${startYear}-01-01`;
  const endDate = new Date().toISOString().split('T')[0];

  // 無 Token 時回傳假資料
  if (!FINMIND_TOKEN) {
    const mockResults = codeList.reduce((acc, c) => {
      acc[c] = generateMockSeasonal(c, nYears);
      return acc;
    }, {});

    return res.status(503).json({
      error: 'FINMIND_TOKEN 未設定',
      message: '請至 https://finmindtrade.com 申請 Token，並設定環境變數 FINMIND_TOKEN',
      mock: true,
      years: nYears,
      data: codeList.length === 1 ? mockResults[codeList[0]] : mockResults,
    });
  }

  try {
    // 批次拉資料（注意 FinMind 免費版有速率限制，批次需間隔）
    const results = {};
    for (const c of codeList) {
      results[c] = await fetchAndComputeSeasonal(c, startDate, endDate, nYears);
      // 免費版速率限制：30 req/min → 每次延遲 200ms
      if (codeList.length > 1) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    return res.status(200).json({
      years: nYears,
      start: startDate,
      end: endDate,
      data: codeList.length === 1 ? results[codeList[0]] : results,
    });

  } catch (err) {
    console.error('[seasonal.js] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * 從 FinMind 拉日K，計算各月份季節效應
 */
async function fetchAndComputeSeasonal(code, startDate, endDate, nYears) {
  const params = new URLSearchParams({
    dataset: 'TaiwanStockPrice',
    data_id: code,
    start_date: startDate,
    end_date: endDate,
    token: FINMIND_TOKEN,
  });

  const resp = await fetch(`${FINMIND_BASE}?${params}`);
  if (!resp.ok) throw new Error(`FinMind fetch failed for ${code}: ${resp.status}`);

  const json = await resp.json();
  if (json.status !== 200) throw new Error(`FinMind error: ${json.msg}`);

  return computeMonthlyReturns(code, json.data || [], nYears);
}

/**
 * 核心計算：從日K計算月報酬
 */
function computeMonthlyReturns(code, rows, nYears) {
  if (rows.length === 0) return { code, monthly_avg: new Array(12).fill(0), monthly_detail: [], hit_rate: new Array(12).fill(0) };

  // 按年月分組
  const byYearMonth = {};
  for (const r of rows) {
    const [y, m] = r.date.split('-');
    const key = `${y}-${m}`;
    if (!byYearMonth[key]) byYearMonth[key] = [];
    byYearMonth[key].push(r);
  }

  const monthly_detail = [];
  for (const [ym, dayRows] of Object.entries(byYearMonth)) {
    const [year, monthStr] = ym.split('-');
    const month = parseInt(monthStr);
    // 月第一天開盤、月最後一天收盤
    const firstDay = dayRows[0];
    const lastDay  = dayRows[dayRows.length - 1];
    const open  = firstDay.open || firstDay.close;
    const close = lastDay.close;
    if (!open || !close) continue;
    const ret = +((close / open - 1) * 100).toFixed(2);
    monthly_detail.push({ year: parseInt(year), month, return: ret });
  }

  // 各月份平均
  const monthly_avg = [];
  const hit_rate = [];
  for (let m = 1; m <= 12; m++) {
    const vals = monthly_detail.filter(d => d.month === m).map(d => d.return);
    if (vals.length === 0) {
      monthly_avg.push(0);
      hit_rate.push(0);
    } else {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      monthly_avg.push(+avg.toFixed(2));
      hit_rate.push(+(vals.filter(v => v > 0).length / vals.length).toFixed(2));
    }
  }

  return {
    code,
    years_computed: nYears,
    monthly_avg,
    monthly_detail,
    hit_rate,
  };
}

/**
 * 假資料產生（無 Token 時）
 */
function generateMockSeasonal(code, nYears) {
  // 各股的月份偏好（簡化版）
  const patterns = {
    '2330': [+2.1,-1.2,+3.8,+5.2,-2.1,+1.8,+4.3,+2.9,-0.5,+3.1,+6.2,+1.8],
    '2454': [+3.2,-0.8,+4.5,+6.8,-3.2,+2.5,+5.1,+3.4,-1.2,+4.2,+7.8,+2.4],
    default: new Array(12).fill(0).map(() => +(Math.random()*6-2).toFixed(1)),
  };
  const monthly_avg = patterns[code] || patterns.default;

  // 產生逐年明細
  const monthly_detail = [];
  const currentYear = new Date().getFullYear();
  for (let yr = currentYear - nYears; yr < currentYear; yr++) {
    for (let m = 1; m <= 12; m++) {
      const base = monthly_avg[m-1];
      const noise = (Math.random() - 0.5) * 3;
      monthly_detail.push({ year: yr, month: m, return: +(base + noise).toFixed(2) });
    }
  }

  const hit_rate = monthly_avg.map(v =>
    +(0.5 + v / 20 + (Math.random()-0.5)*0.1).toFixed(2)
  );

  return { code, years_computed: nYears, monthly_avg, monthly_detail, hit_rate };
}
