import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { ActivityLog } from './activity.ts';
import { createApp } from './app.ts';
import { Account } from './account.ts';
import { RunManager } from './claude-runs.ts';
import { Connections } from './connections.ts';
import { createHub } from './hub.ts';
import { Workbench } from './workbench.ts';

const port = Number(process.env.LEGOS_API_PORT ?? 4317);
const selfUrl = `http://localhost:${port}`;

function startHub() {
  // Team hub only: no runs, no UI. Local for now; deploying it means binding beyond loopback behind TLS.
  const hubPort = Number(process.env.LEGOS_HUB_PORT ?? 4400);
  // the hub verifies who posts with the same workbench the laptops connect to in Settings
  const workbench = process.env.LEGOS_WORKBENCH_URL?.replace(/\/$/, '');
  if (!workbench) throw new Error('LEGOS_WORKBENCH_URL is required for the team hub (it verifies who posts)');
  serve({ fetch: createHub({ workbench: new Workbench(`${workbench}/mcp`) }).fetch, hostname: '127.0.0.1', port: hubPort }, () =>
    console.log(`legos-factory team hub on http://localhost:${hubPort}`),
  );
}

function startApp() {
  const runs = new RunManager();
  const account = process.env.LEGOS_AUTH === 'off' ? null : new Account();
  const hubUrl = process.env.LEGOS_HUB_URL?.replace(/\/$/, '') || null;
  const app = createApp(runs, {
    account,
    connections: new Connections({ callbackUrl: `${selfUrl}/auth/callback` }),
    selfUrl,
    activity: new ActivityLog(),
    hubUrl,
  });
  // warm the model list so the first picker open isn't waiting on a CLI spawn
  void runs.models().catch((err) => console.warn('model list unavailable:', err.message));

  if (process.env.NODE_ENV === 'production') {
    app.use('/*', serveStatic({ root: './dist' }));
    app.get('*', serveStatic({ path: './dist/index.html' }));
  }

  serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
    console.log(`legos-factory api on ${selfUrl} · PIN sign-in ${account ? 'on' : 'off (LEGOS_AUTH=off)'} · team hub ${hubUrl ?? 'off'}`);
  });
}

if (process.env.LEGOS_MODE === 'hub') startHub();
else startApp();
