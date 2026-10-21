import type { RoutingRule } from '../shared/types.ts';

const entries = (value: string) => value.split(',').map((entry) => entry.trim());

export function routingRuleError(rule: Pick<RoutingRule, 'kind' | 'value'>): string | null {
  const values = entries(rule.value);
  if (values.some((value) => !value)) return 'entries must not be empty';
  switch (rule.kind) {
    case 'paths':
      return values.every((value) => !/[!\[\]{}?\\]/.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..'))
        ? null : 'paths must be repo-relative globs using only * and ** wildcards';
    case 'lines':
      return /^\d+$/.test(rule.value.trim()) && Number.isSafeInteger(Number(rule.value)) && Number(rule.value) > 0
        ? null : 'lines must be one positive integer';
    case 'jira':
      return values.every((value) => /^(type|label):\s*\S.*$/i.test(value) && !/^(type|label):\s*[!*]/i.test(value))
        ? null : 'jira entries must be type:<name> or label:<name>';
    case 'repo':
      return values.every((value) => /^[a-z0-9_.-]+\/[a-z0-9_.*-]+$/i.test(value))
        ? null : 'repos must be workspace/slug with * allowed only in the slug';
  }
}

function globMatches(value: string, glob: string, recursive = true): boolean {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    if (recursive && glob[i] === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        pattern += '(?:.*/)?';
        i++;
      } else pattern += '.*';
    } else if (glob[i] === '*') pattern += '[^/]*';
    else pattern += glob[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`, 'i').test(value);
}

export function route(
  pr: { files: string[]; changedLines: number; repo: string; jiraType: string | null; labels: string[] },
  rules: RoutingRule[],
  inspectorReasons: string[],
): { toPerson: boolean; reasons: string[]; matches: { id: string; reason: string }[] } {
  const matches: { id: string; reason: string }[] = [];
  for (const rule of rules) {
    if (!rule.on || routingRuleError(rule)) continue;
    const values = entries(rule.value);
    let reason: string | undefined;
    switch (rule.kind) {
      case 'paths': {
        const file = pr.files.find((file) => values.some((value) => globMatches(file, value)));
        if (file !== undefined) reason = `paths: ${file}`;
        break;
      }
      case 'lines':
        if (pr.changedLines > Number(rule.value)) reason = `lines: ${pr.changedLines} > ${Number(rule.value)}`;
        break;
      case 'jira':
        for (const value of values) {
          const colon = value.indexOf(':');
          const kind = value.slice(0, colon).toLowerCase();
          const name = value.slice(colon + 1).trim().toLowerCase();
          const matched = kind === 'type' ? pr.jiraType?.toLowerCase() === name : pr.labels.some((label) => label.toLowerCase() === name);
          if (matched) {
            reason = `jira: ${kind}:${kind === 'type' ? pr.jiraType : pr.labels.find((label) => label.toLowerCase() === name)}`;
            break;
          }
        }
        break;
      case 'repo':
        if (values.some((value) => globMatches(pr.repo, value, false))) reason = `repo: ${pr.repo}`;
        break;
    }
    if (reason) matches.push({ id: rule.id, reason });
  }
  const reasons = [...matches.map((match) => match.reason), ...inspectorReasons];
  return { toPerson: reasons.length > 0, reasons, matches };
}
