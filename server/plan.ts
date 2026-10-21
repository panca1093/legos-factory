import type { Plan, PlanTask } from '../shared/types.ts';

function scalar(value: string): string {
  if (value.startsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string' && parsed.length) return parsed;
  } else if (value.startsWith("'")) {
    if (/^'(?:[^']|'')+'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  } else if (value && !/[\[\]{}"']/.test(value) && !/:\s/.test(value)) {
    return value;
  }
  throw new Error('bad YAML: expected a non-empty string');
}

function list(value: string): string[] {
  if (!value.startsWith('[') || !value.endsWith(']')) throw new Error('bad YAML: expected an inline list');
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  const values: string[] = [];
  let start = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote === '"' && char === '\\') {
      i++;
    } else if (quote && char === quote) {
      if (quote === "'" && body[i + 1] === "'") i++;
      else quote = '';
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
    } else if (!quote && char === ',') {
      values.push(scalar(body.slice(start, i).trim()));
      start = i + 1;
    }
  }
  if (quote) throw new Error('bad YAML: unclosed quote');
  values.push(scalar(body.slice(start).trim()));
  return values;
}

export function parsePlan(prDescription: string, repos: string[]): Plan {
  const fallback = (error: string): Plan => ({
    tasks: repos.map((repo, index) => ({
      id: `T${index + 1}`, do: `Build ${repo}`, repo, test: '',
      needs: index ? [`T${index}`] : [], touches: [], state: 'waiting',
    })),
    error,
  });
  const block = /^```plan[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/m.exec(prDescription);
  if (!block) return fallback('no plan block');
  try {
    const records: Record<string, string | string[]>[] = [];
    for (const line of block[1].split(/\r?\n/)) {
      if (!line.trim()) continue;
      const field = /^(?:- |  )([a-z]+):[ \t]*(.*?)[ \t]*$/.exec(line);
      if (!field) throw new Error('bad YAML: expected a task field');
      if (line.startsWith('- ')) records.push({});
      const record = records.at(-1);
      const [, key, value] = field;
      if (!record || !['id', 'do', 'repo', 'test', 'needs', 'touches'].includes(key) || Object.hasOwn(record, key)) {
        throw new Error('bad YAML: unknown or duplicate field');
      }
      record[key] = key === 'needs' || key === 'touches' ? list(value) : scalar(value);
    }
    if (!records.length || records.some((record) => Object.keys(record).length !== 6)) {
      throw new Error('bad YAML: missing task fields');
    }
    const tasks = records.map((record) => ({ ...record, state: 'waiting' })) as PlanTask[];
    const ids = new Set<string>();
    for (const task of tasks) {
      if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
      ids.add(task.id);
      if (!repos.includes(task.repo)) throw new Error(`unknown repo: ${task.repo}`);
    }
    for (const task of tasks) {
      for (const need of task.needs) {
        if (!ids.has(need)) throw new Error(`unknown id in needs: ${need}`);
      }
    }
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error('cycle in plan dependencies');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const need of byId.get(id)!.needs) visit(need);
      visiting.delete(id);
      visited.add(id);
    };
    for (const task of tasks) visit(task.id);
    return { tasks, error: null };
  } catch (error) {
    return fallback(error instanceof Error ? error.message : 'bad YAML');
  }
}

export function canRunTogether(a: PlanTask, b: PlanTask, plan: Plan): boolean {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const needs = (task: PlanTask, id: string, seen = new Set<string>()): boolean => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return task.needs.some((need) => need === id || (byId.has(need) && needs(byId.get(need)!, id, seen)));
  };
  return a.id !== b.id && !needs(a, b.id) && !needs(b, a.id) && !a.touches.some((path) => b.touches.includes(path));
}

export function waves(plan: Plan): string[][] {
  const remaining = [...plan.tasks];
  const done = new Set<string>();
  const result: string[][] = [];
  while (remaining.length) {
    const wave: PlanTask[] = [];
    for (const task of remaining) {
      if (task.needs.every((id) => done.has(id)) && wave.every((other) => canRunTogether(task, other, plan))) wave.push(task);
    }
    if (!wave.length) throw new Error('plan dependencies cannot be scheduled');
    result.push(wave.map((task) => task.id));
    for (const task of wave) {
      done.add(task.id);
      remaining.splice(remaining.indexOf(task), 1);
    }
  }
  return result;
}
