// 항목 메시지(결정 답변·후속 질문)·자유 메시지·요청함. 서버는 보관·표시만 한다. 보내도 결정 승인·작업 완료로 바뀌지 않으며,
// coordinator가 읽고 처리한 뒤 답변을 남긴다. 사용자 글과 답변 본문은 Md(raw HTML 이스케이프, http·https 절대 링크만)로 그린다
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useApp } from '../ctx';
import { markSeen, newBox } from '../lib/alerts';
import { post } from '../lib/api';
import { KIND, MSG_KINDS, MSG_MAX, MSG_ST, fmt, msgName, msgTarget, newId, oneLine, resolvedItems, tgtName } from '../lib/model';
import { loadDrafts, setDraft } from '../lib/storage';
import type { Item, Kind, Msg, MsgLink } from '../lib/types';
import { Card } from './Lists';
import { Badge, Det, Empty, ErrAlert, Fold, GROUP, GroupChk, ListBox, Md, Muted, RefBtn, SelectRow } from './ui';

// 같은 초안 키의 Composer와 FlushCard는 요청함과 플로팅 패널에 동시에 있을 수 있다. 전송 상태는 모듈에 두고, 바뀌면 모든 인스턴스를 다시 그린다.
// 그래서 한쪽이 보내는 중이면 다른 쪽도 막히고, 패널을 닫거나 탭을 옮겨도 상태가 이어진다
const subs = new Set<() => void>();
const ping = () => subs.forEach(f => f());
function useShared() {
  const [, rerender] = useState(0);
  useEffect(() => { const f = () => rerender(n => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
}
const sendSt: Record<string, { busy: boolean; err: string; failed: boolean }> = {};

// 항목 메시지와 자유 메시지(kind general, itemId 없음)가 같은 입력·전송·초안·재시도 흐름을 쓴다. dkey는 초안 키다.
// textarea는 비제어 입력이라 60초 갱신·IME 조합 중에도 값과 커서를 건드리지 않는다. 초안은 localStorage에 남는다
export function Composer({ dkey, kind, itemId, ariaLabel, placeholder, rows = 3 }: {
  dkey: string; kind: string; itemId: string | null; ariaLabel: string; placeholder: string; rows?: number }) {
  const { toast, reload, setEditing } = useApp();
  const ta = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => loadDrafts()[dkey]?.text || '');
  useShared();
  const st = sendSt[dkey] ||= { busy: false, err: '', failed: false }, { busy, err, failed } = st;
  const upd = (v: Partial<typeof st>) => { Object.assign(st, v); ping(); };
  // 다른 곳의 같은 키 입력칸에서 쓰거나 보내 초안이 바뀌면 따라간다(지금 쓰는 입력칸은 건드리지 않는다)
  useLayoutEffect(() => {
    const t = ta.current, d = loadDrafts()[dkey]?.text || '';
    if (t && document.activeElement !== t && t.value !== d) { t.value = d; setText(d); }
  });
  // 편집 고정(App editing)은 textarea blur가 아니라 이 Composer 바깥으로 실제로 나갔을 때 푼다. 보내기를 누르면 mousedown에서 textarea가
  // blur되는데, 그때 풀면 다시 그리며 카드가 다른 묶음으로 옮겨져 click이 사라진다. 누르는 동안·전송 중에는 유지하고, 끝난 뒤 포커스가 밖이면 푼다
  const wrap = useRef<HTMLDivElement>(null), pressing = useRef(false), sending = useRef(false);
  const release = () => {
    if (pressing.current || sending.current || wrap.current?.contains(document.activeElement)) return;
    setEditing(cur => cur === dkey ? null : cur);
  };
  useEffect(() => {
    // pointerup 뒤 click이 같은 입력 처리에서 먼저 실행되도록 다음 task에서 확인한다
    const up = () => { if (pressing.current) { pressing.current = false; setTimeout(release, 0); } };
    addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
    return () => { removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true); setEditing(cur => cur === dkey ? null : cur); };
  }, []);
  // 내용을 고치면 messageId를 새로 받는다. 같은 번호로 다른 글을 보내 충돌(409)하지 않게 하기 위해서다
  const onInput = (v: string) => { setText(v); setDraft(dkey, v ? { text: v, mid: null } : null); ping(); };
  const send = async () => {
    const v = ta.current!.value;
    if (!v.trim() || st.busy) return;
    const mid = loadDrafts()[dkey]?.mid || newId();  // 실패 뒤 그대로 다시 보내면 같은 번호라 서버가 한 번만 접수한다
    setDraft(dkey, { text: v, mid });
    upd({ busy: true, err: '' }); sending.current = true;
    const s = newBox.get(); if (s) newBox.put(markSeen(s, 'm:' + mid));  // 내가 보낸 메시지는 새 항목 알림에서 뺀다(보내기 전에 표시해 동시 갱신과 경쟁하지 않는다)
    try {
      const body = await post('api/messages', itemId ? { messageId: mid, kind, itemId, text: v } : { messageId: mid, kind, text: v }, 'message');
      setDraft(dkey, null); if (ta.current) ta.current.value = ''; setText('');
      toast(body.duplicate ? '이미 접수된 메시지입니다.' : `${msgName(kind)}을 접수했습니다. 담당 에이전트가 확인하면 여기에 답변이 표시됩니다.`);
      upd({ busy: false, failed: false }); await reload();
      // 전송이 끝났으면 입력칸에 다시 포커스가 있지 않은 한 고정을 푼다(비워진 버튼은 disabled라 포커스 이동 신호가 오지 않을 수 있다)
      sending.current = false; if (document.activeElement !== ta.current) setEditing(cur => cur === dkey ? null : cur);
    } catch (e: any) {
      upd({ busy: false, failed: true, err: `보내지 못했습니다: ${e.message}. 쓴 내용은 그대로 두었습니다. 고치지 않고 다시 보내면 같은 메시지 번호라 중복 접수되지 않습니다.` });
      sending.current = false; release();
    }
  };
  return <div ref={wrap} onFocusIn={() => setEditing(dkey)} onPointerDown={() => { pressing.current = true; }}
    onFocusOut={e => { if (!wrap.current?.contains(e.relatedTarget as Node)) release(); }}>
    {/* 보내는 중에는 모든 진입점의 같은 키 입력칸을 읽기 전용으로 둔다. 성공하면 초안을 지우므로 그 사이 고친 글이 조용히 사라지지 않게 한다 */}
    <textarea ref={ta} class="textarea w-full text-sm" rows={rows} maxLength={MSG_MAX} aria-label={ariaLabel} placeholder={placeholder}
      readOnly={busy} defaultValue={text} onInput={e => onInput(e.currentTarget.value)} />
    <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
      <span class="text-xs tabular-nums text-base-content/60">{text.trim().length}/{MSG_MAX}</span>
      <button class="btn btn-sm btn-primary" type="button" disabled={busy || !text.trim()} onClick={send}>{busy ? '보내는 중…' : failed ? '다시 보내기' : '보내기'}</button>
    </div>
    <div aria-live="assertive">{err ? <ErrAlert>{err}</ErrAlert> : null}</div>
  </div>;
}

export const msgLabel = (m: Msg) => `${msgName(m.kind)} ${oneLine(m.text).slice(0, 40)}`;
// 메시지 자체 번호(msg-<messageId>)는 복사, 연결 항목 번호는 누르면 그 항목으로 이동한다
const MsgRef = ({ m }: { m: Msg }) => <RefBtn id={'msg-' + m.messageId} label={msgLabel(m)} />;
function LinkRef({ t }: { t: MsgLink | null }) {
  const { refOf, it, snap, toast, reveal } = useApp();
  if (!t || !refOf(t.id)) return null;
  // 목록에 없으면 이유만 알리고 숨김·merged를 되돌리지 않는다
  const go = () => {
    const r = refOf(t.id), x = [...Object.values(it).flat(), ...resolvedItems(snap)].find(x => x.id === t.id);  // 결정 완료 카드도 이동 대상(reveal의 flash가 결정 완료 묶음을 펼친다)
    if (x) return reveal(x);
    if (Object.values(snap.data.mergedPrs || {}).some(p => p.id === t.id)) return toast(`${r}은 merged로 확인된 PR이라 PR 목록에서 자동으로 숨겼습니다(원본 기록 유지).`);
    if (snap.requests.some(q => q.status === 'done' && (q.items || []).some(i => i.id === t.id))) return toast(`${r}은 삭제 요청으로 진행판에서 숨긴 항목입니다(원본 기록 유지).`);
    toast(`${r}은 지금 진행판 목록에 없습니다.`);
  };
  return <span class="inline-flex items-center text-xs text-base-content/60">연결<RefBtn id={t.id} label={'연결 항목 ' + t.label} go={go} /></span>;
}
function MsgItem({ m }: { m: Msg }) {
  const { refOf } = useApp();
  const t = msgTarget(m), src = m.itemId ? tgtName({ kind: m.kind, label: m.label || '' }) : '자유 메시지', mref = refOf('msg-' + m.messageId);
  return <li class="grid min-w-0 grid-cols-1 gap-1.5 rounded-box border border-base-300 bg-base-100 p-3">
    <div class="flex flex-wrap items-center gap-1.5 text-xs text-base-content/60"><Badge cls={(MSG_ST[m.status] || [m.status])[1]}>{(MSG_ST[m.status] || [m.status])[0]}</Badge>
      {`${msgName(m.kind)} · ${fmt(m.createdAt)}${m.processedAt ? ' · 처리 ' + fmt(m.processedAt) : ''}`}</div>
    <Md text={m.text} />
    {m.link ? <Muted cls="break-words text-xs">{`담당 에이전트가 ${refOf(t!.id) || ''} ${tgtName(t!)}에 분류했습니다(${fmt(m.link.at)}${m.link.note ? ', ' + m.link.note : ''}). 원래 출처: ${src}`}</Muted> : null}
    {m.processNote ? <Muted cls="whitespace-pre-wrap break-words">{'처리 메모: ' + m.processNote}</Muted> : null}
    {(m.replies || []).map(r => <div class="border-l-2 border-base-300 pl-3"><p class="text-xs font-medium text-base-content/60">에이전트 답변 · {fmt(r.at)}</p>
      <Md text={r.text} /></div>)}
    <Muted cls="break-all font-mono text-xs">{`${mref ? '메시지 번호 ' + mref + ' · ' : ''}messageId ${m.messageId}`}</Muted>
  </li>;
}
const StBadge = ({ m }: { m: Msg }) => <Badge cls={(MSG_ST[m.status] || [m.status, 'badge-ghost'])[1]}>{(MSG_ST[m.status] || [m.status])[0]}</Badge>;
// 접힌 한 줄: 상태·유형·시각·답변 수·본문 앞부분. min-w-0은 grid 부모가 nowrap 미리보기 길이만큼 넓어져 카드 밖으로 넘치지 않게 한다. 펼치면 원문·답변·처리 기록. 펼침은 open(mx:)에 남는다
function MsgFold({ m }: { m: Msg }) {
  const { isOpen, setOpen } = useApp(), key = 'mx:' + m.messageId, n = (m.replies || []).length;
  return <details class="group/mx min-w-0 rounded-box border border-base-300 bg-base-100" open={isOpen(key)} data-item={'msg-' + m.messageId} onToggle={e => setOpen(key, e.currentTarget.open)}>
    <summary class="flex cursor-pointer flex-wrap items-center gap-1.5 px-3 py-2 text-sm"><MsgRef m={m} /><StBadge m={m} /><Badge>{msgName(m.kind)}</Badge>
      {m.link && m.kind === 'general' ? <Badge cls="badge-primary">분류됨</Badge> : null}{n ? <Badge>답변 {n}</Badge> : null}
      <span class="text-xs text-base-content/60">{fmt(m.createdAt)}</span>
      <span class="min-w-0 basis-full truncate text-base-content/80 group-open/mx:hidden">{oneLine(m.text)}</span></summary>
    <ul class="grid px-2 pb-2"><MsgItem m={m} /></ul>
  </details>;
}
// 작업·질문·PR·결정 카드의 접힌 "후속 질문"(결정은 "답장 쓰기"). 분류 연결된 메시지도 연결 항목 카드에 보인다.
// 결정 완료(resolved) 카드는 받은 메시지의 원문·답변만 읽기 전용으로 보인다(서버가 새 메시지 대상으로 받지 않으므로 입력칸 없음)
export function MsgBox({ x }: { x: Item }) {
  const { snap } = useApp();
  if (!x.id || !MSG_KINDS.includes(x.kind)) return null;
  const ms = snap.messages.filter(m => msgTarget(m)?.id === x.id), nrep = ms.reduce((n, m) => n + (m.replies || []).length, 0);
  if (x.resolved) return ms.length ? <Det k={'m:' + x.id} summary={`받은 메시지 ${ms.length}${nrep ? ' · 답변 ' + nrep : ''}`}>
    <div class="grid gap-2">{ms.map(m => <MsgFold key={m.messageId} m={m} />)}</div></Det> : null;
  const head = (x.kind === 'decision' ? '답장 쓰기' : '후속 질문') + (ms.length ? ` · 메시지 ${ms.length}${nrep ? ' · 답변 ' + nrep : ''}` : '');
  return <Det k={'m:' + x.id} summary={head}>
    {ms.length ? <div class="mb-3 grid gap-2">{ms.map(m => <MsgFold key={m.messageId} m={m} />)}</div> : null}
    <Composer dkey={x.id} kind={x.kind} itemId={x.id} ariaLabel={`${msgName(x.kind)}: ${x.label}`}
      placeholder={x.kind === 'decision' ? '이 결정에 대한 답변을 적어 주세요' : '이 항목에 대한 후속 질문을 적어 주세요'} />
    <Muted cls="mt-2 text-xs">보내면 요청함에 접수됩니다. 담당 에이전트가 확인해 처리하고 답변을 남기며, 보내는 것만으로 결정 승인이나 작업 완료로 바뀌지 않습니다.</Muted>
  </Det>;
}
function MsgRow({ x }: { x: Item }) {
  const m: Msg = x.raw, t = msgTarget(m), n = (m.replies || []).length;
  return <Card x={x} title={t ? tgtName(t) : '연결 항목 없음'} lead={oneLine(m.text)} leadCls="line-clamp-1 break-all"
    head={<><MsgRef m={m} /><Badge>{msgName(m.kind)}</Badge>{m.link && m.kind === 'general' ? <Badge cls="badge-primary">분류됨</Badge> : null}<LinkRef t={t} />
      <StBadge m={m} />{n ? <Badge>답변 {n}</Badge> : null}<span class="text-xs text-base-content/60">{fmt(m.createdAt)}</span></>}>
    <Det k={'mx:' + m.messageId} summary={`원문${n ? ' · 답변 ' + n : ''}${m.processedAt ? ' · 처리 기록' : ''} 보기`}><ul class="grid"><MsgItem m={m} /></ul></Det>
  </Card>;
}
// 요청함 메시지 목록: 자유 메시지(분류 연결 전) / 항목 메시지(결정 답변·후속 질문·분류된 메시지) / 처리된 메시지(기본 접힘)
function MsgSections() {
  const { it, snap } = useApp(), xs = [...it.message].reverse();  // 최근 것이 위
  // 처리된 메시지 중 연결 항목 카드에서 원문·답변을 볼 수 있는 것은 처리된 메시지에서 뺀다(표시만 빼며 원문은 msg read·lookup으로 남는다).
  // 분류 연결된 자유 메시지는 기존대로 뺀다. 결정 답변·후속 질문은 연결(명시 link 우선, 없으면 원래 itemId) 항목이
  // 지금 카드로 보일 때만 뺀다(대기·완료 결정 포함). 숨김·merged·없는 대상이면 카드가 없으므로 여기 남긴다
  const shown = new Set([...MSG_KINDS.flatMap(k => it[k as Kind].map(x => x.id)), ...resolvedItems(snap).map(x => x.id)]);
  const filed = (m: Msg) => m.kind === 'general' ? !!m.link?.id && MSG_KINDS.includes(m.link.kind) : !!msgTarget(m) && shown.has(msgTarget(m)!.id);
  const recv = xs.filter(x => x.raw.status === 'received'), done = xs.filter(x => x.raw.status !== 'received' && !filed(x.raw));
  const free = recv.filter(x => !msgTarget(x.raw)), linked = recv.filter(x => msgTarget(x.raw));
  const sec = (title: string, note: string, arr: Item[], none: string) => <section class="grid gap-2">
    <div class="flex flex-wrap items-baseline gap-x-2"><h3 class="font-semibold">{title}</h3><Badge>{arr.length + '건'}</Badge></div><Muted cls="text-xs">{note}</Muted>
    {arr.length ? <><SelectRow label={title} xs={arr} /><ListBox>{arr.map(x => <MsgRow key={x.id} x={x} />)}</ListBox></> : <Empty>{none}</Empty>}
  </section>;
  return <>
    {sec('자유 메시지', '항목에 연결되지 않은 미처리 메시지입니다. 담당 에이전트가 작업·질문·결정으로 분류하면 해당 항목으로 옮겨지고, 맞는 항목이 없는 메시지만 여기 남습니다.', free, '미처리 자유 메시지가 없습니다.')}
    {sec('항목 메시지', '결정 답변, 후속 질문, 분류된 자유 메시지 중 미처리인 것입니다. 해당 항목 카드에서도 볼 수 있습니다.', linked, '미처리 항목 메시지가 없습니다.')}
    {done.length ? <Fold k="msgdone" cls={GROUP} head={<><GroupChk label="처리된 메시지" xs={done} /><span class="font-semibold">처리된 메시지</span><Badge>{done.length + '건'}</Badge></>}>
      <ListBox>{done.map(x => <MsgRow key={x.id} x={x} />)}</ListBox></Fold> : null}
    <Muted cls="text-xs">메시지는 삭제 요청으로 진행판에서 숨길 수 있습니다. 원문과 처리 기록은 지워지지 않고, 숨김은 승인이나 처리 완료를 뜻하지 않습니다.</Muted>
  </>;
}

// ---------- 지금 확인 요청(flush) ----------
// 서버가 등록된 Codex coordinator 세션에 고정 알림만 대기열로 넣는다. 사용자 글은 보내지 않으며, 적재는 처리 완료가 아니다.
// ponytail: 탭을 옮겨도 유지되게 모듈 상태로 둔다. 응답을 잃으면 같은 번호로 다시 보내 서버가 한 번만 실행하게 한다
const flushSt = { fid: null as string | null, busy: false, err: '' };
const FLUSH_ST: Record<string, [string, string]> = { sending: ['전송 중', 'badge-ghost'], queued: ['대기열 적재됨', 'badge-info'] };
function FlushCard() {
  const { snap, toast, reload } = useApp(), FL = snap.flush;
  const [, rerender] = useState(0), hid = useId(); useShared();
  const err = flushSt.err, setErr = (v: string) => { flushSt.err = v; ping(); };
  const reg = FL?.registration, recent = [...(FL?.recent || [])].reverse(), last = recent[0];
  const wait = last ? Math.ceil((FL!.cooldownSec || 60) - (Date.now() - new Date(last.createdAt).getTime()) / 1000) : 0;
  // 재요청 대기가 끝나면 버튼을 다시 켠다
  useEffect(() => { if (wait > 0) { const t = setTimeout(() => rerender(n => n + 1), wait * 1000); return () => clearTimeout(t); } }, [wait, last?.createdAt]);
  const open = reg && recent.find(f => (f.status === 'queued' || f.status === 'sending') && f.threadName === reg.threadName);
  const failed = reg && !open && wait > 0 && last.status === 'failed' ? last : null;  // ponytail: 재요청 대기 동안만 직전 실패를 보인다
  const click = async () => {
    if (flushSt.busy) return;
    flushSt.fid = flushSt.fid || newId(); flushSt.busy = true; setErr('');
    try {
      const body = await post('api/flush', { flushId: flushSt.fid }, 'flush').catch(e => {
        if (e.status === 429) flushSt.fid = null;  // 보내지 않았으므로 새 번호로 다시 시도한다
        throw e.status === 429 ? new Error(e.message || '잠시 후 다시 요청할 수 있습니다') : e;
      });
      flushSt.fid = null;
      const st = body.flush.status;
      toast(body.duplicate ? '처리 기록 전인 확인 요청이 이미 있습니다.' : st === 'queued' ? '확인 요청을 세션 대기열에 넣었습니다. 처리되면 진행 중 표시가 사라집니다.'
        : `전달하지 못했습니다: ${body.flush.error || st}`, st === 'queued' || body.duplicate ? 'ok' : 'err');
    } catch (e: any) {
      setErr(`보내지 못했습니다: ${e.message}.` + (flushSt.fid ? ' 다시 시도하면 같은 요청 번호라 중복 전송되지 않습니다.' : ''));
    }
    flushSt.busy = false; ping(); await reload(); ping();
  };
  return <section class="card card-border bg-base-100" aria-labelledby={hid}><div class="card-body gap-2 p-4 sm:p-5">
    <h3 id={hid} class="font-semibold">지금 확인 요청</h3>
    <Muted>담당 에이전트 세션에 "요청함을 지금 확인하라"는 고정 알림을 보냅니다. 쓴 글은 함께 보내지 않습니다. 요청함의 메시지와 삭제 요청은 에이전트가 운영 지침대로 처리하고 결과를 기록합니다. 대기열에 넣은 것만으로 처리된 것은 아닙니다.</Muted>
    <Muted cls="text-xs">{reg ? `대상: Codex 세션 "${reg.threadName}" · 등록 ${fmt(reg.registeredAt)}` : '미전달: 등록된 담당 에이전트 세션이 없어 보낼 수 없습니다. 에이전트가 세션을 등록하면 쓸 수 있습니다.'}</Muted>
    {reg ? <div class="flex flex-wrap items-center gap-1.5 text-xs text-base-content/60">
      {open ? <><Badge cls={FLUSH_ST[open.status][1]}>{'진행 중 · ' + FLUSH_ST[open.status][0]}</Badge>{`요청 ${fmt(open.createdAt)}`}</> : <Badge>진행 중인 요청 없음</Badge>}</div> : null}
    {open && open.status === 'queued' ? <Muted cls="text-xs">세션에 알림을 넣었습니다. 쉬고 있으면 바로, 작업 중이면 지금 작업이 끝난 뒤 확인합니다. 에이전트가 처리를 기록하면 진행 중 표시가 사라집니다.</Muted> : null}
    {failed ? <ErrAlert>{`전달하지 못했습니다: ${failed.error || '사유 미상'}`}</ErrAlert> : null}
    {flushSt.fid && !flushSt.busy ? <ErrAlert>직전 요청의 결과를 받지 못했습니다. 다시 시도하면 같은 요청 번호라 중복 전송되지 않습니다.</ErrAlert> : null}
    <div class="mt-1 flex flex-wrap items-center gap-2">
      <button class="btn btn-sm btn-primary" type="button" disabled={!reg || flushSt.busy || wait > 0 || !!open} onClick={click}>{flushSt.busy ? '보내는 중…' : flushSt.fid ? '다시 시도' : '지금 확인 요청'}</button>
      {open ? <Muted cls="text-xs">처리 기록 전인 요청이 있어 다시 보내지 않습니다.</Muted> : wait > 0 ? <Muted cls="text-xs">{`${wait}초 뒤 다시 요청할 수 있습니다.`}</Muted> : null}
    </div>
    <div aria-live="assertive">{err ? <ErrAlert>{err}</ErrAlert> : null}</div>
  </div></section>;
}

function GeneralCard() {
  const hid = useId();
  return <section class="card card-border bg-base-100" aria-labelledby={hid}><div class="card-body gap-2 p-4 sm:p-5">
    <h3 id={hid} class="font-semibold">새 메시지</h3>
    <Muted cls="text-sm">특정 항목을 고르지 않고 담당 에이전트에게 남기는 메시지입니다. 에이전트가 읽고 해당하는 작업·질문·결정으로 분류해 연결하며, 맞는 항목이 없으면 자유 메시지로 남습니다. 보내는 것만으로 무엇을 승인하거나 완료하지 않습니다.</Muted>
    <Composer dkey="_general" kind="general" itemId={null} ariaLabel="새 자유 메시지" placeholder="담당 에이전트에게 남길 내용을 적어 주세요" rows={4} />
  </div></section>;
}

// 어느 화면에서나 쓰는 우측 하단 진입점. 요청함의 새 메시지·지금 확인 요청과 같은 컴포넌트라 초안·전송 상태를 함께 쓴다.
// 화면을 막지 않는 패널이다. Escape나 닫기 버튼으로 닫으면 여는 버튼으로 포커스를 돌린다. lift는 아래 선택 바 높이만큼 올리는 값(px)이다
export function QuickPanel({ lift }: { lift: number }) {
  const [open, setOpen] = useState(false), btn = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), hid = useId();
  const close = () => { setOpen(false); btn.current?.focus(); };
  useLayoutEffect(() => { if (open) panel.current?.querySelector<HTMLElement>('textarea')?.focus(); }, [open]);
  const bottom = lift ? `calc(${lift}px + 1.5rem)` : '1rem';
  return <div class="fixed right-4 z-[25] flex flex-col items-end gap-2" style={{ bottom }}
    onKeyDown={e => { if (open && e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); close(); } }}>
    {open ? <div ref={panel} id={hid} role="dialog" aria-label="메시지 보내기" class="grid w-[min(26rem,calc(100vw-2rem))] gap-3 overflow-y-auto overscroll-contain rounded-box border border-base-300 bg-base-200 p-3 shadow-xl"
      style={{ maxHeight: `calc(100dvh - ${bottom} - 5.5rem)` }}>
      <div class="flex items-center justify-between gap-2 px-1"><h2 class="font-semibold">메시지 보내기</h2>
        <button class="btn btn-sm btn-square btn-ghost" type="button" aria-label="메시지 패널 닫기" onClick={close}>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="size-4" aria-hidden="true"><path stroke-linecap="round" d="M6 6l12 12M18 6 6 18" /></svg></button></div>
      <GeneralCard /><FlushCard />
    </div> : null}
    <button ref={btn} class="btn btn-circle btn-primary btn-lg shadow-lg" type="button" aria-label={open ? '메시지 패널 닫기' : '새 메시지·지금 확인 요청 열기'}
      aria-expanded={open} aria-controls={open ? hid : undefined} onClick={() => open ? close() : setOpen(true)}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="size-6" aria-hidden="true">
        {open ? <path stroke-linecap="round" d="M6 6l12 12M18 6 6 18" /> : <path stroke-linecap="round" stroke-linejoin="round" d="M4 5h16v11H9l-5 4V5Z" />}</svg>
    </button>
  </div>;
}

