# Agent HQ 요청 확장

선택한 GitHub owner의 PR 목록·상세·댓글, 선택적으로 Jira 티켓에서 로컬 진행판으로 메시지를 보낸다. GitHub/Jira를 수정하거나 git 명령을 실행하지 않는다. 스토어 배포 없이 Chrome의 Load unpacked로 설치한다.

## 구성과 설치

먼저 루트 README대로 진행판을 빌드하고 `init`한다. 그다음 자신의 진행판 origin, GitHub owner 하나, 선택적 Jira 주소로 설치 폴더를 만든다.

```sh
node apps/github-extension/configure.mjs \
  --api http://127.0.0.1:48173 \
  --owner example-org \
  --jira https://example.atlassian.net
```

`--jira`는 생략하면 비활성이다. `--api`는 사용자 정보·경로·query·hash 없는 http(s) origin이며, owner는 GitHub 계정/조직 이름 하나다. 서버의 실제 bind·alias·포트와 일치시킨다. 기본 소스의 설정은 비어 있어 popup에 명확한 오류를 표시하고 HTTP 요청을 보내지 않는다. 개인 서버로 향하는 fallback은 없다.

1. 출력된 `apps/github-extension/local/extension` 폴더를 `chrome://extensions`의 개발자 모드에서 Load unpacked로 설치한다. 기본 출력 폴더는 `.gitignore`에 포함된다. `--out <비어있는폴더>`로 다른 위치를 쓸 수도 있으며 생성한 개인 설정을 커밋하지 않는다.
2. Chrome에 표시된 자신의 확장 ID를 읽는다. manifest에 `key`가 없으므로 폴더 이동 등으로 ID가 달라질 수 있다.
3. 서버에 exact origin을 등록한다. `python3 apps/dashboard/server.py serve --ext-origin chrome-extension://<자기확장ID>`로 시작하거나 기존 인자를 유지해 재시작한다. 기본 허용 목록은 비어 있으며 옵션은 반복할 수 있다.
4. 알림도 쓴다면 루트 README대로 provider별 opt-in과 coordinator 등록을 별도로 한다. 등록이 없으면 메시지만 보낼 수 있고 알림 선택은 비활성이다.
5. GitHub 탭에서 확장을 열어 서버·대상을 확인하고 합성 메시지로 시험한다. Jira는 `/browse/<키>` 또는 `?selectedIssue=<키>`만 지원한다.

설정을 바꾸려면 새 빈 출력 폴더를 지정하거나 자신이 만든 기존 출력 폴더를 정리한 뒤 다시 구성한다. 생성기는 비어 있지 않은 폴더를 덮어쓰지 않는다. manifest/service worker를 바꾸면 확장을 reload하고, content script를 바꾸면 대상 GitHub 탭도 reload한다. ID가 바뀌면 서버에서 옛 origin을 제거하고 새 ID를 등록한다. 쓰던 초안·재시도 키는 reload 전에 보내거나 따로 보관한다.

## 동작과 경계

- PR popup은 저장된 PR URL과 탭의 owner/repo/번호가 같은 경우에만 등록 PR로 보고, 해당 번호가 `prs`에 있는 작업·질문·미결 결정을 연결 대상으로 표시한다. 미등록 PR은 출처 URL을 담은 자유 메시지로 보낸다. 등록된 PR의 카드 자체도 선택할 수 있다.
- 설정한 owner의 목록에서 로그인 사용자와 작성자가 일치하는 PR 옆에 `HQ` 버튼을 넣는다. PR 상세와 목록에는 연결 항목의 번호·종류·제목·상태와 기록 시각만 표시하고 메시지 원문·flush·숨김 정보를 페이지에 넘기지 않는다. service worker가 sender id/origin/frame/tab와 같은 레포 여부를 검사하고 공개 dashboard GET만 읽는다.
- 댓글 버튼은 해당 PR의 permalink와 현재 보이는 글을 읽고, 최대 500자의 인용을 글자로만 보여 준다. 페이지가 호출한 합성 click은 거절하고 실제 사용자 클릭에서만 popup을 연다. GitHub DOM 선택자는 공개 API 계약이 아니어서 화면 구조가 바뀌면 버튼/표시가 사라질 수 있다.
- 리베이스·리뷰 처리 버튼은 입력칸에 일반 요청 문구를 채울 뿐이다. 자동 전송·실행·push 승인 없이 사용자가 내용을 확인해 보내며 원격 반영은 현재 작업의 권한 범위에 따른다.
- Jira는 activeTab으로 URL의 키만 읽고 content script나 Jira API를 사용하지 않는다. 티켓 키·정규형 주소를 담은 자유 메시지로 보내며 자동 연결하지 않는다. 실제 로그인된 Jira 화면과 SPA 이동은 별도 실사용 검증이 필요하다.
- '지금 확인 요청도 보내기'는 등록된 coordinator가 있으면 기본으로 켜진다. 메시지 접수 성공 뒤에만 flush를 보낸다. 메시지·알림 실패는 구분하고, 접수·적재를 처리 완료나 승인으로 표시하지 않는다. 처리 기록은 coordinator가 CLI로 남긴다.

