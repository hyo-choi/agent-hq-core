import { describe, expect, it } from 'vitest';
import { alertGroups, detectNew, detectStatus } from './alerts';
import { items, itemGroup, matches } from './model';
import type { Snap } from './types';

const snap = (over: Partial<Snap['data']> = {}, messages: Snap['messages'] = []): Snap => ({
  data: { work: [{ id: 'w-1', title: 'A', status: '진행 중' }], questions: [], pendingDecisions: [], prs: {}, mergedPrs: {}, ...over },
  refs: {}, requests: [], messages, flush: null, prRefresh: {},
});
const msg = (id: string, o: Partial<Snap['messages'][number]> = {}) => ({ messageId: id, kind: 'general', itemId: null, label: null, text: 't', status: 'received', ...o });

describe('새 항목 알림', () => {
  it('처음은 기준선이고, 바뀐 게 없으면 같은 객체를 돌려준다', () => {
    const s0 = detectNew(null, snap());
    expect(s0).toEqual({ v: 1, seen: ['w-1'], list: [], fold: false });
    expect(detectNew(s0, snap())).toBe(s0);
  });
  it('새 id·메시지·답변만 알리고, 사라진 항목은 seen에 남는다', () => {
    const s0 = detectNew(null, snap());
    const s1 = detectNew(s0, snap({ work: [{ id: 'w-2', title: 'B', status: '진행' }] }, [msg('m1', { replies: [{ at: 'x', text: 'r' }] })]), 'T');
    expect(s1.list.map(a => a.key)).toEqual(['w-2', 'm:m1', 'r:m1:0:x']);
    expect(s1.seen).toContain('w-1');
    // 숨김으로 응답에서 빠진 메시지의 알림은 정리하지만 seen에는 남아 다시 알리지 않는다
    const s2 = detectNew(s1, snap({ work: [{ id: 'w-2', title: 'B', status: '진행' }] }));
    expect(s2.list.map(a => a.key)).toEqual(['w-2']);
    expect(s2.seen).toContain('m:m1');
  });
});

describe('상태 알림', () => {
  it('같은 항목의 연속 변경은 최초 from을 유지해 합친다', () => {
    const s0 = detectStatus(null, snap());
    const s1 = detectStatus(s0, snap({ work: [{ id: 'w-1', title: 'A', status: '리뷰' }] }), 'T1');
    const s2 = detectStatus(s1, snap({ work: [{ id: 'w-1', title: 'A', status: '완료' }] }), 'T2');
    expect(s2.list).toEqual([{ key: 'w-1', kind: 'work', id: 'w-1', title: 'A', from: '진행 중', to: '완료', n: 2, at: 'T2' }]);
  });
  it('조회 실패 PR은 마지막 기준을 유지하고 merged 이동은 상태 변화다', () => {
    const pr = (o: object) => ({ '7': { id: 'pr-7', number: 7, ok: true, state: 'OPEN', isDraft: true, ...o } });
    const s0 = detectStatus(null, snap({ prs: pr({}) }));
    const s1 = detectStatus(s0, snap({ prs: pr({ ok: false, state: undefined }) }));
    expect(s1).toBe(s0);
    const s2 = detectStatus(s1, snap({ prs: {}, mergedPrs: pr({ state: 'MERGED' }) }));
    expect(s2.list[0]).toMatchObject({ from: 'open · draft', to: 'merged' });
  });
});

describe('state 호환', () => {
  it('state가 있으면 우선 묶고, 없으면 status 문자열 규칙을 따른다', () => {
    expect(itemGroup({ status: 'PR 리뷰 대기' })).toBe('decide');  // legacy
    expect(itemGroup({ status: 'PR 리뷰 대기', state: 'open' })).toBe('active');
    expect(itemGroup({ status: '진행 중', state: 'waiting_user' })).toBe('decide');
    for (const st of ['done', 'closed', 'dropped'] as const) expect(itemGroup({ status: '진행 중', state: st })).toBe('done');
    expect(itemGroup({ status: '완료', state: 'blocked' })).toBe('active');
    const it0 = items(snap({ work: [{ id: 'w-1', title: 'A', status: '진행 중', state: 'closed' }] })).work[0];
    expect([it0.state, matches(it0, '', 'done', () => ''), matches(it0, '', 'active', () => '')]).toEqual(['closed', true, false]);
  });
  it('state만 바뀌어도 상태 알림이 뜨고, state 없는 항목의 기준은 그대로다', () => {
    const s0 = detectStatus(null, snap());
    expect(s0.base['w-1']).toBe('진행 중');  // legacy 기준 문구는 바뀌지 않는다(배포 뒤 거짓 알림 없음)
    const s1 = detectStatus(s0, snap({ work: [{ id: 'w-1', title: 'A', status: '진행 중', state: 'open' }] }), 'T1');
    expect(s1).toBe(s0);  // 기본값 open을 처음 채운 것은 상태 변화가 아니다
    const s2 = detectStatus(s1, snap({ work: [{ id: 'w-1', title: 'A', status: '진행 중', state: 'done' }] }), 'T2');
    expect(s2.list).toEqual([{ key: 'w-1', kind: 'work', id: 'w-1', title: 'A', from: '진행 중', to: '진행 중 · 완료', n: 1, at: 'T2' }]);
    expect(detectStatus(s2, snap({ work: [{ id: 'w-1', title: 'A', status: '진행 중', state: 'done' }] }))).toBe(s2);
  });
});

describe('대표 항목 묶음', () => {
  it('보이는 항목에 연결된 메시지·답변·상태 변경은 항목 카드 하나로, 자유 메시지는 따로', () => {
    const linked = msg('m1', { link: { id: 'w-1', kind: 'work', label: 'A' }, replies: [{ at: 'x', text: 'r' }] });
    const s = snap({}, [linked, msg('m2')]);
    const ns = { v: 1, seen: [], fold: false, list: [
      { key: 'w-1', at: '1', kind: 'work', id: 'w-1', title: 'A' },
      { key: 'm:m1', at: '2', kind: 'message', id: 'w-1', mkind: 'general', title: 't' },
      { key: 'm:m2', at: '3', kind: 'message', id: null, mkind: 'general', title: 't' },
      { key: 'r:m1:0:x', at: '4', kind: 'reply', id: 'w-1', mid: 'm1', title: 'r' }] };
    const ss = { v: 1, base: {}, fold: false, list: [{ key: 'w-1', kind: 'work', id: 'w-1', title: 'A', from: 'a', to: 'b', n: 1, at: '5' }] };
    const { groups, st } = alertGroups(s, ns, ss);
    expect(groups.map(g => [g.key, g.xs.map(a => a.key), !!g.st])).toEqual([['msg-m2', ['m:m2'], false], ['w-1', ['w-1', 'm:m1', 'r:m1:0:x'], true]]);
    expect(st).toEqual([]);
  });
  it('대상이 목록에 없으면(숨김·merged) 메시지 자체가 대표다', () => {
    const s = snap({ work: [] }, [msg('m1', { kind: 'work', itemId: 'w-9', label: 'X' })]);
    const ns = { v: 1, seen: [], fold: false, list: [{ key: 'm:m1', at: '1', kind: 'message', id: 'w-9', mkind: 'work', title: 'X' }] };
    expect(alertGroups(s, ns, null).groups[0].key).toBe('msg-m1');
  });
});
