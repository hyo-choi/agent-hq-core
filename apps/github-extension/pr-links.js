// PR 목록의 각 행과 PR 상세 머리글에 그 PR에 연결된 진행판 항목(HQ 번호·상태)을 표시한다.
// 진행판은 직접 부르지 않고 sw.js에 묻는다. 페이지에는 textContent로만 쓴다.
// ponytail: data-testid·data-component·클래식 클래스는 GitHub의 공개 계약이 아니다. 바뀌면 표시만 사라진다.
(() => {
  const configuredOwner = globalThis.AGENT_HQ_OWNER;
  if (!configuredOwner) return;
  const ATTR = "data-agent-hq-pr-links";
  const TITLE = 'a[data-testid="listitem-title-link"]';
  const LIST_PATH = new RegExp(`^/${configuredOwner}/[^/]+/pulls(/|$)`, "i"); // lib.js validateLinksRequest가 받는 페이지와 같다
  const PR_PATH = new RegExp(`^/(${configuredOwner})/([^/]+)/pull/([1-9][0-9]*)(/|$)`, "i");
  const TTL_MS = 60000;
  const FAIL_TTL_MS = 10000; // 실패는 짧게 두고 DOM 변경이 없어도 다시 묻는다
  const LIST_MAX = 3;
  const NOTE = "진행판 실행 데이터의 스냅샷이며, 에이전트 실행 상태의 실시간 표시가 아닙니다.";
  const results = new Map(); // PR url(소문자) → { at, r }
  let inflight = false;

  const prUrl = (href) => {
    let u;
    try {
      u = new URL(href, location.href);
    } catch {
      return null;
    }
    const m = u.origin === "https://github.com" && PR_PATH.exec(u.pathname);
    return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`.toLowerCase() : null;
  };

  function request(urls) {
    inflight = true;
    const done = (res) => {
      const at = Date.now();
      const byUrl = new Map((res?.ok ? res.links : []).map((l) => [l.url.toLowerCase(), l]));
      for (const u of urls) {
        const l = byUrl.get(u);
        results.set(u, { at, r: l ? { ok: true, snap: res.at, ...l } : { ok: false, error: res?.error || "진행판 응답을 받지 못했습니다" } });
      }
      inflight = false;
      if (!res?.ok) setTimeout(scan, FAIL_TTL_MS + 100);
      scan();
    };
    try {
      chrome.runtime.sendMessage({ type: "pr-links", urls }).then(done, () => done({ ok: false, error: "확장과 연결이 끊겼습니다. 페이지를 새로고침해 주세요." }));
    } catch {
      done({ ok: false, error: "확장과 연결이 끊겼습니다. 페이지를 새로고침해 주세요." }); // 확장을 새로고침하면 이 스크립트의 연결이 끊긴다
    }
  }

  const span = (text, css, title) => {
    const s = document.createElement("span");
    s.textContent = text;
    s.style.cssText = css;
    if (title) s.title = title;
    return s;
  };
  const MUTED = "color:var(--fgColor-muted,#59636e)";
  const CHIP = "display:inline-block;margin-left:6px;padding:0 6px;font-size:12px;line-height:18px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;white-space:nowrap;text-decoration:none;vertical-align:middle;";

  function build(r, detail) {
    const box = document.createElement(detail ? "div" : "span");
    box.setAttribute(ATTR, "");
    box.style.cssText = detail ? "margin-top:6px;font-size:12px" : "font-size:12px";
    box.addEventListener("click", (e) => e.stopPropagation()); // 목록 행의 클릭 처리로 번지지 않게 한다
    if (detail) box.append(span("HQ 연결", MUTED + ";font-weight:600", NOTE));
    if (!r.ok) return box.append(span("HQ 조회 실패", CHIP + MUTED, r.error)), box;
    if (!r.registered) return box.append(span("HQ 미등록", CHIP + MUTED, "진행판에 등록되지 않았거나 숨긴 PR입니다.")), box;
    if (!r.items.length) return box.append(span("HQ 연결 없음", CHIP + MUTED, "이 PR에 연결된 작업·질문·결정이 없습니다.")), box;
    const snap = r.snap ? `\n진행판 기록 ${new Date(r.snap).toLocaleString("ko-KR", { hour12: false })} 기준. ${NOTE}` : `\n${NOTE}`;
    const shown = detail ? r.items : r.items.slice(0, LIST_MAX);
    for (const it of shown) {
      const a = document.createElement("a");
      a.href = it.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = `${it.ref || "번호 없음"} ${it.kind} · ${it.state}`;
      a.title = `${it.title}${snap}`;
      a.style.cssText = CHIP + (it.finished ? MUTED : "color:var(--fgColor-accent,#0969da)");
      box.append(a);
    }
    if (shown.length < r.items.length) box.append(span(`외 ${r.items.length - shown.length}건`, "margin-left:6px;" + MUTED, r.items.slice(LIST_MAX).map((it) => `${it.ref || "번호 없음"} ${it.title}`).join("\n")));
    return box;
  }

  // 자리마다 표시가 정확히 하나이고 지금 결과와 같으면 손대지 않는다(관찰자가 다시 부르므로 반복 쓰기를 막는다)
  function place(slot, url, detail, keep) {
    const got = results.get(url);
    if (!got) return;
    const key = `${url}|${JSON.stringify(got.r)}`;
    const cur = slot.find();
    if (cur?.dataset.key === key) return keep.add(cur);
    cur?.remove();
    const el = build(got.r, detail);
    el.dataset.key = key;
    slot.put(el);
    keep.add(el);
  }

  function scan() {
    const keep = new Set();
    const want = [];
    const visit = (url, slot, detail) => {
      const got = results.get(url);
      if (!got || Date.now() - got.at > (got.r.ok ? TTL_MS : FAIL_TTL_MS)) want.push(url);
      place(slot, url, detail, keep);
    };
    if (LIST_PATH.test(location.pathname)) {
      const here = `https://github.com${location.pathname.split("/").slice(0, 3).join("/")}/pull/`.toLowerCase();
      for (const link of document.querySelectorAll(TITLE)) {
        const box = link.closest("[data-listview-item-title-container]");
        const url = prUrl(link.href);
        if (!box || !url || !url.startsWith(here)) continue; // 이슈 목록도 같은 마크업을 쓴다. 다른 레포 PR은 서비스 워커가 거절한다
        visit(url, { find: () => box.querySelector(`[${ATTR}]`), put: (el) => box.append(el) }, false);
      }
    } else {
      const url = PR_PATH.test(location.pathname) && prUrl(location.href);
      const desc = document.querySelector('header[data-component="SplitPageLayout.Header"] [data-component="PageHeader.Description"]');
      const meta = !desc && document.querySelector(".gh-header-meta"); // 변경 파일 탭은 클래식 머리글이다
      const anchor = desc || meta;
      if (url && anchor) {
        const near = () => (desc ? desc.querySelector(`:scope > [${ATTR}]`) : meta.nextElementSibling?.matches(`[${ATTR}]`) ? meta.nextElementSibling : null);
        visit(url, { find: near, put: (el) => (desc ? desc.append(el) : meta.after(el)) }, true);
      }
    }
    for (const el of document.querySelectorAll(`[${ATTR}]`)) if (!keep.has(el)) el.remove(); // 페이지 이동·행 재사용으로 남은 표시
    if (want.length && !inflight) request([...new Set(want)].slice(0, 100)); // lib.js LINKS_MAX
  }

  // GitHub는 페이지 이동을 문서 교체 없이 하고 행도 다시 그린다
  let timer = null;
  new MutationObserver(() => {
    timer ??= setTimeout(() => {
      timer = null;
      scan();
    }, 150);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href"] });
  scan();
})();
