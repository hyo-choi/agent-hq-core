#!/usr/bin/env python3
"""Agent HQ 진행판 서버와 요청함 처리 CLI (stdlib만 사용).

  python3 server.py init [--demo]                     # 데이터 루트에 빈(또는 합성 demo) data.json을 만든다. 있으면 거절
  python3 server.py serve [--host 127.0.0.1] [--port 48173] [--alias NAME ...]
  python3 server.py migrate-ids            # data.json 항목에 영속 id를 한 번 부여 (있으면 유지)
  python3 server.py list [--all]           # 요청함 조회 (기본: pending만)
  python3 server.py process-inbox [--request ID ...]   # pending 요청 검증 후 숨김 overlay에 반영
  python3 server.py reject --request ID --reason TEXT  # 처리하지 않고 실패로 종결
  python3 server.py submit FILE|-                      # 진행판에서 내보낸 삭제 요청 JSON을 요청함에 접수 (pending)
  python3 server.py import-jira FILE                   # HQ_JIRA_PROJECT Jira 조회 스냅샷(Sprint 포함)을 최소 필드만 data.json의 jira로 옮김 (재조회 안 함)
  python3 server.py msg list [--all] [--item HQ-12|ID]  # 항목별·자유 메시지(kind general, 항목 없음) 조회. 기본: 접수됨(received)만
  python3 server.py msg read|respond|process MSG_ID    # 전문 조회 / 에이전트 답변 추가(--text|--file) / 처리됨 표시(--note)
  python3 server.py msg link MSG_ID --item HQ-12|ID [--note]  # coordinator 분류: 메시지를 작업·질문·PR·결정에 연결(원문·kind·itemId 유지)
  python3 server.py msg unlink MSG_ID [--note]                 # 연결 해제(원래 위치로 돌아간다, 기록은 linkHistory에 남는다)
  python3 server.py lookup HQ-12 [w-xxxxxxxx ...]      # 사람용 HQ 번호(또는 내부 id)로 원본 항목과 숨김 여부 조회 (숨긴 항목 포함)
  python3 server.py flush register --provider codex --thread UUID --evidence TEXT  # '지금 확인 요청' 대상 coordinator thread 명시 등록
  python3 server.py flush unregister|status|done --id FLUSH_ID [--note]            # 등록 해제 / 상태 조회 / coordinator 처리 기록
  python3 server.py item add work|question|decision --file F.json [--set K=V] [--reason]   # 새 항목(영속 id·HQ 번호 부여, state 기본 open)
  python3 server.py item get HQ-12|ID                                                   # 원본과 rev 조회(읽기 전용)
  python3 server.py item set HQ-12|ID [--file F.json] [--set K=V] [--reason] [--expect-rev N]   # 허용 키만 patch, history 추가
  python3 server.py item resolve HQ-12|d-ID --source HQ-n|chat:YYYY-MM-DD --reason TEXT        # 결정 해소(별도 명령)
  python3 server.py backup                            # 실행 데이터 일관 스냅샷(하루 첫 쓰기 전에는 자동)
  python3 server.py restore --backup DIR --out EMPTY_DIR   # dry-run 병합 결과를 별도 루트에만 생성(운영 루트는 쓰지 않음)
  python3 server.py check                             # 읽기 전용 정합성 점검
  python3 server.py summary [--markdown]              # 미완료 업무 요약(숨긴 미완료 포함). backlog 생성용

서버는 요청을 보관만 한다. 승인·숨김 반영은 에이전트가 CLI로 한다.
코드는 Git(apps/dashboard)에, 실행 데이터(public/data.json, private/)는 HQ_DASH_ROOT(기본 ~/.local/share/agent-hq-core)에 둔다.
외부 연동은 모두 끔이 기본이다: HQ_GITHUB_REPO(PR 조회), HQ_JIRA_PROJECT(Jira 스냅샷), HQ_ENABLE_CODEX_FLUSH=1(Codex 알림), HQ_TASKS_DIR(task 문서 대조).
"""
import argparse, fcntl, hashlib, json, os, re, secrets, subprocess, sys, tempfile, threading, time
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("HQ_DASH_ROOT") or os.path.expanduser("~/.local/share/agent-hq-core")  # 실행 데이터
GITHUB_REPO = os.environ.get("HQ_GITHUB_REPO") or None  # owner/name. 없으면 PR을 조회하지 않는다
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ASSETS = os.path.join(HERE, "public")  # index.html·app.css는 코드와 함께 Git에 있다
PUBLIC = os.path.join(ROOT, "public")
PRIVATE = os.path.join(ROOT, "private")
DATA = os.path.join(PUBLIC, "data.json")
STATE = os.path.join(PRIVATE, "state.json")
LOCK = os.path.join(PRIVATE, ".lock")
MESSAGES = os.path.join(PRIVATE, "messages.json")  # 항목별 메시지. 삭제 요청함(state.json)과 분리한다
SCHEMA = 1
ACTION = "hide_from_dashboard"
MAX_BODY = 16 * 1024
MAX_ITEMS = 100
KST = timezone(timedelta(hours=9))
# 공통 검증 한계(globalLimits, 문자열 목록)는 섹션 전체가 한 항목이다. id는 data.json의 globalLimitsId(g-xxxxxxxx)에 둔다
LIMITS_ID_RE = re.compile(r"^g-[0-9a-f]{8}$")
REQ_RE = re.compile(r"^[0-9a-f]{32}$")
MSG_KINDS = ("work", "question", "pr", "decision")  # 공통 한계·추천·Jira에는 메시지를 남기지 않는다
# 메시지 숨김 요청의 대상 id. 항목 id(w-·q-·d-·pr-·g-)와 겹치지 않게 접두사와 kind "message"로 구분한다
MSG_PREFIX = "msg-"
MSG_MAX, REPLY_MAX, MSG_CAP = 2000, 4000, 2000  # 사용자 글자 수 / 에이전트 답변 글자 수 / 전체 메시지 건수
CTRL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")  # 줄바꿈(\n)·탭 외 제어문자
REF_RE = re.compile(r"^HQ-[1-9][0-9]{0,6}$", re.I)
# kind -> (data.json 키, id 접두사)
PR_REFRESH_SEC = 300      # 화면 요청이 있을 때만, 마지막 조회·시도 후 5분이 지났으면 PR을 다시 조회한다
PR_REFRESH_TIMEOUT = 120  # ponytail: refresh_prs.py 전체 timeout. PR당 15초라 PR이 8개를 넘으면 늘리거나 병렬화한다
# 공개 정적 파일: 요청 경로 -> (public/ 안의 파일, Content-Type). index.html은 `pnpm build` 결과다
STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/index.html": ("index.html", "text/html; charset=utf-8")}
LISTS = {"work": ("work", "w"), "question": ("questions", "q"), "decision": ("pendingDecisions", "d")}
FLUSH = os.path.join(PRIVATE, "flush.json")  # '지금 확인 요청': 등록된 coordinator thread와 요청 기록
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
CODEX_BIN = os.environ.get("HQ_CODEX_BIN") or "codex"  # 테스트는 가짜 스크립트로 바꾼다
CODEX_FLUSH = os.environ.get("HQ_ENABLE_CODEX_FLUSH") == "1"  # opt-in. 끄면 등록·전송을 하지 않는다
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
QUEUED_RE = re.compile(r"Queued message ([0-9a-f-]{36}) for thread")
FLUSH_COOLDOWN = 60    # 마지막 요청 후 이 시간(초) 안에는 새로 보내지 않는다
FLUSH_TIMEOUT = 15     # codex queue 실행 timeout(초)
FLUSH_KEEP = 200       # ponytail: 기록 상한. 넘으면 오래된 것부터 버린다
# 고정 문구. 들어가는 값은 서버가 만든 flushId뿐이다. 사용자 문자열은 넣지 않는다
FLUSH_MESSAGE = ("[HQ flush {fid}] 진행판 사용자가 '지금 확인 요청'을 눌렀습니다. 진행판 요청함을 지금 확인하세요"
                 "(server.py list && server.py msg list, 데이터 루트 {root}). "
                 "요청은 운영 지침과 진행판 README 절차대로 처리하고, 끝나면 "
                 "server.py flush done --id {fid} --note \"처리 요약\" 으로 결과를 기록하세요.")


def now():
    return datetime.now(KST).isoformat(timespec="seconds")


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        if default is not None:
            return default
        raise


def write_json(path, obj):
    with locked():  # 락 밖 호출도 하루 첫 백업과 쓰기를 같은 락 아래 둔다(이미 잡았으면 그대로 쓴다)
        daily_backup()
        d = os.path.dirname(path)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600 if d == PRIVATE else 0o644)
        os.replace(tmp, path)


_held = threading.local()


