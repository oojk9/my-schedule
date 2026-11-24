#!/usr/bin/env python3
"""나라장터 입찰공고 받기 (공공데이터포털 '조달청_나라장터 입찰공고정보서비스')

GitHub Actions가 하루 몇 번 이 파일을 실행해서 최근 공고를 bids/ 폴더에 날짜별 JSON으로 저장해요.
앱(index.html)과 서비스워커(sw.js)는 그 파일을 읽어 내 조건에 맞는 공고만 보여 줍니다.

필요한 것: 환경변수 G2B_KEY (data.go.kr에서 받은 '일반 인증키(Decoding)').
실행:      python3 tools/fetch_bids.py --out bids            (GitHub Actions에서는 자동)
확인:      python3 tools/fetch_bids.py --probe               (API가 되는지, 어떤 항목이 오는지 1건만 보기)
표준 라이브러리만 사용 — 따로 설치할 것 없음.
"""
import argparse, datetime as dt, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

KST = dt.timezone(dt.timedelta(hours=9))
BASE_NEW = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService02'   # 2026-11 개편 주소
BASE_OLD = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService'     # 개편 전 주소(당분간 함께 열려 있음)
# 업무 구분별 '나라장터 검색조건에 의한 입찰공고 조회' 오퍼레이션 (개편 후엔 이름 끝에 02가 붙음)
OPS = {'물품': 'getBidPblancListInfoThngPPSSrch', '용역': 'getBidPblancListInfoServcPPSSrch',
       '공사': 'getBidPblancListInfoCnstwkPPSSrch', '외자': 'getBidPblancListInfoFrgcptPPSSrch'}
# 보조 정보(있으면 좋고 없어도 됨): 면허·업종 제한, 참가 가능 지역
OP_LIC = 'getBidPblancListInfoLicenseLimit'
OP_RGN = 'getBidPblancListInfoPrtcptPsblRgn'
ROWS = 999
UA = 'ilsu-notebook-bids/1.0 (+github actions)'


def log(*a):
    print(*a, flush=True)


def call(base, op, params, key, timeout=40):
    """API 한 번 호출 → (header, body) 또는 예외. 재시도 3번."""
    q = dict(params)
    q['serviceKey'] = key
    q['type'] = 'json'
    url = f'{base}/{op}?' + urllib.parse.urlencode(q, safe='')
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
            text = raw.decode('utf-8', 'replace')
            try:
                data = json.loads(text)
            except ValueError:
                # XML로 오면(키가 잘못됐거나 서비스 오류일 때 흔함) 메시지만 뽑아서 알려 줌
                m = re.search(r'<returnReasonCode>(.*?)</returnReasonCode>', text) or re.search(r'<resultCode>(.*?)</resultCode>', text)
                msg = re.search(r'<(?:returnAuthMsg|resultMsg|errMsg)>(.*?)</', text)
                raise RuntimeError(f'JSON이 아닌 응답 (code={m.group(1) if m else "?"}, msg={msg.group(1) if msg else text[:120]!r})')
            resp = data.get('response') if isinstance(data, dict) else None
            if not isinstance(resp, dict):
                raise RuntimeError(f'알 수 없는 응답 모양: {text[:160]!r}')
            header = resp.get('header') or {}
            code = str(header.get('resultCode', '')).strip().zfill(2)
            if code != '00':
                raise RuntimeError(f'resultCode={code} ({header.get("resultMsg", "")})')
            return header, (resp.get('body') or {})
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(2 * (attempt + 1)); continue
            raise RuntimeError(f'HTTP {e.code}') from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
            if attempt < 2:
                time.sleep(2 * (attempt + 1)); continue
            raise RuntimeError(f'연결 실패: {e}') from e
    raise RuntimeError(f'실패: {last}')


def items_of(body):
    it = body.get('items')
    if isinstance(it, dict):
        it = it.get('item', [])
    if isinstance(it, dict):
        it = [it]
    return [x for x in (it or []) if isinstance(x, dict)]


