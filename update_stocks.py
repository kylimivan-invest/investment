#!/usr/bin/env python3
"""
台股儀表板 - 每日資料更新腳本
使用方式：每天下午 3:30 後在你的電腦執行
  python3 update_stocks.py

執行後會更新 data/stocks.json
再把這個檔案上傳到 GitHub 即可
"""

import requests, json, time, os
from datetime import datetime, timedelta

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.twse.com.tw/zh/trading/exchange/BWIBBU_d.html',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-TW,zh;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
}

FINANCE = {'2882','2881','2886','2891','2892','2884','2885','2880','2887','2888',
           '5876','2823','2836','2838','2834','2838','6005','2820'}
LARGE   = {'2330','2317','2454','2882','2881','2886','2891','2892','2884','2885',
           '2880','2002','1301','1303','2412','3045','2382','3711','2303','2408','2308'}

SECTOR_MAP = {
    'semi':     {'2330','2454','2303','2379','2408','3711','2337','3034','2344',
                 '6274','2385','2388','3443','6415','3661','3105','2449','4958','5347','6257','3081'},
    'finance':  {'2882','2881','2886','2891','2892','2884','2885','2880','2887',
                 '2888','5876','2823','2836','2838','2834','6005','2820'},
    'tech':     {'2317','2308','2357','2382','4938','2345','6669','2395','2327',
                 '2474','3231','2376','2353','2352','3008','2458','3533','6770','3037','2441'},
    'trad':     {'2412','3045','4904','2498'},
    'chem':     {'1301','1303','1326','1308','6505','1314','1710'},
    'steel':    {'2002','2008','2014','2015','2006'},
    'shipping': {'2603','2609','2615','2610','2618'},
    'biotech':  {'4720','6446','4168','1722','6548'},
    'food':     {'1216','1203','1225','1215'},
}

def get_sector(code):
    for sec, codes in SECTOR_MAP.items():
        if code in codes: return sec
    return 'other'

def get_trade_date():
    """取今天或最近交易日"""
    now = datetime.now()
    # 若未到收盤（15:00），用前一天
    if now.hour < 15:
        now -= timedelta(days=1)
    # 往前找最近的週一到週五
    for i in range(7):
        d = now - timedelta(days=i)
        if d.weekday() < 5:  # 0=Monday, 4=Friday
            return d.strftime('%Y%m%d')
    return now.strftime('%Y%m%d')

