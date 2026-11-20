import * as L from "./lib.js";
import { ImageDraft } from "./images.js";
import { imageHelp } from "./help.js";

const $ = (id) => document.getElementById(id);
imageHelp($("attachHelp"), $("attachHint"));
const say = (text, err = false) => {
  $("status").textContent = text;
  $("status").className = err ? "err" : "";
};

async function call(path, init) {
  L.requireConfig();
  const opt = init ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body), signal: AbortSignal.timeout(init.timeout) } : { cache: "no-store", signal: AbortSignal.timeout(8000) };
  try {
    const r = await fetch(L.API + path, opt);
    const body = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, ...body, error: r.ok ? null : L.errorText(r.status, body.error, chrome.runtime.id) };
  } catch {
    return { status: 0, ok: false, error: L.errorText(0) };
  }
}

const postFlush = (flushId) => call("/api/flush", { body: { flushId }, timeout: 20000 }); // 서버의 전달 timeout(codex queue·Claude socket)이 15초다

let pr, dash, view, key;
let comment = null; // 댓글 버튼으로 열었을 때의 대상 댓글(permalink·작성자·인용)
let draft = { value: null, text: "", attempt: null }; // flush: 사용자가 바꾼 "지금 확인 요청" 선택(없으면 기본으로 켠다)
let saving = Promise.resolve();
const images = new ImageDraft();
let sending = false;

// popup은 포커스를 잃으면 닫힌다. 텍스트 초안과 텍스트 전송의 재시도 키는 브라우저 세션 동안 보관한다.
const save = () => {
  // File과 업로드 재시도 키는 popup 수명 동안만 유지한다. 텍스트 초안은 기존 세션 저장소에 남긴다.
  const snapshot = { ...draft, attempt: images.items.length ? null : draft.attempt, comment };
  return (saving = saving.catch(() => {}).then(() => chrome.storage.session.set({ [key]: snapshot })));
}; // 한 번 실패해도 다음 저장을 막지 않는다
const target = () => view.targets.find((t) => t.value === $("target").value);
const compose = () => L.composeText(target(), $("text").value, pr, comment, images.items.length > 0);

function renderTargets() {
  const sel = $("target");
  sel.replaceChildren(...view.targets.map((t) => new Option(t.label, t.value)));
  sel.value = view.targets.some((t) => t.value === draft.value) ? draft.value : view.targets[0].value;
  $("note").textContent = view.registered ? "" : pr.jira ? "이 티켓의 키와 주소가 담긴 자유 메시지로 보내며 coordinator가 분류합니다." : "진행판에서 이 PR을 찾지 못했습니다. 자유 메시지로 보내면 coordinator가 분류합니다.";
}

function refreshControls(busy = false) {
  sending = busy;
  for (const id of ["attach", "picker"]) $(id).disabled = busy;
  for (const b of $("images").querySelectorAll("button")) b.disabled = busy;
  const block = comment || pr.jira ? null : L.rebaseBlock(dash, pr, view.entry);
  const text = compose();
  $("rebase").disabled = sending || !!block;
  $("review").disabled = sending;
  $("rebaseNote").textContent = block || "";
  $("count").textContent = `${text.length} / ${L.MSG_MAX}`;
  $("send").disabled = sending || (!text && !images.items.length) || text.length > L.MSG_MAX;
  const reg = dash.flush?.registration;
  $("flush").disabled = sending || !reg;
  if (!reg) $("flush").checked = false;
  $("flushLabel").textContent = reg ? "지금 확인 요청도 보내기" : "지금 확인 요청(등록된 coordinator 없음)";
  $("text").readOnly = sending;
  $("target").disabled = sending;
}

// 메시지가 접수된 뒤의 마무리. 다시 열었을 때도 같은 함수로 이어 가므로 같은 flushId를 쓴다.
async function finish(attempt, note) {
  let flush = "";
  if (attempt.wantFlush) {
    say(`${note}\n확인 요청을 보내는 중…`);
    const res = await postFlush(attempt.flushId);
    flush = `\n${L.flushNote(res)}`;
  }
  // 실패 뒤 글을 고쳐 두고 다시 연 경우, 이전 시도가 접수됐어도 고친 글은 지우지 않는다
  const kept = compose() === attempt.text ? "" : $("text").value;
  images.clear();
  renderImages();
  draft = { value: kept ? draft.value : null, text: kept, attempt: null, flush: draft.flush }; // 끝난 뒤에는 PR 카드 기본으로 돌아간다. 확인 요청 선택은 유지한다
  await save();
  dash.messages = [...(dash.messages || []), { messageId: attempt.messageId, status: "received", text: attempt.text }]; // 재조회가 실패해도 리베이스 중복을 막는다
  const fresh = await call("/api/dashboard");
  if (fresh.ok) {
    dash = fresh;
    view = L.resolveTargets(dash, pr);
  }
  renderTargets();
  const ref = dash.refs?.[`msg-${attempt.messageId}`];
  $("text").value = kept;
  refreshControls();
  say(`${note}${ref ? ` · ${ref}` : ""}${flush}`);
}

