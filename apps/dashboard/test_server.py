#!/usr/bin/env python3
"""격리된 임시 루트와 임시 포트에서 server.py의 요청함 흐름과 PR 자동 조회를 검증한다. 실제 data.json은 건드리지 않는다.
gh는 PATH 앞의 가짜 스크립트로 바꿔서 실제 GitHub을 조회하거나 바꾸지 않는다.

  python3 test_server.py
"""
import hashlib, json, os, secrets, shutil, socket, subprocess, sys, tempfile, threading, time, unittest
import urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = {
    "updatedAt": "2026-01-16T11:00:00+09:00", "updatedBy": "test",
    "work": [{"title": "합성 작업 A", "status": "진행 중", "conclusion": "c", "verification": "v", "remaining": "r", "prs": [1]},
             {"title": "합성 작업 B", "status": "완료", "conclusion": "c", "verification": "v", "remaining": "r", "prs": []}],
    "questions": [{"q": "합성 질문?", "answer": "a", "status": "확정 답변", "updatedAt": "2026-01-16T11:00:00+09:00"}],
    "pendingDecisions": [{"title": "합성 결정", "detail": "d", "waiting": "w"}],
    "globalLimits": ["합성 한계 1", "합성 한계 2"],
    "prs": {"1": {"number": 1, "title": "합성 PR", "state": "OPEN", "isDraft": True, "url": "https://example.com/1", "ok": True}},
}


# 가짜 gh: <root>/gh-plan.json의 {번호: 상태|"fail"}대로 응답하고, 호출마다 <root>/gh-calls에 번호를 남긴다
FAKE_GH = """#!%s
import json, os, sys, time
root = os.environ["HQ_DASH_ROOT"]; n = sys.argv[3]
assert sys.argv[1:3] == ["pr", "view"] and "--json" in sys.argv, sys.argv
open(os.path.join(root, "gh-calls"), "a").write(n + "\\n")
time.sleep(float(os.environ.get("FAKE_GH_SLEEP", "0")))
st = json.load(open(os.path.join(root, "gh-plan.json"))).get(n, "fail")
if st == "fail": sys.exit(1)
print(json.dumps({"number": int(n), "title": "합성 PR " + n, "state": st, "isDraft": False,
                  "url": "https://example.com/" + n, "updatedAt": "2026-01-16T00:00:00Z", "mergedAt": None}))
""" % sys.executable

# 가짜 codex: `codex queue --thread T --message M`만 받는다. 호출 argv를 <root>/codex-calls에 남기고,
# <root>/codex-plan(없으면 ok)이 ok면 실제 CLI와 같은 문구를 출력하고, 아니면 그 내용을 오류로 내고 실패한다
FAKE_CODEX = """#!%s
import json, os, sys, uuid
root = os.environ["HQ_DASH_ROOT"]
open(os.path.join(root, "codex-calls"), "a").write(json.dumps(sys.argv[1:]) + "\\n")
plan = open(os.path.join(root, "codex-plan")).read().strip() if os.path.exists(os.path.join(root, "codex-plan")) else "ok"
if plan != "ok":
    sys.stderr.write("Error: failed to queue session message: " + plan + "\\n"); sys.exit(1)
print("Queued message %%s for thread %%s." %% (uuid.uuid4(), sys.argv[3]))
""" % sys.executable
THREAD = "00000000-0000-4000-8000-000000000001"  # 합성 UUID


ALIAS = "dash.example.ts.net"  # 합성 tailnet hostname


