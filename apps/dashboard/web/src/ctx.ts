// 화면 전체가 함께 쓰는 상태와 동작. App이 만든다
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Items } from './lib/model';
import type { Item, Snap } from './lib/types';

export interface AppCtx {
  snap: Snap; it: Items; pend: Set<string>; refOf: (id?: string | null) => string;
  tab: string; setTab: (k: string) => void;
  sel: Map<string, string>; editSel: (f: (m: Map<string, string>) => void) => void;
  isOpen: (key: string) => boolean; setOpen: (key: string, open: boolean) => void;
  filters: Record<string, string>; setFilters: (v: Record<string, string>) => void;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
  openDialog: (node: ComponentChildren) => void; closeDialog: () => void;
  reload: () => Promise<void>;
  reveal: (x: Item) => void; afterRender: (f: () => void) => void;
  alertTick: number; bumpAlerts: () => void;
  // 입력 중인 Composer의 초안 키. 그동안 목록 배치(묶음·순서)를 고정해 카드가 다른 부모로 옮겨지며 다시 만들어지지 않게 한다
  editing: string | null; setEditing: (k: string | null | ((cur: string | null) => string | null)) => void;
}
export const Ctx = createContext<AppCtx>(null!);
export const useApp = () => useContext(Ctx);