async function send(ev) {
  ev.preventDefault();
  try {
    await sendNow();
  } catch (e) {
    refreshControls();
    say(`오류: ${e.message}\n쓴 내용은 그대로 있습니다.`, true);
  }
}

async function sendNow() {
  const t = target();
  const text = compose();
  if (L.isRebaseText(text, pr)) {
    const block = L.rebaseBlock(dash, pr, view.entry);
    if (block) return say(block, true);
  }
  if (sending || (!text && !images.items.length) || text.length > L.MSG_MAX) return;
  const attempt = L.nextAttempt(draft.attempt, t, text, $("flush").checked);
  draft = { ...draft, value: t.value, text: $("text").value, attempt };
  refreshControls(true); // await 전에 막아 연속 클릭이 다시 들어오지 않게 한다
  say("보내는 중…");
  await save(); // 텍스트 시도는 세션에, 이미지 시도는 현재 popup 메모리에 남긴다
  for (const image of images.items) {
    if (!image.id) {
      const res = await upload(image);
      if (!res.ok) {
        refreshControls();
        return say(`${res.error}\n쓴 내용은 그대로 있습니다. 고치지 않고 다시 보내면 같은 메시지 번호와 업로드 키를 사용합니다.`, true);
      }
      image.id = res.upload.id;
    }
  }
  if (images.items.length) attempt.attachments = images.items.map(a => a.id);
  const res = await call("/api/messages", { body: L.messageBody(attempt), timeout: 10000 });
  if (res.ok) return finish(L.recoverAttempt({ messages: [res.message] }, attempt) || attempt, res.duplicate ? "이미 접수된 메시지입니다" : "접수됐습니다(처리는 coordinator가 합니다)");
  const rejected = !images.items.length && L.definitelyRejected(res.status);
  if (rejected) {
    draft.attempt = null; // 저장되지 않았으므로 다음 전송은 새 키를 쓴다
    await save();
  }
  refreshControls();
  say(`${res.error}\n쓴 내용은 그대로 있습니다.${rejected ? "" : " 다시 보내면 중복되지 않습니다."}`, true);
}

async function upload(image) {
  try {
    const r = await fetch(L.API + "/api/uploads", { method: "POST", headers: { "Content-Type": image.file.type, "X-Upload-Key": image.key }, body: image.file, signal: AbortSignal.timeout(125000) });
    const body = await r.json().catch(() => ({}));
    return { ...body, ok: r.ok, error: r.ok ? null : L.errorText(r.status, body.error, chrome.runtime.id) };
  } catch { return { ok: false, error: L.errorText(0) }; }
}

function changedContent() {
  if (images.items.length || draft.attempt?.attachments?.length) {
    images.reset();
    draft.attempt = null;
  }
}

function renderImages() {
  $("images").replaceChildren(...images.items.map((image, i) => {
    const box = document.createElement("div"), img = document.createElement("img"), name = document.createElement("div"), remove = document.createElement("button");
    img.src = image.url; img.alt = `첨부 미리보기 ${i + 1}`;
    name.textContent = image.file.name;
    remove.type = "button"; remove.textContent = "제거"; remove.setAttribute("aria-label", `첨부 ${i + 1} 제거`);
    remove.addEventListener("click", () => {
      if (sending) return;
      changedContent(); images.remove(i); save(); renderImages(); refreshControls();
    });
    box.append(img, name, remove); return box;
  }));
}

function addImages(files) {
  if (sending) return;
  const before = images.items.length;
  const errors = images.add(files);
  if (before !== images.items.length) { changedContent(); save(); }
  renderImages(); refreshControls(); say(errors.join(" "), !!errors.length);
}

// 리베이스·리뷰 문구는 입력칸만 채운다. 보내기는 사용자가 누른다
function insertRebase() {
  const t = L.rebaseText(pr);
  const rest = $("text").value.trim();
  if (!L.isRebaseText(rest, pr)) $("text").value = rest ? `${t}\n\n${rest}` : t;
  toPrCard();
}

function insertReview() {
  const t = L.insertReview($("text").value, pr);
  if (t !== null) $("text").value = t;
  toPrCard();
}

function toPrCard() {
  $("target").value = view.targets[0].value; // 리베이스·리뷰 처리는 PR 카드로, 미등록이면 자유 메시지로 보낸다
  changedContent();
  draft.value = $("target").value;
  draft.text = $("text").value;
  save();
  refreshControls();
  $("text").focus();
}