def rd(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def slurp(p):
    with open(p, "rb") as f:
        return f.read()


def wr(p, obj):
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close()
    return p


class T(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="hqdash-test-")
        os.makedirs(os.path.join(self.root, "public"))  # 데이터 루트에는 data.json만 둔다. 정적 파일은 코드 위치에서 서빙된다
        self.data = os.path.join(self.root, "public", "data.json")
        # 방금 조회한 것으로 두어 자동 조회를 다루지 않는 테스트에서는 refresh가 돌지 않게 한다
        wr(self.data, {**FIXTURE, "prsCheckedAt": time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.gmtime(time.time() + 9 * 3600))})
        bindir = os.path.join(self.root, "bin"); os.makedirs(bindir)
        with open(os.path.join(bindir, "gh"), "w") as f:
            f.write(FAKE_GH)
        os.chmod(os.path.join(bindir, "gh"), 0o755)
        with open(os.path.join(bindir, "codex"), "w") as f:
            f.write(FAKE_CODEX)
        os.chmod(os.path.join(bindir, "codex"), 0o755)
        self.codex_home = os.path.join(self.root, "codex-home"); os.makedirs(self.codex_home)
        with open(os.path.join(self.codex_home, "session_index.jsonl"), "w") as f:
            f.write(json.dumps({"id": THREAD, "thread_name": "합성 coordinator"}) + "\n")
        wr(os.path.join(self.root, "gh-plan.json"), {})
        self.env = {**os.environ, "HQ_DASH_ROOT": self.root, "PATH": bindir + os.pathsep + os.environ["PATH"], "CODEX_HOME": self.codex_home,
                    "HQ_TASKS_DIR": os.path.join(self.root, "tasks"),
                    # 외부 연동은 기본 꺼짐이다. 테스트는 가짜 gh·codex와 합성 값으로만 켠다
                    "HQ_GITHUB_REPO": "example/repo", "HQ_JIRA_PROJECT": "DEMO", "HQ_ENABLE_CODEX_FLUSH": "1"}
        self.cli("migrate-ids")
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.start()

    def start(self):
        self.proc = subprocess.Popen([sys.executable, os.path.join(HERE, "server.py"), "serve", "--host", "127.0.0.1", "--port", str(self.port),
                                      "--alias", ALIAS],
                                     env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(self.base + "/", timeout=1); return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("server did not start")

    def stop(self):
        self.proc.terminate(); self.proc.wait(5)

    def tearDown(self):
        self.stop(); shutil.rmtree(self.root)

    def cli(self, *args):
        out = subprocess.run([sys.executable, os.path.join(HERE, "server.py"), *args], env=self.env, capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    def get(self, path):
        with urllib.request.urlopen(self.base + path) as r:
            return r.status, json.loads(r.read()) if path.startswith("/api") else r.read()

    def post(self, body, origin=None, ctype="application/json", raw=None, path="/api/requests", site=None):
        data = raw if raw is not None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method="POST",
                                     headers={"Content-Type": ctype, "Origin": origin or self.base, **({"Sec-Fetch-Site": site} if site else {})})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def ids(self):
        d = rd(self.data)
        return {"work": [w["id"] for w in d["work"]], "question": d["questions"][0]["id"], "decision": d["pendingDecisions"][0]["id"]}

    def req(self, *items):
        return {"requestId": secrets.token_hex(16), "action": "hide_from_dashboard", "items": [{"kind": k, "id": i} for k, i in items]}

    def test_full_flow_hidden_persists(self):
        ids = self.ids()
        b = self.req(("work", ids["work"][0]), ("pr", "pr-1"), ("decision", ids["decision"]))
        code, r = self.post(b)
        self.assertEqual(code, 201)
        self.assertEqual(r["request"]["status"], "pending")
        self.assertEqual(r["request"]["items"][0]["label"], "합성 작업 A")  # label은 서버 원본 기준
        # 처리 전에는 숨기지 않는다 (서버는 보관만)
        _, d = self.get("/api/dashboard")
        self.assertEqual(len(d["data"]["work"]), 2)
        self.assertEqual(self.cli("list")["requests"][0]["requestId"], b["requestId"])
        out = self.cli("process-inbox")
        self.assertEqual(out["processed"][0]["status"], "done")
        _, d = self.get("/api/dashboard")
        self.assertEqual([w["title"] for w in d["data"]["work"]], ["합성 작업 B"])
        self.assertEqual(d["data"]["prs"], {})
        self.assertEqual(d["data"]["pendingDecisions"], [])
        # 원본 data.json은 보존된다
        raw = rd(self.data)
        self.assertEqual(len(raw["work"]), 2); self.assertEqual(len(raw["pendingDecisions"]), 1); self.assertIn("1", raw["prs"])
        # coordinator가 data.json을 고쳐 써도(제목 수정, PR 재조회) 숨김이 되살아나지 않는다
        raw["work"][0]["title"] = "제목 바뀜"
        raw["prs"]["1"] = {"number": 1, "title": "재조회", "state": "MERGED", "ok": True}
        wr(self.data, raw)
        self.cli("migrate-ids")
        self.stop(); self.start()  # 서버 재시작
        _, d = self.get("/api/dashboard")
        self.assertEqual([w["title"] for w in d["data"]["work"]], ["합성 작업 B"])
        self.assertEqual(d["data"]["prs"], {})
        self.assertEqual(d["requests"][0]["status"], "done")
        # 다시 처리해도 결과 동일 (idempotent)
        self.assertEqual(self.cli("process-inbox")["processed"], [])

    def test_duplicate_request_is_idempotent(self):
        b = self.req(("question", self.ids()["question"]))
        self.assertEqual(self.post(b)[0], 201)
        code, r = self.post(b)
        self.assertEqual((code, r["duplicate"]), (200, True))
        self.assertEqual(len(self.cli("list")["requests"]), 1)

    def test_concurrent_posts_all_saved(self):
        ids = self.ids()
        bodies = [self.req(("work", ids["work"][i % 2])) for i in range(20)]
        res = []
        ts = [threading.Thread(target=lambda b=b: res.append(self.post(b)[0])) for b in bodies]
        [t.start() for t in ts]; [t.join() for t in ts]
        self.assertEqual(res.count(201), 20)
        self.assertEqual(len(self.cli("list")["requests"]), 20)

    def test_rejections(self):
        ids = self.ids()
        self.assertEqual(self.post(self.req(("work", "w-deadbeef")))[0], 400)            # 없는 id
        self.assertEqual(self.post(self.req(("question", ids["work"][0])))[0], 400)       # 종류 불일치
        self.assertEqual(self.post(self.req(("work", "../../etc")))[0], 400)
        self.assertEqual(self.post({**self.req(("work", ids["work"][0])), "action": "run_shell"})[0], 400)
        self.assertEqual(self.post(self.req(("work", ids["work"][0])), origin="http://evil.example")[0], 403)
        self.assertEqual(self.post(self.req(("work", ids["work"][0])), ctype="text/plain")[0], 415)
        self.assertEqual(self.post(None, raw=b"x" * 20000)[0], 413)
        self.assertEqual(self.post(None, raw=b"{not json")[0], 400)
        self.assertEqual(self.post({"requestId": "abc", "action": "hide_from_dashboard", "items": []})[0], 400)
        self.assertEqual(self.cli("list")["requests"], [])

    def test_origin_allowlist(self):
        w = self.ids()["work"]
        host = ALIAS  # serve --alias
        self.assertEqual(self.post(self.req(("work", w[0])))[0], 201)                                 # IP origin
        self.assertEqual(self.post(self.req(("work", w[1])), origin=f"http://{host}:{self.port}")[0], 201)  # tailnet hostname
        for bad in (f"https://{host}:{self.port}", f"http://{host}:{self.port + 1}", f"http://{host}",
                    f"http://evil.{host}:{self.port}", f"http://localhost:{self.port}", "null"):
            self.assertEqual(self.post(self.req(("work", w[0])), origin=bad)[0], 403, bad)
        # Host 헤더를 위조해도 Origin은 고정 allowlist와 비교한다
        req = urllib.request.Request(self.base + "/api/requests", data=json.dumps(self.req(("work", w[0]))).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Host": f"evil.example:{self.port}", "Origin": f"http://evil.example:{self.port}"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        self.assertEqual(e.exception.code, 403)
        # 다른 사이트에서 온 요청은 Origin이 맞아도 거부
        req = urllib.request.Request(self.base + "/api/requests", data=json.dumps(self.req(("work", w[0]))).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Origin": self.base, "Sec-Fetch-Site": "cross-site"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        self.assertEqual(e.exception.code, 403)

    def test_unknown_at_process_time_fails_not_hides(self):
        ids = self.ids()
        b = self.req(("work", ids["work"][0]))
        self.post(b)
        raw = rd(self.data); raw["work"].pop(0); wr(self.data, raw)
        out = self.cli("process-inbox")
        self.assertEqual(out["processed"][0]["status"], "failed")
        self.assertEqual(out["hiddenTotal"], 0)

    def test_reject_cli(self):
        b = self.req(("work", self.ids()["work"][1]))
        self.post(b)
        self.assertEqual(self.cli("reject", "--request", b["requestId"], "--reason", "test")["status"], "failed")
        self.assertEqual(self.cli("process-inbox")["processed"], [])

    def test_export_payload_submit(self):
        # 진행판 JSON 내보내기와 같은 모양(추가 메타 포함)을 HTTP와 CLI submit 양쪽이 받는다
        ids = self.ids()
        exp = {"schemaVersion": 1, "requestId": secrets.token_hex(16), "createdAt": "2026-01-16T02:00:00.000Z",
               "action": "hide_from_dashboard", "hide_from_dashboard": True, "intent": "표시만 숨김", "source": "Agent HQ 진행판",
               "snapshotUpdatedAt": "2026-01-16T11:00:00+09:00",
               "items": [{"kind": "work", "id": ids["work"][0], "label": "조작된 라벨", "status": "진행 중"}]}
        f = os.path.join(self.root, "exp.json"); wr(f, exp)
        out = self.cli("submit", f)
        self.assertEqual((out["duplicate"], out["request"]["status"]), (False, "pending"))
        self.assertEqual(out["request"]["items"][0]["label"], "합성 작업 A")
        self.assertEqual(self.cli("submit", f)["duplicate"], True)          # 같은 requestId 재접수 no-op
        self.assertEqual(self.post(exp), (200, {"request": out["request"], "duplicate": True}))  # HTTP 재전송도 동일
        bad = subprocess.run([sys.executable, os.path.join(HERE, "server.py"), "submit", "-"], env=self.env,
                             input=json.dumps({**exp, "requestId": secrets.token_hex(16), "items": [{"kind": "work", "id": "w-deadbeef"}]}),
                             capture_output=True, text=True)
        self.assertNotEqual(bad.returncode, 0)
        self.assertEqual(len(self.cli("list")["requests"]), 1)
        _, d = self.get("/api/dashboard")
        self.assertEqual(len(d["data"]["work"]), 2)  # 접수만 했고 숨기지 않았다

    def test_defaults_isolated_and_opt_in(self):
        # 기본값: init 전에는 루트를 만들지 않고, 외부 연동(PR·Jira·Codex)은 설정 없이는 실행하지 않는다
        tmp = tempfile.mkdtemp(prefix="hqdash-init-")
        env = {k: v for k, v in self.env.items() if k not in ("HQ_GITHUB_REPO", "HQ_JIRA_PROJECT", "HQ_ENABLE_CODEX_FLUSH", "HQ_TASKS_DIR")}
        env["HQ_DASH_ROOT"] = root = os.path.join(tmp, "r")
        run = lambda *a, script="server.py": subprocess.run([sys.executable, os.path.join(HERE, script), *a], env=env, capture_output=True, text=True)
        try:
            self.assertNotEqual(run("summary").returncode, 0)
            self.assertFalse(os.path.exists(root))
            self.assertEqual(run("init").returncode, 0)
            self.assertNotEqual(run("init", "--demo").returncode, 0)  # 덮어쓰지 않는다
            self.assertEqual(rd(os.path.join(root, "public", "data.json"))["work"], [])
            snap = os.path.join(tmp, "jira.json"); wr(snap, {"isLast": True, "site": "https://x.atlassian.net", "issues": []})
            self.assertIn("HQ_JIRA_PROJECT", run("import-jira", snap).stderr)
            self.assertIn("HQ_ENABLE_CODEX_FLUSH", run("flush", "register", "--provider", "codex", "--thread", THREAD, "--evidence", "e").stderr)
            self.assertIn("HQ_GITHUB_REPO", run(script="refresh_prs.py").stderr)
            self.assertFalse(os.path.exists(os.path.join(root, "gh-calls")))
            env["HQ_DASH_ROOT"] = demo = os.path.join(tmp, "demo")
            self.assertEqual(run("init", "--demo").returncode, 0)
            self.assertTrue(rd(os.path.join(demo, "public", "data.json"))["work"])
            self.assertEqual(run("check").returncode, 0)
        finally:
            shutil.rmtree(tmp)

    def test_static_allowlist(self):
        self.assertEqual(self.get("/")[0], 200)
        for p in ("/app.css", "/data.json", "/private/state.json", "/server.py", "/..%2fserver.py", "/public/index.html",
                  "/public/app.css", "/src/app.css", "/package.json", "/node_modules/daisyui/package.json", "/app.css/", "/APP.css"):
            with self.assertRaises(urllib.error.HTTPError) as c:
                urllib.request.urlopen(self.base + p)
            self.assertEqual(c.exception.code, 404, p)

    # ---------- merged PR 자동 숨김 ----------

    def set_prs(self, prs, checked_at):
        raw = rd(self.data); raw["prs"] = prs; raw["prsCheckedAt"] = checked_at; wr(self.data, raw)

    def gh_calls(self):
        try:
            with open(os.path.join(self.root, "gh-calls")) as f:
                return f.read().split()
        except FileNotFoundError:
            return []

    def wait_refresh(self):
        for _ in range(100):
            _, d = self.get("/api/dashboard")
            if not d["prRefresh"]["running"]:
                return d
            time.sleep(0.1)
        raise RuntimeError("refresh did not finish")

    def kst_now(self):
        return time.strftime("%Y-%m-%dT%H:%M:%S+09:00", time.gmtime(time.time() + 9 * 3600))

    def test_only_fresh_known_merged_hidden(self):
        st = os.path.join(self.root, "private", "state.json")
        b = self.req(("work", self.ids()["work"][1])); self.post(b); self.cli("process-inbox")
        before = {k: v for k, v in rd(st).items() if k != "refs"}  # 새 PR의 HQ 번호 부여(refs)만 허용
        self.set_prs({"1": {"number": 1, "state": "OPEN", "ok": True}, "2": {"number": 2, "state": "MERGED", "ok": True, "url": "https://example.com/2"},
                      "3": {"number": 3, "state": "CLOSED", "ok": True}, "4": {"number": 4, "state": "MERGED", "ok": False},
                      "5": {"number": 5, "ok": False}}, self.kst_now())
        _, d = self.get("/api/dashboard")
        self.assertEqual(sorted(d["data"]["prs"]), ["1", "3", "4", "5"])   # 실패·미확인은 MERGED로 추정하지 않는다
        self.assertEqual(list(d["data"]["mergedPrs"]), ["2"])
        self.assertEqual(d["data"]["mergedPrs"]["2"]["id"], "pr-2")
        self.assertEqual(d["hiddenCount"], 1)                                # 사용자 overlay와 별개
        self.assertIn("2", rd(self.data)["prs"])                             # 원본 보존
        self.assertEqual({k: v for k, v in rd(st).items() if k != "refs"}, before)  # 숨김 overlay·요청함에 쓰지 않는다
        self.assertEqual(self.gh_calls(), [])                                # 방금 조회했으면 다시 조회하지 않는다

    def test_auto_refresh_once_then_cooldown(self):
        self.set_prs({"1": {"number": 1, "title": "옛 제목", "state": "OPEN", "ok": True}, "2": {"number": 2, "state": "OPEN", "ok": True},
                      "3": {"number": 3, "state": "CLOSED", "ok": True}}, "2026-01-16T00:00:00+09:00")
        wr(os.path.join(self.root, "gh-plan.json"), {"1": "MERGED", "2": "OPEN"})  # 3은 조회 실패
        self.stop(); self.env["FAKE_GH_SLEEP"] = "0.2"; self.start()
        ts = [threading.Thread(target=self.get, args=("/api/dashboard",)) for _ in range(8)]
        t0 = time.time(); [t.start() for t in ts]; [t.join() for t in ts]
        self.assertLess(time.time() - t0, 0.5)                               # GET은 gh 조회를 기다리지 않는다
        d = self.wait_refresh()
        self.assertTrue(d["prRefresh"]["ok"])
        self.assertEqual(sorted(self.gh_calls()), ["1", "2", "3"])           # 동시 요청에도 1회만
        self.assertEqual(sorted(d["data"]["prs"]), ["2", "3"])
        self.assertEqual(d["data"]["prs"]["2"]["id"], "pr-2")
        self.assertEqual((d["data"]["prs"]["3"]["state"], d["data"]["prs"]["3"]["ok"]), ("CLOSED", False))
        self.assertEqual(sorted(rd(self.data)["prs"]), ["1", "2", "3"])      # 원본 PR 기록 보존, 새 PR 생성 없음
        self.get("/api/dashboard"); time.sleep(0.5)
        self.assertEqual(len(self.gh_calls()), 3)                            # 5분 쿨다운

    def test_failed_refresh_keeps_last_state_and_no_retry(self):
        self.set_prs({"1": {"number": 1, "state": "MERGED", "ok": False}, "2": {"number": 2, "state": "OPEN", "ok": True}},
                     "2026-01-16T00:00:00+09:00")
        d = self.wait_refresh()                                              # plan이 비어 있어 전부 실패
        self.assertEqual(sorted(d["data"]["prs"]), ["1", "2"])
        self.assertTrue(all(p["ok"] is False for p in d["data"]["prs"].values()))
        self.assertEqual(d["data"]["prs"]["2"]["state"], "OPEN")
        n = len(self.gh_calls()); self.get("/api/dashboard"); time.sleep(0.3)
        self.assertEqual(len(self.gh_calls()), n)                            # 실패 후에도 재시도 억제

    def test_refresh_cli_targets_current_data_prs(self):
        self.set_prs({"7": {"number": 7, "state": "OPEN", "ok": True}, "12": {"number": 12, "state": "OPEN", "ok": True}}, self.kst_now())
        wr(os.path.join(self.root, "gh-plan.json"), {"7": "OPEN", "12": "MERGED"})
        subprocess.run([sys.executable, os.path.join(HERE, "refresh_prs.py")], env=self.env, check=True, capture_output=True)
        self.assertEqual(sorted(self.gh_calls()), ["12", "7"])               # 고정 목록이 아니라 data.prs
        self.assertEqual(rd(self.data)["prs"]["12"]["state"], "MERGED")

    def test_import_jira_minimal_and_keeps_rest(self):
        before = rd(self.data)
        src = os.path.join(self.root, "jira.json")
        sp = lambda i, st, start, end: {"id": i, "name": f"S{i}", "state": st, "startDate": start, "endDate": end, "goal": "g", "boardId": 9}
        good = {"observedAt": "2026-01-16 04:49:52 UTC", "site": "https://x.atlassian.net", "scope": "s", "isLast": True, "sprintField": "customfield_10001",
                "issues": [{"key": "DEMO-1", "summary": "<b>t</b>", "status": "READY", "priority": "High", "due": None, "project": "DEMO",
                            "updated": "u", "accountId": "secret", "sprints": [sp(1, "closed", "2026-01", "2026-02"), sp(2, "active", "2026-10", "2026-11")]},
                           {"key": "DEMO-2", "summary": "f", "status": "READY", "priority": None, "project": "DEMO",
                            "sprints": [sp(1, "closed", "2026-01", "2026-02"), sp(3, "future", None, None)]},
                           {"key": "DEMO-3", "summary": "c", "status": "READY", "priority": None, "project": "DEMO",
                            "sprints": [sp(1, "closed", "2026-01", "2026-02"), sp(4, "closed", "2026-03", "2026-04")]},
                           {"key": "DEMO-4", "summary": "n", "status": "READY", "priority": None, "project": "DEMO", "sprints": []}]}
        wr(src, good)
        self.assertEqual(self.cli("import-jira", src)["observedAt"], "2026-01-16T13:49:52+09:00")
        after = rd(self.data)
        j = after["jira"]
        self.assertEqual(j["issues"][0], {"key": "DEMO-1", "summary": "<b>t</b>", "status": "READY", "priority": "High", "project": "DEMO", "sprint": 2, "sprintIds": [1, 2]})
        self.assertEqual([i["sprint"] for i in j["issues"]], [2, 3, 4, None])   # active > future > 최근 closed, 빈 목록만 없음
        self.assertEqual(j["sprints"]["2"], {"name": "S2", "state": "active", "startDate": "2026-10", "endDate": "2026-11"})  # goal·boardId 제외
        self.assertNotIn("secret", json.dumps(j))
        self.assertEqual({k: v for k, v in after.items() if k != "jira"}, before)  # 다른 키·id는 그대로
        self.assertEqual(self.get("/api/dashboard")[1]["data"]["jira"]["dueSetCount"], 0)
        run = lambda: subprocess.run([sys.executable, os.path.join(HERE, "server.py"), "import-jira", src], env=self.env, capture_output=True).returncode
        bad = [{**good, "isLast": False}, {k: v for k, v in good.items() if k != "sprintField"},
               {**good, "issues": good["issues"] + [{"key": "TN-1", "summary": "x", "project": "TN", "sprints": []}]},
               {**good, "issues": [{k: v for k, v in good["issues"][0].items() if k != "sprints"}]}]  # 미조회를 Sprint 없음으로 받지 않음
        for b in bad:
            wr(src, b)
            self.assertNotEqual(run(), 0)
        self.assertEqual(rd(self.data), after)                                  # 거절 시 기존 jira 유지

    def test_import_jira_description_preview(self):
        src = os.path.join(self.root, "jira.json")
        base = {"key": "DEMO-1", "summary": "s", "status": "READY", "priority": None, "project": "DEMO", "sprints": []}
        good = {"observedAt": "2026-01-16T15:38:30+09:00", "site": "https://x.atlassian.net", "isLast": True, "sprintField": "customfield_10001",
                "descriptionFetched": True, "issues": [{**base, "descriptionState": "text", "description": "<img src=x>" + "a" * 500},
                                                       {**base, "key": "DEMO-2", "descriptionState": "none", "description": "leak"}]}
        wr(src, good); self.cli("import-jira", src)
        j = rd(self.data)["jira"]
        self.assertTrue(j["descriptionFetched"])
        self.assertEqual(len(j["issues"][0]["description"]), 400)                # 최소 길이로 자름(원문 그대로, 렌더링은 textContent)
        self.assertTrue(j["issues"][0]["descriptionTruncated"])
        self.assertEqual((j["issues"][1]["descriptionState"], j["issues"][1]["description"]), ("none", ""))
        wr(src, {**good, "issues": [{**base, "descriptionState": "bogus"}]})
        self.assertNotEqual(subprocess.run([sys.executable, os.path.join(HERE, "server.py"), "import-jira", src], env=self.env, capture_output=True).returncode, 0)
        wr(src, {k: v for k, v in good.items() if k != "descriptionFetched"}); self.cli("import-jira", src)
        self.assertNotIn("descriptionState", rd(self.data)["jira"]["issues"][0])  # 미조회 스냅샷은 설명 필드를 두지 않음

    def test_import_jira_subtask_parent(self):
        src = os.path.join(self.root, "jira.json")
        base = {"summary": "s", "status": "READY", "priority": None, "project": "DEMO", "sprints": []}
        good = {"observedAt": "2026-01-21T10:00:00+09:00", "site": "https://x.atlassian.net", "isLast": True, "sprintField": "customfield_10001",
                "issues": [{**base, "key": "DEMO-1", "issueType": "Story", "isSubtask": False, "parentKey": "DEMO-900"},   # epic parent는 버림
                           {**base, "key": "DEMO-2", "issueType": "하위 작업", "isSubtask": True, "parentKey": "DEMO-777"},  # 부모는 조회 범위 밖
                           {**base, "key": "DEMO-3", "issueType": "Sub-task", "parentKey": "DEMO-1"},  # isSubtask 누락 = legacy 미확인
                           {**base, "key": "DEMO-4", "issueType": "Subtask", "isSubtask": True}]}  # 부모 key 누락
        wr(src, good); self.assertEqual(self.cli("import-jira", src)["issues"], 4)  # 부모를 목록에 끼워 넣지 않음
        a, b, c, d = rd(self.data)["jira"]["issues"]
        self.assertEqual((a["isSubtask"], a["issueType"], "parentKey" in a), (False, "Story", False))
        self.assertEqual((b["isSubtask"], b["parentKey"]), (True, "DEMO-777"))
        self.assertFalse({"isSubtask", "issueType", "parentKey"} & c.keys())    # 이름·parent만으로 서브태스크로 추측하지 않음
        self.assertEqual((d["isSubtask"], "parentKey" in d), (True, False))
        after = rd(self.data)
        run = lambda: subprocess.run([sys.executable, os.path.join(HERE, "server.py"), "import-jira", src], env=self.env, capture_output=True).returncode
        for bad in [{"isSubtask": "true"}, {"isSubtask": True, "parentKey": "demo-1"}, {"isSubtask": True, "parentKey": 7}, {"isSubtask": False, "issueType": 3}]:
            wr(src, {**good, "issues": [{**base, "key": "DEMO-9", **bad}]})
            self.assertNotEqual(run(), 0)
        self.assertEqual(rd(self.data), after)

    def test_limits_section_hide_flow(self):
        lid = rd(self.data)["globalLimitsId"]
        self.assertRegex(lid, r"^g-[0-9a-f]{8}$")
        for bad in [("work", lid), ("limits", "g-00000000"), ("limits", "limits")]:  # 종류 불일치·없는 id·형식 오류
            self.assertEqual(self.post(self.req(bad))[0], 400)
        code, r = self.post(self.req(("limits", lid), ("limits", lid)))
        self.assertEqual(code, 201)
        self.assertEqual(r["request"]["items"], [{"kind": "limits", "id": lid, "label": "공통 검증 한계 2건"}])  # 중복 제거, 서버 label
        self.assertEqual(len(self.get("/api/dashboard")[1]["data"]["globalLimits"]), 2)  # 처리 전에는 보임
        self.assertEqual(self.cli("process-inbox")["processed"][0]["status"], "done")
        raw = rd(self.data); raw["globalLimits"].append("새 한계"); wr(self.data, raw)  # 문구가 바뀌어도 같은 섹션 id
        self.assertEqual(self.cli("migrate-ids")["added"], 0)
        self.stop(); self.start()
        _, d = self.get("/api/dashboard")
        self.assertEqual(d["data"]["globalLimits"], [])
        self.assertEqual(len(rd(self.data)["globalLimits"]), 3)  # 원본 보존

    def test_migrate_keeps_ids(self):
        before, lid = self.ids(), rd(self.data)["globalLimitsId"]
        self.assertEqual(self.cli("migrate-ids")["added"], 0)
        self.assertEqual(self.ids(), before)
        self.assertEqual(rd(self.data)["globalLimitsId"], lid)

    def test_nonstandard_existing_id_hq86(self):
        # q-legacy01처럼 사람이 직접 넣은 8hex가 아닌 id: 보존·번호·삭제·메시지가 모두 같은 인덱스를 따른다
        raw = rd(self.data); raw["questions"].append({"id": "q-legacy01", "q": "형식 밖 질문?", "status": "열림"}); wr(self.data, raw)
        self.assertEqual(self.cli("migrate-ids")["added"], 0)
        self.assertIn("q-legacy01", [q["id"] for q in rd(self.data)["questions"]])
        ref = self.refs()["q-legacy01"]
        self.assertTrue(self.cli("lookup", ref)["results"][0]["inData"])
        w = self.ids()["work"][0]
        for kind, iid in [("question", "q-legacy0"), ("question", "q-legacy02"), ("question", "Q-LEGACY01"),
                          ("question", "q-legacy01 "), ("question", "q-legacy01\n"), ("work", "q-legacy01"),
                          ("limits", "q-legacy01"), ("question", ["q-legacy01"]), ("question", None), ("question", "")]:
            self.assertEqual(self.post(self.req((kind, iid)))[0], 400, (kind, iid))
            self.assertEqual(self.msg(kind, iid, "x")[0], 400, (kind, iid))
        self.assertEqual(self.post(self.req(("question", "q-legacy01"), ("work", "w-deadbeef")))[0], 400)  # 하나라도 없으면 전체 거절
        self.assertEqual(self.cli("list")["requests"], [])
        self.assertEqual(self.msg("question", "q-legacy01", "답변")[0], 201)
        code, r = self.post(self.req(("question", "q-legacy01"), ("work", w)))
        self.assertEqual(code, 201, r)
        self.cli("process-inbox")
        self.assertIn("q-legacy01", rd(os.path.join(self.root, "private", "state.json"))["hidden"])
        self.assertEqual(self.cli("migrate-ids")["added"], 0)
        self.assertEqual(self.refs()["q-legacy01"], ref)
        self.assertTrue(self.cli("lookup", ref)["results"][0]["hidden"])

    def refs(self):
        return rd(os.path.join(self.root, "private", "state.json"))["refs"]["map"]

    def test_refs_stable_unique_and_never_reused(self):
        ids, lid = self.ids(), rd(self.data)["globalLimitsId"]
        m0 = self.refs()  # migrate-ids가 이미 부여
        expect = [*ids["work"], ids["question"], ids["decision"], "pr-1", lid]
        self.assertEqual(sorted(m0), sorted(expect))
        self.assertEqual(sorted(int(v[3:]) for v in m0.values()), list(range(1, len(expect) + 1)))  # 전역 유일
        self.assertEqual(self.get("/api/dashboard")[1]["refs"], m0)
        # 배열 순서 변경·숨김·재시작·PR 재조회·Jira import로 번호가 바뀌지 않는다
        raw = rd(self.data); raw["work"].reverse(); raw["questions"].insert(0, {"q": "새 질문", "status": "조사 중"})
        raw["recommendations"] = {"items": [{"id": "rec-x", "title": "추천 X"}]}; wr(self.data, raw)
        self.cli("migrate-ids")
        self.post(self.req(("work", ids["work"][0]))); self.cli("process-inbox")
        wr(os.path.join(self.root, "gh-plan.json"), {"1": "MERGED"})
        subprocess.run([sys.executable, os.path.join(HERE, "refresh_prs.py")], env=self.env, check=True, capture_output=True)
        self.stop(); self.start()
        _, d = self.get("/api/dashboard")
        m1 = self.refs()
        self.assertEqual({k: m1[k] for k in m0}, m0)
        new = sorted(set(m1) - set(m0), key=lambda k: m1[k])
        self.assertEqual([m1[k] for k in new], ["HQ-7", "HQ-8"])           # 새 질문, 추천 순으로 다음 번호
        self.assertEqual(m1["rec-x"], "HQ-8")
        self.assertEqual(d["refs"], m1)
        # 항목을 지우고 새 항목을 만들어도 옛 번호를 재사용하지 않는다
        raw = rd(self.data); gone = raw["pendingDecisions"].pop()["id"]; raw["pendingDecisions"].append({"title": "다시 만든 결정"}); wr(self.data, raw)
        self.cli("migrate-ids")
        m2 = self.refs()
        self.assertEqual(m2[gone], m0[gone])
        self.assertEqual(m2[rd(self.data)["pendingDecisions"][0]["id"]], "HQ-9")
        self.assertEqual(len(set(m2.values())), len(m2))

    def test_refs_concurrent_get_single_assignment(self):
        # migrate-ids 없이 id만 있는 새 항목 5개를 동시 GET 8개가 처음 보게 한다
        raw = rd(self.data); raw["work"] += [{"id": f"w-0000000{i}", "title": f"동시 {i}", "status": "진행 중"} for i in range(5)]; wr(self.data, raw)
        ts = [threading.Thread(target=self.get, args=("/api/dashboard",)) for _ in range(8)]
        [t.start() for t in ts]; [t.join() for t in ts]
        m = self.refs()
        self.assertEqual(sorted(int(v[3:]) for v in m.values()), list(range(1, 12)))  # 중복·건너뜀 없음
        self.assertEqual(self.cli("lookup", "HQ-11")["results"][0]["id"], "w-00000004")

    def test_lookup_hidden_and_unknown(self):
        ids = self.ids(); dec = ids["decision"]
        self.post(self.req(("decision", dec))); self.cli("process-inbox")
        ref = self.refs()[dec]
        r = self.cli("lookup", ref.lower(), dec, "HQ-999", "nope")["results"]
        self.assertEqual((r[0]["id"], r[0]["kind"], r[0]["title"], r[0]["hidden"], r[0]["inData"]), (dec, "decision", "합성 결정", True, True))
        self.assertEqual(r[0]["content"]["detail"], "d")
        self.assertEqual(r[1]["ref"], ref)
        self.assertEqual([x["found"] for x in r[2:]], [False, False])
        lim = self.cli("lookup", self.refs()[rd(self.data)["globalLimitsId"]])["results"][0]
        self.assertEqual((lim["kind"], lim["content"]), ("limits", ["합성 한계 1", "합성 한계 2"]))

    def test_lookup_resolved_decision_keeps_id_and_ref(self):
        dec = self.ids()["decision"]; ref = self.refs()[dec]
        raw = rd(self.data); d = raw["pendingDecisions"].pop(0)              # coordinator가 결정 완료로 옮긴 경우
        raw["resolvedDecisions"] = [{**d, "status": "거절", "resolvedAt": "2026-01-19T17:00:00+09:00"}]; wr(self.data, raw)
        r = self.cli("lookup", ref)["results"][0]
        self.assertEqual((r["id"], r["kind"], r["title"], r["inData"], r.get("resolved"), r["content"]["status"]),
                         (dec, "decision", "합성 결정", True, True, "거절"))
        self.assertEqual(self.refs()[dec], ref)                               # 번호는 그대로다
        self.assertEqual(self.msg("decision", dec, "후속")[0], 400)  # HTTP 메시지 규칙은 바꾸지 않았다

    def test_resolved_decision_hide_flow(self):
        dec = self.ids()["decision"]; ref = self.refs()[dec]
        raw = rd(self.data); d = raw["pendingDecisions"].pop(0)
        raw["resolvedDecisions"] = [{**d, "status": "승인", "resolvedAt": "2026-01-19T17:00:00+09:00", "decisionSource": "chat:2026-01-19"},
                                    {"title": "id 없는 legacy 결정", "status": "승인"}]; wr(self.data, raw)
        before = slurp(self.data)
        self.assertEqual(self.post(self.req(("work", dec)))[0], 400)       # 종류 불일치
        code, r = self.post(self.req(("decision", dec)))
        self.assertEqual(code, 201)
        self.assertEqual(r["request"]["items"], [{"kind": "decision", "id": dec, "label": "합성 결정"}])
        self.assertEqual(self.cli("process-inbox")["processed"][0]["status"], "done")
        self.assertEqual(self.cli("item", "get", dec)["hidden"], True)
        self.assertEqual(slurp(self.data), before)                          # 원본 결정·상태·id 불변
        self.assertEqual(self.refs()[dec], ref)                               # 번호 그대로
        self.assertEqual(self.msg("decision", dec, "후속")[0], 400)          # 메시지 대상은 그대로 아님

    def test_refs_old_state_without_refs_and_bad_next(self):
        st = os.path.join(self.root, "private", "state.json")
        s = rd(st); s.pop("refs"); wr(st, s)                                  # 이전 버전 state.json
        self.get("/api/dashboard")
        m = self.refs(); self.assertEqual(len(m), 6)
        s = rd(st); s["refs"]["next"] = 1; wr(st, s)                          # 손상된 next
        raw = rd(self.data); raw["work"].append({"title": "새"}); wr(self.data, raw); self.cli("migrate-ids")
        self.assertEqual(self.refs()[rd(self.data)["work"][-1]["id"]], "HQ-7")

    # ---------- 항목별 메시지 ----------
    def msg(self, kind, iid, text, mid=None, **kw):
        return self.post({"messageId": mid or secrets.token_hex(16), "kind": kind, "itemId": iid, "text": text}, path="/api/messages", **kw)

    def test_message_flow_keeps_source_and_inbox(self):
        ids = self.ids(); dec = ids["decision"]
        st = os.path.join(self.root, "private", "state.json")
        self.get("/api/dashboard")  # HQ 번호 부여
        before_data, before_state = slurp(self.data), slurp(st)
        evil = "<img src=x onerror=alert(1)>\n두 번째 줄"
        code, r = self.msg("decision", dec, "  " + evil + "  ")
        self.assertEqual(code, 201)
        m = r["message"]; mid = m["messageId"]
        self.assertEqual((m["status"], m["text"], m["label"], m["replies"]), ("received", evil, "합성 결정", []))  # trim만, 원문 그대로 저장
        _, d = self.get("/api/dashboard")
        self.assertEqual([x["messageId"] for x in d["messages"]], [mid])
        self.assertEqual(len(d["data"]["pendingDecisions"]), 1)  # POST만으로 결정이 바뀌지 않는다
        self.assertEqual(slurp(self.data), before_data)  # 원본 불변
        old, new = json.loads(before_state), rd(st)
        # 요청함·숨김은 그대로이고 refs에는 이 메시지 자체 번호(msg-<messageId>)만 더해진다. 기존 번호는 그대로다
        self.assertEqual({k: v for k, v in new.items() if k != "refs"}, {k: v for k, v in old.items() if k != "refs"})
        self.assertEqual(new["refs"]["map"], {**old["refs"]["map"], "msg-" + mid: f"HQ-{old['refs']['next']}"})
        ref = self.refs()[dec]
        ls = self.cli("msg", "list")["messages"]
        self.assertEqual((ls[0]["messageId"], ls[0]["ref"]), (mid, ref))
        self.assertEqual(len(self.cli("msg", "list", "--item", ref.lower())["messages"]), 1)
        self.assertEqual(self.cli("msg", "list", "--item", "HQ-999")["messages"], [])
        rd_ = self.cli("msg", "read", mid)
        self.assertEqual((rd_["ref"], rd_["itemNow"]["inData"], rd_["itemNow"]["hidden"]), (ref, True, False))
        # 삭제 요청함 처리는 메시지를 건드리지 않는다
        self.assertEqual(self.cli("list")["requests"], [])
        self.assertEqual(self.cli("process-inbox")["processed"], [])
        self.assertEqual(self.cli("msg", "respond", mid, "--text", "답변 <b>1</b>")["replies"][0]["text"], "답변 <b>1</b>")
        self.assertEqual(self.cli("msg", "list")["messages"][0]["status"], "received")  # 답변만으로 처리됨이 되지 않는다
        p1 = self.cli("msg", "process", mid, "--note", "결정 반영은 별도")
        self.assertEqual((p1["status"], p1["processNote"]), ("processed", "결정 반영은 별도"))
        p2 = self.cli("msg", "process", mid)
        self.assertEqual(p2["processedAt"], p1["processedAt"])  # 반복해도 처음 처리 기록 유지
        self.assertEqual(self.cli("msg", "list")["messages"], [])
        self.assertEqual(len(self.cli("msg", "list", "--all")["messages"]), 1)
        _, d = self.get("/api/dashboard")
        self.assertEqual((d["messages"][0]["status"], len(d["messages"][0]["replies"])), ("processed", 1))
        self.assertEqual((slurp(self.data), rd(st)["hidden"]), (before_data, {}))
        self.assertEqual(oct(os.stat(os.path.join(self.root, "private", "messages.json")).st_mode & 0o777), "0o600")
        self.stop(); self.start()
        self.assertEqual(len(self.get("/api/dashboard")[1]["messages"]), 1)  # 재시작 후에도 보존

    def test_message_retry_idempotent_and_conflict(self):
        w = self.ids()["work"][0]; mid = secrets.token_hex(16)
        self.assertEqual(self.msg("work", w, "질문", mid)[0], 201)
        code, r = self.msg("work", w, "질문", mid)
        self.assertEqual((code, r["duplicate"]), (200, True))
        self.assertEqual(self.msg("work", w, "다른 질문", mid)[0], 409)
        self.assertEqual(len(self.cli("msg", "list")["messages"]), 1)

    def test_message_rejections(self):
        ids = self.ids(); w = ids["work"][0]
        lim = rd(self.data)["globalLimitsId"]
        for args, code in [(("work", w, ""), 400), (("work", w, " \n\t "), 400), (("work", w, "가" * 2001), 400),
                           (("work", w, "a\x00b"), 400), (("work", w, "a\x1bb"), 400), (("work", w, 123), 400),
                           (("work", "w-deadbeef", "x"), 400), (("question", w, "x"), 400), (("limits", lim, "x"), 400),
                           (("work", "../x", "x"), 400)]:
            self.assertEqual(self.msg(*args)[0], code, args)
        self.assertEqual(self.msg("work", w, "x", mid="abc")[0], 400)
        self.assertEqual(self.msg("work", w, "x", origin="http://evil.example")[0], 403)
        self.assertEqual(self.msg("work", w, "x", site="cross-site")[0], 403)
        self.assertEqual(self.post(None, raw=b"{}", path="/api/messages", ctype="text/plain")[0], 415)
        self.assertEqual(self.post(None, raw=b"x" * 20000, path="/api/messages")[0], 413)
        self.assertEqual(self.msg("work", w, "가" * 2000)[0], 201)  # 경계값은 허용
        self.assertEqual(self.msg("pr", "pr-1", "줄\n바꿈\t탭")[0], 201)
        self.assertEqual(len(self.cli("msg", "list")["messages"]), 2)
        bad = subprocess.run([sys.executable, os.path.join(HERE, "server.py"), "msg", "respond", "0" * 32, "--text", "x"], env=self.env, capture_output=True)
        self.assertNotEqual(bad.returncode, 0)

    def test_general_message_no_item(self):
        ids = self.ids(); w = ids["work"][0]
        st = os.path.join(self.root, "private", "state.json")
        self.get("/api/dashboard")
        before_data, before_state = slurp(self.data), slurp(st)
        item_mid = self.msg("work", w, "항목 질문")[1]["message"]["messageId"]
        mid = secrets.token_hex(16)
        body = {"messageId": mid, "kind": "general", "text": "  자유 <b>메시지</b>  "}  # itemId 키 없이
        code, r = self.post(body, path="/api/messages")
        self.assertEqual(code, 201)
        m = r["message"]
        self.assertEqual((m["kind"], m["itemId"], m["label"], m["text"], m["status"]), ("general", None, None, "자유 <b>메시지</b>", "received"))
        self.assertEqual(self.post(body, path="/api/messages")[1]["duplicate"], True)  # 같은 messageId 재시도
        self.assertEqual(self.post({**body, "text": "다른 글"}, path="/api/messages")[0], 409)
        self.assertEqual(self.msg("general", None, "itemId null도 허용")[0], 201)
        for args in [("general", w, "x"), ("general", "", "x"), ("general", None, ""), ("general", None, "가" * 2001)]:
            self.assertEqual(self.msg(*args)[0], 400, args)  # 항목 연결·빈값·길이 초과 거절
        self.assertEqual(self.msg("general", None, "x", origin="http://evil.example")[0], 403)
        # 가짜 작업·질문·결정을 만들지 않고, 원본·요청함·숨김·refs도 바꾸지 않는다
        self.assertEqual((slurp(self.data), slurp(st)), (before_data, before_state))
        _, d = self.get("/api/dashboard")
        self.assertEqual(len(d["messages"]), 3)
        self.assertNotIn(None, d["refs"])
        ls = {x["messageId"]: x for x in self.cli("msg", "list")["messages"]}
        self.assertEqual((ls[mid]["ref"], ls[mid]["itemId"], ls[mid]["kind"]), (None, None, "general"))
        self.assertEqual(ls[item_mid]["ref"], self.refs()[w])  # 항목 메시지 회귀 없음
        self.assertEqual([x["messageId"] for x in self.cli("msg", "list", "--item", self.refs()[w])["messages"]], [item_mid])
        rd_ = self.cli("msg", "read", mid)
        self.assertEqual((rd_["ref"], rd_["itemNow"]), (None, None))
        self.assertTrue(self.cli("msg", "read", item_mid)["itemNow"]["inData"])
        self.assertEqual(self.cli("msg", "respond", mid, "--text", "답변")["replies"][0]["text"], "답변")
        self.assertEqual(self.cli("msg", "process", mid)["status"], "processed")
        self.assertEqual(self.cli("list")["requests"], [])  # 삭제 요청함과 분리
        self.assertEqual(slurp(self.data), before_data)

    def test_message_concurrent_posts(self):
        q = self.ids()["question"]
        res = []
        ts = [threading.Thread(target=lambda i=i: res.append(self.msg("question", q, f"질문 {i}")[0])) for i in range(15)]
        [t.start() for t in ts]; [t.join() for t in ts]
        self.assertEqual(res.count(201), 15)
        self.assertEqual(len(self.cli("msg", "list")["messages"]), 15)

    def test_message_hide_request_flow(self):
        w = self.ids()["work"][0]
        st = os.path.join(self.root, "private", "state.json")
        gid = self.msg("general", None, "수신 테스트 비밀문구")[1]["message"]["messageId"]
        iid = self.msg("work", w, "항목 질문")[1]["message"]["messageId"]
        msgs_before = slurp(os.path.join(self.root, "private", "messages.json"))
        # 존재하지 않는 메시지, kind 불일치(항목 id에 message, 메시지 id에 work), 접두사 없는 messageId는 거절한다
        for items in [[("message", "msg-" + "0" * 32)], [("message", w)], [("work", "msg-" + gid)], [("message", gid)]]:
            self.assertEqual(self.post(self.req(*items))[0], 400, items)
        b = self.req(("message", "msg-" + gid))
        code, r = self.post(b)
        self.assertEqual((code, r["request"]["items"][0]["kind"]), (201, "message"))
        self.assertIn("수신 테스트", r["request"]["items"][0]["label"])
        self.assertEqual(self.post(b)[1]["duplicate"], True)
        self.assertEqual(len(self.get("/api/dashboard")[1]["messages"]), 2)  # 처리 전에는 그대로 보인다
        out = self.cli("process-inbox", "--request", b["requestId"])
        self.assertEqual(out["processed"][0]["status"], "done")
        _, d = self.get("/api/dashboard")
        self.assertEqual([m["messageId"] for m in d["messages"]], [iid])
        self.assertNotIn("비밀문구", json.dumps(d, ensure_ascii=False))  # 요청 기록 label에도 원문을 다시 내보내지 않는다
        self.assertEqual(rd(st)["hidden"]["msg-" + gid]["kind"], "message")
        # 원문·상태는 그대로이고 CLI로는 조회된다
        self.assertEqual(slurp(os.path.join(self.root, "private", "messages.json")), msgs_before)
        ls = {m["messageId"]: m for m in self.cli("msg", "list", "--all")["messages"]}
        self.assertEqual((ls[gid]["hidden"], ls[gid]["status"], ls[iid]["hidden"]), (True, "received", False))
        self.assertEqual(self.cli("msg", "read", gid)["text"], "수신 테스트 비밀문구")
        self.assertEqual(len(rd(self.data)["work"]), 2)
        self.stop(); self.start()
        self.assertEqual(len(self.get("/api/dashboard")[1]["messages"]), 1)  # 재시작 후에도 숨김 유지
        # 내보내기 JSON(submit) 경로도 같은 검증으로 받는다
        f = os.path.join(self.root, "exp.json")
        wr(f, {**self.req(("message", "msg-" + iid), ("work", w)), "intent": "x"})
        self.assertEqual(self.cli("submit", f)["request"]["status"], "pending")
        self.cli("process-inbox")
        _, d = self.get("/api/dashboard")
        self.assertEqual((d["messages"], len(d["data"]["work"])), ([], 1))

    def test_message_link_classification(self):
        ids = self.ids(); q = ids["question"]
        self.get("/api/dashboard")
        refs = self.refs(); before = slurp(self.data)
        gid = self.msg("general", None, "로그인 버그 조사해 줘")[1]["message"]["messageId"]
        tid = self.msg("general", None, "수신 테스트")[1]["message"]["messageId"]
        self.cli("msg", "respond", gid, "--text", "질문으로 분류합니다")
        m = self.cli("msg", "link", gid, "--item", refs[q].lower(), "--note", "질문으로 분류")
        self.assertEqual((m["link"]["id"], m["link"]["kind"], m["linkRef"]), (q, "question", refs[q]))
        self.assertEqual((m["kind"], m["itemId"], m["text"], len(m["replies"]), m["status"]), ("general", None, "로그인 버그 조사해 줘", 1, "received"))
        self.assertEqual([x["messageId"] for x in self.cli("msg", "list", "--item", refs[q])["messages"]], [gid])
        self.assertEqual(self.cli("msg", "read", gid)["itemNow"]["id"], q)
        _, d = self.get("/api/dashboard")
        dm = {x["messageId"]: x for x in d["messages"]}
        self.assertEqual((dm[gid]["link"]["id"], dm[tid].get("link")), (q, None))  # 잡담은 자유 메시지로 남는다
        for bad in ["HQ-999", rd(self.data)["globalLimitsId"], "w-deadbeef"]:
            self.assertNotEqual(self.cli_fail("msg", "link", gid, "--item", bad).returncode, 0, bad)
        self.assertEqual(self.cli("msg", "link", gid, "--item", "pr-1")["link"]["kind"], "pr")  # 다시 연결하면 바뀌고 이력은 쌓인다
        u = self.cli("msg", "unlink", gid)
        self.assertEqual((u["link"], len(u["linkHistory"])), (None, 3))
        self.assertEqual(self.cli("msg", "read", gid)["itemNow"], None)
        self.assertEqual(slurp(self.data), before)  # 원본 data.json은 바꾸지 않는다

    def test_message_own_refs(self):
        """메시지 자체 HQ 번호: 기존 refs 계약(단조·유일·재사용 금지)을 따르고, 연결 항목 번호와 구분되며, 숨김·재시작에도 유지된다."""
        ids = self.ids(); q, dec = ids["question"], ids["decision"]
        st = os.path.join(self.root, "private", "state.json")
        self.get("/api/dashboard")
        old = self.refs(); nxt = rd(st)["refs"]["next"]
        gid = self.msg("general", None, "자유 메시지 하나")[1]["message"]["messageId"]
        did = self.msg("decision", dec, "결정 답변")[1]["message"]["messageId"]
        hid = self.msg("general", None, "숨길 메시지")[1]["message"]["messageId"]
        msgs_before = slurp(os.path.join(self.root, "private", "messages.json"))
        _, d = self.get("/api/dashboard")
        m = self.refs()
        self.assertEqual({k: m[k] for k in old}, old)  # 기존 번호 전부 유지
        own = {x: m["msg-" + x] for x in (gid, did, hid)}
        self.assertEqual(sorted(int(v[3:]) for v in own.values()), list(range(nxt, nxt + 3)))  # 접수 순서대로 이어서, 중복 없음
        self.assertEqual(d["refs"]["msg-" + gid], own[gid])
        self.assertNotEqual(own[did], old[dec])  # 메시지 번호와 대상 항목 번호는 다르다
        # CLI: msgRef(자체)와 ref·linkRef(항목)를 따로 내고, 자체 번호로 read·list·lookup 된다
        self.cli("msg", "link", gid, "--item", old[q])
        ls = {x["messageId"]: x for x in self.cli("msg", "list")["messages"]}
        self.assertEqual((ls[gid]["msgRef"], ls[gid]["ref"], ls[gid]["linkRef"]), (own[gid], None, old[q]))
        self.assertEqual((ls[did]["msgRef"], ls[did]["ref"]), (own[did], old[dec]))
        self.assertEqual(self.cli("msg", "read", own[gid].lower())["messageId"], gid)
        self.assertEqual([x["messageId"] for x in self.cli("msg", "list", "--item", own[did])["messages"]], [did])
        r = self.cli("lookup", own[gid], own[did])["results"]
        self.assertEqual([(x["id"], x["kind"], x["content"]["text"]) for x in r], [("msg-" + gid, "message", "자유 메시지 하나"), ("msg-" + did, "message", "결정 답변")])
        # 메시지 번호로 다른 메시지·메시지를 연결하지 않는다
        self.assertNotEqual(self.cli_fail("msg", "link", hid, "--item", own[gid]).returncode, 0)
        # 숨김: 번호 유지, lookup에서 hidden, 원문 보존
        code, _ = self.post(self.req(("message", "msg-" + hid))); self.assertEqual(code, 201)
        self.cli("process-inbox")
        _, d = self.get("/api/dashboard")
        self.assertNotIn(hid, [x["messageId"] for x in d["messages"]])
        h = self.cli("lookup", own[hid])["results"][0]
        self.assertEqual((h["id"], h["hidden"], h["content"]["text"]), ("msg-" + hid, True, "숨길 메시지"))
        # 새 항목·새 메시지는 그 뒤 번호를 받고, 재시작해도 모두 그대로다
        raw = rd(self.data); raw["work"].append({"title": "새 작업"}); wr(self.data, raw); self.cli("migrate-ids")
        nid = self.msg("general", None, "새 메시지")[1]["message"]["messageId"]
        self.stop(); self.start()  # 서버 재시작
        self.get("/api/dashboard")
        m2 = self.refs()
        self.assertEqual({k: m2[k] for k in m}, m)
        self.assertEqual(int(m2["msg-" + nid][3:]), nxt + 4)
        self.assertEqual(len(set(m2.values())), len(m2))
        # 원본 messages.json 내용(원문·kind·상태)은 번호 부여로 바뀌지 않는다(link는 위 CLI가 바꾼 것)
        box = {x["messageId"]: x for x in rd(os.path.join(self.root, "private", "messages.json"))["messages"]}
        prev = {x["messageId"]: x for x in json.loads(msgs_before)["messages"]}
        for k in prev:
            self.assertEqual({f: box[k][f] for f in ("kind", "itemId", "text", "status", "replies")}, {f: prev[k][f] for f in ("kind", "itemId", "text", "status", "replies")})

    # ---------- 지금 확인 요청 (flush) ----------
    def flush(self, fid=None, **kw):
        return self.post({"flushId": fid or secrets.token_hex(16)}, path="/api/flush", **kw)

    def codex_calls(self):
        p = os.path.join(self.root, "codex-calls")
        return [json.loads(l) for l in open(p)] if os.path.exists(p) else []

    def cli_fail(self, *args):
        return subprocess.run([sys.executable, os.path.join(HERE, "server.py"), *args], env=self.env, capture_output=True, text=True)

    def test_flush_not_registered_and_cooldown(self):
        code, r = self.flush()
        self.assertEqual((code, r["flush"]["status"]), (201, "not_registered"))
        self.assertIn("등록된", r["flush"]["error"])
        self.assertEqual(self.codex_calls(), [])
        self.assertEqual(self.flush()[0], 429)  # 60초 안 재요청
        self.assertEqual(self.get("/api/dashboard")[1]["flush"]["recent"][-1]["status"], "not_registered")

    def test_flush_register_validation(self):
        self.assertNotEqual(self.cli_fail("flush", "register", "--provider", "codex", "--thread", "abc", "--evidence", "e").returncode, 0)
        unknown = "00000000-0000-7000-8000-000000000000"
        self.assertNotEqual(self.cli_fail("flush", "register", "--provider", "codex", "--thread", unknown, "--evidence", "e").returncode, 0)
        self.assertNotEqual(self.cli_fail("flush", "register", "--provider", "claude", "--thread", THREAD, "--evidence", "e").returncode, 0)
        r = self.cli("flush", "register", "--provider", "codex", "--thread", THREAD, "--evidence", "terminal read 대조")
        self.assertEqual(r["registration"]["threadName"], "합성 coordinator")
        self.assertIsNone(self.cli("flush", "unregister")["registration"])

    def test_flush_fixed_argv_receipt_and_done(self):
        before = [slurp(self.data), slurp(os.path.join(self.root, "private", "state.json"))]
        self.cli("flush", "register", "--provider", "codex", "--thread", THREAD, "--evidence", "e")
        fid = secrets.token_hex(16)
        code, r = self.flush(fid)
        self.assertEqual((code, r["flush"]["status"]), (201, "queued"))
        self.assertNotIn("thread", r["flush"]); self.assertNotIn("queueMessageId", r["flush"])
        calls = self.codex_calls()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:4], ["queue", "--thread", THREAD, "--message"])
        self.assertEqual(calls[0][4], __import__("server").FLUSH_MESSAGE.format(fid=fid, root=self.root))  # 고정 문구 + flushId·데이터 루트뿐
        self.assertEqual(self.flush(fid)[1]["duplicate"], True)  # 같은 flushId 재전송
        code, r = self.flush()  # coordinator가 done을 남기기 전이면 새로 쌓지 않고 기존 요청을 돌려준다
        self.assertEqual((code, r["flush"]["flushId"], r["duplicate"]), (200, fid, True))
        self.assertEqual(len(self.codex_calls()), 1)
        self.assertNotEqual(self.cli_fail("flush", "done", "--id", secrets.token_hex(16)).returncode, 0)
        self.assertEqual(self.get("/api/dashboard")[1]["flush"]["recent"][-1]["status"], "queued")
        r = self.cli("flush", "done", "--id", fid, "--note", "요청함 확인")
        self.assertEqual(r["flushes"][-1]["status"], "processed")
        self.assertEqual(self.cli("flush", "done", "--id", fid)["flushes"][-1]["processNote"], "요청함 확인")  # 반복해도 첫 기록 유지
        self.assertEqual(self.flush()[0], 429)  # 처리 뒤에도 60초 cooldown
        self.assertEqual([slurp(self.data), slurp(os.path.join(self.root, "private", "state.json"))], before)  # 원본·요청함 불변
        self.assertEqual(self.cli("list")["requests"], [])

    def test_flush_failure_reason(self):
        self.cli("flush", "register", "--provider", "codex", "--thread", THREAD, "--evidence", "e")
        with open(os.path.join(self.root, "codex-plan"), "w") as f:
            f.write("no rollout found")
        code, r = self.flush()
        self.assertEqual((code, r["flush"]["status"]), (201, "failed"))
        self.assertIn("no rollout found", r["flush"]["error"])
        self.assertEqual(self.flush(r["flush"]["flushId"])[1]["duplicate"], True)  # 같은 id 재전송은 다시 실행하지 않는다
        self.assertEqual(len(self.codex_calls()), 1)
        self.assertNotEqual(self.cli_fail("flush", "done", "--id", r["flush"]["flushId"]).returncode, 0)  # 실패 건은 처리 기록 대상이 아니다

    def test_flush_rejections(self):
        self.assertEqual(self.flush(origin="http://evil.example")[0], 403)
        self.assertEqual(self.post({"flushId": "x"}, path="/api/flush")[0], 400)
        self.assertEqual(self.post(None, raw=b"{}", path="/api/flush", ctype="text/plain")[0], 415)
        self.assertEqual(self.codex_calls(), [])

    # ---------- item add/get/set/resolve ----------
    def item(self, *args, file=None):
        if file is not None:
            fp = os.path.join(self.root, "fields.json"); wr(fp, file); args = (*args, "--file", fp)
        return self.cli("item", *args)

    def test_item_add_set_cas_history(self):
        self.get("/api/dashboard")
        st = os.path.join(self.root, "private", "state.json")
        refs0 = rd(st)["refs"]
        r = self.item("add", "work", file={"title": "새 작업", "status": "진행 중", "remaining": "긴 내용\n둘째 줄 $(rm -rf /) `x`"})
        iid, ref = r["id"], r["ref"]
        self.assertRegex(iid, r"^w-[0-9a-f]{8}$")
        self.assertEqual((ref, r["rev"], r["item"]["state"]), (f"HQ-{refs0['next']}", 1, "open"))  # 기존 next 계약대로 번호 부여
        self.assertEqual(rd(st)["refs"]["map"], {**refs0["map"], iid: ref})  # 기존 번호는 그대로
        self.assertEqual(r["item"]["remaining"], "긴 내용\n둘째 줄 $(rm -rf /) `x`")  # 셸 해석 없이 문자열 그대로
        self.assertEqual(self.item("get", ref)["item"], self.item("get", iid)["item"])
        r2 = self.item("set", ref, "--set", "state=done", "--set", "conclusion=끝냄", "--reason", "검증 확인", "--expect-rev", "1")
        self.assertEqual((r2["id"], r2["rev"], r2["item"]["state"]), (iid, 2, "done"))
        self.assertEqual([h["rev"] for h in r2["item"]["history"]], [1, 2])
        self.assertIn("state: open → done", r2["item"]["history"][-1]["change"])
        before, st_fail = slurp(self.data), slurp(st)
        # stale rev·금지 키·필수 필드·사유 누락은 거절하고 아무것도 쓰지 않는다
        for args in (("--set", "status=x", "--expect-rev", "1"), ("--set", "id=w-00000000"), ("--set", "history=x"), ("--set", "rev=9"),
                     ("--set", "state=closed"), ("--set", "state=blocked"), ("--set", "state=bogus"), ("--set", "conclusion="),
                     ("--set", "evidence=x")):
            self.assertNotEqual(self.cli_fail("item", "set", iid, *args).returncode, 0, args)
        self.assertEqual(self.cli_fail("item", "set", iid, "--file", self._f({"evidence": [{"label": "l", "url": "file:///etc"}]})).returncode, 1)
        self.assertEqual(self.cli_fail("item", "set", iid, "--file", self._f({"prs": ["1"]})).returncode, 1)
        self.assertEqual(self.cli_fail("item", "add", "work", "--set", "title=t").returncode, 1)  # status 필수
        self.assertEqual(self.cli_fail("item", "add", "question", "--set", "q=질문", "--set", "status=조사 중", "--set", "state=done").returncode, 1)  # answer 필수
        for args in (("--set", "status="), ("--set", "status=  "), ("--set", "state=closed", "--reason", "사유\x07"), ("--set", "state=closed", "--reason", " "),
                     ("--set", "remaining=x", "--reason", "가" * 4001), ("--set", "remaining=x", "--by", "a\x1b")):
            self.assertNotEqual(self.cli_fail("item", "set", iid, *args).returncode, 0, args)  # 필수 status는 비울 수 없고 reason·by는 제어문자·길이 검사
        self.assertEqual(self.cli_fail("item", "add", "work", "--set", "title=  ", "--set", "status=s").returncode, 1)
        self.assertEqual((slurp(self.data), slurp(st)), (before, st_fail))  # 검증 실패는 data·state를 바꾸지 않는다
        st_before = slurp(st)
        rem = self.item("set", ids_open := self.ids()["work"][0], "--set", "remaining=", "--set", "verification=")
        self.assertEqual((rem["item"]["remaining"], rem["item"]["verification"]), ("", ""))  # 끝난 남은 일은 비울 수 있다
        self.assertEqual([h["change"] for h in rem["item"]["history"]], ["remaining 수정; verification 수정"])  # 이력은 추가만
        self.assertEqual(slurp(st), st_before)
        self.assertNotEqual(self.cli_fail("item", "set", ids_open, "--set", "status=").returncode, 0)
        r3 = self.item("set", iid, "--set", "state=closed", "--reason", "합성 종료 사유")
        self.assertEqual((r3["rev"], r3["item"]["history"][-1]["reason"]), (3, "합성 종료 사유"))
        self.assertTrue(self.item("set", iid, "--set", "state=closed", "--reason", "다시")["unchanged"])  # 바뀐 게 없으면 쓰지 않는다
        self.assertEqual(self.item("get", iid)["rev"], 3)
        q = rd(self.data)["questions"][0]
        r4 = self.item("set", q["id"], "--set", "answer=새 답", "--set", "category=기록 관리")
        self.assertEqual((r4["rev"], r4["item"]["updatedBy"]), (1, "HQ coordinator"))  # legacy 항목은 rev 0에서 시작
        self.assertEqual(self.cli_fail("item", "set", q["id"], "--set", "category=없는분류").returncode, 1)
        self.assertEqual(self.cli_fail("item", "get", "HQ-9999").returncode, 1)

    def test_item_add_new_id_avoids_refs_map(self):
        stp = os.path.join(self.root, "private", "state.json")
        self.get("/api/dashboard")
        st = rd(stp); st["refs"]["map"]["w-deadbeef"] = f"HQ-{st['refs']['next']}"; st["refs"]["next"] += 1; wr(stp, st)  # 지워진 항목의 보존된 번호
        code = ("import sys, server as s\nseq = iter(['deadbeef', 'cafe0001'])\ns.secrets.token_hex = lambda n: next(seq)\n"
                "s.main(['item', 'add', 'work', '--set', 'title=t', '--set', 'status=s'])")
        out = subprocess.run([sys.executable, "-c", code], cwd=HERE, env=self.env, capture_output=True, text=True, timeout=20, check=True).stdout
        r = json.loads(out)
        self.assertEqual(r["id"], "w-cafe0001")
        self.assertEqual(rd(stp)["refs"]["map"]["w-deadbeef"], st["refs"]["map"]["w-deadbeef"])  # 기존 번호는 그대로

    def _f(self, obj):
        fp = os.path.join(self.root, "f-%s.json" % secrets.token_hex(4)); wr(fp, obj); return fp

    def test_item_set_keeps_concurrent_refresh_and_other_items(self):
        wr(os.path.join(self.root, "gh-plan.json"), {"1": "MERGED"})
        iid = self.ids()["work"][1]
        p = subprocess.Popen([sys.executable, os.path.join(HERE, "refresh_prs.py")], env={**self.env, "FAKE_GH_SLEEP": "1.5"},
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)  # refresh가 락 밖에서 gh를 조회하는 동안 항목을 바꾼다
        self.item("set", iid, "--set", "remaining=동시 갱신")
        self.assertEqual(p.wait(10), 0)
        d = rd(self.data)
        self.assertEqual(d["work"][1]["remaining"], "동시 갱신")  # refresh가 항목 변경을 덮지 않는다
        self.assertEqual(d["prs"]["1"]["state"], "MERGED")
        self.item("set", d["work"][0]["id"], "--set", "status=리뷰")
        d2 = rd(self.data)
        self.assertEqual((d2["prs"], d2["prsCheckedAt"], d2["work"][1]), (d["prs"], d["prsCheckedAt"], d["work"][1]))  # 다른 항목·prs 보존
        self.assertEqual([w["id"] for w in d2["work"]], [w["id"] for w in d["work"]])

    def test_item_does_not_sync_messages_hidden_decisions(self):
        ids = self.ids(); w = ids["work"][0]; dec = ids["decision"]
        self.get("/api/dashboard")
        _, r = self.msg("work", w, "완료해 주세요"); mid = r["message"]["messageId"]
        rq = self.req(("work", w)); self.post(rq); self.cli("process-inbox")
        st, mp = os.path.join(self.root, "private", "state.json"), os.path.join(self.root, "private", "messages.json")
        b_state, b_msgs = slurp(st), slurp(mp)
        self.item("set", w, "--set", "state=done", "--set", "conclusion=c2")
        self.item("set", dec, "--set", "detail=새 설명")
        self.assertEqual((slurp(st), slurp(mp)), (b_state, b_msgs))  # 메시지 processed·숨김·refs는 그대로
        self.assertEqual(self.cli("msg", "read", mid)["status"], "received")
        self.assertEqual(rd(self.data)["pendingDecisions"][0]["id"], dec)  # 결정 수정은 승인이 아니다
        self.assertTrue(self.item("get", w)["hidden"])  # 숨긴 항목도 CLI로 조회·수정된다
        self.assertEqual(self.cli_fail("item", "set", dec, "--set", "state=done").returncode, 1)  # 결정에는 state가 없다
        for args in (("--source", "아무거나", "--reason", "r"), ("--source", "HQ-1", "--reason", " ")):
            self.assertEqual(self.cli_fail("item", "resolve", dec, *args).returncode, 1)
        self.assertEqual(self.cli_fail("item", "resolve", w, "--source", "HQ-1", "--reason", "r").returncode, 1)
        ref = self.refs()[dec]
        r = self.item("resolve", ref, "--source", "chat:2026-01-19", "--reason", "사용자가 A안 확정")
        self.assertEqual((r["id"], r["ref"], r["resolved"], r["item"]["decisionSource"], r["item"]["resolution"]), (dec, ref, True, "chat:2026-01-19", "사용자가 A안 확정"))
        d = rd(self.data)
        self.assertEqual((d["pendingDecisions"], [x["id"] for x in d["resolvedDecisions"]]), ([], [dec]))
        self.assertEqual(self.cli("lookup", ref)["results"][0]["resolved"], True)
        self.assertEqual(self.cli_fail("item", "set", dec, "--set", "detail=x").returncode, 1)  # 해소된 결정은 읽기 전용
        self.assertEqual(slurp(mp), b_msgs)

    # ---------- backup / restore ----------
    def backups(self):
        b = os.path.join(self.root, "backups")
        return sorted(os.listdir(b)) if os.path.isdir(b) else []

    def snapshot_root(self):
        """운영 루트의 data·private 파일 내용과 권한(백업 디렉터리 제외)."""
        out = {}
        for d in ("public", "private"):
            for n in sorted(os.listdir(os.path.join(self.root, d))):
                p = os.path.join(self.root, d, n)
                out[f"{d}/{n}"] = (slurp(p), oct(os.stat(p).st_mode & 0o777))
        return out

    def test_backup_daily_first_and_manual(self):
        bs = self.backups()
        self.assertEqual(len(bs), 1)  # setUp의 migrate-ids가 하루 첫 쓰기였다. 쓰기 전 내용(id 없음)이 보존된다
        first = os.path.join(self.root, "backups", bs[0])
        self.assertNotIn(b'"id"', slurp(os.path.join(first, "data.json")))
        secret = "비밀 원문 " + secrets.token_hex(4)
        self.msg("general", None, secret)
        self.item("set", self.ids()["work"][0], "--set", "status=리뷰")
        self.assertEqual(self.backups(), bs)  # 같은 날 두 번째 쓰기부터는 백업하지 않는다
        before = self.snapshot_root()
        out = subprocess.run([sys.executable, os.path.join(HERE, "server.py"), "backup"], env=self.env, capture_output=True, text=True, check=True).stdout
        self.assertNotIn(secret, out)  # stdout에는 내용이 아니라 해시·크기·건수만
        r = json.loads(out)
        self.assertEqual(self.snapshot_root(), before)  # 원본 존재·내용·권한 불변
        self.assertEqual(len(self.backups()), 2)
        self.assertFalse([n for n in os.listdir(os.path.join(self.root, "backups")) if n.startswith(".tmp-")])
        bdir = r["path"]
        self.assertEqual(oct(os.stat(os.path.join(self.root, "backups")).st_mode & 0o777), "0o700")
        self.assertEqual(oct(os.stat(bdir).st_mode & 0o777), "0o700")
        man = rd(os.path.join(bdir, "manifest.json"))
        for fn, src in (("data.json", self.data), ("state.json", os.path.join(self.root, "private", "state.json")),
                        ("messages.json", os.path.join(self.root, "private", "messages.json"))):
            self.assertEqual(slurp(os.path.join(bdir, fn)), slurp(src))
            self.assertEqual(oct(os.stat(os.path.join(bdir, fn)).st_mode & 0o777), "0o600")
            self.assertEqual((man["files"][fn]["sha256"], man["files"][fn]["mode"]), (hashlib.sha256(slurp(src)).hexdigest(), before[f"{'public' if fn == 'data.json' else 'private'}/{fn}"][1]))
        self.assertEqual(man["files"]["flush.json"], {"exists": False})  # 없는 파일은 없다고 기록한다
        st = rd(os.path.join(self.root, "private", "state.json"))
        self.assertEqual((man["counts"]["messages"], man["counts"]["refsNext"], man["counts"]["work"]), (1, st["refs"]["next"], 2))
        head = subprocess.run(["git", "-C", HERE, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        self.assertEqual(man["gitHead"], head)

    def test_backup_on_write_paths_not_plain_get(self):
        self.get("/api/dashboard")  # 번호 부여 쓰기
        shutil.rmtree(os.path.join(self.root, "backups"))
        self.get("/api/dashboard")  # 쓰기가 없는 GET은 백업하지 않는다
        self.assertEqual(self.backups(), [])
        self.msg("general", None, "새 메시지")  # 서버 쓰기 경로도 하루 첫 쓰기 전에 백업한다
        self.assertEqual(len(self.backups()), 1)
        b = os.path.join(self.root, "backups", self.backups()[0])
        self.assertEqual(rd(os.path.join(b, "manifest.json"))["files"]["messages.json"], {"exists": False})  # 쓰기 전 상태
        shutil.rmtree(os.path.join(self.root, "backups"))
        subprocess.run([sys.executable, os.path.join(HERE, "refresh_prs.py")], env=self.env, check=True, capture_output=True)
        self.assertEqual(len(self.backups()), 1)  # PR 자동 조회 쓰기도 같은 정책
        # 중첩 락·write_json 안 백업이 deadlock 없이 끝난다
        shutil.rmtree(os.path.join(self.root, "backups"))
        code = "import server as s\nwith s.locked():\n    with s.locked():\n        s.write_json(s.DATA, s.load_json(s.DATA))\n    print(len(s.backup_dirs()))"
        r = subprocess.run([sys.executable, "-c", code], cwd=HERE, env=self.env, capture_output=True, text=True, timeout=20, check=True)
        self.assertEqual(r.stdout.strip(), "1")

    def restore(self, bdir, out):
        return subprocess.run([sys.executable, os.path.join(HERE, "server.py"), "restore", "--backup", bdir, "--out", out],
                              env=self.env, capture_output=True, text=True)

    def test_restore_merge_preserves_later_records(self):
        ids = self.ids(); self.get("/api/dashboard")
        _, r1 = self.msg("work", ids["work"][0], "첫 메시지"); m1 = r1["message"]["messageId"]
        rq = self.req(("question", ids["question"])); self.post(rq)
        bdir = self.cli("backup")["path"]
        # 백업 이후의 변경: 답변·처리·새 메시지·요청 처리·숨김·새 항목 번호
        self.cli("msg", "respond", m1, "--text", "답변"); self.cli("msg", "process", m1)
        _, r2 = self.msg("general", None, "백업 이후 메시지"); m2 = r2["message"]["messageId"]
        self.cli("process-inbox")
        new = self.item("add", "question", "--set", "q=새 질문", "--set", "status=조사 중")
        self.get("/api/dashboard")
        before = self.snapshot_root()
        out = os.path.join(self.root, "..", os.path.basename(self.root) + "-restore1")
        self.addCleanup(shutil.rmtree, out, True)
        p = self.restore(bdir, out)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        rep = json.loads(p.stdout)
        self.assertEqual((rep["conflicts"], rep["currentProblems"]), ([], {}))
        self.assertEqual(self.snapshot_root(), before)  # 운영 루트는 읽기만 한다
        st, ms = rd(os.path.join(out, "private", "state.json")), rd(os.path.join(out, "private", "messages.json"))
        cur_st, cur_ms = rd(os.path.join(self.root, "private", "state.json")), rd(os.path.join(self.root, "private", "messages.json"))
        self.assertEqual((st["refs"], st["requests"], st["hidden"]), (cur_st["refs"], cur_st["requests"], cur_st["hidden"]))
        self.assertEqual(ms["messages"], cur_ms["messages"])  # 백업 이후 답변·처리·새 메시지가 남는다
        self.assertIn(new["id"], st["refs"]["map"])
        self.assertEqual(rd(os.path.join(out, "public", "data.json")), rd(self.data))
        self.assertEqual(oct(os.stat(os.path.join(out, "private", "state.json")).st_mode & 0o777), "0o600")
        # 현재 messages.json이 없으면 백업으로 채우고 유실 가능성을 알린다
        os.rename(os.path.join(self.root, "private", "messages.json"), os.path.join(self.root, "messages.bak"))
        out2 = out + "-2"; self.addCleanup(shutil.rmtree, out2, True)
        rep2 = json.loads(self.restore(bdir, out2).stdout)
        self.assertEqual(rep2["currentProblems"], {"messages.json": "없음"})
        self.assertTrue(any("이후의 변경은 복구되지 않을 수 있습니다" in n for n in rep2["notes"]))
        self.assertEqual([m["messageId"] for m in rd(os.path.join(out2, "private", "messages.json"))["messages"]], [m1])
        os.rename(os.path.join(self.root, "messages.bak"), os.path.join(self.root, "private", "messages.json"))
        # 현재 state.json이 손상되면 백업 refs를 쓰고 그렇게 보고한다
        stp = os.path.join(self.root, "private", "state.json"); good = slurp(stp)
        with open(stp, "w") as f:
            f.write("{broken")
        out3 = out + "-3"; self.addCleanup(shutil.rmtree, out3, True)
        rep3 = json.loads(self.restore(bdir, out3).stdout)
        self.assertIn("손상", rep3["currentProblems"]["state.json"])
        self.assertTrue(any("번호 재사용" in n for n in rep3["notes"]))
        with open(stp, "wb") as f:
            f.write(good)

    def test_restore_conflicts_and_guards(self):
        ids = self.ids(); self.get("/api/dashboard")
        _, r1 = self.msg("work", ids["work"][0], "원문"); m1 = r1["message"]["messageId"]
        self.cli("msg", "respond", m1, "--text", "첫 답변")
        bdir = self.cli("backup")["path"]
        out = os.path.join(self.root, "..", os.path.basename(self.root) + "-restore-c")
        self.addCleanup(shutil.rmtree, out, True)
        mp, stp = os.path.join(self.root, "private", "messages.json"), os.path.join(self.root, "private", "state.json")
        good_m, good_s = slurp(mp), slurp(stp)
        def conflict(mutate, path, good):
            box = json.loads(good); mutate(box); wr(path, box)
            p = self.restore(bdir, out)
            self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
            self.assertTrue(json.loads(p.stdout)["conflicts"])
            self.assertFalse(os.path.exists(out))  # 충돌이면 아무것도 만들지 않는다
            with open(path, "wb") as f:
                f.write(good)
        conflict(lambda b: b["messages"][0].update(text="바뀐 원문"), mp, good_m)
        conflict(lambda b: b["messages"][0].update(replies=[{"at": "x", "text": "다른 답변"}]), mp, good_m)  # 답변 prefix 불일치
        conflict(lambda b: b["messages"][0].update(status="processed", replies=[]), mp, good_m)  # 처리됨이어도 답변이 빠지면 충돌
        conflict(lambda b: b["refs"]["map"].update({ids["work"][0]: "HQ-999"}), stp, good_s)
        # 무결성·출력 루트 검사
        self.assertIn("출력 루트", self.restore(bdir, self.root).stderr)
        os.makedirs(out); open(os.path.join(out, "x"), "w").close()
        self.assertIn("비어 있어야", self.restore(bdir, out).stderr)
        shutil.rmtree(out)
        with open(os.path.join(bdir, "messages.json"), "ab") as f:
            f.write(b" ")
        self.assertIn("무결성 실패", self.restore(bdir, out).stderr)
        self.assertIn("완료된 백업", self.restore(os.path.join(self.root, "backups"), out).stderr)

    # ---------- check / summary ----------
    def tree(self):
        out = {}
        for d, _, fs in os.walk(self.root):
            for f in fs:
                p = os.path.join(d, f); out[p] = slurp(p)
        return out

    def test_check_summary_read_only(self):
        d = rd(self.data); d["work"].append({"id": "w-0000beef", "title": "번호 없는 legacy", "status": "진행 중"}); wr(self.data, d)
        before = self.tree()
        c = self.cli("check")
        self.cli("summary"); subprocess.run([sys.executable, os.path.join(HERE, "server.py"), "summary", "--markdown"], env=self.env, check=True, capture_output=True)
        self.assertEqual(self.tree(), before)  # 번호 부여·PR 조회·백업 등 숨은 쓰기가 없다
        self.assertIn("w-0000beef", c["legacy"]["ref-missing"]["ids"])
        self.assertEqual(c["errors"], [])
        empty = tempfile.mkdtemp(prefix="hqdash-empty-"); self.addCleanup(shutil.rmtree, empty)
        os.makedirs(os.path.join(empty, "public")); wr(os.path.join(empty, "public", "data.json"), {"work": []})
        subprocess.run([sys.executable, os.path.join(HERE, "server.py"), "check"], env={**self.env, "HQ_DASH_ROOT": empty}, check=True, capture_output=True)
        self.assertEqual(os.listdir(empty), ["public"])  # private·락 파일도 만들지 않는다

    def test_check_findings(self):
        self.get("/api/dashboard")
        ids = self.ids(); w0, w1 = ids["work"]
        self.item("set", w0, "--set", "state=waiting_user", "--set", "remaining=결정 " + ids["decision"] + " 기다림")
        self.item("resolve", ids["decision"], "--source", "chat:2026-01-19", "--reason", "확정")
        wr(os.path.join(self.root, "gh-plan.json"), {"1": "MERGED"})
        subprocess.run([sys.executable, os.path.join(HERE, "refresh_prs.py")], env=self.env, check=True, capture_output=True)
        codes = lambda c: sorted({f["code"] for f in c["errors"] + c["warnings"]})
        os.makedirs(os.path.join(self.root, "tasks"))
        with open(os.path.join(self.root, "tasks", "t.md"), "w") as f:
            f.write(f"# 작업\n\n항목: {self.refs()[w0]} ({w0}), HQ-9999 (w-deadbeef)\n")
        c = self.cli("check")
        self.assertEqual(sorted(x["msg"].split("항목 ")[1].split("가")[0] for x in c["warnings"] if x["code"] == "task-unknown-item"), ["HQ-9999", "w-deadbeef"])
        os.remove(os.path.join(self.root, "tasks", "t.md"))
        self.assertEqual(codes(self.cli("check")), ["open-but-prs-finished", "waiting-on-resolved-decision"])
        d = rd(self.data)
        d["work"][1]["state"] = "done"; d["work"][1]["conclusion"] = ""
        d["questions"][0]["state"] = "finished"
        d["work"].append(dict(d["work"][0]))  # id 중복
        wr(self.data, d)
        stp = os.path.join(self.root, "private", "state.json"); st = rd(stp)
        st["refs"]["map"]["x-1"] = st["refs"]["map"][w1]; st["refs"]["next"] = 1; wr(stp, st)
        p = self.cli_fail("check")
        self.assertEqual(p.returncode, 1)  # errors가 있으면 nonzero(warnings·legacy만이면 위처럼 0)
        self.assertEqual(codes(json.loads(p.stdout)), ["done-without-result", "id-duplicate", "open-but-prs-finished", "ref-duplicate", "refs-next",
                                                       "state-invalid", "waiting-on-resolved-decision"])

    def test_summary_markdown_hidden_and_legacy(self):
        self.get("/api/dashboard")
        ids = self.ids(); w0, w1 = ids["work"]  # A: 진행 중(legacy), B: 완료(legacy 문구)
        n = self.item("add", "work", "--set", "title=숨긴 미완료 /Users/me/x run_123abc", "--set", "status=진행 중", "--set", "remaining=DEMO-42 확인")
        closed = self.item("add", "work", "--set", "title=끝난 일", "--set", "status=진행 중")
        self.item("set", closed["id"], "--set", "state=closed", "--reason", "사용자 종료")
        self.post(self.req(("work", n["id"]))); self.cli("process-inbox")
        self.msg("work", w0, "비밀 메시지 원문")
        md = subprocess.run([sys.executable, os.path.join(HERE, "server.py"), "summary", "--markdown"], env=self.env, check=True, capture_output=True, text=True).stdout
        self.assertTrue(md.startswith("<!-- 생성물:"))
        self.assertIn("관찰 시각:", md)
        refs = self.refs()
        line = next(l for l in md.splitlines() if l.startswith(f"- {n['ref']} "))
        self.assertIn("숨김", line)  # 숨긴 미완료도 빠지지 않는다
        self.assertIn("DEMO-42", md)
        self.assertNotIn(f"- {closed['ref']} ", md)  # closed는 미완료가 아니다
        # 완료 기록은 기본 요약에서 뺀다: legacy 문구 완료는 개수 문장만, 목록은 JSON에 남는다
        self.assertNotIn(f"- {refs[w1]} ", md)
        self.assertIn("문구로만 완료로 분류돼 위 목록에서 뺀 항목 2건", md)  # 작업 B(완료)·질문(확정 답변)
        self.assertEqual([x["id"] for x in self.cli("summary")["legacyDoneByStatus"]], [w1, ids["question"]])
        self.assertIn(f"- {refs[w0]} [작업] 합성 작업 A", md)  # legacy 미완료는 그대로
        self.assertIn(f"- {refs[ids['decision']]} [결정] 합성 결정", md)
        for leak in ("비밀 메시지 원문", "/Users/me", "run_123abc"):
            self.assertNotIn(leak, md)
        active = md.split("## 진행 중")[1].split("##")[0]
        order = [l.split()[1] for l in active.splitlines() if l.startswith("- HQ-")]
        self.assertEqual(order, sorted(order, key=lambda r: int(r[3:])))  # HQ 번호 순 안정 정렬


if __name__ == "__main__":
    unittest.main(verbosity=2)
