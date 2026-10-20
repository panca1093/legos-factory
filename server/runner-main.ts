import { RunManager } from './claude-runs.ts';
import type { Job } from './protocol.ts';
import { Runner, httpTransport } from './runner.ts';
import { workspacesDir } from './workspace.ts';

// A standalone runner: pulls jobs from a control plane and runs them with this machine's own Claude login.

const control = process.env.LEGOS_CONTROL_URL?.replace(/\/$/, '');
const token = process.env.LEGOS_RUNNER_TOKEN;
if (!control || !token) {
  console.error('set LEGOS_CONTROL_URL (the control plane, e.g. https://factory.example.com) and LEGOS_RUNNER_TOKEN (Settings → Runners)');
  process.exit(1);
}

// a repo run's git credentials come from the control plane, per run, through the same endpoint the clone's helper uses
async function credential(job: Job): Promise<string> {
  const { LEGOS_URL, LEGOS_RUN_SECRET } = job.request.env ?? {};
  if (!LEGOS_URL || !LEGOS_RUN_SECRET) throw new Error('the control plane sent no git credentials for this run');
  const res = await fetch(`${LEGOS_URL}/git/credential`, { headers: { 'x-legos-run': LEGOS_RUN_SECRET } });
  if (!res.ok) throw new Error(`git credentials unavailable (HTTP ${res.status})`);
  const password = (await res.text()).match(/^password=(.+)$/m)?.[1];
  if (!password) throw new Error('the control plane sent no git token');
  return password;
}

const runner = new Runner({
  transport: httpTransport(control, token),
  manager: new RunManager(),
  wsRoot: workspacesDir(),
  gitUrl: process.env.LEGOS_GIT_URL,
  credential,
  onFatal: (err) => {
    console.error(err.message);
    process.exit(1);
  },
});
runner.start();
console.log(`legos-factory runner pulling from ${control}`);
