// 작업·질문·PR·결정 탭 목록. 같은 목록 안의 행들은 daisyUI list(카드 테두리 하나)로 묶는다
import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { useApp } from '../ctx';
import { CATS, KIND, fmt, itemGroup, matches, prBadge, prState, resolvedItems, type Items } from '../lib/model';
import type { Item } from '../lib/types';
import { AskDelete } from './Dialogs';
import { MsgBox } from './Messages';
import { A, Badge, DecideBadge, Det, Dl, Empty, Fold, GROUP, GroupChk, ListBox, Md, Muted, RefBtn, SelectRow, StatusBadge } from './ui';

// 목록 한 행. head가 있으면 기본 머리(번호·상태) 대신 쓴다(요청함 메시지 행)
export function Card({ x, head, title, lead, leadCls, children }: {
  x: Item; head?: ComponentChildren; title?: string; lead?: string; leadCls?: string; children?: ComponentChildren }) {
  const { sel, editSel, pend, openDialog } = useApp();
  const isSel = !!x.id && sel.has(x.id), isPend = !!x.id && pend.has(x.id), hasId = !!x.id;
  const ld = lead ?? x.lead;
  return <article class={'list-row items-start gap-3 px-4 py-4 sm:px-5' + (isSel ? ' bg-primary/5' : '')} data-item={x.id || ''}>
    {hasId ? <label class="pt-0.5"><span class="sr-only">선택: {x.label}</span>
      <input type="checkbox" class="checkbox checkbox-sm checkbox-primary" checked={isSel}
        onChange={e => { const on = e.currentTarget.checked; editSel(m => on ? m.set(x.id!, x.kind) : m.delete(x.id!)); }} /></label> : <span />}
    <div class="list-col-grow min-w-0">
      <div class="mb-1.5 flex flex-wrap items-center gap-1.5">
        {head ?? <><RefBtn id={x.id} label={x.label} />{x.kind === 'pr' ? <Badge cls={prBadge(x.raw)}>{x.status}</Badge> : <StatusBadge x={x} />}</>}
        {isPend ? <Badge cls="badge-neutral text-base-content">삭제 요청 대기</Badge> : null}
        {hasId ? null : <Badge cls="badge-error">id 없음 · 선택 불가</Badge>}
      </div>
      <h3 class="text-[15px] font-semibold leading-snug">{x.kind === 'question' ? 'Q. ' + x.label : title || x.label}</h3>
      {ld ? <p class={'mt-1 text-sm text-base-content/75 ' + (leadCls || 'line-clamp-2')}>{ld}</p> : null}
      {children}
    </div>
    {hasId ? <button class="btn btn-ghost btn-xs text-base-content/60 hover:text-error" type="button" disabled={isPend} aria-label={`삭제 요청: ${x.label}`}
      onClick={() => openDialog(<AskDelete list={[{ kind: x.kind, id: x.id!, label: x.label }]} />)}>{isPend ? '요청됨' : '삭제 요청'}</button> : <span />}
  </article>;
}

export function PrLinks({ nums }: { nums?: (number | string)[] }) {
  const { snap } = useApp(), d = snap.data;
  return <>{(nums || []).map(n => { const p = (d.prs || {})[n] || (d.mergedPrs || {})[n] || {};
    return <span class="inline-flex items-center gap-1.5"><A label={'#' + n} url={p.url} /><Badge cls={prBadge(p)}>{prState(p)}</Badge></span>; })}</>;
}

