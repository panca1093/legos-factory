import { isAbsolute } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { DecisionAnswer, PendingDecision, SessionSummary, Settings, StreamMessage } from '../../shared/types.ts';
import { getSession, listSessions } from '../claude-sessions.ts';
import { gitBranch, loadSettings, saveAutomation, settingsPath, shareFor } from '../policy.ts';
import { HttpError, parse, readBody, text, type Deps, type Env } from '../http.ts';
import { isOwner } from '../owners.ts';
import { MODEL_RE, launchRun, launchSchema } from '../launch-run.ts';

const annotate = <T extends SessionSummary>(s: T, settings: Settings, tickets: Map<string, string>): T => ({
  ...s,
  ticket: tickets.get(s.id) ?? null,
  share: shareFor(s.cwd, settings),
});

const textSchema = z.object({ text: text() });
const requiredText = z.object({ text: text().refine((t) => !!t, 'text is required') });
const modelSchema = z.object({ model: text().refine((m) => MODEL_RE.test(m), 'invalid model') });
const decisionSchema = z.object({
  behavior: z.enum(['allow', 'deny'], { error: 'behavior must be allow or deny' }),
  answers: z.custom<Record<string, string>>().optional(),
  message: z.custom<string>().optional(),
  remember: z.boolean().optional(),
});

export function runsRoutes(deps: Deps) {
  const { runs, activity, ownsRun, users } = deps;
  const routes = new Hono<Env>();
  const decisionById = (id: string): PendingDecision | undefined => {
    const snap = runs.snapshot();
    return snap.type === 'snapshot' ? snap.decisions.find((d) => d.id === id) : undefined;
  };

  // Other users' runs and decisions look like they don't exist.
  routes.use('/api/runs/:id/*', async (c, next) => {
    const r = runs.get(c.req.param('id'));
    if (r && r.owner !== c.get('uid')) return c.json({ error: 'run not found' }, 404);
    await next();
  });
  routes.use('/api/decisions/:id/*', async (c, next) => {
    const d = decisionById(c.req.param('id'));
    if (d && !ownsRun(c.get('uid'), d.runId)) return c.json({ error: 'decision no longer open' }, 410);
    await next();
  });

  routes.get('/api/sessions', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 1000);
    const active = runs.activeRunBySession();
    const [list, settings] = await Promise.all([listSessions(activity.sessionIds(c.get('uid'), limit)), loadSettings()]);
    const tickets = activity.sessionTickets(c.get('uid'));
    return c.json(list.map((s) => ({ ...annotate(s, settings, tickets), activeRunId: active.get(s.id) ?? null })));
  });

  routes.get('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const s = activity.ownsSession(c.get('uid'), id) ? await getSession(id) : null;
    if (!s) throw new HttpError(404, 'session not found');
    return c.json({ ...annotate(s, await loadSettings(), activity.sessionTickets(c.get('uid'))), activeRunId: runs.activeRunBySession().get(s.id) ?? null });
  });

  routes.get('/api/runs/:id', (c) => {
    const r = runs.get(c.req.param('id'));
    if (!r || r.owner !== c.get('uid')) throw new HttpError(404, 'run not found');
    return c.json(r);
  });

  routes.post('/api/runs', async (c) => {
    const req = parse(launchSchema, await readBody(c));
    return c.json(await launchRun(deps, c.get('uid'), req), 201);
  });

  routes.post('/api/runs/:id/messages', async (c) => {
    const { text } = parse(requiredText, await readBody(c));
    if (!runs.send(c.req.param('id'), text)) throw new HttpError(409, 'session has ended or is a task (tasks take no follow-ups)');
    return c.json({ ok: true });
  });

  routes.post('/api/runs/:id/model', async (c) => {
    const { model } = parse(modelSchema, await readBody(c));
    if (!(await runs.setModel(c.req.param('id'), model))) throw new HttpError(409, 'session has ended');
    return c.json({ ok: true });
  });

  routes.post('/api/runs/:id/interrupt', async (c) => {
    if (!(await runs.interrupt(c.req.param('id')))) throw new HttpError(409, 'no turn in progress');
    return c.json({ ok: true });
  });

  routes.post('/api/runs/:id/end', async (c) => {
    if (!(await runs.end(c.req.param('id')))) throw new HttpError(409, 'session already ended');
    return c.json({ ok: true });
  });

  routes.post('/api/runs/:id/resume-task', async (c) => {
    const { text } = parse(textSchema, await readBody(c));
    if (!runs.resumeTask(c.req.param('id'), text)) throw new HttpError(409, 'only an idle chat that started as a task can resume it');
    return c.json({ ok: true });
  });

  routes.post('/api/decisions/:id', async (c) => {
    const b = parse(decisionSchema, await readBody(c));
    const decision = decisionById(c.req.param('id'));
    if (b.remember && b.behavior === 'allow' && decision?.toolName === 'Bash' && (!users || isOwner(users.get(c.get('uid'))))) {
      const command = decision.input.command;
      if (typeof command === 'string' && command.trim()) {
        const prefix = command.trim().split(/\s+/).slice(0, 2).join(' ');
        const { automation } = await loadSettings();
        await saveAutomation({ ...automation, allowlist: [...automation.allowlist, prefix] });
      }
    }
    const answer: DecisionAnswer = b.behavior === 'allow' ? { behavior: 'allow', answers: b.answers } : { behavior: 'deny', message: b.message };
    // 410: expired, withdrawn, or answered elsewhere — the UI must drop it, not retry
    if (!runs.decide(c.req.param('id'), answer)) throw new HttpError(410, 'decision no longer open');
    return c.json({ ok: true });
  });

  routes.post('/api/decisions/:id/discuss', async (c) => {
    const { text } = parse(requiredText, await readBody(c));
    const runId = runs.discuss(c.req.param('id'), text);
    if (!runId) throw new HttpError(410, 'decision no longer open');
    return c.json({ runId });
  });

  routes.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const uid = c.get('uid');
      const mine = (m: StreamMessage) =>
        m.type === 'run' ? m.run.owner === uid
        : m.type === 'run_event' ? ownsRun(uid, m.runId)
        : m.type === 'decision' ? ownsRun(uid, m.decision.runId)
        : true; // decision_closed carries only an id
      const send = (m: StreamMessage) => void (mine(m) && stream.writeSSE({ data: JSON.stringify(m) }));
      const snap = runs.snapshot();
      if (snap.type === 'snapshot')
        send({ ...snap, runs: snap.runs.filter((r) => r.owner === uid), decisions: snap.decisions.filter((d) => ownsRun(uid, d.runId)) });
      runs.on('message', send);
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 15000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      runs.off('message', send);
    }),
  );

  routes.get('/api/settings', async (c) => c.json({ path: settingsPath(), ...(await loadSettings()) }));

  // What a new run in this folder would get, so the launch dialog can prefill it.
  routes.get('/api/policy', async (c) => {
    const cwd = (c.req.query('cwd') ?? '').trim();
    if (!isAbsolute(cwd)) throw new HttpError(400, 'cwd must be absolute');
    const settings = await loadSettings();
    const branch = await gitBranch(cwd);
    return c.json({ share: shareFor(cwd, settings), branch });
  });

  routes.get('/api/models', async (c) => {
    const models = await runs.models().catch((err) => {
      throw new HttpError(502, `could not list models: ${err instanceof Error ? err.message : err}`);
    });
    return c.json(models);
  });

  return routes;
}
