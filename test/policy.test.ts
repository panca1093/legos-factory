import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectTicket, loadSettings, shareFor } from '../server/policy.ts';

const fx = (f: string) => join(import.meta.dirname, 'fixtures/settings', f);

afterEach(() => {
  delete process.env.LEGOS_SETTINGS;
});

describe('settings', () => {
  it('defaults to private with no file', async () => {
    process.env.LEGOS_SETTINGS = fx('missing.json');
    const s = await loadSettings();
    expect(s).toMatchObject({ share: { default: 'private', rules: [] }, ticketKeys: [], error: null });
  });

  it('falls back to private and reports a broken file', async () => {
    process.env.LEGOS_SETTINGS = fx('broken.json');
    const s = await loadSettings();
    expect(s.share.default).toBe('private');
    expect(s.error).toContain('could not read');
  });

  it('drops invalid rules and keys', async () => {
    process.env.LEGOS_SETTINGS = fx('settings.json');
    const s = await loadSettings();
    expect(s.share.rules.map((r) => r.level)).toEqual(['status', 'full']);
    expect(s.ticketKeys).toEqual(['PROJ']);
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

describe('detectTicket', () => {
  it('finds a ticket in a prompt or branch', () => {
    expect(detectTicket('fix PROJ-2341 export', [])).toBe('PROJ-2341');
    expect(detectTicket('feature/proj-1885-checkout', ['PROJ'])).toBe('PROJ-1885');
    expect(detectTicket('nothing here', [])).toBeNull();
  });

  it('ignores ticket-shaped words that are not tickets', () => {
    expect(detectTicket('encode as UTF-8 and hash with SHA-256', [])).toBeNull();
    expect(detectTicket('see PLAT-12 and PROJ-9', ['PROJ'])).toBe('PROJ-9');
  });
});