// 값이 없으면 null이라 Dl이 그 행을 생략한다
const md = (t?: string) => t ? <Md text={t} /> : null;
function Detail({ x }: { x: Item }) {
  const { snap } = useApp(), r = x.raw;
  if (x.kind === 'work') return <Det k={'d:' + x.id} summary="검증 · 남은 일 · PR">
    <Dl rows={[['결론', md(r.conclusion)], ['검증', md(r.verification)], ['남은 일', md(r.remaining)],
      ['PR', (r.prs || []).length ? <div class="flex flex-wrap gap-x-4 gap-y-1"><PrLinks nums={r.prs} /></div> : null]]} /></Det>;
  if (x.kind === 'question') {
    const ev = (r.evidence || []).length ? r.evidence.map((e: any, i: number) => <>{i ? ', ' : ''}<A label={e.label} url={e.url} /></>) : null;
    const hist = (r.history || []).length ? <ul class="list-disc pl-4">{r.history.map((h: any) => <li>{`${fmt(h.at)} ${h.change} (이유: ${h.reason})`}</li>)}</ul> : null;
    return <Det k={'d:' + x.id} summary={`답변 전체${hist ? ` · 변경 이력 ${r.history.length}건` : ''}`}>
      <Dl rows={[['답변', md(r.answer)], ['근거', ev], ['갱신', fmt(r.updatedAt)], ['변경 이력', hist]]} /></Det>;
  }
  if (x.kind === 'pr') {
    const works = (snap.data.work || []).filter(w => (w.prs || []).map(String).includes(String(r.number))).map(w => w.title).join(', ');
    return <Det k={'d:' + x.id} summary="관찰 시각 · 관련 작업"><Dl rows={[['링크', <A label={r.url || ''} url={r.url} />], ['관련 작업', works],
      ['merge 시각', r.mergedAt ? fmt(r.mergedAt) : null], ['GitHub 갱신', fmt(r.updatedAt)],
      ['관찰', r.ok === false ? `조회 실패 ${fmt(r.failedAt)} · 마지막 관찰 ${fmt(r.observedAt)}` : fmt(r.observedAt)]]} /></Det>;
  }
  if (x.resolved) return <Det k={'d:' + x.id} summary="자세히"><Dl rows={[['내용', md(r.detail)], ['결정', r.status], ['결정 시각', r.resolvedAt ? fmt(r.resolvedAt) : null], ['출처', r.decisionSource]]} /></Det>;
  return <Det k={'d:' + x.id} summary="자세히"><Dl rows={[['내용', md(r.detail)], ['대기 범위', md(r.waiting)]]} />
    <Muted cls="mt-2">이 항목을 진행판에서 숨겨도 결정이나 승인으로 간주하지 않습니다.</Muted></Det>;
}
const RowsBase = ({ xs, live }: { xs: Item[]; live?: Map<string | undefined, Item> }) => <ListBox>{xs.map(x0 => { const x = live?.get(x0.id) || x0;
  return <Card key={x.id || x.label} x={x}><Detail x={x} /><MsgBox x={x} /></Card>; })}</ListBox>;

