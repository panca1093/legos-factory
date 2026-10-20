import type { RepoRef } from './workspace.ts';

// The two things the factory needs from the outside world, as the core sees them. A provider module
// implements each for one product; nothing outside server/providers names that product.

export type PrState = 'OPEN' | 'MERGED' | 'DECLINED';

export type RepoRow = { name: string; mainBranch: string | null; updated: string | null; description: string | null };
export type PrRow = { repo: string; id: number; title: string; state: string; author: string | null; source: string; destination: string; updated: string | null };
export type Pr = PrRow & {
  description: string;
  url: string | null;
  reviewers: { name: string; uuid: string | null; approved: boolean }[];
  comments: number;
  tasks: number;
  created: string | null;
  // the forge's verdict on the PR's checks; null when it reports none
  ci: 'passed' | 'failed' | 'pending' | null;
};
export type PrFile = { status: string; path: string; oldPath: string | null; added: number; removed: number };
export type PrComment = { id: number; author: string | null; text: string; path: string | null; line: number | null; created: string | null };
export type Inline = { path: string; line: number };

// Where the code and its pull requests live.
export interface Forge {
  readonly kind: string;
  listRepos(namespace: string): Promise<RepoRow[]>;
  listPrs(repo: RepoRef, state: PrState, limit?: number): Promise<PrRow[]>;
  getPr(repo: RepoRef, id: number): Promise<Pr>;
  files(repo: RepoRef, id: number): Promise<PrFile[]>;
  diff(repo: RepoRef, id: number): Promise<{ diff: string; truncated: boolean }>;
  comments(repo: RepoRef, id: number): Promise<PrComment[]>;
  addComment(repo: RepoRef, id: number, text: string, inline?: Inline): Promise<{ id: number }>;
  merge(repo: RepoRef, id: number): Promise<void>;
  // a short-lived token git can clone, pull and push the repo with
  cloneToken(repo: RepoRef): Promise<string>;
  searchUsers(namespace: string, query: string): Promise<{ name: string; uuid: string }[]>;
}

// What a ticket's development looks like at the source: PRs, builds and deploys it reports.
export type DevSummary = {
  prs: { count: number; state: string | null; open: boolean } | null;
  builds: { ok: number; failed: number } | null;
  deploys: { env: string; status: string }[];
  // the source caches this summary; true means it may lag behind the forge
  stale: boolean;
};

export type WorkItemRow = {
  key: string;
  summary: string;
  status: string | null;
  assignee: string | null;
  priority: string | null;
  updated: string | null;
  dev: DevSummary | null;
};

export type WorkItemDetail = WorkItemRow & {
  issueType: string | null;
  description: string | null;
  labels: string[];
  reporter: string | null;
  parent: string | null;
  created: string | null;
  url: string | null;
};

// Where tickets live.
export interface WorkSource {
  readonly kind: string;
  // `filter` names one of the source's own presets; `query` is its query language, taking precedence
  list(q: { filter: string; query?: string }, limit: number, page?: string): Promise<{ items: WorkItemRow[]; next: string | null }>;
  get(key: string): Promise<WorkItemDetail>;
  status(key: string): Promise<string | null>;
  // false when the ticket has no way to reach that status from where it is
  transitionTo(key: string, status: string): Promise<boolean>;
  comment(key: string, body: string): Promise<void>;
}
