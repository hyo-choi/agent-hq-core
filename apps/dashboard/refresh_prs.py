#!/usr/bin/env python3
"""data.json에 등록된 PR metadata를 gh로 읽기 전용 갱신한다. 실패한 PR은 마지막 관찰값을 남기고 ok=false로 표시한다.
대상은 data.prs의 숫자 키 전체라서 coordinator가 PR을 추가하면 다음 조회부터 자동으로 포함된다. PR을 새로 만들지 않는다."""
import json, subprocess, sys
from server import DATA, GITHUB_REPO, REPO_RE, locked, load_json, write_json
from datetime import datetime, timezone, timedelta

if not (GITHUB_REPO and REPO_RE.match(GITHUB_REPO)):  # opt-in: 설정한 레포만 조회한다
    sys.exit("PR 조회는 opt-in입니다. HQ_GITHUB_REPO=owner/name으로 실행하세요")
REPO = GITHUB_REPO
FIELDS = "number,title,state,isDraft,url,updatedAt,mergedAt"

now = datetime.now(timezone(timedelta(hours=9))).isoformat(timespec="seconds")
with locked():
    nums = sorted(int(k) for k in (load_json(DATA).get("prs") or {}) if k.isdigit())
results = {}
for n in nums:
    try:
        out = subprocess.run(["gh", "pr", "view", str(n), "-R", REPO, "--json", FIELDS],
                             capture_output=True, text=True, timeout=15, check=True, stdin=subprocess.DEVNULL).stdout
        p = json.loads(out)
        if p.get("number") != n:
            raise ValueError("number mismatch")
        results[str(n)] = {**p, "ok": True, "observedAt": now}
    except Exception:
        # ponytail: 실패 원인 문자열은 계정 정보가 섞일 수 있어 공개 파일에 쓰지 않는다
        results[str(n)] = None
# gh 조회가 끝난 뒤 짧게 잠그고 다시 읽어 써서, 그 사이의 다른 편집·migrate-ids와 충돌하지 않게 한다
with locked():
    data = load_json(DATA)
    prs = data.setdefault("prs", {})
    for k, v in results.items():
        if k in prs:  # 조회 중 coordinator가 지운 PR은 되살리지 않는다
            prs[k] = v or {**prs[k], "number": int(k), "ok": False, "failedAt": now}
    data["prsCheckedAt"] = now
    write_json(DATA, data)
print(now, {k: ("ok" if v.get("ok") else "FAIL") for k, v in prs.items()})
