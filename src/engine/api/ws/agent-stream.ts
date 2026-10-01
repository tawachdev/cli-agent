import { createBunWebSocket } from "hono/bun";

export const { upgradeWebSocket, websocket } = createBunWebSocket();

export interface StreamEvent {
  v: 1;
  type: string;
  seq: number;
  ts: string;
  sessionId: string;
  payload: unknown;
}

const MAX_BUFFERED = 500;

export class SessionStream {
  private seq = 0;
  private readonly buffer: StreamEvent[] = [];
  private readonly subscribers = new Set<(event: StreamEvent) => void>();

  constructor(readonly sessionId: string) {}

  publish(type: string, payload: unknown): StreamEvent {
    const event: StreamEvent = {
      v: 1,
      type,
      seq: ++this.seq,
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      payload,
    };
    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFERED) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFERED);
    }
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
    return event;
  }

  subscribe(
    subscriber: (event: StreamEvent) => void,
    since = 0,
  ): () => void {
    for (const event of this.buffer) {
      if (event.seq > since) {
        subscriber(event);
      }
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }
}

const MAX_STREAMS = 200;

export class StreamRegistry {
  private readonly streams = new Map<string, SessionStream>();

  get(sessionId: string): SessionStream {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = new SessionStream(sessionId);
      this.streams.set(sessionId, stream);
      if (this.streams.size > MAX_STREAMS) {
        const oldest = this.streams.keys().next().value;
        if (oldest !== undefined && oldest !== sessionId) this.streams.delete(oldest);
      }
    }
    return stream;
  }

  delete(sessionId: string): void {
    this.streams.delete(sessionId);
  }
}
