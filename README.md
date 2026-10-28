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

서버는 `.env`를 자동으로 읽지 않는다. 예시 파일을 복사해 고친 뒤 레포 루트에서 현재 셸에 export하고, 같은 셸에서 명령을 실행한다. 실제 `.env`는 `.gitignore`로 추적하지 않는다.

```sh
cp .env.example .env            # 필요한 값만 주석을 풀어 고친다
set -a; . ./.env; set +a        # 현재 셸에 export
cd apps/dashboard && python3 server.py init
```

| 이름 | 기본 | 의미 |
| --- | --- | --- |
| `HQ_DASH_ROOT` | `~/.local/share/agent-hq-core` | 실행 데이터 루트(`public/data.json`, `private/`, `backups/`) |
| `HQ_GITHUB_REPO` | 없음 | `owner/name`. 지정하면 `data.prs`의 PR을 `gh pr view`로 읽기 전용 조회(화면 요청 시 5분 간격, 또는 `python3 refresh_prs.py`)하고 PR 링크를 만든다. `gh` 로그인이 필요하다 |
| `HQ_JIRA_PROJECT` | 없음 | Jira 프로젝트 키. 지정하면 `import-jira FILE`로 미리 받아 둔 조회 스냅샷 파일을 가져온다(서버가 Jira를 호출하지는 않는다) |
| `HQ_ENABLE_CODEX_FLUSH` | 없음 | `1`이면 '지금 확인 요청' 버튼이 등록된 Codex thread에 고정 문구를 `codex queue`로 적재한다(`flush register` 필요) |
| `HQ_TASKS_DIR` | 없음 | 지정하면 `check`가 그 디렉터리의 task 문서 첫머리 `항목: HQ-n`을 데이터와 대조한다 |
| `CODEX_HOME`, `HQ_CODEX_BIN` | `~/.codex`, `codex` | Codex 알림을 켰을 때만 쓴다 |

## 에이전트와 함께 쓰기

진행판은 에이전트를 실행하거나 깨우지 않는다. 터미널의 CLI 에이전트(Codex, Claude Code 등)가 셸에서 `server.py` 명령을 직접 실행해 상태를 기록하고, 화면에서 사용자가 남긴 요청을 같은 CLI로 읽어 처리한다. 별도 오케스트레이션 도구는 필요 없다.

```text
에이전트 ──item add/set──▶ data.json ──60초 새로고침──▶ 화면(사용자)
   ▲                                                      │ 메시지·결정 답변·숨김 요청
   └──msg list/read·list ◀── 서버가 보관만 함 ◀──────────────┘
      → 처리 후 msg respond/process·item resolve·process-inbox
```

- 자동으로 되는 것: 화면은 60초마다 데이터를 다시 읽고, 서버는 화면 요청을 파일에 보관한다.
- 수동(에이전트 몫)인 것: 요청함 확인과 처리. 에이전트가 명령을 실행해야만 처리된다. 화면의 새로고침은 에이전트가 처리했다는 뜻이 아니다.

### 1. 하나의 데이터 루트를 공유한다

서버와 에이전트는 같은 `HQ_DASH_ROOT`를 봐야 한다. 에이전트는 보통 다른 프로젝트 디렉터리에서 실행되므로 `server.py`를 절대 경로로 부르고, 같은 `.env`를 셸에 반영한다.

```sh
# 서버 터미널 (레포 루트)
set -a; . ./.env; set +a
python3 apps/dashboard/server.py init        # 처음 한 번
python3 apps/dashboard/server.py serve

# 에이전트가 쓸 셸 (어느 디렉터리든). /path/to는 이 레포를 둔 실제 위치로 바꾼다
set -a; . /path/to/agent-hq-core/.env; set +a
hq() { python3 /path/to/agent-hq-core/apps/dashboard/server.py "$@"; }   # bash·zsh 공통
hq summary --markdown
```

`.env`를 반영하지 않은 셸에서 실행하면 기본 루트(`~/.local/share/agent-hq-core`)를 쓰므로, `.env`에서 루트를 바꿨다면 서버와 다른 데이터를 보게 된다.

### 2. 에이전트에게 bootstrap 프롬프트를 준다

에이전트 세션을 시작할 때 아래를 붙여 넣는다. 경로는 자기 환경에 맞게 바꾼다. 오래 쓸 규칙은 `templates/AGENTS.example.md`를 고쳐 에이전트가 읽는 지침 파일(예: 작업 레포의 `AGENTS.md`)에 넣는다.

