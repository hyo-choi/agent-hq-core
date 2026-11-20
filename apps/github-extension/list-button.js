// PR 목록에서 내 PR 제목 옆에 popup을 여는 버튼을 넣는다. 진행판 데이터를 읽거나 페이지에 쓰지 않는다.
// ponytail: data-testid는 GitHub의 공개 계약이 아니다. 바뀌면 버튼만 사라지고 PR 페이지 popup은 그대로 쓸 수 있다.
(() => {
  const configuredOwner = globalThis.AGENT_HQ_OWNER;
  if (!configuredOwner) return;
  const ATTR = "data-agent-hq-pr-button";
  const TITLE = 'a[data-testid="listitem-title-link"]';
  const AUTHOR = '[data-testid="author-filter-link"]';
  const LABEL = "Agent HQ로 요청 보내기";
  const FAILED = "popup을 열지 못했습니다. 페이지를 새로고침해 주세요.";
  const LIST_PATH = new RegExp(`^/${configuredOwner}/[^/]+/pulls(/|$)`, "i"); // lib.js validateOpenRequest가 받는 페이지와 같다

  const live = new WeakSet(); // 복원된 스냅샷의 복제 버튼에는 리스너가 없다
  const login = () => document.querySelector('meta[name="user-login"]')?.content.trim().toLowerCase();

  function isMine(link, me) {
    if (!me || !/\/pull\/[1-9][0-9]*$/.test(link.pathname)) return false; // 이슈 목록도 같은 마크업을 쓴다
    return link.closest("li")?.querySelector(AUTHOR)?.textContent.trim().toLowerCase() === me;
  }

  function makeButton(box) {
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
      const link = box.querySelector(TITLE); // React가 행을 재사용하므로 누른 시점의 링크를 읽는다
      if (!link || !isMine(link, login())) return;
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ type: "open-pr", url: link.href });
      } catch {} // 확장을 새로고침하면 이 스크립트의 연결이 끊긴다
      if (res?.ok) return;
      b.title = FAILED;
      b.textContent = "HQ!";
      setTimeout(() => { // 행이 재사용돼 다른 PR에 실패 표시가 남지 않게 한다
        b.title = LABEL;
        b.textContent = "HQ";
      }, 5000);
    });
    live.add(b);
    return b;
  }

  function scan() {
    if (!LIST_PATH.test(location.pathname)) { // 문서 교체 없이 목록을 벗어나면 거절될 버튼을 남기지 않는다
      for (const b of document.querySelectorAll(`[${ATTR}]`)) b.remove();
      return;
    }
    const me = login();
    for (const link of document.querySelectorAll(TITLE)) {
      const box = link.closest("[data-listview-item-title-container]");
      if (!box) continue;
      const cur = box.querySelector(`[${ATTR}]`);
      if (cur && live.has(cur) && isMine(link, me)) continue;
      cur?.remove();
      if (isMine(link, me)) box.append(makeButton(box));
    }
  }

  // GitHub는 페이지 이동을 문서 교체 없이 하고 행도 다시 그린다
  let timer = null;
  new MutationObserver(() => {
    timer ??= setTimeout(() => {
      timer = null;
      scan();
    }, 100);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href"] });
  scan();
})();
