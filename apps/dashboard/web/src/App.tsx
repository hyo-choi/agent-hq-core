// 화면 셸: 상태·60초 갱신·탭·사이드바·대화상자·토스트. 같은 id를 key로 diff하므로 갱신해도 입력·포커스·펼침·대화상자가 유지된다
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Ctx, useApp, type AppCtx } from './ctx';
import { detectNew, detectStatus, newBox, statusBox } from './lib/alerts';
import { fetchSnap } from './lib/api';
import { mdPlain } from './lib/md';
import { CATS, REFRESH_MS, STALE_MIN, TABS, ageMin, fmt, isView, items, pendingIds, resolvedItems, viewName } from './lib/model';
import { KEYS, session } from './lib/storage';
import type { Item, Snap } from './lib/types';
import { flash, useAlertRows } from './components/Alerts';
import { ShowExport, AskDelete } from './components/Dialogs';
import { ListTab } from './components/Lists';
import { Inbox, QuickPanel } from './components/Messages';
import { Sidebar } from './components/Sidebar';
import { JiraTab, Recs, Search, jiraStatuses } from './components/Views';
import { Badge } from './components/ui';

const FILTERS = ['q', 'fstatus', 'fcat', 'jq', 'jst', 'gq'];
const SearchIcon = () => <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="size-4 opacity-50" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path stroke-linecap="round" d="m20 20-3.5-3.5" /></svg>;

