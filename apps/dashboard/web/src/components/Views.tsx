// 홈(다음 할 일 추천)·통합 검색·Jira 탭
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useApp } from '../ctx';
import { JKEY, JPRI, JST, KIND, ageMin, fmt, jiraUrl, matches, prBadge, resolvedItems } from '../lib/model';
import type { Item, JiraIssue } from '../lib/types';
import { PrLinks } from './Lists';
import { Badge, Det, Empty, GROUP, ListBox, Muted, RefBtn, StatusBadge } from './ui';

// ---------- 다음 할 일 추천 (coordinator가 data.recommendations에 명시한 것만) ----------
export function Recs({ gotoJira }: { gotoJira: (k: string) => void }) {
  const { snap } = useApp(), D = snap.data, R = D.recommendations, all = R?.items || [];
  if (!all.length) return <Empty>지금 표시할 추천이 없습니다.</Empty>;
  // merged로 확인된(known merged) PR만 걸린 추천은 이미 끝난 리뷰 행동이므로 카드에서 뺀다. Jira 상태는 바꾸지 않는다.
  const merged = (r: typeof all[number]) => (r.prs || []).length > 0 && r.prs!.every(n => (D.mergedPrs || {})[n]);
  const xs = all.filter(r => !merged(r)).slice(0, 5), gone = all.filter(merged);
  return <section aria-label="다음 할 일 추천">
    <div class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1"><h2 class="text-lg font-bold">다음 할 일</h2>
      <Muted cls="text-xs">{`coordinator 추천 · 갱신 ${fmt(R!.updatedAt)} · 누르면 링크·탭 이동만 하고 작업을 시작하지 않습니다`}</Muted></div>
    {xs.length ? <div class="grid gap-4 md:grid-cols-2">{xs.map((r, i) => <article key={r.id || r.title} class="card card-border border-base-300 bg-base-100 shadow-sm"><div class="card-body gap-2 p-5">
      <div class="flex flex-wrap items-center gap-2"><span class="badge badge-sm badge-neutral tabular-nums">{String(i + 1)}</span><RefBtn id={r.id} label={r.title} />
        {r.decision ? <Badge cls="badge-warning">사용자 결정 필요</Badge> : <Badge cls="badge-success">바로 할 수 있음</Badge>}</div>
      <h3 class="card-title text-base leading-snug">{r.title}</h3>
      {r.why ? <p class="line-clamp-3 text-sm text-base-content/70">{r.why}</p> : null}
      {r.action ? <p class="text-sm"><b>다음 행동 · </b>{r.action}</p> : null}
      {r.decision ? <p class="rounded-field bg-warning/15 px-3 py-2 text-sm text-base-content">{r.decision}</p> : null}
      <div class="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-2 text-sm"><PrLinks nums={r.prs} />
        {(r.jira || []).filter(k => JKEY.test(k)).map(k => <span class="inline-flex items-center gap-1">
          <button class="btn btn-xs btn-soft btn-info font-mono" type="button" title="Jira 탭에서 보기" onClick={() => gotoJira(k)}>{k}</button>
          {jiraUrl(snap, k) ? <a class="link link-info" href={jiraUrl(snap, k)!} target="_blank" rel="noopener noreferrer" aria-label={`${k} Jira에서 열기`}>↗</a> : null}</span>)}</div>
    </div></article>)}</div> : <Muted>지금 표시할 추천이 없습니다.</Muted>}
    {gone.length ? <Muted cls="mt-3">{`merged 확인으로 제외한 추천 ${gone.length}건: ${gone.map(r => r.title).join(', ')}`}</Muted> : null}
  </section>;
}

