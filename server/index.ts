import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { ActivityLog } from './activity.ts';
import { createApp } from './app.ts';
import { Auth } from './auth.ts';
import { RunManager } from './claude-runs.ts';
import { createHub } from './hub.ts';
import { Workbench } from './workbench.ts';

const port = Number(process.env.LEGOS_API_PORT ?? 4317);
const selfUrl = `http://localhost:${port}`;
// e.g. https://workbench.example.com — set in .env.local; without it sign-in and workbench features are off
const workbench = process.env.LEGOS_WORKBENCH_URL?.replace(/\/$/, '') || null;
const workbenchMcpUrl = workbench ? `${workbench}/mcp` : '';
const ssoName = process.env.LEGOS_SSO_NAME || 'workbench';

function startHub() {
  // Team hub only: no runs, no UI. Local for now; deploying it means binding beyond loopback behind TLS.
  const hubPort = Number(process.env.LEGOS_HUB_PORT ?? 4400);
  if (!workbench) throw new Error('LEGOS_WORKBENCH_URL is required for the team hub (it verifies who posts)');
  serve({ fetch: createHub({ workbench: new Workbench(workbenchMcpUrl) }).fetch, hostname: '127.0.0.1', port: hubPort }, () =>
    console.log(`legos-factory team hub on http://localhost:${hubPort}`),
  );
}

function startApp() {
  const runs = new RunManager();
  const auth =
    process.env.LEGOS_AUTH === 'off' || !workbench
      ? null
      : new Auth({ issuer: workbench, resource: workbenchMcpUrl, callbackUrl: `${selfUrl}/auth/callback` });
  const hubUrl = process.env.LEGOS_HUB_URL?.replace(/\/$/, '') || null;
  const app = createApp(runs, {
    auth,
    workbench: auth ? new Workbench(workbenchMcpUrl) : null,
    workbenchMcpUrl,
    workbenchUrl: workbench,
    ssoName,
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
    console.log(`legos-factory api on ${selfUrl} · sign-in ${auth ? `via ${workbench}` : workbench ? 'disabled (LEGOS_AUTH=off)' : 'off (set LEGOS_WORKBENCH_URL)'} · team hub ${hubUrl ?? 'off'}`);
  });
}

if (process.env.LEGOS_MODE === 'hub') startHub();
else startApp();
