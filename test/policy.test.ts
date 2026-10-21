import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings, shareFor } from '../server/policy.ts';

const fx = (f: string) => join(import.meta.dirname, 'fixtures/settings', f);

const before = process.env.LEGOS_SETTINGS;
afterEach(() => {
  process.env.LEGOS_SETTINGS = before;
});

describe('settings', () => {
  it('defaults to private with no file', async () => {
    process.env.LEGOS_SETTINGS = fx('missing.json');
    const s = await loadSettings();
    expect(s).toMatchObject({ share: { default: 'private', rules: [] }, error: null });
    expect(s.jiraFlow).toEqual({ todo: 'To Do', inProgress: 'In Progress', codeReview: 'Code Review', readyForQa: 'Ready for QA' });
  });

  it('falls back to private and reports a broken file', async () => {
    process.env.LEGOS_SETTINGS = fx('broken.json');
    const s = await loadSettings();
    expect(s.share.default).toBe('private');
    expect(s.error).toContain('could not read');
  });

  it('drops invalid rules', async () => {
    process.env.LEGOS_SETTINGS = fx('settings.json');
    const s = await loadSettings();
    expect(s.share.rules.map((r) => r.level)).toEqual(['status', 'full']);
    expect(s.jiraFlow).toEqual({ todo: 'To Do', inProgress: 'In Progress', codeReview: 'In Review', readyForQa: 'Ready for QA' });
  });
});

describe('shareFor', () => {
  it('uses the longest matching folder and never matches a sibling prefix', async () => {
    process.env.LEGOS_SETTINGS = fx('settings.json');
    const s = await loadSettings();
    expect(shareFor('/work/acme/billing-api', s)).toBe('status');
    expect(shareFor('/work/acme/payments-api/internal', s)).toBe('full');
    expect(shareFor('/work/acme-personal', s)).toBe('private');
    expect(shareFor('/Users/me/side-project', s)).toBe('private');
    expect(shareFor(null, s)).toBe('private');
  });
});