export function App() {
  const [snap, setSnap] = useState<Snap | null>(null), [loadErr, setLoadErr] = useState(''), [loadedAt, setLoadedAt] = useState('');
  const [tab, setTabState] = useState<string>(() => isView(location.hash.slice(1)) ? location.hash.slice(1) : isView(session.get('tab', '')) ? session.get('tab', '') : 'home');
  const [sel, setSel] = useState(() => new Map<string, string>(session.get<[string, string][]>('sel', [])));
  const [open, setOpenSet] = useState(() => new Set<string>(session.get<string[]>('open', [])));
  const [filters, setFiltersState] = useState(() => Object.fromEntries(FILTERS.map(id => [id, session.get(id === 'jst' ? 'f:jst' : 'f:' + id, '')])));
  const [toastMsg, setToast] = useState<{ msg: string; kind: string; n: number } | null>(null);
  const [dlg, setDlg] = useState<{ node: ComponentChildren; n: number } | null>(null), dlgRef = useRef<HTMLDialogElement>(null);
  const [alertTick, setAlertTick] = useState(0), [, setTick] = useState(0), [editing, setEditing] = useState<string | null>(null);
  const after = useRef<(() => void)[]>([]), nav = useRef<HTMLInputElement>(null);

  const setTab = useCallback((k: string) => { setTabState(k); session.set('tab', k); try { history.replaceState(null, '', '#' + k); } catch {} }, []);
  const setOpen = useCallback((key: string, on: boolean) => setOpenSet(s => {
    if (s.has(key) === on) return s;
    const n = new Set(s); on ? n.add(key) : n.delete(key); session.set('open', [...n]); return n;
  }), []);
  const editSel = useCallback((f: (m: Map<string, string>) => void) => setSel(s => { const n = new Map(s); f(n); session.set('sel', [...n]); return n; }), []);
  const setFilters = useCallback((v: Record<string, string>) => setFiltersState(f => { for (const [k, x] of Object.entries(v)) session.set('f:' + k, x); return { ...f, ...v }; }), []);
  const toast = useCallback((msg: string, kind = 'ok') => {
    const n = Date.now() + Math.random();
    setToast({ msg, kind, n }); setTimeout(() => setToast(t => t?.n === n ? null : t), kind === 'err' ? 9000 : 4000);
  }, []);
  const afterRender = useCallback((f: () => void) => { after.current.push(f); setTick(t => t + 1); }, []);
  const bumpAlerts = useCallback(() => setAlertTick(t => t + 1), []);

  const load = useCallback(async () => {
    try {
      const s = await fetchSnap();
      // 정상 응답에서만 비교한다(실패하면 기준선·알림을 건드리지 않는다). 두 패널이 묶음을 나누므로 둘 다 감지한 뒤 그린다
      const a0 = newBox.get(), a1 = detectNew(a0, s); if (a1 !== a0) newBox.put(a1);
      const s0 = statusBox.get(), s1 = detectStatus(s0, s); if (s1 !== s0) statusBox.put(s1);
      const it = items(s), live = new Set([...Object.values(it).flat(), ...resolvedItems(s)].map(x => x.id));  // 결정 완료도 선택 대상이다
      editSel(m => { for (const id of [...m.keys()]) if (!live.has(id)) m.delete(id); });
      setSnap(s); setLoadErr(''); setLoadedAt(new Date().toISOString()); bumpAlerts();
    } catch (e: any) {
      setLoadErr(`데이터를 읽지 못했습니다: ${e.message}. 마지막으로 읽은 내용을 표시합니다.`);
    }
  }, []);

  useEffect(() => {
    load();
    // ponytail: 숨겨진 탭에서는 poll하지 않는다. 서버 PR 자동 조회도 이 요청에 얹혀 있어 함께 멈춘다
    const iv = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    const vis = () => { if (!document.hidden) load(); };
    const hash = () => { const h = location.hash.slice(1); if (isView(h)) { setTabState(h); session.set('tab', h); } };
    const storage = (e: StorageEvent) => { if (e.key === KEYS.alerts || e.key === KEYS.status) bumpAlerts(); };  // 다른 탭에서 확인한 알림을 반영한다
    document.addEventListener('visibilitychange', vis); addEventListener('hashchange', hash); addEventListener('storage', storage);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', vis); removeEventListener('hashchange', hash); removeEventListener('storage', storage); };
  }, []);
  useEffect(() => { const fs = after.current.splice(0); for (const f of fs) f(); });  // afterRender: 이번 렌더가 DOM에 반영된 뒤 실행
  useLayoutEffect(() => { const d = dlgRef.current; if (d && dlg && !d.open) d.showModal(); }, [dlg]);

  const it = useMemo(() => snap ? items(snap) : null, [snap]);
  const pend = useMemo(() => snap ? pendingIds(snap) : new Set<string>(), [snap]);
  const refOf = useCallback((id?: string | null) => (id && snap?.refs[id]) || '', [snap]);
  // 항목을 그 탭에서 보이게 하고 강조한다. 검색·필터에 걸러져 있으면 HQ 번호 정확 검색으로 그 항목만 보이게 한다
  const reveal = useCallback((x: Item) => {
    setTab(x.kind);
    const find = () => document.querySelector(`#list [data-item="${CSS.escape(x.id || '')}"]`);
    afterRender(() => {
      const t = find();
      if (t) return flash(t);
      const r = refOf(x.id);
      if (!r) return toast('항목 위치를 찾지 못했습니다. 목록에서 직접 확인해 주세요.');
      setFilters({ q: r, fstatus: '', fcat: '' });
      afterRender(() => { const t2 = find(); t2 ? flash(t2) : toast('항목 위치를 찾지 못했습니다. 목록에서 직접 확인해 주세요.'); });
    });
  }, [refOf]);

  // 첫 응답 전·첫 실패 때는 제목과 상태만 보인다(이후 실패는 마지막 내용을 유지한 채 경고만 띄운다)
  if (!snap || !it) return <main class="mx-auto w-full max-w-6xl px-4 pt-5 sm:px-6 lg:px-10 lg:pt-8">
    <p class="text-sm font-medium text-base-content/60">Agent HQ 진행판</p><h1 class="text-2xl font-bold tracking-tight sm:text-3xl">{viewName(tab)}</h1>
    {loadErr ? <div role="alert" class="alert alert-error mt-4">{loadErr}</div> : <p class="mt-1 text-sm text-base-content/60">불러오는 중…</p>}</main>;
  const ctx: AppCtx = { snap, it, pend, refOf, tab, setTab, sel, editSel, isOpen: k => open.has(k), setOpen, filters, setFilters, toast,
    openDialog: node => setDlg({ node, n: Date.now() }), closeDialog: () => dlgRef.current?.close(), reload: load, reveal, afterRender, alertTick, bumpAlerts, editing, setEditing };
  return <Ctx.Provider value={ctx}>
    <Body nav={nav} loadErr={loadErr} loadedAt={loadedAt} />
    <dialog ref={dlgRef} class="modal modal-bottom sm:modal-middle" onClose={() => setDlg(null)}
      onClick={e => { if (e.target === dlgRef.current) dlgRef.current!.close(); }}>{/* 바깥(backdrop)을 누르면 닫는다. Escape는 dialog 기본 동작 */}
      <div class="modal-box max-w-2xl" key={dlg?.n}>{dlg?.node}</div></dialog>
    <div class="toast toast-top toast-center z-50 empty:hidden" role="status" aria-live="polite">
      {toastMsg ? <div class={'alert shadow-lg ' + (toastMsg.kind === 'err' ? 'alert-error' : 'alert-success')}><span>{toastMsg.msg}</span></div> : null}</div>
  </Ctx.Provider>;
}

