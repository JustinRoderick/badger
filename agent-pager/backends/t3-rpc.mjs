// Minimal client for T3 Code's WebSocket RPC (Effect RPC, JSON frames).
//
//   -> {_tag:"Request", id, tag, payload, headers:[]}
//   <- {_tag:"Chunk", requestId, values[]}   (stream item; must be Acked)
//   <- {_tag:"Exit", requestId, exit:{_tag:"Success"|"Failure", ...}}
//
// The socket authenticates with a short-lived ticket swapped for the bearer
// token, and reconnects with backoff. Streams are re-opened after a reconnect.

const PING_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const PROTOCOL = "2";

export class T3Rpc {
  constructor({ origin, token, log = console.log }) {
    this.origin = origin.replace(/\/$/, "");
    this.token = token;
    this.log = log;
    this.nextId = 1;
    this.calls = new Map();
    this.streams = new Map();
    this.socket = null;
    this.closed = false;
    this.backoff = 1000;
    this.onConnect = () => {};
  }

  headers(extra = {}) {
    return { authorization: `Bearer ${this.token}`, "x-t3-orchestration-protocol": PROTOCOL, ...extra };
  }

  async getJson(path) {
    const response = await fetch(this.origin + path, { headers: this.headers() });
    if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
    return response.json();
  }

  async connect() {
    const response = await fetch(`${this.origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: this.headers(),
    });
    if (response.status === 401) throw new Error("T3 rejected the token (expired or revoked?)");
    if (!response.ok) throw new Error(`websocket-ticket -> HTTP ${response.status}`);
    const { ticket } = await response.json();
    const url = new URL("/ws", this.origin.replace(/^http/, "ws"));
    url.searchParams.set("orchestrationProtocol", PROTOCOL);
    url.searchParams.set("wsTicket", ticket);

    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`Could not connect to ${this.origin}`)), { once: true });
    });
    this.socket = socket;
    this.backoff = 1000;
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("close", () => this.dropped());
    this.pinger = setInterval(() => this.send({ _tag: "Ping" }), PING_MS);
    this.log(`[t3] connected to ${this.origin}`);
    for (const stream of this.streams.values()) this.open(stream);
    this.onConnect();
  }

  async start() {
    while (!this.closed) {
      try {
        await this.connect();
        return;
      } catch (error) {
        this.log(`[t3] ${error.message}; retrying in ${this.backoff / 1000}s`);
        await new Promise((r) => setTimeout(r, this.backoff));
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  dropped() {
    clearInterval(this.pinger);
    this.socket = null;
    for (const { reject } of this.calls.values()) reject(new Error("T3 connection lost"));
    this.calls.clear();
    if (!this.closed) {
      this.log("[t3] connection lost; reconnecting");
      setTimeout(() => this.start(), this.backoff);
    }
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(message) {
    if (this.connected) this.socket.send(JSON.stringify(message));
  }

  receive(raw) {
    for (const message of [].concat(JSON.parse(raw))) {
      const id = message.requestId;
      if (message._tag === "Chunk") {
        this.send({ _tag: "Ack", requestId: id });
        const stream = [...this.streams.values()].find((s) => s.requestId === id);
        for (const value of message.values) stream?.onValue(value);
      } else if (message._tag === "Exit") {
        const call = this.calls.get(id);
        this.calls.delete(id);
        if (call) {
          if (message.exit._tag === "Success") call.resolve(message.exit.value);
          else call.reject(new Error(failureMessage(message.exit)));
        }
        const stream = [...this.streams.values()].find((s) => s.requestId === id);
        if (stream && !this.closed) {
          this.log(`[t3] stream ${stream.tag} ended; reopening`);
          setTimeout(() => this.open(stream), 1000);
        }
      } else if (message._tag === "Defect") {
        this.log(`[t3] defect: ${JSON.stringify(message).slice(0, 300)}`);
      }
    }
  }

  request(tag, payload) {
    if (!this.connected) return Promise.reject(new Error("Not connected to T3"));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  subscribe(tag, payload, onValue) {
    const stream = { tag, payload, onValue, requestId: null };
    this.streams.set(tag, stream);
    if (this.connected) this.open(stream);
  }

  open(stream) {
    stream.requestId = String(this.nextId++);
    this.send({ _tag: "Request", id: stream.requestId, tag: stream.tag, payload: stream.payload, headers: [] });
  }

  close() {
    this.closed = true;
    clearInterval(this.pinger);
    this.socket?.close();
  }
}

function failureMessage(exit) {
  const cause = [].concat(exit.cause ?? [])[0];
  const error = cause?.error ?? cause?.defect ?? cause;
  return error?.message ?? error?.reason ?? JSON.stringify(error ?? exit).slice(0, 200);
}