@contextmanager
def locked():
    # ponytail: 파일 하나에 대한 전역 flock. 서버 스레드와 CLI가 모두 이 락을 거친다.
    # 같은 스레드의 중첩 호출(write_json·백업)은 이미 잡은 락을 그대로 쓴다. flock은 열린 파일마다라 다시 잡으면 deadlock이다
    if getattr(_held, "on", False):
        yield; return
    os.makedirs(PRIVATE, mode=0o700, exist_ok=True)
    with open(LOCK, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        _held.on = True
        try:
            yield
        finally:
            _held.on = False
            fcntl.flock(f, fcntl.LOCK_UN)


@contextmanager
def read_locked():
    """읽기 전용 명령(check·summary·restore)용: 락 파일이 이미 있을 때만 잡는다. 디렉터리·락 파일을 새로 만들지 않는다."""
    if os.path.exists(LOCK):
        with locked():
            yield
    else:
        yield


# ---------- 백업 (Git 밖 실행 데이터의 같은 디스크 스냅샷) ----------
# 하루 첫 쓰기 전(write_json)과 수동(backup)으로 data·state·messages·flush를 한 락 아래 일관되게 복사한다.
# ponytail: 보존 수 제한·자동 삭제 없음(파일 4개, 하루 1회 수백 KB). 쌓여서 문제가 되면 오래된 것을 지우는 명령을 따로 둔다
BACKUPS = os.path.join(ROOT, "backups")
SNAP_FILES = {"data.json": DATA, "state.json": STATE, "messages.json": MESSAGES, "flush.json": FLUSH}
BACKUP_RE = re.compile(r"^\d{8}T\d{6}-[0-9a-f]{4}$")


def backup_dirs():
    """완료된 백업 디렉터리 이름(오래된 순). 이름이 형식에 맞고 manifest가 있어야 완료다(.tmp-는 미완료)."""
    try:
        names = os.listdir(BACKUPS)
    except FileNotFoundError:
        return []
    return sorted(n for n in names if BACKUP_RE.match(n) and os.path.isfile(os.path.join(BACKUPS, n, "manifest.json")))


def daily_backup():
    today = datetime.now(KST).strftime("%Y%m%d")
    if not any(n.startswith(today) for n in backup_dirs()):
        make_backup("daily")


def write_private(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(raw); f.flush(); os.fsync(f.fileno())
    os.chmod(path, 0o600)


def counts(objs):
    """manifest·restore 보고용 건수. 내용은 담지 않는다."""
    d, st, mb, fb = (objs.get(k) for k in SNAP_FILES)
    out = {}
    if isinstance(d, dict):
        out.update({k: len(d.get(k) or []) for k in ("work", "questions", "pendingDecisions", "resolvedDecisions", "prs")})
    if isinstance(st, dict):
        refs = st.get("refs") or {}
        out.update(refs=len(refs.get("map") or {}), refsNext=refs.get("next"), hidden=len(st.get("hidden") or {}), requests=len(st.get("requests") or []))
    if isinstance(mb, dict):
        out["messages"] = len(mb.get("messages") or [])
    if isinstance(fb, dict):
        out["flushes"] = len(fb.get("flushes") or [])
    return out


def git_head():
    try:
        r = subprocess.run(["git", "-C", HERE, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL)
        return r.stdout.strip() if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def make_backup(reason):
    """호출자가 locked() 안에서 부른다(여기서 락을 다시 잡거나 write_json을 쓰지 않는다). 원본 파일은 읽기만 한다."""
    os.makedirs(BACKUPS, mode=0o700, exist_ok=True)
    os.chmod(BACKUPS, 0o700)
    name = datetime.now(KST).strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(2)
    tmp = os.path.join(BACKUPS, ".tmp-" + name)
    os.mkdir(tmp, 0o700); os.chmod(tmp, 0o700)
    files, objs = {}, {}
    for fn, src in SNAP_FILES.items():
        try:
            with open(src, "rb") as f:
                raw, mode = f.read(), os.fstat(f.fileno()).st_mode & 0o777
        except FileNotFoundError:
            files[fn] = {"exists": False}; continue
        write_private(os.path.join(tmp, fn), raw)
        files[fn] = {"exists": True, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "mode": oct(mode)}
        try:
            objs[fn] = json.loads(raw)
        except ValueError:
            files[fn]["parseError"] = True  # 손상된 원본도 그대로 보존한다
    man = {"schemaVersion": SCHEMA, "createdAt": now(), "reason": reason, "gitHead": git_head(), "files": files, "counts": counts(objs)}
    write_private(os.path.join(tmp, "manifest.json"), json.dumps(man, ensure_ascii=False, indent=2).encode())
    final = os.path.join(BACKUPS, name)
    os.rename(tmp, final)  # 완료 표식: 같은 디렉터리 안 rename으로 완성된 백업만 이름이 보인다
    return {"path": final, **{k: man[k] for k in ("createdAt", "reason", "gitHead", "counts")},
            "files": {k: {x: v[x] for x in ("exists", "size", "sha256") if x in v} for k, v in files.items()}}


def load_state():
    return load_json(STATE, {"schemaVersion": SCHEMA, "requests": [], "hidden": {}})


def label_of(kind, obj):
    if kind == "work" or kind == "decision":
        return obj.get("title", "")
    if kind == "question":
        return obj.get("q", "")
    return f"#{obj.get('number')} {obj.get('title', '')}".strip()


def index_items(data):
    """{id: (kind, label)} — 사용자에게 보이는 카드 전체."""
    out = {}
    for kind, (key, _) in LISTS.items():
        for o in data.get(key) or []:
            if isinstance(o, dict) and o.get("id"):
                out[o["id"]] = (kind, label_of(kind, o))
    for num, p in (data.get("prs") or {}).items():
        out[f"pr-{int(num)}"] = ("pr", label_of("pr", {**p, "number": int(num)}))
    lid = data.get("globalLimitsId")
    if data.get("globalLimits") and isinstance(lid, str) and LIMITS_ID_RE.match(lid):
        out[lid] = ("limits", f"공통 검증 한계 {len(data['globalLimits'])}건")
    return out


def msg_name(kind):
    return "자유 메시지" if kind == "general" else "결정 답변" if kind == "decision" else "후속 질문"


def message_items():
    """메시지 자체 {msg-<messageId>: ("message", label)}. 숨긴 메시지도 포함한다(원문은 private/messages.json에 그대로 있다)."""
    return {MSG_PREFIX + m["messageId"]: ("message", f"[{msg_name(m['kind'])}] {' '.join(m['text'].split())[:60]}")
            for m in load_messages()["messages"]}


def hide_targets(data):
    """삭제 요청(숨김) 대상 {id: (kind, label)}: 화면 카드 전체, 결정 완료(kind decision)와 메시지(kind message, id msg-<messageId>).
    결정 완료는 숨김 대상일 뿐 메시지·HQ 번호 대상(index_items)에는 넣지 않는다."""
    done = {o["id"]: ("decision", label_of("decision", o)) for o in data.get("resolvedDecisions") or [] if isinstance(o, dict) and o.get("id")}
    return {**message_items(), **done, **index_items(data)}


def msg_target(m):
    """메시지가 지금 속한 항목: coordinator가 연결(link)했으면 그 항목, 아니면 원래 itemId(자유 메시지는 None)."""
    return m.get("link") or ({"id": m["itemId"], "kind": m["kind"], "label": m["label"]} if m["itemId"] else None)


def ref_targets(data):
    """사람용 HQ 번호를 붙일 대상 [(id, kind, label)]. 순서는 처음 부여할 때만 쓰이며, 부여 후 번호는 순서와 무관하다."""
    out = list((i, k, l) for i, (k, l) in index_items(data).items())
    rec = data.get("recommendations")
    for r in (rec.get("items") if isinstance(rec, dict) else None) or []:
        if isinstance(r, dict) and isinstance(r.get("id"), str) and r["id"]:
            out.append((r["id"], "recommendation", r.get("title", "")))
    # 메시지 자체 번호(msg-<messageId>). 연결 항목의 번호(link.id)와 별개이며, 같은 refs.map/next 계약을 따른다
    seen = {i for i, _, _ in out}
    out.extend((i, k, l) for i, (k, l) in message_items().items() if i not in seen)
    return out


def assign_refs(data, state):
    """처음 보는 내부 id에 HQ-n을 붙인다. 이미 붙은 번호는 바꾸지 않고, 사라진 항목의 번호도 지우거나 재사용하지 않는다.
    호출자가 locked() 안에서 state를 쓴다. 바뀌었으면 True."""
    refs = state.setdefault("refs", {"next": 1, "map": {}})
    m = refs.setdefault("map", {})
    # ponytail: next가 손상돼도 기존 최댓값 뒤에서 시작해 재사용하지 않는다
    nxt = max([refs.get("next") or 1] + [int(v[3:]) + 1 for v in m.values()])
    changed = nxt != refs.get("next")
    for iid, _, _ in ref_targets(data):
        if iid not in m:
            m[iid] = f"HQ-{nxt}"; nxt += 1; changed = True
    refs["next"] = nxt
    return changed


def lookup(keys):
    with locked():
        data, state = load_json(DATA), load_state()
        if assign_refs(data, state):
            write_json(STATE, state)
    m, hidden = state["refs"]["map"], state.get("hidden", {})
    by_ref = {v.upper(): k for k, v in m.items()}
    raw = {}
    for kind, (key, _) in LISTS.items():
        for o in data.get(key) or []:
            if isinstance(o, dict) and o.get("id"):
                raw[o["id"]] = o
    for n, p in (data.get("prs") or {}).items():
        raw[f"pr-{int(n)}"] = p
    if data.get("globalLimitsId"):
        raw[data["globalLimitsId"]] = data.get("globalLimits")
    for r in ((data.get("recommendations") or {}).get("items") or []):
        if isinstance(r, dict) and r.get("id"):
            raw[r["id"]] = r
    for msg in load_messages()["messages"]:
        raw.setdefault(MSG_PREFIX + msg["messageId"], msg)
    meta = {i: (k, l) for i, k, l in ref_targets(data)}
    # 결정이 끝나 pendingDecisions에서 옮긴 항목도 원본 id·번호로 찾는다(조회 전용. 메시지·숨김 대상 규칙은 그대로다)
    resolved = {o["id"] for o in data.get("resolvedDecisions") or [] if isinstance(o, dict) and o.get("id") and o["id"] not in raw}
    for o in data.get("resolvedDecisions") or []:
        if isinstance(o, dict) and o.get("id") in resolved:
            raw[o["id"]] = o
            meta.setdefault(o["id"], ("decision", o.get("title", "")))
    out = []
    for key in keys:
        iid = by_ref.get(key.upper()) if REF_RE.match(key) else key
        if iid is None or iid not in m:
            out.append({"query": key, "found": False}); continue
        kind, label = meta.get(iid) or (hidden.get(iid, {}).get("kind"), hidden.get(iid, {}).get("label"))
        out.append({"query": key, "found": True, "ref": m[iid], "id": iid, "kind": kind, "title": label,
                    "inData": iid in raw, "hidden": iid in hidden, "hiddenInfo": hidden.get(iid), "content": raw.get(iid),
                    **({"resolved": True} if iid in resolved else {})})
    return {"results": out}


def known_merged(p):
    # 마지막 조회가 성공했고 MERGED로 확인된 PR만. 조회 실패(ok=false)·미확인은 MERGED로 추정하지 않는다.
    return p.get("ok") is True and p.get("state") == "MERGED"


def view(data, state):
    """숨김 overlay와 merged PR 자동 숨김을 적용한 공개 응답. 원본 data.json과 overlay는 바꾸지 않는다."""
    hidden = state.get("hidden", {})
    v = dict(data)
    for kind, (key, _) in LISTS.items():
        v[key] = [o for o in data.get(key) or [] if o.get("id") not in hidden]
    if data.get("globalLimitsId") in hidden:
        v["globalLimits"] = []
    base = f"https://github.com/{GITHUB_REPO}/pull/" if GITHUB_REPO and REPO_RE.match(GITHUB_REPO) else None
    prs = {n: {**p, "id": f"pr-{int(n)}", "url": p.get("url") or (base and base + str(int(n)))} for n, p in (data.get("prs") or {}).items()}
    v["mergedPrs"] = {n: p for n, p in prs.items() if known_merged(p)}  # 작업 카드의 PR 링크 표시용
    v["prs"] = {n: p for n, p in prs.items() if p["id"] not in hidden and n not in v["mergedPrs"]}
    reqs = [{k: r.get(k) for k in ("requestId", "createdAt", "action", "items", "status", "processedAt", "error")}
            for r in state.get("requests", [])]
    for r in reqs:  # 숨긴 메시지의 원문 미리보기(label)는 공개 응답에 다시 내보내지 않는다
        r["items"] = [{**it, "label": "숨긴 메시지"} if it["kind"] == "message" and it["id"] in hidden else it for it in r["items"]]
    msgs = [m for m in load_messages()["messages"] if MSG_PREFIX + m["messageId"] not in hidden]
    with _refresh_lock:
        refresh = {**_refresh, "intervalSec": PR_REFRESH_SEC}
    return {"data": v, "refs": state.get("refs", {}).get("map", {}), "requests": reqs, "hiddenCount": len(hidden), "prRefresh": refresh,
            "messages": msgs, "flush": flush_public(load_flush()), "serverTime": now()}



# ---------- 복원 점검 (dry-run 병합, 운영 루트는 쓰지 않는다) ----------
# 읽을 수 있는 현재 파일을 기준으로 백업을 병합한 결과를 별도 출력 루트에만 만든다. 충돌이 있으면 아무것도 만들지 않고 중단한다.
# 같은 키의 레코드는 같거나, 한쪽이 다른 쪽의 원문·답변·이력을 모두 담고 정해진 방향으로만 나아갔을 때만 합친다.
FORWARD = {  # 종류 -> (status 전진 방향, 옛 값이 비어 있을 때만 채워질 수 있는 키, 앞부분이 같아야 하는 이력 목록)
    "requests": ({"pending": ("done", "failed")}, ("processedAt", "error"), ()),
    "messages": ({"received": ("processed",)}, ("processedAt", "processNote"), ("replies", "linkHistory")),
    "flushes": ({"sending": ("queued", "failed", "processed"), "queued": ("processed",)},
                ("queueMessageId", "sentAt", "error", "processedAt", "processNote"), ()),
}


def extends(new, old, kind):
    fwd, fill, hist = FORWARD[kind]
    for k in set(old) | set(new):
        a, b = old.get(k), new.get(k)
        if a == b or (k == "status" and b in fwd.get(a, ())) or (k in fill and a in (None, "")):
            continue
        if k in hist and isinstance(b, list) and b[:len(a or [])] == (a or []):
            continue
        if k == "link" and (new.get("linkHistory") or []) != (old.get("linkHistory") or []):
            continue  # 연결은 linkHistory가 늘어난 쪽의 현재 값이다
        return False
    return True


def merge_keyed(cur, bak, key, kind, conflicts):
    out, pos, added = list(cur), {x.get(key): i for i, x in enumerate(cur)}, []
    for x in bak:
        i = pos.get(x.get(key))
        if i is None:
            out.append(x); added.append(x.get(key))
        elif out[i] == x or extends(out[i], x, kind):
            continue
        elif extends(x, out[i], kind):
            out[i] = x
        else:
            conflicts.append(f"{kind} {x.get(key)}: 현재와 백업이 서로 다른 내용을 담고 있습니다")
    out.sort(key=lambda x: x.get("createdAt") or "")  # 안정 정렬: 같은 시각은 현재 파일 순서를 유지한다
    return out, added


def merge_refs(cur, bak, conflicts):
    m = dict(cur.get("map") or {})
    for iid, hq in (bak.get("map") or {}).items():
        if m.setdefault(iid, hq) != hq:
            conflicts.append(f"refs {iid}: 현재 {m[iid]}, 백업 {hq}")
    seen = {}
    for iid, hq in m.items():
        if hq.upper() in seen:
            conflicts.append(f"refs {hq}: {seen[hq.upper()]}와 {iid}에 함께 붙어 있습니다")
        seen[hq.upper()] = iid
    used = max([int(v[3:]) for v in m.values()] or [0])
    return {"next": max(used + 1, cur.get("next") or 1, bak.get("next") or 1), "map": m}


def read_current():
    """운영 루트의 현재 파일을 읽기만 한다. {이름: 값 또는 None}, {이름: 문제}."""
    cur, problems = {}, {}
    with read_locked():
        for fn, src in SNAP_FILES.items():
            try:
                cur[fn] = load_json(src)
            except FileNotFoundError:
                cur[fn], problems[fn] = None, "없음"
            except (ValueError, UnicodeDecodeError):
                cur[fn], problems[fn] = None, "손상(JSON으로 읽지 못함)"
    return cur, problems


def restore_check(bdir, out_root):
    bdir, out_root, root = (os.path.realpath(x) for x in (bdir, out_root, ROOT))
    if any(x == y or x.startswith(y + os.sep) for x, y in ((out_root, root), (root, out_root))):
        sys.exit("출력 루트는 운영 데이터 루트와 겹치면 안 됩니다(운영 덮어쓰기 금지)")
    if os.path.exists(out_root) and os.listdir(out_root):
        sys.exit("출력 루트는 없거나 비어 있어야 합니다")
    if not (BACKUP_RE.match(os.path.basename(bdir)) and os.path.isfile(os.path.join(bdir, "manifest.json"))):
        sys.exit("완료된 백업 디렉터리가 아닙니다(manifest 없음 또는 .tmp- 미완료)")
    man = load_json(os.path.join(bdir, "manifest.json"))
    bak = {}
    for fn in SNAP_FILES:  # 무결성: manifest의 존재·크기·sha256과 실제 파일이 같아야 한다
        meta, path = man["files"].get(fn) or {}, os.path.join(bdir, fn)
        if not meta.get("exists"):
            if os.path.exists(path):
                sys.exit(f"무결성 실패: manifest에 없는 {fn}이 있습니다")
            bak[fn] = None; continue
        try:
            raw = open(path, "rb").read()
        except FileNotFoundError:
            sys.exit(f"무결성 실패: {fn}이 없습니다")
        if len(raw) != meta["size"] or hashlib.sha256(raw).hexdigest() != meta["sha256"]:
            sys.exit(f"무결성 실패: {fn}의 크기·sha256이 manifest와 다릅니다")
        try:
            bak[fn] = json.loads(raw)
        except ValueError:
            bak[fn] = None  # 백업 당시 이미 손상된 파일
    cur, problems = read_current()
    problems = {fn: p for fn, p in problems.items() if p != "없음" or bak[fn] is not None}  # 양쪽 다 없는 파일(예: flush 미사용)은 문제가 아니다
    since = man["createdAt"]
    notes = [f"현재 {fn} {p}: 백업 시각({since}) 이후의 변경은 복구되지 않을 수 있습니다" + (" (백업에도 없음)" if bak[fn] is None else "")
             for fn, p in problems.items()]
    pick = lambda fn: cur[fn] if cur[fn] is not None else bak[fn]
    if "state.json" in problems:
        notes.append("현재 state.json을 읽지 못해 백업 이후 부여된 HQ 번호를 알 수 없습니다. 반영 전에 refs.next를 ledger·task·메시지 회신에 나온 가장 큰 HQ 번호보다 크게 올려 번호 재사용을 피하세요")
    conflicts = []
    data = pick("data.json")
    if cur["data.json"] is not None and bak["data.json"] is not None:  # data.json은 현재를 그대로 쓴다. 백업에만 있는 항목은 알리기만 한다
        ids = lambda d: {o.get("id") for k in ("work", "questions", "pendingDecisions", "resolvedDecisions") for o in d.get(k) or [] if isinstance(o, dict)}
        gone = sorted(i for i in ids(bak["data.json"]) - ids(cur["data.json"]) if i)
        if gone:
            notes.append(f"백업에만 있는 data 항목 {len(gone)}건은 병합하지 않았습니다(현재에서 지웠을 수 있음): {', '.join(gone[:20])}")
    cs, bs = cur["state.json"] or {}, bak["state.json"] or {}
    state = {**bs, **cs}
    state["refs"] = merge_refs(cs.get("refs") or {}, bs.get("refs") or {}, conflicts)
    state["requests"], radd = merge_keyed(cs.get("requests") or [], bs.get("requests") or [], "requestId", "requests", conflicts)
    state["hidden"] = {**(bs.get("hidden") or {}), **(cs.get("hidden") or {})}
    readd = sorted(set(bs.get("hidden") or {}) - set(cs.get("hidden") or {})) if cur["state.json"] is not None else []
    if readd:
        notes.append(f"백업에만 있는 숨김 {len(readd)}건을 다시 넣었습니다(현재에서 직접 해제했다면 확인 필요): {', '.join(readd[:20])}")
    cm, bm = cur["messages.json"] or {}, bak["messages.json"] or {}
    msgs = {**bm, **cm}
    msgs["messages"], madd = merge_keyed(cm.get("messages") or [], bm.get("messages") or [], "messageId", "messages", conflicts)
    cf, bf = cur["flush.json"], bak["flush.json"] or {}
    flush = {**bf, **(cf or {})}  # 등록은 현재 파일이 있으면 현재 것(해제·교체도 유효한 변경이다)
    flush["flushes"], fadd = merge_keyed((cf or {}).get("flushes") or [], bf.get("flushes") or [], "flushId", "flushes", conflicts)
    flush["flushes"] = flush["flushes"][-FLUSH_KEEP:]
    report = {"backup": os.path.basename(bdir), "backupCreatedAt": since, "gitHeadAtBackup": man.get("gitHead"), "outRoot": out_root,
              "currentProblems": problems, "conflicts": conflicts, "notes": notes,
              "addedFromBackup": {"requests": len(radd), "messages": len(madd), "flushes": len(fadd), "hidden": len(readd)}}
    if conflicts:
        report["result"] = "중단: 충돌이 있어 병합 결과를 만들지 않았습니다. 충돌 레코드를 확인한 뒤 결정하세요"
        print(json.dumps(report, ensure_ascii=False, indent=2))
        sys.exit(1)
    res = {"data.json": data, "state.json": state if (cs or bs) else None, "messages.json": msgs if (cm or bm) else None,
           "flush.json": flush if (cf or bf) else None}
    res = {fn: v for fn, v in res.items() if v is not None}
    report["counts"] = counts(res)
    for sub in ("", "public", "private"):
        os.makedirs(os.path.join(out_root, sub), mode=0o700, exist_ok=True); os.chmod(os.path.join(out_root, sub), 0o700)
    for fn, v in res.items():
        write_private(os.path.join(out_root, "public" if fn == "data.json" else "private", fn), json.dumps(v, ensure_ascii=False, indent=2).encode())
    write_private(os.path.join(out_root, "restore-report.json"), json.dumps(report, ensure_ascii=False, indent=2).encode())
    report["result"] = "병합 결과를 출력 루트에만 만들었습니다. 운영 데이터는 바꾸지 않았습니다"
    return report

# ---------- PR 자동 조회 (서버) ----------
# ponytail: daemon·cron 없이 /api/dashboard 요청에 얹는다. 화면이 닫혀 있으면 조회하지 않는다.
_refresh_lock = threading.Lock()
_refresh = {"running": False, "startedAt": None, "finishedAt": None, "ok": None, "error": None}
_last_try = None  # time.monotonic(). 실패해도 이 시각 기준 5분 동안 재시도하지 않는다


def maybe_refresh_prs(data):
    global _last_try
    if not GITHUB_REPO:  # opt-in: 레포를 설정하지 않으면 gh를 실행하지 않는다
        return False
    try:
        age = (datetime.now(KST) - datetime.fromisoformat(data["prsCheckedAt"])).total_seconds()
    except (KeyError, TypeError, ValueError):
        age = None
    with _refresh_lock:
        if _refresh["running"] or (_last_try is not None and time.monotonic() - _last_try < PR_REFRESH_SEC) \
                or (age is not None and 0 <= age < PR_REFRESH_SEC):
            return False
        _last_try = time.monotonic()
        _refresh.update(running=True, startedAt=now())
    threading.Thread(target=_run_refresh, daemon=True).start()
    return True


def _run_refresh():
    # 고정 스크립트만 shell=False로 실행한다. 요청 내용은 인자로 넘기지 않는다.
    try:
        r = subprocess.run([sys.executable, os.path.join(HERE, "refresh_prs.py")], capture_output=True,
                           timeout=PR_REFRESH_TIMEOUT, stdin=subprocess.DEVNULL)
        ok, err = r.returncode == 0, None if r.returncode == 0 else f"exit {r.returncode}"
    except subprocess.TimeoutExpired:
        ok, err = False, f"{PR_REFRESH_TIMEOUT}초 timeout"
    except OSError:
        ok, err = False, "실행 실패"
    with _refresh_lock:
        _refresh.update(running=False, finishedAt=now(), ok=ok, error=err)


# ---------- 요청 접수 (서버) ----------

class BadRequest(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def accept_request(body):
    if not isinstance(body, dict):
        raise BadRequest(400, "JSON object가 필요합니다")
    rid = body.get("requestId")
    if not isinstance(rid, str) or not REQ_RE.match(rid):
        raise BadRequest(400, "requestId는 32자리 hex여야 합니다")
    if body.get("action") != ACTION:
        raise BadRequest(400, f"action은 {ACTION}만 허용됩니다")
    items = body.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
        raise BadRequest(400, f"items는 1~{MAX_ITEMS}개여야 합니다")
    with locked():
        state = load_state()
        for r in state["requests"]:
            if r["requestId"] == rid:  # 같은 요청 재전송: 기존 기록 그대로 반환
                return r, True
        idx = hide_targets(load_json(DATA))  # 화면 카드와 메시지. 메시지는 존재하는 messageId만 받는다
        clean, seen = [], set()
        for it in items:
            if not isinstance(it, dict):
                raise BadRequest(400, "item 형식 오류")
            kind, iid = it.get("kind"), it.get("id")
            # 형식이 아니라 현재 인덱스에 실재하는지로 판정한다. q-legacy01처럼 8hex가 아닌 기존 id도 화면·HQ 번호와 같이 받는다
            if not isinstance(iid, str) or iid not in idx:
                raise BadRequest(400, f"알 수 없는 id: {str(iid)[:40]}")
            if idx[iid][0] != kind:
                raise BadRequest(400, f"종류 불일치: {iid}")
            if iid in seen:
                continue
            seen.add(iid)
            clean.append({"kind": kind, "id": iid, "label": idx[iid][1][:200]})  # label은 서버 원본 기준
        req = {"schemaVersion": SCHEMA, "requestId": rid, "createdAt": now(), "action": ACTION,
               "hide_from_dashboard": True, "items": clean, "status": "pending"}
        state["requests"].append(req)
        write_json(STATE, state)
        return req, False


# ---------- 항목별 메시지 (결정 답변·후속 질문) ----------
# 삭제 요청함(state.json)과 다른 파일이다. process-inbox·reject·submit은 이 파일을 읽지도 쓰지도 않는다.
# 서버와 CLI는 메시지를 보관·표시만 한다. 결정 승인·작업 완료 등 원본 data.json 변경은 coordinator가 따로 한다.

def load_messages():
    return load_json(MESSAGES, {"schemaVersion": SCHEMA, "messages": []})


def clean_text(t, limit):
    if not isinstance(t, str):
        raise BadRequest(400, "text는 문자열이어야 합니다")
    t = t.replace("\r\n", "\n").strip()
    if not t:
        raise BadRequest(400, "내용이 비어 있습니다")
    if len(t) > limit:
        raise BadRequest(400, f"내용은 {limit}자 이하여야 합니다")
    if CTRL_RE.search(t):
        raise BadRequest(400, "줄바꿈·탭 외 제어문자는 넣을 수 없습니다")
    return t


def accept_message(body):
    if not isinstance(body, dict):
        raise BadRequest(400, "JSON object가 필요합니다")
    mid, kind, iid = body.get("messageId"), body.get("kind"), body.get("itemId")
    if not isinstance(mid, str) or not REQ_RE.match(mid):
        raise BadRequest(400, "messageId는 32자리 hex여야 합니다")
    if kind != "general" and kind not in MSG_KINDS:
        raise BadRequest(400, "메시지는 작업·질문·PR·결정 항목이나 자유 메시지(general)로만 남길 수 있습니다")
    if kind == "general" and iid is not None:
        raise BadRequest(400, "자유 메시지에는 itemId를 넣지 않습니다")
    text = clean_text(body.get("text"), MSG_MAX)
    with locked():
        box = load_messages()
        for m in box["messages"]:
            if m["messageId"] == mid:  # 재시도: 같은 내용이면 기존 기록, 다르면 충돌(같은 키로 다른 글을 덮지 않는다)
                if (m["kind"], m["itemId"], m["text"]) != (kind, iid, text):
                    raise BadRequest(409, "같은 messageId로 다른 내용이 이미 접수됐습니다")
                return m, True
        if kind != "general":  # 자유 메시지는 항목에 연결하지 않는다(itemId·label·ref 모두 null)
            idx = index_items(load_json(DATA))
            if not isinstance(iid, str) or iid not in idx:  # 삭제 요청과 같은 기준: 실제 인덱스
                raise BadRequest(400, f"알 수 없는 id: {str(iid)[:40]}")
            if idx[iid][0] != kind:
                raise BadRequest(400, f"종류 불일치: {iid}")
        if len(box["messages"]) >= MSG_CAP:  # ponytail: 전체 상한. 걸리면 오래된 processed를 보관 파일로 옮기는 명령을 추가한다
            raise BadRequest(507, f"메시지가 {MSG_CAP}건을 넘어 더 받을 수 없습니다")
        m = {"messageId": mid, "kind": kind, "itemId": iid, "label": idx[iid][1][:200] if iid else None, "text": text, "createdAt": now(),
             "status": "received", "processedAt": None, "processNote": None, "replies": []}
        box["messages"].append(m)
        write_json(MESSAGES, box)
        return m, False


def msg_cli(a):
    with locked():
        state = load_state()
        if assign_refs(load_json(DATA), state):  # 아직 번호가 없는 메시지(방금 접수 등)에 메시지 번호를 붙인다
            write_json(STATE, state)
        box, refs, hidden = load_messages(), state.get("refs", {}).get("map", {}), state.get("hidden", {})
        own = lambda m: refs.get(MSG_PREFIX + m["messageId"])
        ms = box["messages"]
        # 숨긴 메시지(진행판 표시에서만 빠짐)도 CLI에서는 원문 그대로 조회한다. hidden 필드로 구분한다
        link_ref = lambda m: m.get("link") and refs.get(m["link"]["id"])
        if a.mcmd == "list":
            ref_of = (a.item or "").upper()
            return {"messages": [{"messageId": m["messageId"], "msgRef": own(m), "ref": refs.get(m["itemId"]), "itemId": m["itemId"], "kind": m["kind"],
                                  "label": m["label"], "status": m["status"], "createdAt": m["createdAt"], "replies": len(m["replies"]),
                                  "linkRef": link_ref(m), "hidden": MSG_PREFIX + m["messageId"] in hidden, "text": m["text"][:120]}
                                 for m in ms if (a.all or m["status"] == "received")
                                 and (not a.item or a.item in (m["itemId"], (m.get("link") or {}).get("id"))
                                      or ref_of == (own(m) or "").upper()
                                      or ref_of in ((refs.get(m["itemId"]) or "").upper(), (link_ref(m) or "").upper()))]}
        mid = next((k[len(MSG_PREFIX):] for k, v in refs.items() if v.upper() == a.id.upper() and k.startswith(MSG_PREFIX)), a.id)
        m = next((m for m in ms if m["messageId"] == mid), None)  # messageId 또는 메시지 자체 번호(HQ-n)
        if not m:
            sys.exit(f"메시지 {a.id} 없음")
        if a.mcmd == "read":
            t, idx = msg_target(m), index_items(load_json(DATA))
            # itemNow: 지금 속한 항목(연결했으면 연결 항목, 자유 메시지는 None)의 현재 상태
            return {**m, "msgRef": own(m), "ref": refs.get(m["itemId"]), "linkRef": link_ref(m), "hidden": MSG_PREFIX + m["messageId"] in hidden,
                    "itemNow": t and {"id": t["id"], "ref": refs.get(t["id"]), "inData": t["id"] in idx,
                                      "label": idx.get(t["id"], (None, None))[1], "hidden": t["id"] in hidden}}
        if a.mcmd in ("link", "unlink"):
            # 분류 연결: 원문·kind·itemId·답변·상태는 그대로 두고 표시 위치만 바꾼다. 원본 data.json은 바꾸지 않는다
            link = None
            if a.mcmd == "link":
                by_ref = {v.upper(): k for k, v in refs.items()}
                iid = by_ref.get(a.item.upper()) if REF_RE.match(a.item) else a.item
                idx = index_items(load_json(DATA))
                if iid not in idx or idx[iid][0] not in MSG_KINDS:
                    sys.exit(f"연결할 수 없는 항목: {a.item} (작업·질문·PR·결정의 HQ 번호나 내부 id만, 새 항목은 item add 후 연결)")
                link = {"id": iid, "kind": idx[iid][0], "label": idx[iid][1][:200], "at": now(), "note": a.note or None}
            m["link"] = link
            m.setdefault("linkHistory", []).append(link or {"id": None, "at": now(), "note": a.note or None})
        elif a.mcmd == "respond":
            raw = sys.stdin.read() if a.file == "-" else open(a.file, encoding="utf-8").read() if a.file else a.text
            try:
                m["replies"].append({"at": now(), "text": clean_text(raw, REPLY_MAX)})
            except BadRequest as e:
                sys.exit(f"거절: {e}")
        elif m["status"] != "processed":  # process: 반복해도 처음 처리 기록을 유지한다
            m.update(status="processed", processedAt=now(), processNote=(a.note or None))
        write_json(MESSAGES, box)
        return {**m, "msgRef": own(m), "ref": refs.get(m["itemId"]), "linkRef": link_ref(m)}


# ---------- 지금 확인 요청 (flush) ----------
# 명시 등록된 Codex thread에 고정 문구를 `codex queue`로 적재한다. 고정 argv·shell=False이며 사용자 문자열은 넣지 않는다.
# 서버는 터미널 입력·에이전트 메일·승인·숨김·작업 실행을 하지 않는다. 적재(queued)는 처리 완료가 아니며, coordinator의 flush done만 processed다.

def load_flush():
    return load_json(FLUSH, {"schemaVersion": SCHEMA, "registration": None, "flushes": []})


def age_sec(ts):
    return (datetime.now(KST) - datetime.fromisoformat(ts)).total_seconds()


def codex_thread_name(thread):
    """~/.codex/session_index.jsonl에 있으면 thread 이름(마지막 기록), 없으면 None."""
    name = None
    try:
        with open(os.path.join(CODEX_HOME, "session_index.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if o.get("id") == thread:
                    name = o.get("thread_name") or ""
    except OSError:
        return None
    return name


def close_stale_sending(box):
    """서버가 전송 중에 죽어 남은 sending을 failed로 닫는다(자동 재전송은 하지 않는다). 바뀌었으면 True."""
    changed = False
    for f in box["flushes"]:
        if f["status"] == "sending" and age_sec(f["createdAt"]) > FLUSH_TIMEOUT * 4:
            f.update(status="failed", error="전송 결과를 기록하지 못했습니다(적재 여부 미확인)"); changed = True
    return changed


def deliver_codex(thread, fid):
    if not CODEX_FLUSH:
        return "failed", None, "HQ_ENABLE_CODEX_FLUSH=1이 아니라 보내지 않았습니다"
    try:
        r = subprocess.run([CODEX_BIN, "queue", "--thread", thread, "--message", FLUSH_MESSAGE.format(fid=fid, root=ROOT)],
                           capture_output=True, text=True, timeout=FLUSH_TIMEOUT, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return "failed", None, f"{FLUSH_TIMEOUT}초 timeout(적재 여부 미확인)"
    except OSError:
        return "failed", None, "codex를 실행하지 못했습니다"
    m = QUEUED_RE.search(r.stdout)
    if r.returncode == 0 and m:
        return "queued", m.group(1), None
    lines = (r.stderr or r.stdout).strip().splitlines()
    return "failed", None, (lines[-1] if lines else f"exit {r.returncode}")[:300]


def accept_flush(body):
    if not isinstance(body, dict) or not isinstance(body.get("flushId"), str) or not REQ_RE.match(body["flushId"]):
        raise BadRequest(400, "flushId는 32자리 hex여야 합니다")
    fid = body["flushId"]
    with locked():
        box = load_flush()
        close_stale_sending(box)
        for f in box["flushes"]:
            if f["flushId"] == fid:  # 같은 요청 재전송
                return f, True
        reg = box["registration"]
        if reg:  # 같은 thread에 coordinator가 처리 기록(done)을 남기지 않은 요청이 있으면 다시 쌓지 않는다
            for f in reversed(box["flushes"]):
                if f["status"] in ("sending", "queued") and f["thread"] == reg["thread"]:
                    return f, True
        if box["flushes"] and (wait := FLUSH_COOLDOWN - age_sec(box["flushes"][-1]["createdAt"])) > 0:
            raise BadRequest(429, f"{int(wait) + 1}초 후에 다시 요청할 수 있습니다")
        f = {"flushId": fid, "createdAt": now(), "provider": reg and reg["provider"], "thread": reg and reg["thread"],
             "threadName": reg and reg["threadName"], "status": "sending" if reg else "not_registered",
             "error": None if reg else "등록된 coordinator thread가 없습니다", "queueMessageId": None, "sentAt": None,
             "processedAt": None, "processNote": None}
        box["flushes"] = (box["flushes"] + [f])[-FLUSH_KEEP:]
        write_json(FLUSH, box)
    if not reg:
        return f, False
    status, qid, err = deliver_codex(reg["thread"], fid)  # 락 밖에서 실행한다(최대 FLUSH_TIMEOUT초)
    with locked():
        box = load_flush()
        f = next(x for x in box["flushes"] if x["flushId"] == fid)
        f.update(status=status, queueMessageId=qid, error=err, sentAt=now())
        write_json(FLUSH, box)
    return f, False


def flush_public(box):
    reg = box["registration"]
    return {"registration": reg and {k: reg[k] for k in ("provider", "threadName", "registeredAt")},
            "recent": [{k: v for k, v in f.items() if k not in ("thread", "queueMessageId")} for f in box["flushes"][-5:]],
            "cooldownSec": FLUSH_COOLDOWN}


def flush_cli(a):
    with locked():
        box = load_flush()
        changed = close_stale_sending(box)
        if a.fcmd == "register":
            if not CODEX_FLUSH:
                sys.exit("Codex 알림은 opt-in입니다. HQ_ENABLE_CODEX_FLUSH=1로 실행하세요")
            if not UUID_RE.match(a.thread):
                sys.exit("thread는 Codex session UUID여야 합니다")
            name = codex_thread_name(a.thread)
            if name is None:
                sys.exit(f"{CODEX_HOME}/session_index.jsonl에 없는 thread입니다")
            prev = box["registration"]
            box["registration"] = {"provider": a.provider, "thread": a.thread, "threadName": name, "registeredAt": now(),
                                   "evidence": a.evidence, "previousThread": prev and prev["thread"]}
            changed = True
        elif a.fcmd == "unregister":
            changed, box["registration"] = box["registration"] is not None, None
        elif a.fcmd == "done":
            f = next((x for x in box["flushes"] if x["flushId"] == a.id), None)
            if not f or f["status"] not in ("queued", "processed"):
                sys.exit(f"처리 기록을 남길 수 있는 flush {a.id}가 없습니다(queued만 가능)")
            if f["status"] != "processed":  # 반복해도 처음 처리 기록을 유지한다
                f.update(status="processed", processedAt=now(), processNote=a.note or None); changed = True
        if changed:
            write_json(FLUSH, box)
    return {"registration": box["registration"], "flushes": box["flushes"][-10:]}


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentHQ/2"
    sys_version = ""

    def send_body(self, code, body, ctype="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
                         "connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in STATIC:  # ponytail: 정확한 경로 allowlist라 경로 탈출 여지가 없다
            name, ctype = STATIC[path]
            with open(os.path.join(ASSETS, name), "rb") as f:
                return self.send_body(200, f.read(), ctype)
        if path == "/api/dashboard":
            try:
                data = load_json(DATA)
            except (ValueError, OSError):
                return self.send_body(503, {"error": "data.json을 읽지 못했습니다(편집 중일 수 있음)"})
            maybe_refresh_prs(data)  # 백그라운드 실행이라 이 응답은 기다리지 않는다. 결과는 다음 poll에 반영된다
            with locked():
                state = load_state()
                if assign_refs(load_json(DATA), state):  # 새 항목에 HQ 번호를 붙여 영속화한다(락 안에서 다시 읽음)
                    write_json(STATE, state)
                box = load_flush()
                if close_stale_sending(box):
                    write_json(FLUSH, box)
            return self.send_body(200, view(data, state))
        self.send_body(404, {"error": "not found"})

    def do_POST(self):
        accept = {"/api/requests": accept_request, "/api/messages": accept_message, "/api/flush": accept_flush}.get(self.path)
        if not accept:
            return self.send_body(404, {"error": "not found"})
        origin = self.headers.get("Origin")
        if origin not in self.server.origins or self.headers.get("Sec-Fetch-Site", "same-origin") != "same-origin":
            return self.send_body(403, {"error": "같은 origin 요청만 허용됩니다"})
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            return self.send_body(415, {"error": "Content-Type: application/json이 필요합니다"})
        try:
            n = int(self.headers.get("Content-Length") or -1)
        except ValueError:
            n = -1
        if not 0 < n <= MAX_BODY:
            return self.send_body(413, {"error": f"본문은 1~{MAX_BODY} byte여야 합니다"})
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8"))
            req, dup = accept(body)
        except BadRequest as e:
            return self.send_body(e.code, {"error": str(e)})
        except (ValueError, UnicodeDecodeError):
            return self.send_body(400, {"error": "JSON 형식 오류"})
        except OSError:
            return self.send_body(500, {"error": "저장하지 못했습니다"})
        key = {accept_request: "request", accept_message: "message", accept_flush: "flush"}[accept]
        if accept is accept_flush:  # 등록 thread UUID와 queue 내부 id는 응답에 넣지 않는다
            req = {k: v for k, v in req.items() if k not in ("thread", "queueMessageId")}
        self.send_body(200 if dup else 201, {key: req, "duplicate": dup})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s [%s] %s\n" % (self.address_string(), now(), fmt % args))


def serve(host, port, aliases=()):
    if not host.startswith("100.") and host != "127.0.0.1":
        sys.exit("127.0.0.1(기본) 또는 tailnet IP(100.x)에만 bind합니다")
    missing = [k for k, (key, _) in LISTS.items() for o in load_json(DATA).get(key) or [] if not o.get("id")]
    if missing:
        print(f"경고: id 없는 항목 {len(missing)}개는 선택할 수 없습니다. `python3 server.py migrate-ids`를 실행하세요.", file=sys.stderr)
    httpd = ThreadingHTTPServer((host, port), Handler)
    # ponytail: 고정 allowlist다. Host 헤더에서 origin을 만들지 않으므로 임의 Host로 우회할 수 없다
    httpd.origins = {f"http://{h}:{port}" for h in (host, *aliases)}
    print(f"serving {' '.join(sorted(httpd.origins))} (root={ROOT})", flush=True)
    httpd.serve_forever()


# ---------- CLI ----------

def migrate_ids():
    with locked():
        data = load_json(DATA)
        added, seen = 0, set()
        for kind, (key, prefix) in LISTS.items():
            for o in data.get(key) or []:
                # 없거나 중복인 id만 새로 붙인다. 형식이 달라도 기존 id는 refs·숨김·메시지의 키라 바꾸지 않는다
                if o.get("id") in seen or not (isinstance(o.get("id"), str) and o["id"]):
                    o["id"] = f"{prefix}-{secrets.token_hex(4)}"
                    added += 1
                seen.add(o["id"])
                # ponytail: id를 첫 키로 옮겨 사람이 편집할 때 눈에 띄게 한다
                items = list(o.items())
                o.clear(); o["id"] = dict(items)["id"]; o.update(items)
        lid = data.get("globalLimitsId")
        if data.get("globalLimits") and not (isinstance(lid, str) and LIMITS_ID_RE.match(lid)):
            data["globalLimitsId"] = f"g-{secrets.token_hex(4)}"  # 한 번 부여하면 유지한다. 문구를 바꿔도 같은 섹션이다
            added += 1
        if added:
            write_json(DATA, data)
        state = load_state()
        if assign_refs(data, state):
            write_json(STATE, state)
    return {"added": added, "total": len(seen), "refsNext": state["refs"]["next"]}


def process_inbox(only=None):
    with locked():
        state = load_state()
        idx = hide_targets(load_json(DATA))
        done = []
        for r in state["requests"]:
            if r["status"] != "pending" or (only and r["requestId"] not in only):
                continue
            bad = [it["id"] for it in r["items"] if idx.get(it["id"], (None,))[0] != it["kind"]]
            r["processedAt"] = now()
            if bad:
                r["status"], r["error"] = "failed", "현재 데이터에 없거나 종류가 다른 id: " + ", ".join(bad)
            else:
                for it in r["items"]:
                    state["hidden"].setdefault(it["id"], {"kind": it["kind"], "label": it["label"],
                                                          "requestId": r["requestId"], "hiddenAt": r["processedAt"]})
                r["status"] = "done"
            done.append({k: r.get(k) for k in ("requestId", "status", "error", "items")})
        if done:
            write_json(STATE, state)
    return {"processed": done, "hiddenTotal": len(state["hidden"])}


JIRA_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]{0,9}-[0-9]{1,7}$")
JIRA_SITE_RE = re.compile(r"^https://[a-z0-9-]+\.atlassian\.net$")
JIRA_PROJECT = os.environ.get("HQ_JIRA_PROJECT") or None  # opt-in. Jira 탭은 이 프로젝트 전용이며, 다른 프로젝트 티켓이 섞인 스냅샷은 통째로 거절한다
JIRA_FIELDS = ("key", "summary", "status", "priority", "project")  # 공개 data.json에는 이 최소 필드만 둔다
SPRINT_FIELDS = ("id", "name", "state", "startDate", "endDate")
SPRINT_STATES = ("active", "future", "closed")
DESC_STATES = ("text", "nontext", "none")  # 평문 일부 / 텍스트 없는 설명(이미지 등) / 설명 없음
DESC_MAX = 400  # 공개 data.json에는 hover 미리보기에 필요한 평문 앞부분만 둔다


def rep_sprint(sprints):
    """여러 Sprint 이력 중 대표 소속 하나: active(최근 시작) > future(가장 가까운 시작) > closed(가장 최근 종료)."""
    by = {st: [s for s in sprints if s["state"] == st] for st in SPRINT_STATES}
    if by["active"]:
        return max(by["active"], key=lambda s: (s.get("startDate") or "", s["id"]))
    if by["future"]:
        return min(by["future"], key=lambda s: (s.get("startDate") or "9999", s["id"]))
    if by["closed"]:
        return max(by["closed"], key=lambda s: (s.get("endDate") or "", s.get("startDate") or "", s["id"]))
    return None


def import_jira(path):
    """Jira 조회 스냅샷(JSON)을 data.json의 jira 키로 옮긴다. 다시 조회하지 않으며 관찰 시각은 스냅샷 값을 그대로 쓴다.
    Sprint 조회가 확인된 스냅샷(sprintField 명시, 티켓마다 sprints 목록)만 받는다. 빈 목록만 'Sprint 없음'이다."""
    if not (JIRA_PROJECT and re.match(r"^[A-Z][A-Z0-9]{0,9}$", JIRA_PROJECT)):
        sys.exit("Jira 스냅샷 import는 opt-in입니다. HQ_JIRA_PROJECT=<프로젝트 키>로 실행하세요")
    src = load_json(path)
    if src.get("isLast") is not True:
        sys.exit("isLast=true인 전체 조회 결과만 가져옵니다")
    site = src.get("site") or ""
    if not JIRA_SITE_RE.match(site):
        sys.exit("site는 https://<이름>.atlassian.net 형식이어야 합니다")
    if not re.match(r"^customfield_[0-9]{1,8}$", str(src.get("sprintField", ""))):
        sys.exit("sprintField(실제 확인한 Sprint 필드 ID)가 없습니다. Sprint를 조회하지 않은 스냅샷은 가져오지 않습니다")
    try:
        observed = datetime.fromisoformat(str(src["observedAt"]).replace(" UTC", "+00:00")).astimezone(KST)
    except (KeyError, ValueError):
        sys.exit("observedAt을 읽지 못했습니다")
    issues, sprints = [], {}
    for i in src.get("issues") or []:
        key = str(i.get("key", ""))
        if not JIRA_KEY_RE.match(key):
            sys.exit(f"잘못된 key: {key[:40]}")
        if i.get("project") != JIRA_PROJECT or not key.startswith(JIRA_PROJECT + "-"):
            sys.exit(f"{JIRA_PROJECT} 이외 프로젝트 티켓은 받지 않습니다: {key[:40]}")
        if not isinstance(i.get("sprints"), list):
            sys.exit(f"{key}: sprints 목록이 없습니다(조회 실패를 Sprint 없음으로 처리하지 않습니다)")
        mine = []
        for sp in i["sprints"]:
            if not isinstance(sp, dict) or not isinstance(sp.get("id"), int) or sp.get("state") not in SPRINT_STATES:
                sys.exit(f"{key}: Sprint 형식 오류")
            sp = {k: sp.get(k) for k in SPRINT_FIELDS}
            sprints[str(sp["id"])] = {k: sp[k] for k in SPRINT_FIELDS if k != "id"}
            mine.append(sp)
        rep = rep_sprint(mine)
        row = {**{k: i.get(k) for k in JIRA_FIELDS}, "sprint": rep and rep["id"], "sprintIds": [s["id"] for s in mine]}
        if src.get("descriptionFetched") is True:  # 설명을 조회한 스냅샷만 미리보기를 둔다. 없으면 UI는 '미조회'로 표시한다
            ds = i.get("descriptionState")
            if ds not in DESC_STATES or not isinstance(i.get("description", ""), str):
                sys.exit(f"{key}: descriptionState/description 형식 오류")
            row.update(descriptionState=ds, description=i.get("description", "")[:DESC_MAX] if ds == "text" else "",
                       descriptionTruncated=bool(i.get("descriptionTruncated")) or len(i.get("description", "")) > DESC_MAX)
        if "isSubtask" in i:  # Jira issuetype.subtask 기준. 없으면(legacy) 저장하지 않고 UI가 '유형 미확인'으로 표시한다
            it, pk = i.get("issueType"), i.get("parentKey")
            if not isinstance(i["isSubtask"], bool) or not isinstance(it, (str, type(None))) or not (pk is None or JIRA_KEY_RE.match(str(pk))):
                sys.exit(f"{key}: isSubtask/issueType/parentKey 형식 오류")
            row.update(issueType=(it or "")[:40], isSubtask=i["isSubtask"])
            if i["isSubtask"] and pk:  # 부모 key만 둔다. 부모를 따로 조회하거나 목록에 넣지 않는다(일반 티켓의 epic parent는 버림)
                row["parentKey"] = pk
        issues.append(row)
    with locked():
        data = load_json(DATA)
        data["jira"] = {"observedAt": observed.isoformat(timespec="seconds"), "importedAt": now(), "site": site,
                        "scope": src.get("scope"), "project": JIRA_PROJECT, "sprintField": src["sprintField"],
                        "descriptionFetched": src.get("descriptionFetched") is True,
                        "dueSetCount": sum(1 for i in src.get("issues") or [] if i.get("due")),
                        "sprints": sprints, "issues": issues}
        write_json(DATA, data)
    return {"issues": len(issues), "sprints": len(sprints), "observedAt": data["jira"]["observedAt"]}


# ---------- 항목 쓰기 (item add/get/set/resolve) ----------
# data.json 업무·질문·결정의 유일한 쓰기 경로다. 락 안에서 최신 파일을 다시 읽고 대상 항목만 patch해 원자적으로 쓴다.
# 다른 항목·prs·jira·prsCheckedAt은 읽은 최신 값을 그대로 둔다. 메시지 processed·숨김·결정 승인은 바꾸지 않는다.
STATES = ("open", "blocked", "waiting_user", "done", "closed", "dropped")
REASON_STATES = ("blocked", "closed", "dropped")  # 사유(--reason) 필수
CATEGORIES = ("PR·코드", "에이전트 운영", "진행 보고·알림", "기록 관리", "기타")
REQUIRED = {"work": ("title", "status"), "question": ("q", "status"), "decision": ("title",)}
DONE_FIELD = {"work": "conclusion", "question": "answer"}  # state done이면 비어 있으면 안 된다
# set으로 바꿀 수 있는 키. add는 여기에 REQUIRED 키를 더한다. id·history·rev·updatedAt·updatedBy는 CLI만 쓴다
PATCH_KEYS = {"work": ("status", "state", "conclusion", "verification", "remaining", "evidence", "prs"),
              "question": ("status", "state", "answer", "evidence", "category", "thread", "prs"),
              "decision": ("detail", "waiting", "evidence", "prs")}
FIELD_MAX = 4000
SOURCE_RE = re.compile(r"^(HQ-[1-9][0-9]{0,6}|chat:\d{4}-\d{2}-\d{2})$")


def find_item(data, iid):
    """(kind, 목록, index) — pendingDecisions에서 옮긴 결정은 kind decision, 목록 resolvedDecisions로 찾는다."""
    for kind, (key, _) in [*LISTS.items(), ("decision", ("resolvedDecisions", "d"))]:
        for i, o in enumerate(data.get(key) or []):
            if isinstance(o, dict) and o.get("id") == iid:
                return kind, key, i
    return None


def resolve_key(key, refs):
    """HQ-n 또는 내부 id → 내부 id. 번호는 이미 부여된 것만 찾는다(여기서 새 번호를 붙이지 않는다)."""
    if REF_RE.match(key):
        return next((k for k, v in refs.items() if v.upper() == key.upper()), None)
    return key


def clean_fields(kind, fields, allowed):
    if not isinstance(fields, dict):
        sys.exit("필드는 JSON object여야 합니다")
    bad = sorted(set(fields) - set(allowed))
    if bad:
        sys.exit(f"바꿀 수 없는 키: {', '.join(bad)} (허용: {', '.join(allowed)})")
    out = {}
    for k, v in fields.items():
        try:
            if k == "prs":
                if not isinstance(v, list) or not all(isinstance(n, int) and not isinstance(n, bool) and n > 0 for n in v):
                    sys.exit("prs는 양의 정수 PR 번호 목록이어야 합니다")
            elif k == "evidence":
                if not isinstance(v, list) or not all(isinstance(e, dict) and set(e) == {"label", "url"} and isinstance(e["url"], str)
                                                      and e["url"].startswith("https://") for e in v):
                    sys.exit("evidence는 [{label, url}] 목록이며 url은 https만 허용합니다")
                v = [{"label": clean_text(e["label"], 200), "url": clean_text(e["url"], 500)} for e in v]
            elif k == "state":
                if v not in STATES:
                    sys.exit(f"state는 {', '.join(STATES)} 중 하나입니다")
            elif k == "category":
                if v not in CATEGORIES:
                    sys.exit(f"category는 {', '.join(CATEGORIES)} 중 하나입니다")
            elif k not in REQUIRED[kind] and isinstance(v, str) and not v.strip():
                v = ""  # 선택 문자열(remaining 등)은 비워서 끝난 내용을 지울 수 있다. done의 결론·답변은 check_item이 따로 본다
            else:
                v = clean_text(v, FIELD_MAX)
        except BadRequest as e:
            sys.exit(f"{k}: {e}")
        out[k] = v
    return out


def read_fields(a):
    """--file(JSON object, 경로 또는 -)과 --set KEY=VALUE(문자열)를 합친다. 긴 내용은 --file로 넘긴다. 셸 명령은 실행하지 않는다."""
    out = {}
    if a.file:
        raw = sys.stdin.read() if a.file == "-" else open(a.file, encoding="utf-8").read()
        try:
            out = json.loads(raw)
        except ValueError:
            sys.exit("--file은 JSON object여야 합니다")
        if not isinstance(out, dict):
            sys.exit("--file은 JSON object여야 합니다")
    for kv in a.set or []:
        k, sep, v = kv.partition("=")
        if not sep:
            sys.exit(f"--set은 KEY=VALUE 형식입니다: {kv[:40]}")
        out[k] = v
    return out


def check_item(kind, o, reason):
    for k in REQUIRED[kind]:
        if not (isinstance(o.get(k), str) and o[k].strip()):
            sys.exit(f"필수 필드 {k}가 비어 있습니다")
    st = o.get("state")
    if st == "done" and kind in DONE_FIELD and not (o.get(DONE_FIELD[kind]) or "").strip():
        sys.exit(f"state done에는 {DONE_FIELD[kind]}(결론·답변)가 필요합니다")
    if st in REASON_STATES and not reason:
        sys.exit(f"state {st}에는 --reason(사유)이 필요합니다")


def describe(before, after):
    return "; ".join(f"state: {before.get('state') or '없음'} → {after[k]}" if k == "state" else f"{k} {'수정' if k in before else '추가'}"
                     for k in sorted(after) if before.get(k) != after[k])


def stamp(o, change, reason, by):
    o["rev"] = int(o.get("rev") or 0) + 1
    o["updatedAt"], o["updatedBy"] = now(), by
    o.setdefault("history", []).append({"at": o["updatedAt"], "change": change, "reason": reason or "", "by": by, "rev": o["rev"]})


def item_out(kind, o, refs, hidden, resolved=False):
    return {"kind": kind, "id": o["id"], "ref": refs.get(o["id"]), "rev": int(o.get("rev") or 0), "hidden": o["id"] in hidden,
            **({"resolved": True} if resolved else {}), "item": o}


def clean_arg(name, v, limit):
    """--reason·--by: 주면 메시지·답변과 같은 규칙(비어 있지 않음, 제어문자 없음, 길이)으로 검사한다."""
    if v is None:
        return None
    try:
        return clean_text(v, limit)
    except BadRequest as e:
        sys.exit(f"--{name}: {e}")


def item_cli(a):
    by = clean_arg("by", getattr(a, "by", None), 100) or "HQ coordinator"
    a.reason = clean_arg("reason", getattr(a, "reason", None), FIELD_MAX)
    with locked():
        data, state = load_json(DATA), load_state()
        refs, hidden = state.get("refs", {}).get("map", {}), state.get("hidden", {})
        if a.icmd == "add":
            key, prefix = LISTS[a.kind]
            fields = clean_fields(a.kind, read_fields(a), REQUIRED[a.kind] + PATCH_KEYS[a.kind])  # 결정에는 state가 없다(해소는 resolve)
            if a.kind != "decision":
                fields.setdefault("state", "open")
            check_item(a.kind, fields, a.reason)
            # 지금 data의 id와, 지워진 항목까지 남아 있는 refs.map의 id 모두와 겹치지 않게 한다(옛 번호·숨김·메시지 연결이 따라붙지 않게)
            taken = {o.get("id") for k in (*[v[0] for v in LISTS.values()], "resolvedDecisions") for o in data.get(k) or [] if isinstance(o, dict)} | set(refs)
            iid = next(i for i in iter(lambda: f"{prefix}-{secrets.token_hex(4)}", None) if i not in taken)
            o = {"id": iid, **fields}
            stamp(o, "추가", a.reason, by)
            data.setdefault(key, []).append(o)
            data["updatedAt"], data["updatedBy"] = o["updatedAt"], by
            write_json(DATA, data)
            if assign_refs(data, state):  # 같은 락 안에서 HQ 번호를 붙인다(기존 번호·next 계약 그대로)
                write_json(STATE, state)
            return item_out(a.kind, o, state["refs"]["map"], hidden)
        iid = resolve_key(a.id, refs)
        hit = iid and find_item(data, iid)
        if not hit:
            sys.exit(f"항목 {a.id} 없음 (HQ 번호는 이미 부여된 것만 찾는다)")
        kind, key, i = hit
        o = data[key][i]
        if a.icmd == "get":
            return item_out(kind, o, refs, hidden, key == "resolvedDecisions")
        if key == "resolvedDecisions":
            sys.exit(f"{a.id}는 이미 해소된 결정입니다(읽기 전용)")
        if a.expect_rev is not None and int(o.get("rev") or 0) != a.expect_rev:
            sys.exit(f"거절: {a.id}의 현재 rev는 {int(o.get('rev') or 0)}입니다(--expect-rev {a.expect_rev}). item get으로 최신 내용을 다시 읽으세요")
        if a.icmd == "set":
            fields = clean_fields(kind, read_fields(a), PATCH_KEYS[kind])
            if not fields:
                sys.exit("바꿀 필드가 없습니다(--file 또는 --set)")
            new = {**o, **fields}
            check_item(kind, new, a.reason)
            change = describe(o, new)
            if not change:
                return {**item_out(kind, o, refs, hidden), "unchanged": True}
            o.update(fields)
            stamp(o, change, a.reason, by)
        else:  # resolve: pendingDecisions → resolvedDecisions. 사용자 결정 출처와 사유를 명시해야 한다
            if kind != "decision":
                sys.exit("resolve는 결정(d-…)에만 씁니다. 업무·질문 종료는 item set --set state=closed --reason …")
            if not SOURCE_RE.match(a.source):
                sys.exit("--source는 사용자 결정이 담긴 메시지 HQ-n 또는 chat:YYYY-MM-DD 입니다")
            reason = a.reason
            data[key].pop(i)
            o.update(status=a.status, resolvedAt=now(), decisionSource=a.source, resolution=reason)
            stamp(o, f"결정 해소({a.status})", reason, by)
            data.setdefault("resolvedDecisions", []).append(o)
        data["updatedAt"], data["updatedBy"] = o["updatedAt"], by
        write_json(DATA, data)
        return item_out(kind, o, refs, hidden, a.icmd == "resolve")


# ---------- 정합성 점검·미완료 요약 (읽기 전용) ----------
# 둘 다 파일을 쓰지 않는다: HQ 번호를 새로 붙이지 않고(assign_refs 없음) PR도 조회하지 않는다.
TASKS = os.environ.get("HQ_TASKS_DIR") or None  # 지정했을 때만 task 문서 첫머리의 '항목:'을 대조한다
STATE_GROUP = {"open": "active", "blocked": "active", "waiting_user": "decide", "done": "done", "closed": "done", "dropped": "done"}
STATE_NAME = {"open": "진행", "blocked": "막힘", "waiting_user": "사용자 대기", "done": "완료", "closed": "종료", "dropped": "취소"}


def legacy_group(status):
    """state 없는 항목의 묶음. 화면 model.ts group()과 같은 규칙이다."""
    return "decide" if re.search("결정|미결정|대기", status) else "done" if re.search("완료|확정|merged|closed|미도입", status, re.I) else "active"


def item_group(o):
    return STATE_GROUP.get(o.get("state")) or legacy_group(o.get("status") or "")


def read_all():
    with read_locked():
        return load_json(DATA), load_state()


def pr_text(prs, n):
    p = prs.get(str(n))
    if not p:
        return f"#{n}(미등록)"
    st = "상태 미확인" if p.get("ok") is not True or not p.get("state") else {"MERGED": "merged", "CLOSED": "closed"}.get(
        p["state"], "open · draft" if p.get("isDraft") else "open · ready")
    return f"#{n}({st})"


def check():
    data, state = read_all()
    m, nxt = (state.get("refs") or {}).get("map") or {}, (state.get("refs") or {}).get("next")
    errors, warnings, legacy = [], [], {}
    add = lambda lst, code, iid, msg: lst.append({"code": code, "id": iid, "ref": m.get(iid), "msg": msg})
    old = lambda code, iid: legacy.setdefault(code, []).append(m.get(iid) or iid)
    resolved = {o["id"]: o for o in data.get("resolvedDecisions") or [] if isinstance(o, dict) and o.get("id")}
    prs, seen = data.get("prs") or {}, {}
    for kind, key in [*((k, v[0]) for k, v in LISTS.items()), ("decision", "resolvedDecisions")]:
        for o in data.get(key) or []:
            iid = o.get("id") if isinstance(o, dict) else None
            if not iid:
                old("id-missing", f"{key}: {label_of(kind, o)[:40] if isinstance(o, dict) else '?'}"); continue
            if iid in seen:
                add(errors, "id-duplicate", iid, f"같은 id가 {seen[iid]}와 {key}에 있습니다")
            seen[iid] = key
            if iid not in m:
                old("ref-missing", iid)  # 다음 화면 조회·migrate-ids 때 부여된다
            for f in REQUIRED[kind]:
                if not (isinstance(o.get(f), str) and o[f].strip()):
                    add(errors, "field-missing", iid, f"필수 필드 {f}가 없습니다")
            if key == "resolvedDecisions":
                if not (o.get("resolvedAt") and o.get("decisionSource")):
                    old("resolution-source-missing", iid)
                continue
            if kind == "decision":
                continue
            st = o.get("state")
            if st is None:
                old("state-missing", iid)
            elif st not in STATES:
                add(errors, "state-invalid", iid, f"정의 밖 state {st!r}")
            if st == "done" and not (o.get(DONE_FIELD[kind]) or "").strip():
                add(errors, "done-without-result", iid, f"state done인데 {DONE_FIELD[kind]}가 비어 있습니다")
            if st in REASON_STATES and not ((o.get("history") or [{}])[-1].get("reason") or "").strip():
                add(warnings, "reason-missing", iid, f"state {st}의 사유가 마지막 history에 없습니다")
            if not o.get("updatedAt"):
                old("updatedAt-missing", iid)
            g, now_st = item_group(o), f"state {st}" if st else f"status '{o.get('status')}'"
            ps = [prs.get(str(n)) for n in o.get("prs") or []]
            if g != "done" and ps and all(p and p.get("ok") is True and p.get("state") in ("MERGED", "CLOSED") for p in ps):
                add(warnings, "open-but-prs-finished", iid, f"연결 PR {', '.join(pr_text(prs, n) for n in o['prs'])}이 모두 끝났는데 {now_st}는 미완료입니다(merged가 곧 업무 종료는 아님)")
            if g == "decide":
                blob = json.dumps(o, ensure_ascii=False)
                hit = [d for d in resolved if d in blob or (m.get(d) and re.search(rf"\b{m[d]}\b", blob))]
                if hit:
                    add(warnings, "waiting-on-resolved-decision", iid, f"이미 해소된 결정 {', '.join(m.get(d) or d for d in hit)}을 언급하는데 {now_st}는 결정 대기입니다")
    by_ref = {}
    for iid, hq in m.items():
        if not (isinstance(hq, str) and REF_RE.match(hq)):
            add(errors, "ref-invalid", iid, f"HQ 번호 형식 오류 {hq!r}"); continue
        if hq.upper() in by_ref:
            add(errors, "ref-duplicate", iid, f"{hq}가 {by_ref[hq.upper()]}에도 붙어 있습니다")
        by_ref[hq.upper()] = iid
    used = max([int(v[3:]) for v in by_ref] or [0])
    if m and not (isinstance(nxt, int) and nxt > used):
        add(errors, "refs-next", None, f"refs.next {nxt}가 사용된 최대 번호 HQ-{used} 이하입니다")
    tasks = TASKS  # task 문서 첫 줄 '항목: HQ-n (내부 id)'. 루트만 보고 archive는 보지 않는다
    for fn in sorted(os.listdir(tasks)) if tasks and os.path.isdir(tasks) else []:
        if fn.endswith(".md"):
            with open(os.path.join(tasks, fn), encoding="utf-8") as f:
                head = "".join(f.readline() for _ in range(5))
            line = re.search(r"^항목:\s*(.+)$", head, re.M)
            for ref in re.findall(r"\b[wqd]-[0-9a-z]{6,}\b|\bHQ-\d+\b", line.group(1) if line else ""):
                if ref not in seen and ref.upper() not in by_ref:
                    add(warnings, "task-unknown-item", None, f"tasks/{fn}의 항목 {ref}가 data·refs에 없습니다")
    return {"observedAt": now(), "errors": errors, "warnings": warnings,
            "legacy": {k: {"count": len(v), "ids": v} for k, v in sorted(legacy.items())},
            "note": "읽기 전용 점검이다. legacy는 기존 데이터의 누락으로, 일괄 변환하지 않고 항목을 다음에 갱신할 때 채운다"}


def scrub(t, n=160):
    """요약문에 로컬 경로·실행 ID·UUID를 싣지 않는다. 메시지 원문은 애초에 읽지 않는다."""
    t = " ".join(str(t or "").split())
    t = re.sub(r"(?:~|/Users|/private|/tmp|/var|file:)\S*", "[경로 생략]", t)
    t = re.sub(r"\b(?:run|task|ctx|term|dcap|msg)_[A-Za-z0-9_-]+", "[실행 ID 생략]", t)
    t = re.sub(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", "[ID 생략]", t)
    return t if len(t) <= n else t[:n - 1] + "…"


def summary(markdown):
    data, state = read_all()
    m, hidden, prs = (state.get("refs") or {}).get("map") or {}, state.get("hidden") or {}, data.get("prs") or {}
    num = lambda iid: (int(m[iid][3:]) if iid in m else 10 ** 9, iid or "")
    rows, legacy_done = [], []
    for kind, name in (("work", "작업"), ("question", "질문")):
        for o in data.get(LISTS[kind][0]) or []:
            if not isinstance(o, dict):
                continue
            g, st = item_group(o), o.get("state")
            if g == "done":
                if not st:  # state 없이 문구로만 완료로 보인 항목. JSON에는 목록, markdown에는 개수만 둔다
                    legacy_done.append({"ref": m.get(o.get("id")), "id": o.get("id"), "kind": name, "title": scrub(label_of(kind, o), 80),
                                        "status": scrub(o.get("status"), 60), "hidden": o.get("id") in hidden})
                continue
            blob = " ".join(str(o.get(k) or "") for k in ("title", "q", "status", "conclusion", "remaining", "answer"))
            rows.append({"group": g, "ref": m.get(o.get("id")), "id": o.get("id"), "kind": name, "title": scrub(label_of(kind, o), 120),
                         "status": scrub(o.get("status"), 80), "state": st, "hidden": o.get("id") in hidden,
                         "prs": [pr_text(prs, n) for n in o.get("prs") or []],
                         "jira": sorted(set(re.findall(rf"\b{JIRA_PROJECT}-\d{{1,7}}\b", blob))) if JIRA_PROJECT else [],
                         "remaining": scrub(o.get("remaining"), 160) if kind == "work" else ""})
    decisions = [{"ref": m.get(o.get("id")), "id": o.get("id"), "title": scrub(o.get("title"), 120), "waiting": scrub(o.get("waiting"), 120),
                  "hidden": o.get("id") in hidden} for o in data.get("pendingDecisions") or [] if isinstance(o, dict)]
    recs = [{"ref": m.get(r.get("id")), "id": r.get("id"), "title": scrub(r.get("title"), 120), "action": scrub(r.get("action"), 160),
             "decision": scrub(r.get("decision"), 160) if r.get("decision") else None, "prs": [pr_text(prs, n) for n in r.get("prs") or []]}
            for r in ((data.get("recommendations") or {}).get("items") or []) if isinstance(r, dict)]
    for xs in (rows, decisions, legacy_done):
        xs.sort(key=lambda x: num(x["id"]))  # 안정 정렬: HQ 번호, 없으면 id
    rows.sort(key=lambda x: x["group"] != "decide")
    out = {"observedAt": now(), "dataUpdatedAt": data.get("updatedAt"), "prsCheckedAt": data.get("prsCheckedAt"),
           "open": rows, "pendingDecisions": decisions, "recommendations": recs, "legacyDoneByStatus": legacy_done}
    if not markdown:
        return out
    tag = lambda x: (f"{x['ref']}" if x["ref"] else f"(번호 없음 {x['id']})")
    hid = lambda x: " · 숨김" if x["hidden"] else ""
    L = ["<!-- 생성물: `python3 server.py summary --markdown`이 진행판 data.json에서 만든다. 직접 편집하지 않는다 -->", "",
         "# 미완료 업무 요약", "",
         f"- 관찰 시각: {out['observedAt']} · data.json 갱신: {out['dataUpdatedAt'] or '없음'} · PR 조회: {out['prsCheckedAt'] or '없음'}",
         "- 기준: state가 있으면 state(open·blocked·waiting_user), 없으면 status 문구(legacy)로 미완료를 고른다. 숨김은 업무 상태와 별개라 숨긴 미완료도 싣고 `숨김`으로 표시한다.",
         "- PR 상태는 마지막 gh 조회 스냅샷이다. merged가 곧 업무 종료는 아니다.", ""]
    def item_line(x):
        st = STATE_NAME.get(x["state"], x["state"]) if x["state"] else "legacy status"
        extra = "".join([f" · PR {', '.join(x['prs'])}" if x["prs"] else "", f" · Jira {', '.join(x['jira'])}" if x["jira"] else "", hid(x)])
        return [f"- {tag(x)} [{x['kind']}] {x['title']} — {x['status']} ({st}){extra}"] + ([f"  - 남은 일: {x['remaining']}"] if x["remaining"] else [])
    L += ["## 사용자 결정 필요", ""]
    dec = [f"- {tag(x)} [결정] {x['title']}" + (f" — 대기: {x['waiting']}" if x["waiting"] else "") + hid(x) for x in decisions]
    dec += [l for x in rows if x["group"] == "decide" for l in item_line(x)]
    L += (dec or ["- 없음"]) + ["", "## 진행 중", ""]
    L += [l for x in rows if x["group"] == "active" for l in item_line(x)] or ["- 없음"]
    L += ["", "## 다음 할 일 추천", ""]
    L += [f"- {tag(r)} {r['title']}" + (f" — {r['action']}" if r["action"] else "") + (f" · 결정 필요: {r['decision']}" if r["decision"] else "")
          + (f" · PR {', '.join(r['prs'])}" if r["prs"] else "") for r in recs] or ["- 없음"]
    # 완료 기록은 기본 요약에서 뺀다. 문구로만 완료로 보인 legacy 항목도 개수만 남기고 목록은 JSON(summary)·check에서 본다
    L += ["", f"state 없이 status 문구로만 완료로 분류돼 위 목록에서 뺀 항목 {len(legacy_done)}건은 `python3 server.py summary`(JSON의 legacyDoneByStatus)와 `check`(legacy state-missing)로 따로 확인한다."]
    return "\n".join(L) + "\n"


EMPTY = {"work": [], "questions": [], "pendingDecisions": [], "resolvedDecisions": [], "prs": {}}
DEMO = os.path.join(HERE, "examples", "demo-data.json")


def init(demo):
    """새 데이터 루트를 만든다. 이미 data.json이 있으면 아무것도 바꾸지 않고 거절한다."""
    if os.path.exists(DATA):
        sys.exit(f"이미 있습니다: {DATA} (덮어쓰지 않습니다)")
    data = load_json(DEMO) if demo else {**EMPTY, "updatedAt": now(), "updatedBy": "init"}
    os.makedirs(PUBLIC, exist_ok=True)
    write_json(DATA, data)
    print(json.dumps({"root": ROOT, "demo": demo, **migrate_ids()}, ensure_ascii=False, indent=2))


def reject(rid, reason):
    with locked():
        state = load_state()
        for r in state["requests"]:
            if r["requestId"] == rid and r["status"] == "pending":
                r.update(status="failed", processedAt=now(), error=f"거절: {reason}")
                write_json(STATE, state)
                return r
    sys.exit(f"pending 요청 {rid} 없음")


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve"); s.add_argument("--host", default="127.0.0.1"); s.add_argument("--port", type=int, default=48173)
    s.add_argument("--alias", nargs="*", default=[], help="같은 서버를 가리키는 추가 hostname(Origin 허용, 예: localhost)")
    sub.add_parser("init", help="데이터 루트에 빈 data.json(--demo면 합성 예시)을 만든다").add_argument("--demo", action="store_true")
    sub.add_parser("migrate-ids")
    s = sub.add_parser("list"); s.add_argument("--all", action="store_true")
    s = sub.add_parser("process-inbox"); s.add_argument("--request", nargs="*")
    s = sub.add_parser("reject"); s.add_argument("--request", required=True); s.add_argument("--reason", required=True)
    s = sub.add_parser("submit"); s.add_argument("file")
    s = sub.add_parser("import-jira"); s.add_argument("file")
    s = sub.add_parser("lookup"); s.add_argument("keys", nargs="+", help="HQ-12 또는 내부 id")
    s = sub.add_parser("msg", help="항목별 메시지(결정 답변·후속 질문)와 자유 메시지(general). 삭제 요청함과 별개다")
    ms = s.add_subparsers(dest="mcmd", required=True)
    m = ms.add_parser("list"); m.add_argument("--all", action="store_true"); m.add_argument("--item", help="HQ-12 또는 내부 id")
    ms.add_parser("read").add_argument("id")
    m = ms.add_parser("respond"); m.add_argument("id"); g = m.add_mutually_exclusive_group(required=True)
    g.add_argument("--text"); g.add_argument("--file", help="파일 경로 또는 -(stdin)")
    m = ms.add_parser("process"); m.add_argument("id"); m.add_argument("--note")
    m = ms.add_parser("link", help="메시지를 작업·질문·PR·결정에 분류 연결"); m.add_argument("id"); m.add_argument("--item", required=True, help="HQ-12 또는 내부 id")
    m.add_argument("--note")
    m = ms.add_parser("unlink"); m.add_argument("id"); m.add_argument("--note")
    s = sub.add_parser("flush", help="'지금 확인 요청' 대상 coordinator thread 등록과 요청 기록")
    fs = s.add_subparsers(dest="fcmd", required=True)
    f = fs.add_parser("register"); f.add_argument("--provider", choices=["codex"], required=True)
    f.add_argument("--thread", required=True, help="Codex session UUID"); f.add_argument("--evidence", required=True, help="이 대화의 thread라고 확인한 근거")
    fs.add_parser("unregister"); fs.add_parser("status")
    f = fs.add_parser("done"); f.add_argument("--id", required=True); f.add_argument("--note")
    s = sub.add_parser("item", help="업무·질문·결정 항목 추가·조회·수정·결정 해소(data.json의 유일한 쓰기 경로)")
    its = s.add_subparsers(dest="icmd", required=True)
    i = its.add_parser("add"); i.add_argument("kind", choices=list(LISTS))
    its.add_parser("get").add_argument("id", help="HQ-12 또는 내부 id")
    j = its.add_parser("set"); j.add_argument("id", help="HQ-12 또는 내부 id")
    for x in (i, j):
        x.add_argument("--file", help="필드 JSON object 파일 또는 -(stdin). 긴 내용은 이것으로 넘긴다")
        x.add_argument("--set", action="append", metavar="KEY=VALUE", help="짧은 문자열 필드(여러 번 가능)")
        x.add_argument("--reason", help="이력 사유. state blocked·closed·dropped에는 필수")
    j.add_argument("--expect-rev", type=int, help="현재 rev가 이 값일 때만 쓴다(CAS)")
    r = its.add_parser("resolve", help="대기 결정을 사용자 결정으로 해소(pendingDecisions → resolvedDecisions)"); r.add_argument("id")
    r.add_argument("--source", required=True, help="사용자 결정 출처: 메시지 HQ-n 또는 chat:YYYY-MM-DD")
    r.add_argument("--reason", required=True, help="결정 내용과 근거"); r.add_argument("--status", default="확정")
    r.add_argument("--expect-rev", type=int)
    for x in (i, j, r):
        x.add_argument("--by", help="갱신 주체(기본 HQ coordinator)")
    sub.add_parser("backup", help="data·state·messages·flush 일관 스냅샷(manifest 포함)을 backups/에 만든다")
    s = sub.add_parser("restore", help="dry-run: 백업 무결성 검증 후 현재 파일과 병합한 결과를 별도 출력 루트에만 만든다")
    s.add_argument("--backup", required=True, help="backups/<이름> 디렉터리"); s.add_argument("--out", required=True, help="비어 있는 출력 루트(운영 루트 밖)")
    sub.add_parser("check", help="읽기 전용 정합성 점검(쓰기·번호 부여·PR 조회 없음)")
    sub.add_parser("summary", help="미완료 업무 요약(읽기 전용)").add_argument("--markdown", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "init":
        return init(a.demo)
    if a.cmd not in ("restore",) and not os.path.isfile(DATA):  # 없는 루트를 조용히 만들지 않는다
        sys.exit(f"데이터가 없습니다: {DATA}\n먼저 `python3 server.py init`(빈 상태) 또는 `init --demo`(합성 예시)를 실행하세요")
    if a.cmd == "serve":
        return serve(a.host, a.port, a.alias)
    if a.cmd == "migrate-ids":
        out = migrate_ids()
    elif a.cmd == "list":
        with locked():
            st = load_state()
        out = {"requests": [r for r in st["requests"] if a.all or r["status"] == "pending"], "hiddenTotal": len(st["hidden"])}
    elif a.cmd == "process-inbox":
        out = process_inbox(set(a.request) if a.request else None)
    elif a.cmd == "lookup":
        out = lookup(a.keys)
    elif a.cmd == "msg":
        out = msg_cli(a)
    elif a.cmd == "flush":
        out = flush_cli(a)
    elif a.cmd == "item":
        out = item_cli(a)
    elif a.cmd == "backup":
        with locked():
            out = make_backup("manual")
    elif a.cmd == "restore":
        out = restore_check(a.backup, a.out)
    elif a.cmd == "check":
        out = check()
    elif a.cmd == "summary":
        out = summary(a.markdown)
        if a.markdown:
            return sys.stdout.write(out)
    elif a.cmd == "import-jira":
        out = import_jira(a.file)
    elif a.cmd == "submit":
        raw = sys.stdin.buffer.read() if a.file == "-" else open(a.file, "rb").read()
        if len(raw) > MAX_BODY:
            sys.exit(f"본문이 {MAX_BODY} byte를 넘습니다. 항목을 나눠 내보내세요")
        try:
            req, dup = accept_request(json.loads(raw.decode("utf-8")))  # HTTP와 같은 검증, 같은 requestId는 기존 기록 반환
        except BadRequest as e:
            sys.exit(f"거절: {e}")
        out = {"request": req, "duplicate": dup}
    else:
        out = reject(a.request, a.reason)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    if a.cmd == "check" and out["errors"]:
        sys.exit(1)  # 정합성 error는 스크립트가 놓치지 않게 nonzero. warnings·legacy만이면 0


if __name__ == "__main__":
    main()
