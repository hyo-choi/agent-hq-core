// 사이드바: 홈 링크, 메뉴(탭), 알림 자리, 테마, 폭 조절. 테마·폭의 첫 적용은 index.html head 스크립트가 첫 페인트 전에 한다
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { TABS, fmt } from '../lib/model';
import { KEYS, localGet, localSet } from '../lib/storage';

// 테마: 수동 선택이 우선이고, 저장소가 막혀도 시스템 설정(auto)으로 동작한다. 저장값 light는 daisyUI bumblebee, dark는 dark 테마다
const THEMES = ['auto', 'light', 'dark'];
const darkMq = () => matchMedia('(prefers-color-scheme: dark)');
const applyTheme = (p: string) => { document.documentElement.dataset.theme = (p === 'auto' ? !darkMq().matches : p === 'light') ? 'bumblebee' : 'dark'; };
// 데스크톱 사이드바 폭(px). 화면에 쓰는 폭은 뷰포트에 맞춰 줄이되 사용자 선택값은 그대로 두어, 창을 다시 넓히면 원래 폭으로 돌아간다
const SIDE_DEF = 288, SIDE_MIN = 200, SIDE_MAX = 420;
const sideMax = () => Math.max(SIDE_MIN, Math.min(SIDE_MAX, innerWidth - 600));  // 본문 600px은 남긴다
const savedSide = () => { const v = Number(localGet(KEYS.side)); return v >= SIDE_MIN && v <= SIDE_MAX ? Math.round(v) : SIDE_DEF; };

export function Sidebar({ tab, setTab, nav, counts, tip, hot, loadedAt, note, alerts }: {
  tab: string; setTab: (k: string) => void; nav: { current: HTMLInputElement | null }; counts: Record<string, number>; tip: Record<string, string>;
  hot: (k: string) => boolean; loadedAt?: string; note?: string; alerts: ComponentChildren }) {
  const [theme, setTheme] = useState(() => { const v = localGet(KEYS.theme); return THEMES.includes(v!) ? v! : 'auto'; });
  const [pref, setPref] = useState(savedSide), [, setVw] = useState(0), [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; w: number } | null>(null), prefRef = useRef(pref);
  const now = Math.min(pref, sideMax());
  useEffect(() => { applyTheme(theme); const mq = darkMq(), f = () => applyTheme(theme); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, [theme]);
  useEffect(() => { document.documentElement.style.setProperty('--sidebar-w', now + 'px'); });
  useEffect(() => { const f = () => setVw(innerWidth); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  // drag 중에는 daisyUI drawer의 width transition을 꺼서 폭이 포인터를 바로 따라오게 한다
  useEffect(() => { document.documentElement.classList.toggle('select-none', dragging); document.documentElement.classList.toggle('cursor-col-resize', dragging); }, [dragging]);
  const setSide = (w: number, save?: boolean) => {
    const v = Math.round(Math.min(Math.max(w, SIDE_MIN), sideMax())); prefRef.current = v; setPref(v);
    if (save) localSet(KEYS.side, String(v));
  };
  const endDrag = () => { if (!drag.current) return; drag.current = null; setDragging(false); setSide(prefRef.current, true); };
  const tabKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex(([k]) => k === tab), n = TABS.length;
    const j = /Arrow(Right|Down)/.test(e.key) ? (i + 1) % n : /Arrow(Left|Up)/.test(e.key) ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault(); setTab(TABS[j][0]); document.getElementById('tab-' + TABS[j][0])?.focus();
  };
  const closeNav = () => { if (nav.current) nav.current.checked = false; };
  return <aside class="drawer-side z-30">
    <label for="nav" class="drawer-overlay" aria-label="메뉴 닫기" />
    <div class={'relative flex min-h-full w-72 flex-col gap-6 border-r border-base-300 bg-base-100 p-4 lg:w-[var(--sidebar-w,18rem)]' + (dragging ? ' transition-none' : '')} id="sidepanel">
      <div role="separator" aria-orientation="vertical" aria-label="사이드바 폭" aria-controls="sidepanel" aria-valuemin={SIDE_MIN} aria-valuemax={sideMax()} aria-valuenow={now} aria-valuetext={now + 'px'} tabIndex={0}
        title="드래그하거나 ←·→ 키로 폭 조절 · 더블클릭 또는 Home 키로 기본 폭"
        class="absolute inset-y-0 right-0 z-10 hidden w-2 cursor-col-resize touch-none transition-colors hover:bg-primary/25 focus-visible:bg-primary/40 focus-visible:outline-none lg:block"
        onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, w: now }; setDragging(true); }}
        onPointerMove={e => { if (drag.current) setSide(drag.current.w + e.clientX - drag.current.x); }}
        onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
        onDblClick={() => setSide(SIDE_DEF, true)}
        onKeyDown={e => { const step = e.shiftKey ? 48 : 16;
          const w = ({ ArrowRight: now + step, ArrowLeft: now - step, Home: SIDE_DEF, End: sideMax() } as Record<string, number>)[e.key];
          if (w == null) return; e.preventDefault(); setSide(w, true); }} />
      <a href="#home" id="tab-home" class="block rounded-box px-2 pt-2 pb-1 hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-primary" title="홈으로"
        aria-current={tab === 'home' ? 'page' : undefined} onClick={e => { e.preventDefault(); setTab('home'); closeNav(); }}>
        <p class="text-lg font-bold tracking-tight">Agent HQ</p><p class="text-sm text-base-content/60">작업·질문·결정 진행판</p></a>
      <ul class="menu w-full gap-1 p-0" role="tablist" aria-label="보기 선택" aria-orientation="vertical">
        {TABS.map(([k, name]) => <li key={k} role="none"><button class={'justify-between py-2.5 text-[15px]' + (k === tab ? ' menu-active' : '')} role="tab" id={'tab-' + k} type="button"
          aria-selected={k === tab} aria-controls="panel" tabIndex={k === tab || (tab === 'home' && k === TABS[0][0]) ? 0 : -1}
          onClick={() => { setTab(k); closeNav(); }} onKeyDown={tabKey}>
          {name}{counts[k] == null ? null : <span class={'badge badge-sm tabular-nums ' + (hot(k) ? 'badge-warning' : 'badge-ghost')} title={tip[k]} aria-label={tip[k]}>{counts[k]}</span>}</button></li>)}
      </ul>
      {/* 새 항목·상태 알림(데스크톱). 고정 위치로 띄우지 않아 본문·선택 bar를 가리지 않는다 */}
      <div class="hidden lg:contents">{alerts}</div>
      <div class="mt-auto grid gap-3 px-2 text-sm">
        <label class="grid gap-1"><span class="text-xs font-medium text-base-content/60">화면 테마</span>
          <select class="select select-sm w-full" value={theme} onChange={e => { const v = e.currentTarget.value; setTheme(v); localSet(KEYS.theme, v === 'auto' ? null : v); }}>
            <option value="auto">시스템</option><option value="light">라이트 · Bumblebee</option><option value="dark">다크</option></select></label>
        <p class="text-xs text-base-content/60">{loadedAt ? `마지막 불러옴 ${fmt(loadedAt)}` : ''}</p>
        <details class="text-xs text-base-content/60"><summary class="cursor-pointer font-medium hover:text-base-content">데이터 기준</summary>
          <p class="mt-2 leading-relaxed">{note}</p></details>
      </div>
    </div>
  </aside>;
}