항목의 `prs`는 번호만 저장하므로 여러 레포의 같은 PR 번호를 함께 표현할 수 없다. URL 일치 검증으로 그 모델의 충돌 한계까지 해결하지는 않는다. 연결 표시는 스냅샷이며 실시간 에이전트 실행 상태가 아니다. service worker는 성공한 GET을 30초 캐시하고 페이지 표시는 60초 후 갱신한다. 서버의 PR 자동 조회는 `HQ_GITHUB_REPO` opt-in을 준 경우에만 동작한다.

## 이미지와 재시도

PNG/JPEG/WebP를 장당 5MiB, 최대 6장 붙여 넣거나 파일로 선택한다. 미리보기에서 제거할 수 있고 글 없이 이미지만 보내도 Jira 키·주소, PR 카드 외 대상의 PR 주소, 댓글 permalink·인용을 보존한다. 파일과 미리보기 URL은 popup 메모리에만 있으며 닫으면 사라진다. 이미지 옆 `(?)`는 hover/focus, 클릭 고정, Escape/바깥 누르기로 조작한다.

텍스트 초안과 텍스트 전송 키는 `storage.session`에 남는다. 동일 내용의 재시도는 같은 messageId를 쓰고, 응답을 잃은 채 다시 열면 서버에 접수됐는지 확인해 남은 flush만 이어 보낸다. 이미지 전송은 popup이 열려 있는 동안만 업로드 키·id를 보존하며 편집 없는 재시도는 같은 payload를 쓴다. 내용·대상·첨부를 고치면 새 키로 보존한 File을 다시 올린다. 서버가 원래 메시지를 접수한 뒤 응답만 잃었다면 고친 메시지와 원래 메시지가 둘 다 남을 수 있다. popup을 닫은 뒤에는 이미지 재시도와 남은 flush를 자동 복구하지 못하므로 진행판에서 접수 여부를 먼저 확인한다.

업로드·메시지 POST는 같은 서버 검증과 용량·시간·동시성 제한을 거친다. Origin 등록은 브라우저 CSRF 경계이며 인증이 아니다. 등록된 확장에서도 숨김 요청은 403이고 중복 Origin 헤더도 거절한다. 서버에 `--ext-origin`이 빠졌다면 등록할 origin을 오류로 안내한다.

## 권한

| 권한 | 용도 |
| --- | --- |
| activeTab | 사용자가 연 탭의 URL 읽기. Jira용 host permission/content script 없음 |
| storage | 브라우저 세션 동안 텍스트 초안과 재시도 키 저장 |
| 설정한 GitHub owner의 content script match | 목록/댓글 버튼과 PR 연결 표시 |
| 설정한 진행판 origin의 host permission | dashboard GET과 메시지·업로드·flush POST |

GitHub 전체 host permission, web accessible resources, externally connectable, clipboard 권한을 추가하지 않는다. 미리보기는 로컬 blob URL만 사용한다.

## 테스트와 Chrome for Testing

```sh
node --test apps/github-extension/*.test.mjs
# Chrome for Testing은 별도 설치하거나 기존 테스트용 실행 파일을 지정한다.
# 필요할 때: pnpm dlx @puppeteer/browsers install chrome@<버전> --path <테스트용폴더>
node apps/github-extension/e2e.mjs "<Chrome for Testing 실행 파일>" [스크린샷폴더]
```

E2E는 loopback의 빈 포트를 bind로 확인하고 임시 HOME·ROOT·Chrome 프로필·구성된 확장을 만든다. 가짜 gh/codex와 합성 GitHub/Jira 응답을 사용하며 사용자의 Chrome과 운영 데이터는 건드리지 않는다. 확장 ID는 실행 중 Chrome에서 읽는다. 미설정 HTTP 요청 0건, 미등록 403, 등록 후 전송·이미지·알림, 숨김 거절, 실제 DOM 클릭·초안·재시도·출처·안내 상호작용을 검증한다. 계정 로그인, OS clipboard 단축키, 네이티브 파일 대화상자, 물리 터치 장치의 검증을 대신하지 않는다.