def fetch_all(base, op, params, key, note):
    """페이지를 끝까지 돌며 모두 모음."""
    out, page = [], 1
    while True:
        header, body = call(base, op, dict(params, pageNo=page, numOfRows=ROWS), key)
        got = items_of(body)
        out.extend(got)
        total = int(body.get('totalCount') or 0)
        if not got or len(out) >= total or page >= 20:
            break
        page += 1
        time.sleep(0.25)
    log(f'    {note}: {len(out)}건')
    return out


def try_variants(op, params, key, note):
    """개편 후 이름(…02) → 개편 후 주소의 옛 이름 → 옛 주소 순으로 시도."""
    errs = []
    for base, name in ((BASE_NEW, op + '02'), (BASE_NEW, op), (BASE_OLD, op)):
        try:
            return fetch_all(base, name, params, key, f'{note} [{name}]'), f'{base}/{name}'
        except RuntimeError as e:
            errs.append(f'{name}: {e}')
            time.sleep(0.3)
    raise RuntimeError(' / '.join(errs))


def norm_dt(v):
    """'2026-11-13 10:00:00' · '202611131000' · '2026/11/13 10:00' → '2026-11-13 10:00'"""
    s = str(v or '').strip()
    if not s:
        return ''
    d = re.sub(r'\D', '', s)
    if len(d) >= 12:
        return f'{d[0:4]}-{d[4:6]}-{d[6:8]} {d[8:10]}:{d[10:12]}'
    if len(d) >= 8:
        return f'{d[0:4]}-{d[4:6]}-{d[6:8]}'
    return s[:16]


def to_int(v):
    s = re.sub(r'[^\d]', '', str(v or ''))
    return int(s) if s else 0


def pick(it, *names):
    for n in names:
        v = it.get(n)
        if v not in (None, ''):
            return str(v).strip()
    return ''


def compact(it, cat):
    rec = {
        'n': pick(it, 'bidNtceNo'), 'o': pick(it, 'bidNtceOrd') or '00', 'c': cat,
        't': pick(it, 'bidNtceNm'), 'i': pick(it, 'ntceInsttNm'), 'd': pick(it, 'dminsttNm'),
        'p': norm_dt(pick(it, 'bidNtceDt', 'bidNtceBgnDt')), 'e': norm_dt(pick(it, 'bidClseDt')), 'g': norm_dt(pick(it, 'opengDt')),
        'b': to_int(pick(it, 'asignBdgtAmt')), 'q': to_int(pick(it, 'presmptPrce')),
        'k': pick(it, 'ntceKindNm'), 'm': pick(it, 'cntrctCnclsMthdNm'), 'w': pick(it, 'bidMethdNm'),
        'u': pick(it, 'bidNtceDtlUrl', 'bidNtceUrl'),
        'r': pick(it, 'prtcptLmtRgnNm', 'prtcptPsblRgnNm', 'cnstrtsiteRgnNm'),
        'l': pick(it, 'lcnsLmtNm', 'indstrytyNm', 'permsnIndstrytyNm', 'indstrytyLmtNm'),
        's': pick(it, 'srvceDivNm', 'cnstrtyNm', 'prdctClsfcNoNm'),
    }
    if rec['d'] == rec['i']:
        rec['d'] = ''
    return rec


def names_from(it, skip=('bidNtceNo', 'bidNtceOrd')):
    """보조 응답에서 '…Nm'으로 끝나는 글자 항목만 모아 이름 목록으로 (항목 이름이 바뀌어도 동작하게)"""
    out = []
    for k, v in it.items():
        if k in skip or not isinstance(v, str) or not v.strip():
            continue
        if k.endswith('Nm') or k.endswith('Name'):
            v = v.strip()
            if v not in out:
                out.append(v)
    return out