async function main() {
  L.requireConfig();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // 목록 버튼이 남긴 대상은 쓰든 안 쓰든 한 번만 읽는다
  const { [L.TARGET_KEY]: stored } = await chrome.storage.session.get(L.TARGET_KEY);
  if (stored) await chrome.storage.session.remove(L.TARGET_KEY);
  const target = L.consumeTarget(stored, tab?.id, Date.now());
  pr = L.parsePrUrl(tab?.url) || L.parseJiraUrl(tab?.url) || target; // PR 페이지에서는 탭이 이긴다. 남은 대상이 다른 PR로 보내지 않게 한다
  if (target && pr.slug.toLowerCase() === target.slug.toLowerCase()) comment = stored.comment || null; // 탭과 다른 PR의 댓글은 쓰지 않는다
  if (!pr || (!pr.jira && pr.owner.toLowerCase() !== L.ownerName())) {
    $("title").textContent = "지원하는 페이지가 아닙니다";
    $("sub").textContent = "GitHub PR 또는 Jira 티켓 페이지에서 열어 주세요.";
    return;
  }
  $("title").textContent = pr.jira ? pr.key : `${pr.owner}/${pr.repo}#${pr.number}`;
  if (pr.jira) {
    for (const id of ["rebase", "review", "rebaseNote"]) $(id).hidden = true; // PR 전용 문구다
    $("text").placeholder = "이 티켓에 대해 질문이나 요청을 적어 주세요";
  }
  key = `draft:${pr.slug.toLowerCase()}${comment ? `:${comment.id}` : ""}`; // 댓글마다 초안이 따로다. PR 초안과 섞이지 않는다
  draft = (await chrome.storage.session.get(key))[key] || draft;
  if (comment && draft.attempt && draft.comment?.id === comment.id) comment = draft.comment; // 접수 여부를 모르는 시도가 있으면 그때의 인용으로 같은 글을 다시 만든다
  delete draft.comment;
  if (comment) {
    $("comment").hidden = false;
    $("commentAuthor").textContent = comment.author || "작성자 미확인";
    $("commentLink").textContent = comment.id;
    $("commentLink").href = comment.url;
    $("quote").textContent = comment.quote; // 인용은 글자로만 보인다
    $("rebase").hidden = true; // 리베이스·리뷰 처리는 PR 단위 요청이라 댓글 모드에서 숨긴다
    $("review").hidden = true;
    $("rebaseNote").hidden = true;
    $("text").placeholder = "이 댓글에 대해 할 일을 적어 주세요";
  }
  if (!draft.text.trim()) draft.value = null; // 글 없이 고르기만 한 대상은 남기지 않는다
  dash = await call("/api/dashboard");
  if (!dash.ok) {
    $("sub").textContent = "";
    return say(dash.error, true);
  }
  view = L.resolveTargets(dash, pr);
  $("sub").textContent = pr.jira ? (new URL(tab.url).pathname.startsWith("/browse/") ? (tab.title || "").slice(0, 120) : "") : view.entry?.title ? `${view.entry.title} · ${L.prSummary(view.entry)}` : L.prSummary(view.entry);
  $("dash").href = `${L.API}/`;
  renderTargets();
  $("text").value = draft.text;
  $("flush").checked = L.initialFlush(draft); // 기본으로 켠다. refreshControls가 등록 없을 때 해제한다
  $("form").hidden = false;
  $("form").addEventListener("submit", send);
  $("attach").addEventListener("click", () => $("picker").click());
  $("picker").addEventListener("change", () => { addImages(Array.from($("picker").files)); $("picker").value = ""; });
  $("form").addEventListener("paste", ev => {
    const files = Array.from(ev.clipboardData?.files || []);
    if (files.length) { ev.preventDefault(); addImages(files); }
  });
  $("rebase").addEventListener("click", insertRebase);
  $("review").addEventListener("click", insertReview);
  $("target").addEventListener("change", () => {
    changedContent();
    draft.value = $("target").value;
    save();
    refreshControls();
  });
  $("flush").addEventListener("change", () => {
    draft.flush = $("flush").checked;
    save();
  });
  $("text").addEventListener("input", () => {
    changedContent();
    draft.text = $("text").value;
    save();
    refreshControls();
  });
  refreshControls();
  const recovered = L.recoverAttempt(dash, draft.attempt);
  if (recovered && draft.flush === false) recovered.wantFlush = false; // 시도 뒤 사용자가 끈 확인 요청은 이어 보내지 않는다
  if (recovered) {
    refreshControls(true); // finish가 draft를 비우므로 그동안 입력과 새 전송을 막는다
    try {
      return await finish(recovered, "이전에 보낸 메시지가 접수돼 있습니다");
    } catch (e) {
      refreshControls();
      return say(`오류: ${e.message}\n다시 열면 이어서 확인합니다.`, true);
    }
  }
  if (draft.attempt && draft.text.trim()) say("이전 전송의 접수 여부를 확인하지 못했습니다. 그대로 다시 보내도 중복되지 않습니다.");
}

main().catch((e) => say(`오류: ${e.message}`, true));
