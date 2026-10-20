import { useState } from 'react';
import { api, type Me } from '../api.ts';

const CLAIM_EVERY_MS = 1500;
const CLAIM_FOR_MS = 10 * 60_000;

// Local users (name + PIN) on this machine, and people an outside provider vouches for.
export function SignIn({ me, error, onDone }: { me: Me | null; error?: string; onDone: () => void }) {
  const names = me?.users ?? [];
  // sign-in first; only straight to create when there's nothing to sign in with
  const providers = me?.providers ?? [];
  const canSignIn = names.length > 0 || providers.length > 0;
  const [creating, setCreating] = useState(!canSignIn && !!me?.pin);
  const [flip, setFlip] = useState<'out' | 'in' | null>(null);
  const [name, setName] = useState(names[0] ?? '');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [shakes, setShakes] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);
  const fail = (msg: string) => (setErr(msg), setShakes((n) => n + 1));
  // let the card fly off before the app replaces it
  const finish = () => (setLeaving(true), setTimeout(onDone, 300));
  const mode = (create: boolean) => {
    setCreating(create);
    setName(create ? '' : (names[0] ?? ''));
    setPin('');
    setPin2('');
    setErr(null);
    setShakes(0);
  };
  // half-turn out, swap the face, half-turn back in; reduced motion fires no animationend, so swap at once
  const turn = () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return mode(!creating);
    setShakes(0);
    setFlip('out');
  };
  const onCardAnimationEnd = (e: React.AnimationEvent) => {
    if (e.target !== e.currentTarget || e.animationName !== 'flip-out') return;
    mode(!creating);
    setFlip('in');
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating && pin !== pin2) return fail("PINs don't match");
    setBusy(true);
    setErr(null);
    try {
      await (creating ? api.createUser(name.trim(), pin) : api.login(name, pin));
      finish();
    } catch (e: any) {
      fail(e.message);
      setPin('');
      setPin2('');
    } finally {
      setBusy(false);
    }
  };
  // The link may open in the system browser (desktop pane), which keeps its own cookie: poll for ours.
  const provider = async (id: string, label: string) => {
    setErr(null);
    const attempt = crypto.randomUUID();
    const tab = window.open('', '_blank');
    try {
      const { url } = await api.providerSignIn(id, attempt);
      if (tab) tab.location.href = url;
      else window.open(url, '_blank');
    } catch (e: any) {
      tab?.close();
      return fail(e.message);
    }
    setWaiting(true);
    const until = Date.now() + CLAIM_FOR_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, CLAIM_EVERY_MS));
      const ok = await api.claim(attempt).then(
        (r) => r.ok,
        () => false,
      );
      // finished in this same browser: the callback already set our cookie
      const here = ok || (await api.me().then((m) => m.authenticated, () => false));
      if (here) return finish();
    }
    setWaiting(false);
    fail(`Sign-in with ${label} timed out — try again.`);
  };
  const ready = pin.length === 6 && name.trim() && (!creating || pin2.length === 6);
  return (
    <div className="signin">
      <div className="signin-belt" aria-hidden="true">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i} className="belt-brick" style={{ '--i': i } as React.CSSProperties} />
        ))}
      </div>
      <form
        className={`signin-card${flip ? ` flip-${flip}` : ''}${shakes ? ` shake-${shakes % 2}` : ''}${leaving ? ' leaving' : ''}${busy ? ' busy' : ''}`}
        onSubmit={submit}
        onAnimationEnd={onCardAnimationEnd}
      >
        <div className="signin-logo" aria-hidden="true">
          <span className="brick b3" />
          <span className="brick b2" />
          <span className="brick b1" />
        </div>
        <h1>
          legos<span> / factory</span>
        </h1>
        <p className="lead" key={creating ? 'c' : 'u'}>
          {creating ? 'Create a local user on this machine.' : 'Sign in to mission control for your coding agents.'}
        </p>
        {error ? (
          <button type="button" className="btn primary signin-btn" onClick={onDone}>
            Try again
          </button>
        ) : waiting ? (
          <div className="signin-waiting">
            <span className="signin-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <p className="signin-note">Finish signing in in the window that opened. This page continues on its own.</p>
          </div>
        ) : creating ? (
          <div className="signin-body" key="create">
            <label className="field signin-field">
              Your name
              <input className="input" autoFocus value={name} maxLength={64} autoComplete="name" onChange={(e) => setName(e.target.value)} />
            </label>
            <PinField label="Choose a 6-digit PIN" value={pin} autoComplete="new-password" onChange={(v) => setPin(digits(v))} />
            <PinField label="Repeat PIN" value={pin2} autoComplete="new-password" onChange={(v) => setPin2(digits(v))} />
            <button className="btn primary signin-btn" disabled={!ready || busy}>
              {busy ? 'Checking…' : 'Create user'}
            </button>
            {canSignIn && (
              <button type="button" className="btn ghost signin-switch" onClick={turn}>
                Back to sign in
              </button>
            )}
            <p className="signin-note">Local users stay on this machine and can still connect workbench or other MCP servers in Settings.</p>
          </div>
        ) : (
          <div className="signin-body" key="unlock">
            {names.length > 0 && (
              <>
                <label className="field signin-field">
                  User
                  <select className="input" value={name} onChange={(e) => setName(e.target.value)}>
                    {names.map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <PinField label="PIN" value={pin} autoComplete="current-password" autoFocus onChange={(v) => setPin(digits(v))} />
                <button className="btn primary signin-btn" disabled={!ready || busy}>
                  {busy ? 'Checking…' : 'Unlock'}
                </button>
              </>
            )}
            {providers.map((p, i) => (
              <div key={p.id} className="signin-body">
                {(names.length > 0 || i > 0) && <div className="signin-or">or</div>}
                <button type="button" className={`btn signin-btn${names.length || i ? '' : ' primary'}`} onClick={() => provider(p.id, p.label)}>
                  Sign in with {p.label}
                </button>
              </div>
            ))}
            {!canSignIn && !me?.pin && <p className="signin-note">No sign-in method is set up for this address. Ask whoever runs this app.</p>}
            {me?.pin && (
              <button type="button" className="btn ghost signin-switch" onClick={turn}>
                Create a new user
              </button>
            )}
            <p className="signin-note">Each person works in their own workspace and in the teams they were added to.</p>
          </div>
        )}
        {(err || error) && (
          <p className="error signin-error" role="alert" key={err ?? error}>
            {err ?? error}
          </p>
        )}
      </form>
    </div>
  );
}

// The real input stays on top (transparent) so typing, paste and password managers work as usual.
function PinField({ label, value, autoComplete, autoFocus, onChange }: { label: string; value: string; autoComplete: string; autoFocus?: boolean; onChange: (v: string) => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <label className="field signin-field">
      {label}
      <span className={`pin-cells${focused ? ' focused' : ''}`}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`pin-cell${i < value.length ? ' filled' : ''}${focused && i === Math.min(value.length, 5) ? ' current' : ''}`} />
        ))}
        <input
          className="pin-overlay"
          type="password"
          inputMode="numeric"
          maxLength={6}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </label>
  );
}
