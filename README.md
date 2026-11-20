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
| `HQ_GITHUB_REPO` | 없음 | `owner/name`. 지정하면 `data.prs`의 PR을 `gh pr view`로 읽기 전용 조회(화면 요청 시 5분 간격, 또는 `python3 refresh_prs.py`)하고 PR 링크를 만든다. 저장된 GitHub PR url이 있으면 그 레포로 조회하고, 이 값은 url이 없거나 GitHub가 아닌 url의 PR에 쓴다. `gh` 로그인이 필요하다 |
| `HQ_JIRA_PROJECT` | 없음 | Jira 프로젝트 키. 지정하면 `import-jira FILE`로 미리 받아 둔 조회 스냅샷 파일을 가져온다(서버가 Jira를 호출하지는 않는다). 형식은 [Jira 스냅샷](#jira-스냅샷)을 본다 |
| `HQ_ENABLE_CLAUDE_FLUSH` | 없음 | 정확히 `1`일 때만 등록한 Claude 세션의 inbox socket으로 고정 알림을 보낸다. Codex 설정과 독립적이다 |
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
- 작업·질문·결정은 item add/set/resolve로만 기록한다. data.json을 직접 편집하지 않는다. 추천과 PR 등록은 README의 '추천과 PR 등록' 절차로만 쓴다.
- 화면 메시지는 msg read로 원문을 읽고, 처리한 뒤 msg respond로 답하고 msg process로 처리 기록을 남긴다. 실행할 요청은 기존 또는 새 항목에 연결해 자유 메시지에만 남기지 않는다.
- 숨김 요청은 list로 확인하고 맞으면 process-inbox --request <id>, 아니면 reject로 거절한다.
- 결정은 사용자의 명시적 답변이 있을 때만 item resolve로 해소한다. 메시지 처리·숨김은 업무 완료나 승인이 아니다.
- 작업이 정상 진행되지 않으면 원인을 조사하고 안전한 복구를 시도한 뒤 근거와 함께 보고한다. 재시도는 접근을 바꿀 때만 한다.
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

### 5. (선택) 즉시 알림과 자기 등록

기본값은 외부 전달 없음이다. Codex는 `HQ_ENABLE_CODEX_FLUSH=1`, Claude는 별도로 `HQ_ENABLE_CLAUDE_FLUSH=1`을 서버와 에이전트 셸에 준다. 어느 설정도 다른 provider를 켜지 않는다. 등록을 저장한 뒤 서버를 설정 없이 재시작해도 외부로 전달하지 않는다. 한 번에 coordinator 한 세션만 등록하며 새 등록은 이전 등록을 교체한다.

Codex는 먼저 `codex queue --help`로 CLI의 지원 여부를 확인한다. `--self`는 `CODEX_THREAD_ID`를 읽고 `CODEX_HOME/session_index.jsonl`에서 그 UUID를 확인한다. 환경변수가 없거나 지원하지 않는 CLI에서는 명시 등록이나 수동 요청함 확인을 쓴다. `CODEX_SESSION_ID`만 있는 환경은 자기 등록으로 판정하지 않는다.

```sh
hq flush register --self
# Codex 자기 등록을 쓸 수 없을 때:
hq flush register --provider codex --thread <자기 session UUID> --evidence "현재 대화에서 확인한 근거"
hq flush status
hq flush done --id <flushId> --note "요청함 처리 결과"
hq flush unregister
```

Claude는 실행 중인 자기 세션에서 `--self`로만 등록한다. `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`이 모두 필요하며 현재 사용자가 소유한 Unix socket을 확인한다. Claude와 Codex 환경변수가 함께 있으면 추측하지 않고 실패하므로 `--self --provider claude` 또는 `--self --provider codex`를 명시한다.

Claude 전달은 내부 inbox 형식에 기대는 과도기 구현이며 수신 확인(ack)이 없다. `queued`는 socket에 썼다는 뜻으로 읽음·처리 성공을 보장하지 않는다. 공식 전달 CLI/API가 생기면 이 경로를 교체한다. 버전 변경·세션 재개 뒤에는 재등록과 확인이 필요하며 PID 재사용으로 다른 세션에 전달될 가능성도 남는다. 토큰은 CLI/HTTP 응답에는 숨기지만 `private/flush.json`과 JSON 백업에는 남으므로 함께 보호한다. Codex도 적재와 처리는 구분하며 처리 완료는 coordinator의 `flush done` 기록으로 판단한다.

서버는 같은 등록 이후의 `queued`/`sending`만 열린 요청으로 본다. 공개 `flush.recent[].active`와 화면 버튼도 이 판정을 공유하므로 같은 이름으로 재등록해도 이전 요청이 새 버튼을 막지 않는다. 60초 재요청 대기는 이전 요청을 포함해 유지한다.

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

## 파생 관계와 긴 본문

`derivedFrom`은 파생 항목 하나에 원본의 내부 id를 저장한다. `item add`와 `item set`에서 HQ 번호 또는 내부 id를 받으며, `item get`은 역방향 `derivedItems`를 계산한다. 메시지의 분류에는 기존 `msg link`를 쓴다.

```sh
hq item add question --set q="후속 검토" --set status="조사 중" --set derivedFrom=HQ-1
hq item get HQ-1
hq item set <파생항목> --set derivedFrom=       # 연결 해제
```

자기 연결·순환·없는 대상·PR을 원본으로 지정하는 것은 거절한다. 숨긴 원본은 유지하고 화면에서는 이동할 수 없는 이유를 안내한다. 관계는 이동용이며 승인·업무 상태를 전파하지 않는다. `check`는 없어진 원본을 경고한다.

긴 설명은 Markdown `###` 단위로 접는다. `해 주실`, `확인해 주실`, `정해 주실`, `필요한 결정`, `추천`, `선택지`, `막힌 이유`, `주의하실`, `꼭 확인`, `머지 전에`, `위험`, `알아 두실`, `필요한 선택`, `우선 결정`, `다음 행동`이 제목에 있거나 하위 제목에 있으면 기본으로 펼친다. 그 밖의 섹션과 검증 전체는 기본 접힘이다. 한국어 화면의 안내 정책이며 `확인 N` 배지는 이런 섹션 수를 세므로 미처리 업무 수와 다르다. 소제목 앞 글은 항상 보이고 검색 중에는 관련 본문이 펼쳐진다. 사용자 선택은 세션 동안 유지하고 '상세 모두 닫기'로 본문도 닫는다. 같은 제목 앞에 같은 제목을 삽입하면 저장된 접힘 상태가 밀릴 수 있다.

## 메시지 이미지와 캡처

메시지 입력에서 파일 선택·붙여 넣기·끌어다 놓기로 PNG/JPEG/WebP를 장당 5MiB, 최대 6장 첨부한다. 이미지 옆 `(?)`는 hover·focus로 열고 클릭으로 고정하며 Escape·바깥 누르기로 닫는다. 이미지 초안은 새로고침하면 사라지고 텍스트 초안만 유지된다. 전송 실패 뒤 편집 없이 재시도하면 같은 메시지·업로드 키를 쓰며, 편집하면 보존한 File을 새 키로 다시 올린다. 응답을 잃은 뒤 편집하면 원래 접수된 메시지와 새 메시지가 둘 다 남을 수 있다. 처리된 메시지 묶음은 계속 조회할 수 있다.

업로드와 메타데이터는 `HQ_DASH_ROOT/private/uploads/`에 저장한다. 전체 한도는 256MiB이며 메시지에 연결한 이미지는 생성 후 14일, 미연결 이미지는 1일 뒤 정리한다. 서버 시작·업로드 때 정리하므로 만료 즉시 파일을 지우는 예약 작업은 없다. 만료 뒤에도 메시지 원문·첨부 id·형식·크기는 남고 '보관 기간이 지나 삭제됨'으로 표시한다. 이미지 파일과 업로드 메타데이터 자체는 JSON 백업/복원 대상이 아니다. `msg read`는 유효한 첨부의 로컬 절대 경로를 보여 준다. 형식은 magic bytes만 검사하며 완전한 디코딩·재인코딩은 하지 않는다.

`HQ_DASH_ROOT/captures/<폴더>/`에 신뢰하는 로컬 작성자가 만든 캡처를 놓으면 `/captures/<폴더>/`의 `index.html` 또는 그 안의 단일 파일을 읽기 전용으로 제공한다. 허용 확장자는 html/png/jpg/jpeg/webp/gif/json이고 폴더·파일 이름은 ASCII 영숫자·하이픈·밑줄로 시작하는 128자 이하 이름이다. HTML은 `sandbox allow-scripts`로 제공해 opaque Origin이 되며 진행판 POST가 거절된다. symlink 경로 탈출은 거절하지만 하드 링크로 놓은 파일은 읽을 수 있다. 신뢰하지 않는 로컬 작성자를 격리하는 기능은 아니며 계정·토큰·서명 URL·개인 자료가 보이는 캡처를 두지 않는다. 파일 전체를 메모리로 읽고 동시 캡처 GET 수에는 별도 제한이 없다.

이미지 업로드는 동시에 4건이며, 요청 본문 읽기와 응답 전송에는 유휴 20초·전체 120초 제한을 둔다. 정상 진전은 유휴 시간을 갱신하지만 전체 마감은 연장하지 않는다. 느린 이미지 전송은 전역 데이터 lock 밖에서 수행한다. 슬롯에는 사용자별 공정성이 없으며 인증·rate limit을 제공하지 않는다.

## 브라우저 확장

GitHub owner 하나와 선택적 Jira 사이트를 설정하는 unpacked 확장이다. 기본 소스는 URL/owner가 비어 있고 어떤 기본 서버로도 요청하지 않는다. 설치자별 설정과 manifest를 함께 생성한다. [설치·권한·한계](apps/github-extension/README.md)를 따른다.

```sh
node apps/github-extension/configure.mjs --api http://127.0.0.1:48173 --owner example-org
# 생성한 apps/github-extension/local/extension을 Load unpacked로 설치한 뒤 자기 ID 확인
python3 apps/dashboard/server.py serve --ext-origin chrome-extension://<자기확장ID>
```

생성 폴더는 Git에서 제외하며 key를 넣지 않는다. 서버의 확장 허용 목록은 기본 비어 있고 exact origin만 메시지·업로드·flush POST에 허용한다. 숨김 요청은 계속 거절한다. 경로가 바뀌어 ID가 달라지면 이전 origin을 제거하고 새 ID를 등록한다. 알림은 별도의 provider opt-in과 coordinator 등록이 필요하다.

## 명령이 없는 데이터 쓰기

`item` 명령은 작업·질문·결정만 쓴다. 다음 할 일 추천과 PR 목록은 전용 명령이 없으므로, `data.json`을 편집기로 고치지 말고 아래처럼 파일 락 아래에서 해당 키만 바꾼다. 편집기로 직접 고치면 PR 자동 조회의 쓰기와 엇갈릴 수 있다. 모든 예시는 `apps/dashboard`에서 실행한다.

### 추천과 PR 등록

**다음 할 일 추천(`data.recommendations`).** 홈 화면에 순서대로 최대 5개를 표시한다. coordinator가 직접 관리하는 데이터이며 자동으로 만들어지거나 항목 상태와 동기화되지 않는다.

```json
{
  "updatedBy": "coordinator",
  "note": "오늘 기준 추천",
  "items": [{
    "id": "rec-login",
    "title": "로그인 수정 PR부터 확인",
    "why": "다른 작업이 기다린다",
    "action": "PR을 확인한다",
    "decision": null,
    "prs": [123],
    "jira": ["PROJ-1"],
    "related": ["w-1a2b3c4d"]
  }]
}
```

```sh
python3 - recs.json <<'PY'
import json, sys
from server import DATA, load_json, locked, now, write_json
with open(sys.argv[1], encoding="utf-8") as f:
    recs = json.load(f)
recs["updatedAt"] = now()
with locked():
    data = load_json(DATA)
    data["recommendations"] = recs
    write_json(DATA, data)
PY
```

- `decision`에 내용을 적으면 "사용자 결정 필요"로 표시한다. 필요 없으면 `null`이다.
- `related`(선택)는 관련 항목의 내부 id(`w-`, `q-`, `d-`, `pr-<번호>`) 목록이다. 카드의 버튼을 누르면 해당 항목으로 이동한다. 제목에서 추측하지 않으므로 `server.py lookup HQ-n`으로 확인한 id를 적는다. 숨김이나 merged로 목록에 없는 항목은 이유만 안내하고 되살리지 않는다.
- `prs`가 있고 모두 조회 성공·merged이면 끝난 추천으로 보고 카드에서 뺀다. 그 밖의 추천은 coordinator가 정리한다. 추천을 눌러도 이동만 하며 작업을 시작하지 않는다.

**PR 등록(`data.prs`).** 키는 PR 번호 문자열이다. 등록하면 다음 조회부터 포함된다.

```sh
python3 - <<'PY'
from server import DATA, load_json, locked, write_json
with locked():
    data = load_json(DATA)
    data.setdefault("prs", {})["123"] = {"number": 123, "title": "로그인 오류 수정", "state": "OPEN", "url": "https://github.com/owner/name/pull/123"}
    write_json(DATA, data)
PY
```

작업 카드에 PR을 표시하려면 항목의 `prs`에 번호를 넣는다. 파일 내용은 `{"prs": [123]}`이고 명령은 `server.py item set HQ-1 --file prs.json`이다.

- 조회는 `HQ_GITHUB_REPO`를 설정했을 때만 동작한다. 저장된 url이 GitHub PR url이면 그 레포로 조회하고, url이 없거나 GitHub가 아닌 http(s) url이면 `HQ_GITHUB_REPO`로 조회한다.
- 응답의 레포가 저장된 레포와 다르거나, 저장된 url의 레포와 번호를 확정할 수 없으면(`https://github.com/owner/name/pull/<키와 같은 번호>` 형식이 아니고 GitHub가 아닌 http(s) url도 아닌 경우, 또는 url에 userinfo(`@`)가 있는 경우) 덮어쓰지 않는다. 마지막 관찰값을 남기고 조회 실패로 표시한다. 레포를 옮기거나 이름을 바꾸면 url을 고칠 때까지 실패로 보인다.
- 키가 번호뿐이므로 서로 다른 레포의 같은 번호 PR은 함께 등록할 수 없다.

### Jira 스냅샷

서버는 Jira를 호출하지 않는다. 사용자가 조회한 결과를 아래 형식으로 저장해 `HQ_JIRA_PROJECT=PROJ python3 server.py import-jira jira.json`으로 가져온다. 시간이 지나도 관찰 시각은 그대로이며, 새로 조회하면 같은 명령을 다시 실행한다.

```json
{
  "observedAt": "2026-01-05T10:00:00+09:00",
  "site": "https://example.atlassian.net",
  "scope": "project = PROJ AND assignee = currentUser() AND statusCategory != Done",
  "isLast": true,
  "sprintField": "customfield_10001",
  "issues": [{
    "key": "PROJ-1",
    "summary": "로그인 문구 수정",
    "status": "IN PROGRESS",
    "priority": "High",
    "project": "PROJ",
    "due": null,
    "issueType": "Story",
    "isSubtask": false,
    "parentKey": null,
    "sprints": [{"id": 1, "name": "Sprint 1", "state": "active", "startDate": "2026-01-01", "endDate": "2026-01-14"}]
  }]
}
```

- 다음과 같은 스냅샷은 통째로 거절하며 기존 `data.jira`를 유지한다.
  - `isLast`가 `true`가 아닌 부분 조회 결과.
  - `site`가 `https://<이름>.atlassian.net` 형식이 아닌 경우.
  - `sprintField`(실제 확인한 Sprint 필드 ID, `customfield_<숫자>`)나 `observedAt`을 읽을 수 없는 경우.
  - `HQ_JIRA_PROJECT` 이외 프로젝트의 티켓이 섞인 경우.
  - 티켓에 `sprints` 목록이 없는 경우. 빈 목록만 "Sprint 없음"으로 본다.
- `isSubtask`·`issueType`·`parentKey`는 함께 쓰는 선택 필드다. 없으면 "유형 미확인"으로 표시한다.
- 화면용 데이터에는 최소 필드만 저장한다. 그 밖의 필드와 계정 정보는 옮기지 않는다.

## 백업과 복원 점검

- 모든 쓰기는 그날 완료된 백업이 없으면 쓰기 직전에 `backups/`에 스냅샷을 만든다. `python3 server.py backup`으로 수동 실행도 할 수 있다. 자동 삭제는 없으며, 같은 디스크에 저장하므로 디스크 고장에는 대비하지 못한다.
- 복원 점검은 다음 명령으로 하며 **운영 데이터를 바꾸지 않는다.**

```sh
python3 server.py restore --backup "$HQ_DASH_ROOT/backups/<이름>" --out <비어 있는 새 디렉터리>
```

- 백업의 무결성을 확인한 뒤 현재 파일과 병합한 결과를 출력 디렉터리의 `public/data.json`, `private/*.json`, `restore-report.json`에 만든다.
- 백업 파일의 크기나 해시가 manifest와 다르거나 병합 충돌이 있으면 중단한다.
- 현재 파일이 없거나 손상됐으면 중단하지 않고 백업 값으로 결과를 만든다. 백업 이후의 변경은 복구되지 않을 수 있으며, 그 내용을 `restore-report.json`의 `currentProblems`와 `notes`에 남긴다. 정상 종료만 보지 말고 보고서를 확인한다.
- 실제 반영은 이 명령이 하지 않는다. 보고서를 확인한 뒤 서버를 멈추고 별도로 진행한다.

## 보안 모델

- 기본 정적 화면은 `/`·`/index.html`만 허용하고 별도 검증한 첨부·캡처 GET을 제공한다. 데이터 파일은 `GET /api/dashboard` 응답으로만 나간다.
- JSON POST는 고정 Origin 허용 목록과 `Sec-Fetch-Site`, `application/json`, 16KiB 본문 제한을 검사한다. 등록 확장은 메시지·업로드·flush만 예외로 허용한다. raw 이미지 업로드는 5MiB까지다. 중복 Origin·Content-Length 및 Transfer-Encoding을 거절하며 응답에 CSP를 붙인다. Origin은 브라우저 CSRF 경계로, 비브라우저 클라이언트 인증 수단은 아니다.
- 인증 기능은 없다. 신뢰하는 장치에서 loopback이나 사설 tailnet에만 띄운다.

## 테스트

```sh
cd apps/dashboard
pnpm build && pnpm test          # 화면 빌드·vitest
python3 test_server.py           # 서버·CLI (먼저 pnpm build 필요). 임시 ROOT/HOME, 가짜 gh·codex·socket만 사용
node --test ../github-extension/*.test.mjs
```

## 운영 지침 템플릿 (선택)

`templates/`에는 coordinator 에이전트용 일반 지침 예시(`AGENTS.example.md`)와 작업 문서 양식(`task.md`)이 있다. 진행판 동작은 이 템플릿에 의존하지 않으므로 쓰지 않아도 되고, 필요에 맞게 고쳐 쓴다.

## 라이선스

MIT. 전문은 [LICENSE](LICENSE)를 본다.
