# Agent HQ 진행판 (core)

에이전트에게 맡긴 작업·질문·결정을 한 화면에서 보고, 화면에서 남긴 메시지·숨김 요청을 coordinator 에이전트가 CLI로 처리하는 로컬 진행판이다. 서버는 Python 표준 라이브러리만 쓰고, 화면은 Preact + TypeScript + Vite(daisyUI)로 만든 단일 HTML 파일이다. UI 문구는 한국어다.

## 요구 사항

- Python 3.11 이상 (서버·CLI, 추가 패키지 없음)
- Node.js 22 이상과 pnpm (화면 빌드·테스트에만 쓴다)

## 빠른 시작

```sh
git clone <이 레포> agent-hq-core && cd agent-hq-core/apps/dashboard
pnpm install --frozen-lockfile
pnpm build                                   # public/index.html 생성

export HQ_DASH_ROOT="$HOME/.local/share/agent-hq-core"   # 데이터 루트(기본값과 같다). 실험은 mktemp -d 경로를 쓴다
python3 server.py init                       # 빈 상태로 시작
# 또는: python3 server.py init --demo        # 합성 예시 데이터로 시작(실제 데이터 아님)
python3 server.py serve                      # http://127.0.0.1:48173/
```

- `init` 전에는 어떤 명령도 데이터 루트를 만들지 않고, 안내만 출력하고 종료한다. `init`은 이미 `data.json`이 있으면 덮어쓰지 않는다.
- 서버는 기본으로 `127.0.0.1`에만 bind한다. `--host`는 `127.0.0.1` 또는 tailnet 대역(`100.x`)만 허용한다. 다른 hostname으로 접속한다면 `--alias <이름>`으로 Origin 허용 목록에 넣는다(예: `--alias localhost`).

## 설정 (환경변수, 모두 선택)

외부 도구를 실행하는 기능은 모두 기본 꺼짐이며 아래 값을 줄 때만 켜진다.

| 이름 | 기본 | 의미 |
| --- | --- | --- |
| `HQ_DASH_ROOT` | `~/.local/share/agent-hq-core` | 실행 데이터 루트(`public/data.json`, `private/`, `backups/`) |
| `HQ_GITHUB_REPO` | 없음 | `owner/name`. 지정하면 `data.prs`의 PR을 `gh pr view`로 읽기 전용 조회(화면 요청 시 5분 간격, 또는 `python3 refresh_prs.py`)하고 PR 링크를 만든다. `gh` 로그인이 필요하다 |
| `HQ_JIRA_PROJECT` | 없음 | Jira 프로젝트 키. 지정하면 `import-jira FILE`로 미리 받아 둔 조회 스냅샷 파일을 가져온다(서버가 Jira를 호출하지는 않는다) |
| `HQ_ENABLE_CODEX_FLUSH` | 없음 | `1`이면 '지금 확인 요청' 버튼이 등록된 Codex thread에 고정 문구를 `codex queue`로 적재한다(`flush register` 필요) |
| `HQ_TASKS_DIR` | 없음 | 지정하면 `check`가 그 디렉터리의 task 문서 첫머리 `항목: HQ-n`을 데이터와 대조한다 |
| `CODEX_HOME`, `HQ_CODEX_BIN` | `~/.codex`, `codex` | Codex 알림을 켰을 때만 쓴다 |

## 주요 명령

```sh
python3 server.py item add work --set title="새 작업" --set status="진행 중"
python3 server.py item set HQ-1 --set state=done --set conclusion="결과" --reason "확인"
python3 server.py msg list                  # 화면에서 남긴 메시지
python3 server.py list && python3 server.py process-inbox   # 숨김 요청 확인·반영
python3 server.py summary --markdown        # 미완료 요약
python3 server.py check                     # 읽기 전용 정합성 점검
python3 server.py backup                    # 데이터 스냅샷
python3 server.py --help                    # 전체 명령
```

- 항목 상태는 `state`(`open`·`blocked`·`waiting_user`·`done`·`closed`·`dropped`)로 기록한다. 모든 쓰기는 하나의 파일 락 아래 원자적으로 하며, 그날 첫 쓰기 전에 `backups/`에 스냅샷을 만든다.
- 화면의 메시지·숨김 요청·확인 요청은 서버가 보관만 한다. 승인·처리는 coordinator가 CLI로 한다. 웹에서 셸 명령을 실행하는 경로는 없다.

## 보안 모델

- 정적 경로는 `/`·`/index.html`만 정확히 허용한다. 데이터 파일은 `GET /api/dashboard` 응답으로만 나간다.
- POST는 같은 origin(`Origin` 고정 허용 목록, `Sec-Fetch-Site`), `application/json`, 16KB 이하 본문만 받는다. 응답에는 엄격한 CSP를 붙인다.
- 인증 기능은 없다. 신뢰하는 장치에서 loopback이나 사설 tailnet에만 띄운다.

## 테스트

```sh
cd apps/dashboard
pnpm build && pnpm test          # 화면 빌드·vitest
python3 test_server.py           # 서버·CLI (먼저 pnpm build 필요). 임시 HQ_DASH_ROOT와 가짜 gh·codex만 쓴다
```

## 운영 지침 템플릿 (선택)

`templates/`에는 coordinator 에이전트용 일반 지침 예시(`AGENTS.example.md`)와 작업 문서 양식(`task.md`)이 있다. 진행판 동작은 이 템플릿에 의존하지 않으므로 쓰지 않아도 되고, 필요에 맞게 고쳐 쓴다.

## 라이선스

MIT. 전문은 [LICENSE](LICENSE)를 본다.
