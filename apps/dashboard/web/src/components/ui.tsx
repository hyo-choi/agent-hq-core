// 공통 화면 조각. daisyUI 클래스는 빌드가 찾을 수 있게 완전한 문자열로만 쓴다(문자열 조합 금지)
import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { useApp } from '../ctx';
import { copyText } from '../lib/api';
import { mdHtml } from '../lib/md';
import { BADGE, STATE_NAME, itemGroup, safeUrl } from '../lib/model';
import type { Item } from '../lib/types';

type Kids = { children?: ComponentChildren };
export const Badge = ({ cls = 'badge-ghost', children, ...rest }: Kids & { cls?: string } & JSX.HTMLAttributes<HTMLSpanElement>) =>
  <span class={'badge badge-sm badge-soft whitespace-nowrap ' + cls} {...rest}>{children}</span>;
// state가 있으면 묶음 색은 state를 따르고, 취소·종료 등은 상태 문구 옆에 따로 보인다
export const StatusBadge = ({ x }: { x: Pick<Item, 'status' | 'state'> }) => <>
  <Badge cls={BADGE[itemGroup(x)]}>{x.status}</Badge>{x.state && x.state !== 'open' ? <Badge cls="badge-outline">{STATE_NAME[x.state]}</Badge> : null}</>;
export const Muted = ({ cls = '', children }: Kids & { cls?: string }) => <p class={'text-sm text-base-content/60 ' + cls}>{children}</p>;
export const Empty = ({ children }: Kids) =>
  <p class="rounded-box border border-dashed border-base-300 bg-base-100 px-4 py-10 text-center text-base-content/60">{children}</p>;
export const A = ({ label, url }: { label: ComponentChildren; url?: string | null }) =>
  safeUrl(url) ? <a class="link link-info" href={url!} target="_blank" rel="noopener noreferrer">{label}</a> : <>{label}</>;
// 긴 본문 Markdown. div라서 p 안에 두지 않는다. 비어 있으면 그리지 않아 Dl 행 생략 규칙이 그대로다
export const Md = ({ text, cls = '' }: { text?: string | null; cls?: string }) =>
  text ? <div class={'md ' + cls} dangerouslySetInnerHTML={{ __html: mdHtml(text) }} /> : null;
export const ListBox = ({ children }: Kids) => <div class="list rounded-box border border-base-300 bg-base-100 shadow-sm">{children}</div>;
export const GROUP = 'rounded-box border border-base-300 bg-base-100 shadow-sm';
export const DlgTitle = ({ children }: Kids) => <h2 class="mb-2 text-lg font-bold">{children}</h2>;
export const CloseBtn = ({ t = '닫기' }: { t?: string }) => { const { closeDialog } = useApp(); return <button class="btn btn-ghost" type="button" onClick={closeDialog}>{t}</button>; };
export const ErrAlert = ({ children, cls = '' }: Kids & { cls?: string }) => <p role="alert" class={'alert alert-error alert-soft text-sm ' + cls}>{children}</p>;

// 접는 상세. 펼침은 탭 sessionStorage의 open 키 목록에 남아 갱신·탭 이동·새로고침 뒤에도 유지된다
export function Det({ k, summary, children }: Kids & { k: string; summary: ComponentChildren }) {
  const { isOpen, setOpen } = useApp();
  return <details class="group/det mt-2" open={isOpen(k)} onToggle={e => setOpen(k, e.currentTarget.open)}>
    <summary class="w-fit cursor-pointer rounded text-sm font-medium text-base-content/60 hover:text-base-content">{summary}</summary>
    <div class="mt-2 rounded-box bg-base-200 p-4 text-sm leading-relaxed">{children}</div>
  </details>;
}
// 접는 묶음 = daisyUI collapse(details 기반). force면 검색·필터 결과를 보여 주려고 항상 펼친다
export function Fold({ k, cls, force, head, children }: Kids & { k: string; cls: string; force?: boolean; head: ComponentChildren }) {
  const { isOpen, setOpen } = useApp();
  return <details class={'collapse collapse-arrow ' + cls} open={!!force || isOpen(k)} onToggle={e => { if (!force) setOpen(k, e.currentTarget.open); }}>
    <summary class="collapse-title flex flex-wrap items-center gap-2 pe-12">{head}</summary>
    <div class="collapse-content min-w-0 px-2 sm:px-4">{children}</div>
  </details>;
}
export const Dl = ({ rows }: { rows: [string, ComponentChildren][] }) =>
  <dl class="grid grid-cols-1 gap-x-5 gap-y-1 sm:grid-cols-[max-content_1fr]">
    {rows.filter(r => r[1]).map(([k, v]) => <><dt class="font-medium text-base-content/60">{k}</dt><dd class="mb-2 min-w-0 sm:mb-0">{v}</dd></>)}
  </dl>;

