// 브라우저 저장소. 키와 값 형식은 기존 화면과 같아서, 교체 전후로 기준선·확인 상태·초안·선택·펼침이 이어진다.
// 저장소가 막혀도(사생활 모드 등) 예외 없이 기본값으로 동작한다
export const KEYS = {
  theme: 'agent-hq-dashboard:theme',          // 'light' | 'dark' (시스템이면 키 없음)
  side: 'agent-hq-dashboard:sidebar-width',   // px 숫자
  drafts: 'agent-hq-dashboard:drafts',        // {dkey: {text, mid}}
  alerts: 'agent-hq-dashboard:alerts',        // {v, seen, list, fold}
  status: 'agent-hq-dashboard:status-alerts', // {v, base, list, fold}
};

// 탭별 sessionStorage(JSON): tab, sel([[id, kind]]), open([key]), f:<입력 id>
export const session = {
  get<T>(k: string, d: T): T { try { return JSON.parse(sessionStorage.getItem(k)!) ?? d; } catch { return d; } },
  set(k: string, v: unknown) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export function localGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
export function localSet(k: string, v: string | null) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

export type Drafts = Record<string, { text: string; mid: string | null }>;
export const loadDrafts = (): Drafts => { try { return JSON.parse(localStorage.getItem(KEYS.drafts)!) || {}; } catch { return {}; } };
// ponytail: 다른 탭의 초안과 섞이지 않게 쓸 때마다 다시 읽어 그 키만 바꾼다
export function setDraft(dkey: string, v: { text: string; mid: string | null } | null) {
  const d = loadDrafts();
  if (v) d[dkey] = v; else delete d[dkey];
  try { localStorage.setItem(KEYS.drafts, JSON.stringify(d)); } catch {}
}