// ---------- 통합 검색: 서버가 숨김·merged를 뺀 응답만 각 탭과 같은 matches로 찾는다. 결정 완료 항목도 읽기 전용으로 찾는다 ----------
const SKINDS = ['work', 'question', 'pr', 'decision'] as const;
export function Search() {
  const { it, snap, refOf, filters, reveal } = useApp(), q = (filters.gq || '').trim().toLowerCase();
  if (!q) return <Empty>검색어를 입력하면 작업·질문·PR·결정 전체에서 찾습니다. HQ-12처럼 번호를 넣으면 그 항목만 찾습니다.</Empty>;
  const hit = Object.fromEntries(SKINDS.map(k => [k, [...it[k], ...(k === 'decision' ? resolvedItems(snap) : [])].filter(x => matches(x, q, '', refOf))])) as Record<string, Item[]>;
  const total = SKINDS.reduce((n, k) => n + hit[k].length, 0);
  const row = (x: Item) => <article key={x.id || x.label} class="list-row items-start gap-3 px-4 py-3 sm:px-5"><div class="list-col-grow min-w-0">
    <div class="mb-1 flex flex-wrap items-center gap-1.5"><RefBtn id={x.id} label={x.label} />{x.kind === 'pr' ? <Badge cls={prBadge(x.raw)}>{x.status}</Badge> : x.resolved ? <Badge cls="badge-success">{x.status}</Badge> : <StatusBadge x={x} />}</div>
    <p class="text-[15px] font-semibold leading-snug break-words">{x.kind === 'question' ? 'Q. ' + x.label : x.label}</p>
    {x.lead ? <p class="mt-0.5 line-clamp-2 break-words text-sm text-base-content/70">{x.lead}</p> : null}</div>
    <button class="btn btn-soft btn-sm shrink-0" type="button" aria-label={`${KIND[x.kind]} 탭에서 보기: ${x.label}`} onClick={() => reveal(x)}>보기</button></article>;
  return <div class="grid gap-5">
    <p class="text-sm text-base-content/70" aria-live="polite">{`${total}건 · ` + SKINDS.map(k => `${KIND[k]} ${hit[k].length}`).join(' · ')}</p>
    {total ? SKINDS.filter(k => hit[k].length).map(k => <section key={k} class="grid gap-2" aria-label={`${KIND[k]} 결과`}>
      <div class="flex items-baseline gap-2"><h2 class="font-semibold">{KIND[k]}</h2><Badge>{hit[k].length + '건'}</Badge></div><ListBox>{hit[k].map(row)}</ListBox></section>)
      : <Empty>조건에 맞는 항목이 없습니다. 숨김 처리했거나 merged로 확인된 PR은 검색하지 않습니다.</Empty>}
  </div>;
}

// ---------- Jira (조회 스냅샷, 읽기 전용) ----------
// Sprint 그룹: 티켓마다 대표 Sprint 하나(import-jira가 active > future > 가장 최근 closed로 정함)에만 넣어 중복 출력하지 않는다.
const SPST: Record<string, [string, string]> = { active: ['진행 중', 'badge-info'], future: ['예정', 'badge-warning'], closed: ['종료', 'badge-ghost'] };
const ord = (arr: string[], x?: string) => { const i = arr.indexOf(x!); return i < 0 ? arr.length : i; };
export function jiraStatuses(issues: JiraIssue[]) {
  const sc: Record<string, number> = {};
  for (const i of issues) sc[i.status || '미확인'] = (sc[i.status || '미확인'] || 0) + 1;
  return { sc, keys: Object.keys(sc).sort((a, b) => ord(JST, a) - ord(JST, b) || a.localeCompare(b)) };
}
// 기본 펼침 그룹은 '접음'을(jc:), 기본 접힘(closed) 그룹은 '펼침'을(jo:) open 목록에 기억한다
function JGroup({ k, defOpen, force, head, children }: { k: string; defOpen: boolean; force: boolean; head: ComponentChildren; children: ComponentChildren }) {
  const { isOpen, setOpen } = useApp(), mark = (defOpen ? 'jc:' : 'jo:') + k;
  const open = force || (defOpen ? !isOpen(mark) : isOpen(mark));
  return <details class={'collapse collapse-arrow ' + GROUP} open={open} data-jgroup={k} onToggle={e => { if (!force) setOpen(mark, e.currentTarget.open !== defOpen); }}>
    <summary class="collapse-title flex flex-wrap items-center gap-2 pe-12">{head}</summary><div class="collapse-content min-w-0 px-0 pb-1">{children}</div>
  </details>;
}