def enrich(recs, key, bgn, end, op, field, label):
    """면허 제한·참가 지역 정보를 같은 기간으로 받아 공고번호-차수로 붙임 (안 되면 건너뜀)"""
    by = {}
    try:
        rows, _ = try_variants(op, {'inqryDiv': '1', 'inqryBgnDt': bgn, 'inqryEndDt': end}, key, label)
    except RuntimeError as e:
        log(f'    {label}: 건너뜀 ({e})')
        return 0
    for it in rows:
        k = (pick(it, 'bidNtceNo'), pick(it, 'bidNtceOrd') or '00')
        by.setdefault(k, [])
        for nm in names_from(it):
            if nm not in by[k]:
                by[k].append(nm)
    n = 0
    for r in recs:
        v = by.get((r['n'], r['o']))
        if v and not r.get(field):
            r[field] = ' · '.join(v)[:300]
            n += 1
    return n


def hint_for(errs):
    """실패 원인을 사람이 읽을 수 있게 — README '문제가 생겼을 때'의 문구와 맞춤"""
    text = ' '.join(errs)
    # data.go.kr 공통 오류 코드: 30 미등록 키, 31 기한 만료, 32 미등록 IP, 20 접근 거부, 22 일일 한도 초과, 01·04 서비스 오류
    if re.search(r'code=(30|31|32|20)\b|SERVICE_KEY|SERVICE ACCESS DENIED|활용신청', text, re.I):
        return '→ 인증키 오류·미승인: data.go.kr 활용신청이 승인됐는지(1~2시간 걸릴 수 있어요), GitHub Secret G2B_KEY에 일반 인증키(Decoding)를 넣었는지 확인해 주세요.'
    if re.search(r'code=22\b|LIMITED_NUMBER', text, re.I):
        return '→ 오늘 호출 한도를 넘었어요. 다음 실행 때 다시 받아요.'
    if 'HTTP 404' in text or 'HTTP 410' in text:
        return '→ API 주소가 바뀐 것 같아요. data.go.kr 서비스 페이지의 End Point 주소를 확인해 이 파일 맨 위 BASE_NEW를 고쳐 주세요.'
    if '연결 실패' in text or re.search(r'HTTP 5\d\d', text):
        return '→ 공공데이터포털이 점검 중이거나 응답이 없어요. 다음 실행 때 저절로 다시 받아요.'
    return '→ 인증키·활용신청 상태를 확인해 주세요. (python3 tools/fetch_bids.py --probe 로 자세히 볼 수 있어요)'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='bids', help='저장 폴더 (기본 bids)')
    ap.add_argument('--days', type=int, default=int(os.environ.get('BIDS_DAYS', '3')), help='오늘부터 며칠 치를 다시 받을지 (기본 3)')
    ap.add_argument('--keep', type=int, default=int(os.environ.get('BIDS_KEEP', '14')), help='며칠 치 파일을 남길지 (기본 14)')
    ap.add_argument('--cats', default=os.environ.get('BIDS_CATS', '물품,용역,공사'), help='업무 구분 (기본 물품,용역,공사 — 외자도 가능)')
    ap.add_argument('--probe', action='store_true', help='API 확인만: 오늘 용역 공고 1페이지 받아 항목 이름을 보여 줌')
    a = ap.parse_args()
    key = (os.environ.get('G2B_KEY') or '').strip()
    if not key:
        log('G2B_KEY가 없어요. data.go.kr 인증키(Decoding)를 GitHub Secrets에 G2B_KEY 이름으로 넣어 주세요.')
        return 2
    if '%' in key:
        key = urllib.parse.unquote(key)   # Encoding 키를 넣었어도 되게
    cats = [c.strip() for c in a.cats.split(',') if c.strip() in OPS]
    now = dt.datetime.now(KST)
    today = now.date()

    if a.probe:
        bgn, end = today.strftime('%Y%m%d') + '0000', today.strftime('%Y%m%d') + '2359'
        try:
            header, body = None, None
            for base, name in ((BASE_NEW, OPS['용역'] + '02'), (BASE_NEW, OPS['용역']), (BASE_OLD, OPS['용역'])):
                try:
                    header, body = call(base, name, {'inqryDiv': '1', 'inqryBgnDt': bgn, 'inqryEndDt': end, 'pageNo': 1, 'numOfRows': 3}, key)
                    log(f'성공: {base}/{name}  totalCount={body.get("totalCount")}')
                    break
                except RuntimeError as e:
                    log(f'안 됨: {name} → {e}')
            if body is None:
                return 1
            rows = items_of(body)
            if rows:
                log('첫 공고의 항목 이름들:'); log(json.dumps(rows[0], ensure_ascii=False, indent=1)[:3000])
                log('정리한 모양:'); log(json.dumps(compact(rows[0], '용역'), ensure_ascii=False, indent=1))
            else:
                log('오늘 올라온 용역 공고가 아직 없어요 (API는 정상).')
            return 0
        except RuntimeError as e:
            log('실패:', e); return 1

    os.makedirs(a.out, exist_ok=True)
    days = [today - dt.timedelta(days=i) for i in range(a.days)]
    ok_any, fail = False, []
    for day in days:
        bgn, end = day.strftime('%Y%m%d') + '0000', day.strftime('%Y%m%d') + '2359'
        log(f'{day} 공고 받는 중…')
        recs, seen = [], set()
        for cat in cats:
            try:
                rows, used = try_variants(OPS[cat], {'inqryDiv': '1', 'inqryBgnDt': bgn, 'inqryEndDt': end}, key, cat)
                ok_any = True
            except RuntimeError as e:
                fail.append(f'{day} {cat}: {e}')
                log(f'    {cat}: 실패 — {e}')
                continue
            for it in rows:
                r = compact(it, cat)
                if not r['n'] or not r['t']:
                    continue
                k = (r['n'], r['o'])
                if k in seen:
                    continue
                seen.add(k); recs.append(r)
            time.sleep(0.25)
        if not recs and not ok_any:
            continue
        n1 = enrich(recs, key, bgn, end, OP_LIC, 'l', '면허·업종 제한')
        n2 = enrich(recs, key, bgn, end, OP_RGN, 'r', '참가 가능 지역')
        log(f'    업종 정보 {n1}건, 지역 정보 {n2}건 붙임')
        recs.sort(key=lambda r: (r['e'] or '9999', r['n'], r['o']))
        stamp = now.strftime('%Y-%m-%dT%H:%M+09:00')
        path = os.path.join(a.out, f'{day.isoformat()}.json')
        # 내용이 그대로면 '갱신 시각'도 그대로 둬서, 앱·폰이 같은 파일을 다시 받지 않게
        try:
            prev = json.load(open(path, encoding='utf-8'))
            if prev.get('items') == recs and prev.get('updated'):
                stamp = prev['updated']
        except Exception:
            pass
        json.dump({'day': day.isoformat(), 'updated': stamp, 'n': len(recs), 'items': recs}, open(path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
        log(f'  → {path} ({len(recs)}건)')

    if not ok_any:
        log('공고를 하나도 받지 못했어요.')
        for f in fail:
            log('  -', f)
        log(hint_for(fail))
        return 1

    # 오래된 날짜 파일 정리 + 목차(index.json)
    cutoff = (today - dt.timedelta(days=a.keep)).isoformat()
    index = {}
    for fn in sorted(os.listdir(a.out)):
        m = re.fullmatch(r'(\d{4}-\d{2}-\d{2})\.json', fn)
        if not m:
            continue
        p = os.path.join(a.out, fn)
        if m.group(1) < cutoff:
            os.remove(p); continue
        try:
            d = json.load(open(p, encoding='utf-8'))
            index[m.group(1)] = {'n': int(d.get('n') or len(d.get('items') or [])), 'v': d.get('updated', '')}
        except Exception:
            os.remove(p)
    json.dump({'v': 1, 'updated': now.strftime('%Y-%m-%dT%H:%M+09:00'), 'cats': cats, 'days': index,
               'errors': fail[:10]}, open(os.path.join(a.out, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    log(f'index.json: {len(index)}일 치' + (f', 실패 {len(fail)}건' if fail else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
