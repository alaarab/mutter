// Typing indicator. Mumble has no such thing, so it is our own extension over the same
// PluginDataTransmission side channel the screen share signals on: one byte of state, plus the
// channel id when the composer is aimed at a channel. See docs/extensions.md; iOS can mirror it.

const DATA_ID = 'mutter/typing';
const REPEAT_MS = 3000;        // a start goes out at most this often while typing continues
const IDLE_MS = 5000;          // no input for this long → stop
const EXPIRE_MS = 6000;        // receiver forgets a typer it hasn't heard a start from; > REPEAT_MS with slack

export class TypingIndicator extends EventTarget {
  constructor(client) {
    super();
    this.client = client;
    this.typing = new Map();     // sender session → { scope, at } — others typing, as far as we know
    this._out = null;            // our own outstanding start: { scope, sent: Set<session>, at }
    this._idle = null;
    client.addEventListener('plugin', e => this._onPlugin(e.detail));
    client.addEventListener('users', () => this._onUsers());
    client.addEventListener('state', () => { if (client.state !== 'connected') this._reset(); });
    setInterval(() => this._expire(), 1000);
  }

  /// Call on every input event while the user composes. `scope` is client.sendText's:
  /// { channelId } or { treeId } for a channel, { sessions: [s] } for a DM.
  noteTyping(scope) {
    const s = normalize(scope, this.client);
    if (this._out && !sameScope(this._out.scope, s)) this._stop();
    if (!this._out || Date.now() - this._out.at >= REPEAT_MS) this._start(s);
    clearTimeout(this._idle);
    this._idle = setTimeout(() => this.stopped(), IDLE_MS);
  }

  /// The composer was sent or cleared. Withdraws our start, if one went out.
  stopped() {
    clearTimeout(this._idle);
    this._idle = null;
    this._stop();
  }

  /// Names of the people typing in a scope: a channel id, { channelId } / { treeId }, or
  /// { sessions: [s] } for a DM from those people to me (no argument: any DM to me).
  who(scope) {
    const f = typeof scope === 'number' ? { channelId: scope } : scope ?? {};
    const channelId = f.channelId ?? f.treeId;
    const dm = !!f.sessions || channelId === undefined;
    const out = [];
    for (const [session, t] of this.typing) {
      const match = dm ? !!t.scope.sessions && (!f.sessions || f.sessions.includes(session))
        : !t.scope.sessions && t.scope.channelId === channelId;
      if (match) out.push(this.client.users.get(session)?.name ?? String(session));
    }
    return out.sort();
  }

  // ---- sending ----

  _start(scope) {
    const receivers = this._receivers(scope);
    // The server delivers to nobody when the list is empty; don't bother it.
    if (!receivers.length || !this.client.sendPlugin(receivers, DATA_ID, encode(1, scope))) return;
    const sent = this._out?.sent ?? new Set();
    for (const r of receivers) sent.add(r);
    this._out = { scope, sent, at: Date.now() };
  }

  _stop() {
    const out = this._out;
    if (!out) return;
    this._out = null;
    const receivers = [...out.sent].filter(s => this.client.users.has(s));
    if (receivers.length) this.client.sendPlugin(receivers, DATA_ID, encode(0, out.scope));
  }

  _receivers(scope) {
    if (scope.sessions) return this.client.users.has(scope.sessions[0]) ? [scope.sessions[0]] : [];
    return this.client.usersIn(scope.channelId).filter(u => u.session !== this.client.me).map(u => u.session);
  }

  // ---- receiving ----

  _onPlugin({ sender, dataId, data }) {
    if (dataId !== DATA_ID || !data?.length || sender === this.client.me) return;
    const scope = data.length >= 5
      ? { channelId: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, false) }
      : { sessions: [this.client.me] };
    if (data[0] === 1) {
      const prev = this.typing.get(sender);
      this.typing.set(sender, { scope, at: Date.now() });
      if (!prev || !sameScope(prev.scope, scope)) this._emit();
    } else if (this.typing.delete(sender)) this._emit();
  }

  _onUsers() {
    let changed = false;
    for (const s of [...this.typing.keys()]) if (!this.client.users.has(s)) { this.typing.delete(s); changed = true; }
    if (changed) this._emit();
  }

  _expire() {
    const now = Date.now();
    let changed = false;
    for (const [s, t] of this.typing) if (now - t.at > EXPIRE_MS) { this.typing.delete(s); changed = true; }
    if (changed) this._emit();
  }

  _reset() {
    clearTimeout(this._idle);
    this._idle = null;
    this._out = null;                      // nothing to withdraw: the socket is gone
    const had = this.typing.size;
    this.typing.clear();
    if (had) this._emit();
  }

  _emit() { this.dispatchEvent(new CustomEvent('change')); }
}

const normalize = (scope = {}, client) => scope.sessions?.length
  ? { sessions: [scope.sessions[0]] }
  : { channelId: scope.channelId ?? scope.treeId ?? client.myUser?.channelId ?? 0 };

const sameScope = (a, b) => a.sessions ? b.sessions?.[0] === a.sessions[0] : !b.sessions && a.channelId === b.channelId;

const encode = (state, scope) => {
  if (scope.sessions) return Uint8Array.of(state);
  const b = new Uint8Array(5);
  b[0] = state;
  new DataView(b.buffer).setUint32(1, scope.channelId, false);
  return b;
};
