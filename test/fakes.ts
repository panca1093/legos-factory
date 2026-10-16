import { createHash } from 'node:crypto';
import type { QueryFn } from '../server/claude-runs.ts';

export const WB = 'https://wb.test';
export const OTHER = 'https://tools.test';
export const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

// Fake workbench (its own authorization server) plus a generic MCP server that delegates auth to it.
// `exec` answers workbench execute_tools calls (one execution per call, like the app makes).
export function fakeServers(opts: { expiresIn?: number; exec?: (tool: string, args: any) => unknown | Promise<unknown>; whoami?: object } = {}) {
  const calls: { url: string; body?: string; auth: string | null; headers: Headers }[] = [];
  let n = 0;
  let lastChallenge = '';
  const fetchFn = (async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : init.body;
    const headers = new Headers(init.headers);
    calls.push({ url, body, auth: headers.get('authorization'), headers });
    if (url === `${OTHER}/.well-known/oauth-protected-resource/mcp`) return Response.json({ authorization_servers: [WB] });
    if (url === `${WB}/.well-known/oauth-authorization-server`)
      return Response.json({ authorization_endpoint: `${WB}/authorize`, token_endpoint: `${WB}/token`, registration_endpoint: `${WB}/register` });
    if (url === `${WB}/register`) return Response.json({ client_id: `client-${calls.filter((c) => c.url === `${WB}/register`).length}` });
    if (url === `${WB}/token`) {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        const ok = createHash('sha256').update(p.get('code_verifier')!).digest('base64url') === lastChallenge;
        if (!ok) return new Response('bad verifier', { status: 400 });
      }
      n++;
      return Response.json({ access_token: jwt({ sub: 'u1', n }), refresh_token: `r${n}`, expires_in: opts.expiresIn ?? 3600 });
    }
    if (url === `${WB}/mcp` || url === `${OTHER}/mcp`) {
      const msg = body ? JSON.parse(body) : {};
      if (msg.method === 'tools/call' && msg.params?.name === 'execute_tools' && opts.exec) {
        const ex = msg.params.arguments.executions[0];
        const text = JSON.stringify({ results: [{ result: await opts.exec(ex.tool, ex.args) }] });
        return Response.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } }, { headers: { 'mcp-session-id': 'm1' } });
      }
      if (msg.method === 'tools/call' && msg.params?.name === 'whoami')
        return Response.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(opts.whoami ?? { id: 'u1', email: 'who@acme.test' }) }] } });
      return new Response(JSON.stringify({ seen: headers.get('authorization'), key: headers.get('x-api-key') }), {
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'm1' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls, setChallenge: (c: string) => (lastChallenge = c) };
}

// stays alive until its input closes, like a real session; grants are revoked when a run ends
export const alive = (({ prompt }: any) => {
  const it = (async function* () {
    for await (const _ of prompt as AsyncIterable<unknown>);
  })() as any;
  it.interrupt = async () => {};
  return it;
}) as unknown as QueryFn;

