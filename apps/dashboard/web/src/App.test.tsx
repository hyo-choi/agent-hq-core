// 화면 통합 검사(happy-dom). 서버 응답을 흉내 내 기존 화면과 같은 동작인지 핵심만 본다
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const base = () => ({
  data: {
    updatedAt: new Date().toISOString(), prsCheckedAt: new Date().toISOString(),
    work: [{ id: 'w-1', title: '작업 하나', status: '진행 중', conclusion: '결론' }],
    questions: [], prs: {}, mergedPrs: {},
    pendingDecisions: [{ id: 'd-1', title: '대기 결정', detail: '내용' }],
    resolvedDecisions: [{ id: 'd-0000dec1', title: '합성 결정 통합', detail: '거절', status: '거절', resolvedAt: '2026-01-19T17:00:00+09:00' }],
  },
  refs: { 'w-1': 'HQ-1', 'd-1': 'HQ-2', 'd-0000dec1': 'HQ-30' }, requests: [], messages: [], flush: null, prRefresh: {},
});
let snap: any, posts: any[], postFail: number;

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); location.hash = '';
  snap = base(); posts = []; postFail = 0;
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'api/dashboard') return new Response(JSON.stringify(snap), { status: 200 });
    const body = JSON.parse(String(init!.body)); posts.push([url, body]);
    if (postFail-- > 0) return new Response(JSON.stringify({ error: '실패' }), { status: 500 });
    const field = url === 'api/messages' ? 'message' : url === 'api/requests' ? 'request' : 'flush';
    return new Response(JSON.stringify({ [field]: body, duplicate: false }), { status: 201 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const refresh = () => act(async () => { document.dispatchEvent(new Event('visibilitychange')); await new Promise(r => setTimeout(r, 0)); });
const tabBtn = (name: string) => screen.getAllByRole('tab').find(b => b.textContent!.startsWith(name))!;

describe('App', () => {
  it('Jira Sprint 묶음 안에서 일반 티켓·서브태스크·유형 미확인을 나누고 부모 번호만 링크로 붙인다', async () => {
    const iss = (key: string, extra: object) => ({ key, summary: key + ' 제목', status: 'READY', priority: 'High', sprint: 1, sprintIds: [1], ...extra });
    snap.data.jira = { site: 'https://x.atlassian.net', project: 'DEMO', sprintField: 'customfield_10001', observedAt: new Date().toISOString(),
      sprints: { 1: { name: 'S1', state: 'active', startDate: '2026-01-01', endDate: '2026-01-30' } },
      issues: [iss('DEMO-1', { issueType: 'Story', isSubtask: false }), iss('DEMO-2', { issueType: '하위 작업', isSubtask: true, parentKey: 'DEMO-777' }),
        iss('DEMO-3', { status: 'IN PROGRESS' }), iss('DEMO-4', { issueType: '하위 작업', isSubtask: true })] };
    sessionStorage.setItem('tab', '"jira"');
    render(<App />);
    await screen.findByText('DEMO-1 제목');
    expect(tabBtn('Jira').textContent).toBe('Jira4');  // 범위 밖 부모(DEMO-777)는 건수에 넣지 않음
    const g = document.querySelector('[data-jgroup="1"]')!, kinds = () => [...g.querySelectorAll('[data-jkind]')].map(k => k.getAttribute('data-jkind'));
    const keysIn = (k: string) => [...g.querySelectorAll(`[data-jkind="${k}"] tr.jrow`)].map(r => r.querySelector('td')!.textContent!.replace('미리보기', ''));
    expect(kinds()).toEqual(['일반 티켓', '서브태스크', '유형 미확인']);
    expect([keysIn('일반 티켓'), keysIn('서브태스크'), keysIn('유형 미확인')]).toEqual([['DEMO-1'], ['DEMO-4', 'DEMO-2'], ['DEMO-3']]);
    expect(screen.getByLabelText('부모 DEMO-777 Jira에서 열기').getAttribute('href')).toBe('https://x.atlassian.net/browse/DEMO-777');
    expect(screen.getByText('부모 미확인').closest('tr')!.textContent).toContain('DEMO-4');
    expect(g.querySelector('[data-jkind="유형 미확인"]')!.textContent).not.toContain('부모');  // legacy는 서브태스크로 추측하지 않음
    expect(screen.getByText(/^4\/4건 표시/)).toBeTruthy();
    fireEvent.input(screen.getByPlaceholderText('티켓 키·제목 검색'), { target: { value: 'DEMO-777' } });  // 부모 번호로 서브태스크 검색
    await waitFor(() => expect(kinds()).toEqual(['서브태스크']));  // 빈 소그룹은 그리지 않음
    expect(screen.getByText(/^1\/4건 표시/)).toBeTruthy();
    fireEvent.input(screen.getByPlaceholderText('티켓 키·제목 검색'), { target: { value: '' } });
    fireEvent.input(document.getElementById('jst')!, { target: { value: 'IN PROGRESS' } });
    await waitFor(() => expect(kinds()).toEqual(['유형 미확인']));
    expect(screen.getByText(/^1\/4건 표시/)).toBeTruthy();
  });

  it('부모가 보드에 있으면 서브태스크를 부모 아래 트리로 두고, 필터 건수는 매칭 티켓만 센다', async () => {
    const iss = (key: string, extra: object) => ({ key, summary: key + ' 제목', status: 'READY', priority: 'High', sprint: 1, sprintIds: [1], ...extra });
    const sub = (key: string, parentKey: string, extra: object = {}) => iss(key, { issueType: '하위 작업', isSubtask: true, parentKey, ...extra });
    snap.data.jira = { site: 'https://x.atlassian.net', project: 'DEMO', sprintField: 'customfield_10001', observedAt: new Date().toISOString(),
      sprints: { 1: { name: 'S1', state: 'active', startDate: '2026-01-01', endDate: '2026-01-30' }, 2: { name: 'S2', state: 'future', startDate: '2026-11-01', endDate: '2026-11-30' } },
      issues: [iss('DEMO-10', { issueType: 'Story', isSubtask: false }), sub('DEMO-11', 'DEMO-10', { status: 'TO-DO' }),
        sub('DEMO-12', 'DEMO-10', { sprint: 2, sprintIds: [2] }),  // cross-Sprint 자식: 부모(S1) 묶음에 들어가고 소속 배지
        sub('DEMO-13', 'DEMO-999'),  // 범위 밖 부모: 기존 서브태스크 소그룹
        iss('DEMO-20', { issueType: 'Story', isSubtask: false, sprint: 2, sprintIds: [2] })] };
    sessionStorage.setItem('tab', '"jira"');
    render(<App />);
    await screen.findByText('DEMO-10 제목');
    const rows = (sel = '') => [...document.querySelectorAll(`${sel} tr.jrow`)].map(r => r.querySelector('td')!.textContent!.replace('미리보기', '').replace('└', ''));
    const g1 = '[data-jgroup="1"]', g2 = '[data-jgroup="2"]';
    expect(rows(`${g1} [data-jkind="일반 티켓"]`)).toEqual(['DEMO-10', 'DEMO-11', 'DEMO-12']);
    expect(rows(`${g1} [data-jkind="서브태스크"]`)).toEqual(['DEMO-13']);
    expect(rows(g2)).toEqual(['DEMO-20']);  // DEMO-12는 S2에 중복 렌더하지 않음
    expect(document.querySelector(`${g1} [data-jkind="일반 티켓"] p`)!.textContent).toBe('일반 티켓 1건 · 하위 서브태스크 2건');
    expect(document.querySelector(g1)!.textContent).toContain('4건');
    expect([...document.querySelectorAll('tr[data-jparent="DEMO-10"]')].find(r => r.textContent!.includes('DEMO-12 제목'))!.textContent).toContain('소속 S2');
    expect([...document.querySelectorAll('tr[data-jparent="DEMO-10"]')].find(r => r.textContent!.includes('DEMO-11 제목'))!.textContent).not.toContain('소속');
    expect(screen.getAllByLabelText('부모 DEMO-10 Jira에서 열기')[0].getAttribute('href')).toBe('https://x.atlassian.net/browse/DEMO-10');
    expect(rows().length).toBe(5);
    expect(screen.getByText(/^5\/5건 표시/)).toBeTruthy();
    // 자식만 매칭: 부모는 관계 표시로 보이고 건수에서 빠짐
    fireEvent.input(document.getElementById('jst')!, { target: { value: 'TO-DO' } });
    await waitFor(() => expect(rows()).toEqual(['DEMO-10', 'DEMO-11']));
    const ctx = document.querySelector('tr[data-jctx]')!;
    expect(ctx.textContent).toContain('DEMO-10 제목'); expect(ctx.textContent).toContain('관계 표시');
    expect(document.querySelectorAll('tr[data-jctx]').length).toBe(1);
    expect(document.querySelector(`${g1} [data-jkind="일반 티켓"] p`)!.textContent).toBe('일반 티켓 0건 · 하위 서브태스크 1건');
    expect(screen.getByText(/^1\/5건 표시/)).toBeTruthy();
    fireEvent.input(document.getElementById('jst')!, { target: { value: '' } });
    // 부모만 매칭: 자식을 결과에 자동 포함하지 않음
    fireEvent.input(screen.getByPlaceholderText('티켓 키·제목 검색'), { target: { value: 'DEMO-10 제목' } });
    await waitFor(() => expect(rows()).toEqual(['DEMO-10']));
    expect(document.querySelector('tr[data-jctx]')).toBeNull();
    expect(screen.getByText(/^1\/5건 표시/)).toBeTruthy();
    // cross-Sprint 자식만 매칭: 부모 S1 묶음에 관계 표시 부모와 함께, S2 묶음에는 DEMO-12 없음
    fireEvent.input(screen.getByPlaceholderText('티켓 키·제목 검색'), { target: { value: 'DEMO-12' } });
    await waitFor(() => expect(rows()).toEqual(['DEMO-10', 'DEMO-12']));
    expect(document.querySelector(g2)).toBeNull();
    expect(document.querySelector(g1)!.textContent).toContain('1건');
    expect(screen.getByText(/^1\/5건 표시 · Sprint 묶음 1개/)).toBeTruthy();
    // 부모 key 검색: 자식 둘이 매칭, 부모 본인도 key로 매칭 → 3건, 중복 없음
    fireEvent.input(screen.getByPlaceholderText('티켓 키·제목 검색'), { target: { value: 'DEMO-10' } });
    await waitFor(() => expect(rows()).toEqual(['DEMO-10', 'DEMO-11', 'DEMO-12']));
    expect(screen.getByText(/^3\/5건 표시/)).toBeTruthy();
  });

  it('메뉴 수량·결정 안내·HQ 번호를 기존처럼 보인다', async () => {
    render(<App />);
    await screen.findAllByText('Agent HQ');
    expect(tabBtn('결정').textContent).toBe('결정1');
    await waitFor(() => expect(document.title).toBe('(1) Agent HQ 진행판'));
    fireEvent.click(tabBtn('작업'));
    expect(await screen.findByText('HQ-1')).toBeTruthy();
    expect(sessionStorage.getItem('tab')).toBe('"work"');
  });

  it('긴 본문은 Markdown으로, 제목·요약·입력은 plain으로 그리고 raw HTML·위험 링크는 실행하지 않는다', async () => {
    snap.data.work[0].conclusion = '## 결론\n**완료** <img src=x onerror=alert(1)> [x](javascript:alert(1))\n\n| A | B |\n| - | - |\n| 1 | 2 |';
    snap.data.work[0].verification = '첫 줄\n둘째 줄';  // 기존 plain 기록
    snap.data.pendingDecisions[0].detail = '- 선택지 **A**\n- 선택지 B';
    snap.messages = [{ messageId: 'a', kind: 'work', itemId: 'w-1', label: '작업 하나', text: '`코드` 질문', status: 'processed',
      replies: [{ at: '2026-01-19T17:00:00+09:00', text: '답변 [PR](https://github.com/example/repo/pull/1)' }] }];
    sessionStorage.setItem('open', '["d:w-1","m:w-1","mx:a","d:d-1"]');
    location.hash = '#work';
    render(<App />);
    const card = (await screen.findByText('작업 하나', { selector: 'h3' })).closest('article')!;
    expect(card.querySelector('h3 + p')!.innerHTML).toBe('결론 완료 &lt;img src=x onerror=alert(1)&gt; [x](javascript:alert(1)) A B 1 2');  // 카드 요약은 기호를 뺀 plain
    const dd = (k: string) => [...card.querySelectorAll('dt')].find(d => d.textContent === k)!.nextElementSibling!;
    expect(dd('결론').querySelector('.md h2')!.textContent).toBe('결론');
    expect(dd('결론').querySelector('table td')!.textContent).toBe('1');
    expect(card.querySelector('img, [onerror], a[href^="javascript"]')).toBeNull();
    expect(dd('검증').querySelectorAll('p br').length).toBe(1);
    expect(card.querySelector('.md code')!.textContent).toBe('코드');
    expect(card.querySelector('.md a[href="https://github.com/example/repo/pull/1"]')!.getAttribute('target')).toBe('_blank');
    expect(document.querySelector('p p, p div, p ul, p table, p pre')).toBeNull();
    expect([...card.querySelectorAll('dt')].map(d => d.textContent)).not.toContain('남은 일');  // 빈 필드 행은 그대로 생략
    expect(card.querySelector('textarea')).toBeTruthy();
    fireEvent.click(tabBtn('결정'));
    const dcard = (await screen.findByText('대기 결정', { selector: 'h3' })).closest('article')!;
    expect([...dcard.querySelectorAll('.md li strong')].map(x => x.textContent)).toEqual(['A']);
    expect([...dcard.querySelectorAll('dt')].map(d => d.textContent)).toEqual(['내용']);
  });

  it('갱신해도 입력 중 글·커서·펼침이 유지되고, 실패한 전송은 같은 messageId로 재시도한다', async () => {
    sessionStorage.setItem('tab', '"work"');
    sessionStorage.setItem('open', '["m:w-1"]');
    render(<App />);
    const ta = await screen.findByLabelText('후속 질문: 작업 하나') as HTMLTextAreaElement;
    ta.focus(); ta.value = '한글 입력 중'; fireEvent.input(ta); ta.setSelectionRange(2, 2);
    snap = { ...base(), data: { ...base().data, work: [{ id: 'w-1', title: '작업 하나', status: '리뷰 중' }, { id: 'w-2', title: '새 작업', status: '진행' }] } };
    await refresh();
    await screen.findAllByText('새 작업');
    expect(ta.isConnected && document.activeElement).toBe(ta);
    expect([ta.value, ta.selectionStart]).toEqual(['한글 입력 중', 2]);
    expect(JSON.parse(localStorage.getItem('agent-hq-dashboard:drafts')!)['w-1'].text).toBe('한글 입력 중');
    postFail = 1;
    fireEvent.click(screen.getAllByText('보내기')[0]);
    await screen.findByText(/보내지 못했습니다/);
    expect(ta.value).toBe('한글 입력 중');
    fireEvent.click(screen.getByText('다시 보내기'));
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts[0][1].messageId).toBe(posts[1][1].messageId);
    expect(posts[1][1]).toMatchObject({ kind: 'work', itemId: 'w-1', text: '한글 입력 중' });
    await waitFor(() => expect(ta.value).toBe(''));
    expect(localStorage.getItem('agent-hq-dashboard:drafts')).toBe('{}');
  });

  it('선택·삭제 요청은 대화상자 안 재시도에 같은 requestId를 쓰고, 성공하면 선택을 지운다', async () => {
    sessionStorage.setItem('tab', '"work"');
    sessionStorage.setItem('sel', '[["w-1","work"]]');  // 기존 형식 그대로 복원
    render(<App />);
    expect(await screen.findByText('1개 선택됨')).toBeTruthy();
    fireEvent.click(screen.getAllByText('삭제 요청').find(b => b.closest('[role=region]'))!);
    postFail = 1;
    fireEvent.click(await screen.findByText('요청함에 보내기'));
    fireEvent.click(await screen.findByText('다시 시도'));
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts[0][1].requestId).toBe(posts[1][1].requestId);
    expect(posts[1][1]).toMatchObject({ action: 'hide_from_dashboard', items: [{ kind: 'work', id: 'w-1' }] });
    await waitFor(() => expect(sessionStorage.getItem('sel')).toBe('[]'));
  });

  it('결정 완료 항목은 원본 id·HQ 번호를 유지하고 선택·삭제 요청은 되지만 답장은 없다', async () => {
    location.hash = '#decision';
    const before = JSON.stringify(snap.data.resolvedDecisions);
    render(<App />);
    const row = (await screen.findByText('합성 결정 통합')).closest('[data-item]')!;
    expect(row.getAttribute('data-item')).toBe('d-0000dec1');
    expect(row.textContent).toContain('HQ-30');
    expect(row.textContent).toContain('거절');
    expect(row.textContent).not.toContain('답장 쓰기');
    fireEvent.click(screen.getByLabelText('선택: 합성 결정 통합'));
    expect(await screen.findByText('1개 선택됨')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('삭제 요청: 합성 결정 통합'));
    fireEvent.click(await screen.findByText('요청함에 보내기'));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toEqual(['api/requests', { requestId: expect.stringMatching(/^[0-9a-f]{32}$/), action: 'hide_from_dashboard', items: [{ kind: 'decision', id: 'd-0000dec1' }] }]);
    expect(JSON.stringify(snap.data.resolvedDecisions)).toBe(before);  // 원본 결정·상태는 클라이언트가 바꾸지 않는다
    // 대기 결정은 그대로 답장·삭제 요청 대상이다
    expect((await screen.findByText('대기 결정')).closest('[data-item]')!.textContent).toContain('답장 쓰기');
  });

  it('결정 완료 묶음 전체 선택은 결정 완료 항목만, 삭제 요청 대기·id 없는 항목을 빼고 고른다', async () => {
    const r = (id: string, title: string) => ({ id, title, detail: '내용', status: '승인', resolvedAt: '2026-01-19T17:00:00+09:00' });
    snap.data.resolvedDecisions = [r('d-r1', '완료 A'), r('d-r2', '완료 B'), r('d-r3', '완료 C'), { title: 'legacy 결정', status: '승인' }];
    snap.requests = [{ requestId: 'p', status: 'pending', items: [{ kind: 'decision', id: 'd-r3', label: '완료 C' }] }];
    location.hash = '#decision';
    render(<App />);
    await screen.findByText('완료 A');
    expect(screen.getByText('legacy 결정').closest('[data-item]')!.textContent).toContain('id 없음 · 선택 불가');
    const all = screen.getByLabelText('결정 완료 전체 선택 (2개)') as HTMLInputElement;
    fireEvent.click(all);
    expect(await screen.findByText('2개 선택됨')).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem('sel')!)).toEqual([['d-r1', 'decision'], ['d-r2', 'decision']]);  // 대기 결정 d-1은 건드리지 않음
    await refresh();  // 자동 갱신(load)이 결정 완료 선택을 지우지 않는다
    expect(screen.getByText('2개 선택됨')).toBeTruthy();
    expect(all.closest('label')!.textContent).toBe('전체 선택');  // 보이는 문구
    fireEvent.click(all);
    await waitFor(() => expect(sessionStorage.getItem('sel')).toBe('[]'));
  });

  it('새로 열 때 저장된 결정 완료 선택을 유지하고, 숨김 처리된 결정 완료 선택만 지운다', async () => {
    sessionStorage.setItem('sel', '[["d-0000dec1","decision"],["w-1","work"]]'); location.hash = '#decision';
    render(<App />);
    expect(await screen.findByText('2개 선택됨')).toBeTruthy();
    snap.requests = [{ requestId: 'h', status: 'done', items: [{ kind: 'decision', id: 'd-0000dec1', label: '합성 결정 통합' }] }];
    await refresh();
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('sel')!)).toEqual([['w-1', 'work']]));
  });

  it('완료한 작업 묶음 전체 선택: 부분 선택은 indeterminate, 필터 범위·삭제 요청 대기·진행 작업 선택을 지킨다', async () => {
    snap.data.work = [{ id: 'w-1', title: '진행 작업', status: '진행 중' },
      { id: 'w-a', title: '완료 알파', status: '완료' }, { id: 'w-b', title: '완료 베타', status: '완료' }, { id: 'w-c', title: '완료 대기', status: '완료' }];
    snap.requests = [{ requestId: 'p', status: 'pending', items: [{ kind: 'work', id: 'w-c', label: '완료 대기' }] }];
    sessionStorage.setItem('tab', '"work"'); sessionStorage.setItem('sel', '[["w-1","work"]]');
    render(<App />);
    await screen.findByText('진행 작업');
    const all = () => screen.getByLabelText('완료한 작업 전체 선택 (2개)') as HTMLInputElement;
    expect(document.querySelector('details[open] [data-item="w-a"]')).toBeNull();  // 접힌 묶음 머리에서도 누를 수 있다
    expect(all().closest('label')!.textContent).toBe('전체 선택');  // 접힌 머리에도 보이는 문구
    fireEvent.click(screen.getByLabelText('선택: 완료 알파'));
    await waitFor(() => expect(all().indeterminate).toBe(true));
    fireEvent.click(all());
    await waitFor(() => expect([all().checked, all().indeterminate]).toEqual([true, false]));
    expect(new Map(JSON.parse(sessionStorage.getItem('sel')!))).toEqual(new Map([['w-1', 'work'], ['w-a', 'work'], ['w-b', 'work']]));
    fireEvent.click(all());
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('sel')!)).toEqual([['w-1', 'work']]));  // 진행 작업 선택은 유지
    fireEvent.input(screen.getByPlaceholderText(/검색/), { target: { value: '알파' } });  // 검색 범위만 고른다
    fireEvent.click(await screen.findByLabelText('완료한 작업 전체 선택 (1개)'));
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('sel')!)).toEqual([['w-1', 'work'], ['w-a', 'work']]));
  });

  it('새 항목 알림은 첫 응답을 기준선으로 두고, 확인은 이 브라우저 알림만 지운다', async () => {
    render(<App />);
    await screen.findAllByText('Agent HQ');
    expect(JSON.parse(localStorage.getItem('agent-hq-dashboard:alerts')!).list).toEqual([]);
    snap = { ...base(), data: { ...base().data, work: [...base().data.work, { id: 'w-3', title: '알림 대상', status: '진행' }] }, refs: { ...base().refs, 'w-3': 'HQ-3' } };
    await refresh();
    const ack = (await screen.findAllByLabelText('확인: 알림 대상'))[0];
    fireEvent.click(ack);
    await waitFor(() => expect(JSON.parse(localStorage.getItem('agent-hq-dashboard:alerts')!).list).toEqual([]));
    expect(JSON.parse(localStorage.getItem('agent-hq-dashboard:alerts')!).seen).toContain('w-3');
  });

  it('묶음 확인은 그릴 때 보인 키만 지우고, 그 뒤 도착한 알림은 남긴다', async () => {
    render(<App />);
    await screen.findAllByText('Agent HQ');
    const K = 'agent-hq-dashboard:alerts', st = JSON.parse(localStorage.getItem(K)!);
    localStorage.setItem(K, JSON.stringify({ ...st, list: [{ key: 'w-1', at: '1', kind: 'work', id: 'w-1', title: '작업 하나' }] }));
    await refresh();
    const ack = (await screen.findAllByLabelText('확인: 작업 하나'))[0];
    // 렌더 뒤 같은 대표 항목의 새 알림이 저장소에 도착했지만 아직 그려지지 않았다
    const now = JSON.parse(localStorage.getItem(K)!);
    localStorage.setItem(K, JSON.stringify({ ...now, list: [...now.list, { key: 'm:late', at: '2', kind: 'message', id: 'w-1', mkind: 'work', title: 'late' }] }));
    fireEvent.click(ack);
    expect(JSON.parse(localStorage.getItem(K)!).list.map((a: any) => a.key)).toEqual(['m:late']);
  });

  it('입력 중 카드가 완료 묶음으로 옮겨질 상태가 와도 같은 입력칸·포커스를 유지하고, 벗어나면 옮겨진다', async () => {
    sessionStorage.setItem('tab', '"work"'); sessionStorage.setItem('open', '["m:w-1"]');
    render(<App />);
    const ta = await screen.findByLabelText('후속 질문: 작업 하나') as HTMLTextAreaElement;
    await act(async () => { ta.focus(); });
    ta.value = '입력 중'; fireEvent.input(ta);
    snap = { ...base(), data: { ...base().data, work: [{ id: 'w-1', title: '작업 하나', status: '완료' }] } };
    await refresh();
    expect(screen.getByLabelText('후속 질문: 작업 하나')).toBe(ta);
    expect([ta.isConnected, document.activeElement === ta, ta.value]).toEqual([true, true, '입력 중']);
    expect(ta.closest('details.collapse')).toBeNull();  // 아직 진행 목록 자리에 있다
    expect(ta.closest('[data-item]')!.textContent).toContain('완료');  // 내용(상태)은 최신이다
    await act(async () => { ta.blur(); });
    const moved = screen.getByLabelText('후속 질문: 작업 하나') as HTMLTextAreaElement;
    expect(moved.closest('details.collapse')).not.toBeNull();  // 벗어나면 완료 묶음으로
    expect(moved.value).toBe('입력 중');  // 초안은 유지된다
  });

  it('같은 thread 질문이 1→2건이 되어도 입력 중 질문 카드는 다시 만들어지지 않는다', async () => {
    const q1 = { id: 'q-1', q: '첫 질문', status: '조사 중', category: '기타', thread: 'T' };
    snap = { ...base(), data: { ...base().data, questions: [q1] } };
    sessionStorage.setItem('tab', '"question"'); sessionStorage.setItem('open', '["c:기타","m:q-1"]');
    render(<App />);
    const ta = await screen.findByLabelText('후속 질문: 첫 질문') as HTMLTextAreaElement;
    await act(async () => { ta.focus(); });
    snap = { ...base(), data: { ...base().data, questions: [q1, { id: 'q-2', q: '둘째 질문', status: '조사 중', category: '기타', thread: 'T' }] } };
    await refresh();
    expect([screen.getByLabelText('후속 질문: 첫 질문') === ta, document.activeElement === ta]).toEqual([true, true]);
    await act(async () => { ta.blur(); });
    expect(await screen.findByText('이어지는 질문 2건')).toBeTruthy();
  });

  it('숨김 처리된(done 요청) 결정 완료 항목은 다시 보이지 않는다', async () => {
    snap = { ...base(), requests: [{ requestId: 'r', status: 'done', items: [{ kind: 'decision', id: 'd-0000dec1', label: 'x' }] }] };
    location.hash = '#decision';
    render(<App />);
    await screen.findByText('대기 결정');
    expect(screen.queryByText('합성 결정 통합')).toBeNull();
  });

  it('처리된 메시지는 연결 항목 카드에서 볼 수 있는 결정 답변·후속 질문을 빼고, 미처리·미분류·카드 없는 대상은 남긴다', async () => {
    const m = (id: string, o: any) => ({ messageId: id, kind: 'decision', itemId: null, label: null, text: '본문 ' + id, status: 'processed', ...o });
    snap = { ...base(),
      data: { ...base().data, mergedPrs: { 7: { id: 'pr-7', number: 7, state: 'MERGED', ok: true } } },
      messages: [
        m('a', { itemId: 'd-0000dec1', label: '합성 결정 통합', text: '안하려고', replies: [{ at: '2026-01-19T17:00:00+09:00', text: '거절로 정리' }] }),  // 완료 결정 → 뺌
        m('b', { itemId: 'd-1', label: '대기 결정' }),  // 대기 결정 → 뺌
        m('c', { kind: 'work', itemId: 'w-1', label: '작업 하나' }),  // 후속 질문 → 뺌
        m('d', { itemId: 'd-gone', label: '없는 결정' }),  // 대상 없음 → 남김
        m('e', { kind: 'pr', itemId: 'pr-7', label: '#7' }),  // merged PR → 남김
        m('f', { itemId: 'd-hidden', label: '숨긴 결정' }),  // 숨긴 대상 → 남김
        m('g', { itemId: 'd-gone', label: '없는 결정', link: { id: 'w-1', kind: 'work', label: '작업 하나' } }),  // 명시 link 우선 → 뺌
        m('h', { itemId: 'd-1', label: '대기 결정', link: { id: 'w-gone', kind: 'work', label: '없는 작업' } }),  // link 대상 없음 → 남김
        m('i', { itemId: 'd-1', label: '대기 결정', status: 'received' }),  // 미처리 → 항목 메시지
        m('j', { kind: 'general', status: 'processed' }),  // 미분류 처리 자유 메시지 → 남김
        m('k', { kind: 'general', status: 'processed', link: { id: 'd-gone', kind: 'decision', label: 'x' } }),  // 분류된 자유 메시지 → 기존대로 뺌
      ],
      requests: [{ requestId: 'r', status: 'done', items: [{ kind: 'decision', id: 'd-hidden', label: 'x' }] }],
    };
    snap.data.pendingDecisions = [...snap.data.pendingDecisions];  // 서버가 숨김 overlay를 적용해 d-hidden은 응답에 없다
    location.hash = '#inbox'; sessionStorage.setItem('open', '["msgdone"]');
    render(<App />);
    const fold = (await screen.findByText('처리된 메시지', { selector: 'span' })).closest('details')!;
    const ids = [...fold.querySelectorAll('[data-item^="msg-"]')].map(e => e.getAttribute('data-item'));
    expect(ids.sort()).toEqual(['msg-d', 'msg-e', 'msg-f', 'msg-h', 'msg-j']);
    expect(document.querySelector('[data-item="msg-i"]')).not.toBeNull();  // 미처리는 항목 메시지에 그대로
    // 완료 결정 카드에서 원문·답변을 읽기 전용으로 본다(입력칸 없음)
    fireEvent.click(tabBtn('결정'));
    const row = (await screen.findByText('합성 결정 통합')).closest('[data-item="d-0000dec1"]')!;
    expect(row.textContent).toContain('받은 메시지 1 · 답변 1');
    expect(row.textContent).toContain('안하려고');
    expect(row.textContent).toContain('거절로 정리');
    expect(row.querySelector('textarea')).toBeNull();
    expect(row.textContent).not.toContain('답장 쓰기');
  });

  // P3-2: 요청함 항목 메시지의 연결 HQ 번호가 결정 완료 카드를 가리키면 결정 탭의 결정 완료 묶음을 열고 그 카드로 간다.
  // 검색·상태 필터에 걸러져 있어도 기존 reveal 규칙(HQ 번호 정확 검색)으로 보이게 한다. 숨긴 결정은 없는 대상 안내를 유지한다
  for (const [name, f] of [['필터 없음', null], ['검색·상태 필터 중', ['없는 검색어', 'active']]] as const) {
    it(`연결 HQ 번호로 결정 완료 카드로 이동한다: ${name}`, async () => {
      snap = { ...base(), messages: [{ messageId: 'r1', kind: 'decision', itemId: 'd-1', label: '대기 결정', text: '답', status: 'received',
        link: { id: 'd-0000dec1', kind: 'decision', label: '합성 결정 통합' } }] };  // 명시 link가 원래 itemId보다 우선
      if (f) { sessionStorage.setItem('f:q', JSON.stringify(f[0])); sessionStorage.setItem('f:fstatus', JSON.stringify(f[1])); }
      location.hash = '#inbox';
      render(<App />);
      fireEvent.click(await screen.findByLabelText('HQ-30로 이동: 연결 항목 합성 결정 통합'));
      await waitFor(() => expect(document.querySelector('#list [data-item="d-0000dec1"]')?.classList.contains('ring-2')).toBe(true));
      const row = document.querySelector('#list [data-item="d-0000dec1"]')!;
      expect(sessionStorage.getItem('tab')).toBe('"decision"');
      expect((row.closest('details') as HTMLDetailsElement).open).toBe(true);
      expect(row.closest('details')!.textContent).toContain('결정 완료');
      expect(screen.queryByText(/진행판 목록에 없습니다/)).toBeNull();
    });
  }
  it('숨긴 결정 완료 대상의 연결 HQ 번호는 숨김 안내를 유지한다', async () => {
    snap = { ...base(), messages: [{ messageId: 'r2', kind: 'decision', itemId: 'd-0000dec1', label: '합성 결정 통합', text: '답', status: 'received' }],
      requests: [{ requestId: 'r', status: 'done', items: [{ kind: 'decision', id: 'd-0000dec1', label: 'x' }] }] };
    location.hash = '#inbox';
    render(<App />);
    fireEvent.click(await screen.findByLabelText('HQ-30로 이동: 연결 항목 합성 결정 통합'));
    expect(await screen.findByText(/삭제 요청으로 진행판에서 숨긴 항목/)).toBeTruthy();
  });

  // 보내기 누름 순서: pointerdown → textarea blur(포커스가 버튼으로 가거나, Safari처럼 아무 데도 안 감) → 다시 그리기 → pointerup → click
  for (const [name, toButton] of [['버튼으로 포커스 이동', true], ['포커스 없음(relatedTarget null)', false]] as const) {
    it(`입력 중 완료로 바뀐 카드에서 보내기를 눌러도 click이 유실되지 않는다: ${name}`, async () => {
      sessionStorage.setItem('tab', '"work"'); sessionStorage.setItem('open', '["m:w-1"]');
      render(<App />);
      const ta = await screen.findByLabelText('후속 질문: 작업 하나') as HTMLTextAreaElement;
      await act(async () => { ta.focus(); });
      ta.value = '보낼 글'; fireEvent.input(ta);
      snap = { ...base(), data: { ...base().data, work: [{ id: 'w-1', title: '작업 하나', status: '완료' }] } };
      await refresh();
      const btn = screen.getAllByText('보내기').find(b => b.closest('[data-item="w-1"]'))!;
      await act(async () => {
        fireEvent.pointerDown(btn);
        if (toButton) btn.focus(); else { ta.blur(); fireEvent.focusOut(ta, { relatedTarget: null }); }
        await new Promise(r => setTimeout(r, 0));  // blur 뒤 다시 그리기가 끝날 때까지
      });
      expect(btn.isConnected).toBe(true);
      expect(btn.closest('details.collapse')).toBeNull();  // 아직 진행 목록 자리
      await act(async () => { fireEvent.pointerUp(btn); fireEvent.click(btn); await new Promise(r => setTimeout(r, 10)); });
      await waitFor(() => expect(posts.length).toBe(1));
      expect(posts[0][1]).toMatchObject({ kind: 'work', itemId: 'w-1', text: '보낼 글' });
      // 전송이 끝나면(글이 비워져 보내기 버튼이 disabled) 고정을 풀어 최신 배치(완료 묶음)로 옮겨진다
      await waitFor(() => expect(screen.getByLabelText('후속 질문: 작업 하나').closest('details.collapse')).not.toBeNull());
    });
  }
  // 우측 하단 진입점: 요청함과 같은 초안·전송 상태를 쓴다
  const fab = () => document.querySelector('button.btn-circle[aria-expanded]') as HTMLButtonElement;  // Alerts 접기 버튼도 aria-expanded라 원형 버튼으로 좁힌다
  const panelTa = () => document.querySelector('[role=dialog][aria-label="메시지 보내기"] textarea') as HTMLTextAreaElement;
  const inboxTa = () => [...document.querySelectorAll('#list textarea[aria-label="새 자유 메시지"]')][0] as HTMLTextAreaElement;

  it('플로팅 패널은 어느 탭에서나 열리고 Escape로 닫으면 버튼으로 포커스를 돌린다', async () => {
    sessionStorage.setItem('tab', '"jira"');
    render(<App />);
    await screen.findAllByText('Agent HQ');
    expect(fab().getAttribute('aria-expanded')).toBe('false');
    await act(async () => { fireEvent.click(fab()); });
    expect(fab().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(panelTa());
    await act(async () => { fireEvent.keyDown(panelTa(), { key: 'Escape' }); });
    expect(panelTa()).toBeNull();
    expect(document.activeElement).toBe(fab());
    expect(fab().getAttribute('aria-label')).toBe('새 메시지·지금 확인 요청 열기');
  });

  it('패널과 요청함의 새 메시지는 초안·실패·재시도를 공유해 같은 messageId로 한 번만 접수된다', async () => {
    sessionStorage.setItem('tab', '"work"');
    render(<App />);
    await screen.findAllByText('Agent HQ');
    await act(async () => { fireEvent.click(fab()); });
    const p = panelTa(); p.value = '어디서나 쓰는 글'; fireEvent.input(p);
    expect(JSON.parse(localStorage.getItem('agent-hq-dashboard:drafts')!)._general.text).toBe('어디서나 쓰는 글');
    await act(async () => { fireEvent.click(tabBtn('요청함')); });
    const ib = inboxTa();
    expect(ib.value).toBe('어디서나 쓰는 글');  // 두 입력칸이 함께 열려 있어도 같은 초안
    postFail = 1;
    const sendIn = (ta: HTMLTextAreaElement) => ta.closest('.card-body')!.querySelector('button.btn-primary') as HTMLButtonElement;
    await act(async () => { fireEvent.click(sendIn(ib)); });
    await waitFor(() => expect(sendIn(panelTa()).textContent).toBe('다시 보내기'));  // 실패 상태도 패널에 보인다
    expect([ib.readOnly, panelTa().readOnly]).toEqual([false, false]);  // 실패하면 두 입력칸 모두 다시 고칠 수 있다
    await act(async () => { fireEvent.click(sendIn(panelTa())); });
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts[0][1].messageId).toBe(posts[1][1].messageId);
    expect(posts[1][1]).toEqual({ messageId: posts[0][1].messageId, kind: 'general', text: '어디서나 쓰는 글' });
    await waitFor(() => expect([ib.value, panelTa().value]).toEqual(['', '']));
    expect(localStorage.getItem('agent-hq-dashboard:drafts')).toBe('{}');
  });

  it('한쪽에서 보내는 중이면 다른 진입점의 보내기도 막혀 중복 전송하지 않는다', async () => {
    sessionStorage.setItem('tab', '"inbox"');
    let done!: () => void;
    const gate = new Promise<void>(r => { done = r; }), f0 = (fetch as any).getMockImplementation();
    (fetch as any).mockImplementation(async (url: string, init?: RequestInit) => { if (url === 'api/messages') await gate; return f0(url, init); });
    render(<App />);
    await screen.findAllByText('Agent HQ');
    await act(async () => { fireEvent.click(fab()); });
    const ib = inboxTa(); ib.value = '한 번만'; fireEvent.input(ib);
    const sendIn = (ta: HTMLTextAreaElement) => ta.closest('.card-body')!.querySelector('button.btn-primary') as HTMLButtonElement;
    await act(async () => { fireEvent.click(sendIn(ib)); });
    expect(sendIn(panelTa()).disabled).toBe(true);
    expect([ib.readOnly, panelTa().readOnly]).toEqual([true, true]);  // 보내는 중 고친 글이 성공 뒤 초안 삭제로 사라지지 않게 두 입력칸 모두 잠근다
    await act(async () => { fireEvent.click(sendIn(panelTa())); });
    await act(async () => { done(); await new Promise(r => setTimeout(r, 0)); });
    await waitFor(() => expect(ib.value).toBe(''));
    expect(posts.length).toBe(1);
    expect([ib.readOnly, panelTa().readOnly]).toEqual([false, false]);
  });

  it('처리 기록 전인 확인 요청이 있으면 패널에서도 막고, 패널에서 보낸 요청은 요청함에도 반영된다', async () => {
    const now = new Date().toISOString();
    snap.flush = { registration: { threadName: 'coord', registeredAt: now }, recent: [], cooldownSec: 60 };
    render(<App />);
    await screen.findAllByText('Agent HQ');
    await act(async () => { fireEvent.click(fab()); });
    const panel = () => document.querySelector('[role=dialog][aria-label="메시지 보내기"]')!;
    const flushBtn = () => [...panel().querySelectorAll('button')].find(b => b.textContent === '지금 확인 요청') as HTMLButtonElement;
    expect(flushBtn().disabled).toBe(false);
    snap.flush = { ...snap.flush, recent: [{ status: 'queued', createdAt: now, threadName: 'coord' }] };
    await act(async () => { fireEvent.click(flushBtn()); await new Promise(r => setTimeout(r, 0)); });
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0][0]).toBe('api/flush');
    await waitFor(() => expect(flushBtn().disabled).toBe(true));
    expect(panel().textContent).toContain('처리 기록 전인 요청이 있어 다시 보내지 않습니다.');
    await act(async () => { fireEvent.click(tabBtn('요청함')); });
    const inboxFlush = [...document.querySelectorAll('#list button')].find(b => b.textContent === '지금 확인 요청') as HTMLButtonElement;
    expect(inboxFlush.disabled).toBe(true);
    expect(document.querySelectorAll('h3[id]').length).toBe(new Set([...document.querySelectorAll('h3[id]')].map(h => h.id)).size);  // 두 곳에 있어도 id 중복 없음
  });
});