// Jira hover 미리보기: 조회 스냅샷의 평문 설명 일부만 텍스트로 그린다(외부 HTML·iframe 없음).
// Jira Cloud는 CSP frame-ancestors로 외부 origin의 iframe을 막으므로 원문 페이지를 직접 넣지 않는다.
interface Peek { i: JiraIssue; anchor: HTMLElement }
function JiraPeek({ peek, hide, hold }: { peek: Peek; hide: (ms?: number) => void; hold: () => void }) {
  const { snap } = useApp(), J = snap.data.jira || {}, ref = useRef<HTMLDivElement>(null), { i, anchor } = peek;
  const u = jiraUrl(snap, i.key), sp = (J.sprints || {})[String(i.sprint)];
  const ds = !J.descriptionFetched || !i.descriptionState ? 'unfetched' : i.descriptionState;
  const note = ({ unfetched: '설명 미조회: 이 스냅샷은 설명을 가져오지 않았습니다.', none: '설명 없음: Jira 설명이 비어 있습니다.',
    nontext: '텍스트 설명 없음: 설명에 이미지 등 텍스트가 아닌 내용만 있습니다.' } as Record<string, string>)[ds];
  useLayoutEffect(() => {
    anchor.setAttribute('aria-describedby', 'jcard');
    // 화면 경계 안에 둔다: 기본은 아래, 넘치면 위, 둘 다 좁으면 넓은 쪽에 두고 높이를 줄인다
    const c = ref.current!, r = anchor.getBoundingClientRect(), W = innerWidth, H = innerHeight, g = 8;
    c.style.maxHeight = ''; const h = c.offsetHeight, w = c.offsetWidth;
    const below = H - r.bottom - g, above = r.top - g, up = h > below && above > below;
    c.style.maxHeight = Math.max(120, (up ? above : below) - 6) + 'px'; c.style.overflowY = 'auto';
    c.style.left = Math.max(g, Math.min(r.left, W - w - g)) + 'px';
    c.style.top = (up ? Math.max(g, r.top - 6 - Math.min(h, above - 6)) : r.bottom + 6) + 'px';
    return () => anchor.removeAttribute('aria-describedby');
  }, [peek]);
  return <div ref={ref} id="jcard" role="dialog" aria-label="Jira 티켓 미리보기" class="card card-sm fixed z-50 w-[min(26rem,calc(100vw-16px))] border border-base-300 bg-base-100 shadow-xl"
    onPointerEnter={hold} onPointerLeave={e => e.pointerType !== 'touch' && hide(200)}
    onFocusOut={e => !ref.current!.contains(e.relatedTarget as Node) && e.relatedTarget !== anchor && hide()}>
    <div class="card-body gap-2">
      <div class="flex flex-wrap items-center gap-1"><span class="font-mono text-sm font-semibold">{i.key}</span><Badge cls="badge-info">{i.status || '상태 미확인'}</Badge>
        {i.priority ? <Badge>{i.priority}</Badge> : null}{sp ? <Badge>{sp.name || `Sprint ${i.sprint}`}</Badge> : null}</div>
      <p class="font-semibold leading-snug">{i.summary || '(제목 없음)'}</p>
      {ds === 'text' ? <div class="max-h-48 overflow-y-auto whitespace-pre-line rounded-box bg-base-200 p-2 text-sm leading-relaxed">{i.description}
        {i.descriptionTruncated ? <span class="text-base-content/60"> … (앞부분만 표시)</span> : null}</div>
        : <p class="rounded-box border border-dashed border-base-300 p-2 text-sm text-base-content/60">{note}</p>}
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/60"><span>{`Jira 조회 스냅샷 · 관찰 ${fmt(J.observedAt)}`}</span>
        {u ? <a class="link link-info" href={u} target="_blank" rel="noopener noreferrer">Jira에서 열기 ↗</a> : null}</div>
    </div>
  </div>;
}