```text
너는 이 작업의 coordinator다. 진행판 CLI는 셸에서 실행한다:
  set -a; . /path/to/agent-hq-core/.env; set +a
  python3 /path/to/agent-hq-core/apps/dashboard/server.py <명령>
- 시작할 때와 작업 경계마다 summary --markdown, msg list, list를 실행해 미완료 항목과 화면 요청을 확인한다.
- 작업·질문·결정은 item add/set/resolve로만 기록한다. data.json을 직접 편집하지 않는다.
- 화면 메시지는 msg read로 원문을 읽고, 처리한 뒤 msg respond로 답하고 msg process로 처리 기록을 남긴다.
- 숨김 요청은 list로 확인하고 맞으면 process-inbox --request <id>, 아니면 reject로 거절한다.
- 결정은 사용자의 명시적 답변이 있을 때만 item resolve로 해소한다. 메시지 처리·숨김은 업무 완료나 승인이 아니다.
- 명령 형식이 불확실하면 server.py <명령> --help를 먼저 본다.
```

### 3. 작업을 기록한다

예시의 HQ 번호·id는 실행할 때 출력되는 값으로 바꾼다.

```sh
hq item add work --set title="로그인 오류 수정" --set status="원인 조사 중"     # 출력의 ref가 HQ-1
hq item set HQ-1 --set status="수정 PR 검토 중" --set remaining="리뷰 반영"
hq item set HQ-1 --set state=done --set conclusion="세션 만료 처리 수정, 테스트 통과" --reason "검증 완료"
hq item add question --set q="캐시 TTL을 얼마로 둘까?" --set status="조사 중" --set category="기타"
hq item add decision --set title="배포 시점 결정" --set detail="추천: 금요일 이후(미승인)"
```

- `work`는 `title`·`status`, `question`은 `q`·`status`, `decision`은 `title`이 필수다. `state`는 `open`·`blocked`·`waiting_user`·`done`·`closed`·`dropped` 중 하나이며, `blocked`·`closed`·`dropped`에는 `--reason`, `done`에는 work의 `conclusion`이나 question의 `answer`가 필요하다.
- question의 `category`는 `PR·코드`·`에이전트 운영`·`진행 보고·알림`·`기록 관리`·`기타` 중 하나다. 긴 내용은 `--file 필드.json`(JSON object)으로 넘긴다.

### 4. 화면 요청을 처리한다

사용자는 화면에서 항목에 메시지(결정 답변·후속 질문)나 자유 메시지를 남기고, 항목 숨김을 요청한다. 에이전트는 다음 순서로 처리한다.

```sh
hq msg list                     # 아직 처리하지 않은 메시지. msgRef(예: HQ-7)와 ref(대상 항목)를 본다
hq msg read HQ-7                # 원문과 대상 항목의 현재 상태
hq lookup HQ-3                  # HQ 번호가 가리키는 항목 확인
hq item resolve HQ-3 --source HQ-7 --reason "사용자가 금요일 배포를 선택"   # 결정 답변이었을 때만
hq msg respond HQ-7 --text "반영했습니다. HQ-3을 확정으로 옮겼습니다"
hq msg process HQ-7 --note "결정 해소"
hq msg link HQ-8 --item HQ-1    # 자유 메시지를 관련 항목에 분류 연결(선택)

hq list                         # 대기 중인 숨김 요청(requestId)
hq process-inbox --request <requestId>                 # 승인해 화면에서 숨김(원본 데이터는 남는다)
hq reject --request <requestId> --reason "사용자가 요청을 철회함"
```

숨김(`process-inbox`·`reject`)은 화면 표시 여부만 정하며 업무 진행 상태와 별개다. 답변(`msg respond`)은 화면의 해당 메시지에 표시된다. 처리 기록(`msg process`)은 업무 완료·결정 승인과 별개이므로 필요한 `item set`/`item resolve`를 따로 실행한다.

### 5. (선택) Codex 즉시 알림

화면의 '지금 확인 요청' 버튼은 기본으로 기록만 남긴다. 먼저 `codex queue --help`로 쓰는 Codex CLI가 `queue` 명령을 지원하는지 확인한다. 지원할 때만 켤 수 있으며, 지원하지 않는 버전이나 다른 CLI는 아래 알림 없이 에이전트가 직접 `msg list`·`list`를 확인하는 기본 경로를 쓴다. 지원한다면 `HQ_ENABLE_CODEX_FLUSH=1`을 서버와 에이전트 셸 모두에 준다. 그러면 버튼을 누를 때 등록한 Codex thread 하나에 고정 문구를 `codex queue`로 적재한다. thread는 `CODEX_HOME/session_index.jsonl`에 있는 실제 session UUID여야 한다.

```sh
hq flush register --provider codex --thread <Codex session UUID> --evidence "이 대화에서 확인한 근거"
hq flush status                 # 요청 기록과 적재 결과
hq flush done --id <flushId> --note "요청함 처리 완료"
```

적재는 해당 대화의 입력 큐에 들어갔다는 뜻일 뿐이며, 처리 여부는 에이전트가 `flush done`으로 남긴 기록으로 판단한다. 다른 CLI에는 알림을 보내지 않으므로, 그때는 에이전트가 작업 경계마다 직접 `msg list`·`list`를 확인한다.

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
