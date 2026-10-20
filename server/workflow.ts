import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Stage } from '../shared/types.ts';

// The factory workflow: stage order, personas and gates, read from workflows/factory/factory.yaml.

export const EVENTS = ['pr.merged', 'ci.passed', 'human.approved'] as const;
export type FactType = (typeof EVENTS)[number];

export type StageDef = {
  id: Stage;
  persona: string;
  // 'manual' stages begin only when a person presses their button
  manual: boolean;
  // facts about the stage's PR that must hold before it is ready to merge (design: before Build unlocks)
  gate: FactType[];
  onPrOpen: Stage | null;
  after: FactType | null;
  readOnly: boolean;
};

export type Workflow = { dir: string; stages: StageDef[] };

const STAGES: Stage[] = ['design', 'build', 'inspect', 'catalog'];
const fail = (what: string): never => {
  throw new Error(`factory.yaml: ${what}`);
};
const facts = (v: unknown, where: string): FactType[] =>
  (v == null ? [] : Array.isArray(v) ? v : [v]).map((f) => (EVENTS.includes(f) ? (f as FactType) : fail(`${where}: unknown fact ${JSON.stringify(f)}`)));
const stageId = (v: unknown, where: string): Stage => (STAGES.includes(v as Stage) ? (v as Stage) : fail(`${where}: unknown stage ${JSON.stringify(v)}`));

export function workflowDir(): string {
  return process.env.LEGOS_WORKFLOW_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'factory');
}

export function parseWorkflow(source: string, dir: string): Workflow {
  const doc = parse(source);
  if (!Array.isArray(doc?.stages) || !doc.stages.length) fail('stages must list at least one stage');
  const stages = doc.stages.map((s: any, i: number): StageDef => {
    const where = `stages[${i}]`;
    return {
      id: stageId(s?.id, where),
      persona: typeof s?.persona === 'string' ? s.persona : fail(`${where}: persona is required`),
      manual: s?.start === 'manual',
      gate: facts(s?.gate, where),
      onPrOpen: s?.on_pr_open ? stageId(s.on_pr_open, where) : null,
      after: s?.after ? facts(s.after, where)[0] : null,
      readOnly: s?.read_only === true,
    };
  });
  const ids = stages.map((s: StageDef) => s.id);
  if (new Set(ids).size !== ids.length) fail('a stage appears twice');
  for (const s of stages) if (s.onPrOpen && !ids.includes(s.onPrOpen)) fail(`${s.id}: on_pr_open names a stage that is not listed`);
  return { dir, stages };
}

const cache = new Map<string, Workflow>();

export function loadWorkflow(dir = workflowDir()): Workflow {
  if (!cache.has(dir)) cache.set(dir, parseWorkflow(readFileSync(join(dir, 'factory.yaml'), 'utf8'), dir));
  return cache.get(dir)!;
}

export function stageDef(wf: Workflow, id: Stage): StageDef {
  return wf.stages.find((s) => s.id === id) ?? fail(`no ${id} stage`);
}

// The stage after `id` in the manifest, if any.
export function stageAfter(wf: Workflow, id: Stage): StageDef | null {
  const at = wf.stages.findIndex((s) => s.id === id);
  return wf.stages[at + 1] ?? null;
}

export function persona(wf: Workflow, id: Stage): string {
  return readFileSync(join(wf.dir, stageDef(wf, id).persona), 'utf8').trim();
}

export const CONVENTIONS = "Before anything else, read this repo's own conventions: CLAUDE.md, AGENTS.md, CONTRIBUTING and its docs folder.";

// The target repo owns its conventions; the factory only says what the stage should produce.
export function stageGuide(stage: Stage, ticket: string): string {
  switch (stage) {
    case 'design':
      return `${CONVENTIONS} Write the spec for ${ticket} where this repo keeps specs, then open a pull request for it. Put ${ticket} in the branch name and in the PR title, following the repo's title format; a spec PR title carries no deployment tag.`;
    case 'build':
      return `${CONVENTIONS} Implement ${ticket}, verify it, then open a pull request. Put ${ticket} in the branch name and in the PR title, following the repo's title format.`;
    case 'inspect':
      return `${CONVENTIONS} The pull request for ${ticket} is checked out on this branch. Review it against its spec and the repo's rules. This run is read-only: do not edit, commit or push. List your findings (BLOCKER, COVERAGE, DEBT, NIT), then end with one line: "Verdict: APPROVE", "Verdict: REQUEST_CHANGES" or "Verdict: ABSTAIN".`;
    case 'catalog':
      return `${CONVENTIONS} The pull request for ${ticket} has merged. Record what this ticket taught us where this repo keeps such knowledge, in a small docs pull request; if it keeps none, only summarise. Put ${ticket} in the branch name and in the PR title.`;
  }
}
