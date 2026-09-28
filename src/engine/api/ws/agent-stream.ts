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

export class StreamRegistry {
  private readonly streams = new Map<string, SessionStream>();

  get(sessionId: string): SessionStream {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = new SessionStream(sessionId);
      this.streams.set(sessionId, stream);
    }
    return stream;
  }
}
