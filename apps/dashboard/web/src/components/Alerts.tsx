// 새 항목 · 상태 업데이트 알림 패널. 자동으로 사라지지 않고 사용자가 확인해야 없어진다(판정·저장은 lib/alerts.ts).
// 데스크톱은 사이드바 메뉴 아래, 모바일은 본문 위, 홈은 본문 상단에 같은 목록·확인 상태를 그린다. 접기는 세 곳이 같은 저장 상태(fold)를 쓴다
import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { useApp } from '../ctx';
import { alertGroups, alertMid, isMsgAlert, newBox, statusBox, type AlertGroup, type NewAlert, type StatusAlert } from '../lib/alerts';
import { BADGE, KIND, PRCLS, fmt, group, msgName } from '../lib/model';
import { Badge, Muted } from './ui';

const ALERT_SHOW = 3;
const AKIND: Record<string, string> = { ...KIND, reply: '에이전트 답변' };
const StBadge = ({ kind, v }: { kind: string; v: string }) => kind === 'pr' ? <Badge cls={PRCLS[v] || 'badge-warning'}>{v}</Badge> : <Badge cls={BADGE[group(v)]}>{v}</Badge>;  // v는 알림 기준 문구(status · state 이름)다
const StLine = ({ a }: { a: StatusAlert }) => <p class="mt-1 flex flex-wrap items-center gap-1 text-xs" aria-label={`상태 ${a.from}에서 ${a.to}로${a.n > 1 ? `, ${a.n}회 변경` : ''}`}>
  <StBadge kind={a.kind} v={a.from} /><span aria-hidden="true">→</span><StBadge kind={a.kind} v={a.to} />
  {a.n > 1 ? <span class="whitespace-nowrap text-base-content/60">{a.n}회 변경</span> : null}</p>;
const Meta = ({ label, r, at }: { label: string; r: string; at: string }) => <p class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-base-content/60"><Badge>{label}</Badge>
  {r ? <span class="whitespace-nowrap font-mono tabular-nums">{r}</span> : null}<span class="whitespace-nowrap">{fmt(at)}</span></p>;

interface Row { key: string; title: string; view: () => void; body: ComponentChildren }
// 좁은 사이드바(카드 15rem 미만)에서는 본문과 보기·확인 버튼을 위아래로 나눈다. 넓으면 한 줄이다
function Panel({ name, rows, fold, ok, home, ack, toggle, moreKey }: {
  name: string; rows: Row[]; fold: boolean; ok: boolean; home?: boolean; ack: (keys: string[]) => void; toggle: () => void; moreKey: string }) {
  const { isOpen, setOpen } = useApp(), sec = useRef<HTMLElement>(null);
  // 누른 버튼이 사라져도 포커스를 알림 영역에 둔다
  const keep = (f: () => void) => { const s = sec.current, inside = s?.contains(document.activeElement); f();
    if (inside) requestAnimationFrame(() => { if (s && s.isConnected && !s.contains(document.activeElement)) s.focus({ preventScroll: true }); }); };
  const li = (a: Row) => <li key={a.key} class="flex flex-col gap-1 py-2 @[15rem]:flex-row @[15rem]:items-center @[15rem]:gap-2">
    <div class="min-w-0 flex-1">{a.body}</div>
    <div class="flex shrink-0 gap-1 self-end @[15rem]:self-auto"><button class="btn btn-ghost btn-xs" type="button" aria-label={`보기: ${a.title}`} onClick={a.view}>보기</button>
      <button class="btn btn-soft btn-xs" type="button" aria-label={`확인: ${a.title}`} onClick={() => keep(() => ack([a.key]))}>확인</button></div></li>;
  const more = rows.slice(ALERT_SHOW);
  let inner: ComponentChildren = null;
  if (!rows.length && home) inner = <div class="rounded-box border border-base-300 bg-base-100 shadow-sm">
    <div class="flex items-center gap-2 px-3 py-2"><h2 class="whitespace-nowrap text-sm font-semibold">{name}</h2><span class="badge badge-sm badge-ghost tabular-nums">0</span></div>
    <Muted cls="border-t border-base-300 px-3 py-3">{`${name} 알림이 없습니다.`}</Muted></div>;
  else if (rows.length) inner = <div class="@container rounded-box border border-base-300 bg-base-100 shadow-sm">
    {/* 폭이 모자라면 제목은 줄바꿈하지 않고 모두 확인·접기 묶음만 다음 줄(오른쪽)로 내린다 */}
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
      <h2 class="whitespace-nowrap text-sm font-semibold">{name}</h2><span class="badge badge-sm badge-primary tabular-nums">{rows.length}</span>
      <div class="ml-auto flex gap-2">{fold ? null : <button class="btn btn-ghost btn-xs" type="button" onClick={() => keep(() => ack(rows.map(a => a.key)))}>모두 확인</button>}
        <button class="btn btn-ghost btn-xs" type="button" aria-expanded={!fold} onClick={toggle}>{fold ? '펼치기' : '접기'}</button></div></div>
    {fold ? null : <div class="max-h-[45vh] overflow-y-auto border-t border-base-300 px-3">
      <ul class="divide-y divide-base-300">{rows.slice(0, ALERT_SHOW).map(li)}</ul>
      {more.length ? <details class="border-t border-base-300 pb-1" open={isOpen(moreKey)} onToggle={e => setOpen(moreKey, e.currentTarget.open)}>
        <summary class="cursor-pointer py-2 text-xs font-medium text-base-content/60 hover:text-base-content">{more.length}개 더 보기</summary>
        <ul class="divide-y divide-base-300">{more.map(li)}</ul></details> : null}
      {ok ? null : <Muted cls="border-t border-base-300 py-2 text-xs">브라우저 저장소를 쓸 수 없어 이 탭에서만 유지합니다. 새로고침하면 사라지고 그때 내용을 기준으로 다시 시작합니다.</Muted>}
    </div>}
  </div>;
  if (!inner) return null;
  return <section ref={sec} tabIndex={-1} aria-label={(home ? '홈 ' : '') + name + ' 알림'} class="focus:outline-none">{inner}</section>;
}

