import type { DecisionAnswer, StreamMessage } from '../shared/types.ts';
import type { StartRequest } from './claude-runs.ts';

// What travels between the control plane and a runner. The runner only ever calls the control plane.

export type CloneSpec = { repo: string; key: string; branch?: string; author?: { name?: string | null; email?: string | null } };

// Stored with the job: the run as the launcher asked for it, before credentials are attached at claim time.
export type JobRequest = StartRequest & {
  id: string;
  mcpNames?: string[];
  // the run's git credential helper and the connections proxy need a per-run secret
  gitHelper?: boolean;
  // the throwaway clone of a repo run: its runner makes it unless `prepared` says the launcher already did
  clone?: CloneSpec;
  prepared?: boolean;
  // false for runs that cannot be resumed after a restart (Ask factory keeps its state in memory)
  recoverable?: boolean;
  // the clone is throwaway: read its branch and delete it when the run ends
  ownsClone?: boolean;
  priority?: number;
};

export type Job = { runId: string; attempt: number; request: StartRequest; clone?: CloneSpec; prepared: boolean; ownsClone: boolean };

export type Command = { runId: string } & (
  | { type: 'send'; text: string }
  | { type: 'model'; model: string }
  | { type: 'interrupt' }
  | { type: 'end' }
  | { type: 'decide'; id: string; answer: DecisionAnswer }
  | { type: 'discuss'; id: string; question: string }
  | { type: 'resume_task'; note?: string }
);

export type Order = Command extends infer C ? (C extends unknown ? Omit<C, 'runId'> : never) : never;

export type PollRequest = { capacity: number; running: string[] };
export type PollResponse = { jobs: Job[]; commands: Command[]; lost: string[] };

export type RunnerMessage = StreamMessage | { type: 'finished'; runId: string; branch: string | null } | { type: 'launch_failed'; runId: string; error: string };

export type Transport = {
  poll(req: PollRequest): Promise<PollResponse>;
  report(messages: RunnerMessage[]): Promise<void>;
};
