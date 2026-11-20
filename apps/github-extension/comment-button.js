// PR 상세의 댓글마다 popup을 여는 버튼을 넣는다. 진행판 데이터를 읽거나 페이지에 쓰지 않고, GitHub에 댓글을 쓰지 않는다.
// ponytail: GitHub 클래식 타임라인의 permalink(a.js-timestamp#<id>-permalink)와 .comment-body에 기댄다합성 검증 기준. 공개 계약이 아니라 바뀌면 버튼만 사라진다
(() => {
  const configuredOwner = globalThis.AGENT_HQ_OWNER;
  if (!configuredOwner) return;
  const ATTR = "data-agent-hq-comment-button";
  const ANCHOR = 'a.js-timestamp[id$="-permalink"]';
  const ID = /^(issue-[1-9][0-9]*|issuecomment-[1-9][0-9]*|pullrequestreview-[1-9][0-9]*|discussion_r[1-9][0-9]*)-permalink$/; // lib.js COMMENT_ID와 같다
  const PR_PATH = new RegExp(`^/(${configuredOwner}/[^/]+/pull/[1-9][0-9]*)(/|$)`, "i"); // lib.js validateCommentRequest가 받는 페이지
  const QUOTE_MAX = 500; // lib.js QUOTE_MAX와 같다
  const LABEL = "이 댓글로 Agent HQ 요청 쓰기";
  const FAILED = "popup을 열지 못했습니다. 페이지를 새로고침해 주세요.";

  const owner = new WeakMap(); // 버튼 → 넣을 때의 PR
  const live = new WeakSet(); // 복원된 스냅샷의 복제 버튼에는 리스너가 없다
  const PR_ATTRS = '[data-url*="/pull/"],[action*="/pull/"],[src*="/pull/"]';
  const prOf = () => PR_PATH.exec(location.pathname)?.[1] || null;
  const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const hasText = (a) => !!bodyOf(a)?.textContent.trim();

  // 댓글이 속한 frame(없으면 문서)의 PR. 타임라인과 같은 frame의 data-url·action·src가 /<레포>/pull/<번호>/...를 가리킨다합성 검증 기준.
  // GitHub는 주소와 DOM을 따로 바꾸므로(순서도 경우마다 다르다), 이것이 지금 주소의 PR과 같을 때만 버튼을 두고 보낸다. 못 찾으면 넣지 않는다
  function domPrOf(a, cache = new Map()) {
    const root = a.closest("turbo-frame") || document;
    if (!cache.has(root)) {
      let pr = null;
      for (const e of root.querySelectorAll(PR_ATTRS)) {
        try {
          pr = PR_PATH.exec(new URL(e.getAttribute("data-url") || e.getAttribute("action") || e.getAttribute("src"), location.origin).pathname)?.[1] || null;
        } catch {}
        if (pr) break;
      }
      cache.set(root, pr);
    }
    return cache.get(root);
  }

  // 리뷰는 요약 본문만 읽는다. 그 안의 리뷰 코멘트는 각자 버튼이 있다
  function bodyOf(a) {
    const scope = a.closest(".timeline-comment, .review-comment") || document.getElementById(a.id.replace(/-permalink$/, ""));
    return [...(scope?.querySelectorAll(".comment-body") || [])].find((b) => !b.closest('[id^="discussion_r"]') || b.closest('[id^="discussion_r"]').contains(a)) || null;
  }

  // 누른 시점의 DOM에서 읽는다. 댓글이 수정·재렌더돼도 지금 보이는 글이 대상이다
  function read(a, pr) {
    const m = ID.exec(a.id);
    const body = bodyOf(a);
    if (!m || !same(pr, prOf()) || !same(pr, domPrOf(a)) || !body || !a.isConnected) return null; // 버튼을 넣은 PR에 주소와 DOM이 그대로 있을 때만 쓴다
    const text = body.innerText.replace(/\n{3,}/g, "\n\n").trim();
    let quote = text;
    if (text.length > QUOTE_MAX) { // 서버·sw는 UTF-16 길이로 센다. 코드 포인트 단위로 붙여 이모지를 반으로 가르지 않는다
      quote = "";
      for (const ch of text) {
        if (quote.length + ch.length > QUOTE_MAX - 1) break;
        quote += ch;
      }
      quote += "…";
    }
    const scope = a.closest(".timeline-comment, .review-comment") || document.getElementById(m[1]);
    return {
      type: "open-comment",
      url: `https://github.com/${pr}#${m[1]}`,
      author: (scope?.querySelector(".author")?.textContent || "").trim().slice(0, 100),
      quote,
    };
  }

  function makeButton(a, pr) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute(ATTR, "");
    b.textContent = "HQ";
    b.title = LABEL;
    b.setAttribute("aria-label", LABEL);
    b.style.cssText = "margin-left:6px;padding:0 6px;font-size:12px;line-height:18px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;background:transparent;color:inherit;cursor:pointer;vertical-align:middle";
    b.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return; // 페이지 스크립트의 click()으로는 열지 않는다
      const msg = read(a, pr);
      let res = null;
      try {
        if (msg?.quote) res = await chrome.runtime.sendMessage(msg);
      } catch {} // 확장을 새로고침하면 이 스크립트의 연결이 끊긴다
      if (res?.ok) return;
      b.title = FAILED;
      b.textContent = "HQ!";
      setTimeout(() => {
        b.title = LABEL;
        b.textContent = "HQ";
      }, 5000);
    });
    live.add(b);
    owner.set(b, pr);
    return b;
  }

  function scan() {
    const pr = prOf();
    if (!pr) { // 문서 교체 없이 PR을 벗어나면 거절될 버튼을 남기지 않는다
      for (const b of document.querySelectorAll(`[${ATTR}]`)) b.remove();
      return;
    }
    const cache = new Map();
    for (const a of document.querySelectorAll(ANCHOR)) {
      const cur = a.nextElementSibling?.hasAttribute(ATTR) ? a.nextElementSibling : null;
      const ok = same(pr, domPrOf(a, cache));
      if (cur && live.has(cur) && ok && same(owner.get(cur), pr)) continue; // 본문이 비게 바뀌면 클릭 때 HQ!로 알린다
      cur?.remove();
      if (ok && ID.test(a.id) && hasText(a)) a.after(makeButton(a, pr));
    }
  }

  // GitHub는 페이지 이동을 문서 교체 없이 하고, 댓글을 펼치거나 새로 받으면 타임라인을 다시 그린다
  let timer = null;
  new MutationObserver(() => {
    timer ??= setTimeout(() => {
      timer = null;
      scan();
    }, 100);
  }).observe(document.documentElement, { childList: true, subtree: true });
  // DOM을 먼저 바꾸고 주소를 나중에 바꾸는 이동은 DOM 변경 없이 끝날 수 있다
  for (const ev of ["turbo:load", "turbo:frame-load", "popstate"]) addEventListener(ev, () => setTimeout(scan, 0));
  scan();
})();