export function useAlertRows() {
  const app = useApp(), { snap, it, refOf, reveal, toast, setOpen, setTab, afterRender, bumpAlerts } = app;
  void app.alertTick;  // 확인·다른 탭 변경 때 다시 계산한다
  const s = newBox.get(), ss = statusBox.get(), { groups, st } = alertGroups(snap, s, ss, it);
  const all = Object.values(it).flat();
  // 대표가 없는(목록에 없는) 단일 알림 보기. 메시지는 연결 항목 카드 또는 요청함 메시지 행으로 간다
  const alertView = (a: NewAlert) => {
    const msg = isMsgAlert(a), x = a.id ? all.find(x => x.id === a.id) : undefined;
    if (!x && !(msg && !a.id)) return toast(`${refOf(a.id) || '이 항목'}은 지금 진행판 목록에 없습니다(숨김·merged 등). 알림은 확인을 누를 때까지 남습니다.`);
    if (msg) { if (x) setOpen('m:' + x.id, true); setOpen('mx:' + alertMid(a), true); }
    if (x) return reveal(x);
    setTab('inbox');
    afterRender(() => {
      const t = document.querySelector(`#list [data-item="${CSS.escape('msg-' + alertMid(a))}"]`);
      if (!t) return toast('항목 위치를 찾지 못했습니다. 목록에서 직접 확인해 주세요.');
      flash(t);
    });
  };
  const groupView = (g: AlertGroup) => {
    if (!g.x) { const a = g.xs[g.xs.length - 1]; return alertView(isMsgAlert(a) ? { ...a, id: null } : a); }  // 대표가 메시지 자체면 감지 시점의 옛 대상(a.id)이 아니라 메시지로 간다
    const mids = g.xs.filter(isMsgAlert).map(alertMid);
    if (mids.length) { setOpen('m:' + g.x.id, true); for (const mid of mids) setOpen('mx:' + mid, true); }
    reveal(g.x);
  };
  // 묶음을 확인하면 묶인 새 항목 키와 합쳐진 상태 알림을 모두 확인한다. 이 브라우저의 알림만 지운다.
  // groups는 이 렌더의 카드다. 그 카드가 보인 키만 확인하고, 그 뒤 도착해 아직 화면에 안 보인 알림은 남긴다
  const groupAck = (keys: string[]) => {
    const gs = groups.filter(g => keys.includes(g.key)), ak = gs.flatMap(g => g.xs.map(a => a.key)), sk = gs.flatMap(g => g.st ? [g.st.key] : []);
    const s1 = newBox.get(), ss1 = statusBox.get();
    if (s1) newBox.put({ ...s1, list: s1.list.filter(a => !ak.includes(a.key)) });
    if (ss1 && sk.length) statusBox.put({ ...ss1, list: ss1.list.filter(a => !sk.includes(a.key)) });
    bumpAlerts();
  };
  const stAck = (keys: string[]) => { const s1 = statusBox.get(); if (s1) statusBox.put({ ...s1, list: s1.list.filter(a => !keys.includes(a.key)) }); bumpAlerts(); };
  // 메시지·답변 알림은 연결 항목 번호가 아니라 메시지 자체 번호를 보인다
  const aref = (a: NewAlert) => isMsgAlert(a) ? refOf('msg-' + alertMid(a)) : refOf(a.id);
  const what = (a: NewAlert) => isMsgAlert(a) ? `${a.kind === 'message' ? msgName(a.mkind!) : AKIND.reply} ${aref(a)}`.trim() : '새 항목';
  // 묶음 카드: 대표가 목록에 보이는 항목이면 그 항목으로, 아니면 가장 최근 알림으로 보인다. 대표 자체의 새 항목 알림 하나뿐이면 예전과 같은 카드다
  const newRows: Row[] = [...groups].reverse().map(g => {  // 최근 것이 위
    const a = g.xs[g.xs.length - 1], cnt = new Map<string, number>();
    for (const b of g.xs) cnt.set(what(b), (cnt.get(what(b)) || 0) + 1);
    const parts = g.xs.length > 1 || g.st || (g.x && a.key !== g.key) ? [...cnt].map(([t, n]) => n > 1 ? `${t} ×${n}` : t) : [];
    const title = g.x ? String(g.x.label || '').replace(/\s+/g, ' ').slice(0, 120) : a.title;
    return { key: g.key, title, view: () => groupView(g), body: <>
      {g.x ? <Meta label={KIND[g.x.kind] || g.x.kind} r={refOf(g.x.id)} at={a.at} /> : <Meta label={a.kind === 'message' ? msgName(a.mkind!) : AKIND[a.kind] || a.kind} r={aref(a)} at={a.at} />}
      <p class="mt-0.5 truncate text-sm font-medium" title={title}>{title || '(제목 없음)'}</p>
      {parts.length ? <p class="mt-1 flex flex-wrap gap-x-1.5 text-xs text-base-content/60">{parts.map((t, i) => <span class="whitespace-nowrap">{(i ? '· ' : '') + t}</span>)}</p> : null}{g.st ? <StLine a={g.st} /> : null}</> };
  });
  const stRows: Row[] = [...st].reverse().map(a => ({ key: a.key, title: a.title, view: () => { const x = all.find(x => x.id === a.id); x ? reveal(x) : toast(`${refOf(a.id) || '이 항목'}은 지금 진행판 목록에 없습니다(숨김·merged 등). 알림은 확인을 누를 때까지 남습니다.`); },
    body: <><Meta label={KIND[a.kind] || a.kind} r={refOf(a.id)} at={a.at} /><p class="mt-0.5 truncate text-sm font-medium" title={a.title}>{a.title || '(제목 없음)'}</p><StLine a={a} /></> }));
  return {
    news: (home?: boolean) => <Panel name="새 항목" rows={newRows} fold={!!s?.fold} ok={newBox.ok} home={home} ack={groupAck} moreKey={(home ? 'h:' : '') + 'alerts-more'}
      toggle={() => { const s1 = newBox.get(); if (s1) { newBox.put({ ...s1, fold: !s1.fold }); bumpAlerts(); } }} />,
    stats: (home?: boolean) => <Panel name="상태 업데이트" rows={stRows} fold={!!ss?.fold} ok={statusBox.ok} home={home} ack={stAck} moreKey={(home ? 'h:' : '') + 'salerts-more'}
      toggle={() => { const s1 = statusBox.get(); if (s1) { statusBox.put({ ...s1, fold: !s1.fold }); bumpAlerts(); } }} />,
  };
}

// 항목을 강조한다. 접힌 묶음은 펼친다(onToggle이 펼침 상태를 기억)
export function flash(t: Element) {
  for (let d = t.closest('details'); d; d = d.parentElement!.closest('details')) d.open = true;
  t.scrollIntoView({ block: 'center', behavior: 'smooth' });
  t.classList.add('ring-2', 'ring-primary', 'ring-inset');
  setTimeout(() => t.classList.remove('ring-2', 'ring-primary', 'ring-inset'), 2500);
}
