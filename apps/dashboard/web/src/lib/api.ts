// 서버 API(server.py). 경로·본문은 기존 계약 그대로다. 상대 경로라 어떤 host·alias로 열어도 같은 origin으로 간다
import type { Snap } from './types';

export async function fetchSnap(): Promise<Snap> {
  const r = await fetch('api/dashboard', { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.status);
  return { data: body.data, refs: body.refs || {}, requests: body.requests || [], messages: body.messages || [], flush: body.flush || null, prRefresh: body.prRefresh || {} };
}

export class HttpError extends Error { constructor(msg: string, public status: number) { super(msg); } }
// 성공하면 응답 본문, 실패하면 서버 error 문구(없으면 HTTP 코드)로 HttpError
export async function post(path: 'api/requests' | 'api/messages' | 'api/flush', payload: unknown, field: string) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(payload) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body[field]) throw new HttpError(body.error || `HTTP ${r.status}`, r.status);
  return body;
}

// http(tailnet)에서는 Clipboard API가 막히므로 execCommand로 대신한다. 실제로 복사됐을 때만 true
export async function copyText(text: string) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch {}
  const prev = document.activeElement as HTMLElement | null, ta = document.createElement('textarea');
  ta.readOnly = true; ta.setAttribute('aria-hidden', 'true'); ta.style.cssText = 'position:fixed;top:0;left:-9999px';
  ta.value = text; document.body.append(ta); ta.focus(); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); prev?.focus?.({ preventScroll: true });
  return ok;
}
