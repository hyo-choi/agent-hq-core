// 데이터 → 화면 항목 규칙. 서버(server.py)와 기존 화면이 쓰던 규칙을 그대로 옮긴 순수 함수다
import { mdPlain } from './md';
import type { Item, Kind, Msg, MsgLink, Pr, Snap, State } from './types';

export const STALE_MIN = 30, REFRESH_MS = 60000;
export const KIND: Record<string, string> = { work: '작업', question: '질문', pr: 'PR', decision: '결정', limits: '공통 한계', message: '메시지' };
export const CATS = ['PR·코드', '에이전트 운영', '진행 보고·알림', '기록 관리', '기타'];
export const TABS = [['work', '작업'], ['question', '질문'], ['pr', 'PR'], ['jira', 'Jira'], ['decision', '결정'], ['inbox', '요청함'], ['search', '통합 검색']] as const;
// 홈(다음 할 일 추천)은 메뉴 항목이 아니라 사이드바 로고·모바일 제목으로 들어간다. 첫 화면 기본값이다
export const VIEWS: (readonly [string, string])[] = [['home', '홈'], ...TABS];
export const isView = (k: unknown): k is string => VIEWS.some(([v]) => v === k);
export const viewName = (k: string) => Object.fromEntries(VIEWS)[k];
export const JST = ['In Progress', 'IN REVIEW', 'DEVELOPED', 'TO-DO', 'READY', 'NOT NOW'], JPRI = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
export const JKEY = /^[A-Z][A-Z0-9]{0,9}-[0-9]{1,7}$/;
export const MSG_MAX = 2000, MSG_KINDS = ['work', 'question', 'pr', 'decision'];

export const fmt = (iso?: string | null) => iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '없음';
export const ageMin = (iso?: string | null) => iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity;
export const safeUrl = (u?: string | null) => /^https:\/\//.test(u || '') ? u! : null; // ponytail: https 링크만 허용
export const group = (s: string) => /결정|미결정|대기/.test(s) ? 'decide' : /완료|확정|merged|closed|미도입/i.test(s) ? 'done' : 'active';
// 명시 state가 있으면 그것으로, 없으면(legacy) status 문자열 규칙으로 묶는다. 서버 STATES와 같다
export const STATE_GROUP: Record<State, string> = { open: 'active', blocked: 'active', waiting_user: 'decide', done: 'done', closed: 'done', dropped: 'done' };
export const STATE_NAME: Record<State, string> = { open: '진행', blocked: '막힘', waiting_user: '사용자 대기', done: '완료', closed: '종료', dropped: '취소' };
export const itemGroup = (x: { status: string; state?: State }) => (x.state && STATE_GROUP[x.state]) || group(x.status);
// daisyUI 클래스는 빌드가 찾을 수 있게 완전한 문자열로만 쓴다(문자열 조합 금지)
export const BADGE: Record<string, string> = { decide: 'badge-warning', done: 'badge-success', active: 'badge-info' };
// ready는 초록, draft는 중립으로 구분한다(merged는 초록, 목록에서는 자동 숨김). neutral soft는 글자색을 base-content로 둬야 읽힌다
export const prBadge = (p?: Partial<Pr>) => !p || !p.state ? 'badge-warning' : p.state === 'MERGED' ? 'badge-success' : p.state === 'CLOSED' ? 'badge-ghost' : p.isDraft ? 'badge-neutral text-base-content' : 'badge-success';
export const prState = (p?: Partial<Pr>) => !p || !p.state ? '상태 미확인' : p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'open · draft' : 'open · ready';
export const PRCLS: Record<string, string> = { 'merged': 'badge-success', 'closed': 'badge-ghost', 'open · draft': 'badge-neutral text-base-content', 'open · ready': 'badge-success' };
export const oneLine = (t?: string | null) => String(t || '').replace(/\s+/g, ' ').trim();
export const msgName = (kind: string) => kind === 'decision' ? '결정 답변' : kind === 'general' ? '자유 메시지' : '후속 질문';
export const MSG_ST: Record<string, [string, string]> = { received: ['접수됨', 'badge-ghost'], processed: ['처리됨', 'badge-outline'] };  // 중립 톤으로만 구분한다
// 메시지가 지금 속한 항목: coordinator가 분류 연결(link)했으면 그 항목, 아니면 원래 항목(자유 메시지는 null). 서버 msg_target과 같다
export const msgTarget = (m: Msg): MsgLink | null => m.link || (m.itemId ? { id: m.itemId, kind: m.kind, label: m.label || '' } : null);
export const tgtName = (t: { kind: string; label: string }) => `[${KIND[t.kind] || t.kind}] ${t.label}`;
export const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
export const jiraUrl = (snap: Snap, k: string) => JKEY.test(k) && safeUrl(snap.data.jira?.site) ? `${snap.data.jira!.site}/browse/${k}` : null;

