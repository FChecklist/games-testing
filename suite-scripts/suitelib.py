#!/usr/bin/env python3
"""SUITE-RUNNER support library (boss session, 2 Nov 2026).

Commands:
  parse <log> <out.json>                 parse a bun test log into a summary json
  import <lane> <game> <sha> <log>       store an existing log as a (baseline) result
  sched                                  one scheduler pass (claim queue heads, start jobs, rewrite reports)
  report                                 rewrite SUITE-RESULTS.md and queue result files only
  status                                 short text status
Exit codes of sched: 0 = go on, 10 = every game has a GREEN final head and nothing is running.
Files only; no network; no secrets.
"""
import sys, os, re, json, time, subprocess, datetime
from pathlib import Path

ROOT = Path('C:/ct/test-sites/handover/2026-11-02')
S = ROOT / 'suite'
Q = ROOT / 'queue'
R = S / 'results'
ST = S / 'state'
LG = S / 'logs'
TS = Path('C:/ct/test-sites')
BASH = 'C:/Program Files/Git/bin/bash.exe'

GAMES = {
    'bingo':     dict(dir='bingo',         live='release/bingo-2026-11-02',     private=False),
    'luckydraw': dict(dir='luckydraw',     live='release/luckydraw-2026-11-02', private=True),
    'tambola':   dict(dir='tambola',       live='release/tambola-2026-11-02',   private=False),
    'tictactoe': dict(dir='tictactoe',     live='release/tictactoe-2026-11-02', private=False),
    'luck':      dict(dir='luckbychance',  live='release/luck-2026-11-02',      private=False),
    'snakes':    dict(dir='snakesladders', live='release/snakes-2026-11-02',    private=False),
}
ALIAS = {'ttt': 'tictactoe', 'luckbychance': 'luck', 'snakesladders': 'snakes'}
ORDER = ['bingo', 'luckydraw', 'tambola', 'tictactoe', 'luck', 'snakes']
LANES = ['phone', 'cloud', 'apicloud', 'partner']   # order of preference for a head
LABEL = {'apicloud': 'api-cloud'}
API_LEDGER = Path('C:/ct/test-sites/data/runs/api-spend.json')
API_STOP_USD = 22.0            # boss correction 23:10 IST: this lane may spend only until api-spend.json total_usd reaches 22.00 (absolute owner stop 29.88), then stop and tell the boss
API_RUN_CENTS = 200            # hard budget per api-cloud run
ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')