export function ListTab({ tab }: { tab: 'work' | 'question' | 'pr' | 'decision' }) {
  const { it: liveIt, snap, refOf, filters, pend, editing } = useApp(), D = snap.data;
  // 이 탭에서 글을 쓰는 동안에는 쓰기 시작할 때의 배치(어느 묶음·순서)를 유지하고 내용만 최신으로 그린다.
  // 상태가 완료로 바뀌거나 같은 thread 질문이 늘어 카드가 다른 부모로 옮겨지면 Composer가 다시 만들어져 포커스·IME 조합이 끊기기 때문이다.
  // 입력칸을 벗어나면 다음 렌더에서 최신 배치로 돌아간다. 새로 생긴 항목도 그때 보인다
  const frozen = useRef<Items | null>(null);
  const mine = !!editing && liveIt[tab].some(x => x.id === editing);
  frozen.current = mine ? frozen.current || liveIt : null;
  const it = frozen.current || liveIt, live = new Map(liveIt[tab].map(x => [x.id, x]));
  const rows = (xs: Item[], key?: string) => <RowsBase key={key} xs={xs} live={live} />;  // 컴포넌트를 렌더 안에서 새로 정의하면 매번 재마운트되므로 함수로 부른다
  const q = (filters.q || '').trim().toLowerCase(), st = filters.fstatus || '', cat = filters.fcat || '';
  const xs = it[tab].filter(x => matches(x, q, st, refOf) && (tab !== 'question' || !cat || x.cat === cat));
  const nodes: ComponentChildren[] = [];
  let limHit = false;
  if (tab === 'question') {
    const force = !!(q || st || cat); // 검색·필터 중에는 맞는 묶음을 펼쳐 결과를 바로 보여 준다
    for (const c of CATS) {
      const inCat = xs.filter(x => x.cat === c);
      if (!inCat.length) continue;
      const threads = [...new Set(inCat.map(x => x.thread!))];
      const topics = threads.filter(t => t && inCat.filter(x => x.thread === t).length > 1).join(' · ');
      nodes.push(<Fold key={'c:' + c} k={'c:' + c} cls={GROUP} force={force} head={<><GroupChk label={c} xs={inCat} /><span class="text-base font-semibold">{c}</span>
        <Badge>{inCat.length + '건'}</Badge><DecideBadge xs={inCat} />{topics ? <span class="basis-full text-sm font-normal text-base-content/60">{topics}</span> : null}</>}>
        <div class="grid gap-3">{threads.map(t => { const tx = inCat.filter(x => x.thread === t);
          return tx.length > 1 && t ? <Fold key={'t:' + t} k={'t:' + c + ':' + t} cls="rounded-box border-l-4 border-primary/40 bg-base-200/60" force={force}
            head={<><GroupChk label={t} xs={tx} /><span class="font-semibold text-primary">{t}</span><span class="text-sm text-base-content/60">이어지는 질문 {tx.length}건</span><DecideBadge xs={tx} /></>}>{rows(tx)}</Fold>
            : rows(tx, 'r:' + t); })}</div>
      </Fold>);
    }
  } else if (tab === 'work') {
    // 기본 화면은 진행·결정이 필요한 작업이 먼저 보이고, 완료한 작업은 접는다(검색·필터 중에는 펼침)
    const open = xs.filter(x => itemGroup(x) !== 'done'), done = xs.filter(x => itemGroup(x) === 'done');
    if (open.length) nodes.push(<div key="open" class="grid gap-2"><SelectRow label="진행·결정 작업" xs={open} />{rows(open)}</div>);
    if (done.length) nodes.push(<Fold key="done" k="workdone" cls={GROUP} force={!!(q || st)} head={<><GroupChk label="완료한 작업" xs={done} text="전체 선택" /><span class="font-semibold">완료한 작업</span><Badge cls="badge-success">{done.length + '건'}</Badge></>}>{rows(done)}</Fold>);
    const lim = it.limits;  // 검색·필터 중에는 표시하지 않는다(선택 대상에서도 빠진다). 단 HQ 번호로 찾으면 보인다
    limHit = !!(q && !st && lim.length && refOf(lim[0].id).toLowerCase() === q);
    if ((D.globalLimits || []).length && ((!q && !st) || limHit))
      nodes.push(<Fold key="limits" k="limits" cls={GROUP} force={limHit} head={<><GroupChk label="공통 검증 한계" xs={lim} /><RefBtn id={lim[0]?.id} label="공통 검증 한계" />
        <span class="font-semibold">공통 검증 한계</span><Badge>{D.globalLimits!.length + '건'}</Badge>
        {lim.length && pend.has(lim[0].id!) ? <Badge cls="badge-neutral text-base-content">삭제 요청 대기</Badge> : null}</>}>
        <ul class="grid list-disc gap-1 pl-5 text-sm">{D.globalLimits!.map(t => <li>{t}</li>)}</ul></Fold>);
  } else {
    if (xs.length) nodes.push(<div key="list" class="grid gap-2"><SelectRow label={KIND[tab] + ' 목록'} xs={xs} />{rows(xs)}</div>);
    if (tab === 'pr') nodes.push(<Muted key="prnote">PR 상태는 gh 읽기 전용 조회 결과입니다. merged로 확인된 PR {Object.keys(D.mergedPrs || {}).length}건은 이 목록에서 자동으로 숨깁니다(원본 기록 유지). 조회 실패·미확인 PR은 숨기지 않습니다. ready 전환, 리뷰 요청, merge, CI 감시는 사용자 지시 없이 하지 않습니다.</Muted>);
  }
  if (tab === 'decision') {
    // 결정이 끝난 항목(resolvedDecisions)은 원본 id·HQ 번호를 유지한다. 선택·삭제(숨김) 요청은 되지만 답장은 없다(서버 메시지 대상 아님)
    const rs = resolvedItems(snap).filter(x => matches(x, q, '', refOf));
    if (rs.length) nodes.push(<Fold key="resolved" k="resolved" cls={GROUP} force={!!q} head={<><GroupChk label="결정 완료" xs={rs} text="전체 선택" /><span class="font-semibold">결정 완료</span><Badge cls="badge-success">{rs.length + '건'}</Badge>
      <span class="basis-full text-sm font-normal text-base-content/60">사용자가 결정을 마친 항목입니다. 숨겨도 원본 기록·결정 내용·번호는 그대로 보존합니다.</span></>}>
      <ListBox>{rs.map(x => <Card key={x.id || x.label} x={x} head={<><RefBtn id={x.id} label={x.label} /><Badge cls="badge-success">{x.status}</Badge>
        {x.raw.resolvedAt ? <span class="text-xs text-base-content/60">{fmt(x.raw.resolvedAt)}</span> : null}</>}><Detail x={x} /><MsgBox x={x} /></Card>)}</ListBox></Fold>);
  }
  if (!xs.length && !limHit) nodes.unshift(<Empty key="empty">조건에 맞는 항목이 없습니다.</Empty>);
  return <>{nodes}</>;
}
