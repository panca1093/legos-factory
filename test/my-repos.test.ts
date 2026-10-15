import { describe, expect, it } from 'vitest';
import { openDb } from '../server/db.ts';
import { MY_REPOS_CAP, MyRepos } from '../server/my-repos.ts';

const status = (f: () => unknown) => {
  try {
    f();
  } catch (err) {
    return (err as { status?: number }).status;
  }
  return null;
};

describe('my repos', () => {
  it('adds, lists by name and removes, per owner', () => {
    const repos = new MyRepos(openDb(':memory:'));
    repos.add('u1', { name: 'acme/web', mainBranch: 'main' });
    repos.add('u1', { name: 'Acme/api', mainBranch: null });
    repos.add('u2', { name: 'acme/other', mainBranch: 'dev' });
    expect(repos.list('u1').map((r) => [r.name, r.mainBranch])).toEqual([['Acme/api', null], ['acme/web', 'main']]);
    expect(repos.list('u1')[0].addedAt).toMatch(/^\d{4}-/);
    expect(repos.has('u1', 'acme/API')).toBe(true);
    expect(repos.has('u1', 'acme/other')).toBe(false);
    expect(repos.has('u2', 'acme/other')).toBe(true);

    repos.remove('u1', 'ACME/web');
    expect(repos.list('u1').map((r) => r.name)).toEqual(['Acme/api']);
    expect(repos.list('u2').map((r) => r.name)).toEqual(['acme/other']);
  });

  it('refuses a duplicate in any case, and more than the cap', () => {
    const repos = new MyRepos(openDb(':memory:'));
    repos.add('u1', { name: 'acme/api', mainBranch: 'main' });
    expect(status(() => repos.add('u1', { name: 'ACME/Api', mainBranch: 'main' }))).toBe(409);
    for (let i = 1; i < MY_REPOS_CAP; i++) repos.add('u1', { name: `acme/r${i}`, mainBranch: null });
    expect(status(() => repos.add('u1', { name: 'acme/one-too-many', mainBranch: null }))).toBe(409);
    expect(repos.list('u1')).toHaveLength(MY_REPOS_CAP);
    expect(status(() => repos.add('u2', { name: 'acme/api', mainBranch: null }))).toBe(null);
  });
});
