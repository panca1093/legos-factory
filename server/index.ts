import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { buildDeps, createApp } from './app.ts';
import { RunManager } from './claude-runs.ts';
import { openDb } from './db.ts';
import { startSyncLoop } from './jira-sync.ts';
import { createHub } from './hub.ts';
import { Users } from './users.ts';
import { Workbench } from './workbench.ts';

const port = Number(process.env.LEGOS_API_PORT ?? 4317);
const selfUrl = `http://localhost:${port}`;

function startHub() {
  // Team hub only: no runs, no UI. Local for now; deploying it means binding beyond loopback behind TLS.
  const hubPort = Number(process.env.LEGOS_HUB_PORT ?? 4400);
  // the hub verifies who posts with the same workbench the laptops sign in with
  const workbench = process.env.LEGOS_WORKBENCH_URL?.replace(/\/$/, '');
  if (!workbench) throw new Error('LEGOS_WORKBENCH_URL is required for the team hub (it verifies who posts)');
  serve({ fetch: createHub({ workbench: new Workbench(`${workbench}/mcp`) }).fetch, hostname: '127.0.0.1', port: hubPort }, () =>
    console.log(`legos-factory team hub on http://localhost:${hubPort}`),
  );
}

async function startApp() {
  const runs = new RunManager();
  const db = openDb();
  const users = process.env.LEGOS_AUTH === 'off' ? null : new Users(db);
  const hubUrl = process.env.LEGOS_HUB_URL?.replace(/\/$/, '') || null;
  const wb = process.env.LEGOS_WORKBENCH_URL?.replace(/\/$/, '');
  // a bare workbench host means its MCP endpoint
  const workbenchUrl = wb ? (new URL(wb).pathname === '/' ? `${wb}/mcp` : wb) : null;
  const bitbucketWorkspace = process.env.LEGOS_BITBUCKET_WORKSPACE?.trim() || null;
  const publicUrl = process.env.LEGOS_PUBLIC_URL?.replace(/\/$/, '') || null;
  const embeddedRunner = process.env.LEGOS_RUNNER !== 'off';
  const leaseMs = Number(process.env.LEGOS_LEASE_MS) || undefined;
  const maxAttempts = Number(process.env.LEGOS_MAX_ATTEMPTS) || undefined;
  const opts = { users, db, selfUrl, publicUrl, embeddedRunner, leaseMs, maxAttempts, hubUrl, workbenchUrl, bitbucketWorkspace };
  const deps = buildDeps(runs, opts);
  const app = createApp(runs, opts, deps);
  startSyncLoop(deps, Number(process.env.LEGOS_SYNC_MS ?? 120_000));
  // warm the model list so the first picker open isn't waiting on a CLI spawn
  void runs.models().catch((err) => console.warn('model list unavailable:', err.message));

  if (process.env.NODE_ENV === 'production') {
    app.use('/*', serveStatic({ root: './dist' }));
    app.get('*', serveStatic({ path: './dist/index.html' }));
  }

  // loopback unless this is a team control plane that runners on other machines must reach (then put TLS in front)
  const hostname = process.env.LEGOS_BIND || '127.0.0.1';
  serve({ fetch: app.fetch, hostname, port }, () => {
    console.log(
      `legos-factory api on ${selfUrl} · sign-in ${users ? `PIN${workbenchUrl ? ' + workbench' : ''}` : 'off (LEGOS_AUTH=off)'} · team hub ${hubUrl ?? 'off'} · runner ${embeddedRunner ? 'embedded' : 'remote only'}`,
    );
  });
}

if (process.env.LEGOS_MODE === 'hub') startHub();
else await startApp();
