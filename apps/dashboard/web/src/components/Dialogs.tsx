// 삭제 요청·JSON 내보내기 대화상자. 대화상자 하나는 열 때마다 새로 만들어져 requestId도 새로 생긴다
import { useRef, useState } from 'preact/hooks';
import { useApp } from '../ctx';
import { post } from '../lib/api';
import { KIND, newId } from '../lib/model';
import type { Item } from '../lib/types';
import { CloseBtn, DlgTitle, ErrAlert, Muted } from './ui';

export function AskDelete({ list }: { list: { kind: string; id: string; label: string }[] }) {
  const { closeDialog, editSel, toast, reload } = useApp();
  const [rid] = useState(newId);  // 같은 대화상자 안의 재시도는 같은 requestId를 써서 중복 저장되지 않는다
  const [busy, setBusy] = useState(false), [err, setErr] = useState(''), [retry, setRetry] = useState(false);
  const send = async () => {
    setBusy(true); setErr('');
    try {
      const body = await post('api/requests', { requestId: rid, action: 'hide_from_dashboard', items: list.map(({ kind, id }) => ({ kind, id })) }, 'request');
      closeDialog();
      editSel(m => { for (const x of list) m.delete(x.id); });
      toast(body.duplicate ? '이미 접수된 요청입니다. 요청함에서 상태를 확인하세요.' : '요청함에 저장했습니다. 에이전트가 처리하면 진행판에서 사라집니다.');
      await reload();
    } catch (e: any) {
      setErr(`저장하지 못했습니다: ${e.message}. 요청은 접수되지 않았을 수 있습니다. 다시 시도하면 같은 요청 번호로 보냅니다.`);
      setBusy(false); setRetry(true);
    }
  };
  return <>
    <DlgTitle>삭제 요청 {list.length}개</DlgTitle>
    <p class="text-sm">아래 항목을 진행판에서 숨겨 달라는 요청을 요청함에 남깁니다.</p>
    <ul class="my-3 max-h-56 list-disc overflow-auto rounded-box bg-base-200 py-3 pl-8 pr-3 text-sm">{list.map(x => <li>{`[${KIND[x.kind]}] ${x.label}`}</li>)}</ul>
    <Muted>바로 사라지지 않습니다. 담당 에이전트가 다음 확인 때 처리합니다. 원본 기록과 상태는 바꾸지 않으며, 숨김은 결정·승인이 아닙니다.</Muted>
    <div aria-live="assertive">{err ? <ErrAlert cls="mt-3">{err}</ErrAlert> : null}</div>
    <div class="modal-action"><CloseBtn t="취소" /><button class="btn btn-error" type="button" disabled={busy} onClick={send}>{busy ? '보내는 중…' : retry ? '다시 시도' : '요청함에 보내기'}</button></div>
  </>;
}

// 내보낸 JSON은 그대로 POST /api/requests 또는 `server.py submit` 본문이 된다(서버 요청 레코드와 같은 필드).
// ponytail: 16KB 본문 제한 때문에 원본 data는 넣지 않는다. 원본은 id로 data.json에서 찾는다.
export const exportJson = (xs: Item[], snapshotUpdatedAt?: string) => JSON.stringify({
  schemaVersion: 1, requestId: newId(), createdAt: new Date().toISOString(), action: 'hide_from_dashboard', hide_from_dashboard: true,
  intent: '진행판 표시에서만 숨김을 요청합니다. 원본 기록(tasks·docs·PR·질문 데이터)은 삭제하거나 상태를 바꾸지 않으며, 숨김은 결정이나 승인이 아닙니다.',
  source: 'Agent HQ 진행판', snapshotUpdatedAt,
  items: xs.map(x => ({ kind: x.kind, id: x.id, label: x.label.slice(0, 200), status: x.status })) }, null, 2);

export function ShowExport({ xs }: { xs: Item[] }) {
  const { snap, toast } = useApp(), ta = useRef<HTMLTextAreaElement>(null);
  const [json] = useState(() => exportJson(xs, snap.data.updatedAt));
  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(json);
      else { ta.current!.focus(); ta.current!.select(); if (!document.execCommand('copy')) throw new Error(); }
      toast('JSON을 클립보드에 복사했습니다.');
    } catch { ta.current!.focus(); ta.current!.select(); toast('자동 복사에 실패했습니다. 선택된 텍스트를 직접 복사해 주세요.', 'err'); }
  };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `hq-selection-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return <>
    <DlgTitle>선택 {xs.length}개 JSON</DlgTitle>
    <Muted cls="mb-3">{'선택 항목을 진행판에서 숨겨 달라는 삭제 요청서(action: hide_from_dashboard)입니다. 영속 id와 requestId를 담았으며, 원본 기록은 지우지 않습니다. 이 파일을 받은 에이전트는 `python3 server.py submit <파일>`로 요청함에 접수한 뒤 `process-inbox`로 처리합니다. 같은 requestId는 한 번만 접수됩니다.'}</Muted>
    <textarea ref={ta} readOnly id="exp" class="textarea h-64 w-full font-mono text-xs leading-relaxed" aria-label="내보낸 JSON" value={json} />
    <div class="modal-action flex-wrap"><CloseBtn /><button class="btn" type="button" onClick={download}>파일로 내려받기</button>
      <button class="btn btn-primary" type="button" onClick={copy}>복사</button></div>
  </>;
}
