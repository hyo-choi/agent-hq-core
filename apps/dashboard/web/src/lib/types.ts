// /api/dashboard 응답(server.py view)의 형태. 서버 계약을 그대로 옮긴 것이며, 화면이 쓰는 필드만 적는다
// state는 server.py item CLI가 쓰는 업무 상태다. 없으면(legacy) status 문자열로 묶는다(model.ts itemGroup)
export type State = 'open' | 'blocked' | 'waiting_user' | 'done' | 'closed' | 'dropped';
export interface Work { id?: string; title: string; status: string; state?: State; conclusion?: string; verification?: string; remaining?: string; prs?: (number | string)[] }
export interface Question {
  id?: string; q: string; status: string; state?: State; answer?: string; category?: string; thread?: string; updatedAt?: string;
  evidence?: { label: string; url: string }[]; history?: { at: string; change: string; reason: string }[];
}
export interface Pr {
  id: string; number: number; title?: string; url?: string; state?: string; isDraft?: boolean; ok?: boolean;
  mergedAt?: string; updatedAt?: string; observedAt?: string; failedAt?: string;
}
export interface Decision { id?: string; title: string; detail?: string; waiting?: string }
// 사용자 결정이 끝난 결정. coordinator가 pendingDecisions에서 옮겨 원본 id를 보존한다(읽기 전용 표시)
export interface ResolvedDecision extends Decision { status?: string; resolvedAt?: string; decisionSource?: string }
export interface JiraIssue {
  key: string; summary?: string; status?: string; priority?: string; sprint?: number | string | null; sprintIds?: (number | string)[];
  description?: string; descriptionState?: string; descriptionTruncated?: boolean;
  issueType?: string; isSubtask?: boolean; parentKey?: string;  // isSubtask 없음 = 유형 미확인(legacy)
}
export interface Sprint { name?: string; state?: 'active' | 'future' | 'closed'; startDate?: string; endDate?: string }
export interface Jira {
  issues?: JiraIssue[]; sprints?: Record<string, Sprint>; sprintField?: string; site?: string; project?: string;
  observedAt?: string; dueSetCount?: number; descriptionFetched?: boolean;
}
export interface Rec { id?: string; title: string; why?: string; action?: string; decision?: string | null; prs?: number[]; jira?: string[] }
export interface Data {
  updatedAt?: string; prsCheckedAt?: string; work?: Work[]; questions?: Question[]; pendingDecisions?: Decision[];
  resolvedDecisions?: ResolvedDecision[]; prs?: Record<string, Pr>; mergedPrs?: Record<string, Pr>;
  globalLimits?: string[]; globalLimitsId?: string; jira?: Jira; recommendations?: { updatedAt?: string; items?: Rec[] };
}
export interface ReqItem { kind: string; id: string; label: string }
export interface Req { requestId: string; createdAt?: string; status: string; processedAt?: string; error?: string; items: ReqItem[] }
export interface MsgLink { id: string; kind: string; label: string; at?: string; note?: string }
export interface Msg {
  messageId: string; kind: string; itemId: string | null; label: string | null; text: string; status: string;
  createdAt?: string; processedAt?: string; processNote?: string; link?: MsgLink | null; replies?: { at?: string; text: string }[];
}
export interface FlushRec { status: string; createdAt: string; threadName?: string; error?: string }
export interface Flush { registration?: { threadName: string; registeredAt?: string } | null; recent?: FlushRec[]; cooldownSec?: number }
export interface PrRefresh { running?: boolean; ok?: boolean | null; error?: string | null; finishedAt?: string | null }
export interface Snap { data: Data; refs: Record<string, string>; requests: Req[]; messages: Msg[]; flush: Flush | null; prRefresh: PrRefresh }

export type Kind = 'work' | 'question' | 'pr' | 'decision' | 'limits' | 'message';
// 화면 카드 공통 형태. raw는 원본 객체다
export interface Item {
  kind: Kind; id?: string; label: string; status: string; state?: State; lead?: string; raw: any;
  cat?: string; thread?: string; resolved?: boolean;
}