def fetch_bwibbu(date):
    """拉取殖利率/本益比資料"""
    url = f'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date={date}&response=json'
    print(f'[1/3] 拉取 BWIBBU_d {date}...')
    resp = requests.get(url, headers=HEADERS, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    if data.get('stat') != 'OK':
        raise ValueError(f"TWSE 回傳非OK: {data.get('stat')}, date={date}")
    print(f'      → {len(data["data"])} 筆')
    return data

def fetch_institutional(date):
    """拉取三大法人買賣超"""
    url = f'https://www.twse.com.tw/rwd/zh/fund/T86?date={date}&selectType=ALL&response=json'
    print(f'[2/3] 拉取三大法人 {date}...')
    try:
        resp = requests.get(url, headers={**HEADERS, 'Referer':'https://www.twse.com.tw/zh/fund/T86.html'}, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        if data.get('stat') != 'OK':
            print(f'      → 三大法人無資料（{data.get("stat")}），跳過')
            return {}
        fields = data.get('fields', [])
        ci  = next((i for i,f in enumerate(fields) if '證券代號' in f), 0)
        fni = next((i for i,f in enumerate(fields) if '外陸資買賣超' in f), -1)
        tni = next((i for i,f in enumerate(fields) if '投信買賣超' in f), -1)
        inst_map = {}
        for row in data.get('data', []):
            code = row[ci].strip() if ci < len(row) else ''
            if not code or not code.isdigit() or len(code) != 4:
                continue
            fn = int(row[fni].replace(',','')) if fni >= 0 and fni < len(row) else 0
            tn = int(row[tni].replace(',','')) if tni >= 0 and tni < len(row) else 0
            inst_map[code] = {'foreignNet': fn, 'trustNet': tn}
        print(f'      → {len(inst_map)} 檔')
        return inst_map
    except Exception as e:
        print(f'      → 失敗（{e}），跳過')
        return {}

def fetch_day_all(date):
    """拉取全市場收盤價"""
    url = f'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={date}&response=json'
    print(f'[3/3] 拉取收盤價 {date}...')
    try:
        resp = requests.get(url, headers={**HEADERS, 'Referer':'https://www.twse.com.tw/zh/trading/exchange/MI_INDEX.html'}, timeout=15)
        resp.raise_for_status()
        # 也試 STOCK_DAY_ALL
        url2 = f'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?date={date}&response=json'
        resp2 = requests.get(url2, headers=HEADERS, timeout=15)
        if resp2.status_code == 200:
            data = resp2.json()
            if data.get('stat') == 'OK' and data.get('data'):
                fields = data.get('fields',[])
                ci = next((i for i,f in enumerate(fields) if '證券代號' in f), 0)
                pi = next((i for i,f in enumerate(fields) if '收盤價' in f), 8)
                price_map = {}
                for row in data['data']:
                    code = row[ci].strip() if ci<len(row) else ''
                    if len(code)==4 and code.isdigit():
                        try:
                            price_map[code] = float(row[pi].replace(',',''))
                        except:
                            pass
                print(f'      → {len(price_map)} 檔收盤價')
                return price_map
        print('      → 無法取得收盤價，跳過')
        return {}
    except Exception as e:
        print(f'      → 失敗（{e}），跳過')
        return {}

def fetch_income():
    """損益表(季)：真實 EPS 與營業利益率　來源 t187ap14_L"""
    url='https://openapi.twse.com.tw/v1/opendata/t187ap14_L'
    print('[4/5] 拉取損益表(EPS/營益率)...')
    inc={}
    try:
        resp=requests.get(url, headers=HEADERS, timeout=20); resp.raise_for_status()
        for r in resp.json():
            code=str(r.get('公司代號','')).strip()
            if not (code.isdigit() and len(code)==4): continue
            def num(x):
                try: return float(str(x).replace(',',''))
                except: return None
            eps=num(r.get('基本每股盈餘(元)'))
            rev=num(r.get('營業收入')); op=num(r.get('營業利益')); net=num(r.get('稅後淨利'))
            opm=(op/rev*100) if (rev and op is not None) else None
            netm=(net/rev*100) if (rev and net is not None) else None
            inc[code]={'eps':eps,'opmargin':opm,'netmargin':netm}
        print(f'      → {len(inc)} 檔')
    except Exception as e:
        print(f'      → 失敗（{e}），跳過')
    return inc

def fetch_revenue():
    """月營收：真實去年同月增減(%)　來源 t187ap05_L"""
    url='https://openapi.twse.com.tw/v1/opendata/t187ap05_L'
    print('[5/5] 拉取月營收(年增率)...')
    rev={}
    try:
        resp=requests.get(url, headers=HEADERS, timeout=20); resp.raise_for_status()
        for r in resp.json():
            code=str(r.get('公司代號','')).strip()
            if not (code.isdigit() and len(code)==4): continue
            try: rev[code]=float(str(r.get('營業收入-去年同月增減(%)','')).replace(',',''))
            except: pass
        print(f'      → {len(rev)} 檔')
    except Exception as e:
        print(f'      → 失敗（{e}），跳過')
    return rev

def build_stocks(bwi_data, inst_map, price_map, inc_map=None, rev_map=None):
    inc_map = inc_map or {}; rev_map = rev_map or {}
    """整合資料"""
    fields = bwi_data.get('fields', [])
    ci  = next((i for i,f in enumerate(fields) if '證券代號' in f), 0)
    ni  = next((i for i,f in enumerate(fields) if '證券名稱' in f), 1)
    pei = next((i for i,f in enumerate(fields) if '本益比' in f), 2)
    yi  = next((i for i,f in enumerate(fields) if '殖利率' in f), 4)
    pbi = next((i for i,f in enumerate(fields) if '股價淨值比' in f), 5)

    stocks = []
    for row in bwi_data.get('data', []):
        code = row[ci].strip() if ci < len(row) else ''
        if not code or not code.isdigit() or len(code) != 4:
            continue
        name = row[ni].strip() if ni < len(row) else code
        try:
            pe     = float(row[pei]) if pei < len(row) and row[pei].strip() else 0
            yield_ = float(row[yi])  if yi  < len(row) and row[yi].strip()  else 0
            pb     = float(row[pbi]) if pbi < len(row) and row[pbi].strip() else 0
        except:
            continue
        if yield_ <= 0 and pe <= 0:
            continue

        roe   = round(pb/pe*100, 1) if pb > 0 and pe > 0 else 8.0
        inst  = inst_map.get(code, {})
        close = price_map.get(code, 0)
        is_finance = code in FINANCE
        # 真實基本面
        _inc = inc_map.get(code, {})
        eps_rep = _inc.get('eps')
        op_m    = _inc.get('opmargin')
        # EPS：優先用本益比還原(近12月，精確)；無本益比時用申報EPS
        if pe and pe > 0 and close:
            eps_val = round(close / pe, 2)
        elif eps_rep is not None:
            eps_val = round(eps_rep, 2)
        else:
            eps_val = 0
        rev_g = rev_map.get(code)

        stocks.append({
            'code': code, 'name': name, 'sector': get_sector(code),
            'close': close, 'yield_': round(yield_, 2), 'roe': roe, 'eps': eps_val,
            'pe': round(pe, 1), 'pb': round(pb, 2),
            'debt': 85 if is_finance else 45,
            'cr': None if is_finance else 150,
            'fcf': True, 'ma20': True, 'ma60': True, 'kd': yield_ > 4,
            'foreign': inst.get('foreignNet', 0) > 0,
            'trust':   inst.get('trustNet',   0) > 0,
            'foreignNet': inst.get('foreignNet', 0),
            'trustNet':   inst.get('trustNet',   0),
            'margin': 30,
            'divYears': 8 if yield_ >= 5 else (5 if yield_ >= 3 else 2),
            'chg1w': 0, 'chg1m': 0, 'chg3m': 0, 'chg1y': 0,
            'w52lo': 0, 'w52hi': 0,
            'grossMargin': round(op_m,1) if op_m is not None else 20,  # 近似:營業利益率(真毛利需另抓)
            'revenueGrowth': round(rev_g,1) if rev_g is not None else 0,
            'largeCap': code in LARGE,
            'ytd': 0, 'price_jan': 0,
        })
    return stocks

def main():
    print('='*50)
    print('台股儀表板 - 每日資料更新')
    print('='*50)

    date = get_trade_date()
    print(f'交易日：{date}')
    print()

    # 拉資料
    bwi_data  = fetch_bwibbu(date)
    time.sleep(1)
    inst_map  = fetch_institutional(date)
    time.sleep(1)
    price_map = fetch_day_all(date)
    time.sleep(1)
    inc_map   = fetch_income()
    time.sleep(1)
    rev_map   = fetch_revenue()

    # 整合
    stocks = build_stocks(bwi_data, inst_map, price_map, inc_map, rev_map)
    print(f'\n整合完成：{len(stocks)} 檔股票')

    # 寫入 JSON
    output = {
        'updated': date[:4]+'-'+date[4:6]+'-'+date[6:],
        'tradeDate': date,
        'source': 'TWSE BWIBBU_d + 損益表 + 月營收',
        'count': len(stocks),
        'stocks': stocks,
    }
    os.makedirs('data', exist_ok=True)
    with open('data/stocks.json', 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f'✅ 已寫入 data/stocks.json')
    print()
    print('下一步：把 data/stocks.json 上傳到 GitHub')
    print('  方法1：拖曳上傳到 GitHub 網頁')
    print('  方法2：git add data/stocks.json && git commit -m "update stocks" && git push')

if __name__ == '__main__':
    main()
