import {
  eventStreamPath,
  eventStreamsUrl,
  sharedStreamEventSchema,
} from "@ai-office/events/stream";

// The page's one connection for the live event stream. A browser opens at
// most six connections to a server over HTTP/1.1, and an open stream holds
// one for as long as it is open: the Office alone follows four or five
// filters, so with a chat's own stream, or another tab, the page's next
// request (a chat's message, say) waited for ever. Each stream the page
// opens is a stand-in here instead, and all of them are carried by one
// connection to the shared stream (`eventStreamsPath`), each resuming
// after its own last event. When the page opens or closes one, the
// connection is replaced by one carrying the new set, opened before the
// old one is closed so nothing is missed.

/** The part of the browser's EventSource used here. */
interface Source {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

const connecting = 0;
const open = 1;
const closed = 2;

/** How long a new connection may take to open before the old one goes. */
const handOverMs = 5000;

/** One of the page's streams: its filter, and the last event it was given. */
class Stream implements Source {
  readyState: number = connecting;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  /** Its filter, as the stream's query, without where to resume. */
  readonly query: URLSearchParams;
  last: number | undefined;
  private readonly hub: SharedEventStream;

  constructor(url: string, hub: SharedEventStream) {
    this.hub = hub;
    this.query = new URLSearchParams(url.split("?")[1] ?? "");
    const last = this.query.get("lastEventId");
    this.query.delete("lastEventId");
    this.last = last === null ? undefined : Number(last);
  }

  /** Its query on the shared stream, resuming after its last event. */
  resuming(): string {
    const query = new URLSearchParams(this.query);
    if (this.last !== undefined) {
      query.set("lastEventId", String(this.last));
    }
    return query.toString();
  }

  opened(): void {
    if (this.readyState === connecting) {
      this.readyState = open;
      this.onopen?.(new Event("open"));
    }
  }

  failed(gone: boolean): void {
    if (this.readyState === closed) {
      return;
    }
    this.readyState = gone ? closed : connecting;
    this.onerror?.(new Event("error"));
  }

  close(): void {
    if (this.readyState !== closed) {
      this.readyState = closed;
      this.hub.drop(this);
    }
  }
}

/** A connection to the shared stream, and the streams it carries, in order. */
interface Connection {
  readonly source: Source;
  readonly streams: readonly Stream[];
}

export class SharedEventStream {
  private readonly streams = new Set<Stream>();
  /** The connection the streams are given events by. */
  private current: Connection | undefined;
  /** A connection opening to replace it. */
  private next: Connection | undefined;
  private handOver: ReturnType<typeof setTimeout> | undefined;
  private scheduled = false;

  private readonly connect: (url: string) => Source;

  constructor(connect: (url: string) => Source) {
    this.connect = connect;
  }

  /** Whether `url` is the event stream's, which this carries. */
  static carries(url: string): boolean {
    return url === eventStreamPath || url.startsWith(`${eventStreamPath}?`);
  }

  /** A stand-in for the stream at `url`, carried by the shared connection. */
  open(url: string): Source {
    const stream = new Stream(url, this);
    this.streams.add(stream);
    this.schedule();
    return stream;
  }

  drop(stream: Stream): void {
    this.streams.delete(stream);
    this.schedule();
  }

  /** Reconnects once the page has opened and closed what it will now. */
  private schedule(): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.reconnect();
    });
  }

  private reconnect(): void {
    this.abandonNext();
    const streams = [...this.streams];
    if (streams.length === 0) {
      this.closeCurrent();
      return;
    }
    const source = this.connect(
      eventStreamsUrl(streams.map((stream) => stream.resuming())),
    );
    const connection: Connection = { source, streams };
    this.next = connection;
    source.onopen = () => {
      if (this.next === connection) {
        this.takeOver(connection);
      }
      for (const stream of connection.streams) {
        stream.opened();
      }
    };
    source.onmessage = (message) => {
      this.deliver(connection, message.data);
    };
    source.onerror = () => {
      // Closed: the server refused it, or the session ended. The page's
      // streams reconnect themselves; otherwise the browser does.
      const gone = source.readyState === closed;
      if (gone) {
        source.close();
        if (this.next === connection) {
          this.abandonNext();
        }
        if (this.current === connection) {
          this.current = undefined;
        }
      }
      for (const stream of connection.streams) {
        stream.failed(gone);
        if (gone) {
          this.streams.delete(stream);
        }
      }
    };
    // Should it never open, as when the browser is out of connections
    // while the old one is still open, the old one goes anyway.
    this.handOver = setTimeout(() => {
      if (this.next === connection) {
        this.takeOver(connection);
      }
    }, handOverMs);
  }

  private takeOver(connection: Connection): void {
    clearTimeout(this.handOver);
    this.closeCurrent();
    this.current = connection;
    this.next = undefined;
  }

  private abandonNext(): void {
    clearTimeout(this.handOver);
    this.next?.source.close();
    this.next = undefined;
  }

  private closeCurrent(): void {
    this.current?.source.close();
    this.current = undefined;
  }

  /** An event, to its stream, unless it has had it from another connection. */
  private deliver(connection: Connection, data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const shared = sharedStreamEventSchema.safeParse(parsed);
    if (!shared.success) {
      return;
    }
    const stream = connection.streams[shared.data.stream];
    if (
      stream === undefined ||
      stream.readyState === closed ||
      (stream.last !== undefined && shared.data.event.id <= stream.last)
    ) {
      return;
    }
    stream.last = shared.data.event.id;
    stream.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(shared.data.event) }),
    );
  }
}
