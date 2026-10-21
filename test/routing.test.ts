import { describe, expect, it } from 'vitest';
import type { RoutingRule } from '../shared/types.ts';
import { route } from '../server/routing.ts';

const pr = { files: ['db/migrations/0042_add_purpose.sql'], changedLines: 401, repo: 'acme/api', jiraType: 'Security', labels: ['urgent', 'security'] };
const rule = (kind: RoutingRule['kind'], value: string, id: string = kind): RoutingRule => ({ id, kind, value, on: true });
const nothing = { toPerson: false, reasons: [], matches: [] };

describe('route', () => {
  it('matches any comma-separated path glob and returns the rule ID and changed path', () => {
    const reason = 'paths: db/migrations/0042_add_purpose.sql';
    expect(route(pr, [rule('paths', ' AUTH/** , DB/MIGRATIONS/** ', 'sensitive')], [])).toEqual({
      toPerson: true, reasons: [reason], matches: [{ id: 'sensitive', reason }],
    });
  });

  it('keeps a single star within one path segment and lets double stars match any depth', () => {
    const check = (file: string, glob: string) => route({ ...pr, files: [file] }, [rule('paths', glob)], []).toPerson;
    expect(check('auth/login.ts', 'auth/*.ts')).toBe(true);
    expect(check('auth/nested/login.ts', 'auth/*.ts')).toBe(false);
    expect(check('auth/login.ts', 'auth/**/*.ts')).toBe(true);
    expect(check('auth/nested/login.ts', 'auth/**/*.ts')).toBe(true);
    expect(check('auth/deep/nested/login.ts', 'auth/**')).toBe(true);
    expect(check('other/auth/login.ts', 'auth/**')).toBe(false);
    expect(check('auth/loginXts', 'auth/*.ts')).toBe(false);
  });

  it('routes changed lines strictly above one positive integer threshold', () => {
    const rules = [rule('lines', ' 400 ')];
    expect(route({ ...pr, changedLines: 399 }, rules, [])).toEqual(nothing);
    expect(route({ ...pr, changedLines: 400 }, rules, [])).toEqual(nothing);
    expect(route(pr, rules, [])).toEqual({ toPerson: true, reasons: ['lines: 401 > 400'], matches: [{ id: 'lines', reason: 'lines: 401 > 400' }] });
  });

  it('matches explicit Jira types or labels exactly with case folding', () => {
    expect(route(pr, [rule('jira', ' type:bug , TYPE:security ')], []).toPerson).toBe(true);
    expect(route({ ...pr, jiraType: null }, [rule('jira', 'label: SECURITY')], []).toPerson).toBe(true);
    expect(route(pr, [rule('jira', 'type:Sec, label:urgent-ish')], [])).toEqual(nothing);
    expect(route({ ...pr, jiraType: null, labels: [] }, [rule('jira', 'type:Security, label:security')], [])).toEqual(nothing);
  });

  it('matches comma-separated repositories with stars only in the slug', () => {
    const rules = [rule('repo', ' acme/web, ACME/payments-* ')];
    expect(route({ ...pr, repo: 'Acme/Payments-api' }, rules, []).toPerson).toBe(true);
    expect(route({ ...pr, repo: 'other/payments-api' }, rules, [])).toEqual(nothing);
    expect(route({ ...pr, repo: 'acme/payments-api/nested' }, rules, [])).toEqual(nothing);
    expect(route({ ...pr, repo: 'acme/payments-api/nested' }, [rule('repo', 'acme/payments-**')], [])).toEqual(nothing);
    expect(route(pr, [rule('repo', 'acme/api')], []).toPerson).toBe(true);
    expect(route({ ...pr, repo: 'acme/api-extra' }, [rule('repo', 'acme/api')], [])).toEqual(nothing);
  });

  it('ignores disabled rules', () => {
    expect(route(pr, [{ ...rule('paths', '**'), on: false }], [])).toEqual(nothing);
  });

  it('the inspector can add a reason', () => {
    expect(route(pr, [], ['Needs a security specialist'])).toEqual({ toPerson: true, reasons: ['Needs a security specialist'], matches: [] });
    const result = route(pr, [rule('repo', 'acme/api')], ['Needs a security specialist']);
    expect(result.matches).toEqual([{ id: 'repo', reason: 'repo: acme/api' }]);
    expect(result.reasons).toEqual(['repo: acme/api', 'Needs a security specialist']);
    expect(route(pr, [rule('repo', 'acme/api')], []).toPerson).toBe(true);
  });

  it('an empty rule list sends nothing to a person', () => {
    expect(route(pr, [], [])).toEqual(nothing);
  });

  it('retains every matched rule in order', () => {
    const result = route(pr, [rule('repo', 'acme/api', 'one'), rule('lines', '400', 'two')], []);
    expect(result.matches.map((match) => match.id)).toEqual(['one', 'two']);
    expect(result.reasons).toHaveLength(2);
  });
});
