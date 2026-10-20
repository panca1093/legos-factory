// Minimal MCP client for workbench, always called with the signed-in user's own token.
// Workbench is a gateway: integrations' tools are reached through its execute_tools meta-tool.

export type Integration = { name: string; version: string | null; connected: boolean };

const PROTOCOL = '2025-06-18';

const BUSY = new Set([502, 503, 504]);

export class Workbench {
  // MCP session per token; tokens rotate hourly so this stays small
  private sessions = new Map<string, string>();

  constructor(
    private mcpUrl: string,
    private http: typeof fetch = fetch,
    private retryDelayMs = 500,
  ) {}

  private async post(token: string, body: object, session: string | null) {
    for (let attempt = 0; ; attempt++) {
      const out = await this.postOnce(token, body, session);
      if (!BUSY.has(out.res.status) || attempt === 2) return out;
      await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
    }
  }

  private async postOnce(token: string, body: object, session: string | null) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (session) Object.assign(headers, { 'mcp-session-id': session, 'mcp-protocol-version': PROTOCOL });
    const res = await this.http(this.mcpUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const raw = await res.text();
    if (!res.ok) return { res, msg: null };
    // Streamable HTTP may answer as an SSE stream of data: lines. Decide by the shape, not by "data:" appearing
    // somewhere: a plain JSON answer can carry that text (e.g. a PR description).
    const sse = (res.headers.get('content-type') ?? '').includes('text/event-stream') || /^(event|data|id|:)/.test(raw.trimStart());
    const json = sse ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') : raw;
    try {
      return { res, msg: json.trim() ? JSON.parse(json) : null };
    } catch {
      throw new Error('workbench sent an unreadable response');
    }
  }

  private async session(token: string): Promise<string> {
    const hit = this.sessions.get(token);
    if (hit) return hit;
    const { res } = await this.post(
      token,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'legos-factory', version: '1' } } },
      null,
    );
    if (!res.ok) throw new Error(`workbench unavailable (HTTP ${res.status})`);
    const sid = res.headers.get('mcp-session-id') ?? '';
    await this.post(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    this.sessions.set(token, sid);
    return sid;
  }

  // Calls a workbench tool and returns its parsed JSON text result.
  async call(token: string, name: string, args: object = {}, retried = false): Promise<any> {
    const sid = await this.session(token);
    const { res, msg } = await this.post(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, sid);
    if ((res.status === 404 || res.status === 400) && !retried) {
      // expired MCP session: start a new one once
      this.sessions.delete(token);
      return this.call(token, name, args, true);
    }
    if (!res.ok) throw new Error(`workbench ${name} failed (HTTP ${res.status})`);
    if (msg?.error) throw new Error(msg.error.message ?? `workbench ${name} failed`);
    const text = msg?.result?.content?.find((c: any) => c.type === 'text')?.text;
    if (msg?.result?.isError) throw new Error(text ?? `workbench ${name} failed`);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }

  // Runs one integration tool through execute_tools; `salvage` rescues an answer workbench cut off at ~60k chars.
  async execute(token: string, tool: string, args: object, salvage?: (raw: string) => unknown): Promise<any> {
    const out = await this.call(token, 'execute_tools', { executions: [{ tool, args }] });
    if (typeof out === 'string') {
      const rescued = salvage?.(out);
      if (rescued) return rescued;
      throw new Error(`${tool} answer was too large and got cut off by workbench`);
    }
    const first = out?.results?.[0];
    if (!first) throw new Error(`${tool} returned nothing`);
    // e.g. { error: 'NOT_CONNECTED', message: 'github not connected. Use connect(...)' }
    if (first.error) throw new Error(first.message ?? (typeof first.error === 'string' ? first.error : (first.error.message ?? `${tool} failed`)));
    return first.result;
  }

  async whoami(token: string): Promise<{ id: string | null; email: string | null; name: string | null } | null> {
    const me = await this.call(token, 'whoami');
    return me && (me.id || me.email) ? { id: me.id ?? null, email: me.email ?? null, name: me.name ?? null } : null;
  }

  async integrations(token: string): Promise<Integration[]> {
    const out = await this.call(token, 'list_integrations');
    return (out?.integrations ?? []).map((i: any) => ({ name: String(i.name), version: i.version ?? null, connected: i.connected === true }));
  }

  // Returns the workbench URL the user opens to authorise the integration.
  async connect(token: string, integration: string): Promise<{ url: string | null; connectionId: string | null }> {
    const out = await this.call(token, 'connect', { integration });
    const url = out?.url ?? out?.authUrl ?? out?.connectUrl ?? (typeof out === 'string' ? out.match(/https?:\/\/\S+/)?.[0] : null);
    return { url: url ?? null, connectionId: out?.connectionId ?? null };
  }
}