export function JiraTab() {
  const { snap, filters } = useApp(), J = snap.data.jira, all = J?.issues || [];
  const [peek, setPeek] = useState<Peek | null>(null), t = useRef(0), cardEl = () => document.getElementById('jcard');
  const later = (f: () => void, ms: number) => { clearTimeout(t.current); t.current = window.setTimeout(f, ms); };
  const hide = (ms = 0) => ms ? later(() => setPeek(null), ms) : (clearTimeout(t.current), setPeek(null));
  const show = (anchor: HTMLElement, i: JiraIssue) => { clearTimeout(t.current); if (anchor.isConnected) setPeek({ i, anchor }); };
  useEffect(() => {
    if (!peek) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { const inCard = cardEl()?.contains(document.activeElement); hide(); if (inCard) peek.anchor.focus(); } };
    const scroll = (e: Event) => { if (!cardEl()?.contains(e.target as Node)) hide(); };
    const resize = () => hide();
    const down = (e: PointerEvent) => { const tg = e.target as Element; if (!cardEl()?.contains(tg) && !peek.anchor.contains(tg) && !tg.closest?.('button[aria-label$="미리보기"]')) hide(); };
    addEventListener('keydown', esc); addEventListener('scroll', scroll, true); addEventListener('resize', resize); document.addEventListener('pointerdown', down);
    return () => { removeEventListener('keydown', esc); removeEventListener('scroll', scroll, true); removeEventListener('resize', resize); document.removeEventListener('pointerdown', down); };
  }, [peek]);
  useEffect(() => () => clearTimeout(t.current), []);
  if (!all.length) return <Empty>Jira 스냅샷이 없습니다. coordinator가 조회 스냅샷을 가져오면 표시됩니다.</Empty>;
  const S = J!.sprints || {}, hasSprint = !!J!.sprintField, url = (k: string) => jiraUrl(snap, k);
  const q = (filters.jq || '').trim().toLowerCase(), st = jiraStatuses(all).keys.includes(filters.jst) ? filters.jst : '';
  const recKeys = new Set((snap.data.recommendations?.items || []).flatMap(r => r.jira || []));
  const num = (k: string) => +String(k).split('-')[1] || 0;
  const cmp = (a: JiraIssue, b: JiraIssue) => ord(JST, a.status) - ord(JST, b.status) || ord(JPRI, a.priority) - ord(JPRI, b.priority) || num(b.key) - num(a.key);
  const xs = all.filter(i => (!st || (i.status || '미확인') === st) && (!q || `${i.key} ${i.summary || ''} ${i.parentKey || ''}`.toLowerCase().includes(q))).sort(cmp);
  // 1단계 트리: 부모가 원본 보드 목록에 있으면(그 부모가 서브태스크가 아니면) 서브태스크를 부모 아래에 둔다. 없는 부모는 조회하지 않는다.
  // 매칭은 xs가 정본이다. 자식만 맞으면 부모를 관계 표시용으로만 보여 주고 건수에 넣지 않으며, 부모만 맞으면 자식을 끌어오지 않는다
  const byKey = new Map(all.map(i => [i.key, i])), hit = new Set(xs.map(i => i.key));
  const parentOf = (i: JiraIssue) => { const p = i.isSubtask === true && i.parentKey ? byKey.get(i.parentKey) : undefined; return p && p.isSubtask !== true ? p : undefined; };
  const kids: Record<string, JiraIssue[]> = {}, roots: JiraIssue[] = [];
  for (const i of xs) { const p = parentOf(i); if (p) (kids[p.key] = kids[p.key] || []).push(i); else roots.push(i); }
  for (const k of Object.keys(kids)) if (!hit.has(k)) roots.push(byKey.get(k)!);
  roots.sort(cmp);
  const cnt = (rs: JiraIssue[]) => rs.reduce((n, r) => n + +hit.has(r.key) + (kids[r.key] || []).length, 0);
  const jbadge = (s?: string) => <Badge cls={/progress|review/i.test(s || '') ? 'badge-info' : s === 'DEVELOPED' ? 'badge-success' : 'badge-ghost'}>{s || '상태 미확인'}</Badge>;
  const pbadge = (p?: string) => p ? <Badge cls={/^High/.test(p) ? 'badge-warning' : 'badge-ghost'}>{p}</Badge> : null;
  // 포인터를 올리면 300ms, 키보드 포커스면 150ms 뒤 미리보기를 연다(터치는 미리보기 버튼으로만)
  const trig = (i: JiraIssue, focusable: boolean) => ({
    onPointerEnter: (e: PointerEvent) => { const a = e.currentTarget as HTMLElement; if (e.pointerType !== 'touch') later(() => show(a, i), 300); },
    onPointerLeave: (e: PointerEvent) => { if (e.pointerType !== 'touch') later(() => setPeek(null), 200); },
    ...(focusable ? { onFocus: (e: FocusEvent) => { const a = e.currentTarget as HTMLElement; later(() => show(a, i), 150); },
      onBlur: (e: FocusEvent) => { if (!cardEl()?.contains(e.relatedTarget as Node)) later(() => setPeek(null), 100); } } : {}),
  });
  const sname = (k: string) => S[k]?.name || (k === 'none' ? 'Sprint 없음' : k === 'unknown' ? 'Sprint 미확인' : `Sprint ${k}`);
  // p: 트리 부모(자식 행), ctx: 매칭되지 않았지만 자식 관계를 보여 주려고 그린 부모 행
  const row = (i: JiraIssue, p?: JiraIssue) => { const ctx = !hit.has(i.key);
    return <tr key={i.key} class={`jrow hover:bg-base-200/60${ctx ? ' opacity-70' : ''}`} data-jparent={p?.key} data-jctx={ctx ? '' : undefined}>
    <td class={`whitespace-nowrap align-top font-mono text-[13px] font-semibold${p ? ' ps-7' : ''}`}>
      {p ? <span aria-hidden="true" class="me-1 text-base-content/40">└</span> : null}{url(i.key) ? <a class="link link-info" href={url(i.key)!} target="_blank" rel="noopener noreferrer" {...trig(i, true)}>{i.key}</a> : <span tabIndex={0} {...trig(i, true)}>{String(i.key)}</span>}
      <button type="button" class="btn btn-ghost btn-xs ms-1 px-1 font-sans font-normal pointer-fine:hidden" aria-label={`${i.key} 미리보기`}
        onClick={e => { e.stopPropagation(); peek && peek.i.key === i.key ? hide() : show(e.currentTarget, i); }}>미리보기</button></td>
    <td class="min-w-0 align-top"><p class="leading-snug" {...trig(i, false)}>{i.summary || '(제목 없음)'}</p>
      <div class="mt-1 flex flex-wrap gap-1 empty:hidden"><span class="contents sm:hidden">{jbadge(i.status)}{pbadge(i.priority)}</span>
        {i.isSubtask ? <Badge>{url(i.parentKey || '') ? <>부모 <a class="link link-info font-mono" href={url(i.parentKey!)!} target="_blank" rel="noopener noreferrer"
          aria-label={`부모 ${i.parentKey} Jira에서 열기`}>{i.parentKey}</a></> : '부모 미확인'}</Badge> : null}
        {ctx ? <Badge cls="badge-ghost">관계 표시 · 결과 건수 제외</Badge> : null}
        {p && gk(i) !== gk(p) ? <Badge cls="badge-warning">{`소속 ${sname(gk(i))}`}</Badge> : null}
        {(i.sprintIds || []).length > 1 ? <Badge>{`Sprint 이력 ${i.sprintIds!.length}`}</Badge> : null}
        {recKeys.has(i.key) ? <Badge cls="badge-primary">추천에 포함</Badge> : null}</div></td>
    <td class="hidden whitespace-nowrap align-top sm:table-cell">{jbadge(i.status)}</td>
    <td class="hidden whitespace-nowrap align-top sm:table-cell">{pbadge(i.priority)}</td>
  </tr>; };
  // Sprint 묶음 안 소그룹: Jira issuetype.subtask(isSubtask) 기준. 값이 없는 legacy 항목은 추측하지 않고 '유형 미확인'에 둔다. 빈 소그룹은 그리지 않는다
  const KINDS = [['일반 티켓', (i: JiraIssue) => i.isSubtask === false], ['서브태스크', (i: JiraIssue) => i.isSubtask === true],
    ['유형 미확인', (i: JiraIssue) => typeof i.isSubtask !== 'boolean']] as const;
  // 소그룹 건수는 그 안에 그린 매칭 티켓 수다(관계 표시 부모 제외, 부모 아래 서브태스크 포함)
  const table = (rows: JiraIssue[]) => KINDS.map(([name, f]) => { const rs = rows.filter(f), nk = rs.reduce((n, r) => n + (kids[r.key] || []).length, 0);
    return rs.length ? <div key={name} data-jkind={name}><p class="px-3 pt-2 text-xs font-semibold text-base-content/60">{`${name} ${cnt(rs) - nk}건${nk ? ` · 하위 서브태스크 ${nk}건` : ''}`}</p>
      <table class="table table-sm"><thead><tr><th>키</th><th>제목</th><th class="hidden sm:table-cell">상태</th><th class="hidden sm:table-cell">우선순위</th></tr></thead>
        <tbody>{rs.flatMap(r => [row(r), ...(kids[r.key] || []).map(c => row(c, r))])}</tbody></table></div> : null; });
  // 그룹 키: Sprint id, 'none'(조회했고 Sprint 없음), 'unknown'(Sprint를 조회하지 않은 스냅샷이거나 메타데이터 누락)
  const gk = (i: JiraIssue) => !hasSprint || i.sprint === undefined ? 'unknown' : i.sprint === null ? 'none' : S[String(i.sprint)] ? String(i.sprint) : 'unknown';
  const by: Record<string, JiraIssue[]> = {};
  for (const i of roots) (by[gk(i)] = by[gk(i)] || []).push(i);  // 자식은 부모 위치의 Sprint 묶음에 들어간다
  const day = (v?: string) => v ? new Date(v).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' }) : '?';
  const rank = (k: string): [number, number] => { const s = S[k], r = ({ active: 0, future: 1 } as Record<string, number>)[s?.state!];
    return k === 'none' ? [2, 0] : k === 'unknown' ? [4, 0] : r !== undefined ? [r, r ? Date.parse(s.startDate!) || 9e15 : -(Date.parse(s.startDate!) || 0)] : [3, -(Date.parse(s?.endDate!) || 0)]; };
  const keys = Object.keys(by).sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1]; });
  const force = !!(q || st), nClosed = keys.filter(k => S[k]?.state === 'closed').length;
  return <div class="grid gap-4">
    <div class="rounded-box border border-base-300 bg-base-100 p-4 text-sm leading-relaxed">
      <p><b>{`프로젝트 ${J!.project || '미설정'} · 조회 스냅샷 · 마지막 관찰 ${fmt(J!.observedAt)} (${Math.round(ageMin(J!.observedAt) / 60 * 10) / 10}시간 전). `}</b>
        {`내게 할당된 미완료 티켓 ${all.length}건이며, 진행판은 Jira를 다시 조회하거나 바꾸지 않습니다. `}
        {J!.dueSetCount ? `기본 기한(due)이 있는 티켓은 ${J!.dueSetCount}건입니다.` : '기본 기한(due) 필드는 모두 비어 있습니다.'}</p>
      {hasSprint ? <Det k="jsprint" summary="Sprint 묶음 기준"><p>{`티켓마다 대표 Sprint 하나에만 넣어 중복으로 보이지 않게 합니다. 진행 중(active) Sprint가 있으면 그것, 없으면 예정(future), 그것도 없으면 가장 최근에 끝난(closed) Sprint입니다. 'Sprint 없음'은 조회 결과 Sprint가 비어 있는 티켓만 뜻합니다. 종료 Sprint 묶음은 기본으로 접혀 있습니다. 묶음 안은 Jira 유형의 서브태스크 여부로 일반 티켓·서브태스크를 나누고, 서브태스크에는 부모 번호를 붙입니다. 부모가 이 목록에 있으면 서브태스크를 부모 바로 아래에 들여 쓰고 부모의 Sprint 묶음에 넣으며, 원래 Sprint가 다르면 '소속' 배지로 표시합니다. 목록에 없는 부모는 따로 조회하거나 건수에 넣지 않습니다. 검색·필터에서 서브태스크만 맞으면 부모를 '관계 표시'로 함께 보이되 결과 건수에서 뺍니다. 유형을 조회하지 않은 티켓은 '유형 미확인'입니다. Sprint 필드: ${J!.sprintField}.`}</p></Det>
        : <p class="mt-2"><b>Sprint 정보를 조회하지 않은 스냅샷입니다. </b>모든 티켓을 Sprint 미확인으로 표시합니다.</p>}
    </div>
    {xs.length ? keys.map(k => { const s = S[k], tag = s ? SPST[s.state!] : null;
      return <JGroup key={k} k={k} defOpen={s?.state !== 'closed'} force={force}
        head={s ? <><Badge cls={tag![1]}>{tag![0]}</Badge><span class="font-semibold">{s.name || `Sprint ${k}`}</span><Badge>{cnt(by[k]) + '건'}</Badge>
          <span class="text-xs font-normal text-base-content/60">{`${day(s.startDate)} ~ ${day(s.endDate)}`}</span></>
          : <><span class="font-semibold">{k === 'none' ? 'Sprint 없음' : 'Sprint 미확인'}</span><Badge cls={k === 'none' ? 'badge-ghost' : 'badge-warning'}>{cnt(by[k]) + '건'}</Badge></>}>
        {table(by[k])}</JGroup>; }) : <Empty>조건에 맞는 티켓이 없습니다.</Empty>}
    <Muted>{`${xs.length}/${all.length}건 표시 · Sprint 묶음 ${keys.length}개${nClosed && !force ? ` (종료 ${nClosed}개는 접힘)` : ''} · 묶음 안 정렬: 상태 → 우선순위 → 최근 키. 정렬 순서는 추천이 아닙니다.`}</Muted>
    {peek ? <JiraPeek peek={peek} hide={hide} hold={() => clearTimeout(t.current)} /> : null}
  </div>;
}