# ------------------------------------------------------------------ parsing
def read_text(p):
    b = Path(p).read_bytes()
    if b[:2] in (b'\xff\xfe', b'\xfe\xff'):
        t = b.decode('utf-16', 'replace')
    elif b.count(b'\x00') > max(1, len(b) // 4):
        t = b.decode('utf-16-le', 'replace')
    else:
        t = b.decode('utf-8', 'replace')
    return ANSI.sub('', t.replace('\r', '')).lstrip('\ufeff')


HDR = re.compile(r'^([^\s(][^\s]*\.test\.[A-Za-z]+):\s*$')
TST = re.compile(r'^\((pass|fail|skip|todo)\) (.*)$')
TIME = re.compile(r'\s*\[[\d.,]+\s*m?s\]\s*$')
PATHS = re.compile(r"(?:[A-Za-z]:)?[\\/][^\s'\"]*[\\/]([^\s'\"\\/]+)")


def norm_name(n):
    n = TIME.sub('', n).strip()
    return re.sub(r'\s+', ' ', n)[:60]


def parse_log(path):
    t = read_text(path)
    lines = t.split('\n')
    cur = ''
    fails = {}
    unhandled = {}
    counts = {}
    ran = files = None
    secs = None
    exit_code = None
    crash = False
    for i, l in enumerate(lines):
        if l.startswith('::'):
            l = re.sub(r'^::[a-z]+::', '', l)   # GitHub Actions groups: ::group::file
        m = HDR.match(l)
        if m:
            cur = m.group(1).replace('\\', '/')
            continue
        m = TST.match(l)
        if m and m.group(1) == 'fail':
            k = norm_name(m.group(2))
            if k not in fails:
                fails[k] = cur
            elif not fails[k] and cur:
                fails[k] = cur
            continue
        if l.startswith('# Unhandled error'):
            msg = ''
            for j in range(i + 1, min(i + 14, len(lines))):
                if lines[j].startswith('error:'):
                    msg = PATHS.sub(r'\1', lines[j])[:100]
                    break
            unhandled['UNHANDLED ' + (msg or 'unknown')] = cur
            continue
        m = re.match(r'^\s*(\d+) (pass|skip|todo|fail|errors?)\s*$', l)
        if m:
            counts[m.group(2).rstrip('s') if m.group(2).startswith('error') else m.group(2)] = int(m.group(1))
            continue
        m = re.match(r'^Ran (\d+) tests? across (\d+) files?\.\s*\[([\d.]+)(m?s)\]', l)
        if m:
            ran, files = int(m.group(1)), int(m.group(2))
            v = float(m.group(3))
            secs = v / 1000.0 if m.group(4) == 'ms' else v
            continue
        m = re.search(r'(?:SUITE_EXIT|exit)=(\d+)(?:\s+(?:SECS|secs)=(\d+))?', l)
        if m and (l.startswith('SUITE_EXIT') or l.startswith('exit=')):
            exit_code = int(m.group(1))
            if m.group(2):
                secs = secs or float(m.group(2))
            continue
        if re.search(r'Bun has crashed|panic\(|Segmentation fault|out of memory|JavaScript heap', l, re.I):
            crash = True
    incomplete = ran is None
    return dict(
        pass_=counts.get('pass', 0), fail=counts.get('fail', 0), skip=counts.get('skip', 0),
        todo=counts.get('todo', 0), errors=counts.get('error', 0), ran=ran, files=files,
        secs=secs, exit=exit_code, crash=crash, incomplete=incomplete,
        fails=[dict(name=k, file=v) for k, v in fails.items()],
        unhandled=[dict(name=k, file=v) for k, v in unhandled.items()],
    )


def cmd_parse(log, out):
    m = parse_log(log)
    Path(out).write_text(json.dumps(m, indent=1), encoding='utf-8')
    print(summary_line(m))


def summary_line(m):
    return '%s pass %s fail %s skip %s todo %s err, ran=%s files=%s secs=%s exit=%s%s' % (
        m['pass_'], m['fail'], m['skip'], m['todo'], m['errors'], m['ran'], m['files'],
        None if m['secs'] is None else round(m['secs']), m['exit'], ' INCOMPLETE' if m['incomplete'] else '')


# ------------------------------------------------------------------ file helpers
def jload(p, default=None):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return default


def now_ist():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def git(game, *args):
    r = subprocess.run(['git', '-C', str(TS / GAMES[game]['dir'])] + list(args), capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ''


def live_sha(game):
    return git(game, 'rev-parse', '--verify', '-q', GAMES[game]['live'] + '^{commit}')


def run_dir(lane, game, sha):
    return R / lane / ('%s-%s' % (game, sha[:7]))


def meta(lane, game, sha):
    return jload(run_dir(lane, game, sha) / 'meta.json')


def event(msg, attention=False):
    ST.mkdir(parents=True, exist_ok=True)
    line = '%s %s\n' % (now_ist(), msg)
    with open(ST / 'events.log', 'a', encoding='utf-8') as f:
        f.write(line)
    if attention:
        with open(ST / 'attention.txt', 'a', encoding='utf-8') as f:
            f.write(line)


# ------------------------------------------------------------------ api-cloud lane helpers
def lane_label(l):
    return LABEL.get(l, l)


def api_spent():
    try:
        return float(json.loads(API_LEDGER.read_text(encoding='utf-8')).get('total_usd', 0.0))
    except Exception:
        return 0.0


_BR_CACHE = {}


def api_branch(game, sha):
    """a branch on origin whose tip is exactly this commit (the api-cloud sandbox clones by branch name); None if there is none"""
    k = (game, sha)
    c = _BR_CACHE.get(k)
    if c and time.time() - c[0] < 120:
        return c[1]
    br = None
    try:
        r = subprocess.run(['git', '-C', str(TS / GAMES[game]['dir']), 'ls-remote', '--heads', 'origin'],
                           capture_output=True, text=True, timeout=60)
        for l in r.stdout.splitlines():
            parts = l.split()
            if len(parts) == 2 and parts[0] == sha and parts[1].startswith('refs/heads/'):
                br = parts[1][len('refs/heads/'):]
                if br.startswith('feat/pay') or br.startswith('release/'):
                    break
    except Exception:
        br = None
    _BR_CACHE[k] = (time.time(), br)
    return br


# ------------------------------------------------------------------ verdicts
def failkeys(m):
    return set(x['name'] for x in m['fails']) | set(x['name'] for x in m['unhandled'])


def flaky_names(game):
    d = jload(S / 'flaky.json', {}) or {}
    return [x['name'] for x in d.get(game, [])]


def is_flaky(key, names):
    return any(key[:40] == n[:40] for n in names)


def verdict(head, base, flaky=()):
    """(verdict, new_failure_names, note)"""
    if head is None:
        return ('PENDING', [], 'no result')
    if head['incomplete']:
        return ('RED', [], 'run did not finish (no summary line)%s' % (' - crash seen' if head['crash'] else ''))
    allf = failkeys(head)
    hf = set(k for k in allf if not is_flaky(k, flaky))
    nfl = len(allf) - len(hf)
    fnote = (' (%d known-flaky ignored, see flaky.json)' % nfl) if nfl else ''
    if not hf:
        return ('GREEN', [], ('clean' if not nfl else 'only known-flaky failures') + fnote)
    if base is None:
        return ('PENDING', sorted(hf), 'failures seen, live baseline on this lane not run yet' + fnote)
    if base['incomplete']:
        return ('PENDING', sorted(hf), 'live baseline on this lane did not finish' + fnote)
    new = sorted(hf - failkeys(base))
    if new:
        return ('RED', new, '%d new failure(s), %d also fail on live%s' % (len(new), len(hf) - len(new), fnote))
    return ('GREEN', [], 'same %d failure(s) as live%s' % (len(hf), fnote))


# ------------------------------------------------------------------ queue
def load_heads(claim=True):
    heads = []
    if not Q.exists():
        return heads
    for qd in sorted([d for d in Q.iterdir() if (d / 'info.txt').exists()], key=lambda p: ((p / 'info.txt').stat().st_mtime, p.name)):
        info = qd / 'info.txt'
        if not qd.is_dir() or not info.exists():
            continue
        kv = {}
        for l in info.read_text(encoding='utf-8', errors='replace').splitlines():
            if '=' in l:
                k, v = l.split('=', 1)
                kv[k.strip()] = v.strip()
        game = qd.name.rsplit('-', 1)[0].lower()
        game = ALIAS.get(game, game)
        if game not in GAMES:
            continue
        sha = kv.get('sha', '')
        if not re.fullmatch(r'[0-9a-f]{7,40}', sha):
            sha7 = qd.name.rsplit('-', 1)[1]
            sha = git(game, 'rev-parse', '--verify', '-q', sha7 + '^{commit}') or sha7
        if re.fullmatch(r'[0-9a-f]{40}', sha) is None:
            full = git(game, 'rev-parse', '--verify', '-q', sha + '^{commit}')
            sha = full or sha
        claimed = qd / 'claimed'
        mine = False
        if claim and not claimed.exists():
            try:
                os.mkdir(claimed)
                (claimed / 'by.txt').write_text('suite-runner %s\n' % now_ist(), encoding='utf-8')
                mine = True
                event('claimed %s' % qd.name)
            except FileExistsError:
                pass
        if claimed.exists():
            by = claimed / 'by.txt'
            if by.exists() and not by.read_text(encoding='utf-8', errors='replace').startswith('suite-runner'):
                continue  # claimed by somebody else
        else:
            continue
        heads.append(dict(game=game, sha=sha, sha7=sha[:7], qd=qd, branch=kv.get('branch', ''), low=(kv.get('priority', '').lower() == 'low'),
                          arrived=info.stat().st_mtime, name=qd.name))
    return heads


def heads_by_game(heads):
    """newest normal-priority (pay pages) head per game"""
    d = {}
    for h in heads:
        if not h.get('low'):
            d[h['game']] = h  # list is in arrival order, the last one wins
    return d


def lows_by_game(heads):
    """newest priority=low head per game (consent-lines heads: sit on a pay head, run after all pay heads)"""
    d = {}
    for h in heads:
        if h.get('low'):
            d[h['game']] = h
    return d


def current_heads(heads):
    return list(heads_by_game(heads).values()) + list(lows_by_game(heads).values())


# ------------------------------------------------------------------ lanes
def lane_state(lane):
    f = ST / ('%s.running' % lane)
    if f.exists() and time.time() - f.stat().st_mtime < 240:
        return 'busy'
    b = ST / ('%s.blocked' % lane)
    if b.exists() and time.time() - b.stat().st_mtime < 300:
        return 'blocked'
    return 'free'


def running_jobs():
    out = {}
    for lane in LANES:
        f = ST / ('%s.running' % lane)
        if f.exists() and time.time() - f.stat().st_mtime < 240:
            j = jload(f, {}) or {}
            out[lane] = (j.get('game'), (j.get('sha') or '')[:7])
    return out


def attempts(lane, game, sha):
    f = ST / 'attempts' / ('%s-%s-%s' % (lane, game, sha[:7]))
    try:
        return int(f.read_text().strip())
    except Exception:
        return 0


def launch(lane, game, sha):
    ST.mkdir(parents=True, exist_ok=True)
    LG.mkdir(parents=True, exist_ok=True)
    (ST / ('%s.running' % lane)).write_text(json.dumps(dict(game=game, sha=sha, start=int(time.time()))), encoding='utf-8')
    log = open(LG / ('job-%s-%s-%s.out' % (lane, game, sha[:7])), 'ab')
    flags = 0
    if os.name == 'nt':
        flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | NEW_PROCESS_GROUP | NO_WINDOW
    subprocess.Popen([BASH, str(S / 'run-job.sh'), lane, game, sha], stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                     creationflags=flags, close_fds=True)
    event('started %s %s %s' % (lane, game, sha[:7]))


# ------------------------------------------------------------------ scheduler
def build_jobs(heads):
    running = set(running_jobs().values())
    latest = heads_by_game(heads)
    lows = lows_by_game(heads)
    cur = current_heads(heads)
    jobs = []
    low_jobs = []

    def has_run(game, sha):
        return [l for l in LANES if meta(l, game, sha)]

    def is_running(game, sha):
        return (game, sha[:7]) in running

    # 1. heads, oldest first, skipping heads already replaced by a newer one for the same game
    for h in heads:
        if has_run(h['game'], h['sha']) or is_running(h['game'], h['sha']):
            continue
        if (lows if h['low'] else latest).get(h['game'], {}).get('sha') != h['sha']:
            continue
        (low_jobs if h['low'] else jobs).append(dict(kind='head', game=h['game'], sha=h['sha'], lanes=list(LANES), need=True))
    # 2. live baselines needed to judge a (final) head that has failures
    for h in cur:
        for lane in has_run(h['game'], h['sha']):
            if lane == 'apicloud':
                continue  # no live baseline is bought on the api lane; its failures are reproduced on another lane instead
            m = meta(lane, h['game'], h['sha'])
            ls = live_sha(h['game'])
            if m and failkeys(m) and ls and not meta(lane, h['game'], ls) and not is_running(h['game'], ls):
                jobs.append(dict(kind='base', game=h['game'], sha=ls, lanes=[lane], need=True))
    # 3. a RED final head is run once more on another lane
    for h in cur:
        g = h['game']
        rl = has_run(g, h['sha'])
        if not rl or is_running(g, h['sha']):
            continue
        if all(l == 'apicloud' for l in rl):
            m = meta('apicloud', g, h['sha'])
            if m and failkeys(m):   # api-cloud failure: must be reproduced on phone / GitHub Actions / partner before it counts
                jobs.append(dict(kind='head', game=g, sha=h['sha'], lanes=[l for l in LANES if l != 'apicloud'], need=True))
            continue
        if len(rl) >= 2:
            continue
        verdicts = []
        for lane in rl:
            ls = live_sha(g)
            verdicts.append(verdict(meta(lane, g, h['sha']), meta(lane, g, ls) if ls else None, flaky_names(g))[0])
        # failures on the only lane so far (RED, or waiting for that lane's slow baseline): run the head once on another lane as well
        if all(v in ('RED', 'PENDING') for v in verdicts) and all(failkeys(meta(l, g, h['sha'])) for l in rl):
            jobs.append(dict(kind='head', game=g, sha=h['sha'], lanes=[l for l in LANES if l not in rl], need=True))
    jobs.extend(low_jobs)   # priority=low heads come after every pay head and its baselines / reruns
    # 4. the remaining live baselines, one per game and lane
    for lane in LANES:
        for g in ORDER:
            ls = live_sha(g)
            if not ls or meta(lane, g, ls) or is_running(g, ls):
                continue
            if lane == 'apicloud':
                continue  # never buy baselines on the paid lane
            if GAMES[g]['private'] and lane == 'cloud':
                continue  # private repo: limited free minutes, only if a head needs it (case 2)
            jobs.append(dict(kind='base', game=g, sha=ls, lanes=[lane], need=False))
    return jobs


def sched(do_launch=True):
    ST.mkdir(parents=True, exist_ok=True)
    lock = ST / 'sched.lock'
    try:
        if lock.exists() and time.time() - lock.stat().st_mtime > 180:
            os.rmdir(lock)
        os.mkdir(lock)
    except (FileExistsError, OSError):
        return 0  # another pass is running
    try:
        if (ST / 'stop').exists():
            do_launch = False   # the daemon was told to stop: finish what runs, start nothing new (a job's own end-of-run pass used to start the next one)
        heads = load_heads()
        # a cloud job on a head that a newer head has replaced is stopped (the other lanes just run to the end)
        cur0 = set((h['game'], h['sha7']) for h in current_heads(heads))
        for lane0, (g0, s70) in running_jobs().items():
            ls0 = live_sha(g0) if g0 in GAMES else ''
            if lane0 == 'cloud' and g0 in GAMES and (g0, s70) not in cur0 and s70 != ls0[:7] and any(h['game'] == g0 for h in heads):
                (ST / 'cloud.cancel').write_text('%s %s superseded' % (g0, s70), encoding='utf-8')
        jobs = build_jobs(heads)
        state = {l: lane_state(l) for l in LANES}
        taken = set()

        def eligible(lane, j):
            if lane not in j['lanes']:
                return False
            if attempts(lane, j['game'], j['sha']) >= 2:
                return False
            if lane == 'apicloud':
                if j['kind'] != 'head' or GAMES[j['game']]['private']:
                    return False
                if api_spent() >= API_STOP_USD:
                    return False
                if not api_branch(j['game'], j['sha']):
                    return False
            return True

        def assign(lane, j):
            launch(lane, j['game'], j['sha'])
            state[lane] = 'busy'
            taken.add((j['kind'], j['game'], j['sha'], tuple(j['lanes'])))

        for lane in LANES:
            if state[lane] != 'free':
                continue
            for j in jobs:
                key = (j['kind'], j['game'], j['sha'], tuple(j['lanes']))
                if key in taken or not eligible(lane, j):
                    continue
                if any(t[1] == j['game'] and t[2] == j['sha'] for t in taken):
                    continue  # the same code is already starting somewhere
                if lane == 'cloud' and GAMES[j['game']]['private']:
                    continue  # second pass below
                if do_launch:
                    assign(lane, j)
                break
        # private repo on the cloud lane only when the other lanes are busy
        if state['cloud'] == 'free' and state['phone'] != 'free' and state['partner'] != 'free':
            for j in jobs:
                key = (j['kind'], j['game'], j['sha'], tuple(j['lanes']))
                if key in taken or not GAMES[j['game']]['private'] or not eligible('cloud', j):
                    continue
                if do_launch:
                    assign('cloud', j)
                break
        write_reports(heads)
        return all_done(heads)
    finally:
        try:
            os.rmdir(lock)
        except OSError:
            pass


# ------------------------------------------------------------------ reports
def head_rows(h):
    rows = []
    ls = live_sha(h['game'])
    for lane in LANES:
        m = meta(lane, h['game'], h['sha'])
        if not m:
            continue
        b = meta(lane, h['game'], ls) if ls else None
        v, new, note = verdict(m, b, flaky_names(h['game']))
        if lane == 'apicloud' and v == 'PENDING' and not m['incomplete'] and b is None:
            v, new, note = 'PENDING', sorted(failkeys(m)), 'api-cloud failures not counted until reproduced on phone / cloud / partner'
        rows.append(dict(lane=lane, m=m, base=b, verdict=v, new=new, note=note))
    return rows


def final_verdict(h, running):
    rows = head_rows(h)
    if not rows:
        return 'PENDING'
    if (h['game'], h['sha'][:7]) in running:
        return 'PENDING'
    other = [r for r in rows if r['lane'] != 'apicloud']
    if other:
        rows = other   # a failure seen only on the api-cloud lane is not reported as real
    vs = [r['verdict'] for r in rows]
    if 'RED' in vs:
        return 'RED'
    if 'PENDING' in vs:
        return 'PENDING'
    return 'GREEN'


def all_done(heads):
    latest = heads_by_game(heads)
    lows = lows_by_game(heads)
    if len(latest) < len(GAMES):
        return 0
    running = set(running_jobs().values())
    if running:
        return 0
    for g in GAMES:
        if final_verdict(latest[g], running) != 'GREEN':
            return 0
        if g in lows and final_verdict(lows[g], running) != 'GREEN':
            return 0
    return 10


def fmt_new(names):
    if not names:
        return '0'
    return '%d: %s' % (len(names), '; '.join(n[:50] for n in names[:3]) + (' ...' if len(names) > 3 else ''))


def write_reports(heads):
    running = running_jobs()
    rset = set(running.values())
    L = []
    L.append('# SUITE-RESULTS (wave-2 payment-pages heads, full test suites)')
    L.append('')
    L.append('Updated %s IST by SUITE-RUNNER (boss session). Command per game: `bun test --isolate --timeout 120000 packages apps tools/control-worker`. Lanes: phone = OnePlus (proot ubuntu), cloud = GitHub Actions ubuntu-latest, partner = partner laptop.' % now_ist())
    L.append('A head is GREEN when it has no failure that the live release tip does not also have on the same lane. NEW failure = fails on the head, passes (or is absent) on live.')
    L.append('')
    L.append('## Game verdicts')
    L.append('')
    L.append('Pay head = the payment-pages head. Consent head = the priority=low head that sits on it (one more commit); a green full suite on the consent head covers both.')
    L.append('')
    L.append('| game | pay head | pay verdict | consent head | consent verdict | lanes run / notes |')
    L.append('|---|---|---|---|---|---|')
    latest = heads_by_game(heads)
    lows = lows_by_game(heads)
    for g in ORDER:
        h = latest.get(g)
        lw = lows.get(g)
        if not h:
            L.append('| %s | (none announced yet) | PENDING | %s | %s | waiting for the queue |' % (g, lw['sha7'] if lw else '-', final_verdict(lw, rset) if lw else '-'))
            continue
        rows = head_rows(h)
        fv = final_verdict(h, rset)
        lrows = head_rows(lw) if lw else []
        L.append('| %s | %s | %s | %s | %s | %s |' % (
            g, h['sha7'], fv, lw['sha7'] if lw else '-', final_verdict(lw, rset) if lw else '-',
            '; '.join(['pay %s: %s' % (lane_label(r['lane']), r['note']) for r in rows] + ['consent %s: %s' % (lane_label(r['lane']), r['note']) for r in lrows]) or 'queued/running'))
    L.append('')
    HDRROW = ['| game | sha | lane | pass | skip | fail | errors | secs | new failures vs live | verdict | note |', '|---|---|---|---|---|---|---|---|---|---|---|']

    def head_table(hs, keep_queued):
        for h in sorted(hs, key=lambda x: (ORDER.index(x['game']), x['arrived'])):
            rows = head_rows(h)
            if not rows:
                if not keep_queued:
                    continue
                where = [lane_label(l) for l, j in running.items() if j == (h['game'], h['sha7'])]
                L.append('| %s | %s | %s | | | | | | | %s | %s |' % (h['game'], h['sha7'], ','.join(where) or '-', 'RUNNING' if where else 'QUEUED', h['name']))
            for r in rows:
                m = r['m']
                L.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
                    h['game'], h['sha7'], lane_label(r['lane']), m['pass_'], m['skip'] + m['todo'], m['fail'], m['errors'],
                    '' if m['secs'] is None else round(m['secs']), fmt_new(r['new']), r['verdict'], r['note']))

    curids = set(id(h) for h in current_heads(heads))
    cur = [h for h in heads if id(h) in curids]
    old = [h for h in heads if id(h) not in curids]
    L.append('## Head runs (current heads: pay heads and consent heads)')
    L.append('')
    L.extend(HDRROW)
    head_table(cur, True)
    L.append('')
    L.append('## Superseded heads (older runs, kept for the record; a newer head replaced them)')
    L.append('')
    L.extend(HDRROW)
    head_table(old, False)
    L.append('')
    L.append('## Live baselines (release tips, same command)')
    L.append('')
    L.append('| game | live sha | lane | pass | skip | fail | errors | secs | failing tests | source |')
    L.append('|---|---|---|---|---|---|---|---|---|---|')
    for g in ORDER:
        ls = live_sha(g)
        for lane in LANES:
            m = meta(lane, g, ls) if ls else None
            if m:
                L.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
                    g, ls[:7], lane, m['pass_'], m['skip'] + m['todo'], m['fail'], m['errors'], '' if m['secs'] is None else round(m['secs']),
                    '; '.join(sorted(failkeys(m)))[:160] or '-', 'imported partner run of today' if m.get('imported') else 'this runner'
                    + (' (INCOMPLETE)' if m['incomplete'] else '')))
            elif (g, (ls or '')[:7]) in rset and running.get(lane) == (g, ls[:7]):
                L.append('| %s | %s | %s | | | | | | | RUNNING |' % (g, ls[:7], lane))
    L.append('')
    L.append('## api-cloud lane (Anthropic sandbox, owner API credit; stop line USD %.0f tonight, USD %d max per run)' % (API_STOP_USD, API_RUN_CENTS // 100))
    L.append('')
    L.append('Ledger total now: USD %.2f. A green api-cloud run counts like any lane; a failure there is reproduced on phone / cloud / partner first.' % api_spent())
    L.append('')
    L.append('| tag | head sha | branch | pass | fail | skip | folders | cents booked | verdict |')
    L.append('|---|---|---|---|---|---|---|---|---|')
    for h in sorted(heads, key=lambda x: (ORDER.index(x['game']), x['arrived'])):
        m = meta('apicloud', h['game'], h['sha'])
        if m:
            v = 'GREEN' if not failkeys(m) and not m['incomplete'] else 'PENDING (reproduce on another lane)'
            L.append('| suite-%s-%s | %s | %s | %s | %s | %s | %s | %s | %s |' % (h['game'], h['sha7'], h['sha'], m.get('branch', ''), m['pass_'], m['fail'], m['skip'] + m['todo'], m.get('folders', ''), m.get('cents', '?'), v))
    L.append('')
    L.append('## Lanes now')
    L.append('')
    for lane in LANES:
        j = running.get(lane)
        L.append('- %s: %s' % (lane_label(lane), ('running %s %s' % j) if j else lane_state(lane)))
    L.append('')
    (ROOT / 'SUITE-RESULTS.md').write_text('\n'.join(L), encoding='utf-8')
    # one result file per queue entry and lane
    for h in heads:
        for r in head_rows(h):
            m = r['m']
            T = []
            T.append('game=%s head=%s lane=%s verdict=%s' % (h['game'], h['sha'], r['lane'], r['verdict']))
            T.append('counts: %s' % summary_line(m))
            T.append('note: %s' % r['note'])
            if r['base']:
                T.append('live baseline %s on this lane: %s' % (live_sha(h['game'])[:7], summary_line(r['base'])))
            T.append('failing tests on head (%d):' % len(failkeys(m)))
            for x in m['fails'] + m['unhandled']:
                T.append('  %s%s%s' % ('NEW  ' if x['name'] in r['new'] else 'live ', x['name'], ('   [' + x['file'] + ']') if x['file'] else ''))
            T.append('log: %s' % (run_dir(r['lane'], h['game'], h['sha']) / 'test.log'))
            try:
                (h['qd'] / ('result-%s.txt' % r['lane'])).write_text('\n'.join(T) + '\n', encoding='utf-8')
            except OSError:
                pass


def note_attention(heads):
    """add attention lines for new RED verdicts (once per head+lane)"""
    seen = jload(ST / 'seen.json', {}) or {}
    for h in heads:
        for r in head_rows(h):
            k = '%s-%s-%s-%s' % (h['game'], h['sha7'], r['lane'], r['verdict'])
            if k in seen:
                continue
            seen[k] = now_ist()
            if r['verdict'] in ('RED', 'GREEN'):
                event('%s %s on %s: %s (%s)' % (h['game'], h['sha7'], r['lane'], r['verdict'], r['note']), attention=(r['verdict'] == 'RED'))
    (ST / 'seen.json').write_text(json.dumps(seen), encoding='utf-8')


def cmd_record(lane, game, sha, rc):
    rc = int(rc)
    if rc == 0 and not meta(lane, game, sha):
        rc = 1
    if rc == 79:
        event('cloud job on %s %s cancelled: a newer head replaced it' % (game, sha[:7]))
    elif rc in (75, 76, 77, 78):
        (ST / ('%s.blocked' % lane)).write_text(now_ist(), encoding='utf-8')
        event('%s lane %s, retry in 5 min' % (lane, 'busy (lock held by another worker)' if rc == 75 else 'unreachable' if rc == 76 else 'not eligible / spend stop line'))
    elif rc != 0:
        (ST / 'attempts').mkdir(parents=True, exist_ok=True)
        n = attempts(lane, game, sha) + 1
        (ST / 'attempts' / ('%s-%s-%s' % (lane, game, sha[:7]))).write_text(str(n))
        event('infra failure on %s for %s %s (rc=%s, attempt %d)' % (lane, game, sha[:7], rc, n), attention=(n >= 2))
    heads = load_heads(claim=False)
    note_attention(heads)
    write_reports(heads)


def cmd_import(lane, game, sha, log):
    d = run_dir(lane, game, sha)
    d.mkdir(parents=True, exist_ok=True)
    m = parse_log(log)
    m['imported'] = True
    m['source'] = str(log)
    (d / 'meta.json').write_text(json.dumps(m, indent=1), encoding='utf-8')
    try:
        (d / 'test.log').write_bytes(Path(log).read_bytes())
    except OSError:
        pass
    print(summary_line(m))


def cmd_merge_folders(outdir, outjson, booked_usd, branch, *folders):
    """api-cloud: one raw bun log per folder -> one summed meta.json (counts come from the log summary lines only)"""
    out = Path(outdir)
    tot = dict(pass_=0, fail=0, skip=0, todo=0, errors=0, ran=0, files=0, secs=0.0)
    fails, unh, missing, bad = [], [], [], []
    for f in folders:
        lg = out / (f.replace('/', '_') + '.log')
        if not lg.exists():
            missing.append(f)
            continue
        m = parse_log(lg)
        if m['incomplete']:
            bad.append(f)
            continue
        for k in ('pass_', 'fail', 'skip', 'todo', 'errors'):
            tot[k] += m[k]
        tot['ran'] += m['ran'] or 0
        tot['files'] += m['files'] or 0
        tot['secs'] += m['secs'] or 0
        fails += m['fails']
        unh += m['unhandled']
    rr = out / 'RUN_RESULTS.md'
    head_ok = rr.exists() and re.search(r'[0-9a-f]{40}', rr.read_text(encoding='utf-8', errors='replace')) is not None
    incomplete = bool(missing or bad)
    res = dict(tot, exit=None, crash=False, incomplete=incomplete, fails=fails, unhandled=unh,
               branch=branch, folders=len(folders), missing=missing, unfinished=bad, head_sha_reported=head_ok,
               cents=round(float(booked_usd or 0) * 100, 1))
    Path(outjson).write_text(json.dumps(res, indent=1), encoding='utf-8')
    print(summary_line(res), 'missing=%s unfinished=%s cents=%s' % (missing, bad, res['cents']))
    sys.exit(1 if incomplete else 0)


def cmd_status():
    heads = load_heads(claim=False)
    running = running_jobs()
    print('time', now_ist())
    for lane in LANES:
        print(' ', lane, ('running %s %s' % running[lane]) if lane in running else lane_state(lane))
    latest = heads_by_game(heads)
    lows = lows_by_game(heads)
    for g in ORDER:
        for tag, h in (('pay', latest.get(g)), ('consent', lows.get(g))):
            if not h:
                continue
            print(' ', g, tag, h['sha7'], final_verdict(h, set(running.values())), [(lane_label(r['lane']), r['verdict'], r['m']['fail']) for r in head_rows(h)])


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        sys.exit(2)
    c = a[0]
    if c == 'parse':
        cmd_parse(a[1], a[2])
    elif c == 'import':
        cmd_import(*a[1:5])
    elif c == 'sched-dry':
        sched(do_launch=False)
    elif c == 'sched':
        rc = sched()
        note_attention(load_heads(claim=False))
        sys.exit(rc)
    elif c == 'report':
        write_reports(load_heads(claim=False))
    elif c == 'merge-folders':
        cmd_merge_folders(*a[1:])
    elif c == 'record':
        cmd_record(*a[1:5])
    elif c == 'status':
        cmd_status()
    else:
        print(__doc__)
        sys.exit(2)
