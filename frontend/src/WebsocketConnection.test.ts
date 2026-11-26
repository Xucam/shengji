import WebsocketConnection from "./WebsocketConnection";

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  listeners: Record<string, Array<(event: any) => void>> = {};
  constructor(readonly uri: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    (this.listeners[type] ||= []).push(listener);
  }
  emit(type: string, event: any = {}): void {
    this.listeners[type]?.forEach((listener) => listener(event));
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  receive(data: unknown): void {
    this.emit("message", { data });
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(data);
  }
  close(): void {
    this.serverClose();
  }
  serverClose(): void {
    this.readyState = 3;
    this.emit("close", {
      code: 1006,
      reason: "test connection loss",
      wasClean: false,
    });
  }
}

const JOIN = {
  room_name: "recoverytest0001",
  name: "Alice",
  disable_compression: true,
};
const ACTION = { Action: "DrawCard" };
const originalWebSocket = global.WebSocket;
let connections: WebsocketConnection[];

function setup() {
  const status = jest.fn();
  const onMessage = jest.fn((data: unknown): "state" | "kicked" | undefined => {
    if (data === "state") return "state";
    if (data === "kicked") return "kicked";
    return undefined;
  });
  const stopped = jest.fn();
  const connection = new WebsocketConnection(
    "ws://test/api",
    status,
    onMessage,
    stopped,
  );
  connections.push(connection);
  connection.connect();
  return {
    connection,
    status,
    onMessage,
    stopped,
    socket: FakeSocket.instances[FakeSocket.instances.length - 1],
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, "random").mockReturnValue(0.5);
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  FakeSocket.instances = [];
  connections = [];
  global.WebSocket = FakeSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  connections.forEach((connection) => connection.stop());
  global.WebSocket = originalWebSocket;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("WebSocket recovery", () => {
  it("rejoins with the same identity and waits for fresh state without replaying actions", () => {
    const { connection, socket, status } = setup();
    socket.open();
    socket.receive('"Heartbeat"');
    connection.send(JOIN);
    socket.receive("state");
    connection.send(ACTION);
    socket.serverClose();
    expect(status).toHaveBeenLastCalledWith(false);
    jest.advanceTimersByTime(1000);
    const replacement = FakeSocket.instances[1];
    replacement.open();
    expect(replacement.sent).toContain(JSON.stringify(JOIN));
    expect(replacement.sent).not.toContain(JSON.stringify(ACTION));
    replacement.receive("broadcast");
    expect(status).toHaveBeenLastCalledWith(false);
    connection.send(ACTION);
    expect(replacement.sent).not.toContain(JSON.stringify(ACTION));
    replacement.receive("state");
    expect(status).toHaveBeenLastCalledWith(true);
    connection.send(ACTION);
    expect(replacement.sent).toContain(JSON.stringify(ACTION));
  });

  it("backs off failed attempts and caps the retry delay at 30 seconds", () => {
    setup();
    [1000, 2000, 4000, 8000, 16000, 30000, 30000].forEach((delay, index) => {
      FakeSocket.instances[index].serverClose();
      jest.advanceTimersByTime(delay - 1);
      expect(FakeSocket.instances).toHaveLength(index + 1);
      jest.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(index + 2);
    });
  });

  it("does not mark a working connection disconnected after five seconds", () => {
    const { connection, socket, status } = setup();
    socket.open();
    socket.receive('"Heartbeat"');
    connection.send(JOIN);
    socket.receive("state");
    connection.send(ACTION);
    jest.advanceTimersByTime(6000);
    expect(status).toHaveBeenLastCalledWith(true);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("sends heartbeats every 25 seconds and accepts replies without invoking game handlers", () => {
    const { socket, onMessage, status } = setup();
    socket.open();
    socket.receive('"Heartbeat"');
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(25000);
      expect(socket.sent[socket.sent.length - 1]).toBe('"Heartbeat"');
      socket.receive('"Heartbeat"');
    }
    expect(onMessage).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith(true);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("reconnects when heartbeat replies stop without letting repeated pings postpone the deadline", () => {
    const { socket, status } = setup();
    socket.open();
    socket.receive('"Heartbeat"');
    jest.advanceTimersByTime(25000);
    jest.advanceTimersByTime(60000);
    expect(status).toHaveBeenLastCalledWith(false);
    jest.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("does not automatically reconnect after an intentional kick", () => {
    const { socket, stopped } = setup();
    socket.open();
    socket.receive("kicked");
    jest.advanceTimersByTime(120000);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("ignores messages and closures from an obsolete socket", () => {
    const { socket, onMessage, status } = setup();
    socket.open();
    socket.serverClose();
    jest.advanceTimersByTime(1000);
    FakeSocket.instances[1].open();
    onMessage.mockClear();
    status.mockClear();
    socket.receive("state");
    socket.serverClose();
    expect(onMessage).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("cancels all recovery work when unmounted", () => {
    const { connection, socket } = setup();
    socket.open();
    socket.serverClose();
    connection.stop();
    jest.advanceTimersByTime(120000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("recovers from decoding errors instead of wedging a shared message queue", () => {
    const { socket, onMessage } = setup();
    socket.open();
    onMessage.mockImplementation(() => {
      throw new Error("bad message");
    });
    socket.receive("bad");
    jest.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("times out a stalled handshake", () => {
    setup();
    jest.advanceTimersByTime(60000);
    jest.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("times out stalled state recovery even if heartbeat replies work", () => {
    const { connection, socket, status } = setup();
    socket.open();
    connection.send(JOIN);
    socket.receive('"Heartbeat"');
    jest.advanceTimersByTime(25000);
    socket.receive('"Heartbeat"');
    jest.advanceTimersByTime(25000);
    socket.receive('"Heartbeat"');
    jest.advanceTimersByTime(10000);
    expect(status).toHaveBeenLastCalledWith(false);
  });

  it("probes a dead open socket immediately after a frozen tab resumes", () => {
    const { connection, socket, status } = setup();
    socket.open();
    jest.setSystemTime(Date.now() + 61000);
    connection.probe();
    expect(status).toHaveBeenLastCalledWith(false);
  });
});
