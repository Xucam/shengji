const HEARTBEAT = '"Heartbeat"';
const HEARTBEAT_INTERVAL_MS = 25_000;
const DEADLINE_MS = 60_000;

type MessageResult = "state" | "kicked" | void;

// Transport recovery is independent of React rendering. Game actions are never
// queued or replayed; reconnecting only resends the most recent join request.
export default class WebsocketConnection {
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private heartbeatDeadline: ReturnType<typeof setTimeout> | undefined;
  private heartbeatSentAt: number | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private serial = 0;
  private stopped = false;
  private joined = false;
  private join: unknown;

  constructor(
    private readonly uri: string,
    private readonly onConnected: (connected: boolean) => void,
    private readonly onMessage: (data: unknown) => MessageResult,
    private readonly onStopped: () => void,
  ) {}

  connect = (): void => {
    if (this.stopped || this.socket !== null) return;
    this.retry = undefined;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.uri);
    } catch (error) {
      console.warn("WebSocket creation failed", error);
      this.onConnected(false);
      this.scheduleRetry();
      return;
    }
    this.socket = ws;
    const connectionId = ++this.serial;
    ws.binaryType = "arraybuffer";
    this.deadline = setTimeout(
      () => this.fail(ws, "connect timeout"),
      DEADLINE_MS,
    );
    ws.addEventListener("open", () => {
      if (this.socket !== ws || this.stopped) return;
      console.info("WebSocket opened", { connectionId });
      this.clearDeadline();
      if (this.join !== undefined) {
        this.joined = false;
        this.deadline = setTimeout(
          () => this.fail(ws, "state recovery timeout"),
          DEADLINE_MS,
        );
        if (!this.write(ws, this.join)) return;
      } else {
        this.onConnected(true);
      }
      this.heartbeat = setInterval(() => this.ping(ws), HEARTBEAT_INTERVAL_MS);
      this.ping(ws);
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (this.socket !== ws || this.stopped) return;
      if (event.data === HEARTBEAT) {
        this.clearHeartbeatDeadline();
        if (this.join === undefined) this.attempt = 0;
        return;
      }
      try {
        const result = this.onMessage(event.data);
        if (this.socket !== ws || this.stopped) return;
        if (result === "kicked") {
          this.stop();
          this.onConnected(false);
          this.onStopped();
        } else if (result === "state") {
          this.joined = true;
          this.attempt = 0;
          this.clearDeadline();
          this.onConnected(true);
        }
      } catch (error) {
        console.error("WebSocket message processing failed", error);
        this.fail(ws, "message processing failed");
      }
    });
    ws.addEventListener("error", () => this.fail(ws, "transport error"));
    ws.addEventListener("close", (event: CloseEvent) => {
      console.info("WebSocket closed", {
        connectionId,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      if (this.socket !== ws || this.stopped) return;
      this.fail(ws, "transport closed");
    });
  };

  send = (value: unknown): void => {
    const isJoin =
      value !== null &&
      typeof value === "object" &&
      "room_name" in value &&
      "name" in value;
    if (isJoin) {
      this.join = value;
      this.joined = false;
    }
    const ws = this.socket;
    if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!isJoin && !this.joined) return;
    if (isJoin) {
      this.clearDeadline();
      this.deadline = setTimeout(
        () => this.fail(ws, "join timeout"),
        DEADLINE_MS,
      );
    }
    this.write(ws, value);
  };

  // Probe on tab resume or network restoration. Frozen pages may not run timers.
  probe = (): void => {
    if (this.stopped) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.ping(this.socket);
    } else if (this.socket === null) {
      clearTimeout(this.retry);
      this.retry = undefined;
      this.connect();
    } else if (this.socket.readyState !== WebSocket.CONNECTING) {
      this.fail(this.socket, "socket closed on resume");
    }
  };

  stop = (): void => {
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.clearTimers();
    const ws = this.socket;
    this.socket = null;
    ws?.close();
  };

  private ping(ws: WebSocket): void {
    if (this.socket !== ws) return;
    if (ws.readyState !== WebSocket.OPEN) {
      this.fail(ws, "socket no longer open");
      return;
    }
    if (
      this.heartbeatSentAt !== undefined &&
      Date.now() - this.heartbeatSentAt >= DEADLINE_MS
    ) {
      this.fail(ws, "heartbeat expired on resume");
      return;
    }
    // Repeated sends must not postpone the oldest unanswered heartbeat.
    if (this.heartbeatDeadline === undefined) {
      this.heartbeatSentAt = Date.now();
      this.heartbeatDeadline = setTimeout(
        () => this.fail(ws, "heartbeat timeout"),
        DEADLINE_MS,
      );
    }
    this.write(ws, "Heartbeat");
  }

  private write(ws: WebSocket, value: unknown): boolean {
    try {
      ws.send(JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn("WebSocket send failed", error);
      this.fail(ws, "send failed");
      return false;
    }
  }

  private clearHeartbeatDeadline(): void {
    clearTimeout(this.heartbeatDeadline);
    this.heartbeatDeadline = undefined;
    this.heartbeatSentAt = undefined;
  }

  private clearDeadline(): void {
    clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  private clearTimers(): void {
    this.clearDeadline();
    this.clearHeartbeatDeadline();
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private fail(ws: WebSocket, reason: string): void {
    if (this.socket !== ws || this.stopped) return;
    console.info("WebSocket recovery started", reason);
    this.socket = null;
    this.joined = false;
    this.clearTimers();
    ws.close();
    this.onConnected(false);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry !== undefined) return;
    const base = Math.min(1000 * 2 ** Math.min(this.attempt++, 5), 30_000);
    const delay = Math.min(30_000, base * (0.8 + Math.random() * 0.4));
    console.info("WebSocket reconnect scheduled", {
      attempt: this.attempt,
      delay,
    });
    this.retry = setTimeout(this.connect, delay);
  }
}
