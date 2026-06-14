/**
 * Swappable event sink. Adapters POST normalized BirdyBeep events to `sink.url`;
 * the harness reads them back via `sink.received()` for contract assertions.
 *
 * `StubEventSink` is a local in-process HTTP server used today. The
 * {@link EventSink} interface is the seam: the SAME harness can later point at
 * the product's real `POST /v1/agent-events` running under `wrangler dev` (the
 * eventual cross-repo E2E) by injecting a remote sink — nothing here is
 * hard-wired to the stub. See {@link createEventSink}.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** The canonical ingestion path the product backend exposes (§13.4). */
export const AGENT_EVENTS_PATH = "/v1/agent-events";

/** One captured inbound request. `body` is intentionally `unknown` — callers narrow it. */
export interface DeliveredEvent {
  /** Parsed JSON body (or the raw string if it was not valid JSON). */
  readonly body: unknown;
  /** Lowercased request headers (e.g. `authorization`). */
  readonly headers: Readonly<Record<string, string>>;
  /** Request path, e.g. `/v1/agent-events`. */
  readonly path: string;
  /** Wall-clock receipt time (ms since epoch). */
  readonly receivedAt: number;
}

export interface EventSink {
  /** Base URL adapters POST to, no trailing slash (e.g. `http://127.0.0.1:53121`). */
  readonly url: string;
  /** Every request captured so far, in arrival order. */
  received(): DeliveredEvent[];
  /** Drop all captured requests. */
  reset(): void;
  /** Release resources (stop the server / close connections). */
  close(): Promise<void>;
}

function lowercaseHeaders(msg: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(msg.headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

async function readBody(msg: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of msg) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A local HTTP server that records inbound POSTs for assertion. */
export class StubEventSink implements EventSink {
  readonly url: string;
  #server: Server;
  #events: DeliveredEvent[] = [];

  private constructor(server: Server, url: string) {
    this.#server = server;
    this.url = url;
  }

  /** Start a stub sink listening on an ephemeral loopback port. */
  static async start(): Promise<StubEventSink> {
    const events: DeliveredEvent[] = [];
    const server = createServer((req, res) => {
      void (async () => {
        const raw = await readBody(req);
        let body: unknown = raw;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw; // keep the raw string so assertions can still inspect it
          }
        }
        events.push({
          body,
          headers: lowercaseHeaders(req),
          path: req.url ?? "",
          receivedAt: Date.now(),
        });
        res.statusCode = 202;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ accepted: true }));
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const sink = new StubEventSink(server, `http://127.0.0.1:${address.port}`);
    sink.#events = events;
    return sink;
  }

  received(): DeliveredEvent[] {
    return [...this.#events];
  }

  reset(): void {
    this.#events.length = 0;
  }

  close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

/**
 * Resolve the harness event sink. Today this is always a fresh in-process
 * {@link StubEventSink}.
 *
 * The cross-repo E2E seam is the {@link EventSink} interface itself, not a flag
 * here: every harness helper depends only on `EventSink`, so the product test
 * setup can implement `EventSink` against the real `POST /v1/agent-events`
 * running under `wrangler dev` (its `received()` reads the backend's delivered
 * events back) and inject it wherever a sink is accepted. The stub is therefore
 * never hard-wired — but this package ships no fake remote, only the real stub.
 */
export function createEventSink(): Promise<EventSink> {
  return StubEventSink.start();
}