const REQ_LAB: Record<string, [string, string]> = { pending: ['대기', 'badge-warning'], done: ['처리 완료', 'badge-success'], failed: ['실패', 'badge-error'] };
export function Inbox() {
  const { snap } = useApp();
  const reqs = snap.requests.filter(r => r.status !== 'done').reverse();  // 처리 완료는 표시만 뺀다(서버 기록은 유지, 실패는 남겨 둔다)
  return <div class="grid gap-4"><FlushCard />
    <GeneralCard />
    <MsgSections />
    <h3 class="mt-4 font-semibold">삭제 요청 (진행판 숨김)</h3>
    <div role="note" class="alert alert-info alert-soft items-start text-sm"><p><b>서버는 요청을 보관만 합니다. </b>
      담당 에이전트(coordinator)가 세션 시작이나 작업 경계에서 요청함을 확인할 때 처리하며, 처리된 항목만 진행판에서 숨겨집니다. 비활성 세션에서는 즉시 처리되지 않습니다. 원본 작업·질문·PR 기록은 삭제되지 않고, 숨김은 결정이나 승인을 뜻하지 않습니다.</p></div>
    {reqs.length ? <ListBox>{reqs.map(r => <article key={r.requestId} class="list-row block px-4 py-4 sm:px-5">
      <div class="mb-1.5 flex flex-wrap gap-1.5"><Badge cls={(REQ_LAB[r.status] || [r.status, 'badge-ghost'])[1]}>{(REQ_LAB[r.status] || [r.status])[0]}</Badge><Badge>{`항목 ${r.items.length}개`}</Badge></div>
      <h3 class="font-semibold">진행판에서 숨김 요청</h3>
      <Muted>{`요청 ${fmt(r.createdAt)}` + (r.processedAt ? ` · 처리 ${fmt(r.processedAt)}` : ' · 에이전트 확인 대기')}</Muted>
      {r.error ? <ErrAlert cls="mt-2">{r.error}</ErrAlert> : null}
      <Det k={'r:' + r.requestId} summary="대상 항목"><ul class="list-disc pl-4">{r.items.map(i => <li>{`[${KIND[i.kind] || i.kind}] ${i.label}`}</li>)}</ul>
        <Muted cls="mt-2 break-all font-mono text-xs">{'requestId ' + r.requestId}</Muted></Det>
    </article>)}</ListBox> : <Empty>대기 중인 삭제 요청이 없습니다.</Empty>}
  </div>;
}