export type Items = Record<Kind, Item[]>;
// 서버가 숨김·merged를 적용한 응답에서 화면 항목을 만든다. 해결된 결정(resolvedDecisions)은 resolvedItems로 따로 만든다
// (서버가 숨김 요청 대상으로만 받고 메시지 대상으로는 받지 않으므로 알림·답장 대상에서 뺀다)
export function items(snap: Snap): Items {
  const d = snap.data, out: Items = { work: [], question: [], pr: [], decision: [], limits: [], message: [] };
  for (const w of d.work || []) out.work.push({ kind: 'work', id: w.id, label: w.title, status: w.status, state: w.state, lead: mdPlain(w.conclusion), raw: w });
  for (const q of d.questions || []) out.question.push({ kind: 'question', id: q.id, label: q.q, status: q.status, state: q.state, lead: mdPlain(q.answer), raw: q,
    cat: CATS.includes(q.category!) ? q.category : '기타', thread: q.thread || '' });
  for (const p of Object.values(d.prs || {}).sort((a, b) => a.number - b.number))
    out.pr.push({ kind: 'pr', id: p.id, label: `#${p.number} ${p.title || ''}`, status: prState(p), lead: '', raw: p });
  for (const x of d.pendingDecisions || []) out.decision.push({ kind: 'decision', id: x.id, label: x.title, status: '결정 필요', lead: mdPlain(x.detail), raw: x });
  // 공통 검증 한계는 섹션 전체가 한 항목이다(서버 kind limits, data.json의 globalLimitsId)
  out.limits = (d.globalLimits || []).length && d.globalLimitsId ? [{ kind: 'limits', id: d.globalLimitsId, label: `공통 검증 한계 ${d.globalLimits!.length}건`, status: '', raw: d.globalLimits }] : [];
  // 메시지도 삭제(숨김) 요청·선택·내보내기 대상이다. id는 항목 id와 겹치지 않게 msg-<messageId>, kind는 message다(서버와 같은 규칙)
  out.message = snap.messages.map(m => ({ kind: 'message', id: 'msg-' + m.messageId, label: `[${msgName(m.kind)}] ${oneLine(m.text).slice(0, 60)}`,
    status: (MSG_ST[m.status] || [m.status])[0], raw: m }));
  return out;
}
// 진행판에서 숨긴 id. 서버는 pendingDecisions 등 기존 목록에만 hidden overlay를 적용하므로, 처리 완료(done)된 숨김 요청의 항목으로 판단한다.
// ponytail: overlay는 process-inbox가 done 요청으로만 만든다. overlay를 손으로 지우면 여기서는 계속 숨긴다
export const hiddenIds = (snap: Snap) => new Set(snap.requests.filter(r => r.status === 'done').flatMap(r => r.items.map(i => i.id)));
export const resolvedItems = (snap: Snap, hid = hiddenIds(snap)): Item[] => (snap.data.resolvedDecisions || []).filter(x => !x.id || !hid.has(x.id)).map(x => ({
  kind: 'decision', id: x.id, label: x.title, status: x.status || '결정 완료', lead: mdPlain(x.detail), raw: x, resolved: true }));
export const pendingIds = (snap: Snap) => new Set(snap.requests.filter(r => r.status === 'pending').flatMap(r => r.items.map(i => i.id)));

export function matches(x: Item, q: string, st: string, refOf: (id?: string) => string) {
  if (st && itemGroup(x) !== st) return false;
  if (!q) return true;
  const r = refOf(x.id).toLowerCase();
  if (/^hq-\d+$/.test(q)) return r === q;  // HQ-1이 HQ-12까지 잡지 않게 번호 검색은 정확히 일치만
  return r.includes(q) || String(x.label || '').toLowerCase().includes(q) || JSON.stringify(x.raw).toLowerCase().includes(q);
}