function Body({ nav, loadErr, loadedAt }: { nav: { current: HTMLInputElement | null }; loadErr: string; loadedAt: string }) {
  const { snap, it, tab, setTab, pend, sel, filters, setFilters, editSel, openDialog } = useApp(), d = snap.data;
  const alerts = useAlertRows();
  const warn: string[] = [];
  if (ageMin(d.updatedAt) > STALE_MIN) warn.push(`작업·질문 스냅샷이 ${Math.round(ageMin(d.updatedAt))}분 전 것입니다. 지금 상태와 다를 수 있습니다.`);
  if (ageMin(d.prsCheckedAt) > STALE_MIN) warn.push(d.prsCheckedAt ? `PR 상태 조회가 ${Math.round(ageMin(d.prsCheckedAt))}분 전 것입니다.` : 'PR 상태를 아직 조회하지 않았습니다.');
  const failed = Object.values(d.prs || {}).filter(p => p.ok === false).map(p => '#' + p.number);
  if (failed.length) warn.push(`PR 조회 실패: ${failed.join(', ')}. 마지막 관찰값을 표시하며, 실패한 PR은 merged로 추정해 숨기지 않습니다.`);
  const PRR = snap.prRefresh;
  if (PRR.ok === false) warn.push(`PR 자동 조회 실패(${PRR.error || '원인 미상'}, ${fmt(PRR.finishedAt)}). 마지막 관찰값을 유지하고 5분 뒤 다시 시도합니다.`);
  const nMerged = Object.keys(d.mergedPrs || {}).length, decs = d.pendingDecisions || [], nDecide = decs.length;
  const reqPend = snap.requests.filter(r => r.status === 'pending').length;
  const unread = snap.messages.filter(m => m.status === 'received').length;  // 자유 메시지 포함 미처리(접수됨) 메시지도 요청함 수량에 넣는다
  const counts: Record<string, number> = { work: it.work.length, question: it.question.length, pr: it.pr.length, jira: (d.jira?.issues || []).length, decision: it.decision.length, inbox: reqPend + unread };
  const tip: Record<string, string> = { inbox: `삭제 요청 대기 ${reqPend}건 · 미처리 메시지 ${unread}건` };
  const hot = (k: string) => k === 'decision' && counts[k] > 0;  // 요청함 대기 수는 다른 메뉴와 같은 차분한 badge로 둔다
  useEffect(() => { document.title = (nDecide ? `(${nDecide}) ` : '') + 'Agent HQ 진행판'; }, [nDecide]);
  const isList = tab === 'work' || tab === 'question' || tab === 'pr' || tab === 'decision';
  const selected = [...it.work, ...it.question, ...it.pr, ...it.decision, ...it.limits, ...it.message, ...resolvedItems(snap)].filter(x => sel.has(x.id!));
  const gotoJira = (k: string) => { setFilters({ jq: k, jst: '' }); setTab('jira'); };
  const jst = jiraStatuses(d.jira?.issues || []);
  const input = (id: string) => ({ value: filters[id] || '', onInput: (e: any) => setFilters({ [id]: e.currentTarget.value }) });
  // 결정 대기·요청함 대기는 어느 탭에서도 놓치지 않게 상단에 짧게 둔다(해당 탭에서는 목록이 같은 내용을 보여 주므로 생략)
  const callout = [...(tab === 'decision' ? [] : decs.map(x => <div key={x.id || x.title} role="alert" class="alert alert-warning alert-soft alert-vertical items-start justify-items-start text-start sm:alert-horizontal sm:grid-cols-[1fr_auto] sm:items-center">
    <div class="min-w-0"><p class="font-semibold">{'결정 필요 · ' + x.title}</p>{x.waiting ? <p class="text-sm opacity-80">{mdPlain(x.waiting)}</p> : null}</div>
    <button class="btn btn-sm whitespace-nowrap" type="button" onClick={() => setTab('decision')}>결정 보기</button></div>)),
    ...(tab === 'inbox' || !reqPend ? [] : [<div key="req" role="status" class="alert alert-info alert-soft alert-vertical items-start justify-items-start text-start sm:alert-horizontal sm:grid-cols-[1fr_auto] sm:items-center">
      <p>{`삭제 요청 ${reqPend}건이 담당 에이전트 확인을 기다립니다.`}</p>
      <button class="btn btn-sm whitespace-nowrap" type="button" onClick={() => setTab('inbox')}>요청함 보기</button></div>])];
  // 선택 바가 떠 있으면 플로팅 버튼을 그 높이만큼 올린다(좁은 화면에서는 바가 여러 줄이 된다)
  const bar = useRef<HTMLDivElement>(null), [barH, setBarH] = useState(0), hasSel = selected.length > 0;
  useLayoutEffect(() => {
    const b = bar.current; if (!b) return setBarH(0);
    const f = () => setBarH(b.offsetHeight); f();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(f); ro.observe(b); return () => ro.disconnect();
  }, [hasSel]);
  const goHome = (e: Event) => { e.preventDefault(); setTab('home'); if (nav.current) nav.current.checked = false; };
  return <>
    <div class="drawer lg:drawer-open">
      <input ref={nav} id="nav" type="checkbox" class="drawer-toggle" aria-label="메뉴 열기·닫기" />
      <div class="drawer-content flex min-w-0 flex-col">
        <header class="navbar sticky top-0 z-20 min-h-14 gap-2 border-b border-base-300 bg-base-100 px-2 lg:hidden">
          <label for="nav" class="btn btn-square btn-ghost" aria-label="메뉴 열기">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="size-5" aria-hidden="true"><path stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
          </label>
          <a href="#home" class="flex-1 truncate font-semibold" title="홈으로" aria-current={tab === 'home' ? 'page' : undefined} onClick={goHome}>Agent HQ 진행판</a>
          <span>{nDecide ? <Badge cls="badge-warning">{`결정 ${nDecide}`}</Badge> : null}</span>
        </header>
        <nav class="tabs tabs-box tabs-sm mx-4 mt-3 flex-nowrap overflow-x-auto bg-base-100 lg:hidden" aria-label="보기 선택">
          {TABS.map(([k, name]) => <button key={k} class={'tab shrink-0 gap-1' + (k === tab ? ' tab-active' : '')} type="button" aria-current={k === tab ? 'page' : undefined} onClick={() => setTab(k)}>
            {name}{counts[k] == null ? null : <span class={hot(k) ? 'font-bold text-warning' : 'opacity-60'} title={tip[k]} aria-label={tip[k]}>{counts[k]}</span>}</button>)}
        </nav>
        {/* 모바일 알림: 본문 위 흐름 안. 홈은 본문에 알림을 그리므로 모바일 상단 알림은 홈에서만 숨긴다 */}
        <div class={'lg:hidden' + (tab === 'home' ? ' hidden' : '')}>
          <div class="mx-4 mt-3 empty:hidden">{alerts.news()}</div><div class="mx-4 mt-3 empty:hidden">{alerts.stats()}</div>
        </div>
        <main class="mx-auto w-full max-w-6xl px-4 pb-36 pt-5 sm:px-6 lg:px-10 lg:pt-8">
          <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3"><div class="min-w-0">
            <p class="text-sm font-medium text-base-content/60">Agent HQ 진행판</p>
            <h1 class="text-2xl font-bold tracking-tight sm:text-3xl">{viewName(tab)}</h1>
            <p class="mt-1 text-sm text-base-content/60">{`스냅샷 ${fmt(d.updatedAt)} · PR 조회 ${fmt(d.prsCheckedAt)}${PRR.running ? ' (조회 중)' : ''} · 실시간 연동 아님`}</p>
          </div></div>
          {loadErr ? <div role="alert" class="alert alert-error mt-4">{loadErr}</div> : null}
          {callout.length ? <div class="mt-5 grid gap-3">{callout}</div> : null}
          {warn.length ? <div role="alert" class="alert alert-warning alert-soft mt-4 items-start text-sm"><ul class="grid list-disc gap-1 pl-4">{warn.map(w => <li>{w}</li>)}</ul></div> : null}
          <section id="panel" role="tabpanel" aria-labelledby={'tab-' + tab} class="mt-6">
            {isList ? <div class="mb-3 flex flex-wrap items-center gap-2">
              <label class="input min-w-0 flex-[1_1_16rem]"><SearchIcon /><span class="sr-only">검색</span>
                <input type="search" class="grow" placeholder="제목·내용·HQ 번호 검색" autocomplete="off" {...input('q')} /></label>
              <label class="sr-only" for="fstatus">상태 필터</label>
              <select id="fstatus" class="select w-auto" {...input('fstatus')}>
                <option value="">모든 상태</option><option value="active">진행·리뷰</option><option value="decide">결정 필요</option><option value="done">완료</option></select>
              {tab === 'question' ? <><label class="sr-only" for="fcat">질문 분류</label>
                <select id="fcat" class="select w-auto" {...input('fcat')}><option value="">모든 분류</option>{CATS.map(c => <option value={c}>{c}</option>)}</select></> : null}
            </div> : null}
            {tab === 'jira' && (d.jira?.issues || []).length ? <div class="mb-3 flex flex-wrap items-center gap-2">
              <label class="input min-w-0 flex-[1_1_16rem]"><SearchIcon /><span class="sr-only">Jira 검색</span>
                <input type="search" class="grow" placeholder="티켓 키·제목 검색" autocomplete="off" {...input('jq')} /></label>
              <label class="sr-only" for="jst">Jira 상태</label>
              <select id="jst" class="select w-auto" value={jst.keys.includes(filters.jst) ? filters.jst : ''} onInput={(e: any) => setFilters({ jst: e.currentTarget.value })}>
                <option value="">모든 상태</option>{jst.keys.map(x => <option value={x}>{`${x} (${jst.sc[x]})`}</option>)}</select>
            </div> : null}
            {tab === 'search' ? <div class="mb-3 flex flex-wrap items-center gap-2">
              <label class="input min-w-0 flex-[1_1_16rem]"><SearchIcon /><span class="sr-only">통합 검색</span>
                <input type="search" class="grow" placeholder="작업·질문·PR·결정 전체에서 제목·내용·HQ·PR 번호 검색" autocomplete="off" {...input('gq')} /></label>
            </div> : null}
            {/* 홈 알림: 사이드바·모바일 알림과 같은 목록·확인 상태를 홈 상단에 따로 그린다(추천 위). 폭이 되면 2열이다 */}
            {tab === 'home' ? <div class="@container mb-8"><div class="grid items-start gap-4 @2xl:grid-cols-2">{alerts.news(true)}{alerts.stats(true)}</div></div> : null}
            <div id="list" class="grid gap-4">
              {tab === 'home' ? <Recs gotoJira={gotoJira} /> : tab === 'jira' ? <JiraTab /> : tab === 'search' ? <Search /> : tab === 'inbox' ? <Inbox /> : <ListTab key={tab} tab={tab as any} />}
            </div>
          </section>
        </main>
      </div>
      <Sidebar tab={tab} setTab={setTab} nav={nav} counts={counts} tip={tip} hot={hot} loadedAt={loadedAt}
        note={`스냅샷은 coordinator가 작업 경계마다 갱신합니다. PR 상태는 화면이 열려 있을 때 최대 5분 간격으로 gh 읽기 전용 자동 조회하며, merged PR ${nMerged}건은 자동으로 숨깁니다. 화면은 탭이 보이는 동안 60초마다 데이터만 다시 읽습니다. 실시간 연동이 아닙니다.`}
        alerts={<><div class="empty:hidden">{alerts.news()}</div><div class="empty:hidden">{alerts.stats()}</div></>} />
    </div>
    {hasSel ? <div ref={bar} class="fixed bottom-4 left-1/2 z-40 flex w-[min(56rem,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center gap-2 rounded-box bg-neutral p-2 pl-4 text-neutral-content shadow-xl lg:left-[calc(50%+var(--sidebar-w,18rem)/2)] lg:w-[min(56rem,calc(100%-var(--sidebar-w,18rem)-2rem))]" role="region" aria-label="선택한 항목 작업">
      <span class="grow whitespace-nowrap text-sm font-semibold" aria-live="polite">{`${selected.length}개 선택됨`}</span>
      <button class="btn btn-sm btn-ghost text-neutral-content hover:bg-neutral-content/10" type="button" onClick={() => editSel(m => m.clear())}>선택 해제</button>
      <button class="btn btn-sm btn-primary" type="button" onClick={() => openDialog(<ShowExport xs={selected} />)}>JSON 내보내기</button>
      <button class="btn btn-sm btn-error" type="button" onClick={() => openDialog(<AskDelete list={selected.map(({ kind, id, label }) => ({ kind, id: id!, label }))} />)}>삭제 요청</button>
    </div> : null}
    <QuickPanel lift={barH} />
  </>;
}
