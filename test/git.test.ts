import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { RunManager, type StartRequest } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { MyRepos } from '../server/my-repos.ts';
import { Users } from '../server/users.ts';
import { tokenFromCloneUrl } from '../server/workbench.ts';
import { createWorkspace } from '../server/workspace.ts';
import { alive, fakeServers, WB } from './fakes.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const TOKEN = 'tok-SECRET/+=';
const cloneUrl = (ws: string, slug: string, token = TOKEN) => `https://x-token-auth:${encodeURIComponent(token)}@bitbucket.org/${ws}/${slug}.git`;

// <root>/acme/{app,web}.git
function forgeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'lf-git-'));
  const src = join(root, 'src');
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'config', 'user.email', 't@t');
  git(src, 'config', 'user.name', 't');
  writeFileSync(join(src, 'README.md'), 'main\n');
  git(src, 'add', '.');
  git(src, 'commit', '-qm', 'init');
  for (const slug of ['app', 'web']) git(root, 'clone', '-q', '--bare', src, join(root, 'acme', `${slug}.git`));
  return root;
}

// Smart-HTTP git over `git http-backend`, answering only Basic x-token-auth:<TOKEN> like Bitbucket.
function gitServer(root: string): Promise<Server> {
  const srv = createServer((req, res) => {
    const want = `Basic ${Buffer.from(`x-token-auth:${TOKEN}`).toString('base64')}`;
    if (req.headers.authorization !== want) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="forge"' });
      return res.end('Authentication failed');
    }
    const url = new URL(req.url!, 'http://x');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REMOTE_USER: 'x-token-auth',
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        HTTP_GIT_PROTOCOL: (req.headers['git-protocol'] as string) ?? '',
      },
    });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on('data', (d) => chunks.push(d));
    cgi.on('close', () => {
      const out = Buffer.concat(chunks);
      const end = out.indexOf('\r\n\r\n');
      const headers: Record<string, string> = {};
      for (const l of out.subarray(0, end).toString().split('\r\n')) {
        const i = l.indexOf(':');
        headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
      }
      const status = Number((headers.status ?? '200').split(' ')[0]);
      delete headers.status;
      res.writeHead(status, headers);
      res.end(out.subarray(end + 4));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

let root: string;
let server: Server;
const saved = { ...process.env };

beforeAll(async () => {
  process.env.LEGOS_SETTINGS = join(import.meta.dirname, 'fixtures/settings/app.json');
  root = forgeRoot();
  server = await gitServer(root);
  // https://bitbucket.org/ → the local server, appended to whatever GIT_CONFIG_* the environment already has
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  process.env[`GIT_CONFIG_KEY_${n}`] = `url.http://127.0.0.1:${(server.address() as AddressInfo).port}/.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${n}`] = 'https://bitbucket.org/';
  process.env.GIT_CONFIG_COUNT = String(n + 1);
  delete process.env.GIT_ASKPASS;
});

afterAll(() => {
  process.env = saved;
  server.close();
});

describe('tokenFromCloneUrl', () => {
  it('reads the token from a Bitbucket clone URL, null for anything else', () => {
    expect(tokenFromCloneUrl(cloneUrl('acme', 'app'))).toBe(TOKEN);
    for (const bad of ['', 'not a url', 'https://bitbucket.org/acme/app.git', 'https://x-token-auth:@bitbucket.org/acme/app.git', 'https://bob:t@bitbucket.org/acme/app.git', 'http://x-token-auth:t@bitbucket.org/acme/app.git', 'https://x-token-auth:t@evil.test/acme/app.git'])
      expect(tokenFromCloneUrl(bad)).toBeNull();
  });
});

describe('cloning with a workbench credential', () => {
  const path = () => join(mkdtempSync(join(tmpdir(), 'lf-ws-')), 'u1', 'acme', 'app', 'PROJ-1');

  it('clones over HTTPS, keeps the token out of .git/config, and writes the run-time helper and author', async () => {
    const cwd = await createWorkspace({ path: path(), repo: { workspace: 'acme', slug: 'app' }, credential: async () => TOKEN, author: { name: 'Ada Lovelace', email: 'ada@acme.test' } });
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('main\n');
    const config = readFileSync(join(cwd, '.git', 'config'), 'utf8');
    expect(config).not.toContain('tok-SECRET');
    expect(git(cwd, 'config', '--local', 'remote.origin.url')).toBe('https://bitbucket.org/acme/app.git');
    expect(execFileSync('git', ['config', '--local', '--get-all', 'credential.https://bitbucket.org.helper'], { cwd }).toString()).toBe(
      '\n!f() { test "$1" = get || exit 0; curl -fsS -H "x-legos-run: $LEGOS_RUN_SECRET" "$LEGOS_URL/git/credential"; }; f\n',
    );
    expect(git(cwd, 'config', '--local', 'user.name')).toBe('Ada Lovelace');
    expect(git(cwd, 'config', '--local', 'user.email')).toBe('ada@acme.test');
  });

  it('leaves the author to git when it is not known', async () => {
    const cwd = await createWorkspace({ path: path(), repo: { workspace: 'acme', slug: 'app' }, credential: async () => TOKEN, author: { name: 'Ada', email: null } });
    expect(git(cwd, 'config', '--local', 'user.name')).toBe('Ada');
    expect(() => git(cwd, 'config', '--local', 'user.email')).toThrow();
  });

  it('the run-time helper fetches a credential from the factory with the run secret', async () => {
    const cwd = await createWorkspace({ path: path(), repo: { workspace: 'acme', slug: 'app' }, credential: async () => TOKEN });
    const seen: (string | undefined)[] = [];
    const factory = createServer((req, res) => {
      seen.push(`${req.url} ${req.headers['x-legos-run']}`);
      res.end('username=x-token-auth\npassword=fresh\n');
    });
    await new Promise<void>((r) => factory.listen(0, '127.0.0.1', r));
    const fill = spawn('git', ['credential', 'fill'], {
      cwd,
      env: { ...process.env, LEGOS_RUN_SECRET: 's3', LEGOS_URL: `http://127.0.0.1:${(factory.address() as AddressInfo).port}`, GIT_TERMINAL_PROMPT: '0' },
    });
    fill.stdin.end('protocol=https\nhost=bitbucket.org\n\n');
    let out = '';
    fill.stdout.on('data', (d) => (out += d));
    await new Promise((r) => fill.on('close', r));
    factory.close();
    expect(seen).toEqual(['/git/credential s3']);
    expect(out).toContain('username=x-token-auth\npassword=fresh\n');
  });

  it('redacts credentials from clone errors and hints at reconnecting workbench on auth failures', async () => {
    const err = await createWorkspace({ path: path(), repo: { workspace: 'acme', slug: 'app' }, credential: async () => 'wrong-SECRET' }).catch((e) => e);
    expect(err.message).toMatch(/could not clone acme\/app/);
    expect(err.message).toContain('reconnect workbench in Settings (needs repository write access)');
    expect(err.message).not.toContain('SECRET');

    const leaky = await createWorkspace({ path: path(), repo: { workspace: 'acme', slug: 'app' }, urlTemplate: 'https://x-token-auth:SECRET@127.0.0.1:1/{workspace}/{slug}.git' }).catch((e) => e);
    expect(leaky.message).toMatch(/could not clone acme\/app/);
    expect(leaky.message).not.toContain('SECRET');
  });
});

describe('repo runs and /git/credential', () => {
  function setup(opts: { gitUrl?: boolean; exec?: (tool: string, args: any) => unknown; users?: boolean } = {}) {
    const calls: any[] = [];
    const srv = fakeServers({
      whoami: { id: 'u1', email: 'ada@acme.test', name: 'Ada Lovelace' },
      exec: (tool, args) => {
        calls.push({ tool, args });
        if (opts.exec) return opts.exec(tool, args);
        if (tool === 'bitbucket_get_clone_url') return { url: cloneUrl(args.workspace, args.repoSlug) };
        return null;
      },
    });
    const db = openDb(':memory:');
    const myRepos = new MyRepos(db);
    for (const name of ['acme/app', 'acme/web']) myRepos.add('local', { name, mainBranch: 'main' });
    const runs = new RunManager(alive);
    const starts: StartRequest[] = [];
    const orig = runs.start.bind(runs);
    runs.start = (r) => (starts.push(r), orig(r));
    const workspaces = mkdtempSync(join(tmpdir(), 'lf-ws-'));
    const app = createApp(runs, { db, workspaces, selfUrl: 'http://localhost:4317', fetch: srv.fetchFn, gitUrl: opts.gitUrl === false ? undefined : `file://${root}/{workspace}/{slug}.git` });
    const req = (p: string, init: RequestInit = {}) => app.request(`http://localhost:4317${p}`, { ...init, headers: { host: 'localhost:4317', ...(init.headers as any) } });
    const post = (p: string, body: unknown = {}) => req(p, { method: 'POST', body: JSON.stringify(body), headers: { 'x-legos': '1', 'content-type': 'application/json' } });
    const connectWorkbench = async () => {
      await post('/api/connections', { name: 'workbench', kind: 'workbench', url: WB, auth: 'oauth' });
      const authorize = new URL((await (await post('/api/connections/workbench/connect')).json()).url);
      srv.setChallenge(authorize.searchParams.get('code_challenge')!);
      await req(`/auth/callback?code=abc&state=${authorize.searchParams.get('state')}`);
    };
    const credential = (secret: string, host = 'localhost:4317') => req('/git/credential', { headers: { host, 'x-legos-run': secret } });
    const cloneCalls = () => calls.filter((c) => c.tool === 'bitbucket_get_clone_url').map((c) => `${c.args.workspace}/${c.args.repoSlug}`);
    return { runs, starts, post, req, credential, connectWorkbench, cloneCalls, myRepos, workspaces };
  }

  it('gives every repo run a grant and env, with zero MCP connections; local-folder runs get neither', async () => {
    const { starts, post, runs } = setup();
    const res = await post('/api/runs', { repo: 'acme/app', prompt: 'PROJ-1' });
    expect(res.status).toBe(201);
    const env = starts[0].env!;
    expect(env.LEGOS_URL).toBe('http://localhost:4317');
    expect(env.LEGOS_RUN_SECRET).toMatch(/^[\w-]{20,}$/);
    expect(starts[0].mcp).toBeUndefined();

    expect((await post('/api/runs', { cwd: '/tmp', prompt: 'hi' })).status).toBe(201);
    expect(starts[1].env).toBeUndefined();
    expect(starts[1].mcp).toBeUndefined();
    await runs.end((await res.json()).id);
  });

  it('mints a fresh token per call for the run\'s own repo only, and revokes the grant when the run ends', async () => {
    const { starts, post, runs, credential, connectWorkbench, cloneCalls } = setup();
    await connectWorkbench();
    const app = await (await post('/api/runs', { repo: 'acme/app', prompt: 'PROJ-1' })).json();
    await post('/api/runs', { repo: 'acme/web', prompt: 'PROJ-2' });
    const [a, w] = starts.map((s) => s.env!.LEGOS_RUN_SECRET);

    const res = await credential(a);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(`username=x-token-auth\npassword=${TOKEN}\n`);
    await credential(a);
    await credential(w);
    expect(cloneCalls()).toEqual(['acme/app', 'acme/app', 'acme/web']);

    await runs.end(app.id);
    await new Promise((r) => setTimeout(r, 10));
    expect((await credential(a)).status).toBe(403);
  });

  it('refuses non-local hosts, unknown secrets, runs without a repo, and repos removed from My repos', async () => {
    const { starts, post, credential, connectWorkbench, myRepos, cloneCalls } = setup();
    await connectWorkbench();
    await post('/api/connections', { name: 'tools', kind: 'mcp', url: 'http://localhost:9000/mcp', auth: 'header', headers: { 'x-api-key': 'k' } });
    await post('/api/runs', { repo: 'acme/app', prompt: 'PROJ-1' });
    await post('/api/runs', { cwd: '/tmp', prompt: 'hi' });
    const secret = starts[0].env!.LEGOS_RUN_SECRET;
    // a local-folder run has a grant (for its MCP proxy) but no repo
    const folder = starts[1].mcp!.tools.headers['x-legos-run'];

    expect((await credential(secret, 'evil.test')).status).toBe(403);
    expect((await credential('guess')).status).toBe(403);
    expect((await credential(folder)).status).toBe(403);
    myRepos.remove('local', 'acme/app');
    const gone = await credential(secret);
    expect(gone.status).toBe(403);
    expect(await gone.json()).toMatchObject({ needRepo: true });
    expect(cloneCalls()).toEqual([]);
  });

  it('answers 409 without a workbench and 502 when workbench fails or sends an unexpected URL', async () => {
    const none = setup();
    await none.post('/api/runs', { repo: 'acme/app', prompt: 'PROJ-1' });
    expect((await none.credential(none.starts[0].env!.LEGOS_RUN_SECRET)).status).toBe(409);

    for (const exec of [() => { throw new Error('boom'); }, () => ({ url: 'https://bitbucket.org/acme/app.git' })]) {
      const s = setup({ exec: (tool, args) => (tool === 'bitbucket_get_clone_url' ? exec() : null) });
      await s.connectWorkbench();
      await s.post('/api/runs', { repo: 'acme/app', prompt: 'PROJ-1' });
      const res = await s.credential(s.starts[0].env!.LEGOS_RUN_SECRET);
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain('bitbucket.org');
    }
  });

  it('without gitUrl, clones through workbench as the run owner', async () => {
    const { post, runs, connectWorkbench, cloneCalls } = setup({ gitUrl: false });
    expect((await post('/api/runs', { repo: 'acme/app', prompt: 'PROJ-1' })).status).toBe(409);
    await connectWorkbench();
    const res = await post('/api/runs', { repo: 'acme/app', prompt: 'PROJ-1' });
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(readFileSync(join(run.cwd, 'README.md'), 'utf8')).toBe('main\n');
    expect(readFileSync(join(run.cwd, '.git', 'config'), 'utf8')).not.toContain('tok-SECRET');
    expect(cloneCalls()).toEqual(['acme/app']);
    await runs.end(run.id);
  });

  it('fix-queue runs clone through workbench and get a grant and env too', async () => {
    const { starts, post, connectWorkbench, credential } = setup({
      gitUrl: false,
      exec: (tool, args) => {
        if (tool === 'bitbucket_get_clone_url') return { url: cloneUrl(args.workspace, args.repoSlug) };
        if (tool === 'bitbucket_get_pr') return { id: 12, title: 't', state: 'OPEN', source: 'main', destination: 'main' };
        if (tool === 'bitbucket_list_pr_comments') return { comments: [{ id: 1, author: 'Bob', text: 'rename this', created_on: '2026-10-02' }], hasMore: false };
        return null;
      },
    });
    await connectWorkbench();
    const res = await post('/api/prs/acme/app/12/fixes', { commentIds: [1] });
    expect(res.status).toBe(201);
    const queue = await res.json();
    for (let i = 0; i < 200 && !starts.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(starts[0].repo).toBe('acme/app');
    expect(starts[0].env?.LEGOS_URL).toBe('http://localhost:4317');
    expect((await credential(starts[0].env!.LEGOS_RUN_SECRET)).status).toBe(200);
    await post(`/api/fixes/${queue.id}/cancel`);
  });
});
