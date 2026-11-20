import * as L from "./lib.js";

// 목록·댓글 버튼의 요청을 검증하고 popup을 연다. 전송은 하지 않는다.
async function openFor(pr, tab, comment = null) {
  await chrome.storage.session.set({ [L.TARGET_KEY]: L.makeTarget(pr, tab.id, Date.now(), comment) });
  try {
    await chrome.action.openPopup({ windowId: tab.windowId });
    return { ok: true };
  } catch {
    await chrome.storage.session.remove(L.TARGET_KEY); // 열리지 않았으면 다음 아이콘 클릭에 남기지 않는다
    return { ok: false };
  }
}

// PR 연결 항목 표시용 읽기. 진행판의 공개 GET만 쓴다.
// ponytail: 탭·행이 많아도 진행판 조회는 30초에 한 번이다. 실패는 캐시하지 않는다
const CACHE_MS = 30000;
let cached = null;
function dashboard() {
  L.requireConfig();
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.p;
  const p = fetch(`${L.API}/api/dashboard`, { cache: "no-store", signal: AbortSignal.timeout(8000) }).then((r) => {
    if (!r.ok) throw new Error(L.errorText(r.status, null, chrome.runtime.id));
    return r.json().catch(() => {
      throw new Error("진행판 응답을 읽지 못했습니다");
    });
  });
  cached = { at: Date.now(), p };
  p.catch(() => {
    if (cached?.p === p) cached = null;
  });
  return p;
}

async function linksFor(prs) {
  try {
    const dash = await dashboard();
    return { ok: true, at: dash.data?.updatedAt || null, links: prs.map((pr) => ({ url: pr.url, ...L.prLinks(dash, pr) })) };
  } catch (e) {
    return { ok: false, error: e?.name === "TypeError" || e?.name === "TimeoutError" ? L.errorText(0) : e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "pr-links") {
    const prs = L.validateLinksRequest(msg, sender, chrome.runtime.id);
    if (!prs) {
      reply({ ok: false, error: "허용되지 않은 요청입니다" });
      return;
    }
    linksFor(prs).then(reply);
    return true;
  }
  if (msg?.type === "open-comment") {
    const c = L.validateCommentRequest(msg, sender, chrome.runtime.id);
    if (!c) {
      reply({ ok: false });
      return;
    }
    openFor(c.pr, sender.tab, c.comment).then(reply, () => reply({ ok: false }));
    return true;
  }
  const pr = L.validateOpenRequest(msg, sender, chrome.runtime.id);
  if (!pr) {
    reply({ ok: false });
    return;
  }
  openFor(pr, sender.tab).then(reply, () => reply({ ok: false }));
  return true;
});
