// 새 항목 · 상태 업데이트 알림 판정(브라우저별). 저장 키와 형식은 기존 화면과 같다(storage.ts KEYS.alerts / KEYS.status).
// - 새 항목: 키는 작업·질문·결정·PR의 영속 id, 메시지 'm:'+messageId, 에이전트 답변 'r:'+messageId+':'+순번+':'+at.
//   처음 정상으로 읽은 내용은 기준선이라 알리지 않는다. seen은 지우지 않고 쌓기만 하므로 숨김·삭제·정렬·merged 이동·재시작은 새 항목이 아니다.
//   ponytail: seen은 키 수만큼만 자란다(항목·메시지 수백 개 규모). 커지면 지금 없는 키를 오래된 순으로 잘라 낸다
// - 상태: 작업·질문은 status 문자열(공백 정규화), PR은 마지막 조회가 성공(ok: true)한 state·isDraft(prState 표시값).
//   state(item CLI)가 있으면 status·state를 함께 본다(state만 바뀌어도 알린다). 기본값 open과 state 없는 항목은 기존 기준 문구 그대로다.
//   답변·결론·제목·updatedAt·정렬은 보지 않는다. 결정은 상태 필드가 없어 대상이 아니다. base는 지금 응답에 있는 항목만 남긴다.
//   조회 실패·미확인 PR은 마지막 기준을 유지한다. 같은 항목이 연이어 바뀌면 최초 from을 유지하고 to·횟수(n)·시각만 갱신한다.
// 확인은 이 브라우저의 알림만 지우며 서버 요청·결정·업무 상태는 바꾸지 않는다.
import { STATE_NAME, items, msgTarget, prState, type Items } from './model';
import { KEYS } from './storage';
import type { Item, Snap } from './types';

export interface NewAlert { key: string; at: string; kind: string; id: string | null; title: string; mkind?: string; mid?: string }
export interface NewState { v: number; seen: string[]; list: NewAlert[]; fold: boolean }
export interface StatusAlert { key: string; kind: string; id: string; title: string; from: string; to: string; n: number; at: string }
export interface StatusState { v: number; base: Record<string, string>; list: StatusAlert[]; fold: boolean }

// 저장소를 못 쓰면 이 탭 메모리에만 둔다. 새로고침하면 그때 내용을 기준선으로 다시 시작한다
function box<T>(key: string, valid: (s: any) => boolean) {
  let mem: T | null = null;
  const b = {
    ok: true,
    get(): T | null {
      let raw;
      try { raw = localStorage.getItem(key); b.ok = true; } catch { b.ok = false; return mem; }
      try { const s = JSON.parse(raw!); return s && valid(s) ? s : null; } catch { return null; }
    },
    put(s: T) { mem = s; try { localStorage.setItem(key, JSON.stringify(s)); b.ok = true; } catch { b.ok = false; } },
  };
  return b;
}
export const newBox = box<NewState>(KEYS.alerts, s => Array.isArray(s.seen) && Array.isArray(s.list));
export const statusBox = box<StatusState>(KEYS.status, s => s.base && typeof s.base === 'object' && !Array.isArray(s.base) && Array.isArray(s.list));

const clip = (t?: string | null) => String(t || '').replace(/\s+/g, ' ').slice(0, 120);

export function newCur(snap: Snap, it: Items = items(snap)) {
  const cur = new Map<string, Omit<NewAlert, 'key' | 'at'>>();
  for (const x of [...it.work, ...it.question, ...it.decision, ...it.pr]) if (x.id) cur.set(x.id, { kind: x.kind, id: x.id, title: clip(x.label) });
  for (const p of Object.values(snap.data.mergedPrs || {})) if (p.id) cur.set(p.id, { kind: 'pr', id: p.id, title: clip(`#${p.number} ${p.title || ''}`) });
  for (const m of snap.messages) {
    const id = msgTarget(m)?.id || null;  // 분류 연결된 메시지는 연결 항목으로 이동한다
    cur.set('m:' + m.messageId, { kind: 'message', id, mkind: m.kind, title: clip(m.label || m.text) });
    (m.replies || []).forEach((r, i) => cur.set(`r:${m.messageId}:${i}:${r.at || ''}`, { kind: 'reply', id, mid: m.messageId, title: clip(m.label || r.text) }));
  }
  return cur;
}
export const isMsgAlert = (a: NewAlert) => a.kind === 'message' || a.kind === 'reply';
export const alertMid = (a: NewAlert) => a.kind === 'message' ? a.key.slice(2) : a.mid!;