function ManualCopy({ text }: { text: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return <>
    <DlgTitle>직접 복사해 주세요</DlgTitle>
    <Muted cls="mb-3">이 브라우저에서는 자동 복사를 쓸 수 없습니다. 선택된 번호를 Ctrl+C(⌘C)로 복사하세요.</Muted>
    <input ref={ref} readOnly class="input w-full font-mono" aria-label="복사할 번호" value={text} onFocus={e => e.currentTarget.select()} />
    <div class="modal-action"><CloseBtn /></div>
  </>;
}
// 사람용 고정 번호(HQ-n). 서버가 영속 저장한 번호라 순서·검색·숨김·재시작과 무관하다.
// 접는 묶음 머리(summary)나 선택 행 안에 있어도 접힘·선택을 바꾸지 않는다. go가 있으면 복사 대신 그 항목으로 이동한다
export function RefBtn({ id, label, go }: { id?: string | null; label: string; go?: () => void }) {
  const { refOf, toast, openDialog } = useApp();
  const r = refOf(id);
  if (!r) return null;
  return <button class="btn btn-ghost btn-xs px-1.5 font-mono font-normal tabular-nums text-base-content/60" type="button"
    title={go ? `${r}로 이동` : `${r} 복사`} aria-label={go ? `${r}로 이동: ${label}` : `번호 ${r} 복사: ${label}`}
    onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') e.stopPropagation(); }}
    onClick={async e => { e.preventDefault(); e.stopPropagation(); if (go) return go(); if (await copyText(r)) toast(`${r} 번호를 복사했습니다.`); else openDialog(<ManualCopy text={r} />); }}>{r}</button>;
}

// 묶음 전체 선택. 대상은 지금 화면(검색·필터 결과)에 보이는 항목 중 id가 있고 삭제 요청 대기가 아닌 것만이다.
// 접힌 묶음 머리에서도 누를 수 있고, checkbox 클릭은 묶음을 접거나 펼치지 않는다
export function GroupChk({ label, xs, text }: { label: string; xs: Item[]; text?: string }) {
  const { sel, editSel, pend } = useApp(), box = useRef<HTMLInputElement>(null);
  const ids = xs.filter(x => x.id && !pend.has(x.id)).map(x => [x.id!, x.kind] as const);
  const n = ids.filter(([id]) => sel.has(id)).length;
  useLayoutEffect(() => { if (box.current) box.current.indeterminate = n > 0 && n < ids.length; });
  if (!ids.length) return null;
  // label이 summary 안에서 클릭을 checkbox로 넘길 때 details가 토글되지 않게 막는다
  return <label class="flex items-center" onClick={e => { if (e.target !== box.current) { e.preventDefault(); box.current?.click(); } }}>
    <input ref={box} type="checkbox" class="checkbox checkbox-sm checkbox-primary" aria-label={`${label} 전체 선택 (${ids.length}개)`} checked={n === ids.length}
      onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') e.stopPropagation(); }}
      onChange={() => editSel(m => { const all = ids.every(([id]) => m.has(id)); for (const [id, kind] of ids) all ? m.delete(id) : m.set(id, kind); })} />
    {text ? <span class="ml-1.5 text-sm font-normal text-base-content/60" aria-hidden="true">{text}</span> : null}
  </label>;
}
// 머리가 없는 목록(진행 작업, PR, 결정, 메시지)에 붙이는 전체 선택 줄
export function SelectRow({ label, xs }: { label: string; xs: Item[] }) {
  const { pend } = useApp();
  if (!xs.some(x => x.id && !pend.has(x.id))) return null;
  return <div class="flex items-center gap-2 px-4 text-sm text-base-content/70 sm:px-5"><GroupChk label={label} xs={xs} /><span aria-hidden="true">{label} 전체 선택</span></div>;
}
export function DecideBadge({ xs }: { xs: Item[] }) {
  const n = xs.filter(x => itemGroup(x) === 'decide').length;
  return n ? <Badge cls="badge-warning">결정 필요 {n}</Badge> : null;
}