// 이전 상태와 지금 응답으로 다음 상태를 만든다. 바뀐 게 없으면 s0를 그대로 돌려준다(쓰지 않는다)
export function detectNew(s0: NewState | null, snap: Snap, at = new Date().toISOString()): NewState {
  const cur = newCur(snap);
  if (!s0) return { v: 1, seen: [...cur.keys()], list: [], fold: false };  // 기준선: 기존 항목은 알리지 않는다
  // 메시지는 숨김 처리될 때만 응답에서 빠진다. 숨긴 메시지의 알림은 남기지 않는다(seen에는 남아 다시 알리지 않는다)
  const live = new Set(snap.messages.map(m => m.messageId));
  const list = s0.list.filter(a => !(isMsgAlert(a) && !live.has(alertMid(a))));
  const seen = new Set(s0.seen), add = [...cur].filter(([k]) => !seen.has(k));
  if (!add.length) return list.length === s0.list.length ? s0 : { ...s0, list };
  for (const [k] of add) seen.add(k);
  return { ...s0, seen: [...seen], list: [...list, ...add.map(([key, a]) => ({ key, at, ...a }))] };
}
export const markSeen = (s: NewState, key: string): NewState => s.seen.includes(key) ? s : { ...s, seen: [...s.seen, key] };

export function statusCur(snap: Snap, it: Items = items(snap)) {
  const cur = new Map<string, { kind: string; title: string; fp: string | null }>();
  for (const x of [...it.work, ...it.question]) if (x.id) cur.set(x.id, { kind: x.kind, title: clip(x.label), fp: [String(x.status || '').replace(/\s+/g, ' ').trim(), x.state && x.state !== 'open' ? STATE_NAME[x.state] : ''].filter(Boolean).join(' · ') || null });
  for (const p of [...Object.values(snap.data.prs || {}), ...Object.values(snap.data.mergedPrs || {})])
    if (p.id) cur.set(p.id, { kind: 'pr', title: clip(`#${p.number} ${p.title || ''}`), fp: p.ok === true && p.state ? prState(p) : null });
  return cur;
}
export function detectStatus(s0: StatusState | null, snap: Snap, at = new Date().toISOString()): StatusState {
  const cur = statusCur(snap), base: Record<string, string> = {};
  for (const [id, c] of cur) { const fp = c.fp ?? s0?.base[id]; if (fp) base[id] = fp; }  // 미확인이면 마지막 기준을 유지한다
  if (!s0) return { v: 1, base, list: [], fold: false };  // 기준선: 지금 상태는 알리지 않는다
  const list = [...s0.list];
  for (const [id, c] of cur) {
    const was = s0.base[id];
    if (!c.fp || !was || was === c.fp) continue;
    const i = list.findIndex(a => a.key === id), a0 = i < 0 ? null : list.splice(i, 1)[0];
    list.push({ key: id, kind: c.kind, id, title: c.title, from: a0 ? a0.from : was, to: c.fp, n: (a0?.n || 0) + 1, at });
  }
  const s = { ...s0, base, list };
  return JSON.stringify(s) === JSON.stringify(s0) ? s0 : s;
}

// ---------- 대표 항목 묶음 ----------
// 같은 업무의 알림은 대표 항목 하나로 묶는다. 저장된 알림·키는 그대로 두고 그릴 때만 묶으며, 묶음을 확인하면 묶인 키를 모두 확인한다.
// 메시지·답변의 대표는 지금 속한 항목(msgTarget: 분류 연결 우선)이 진행판 목록에 보일 때 그 항목이다.
// 대상이 없거나(자유 메시지) 숨김·merged라 목록에 없으면 메시지 자체(msg-<messageId>)가 대표라 따로 알린다(조용히 빠지지 않는다).
// 상태 업데이트도 같은 대표의 새 항목 묶음이 있으면 그 카드에 합치고 상태 패널에서는 뺀다. 묶음이 없으면 따로 보인다.
export interface AlertGroup { key: string; x?: Item; xs: NewAlert[]; st: StatusAlert | null }
export function alertGroups(snap: Snap, s: NewState | null, ss: StatusState | null, it: Items = items(snap)) {
  const shown = new Map([...it.work, ...it.question, ...it.decision, ...it.pr].map(x => [x.id, x]));
  const live = new Map(snap.messages.map(m => [m.messageId, m]));
  const rep = (a: NewAlert) => {
    if (!isMsgAlert(a)) return a.key;
    const m = live.get(alertMid(a)), t = m ? msgTarget(m)?.id : a.id;
    return t && shown.has(t) ? t : 'msg-' + alertMid(a);
  };
  const g = new Map<string, AlertGroup>();
  for (const a of s?.list || []) {  // 오래된 것부터 보며 새 알림이 붙은 묶음을 뒤(= 화면 위)로 옮긴다
    const r = rep(a), x = g.get(r) || { key: r, x: shown.get(r), xs: [], st: null };
    g.delete(r); g.set(r, { ...x, xs: [...x.xs, a] });
  }
  const st = (ss?.list || []).filter(a => { const gr = g.get(a.id); if (gr) gr.st = a; return !gr; });
  return { groups: [...g.values()], st };
}
