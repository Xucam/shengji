// Run against an isolated test server, never a room with real players.
// Requires Node 22+ and the frontend's installed TypeScript dependency.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const vm = require("node:vm");
const repo = path.resolve(__dirname, "../..");
const ts = require(require.resolve("typescript", { paths: [path.join(repo, "frontend"), process.cwd()] }));
const source = fs.readFileSync(path.join(repo, "frontend/src/WebsocketConnection.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
let heartbeats = 0;
class TrackedSocket extends WebSocket {
  constructor(uri) {
    super(uri);
    this.addEventListener("message", (event) => {
      if (event.data === '"Heartbeat"') heartbeats++;
    });
  }
}
const exported = {};
vm.runInNewContext(compiled, {
  exports: exported, WebSocket: TrackedSocket,
  setTimeout, clearTimeout, setInterval, clearInterval, console, Date, Math,
});
const Connection = exported.default;
const sockets = new Set();
let blocked = false;
const proxy = net.createServer((downstream) => {
  if (blocked) { downstream.destroy(); return; }
  const upstream = net.connect(3030, "127.0.0.1");
  for (const socket of [downstream, upstream]) {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  }
  downstream.on("close", () => upstream.destroy());
  upstream.on("close", () => downstream.destroy());
  downstream.pipe(upstream).pipe(downstream);
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(25);
  }
}
function player(client) {
  const phase = client.state && Object.values(client.state)[0];
  return phase?.propagated.players.find((p) => p.name === client.name);
}
function cutConnections() {
  for (const socket of sockets) socket.destroy();
}

(async () => {
  const clients = [];
  try {
    await new Promise((resolve) => proxy.listen(3035, "127.0.0.1", resolve));
    for (const name of ["Alice", "Bob", "Carol", "Dave"]) {
      const client = { name, connected: false, state: null, states: 0, requestedJoin: false };
      const connection = new Connection(
        "ws://127.0.0.1:3035/api",
        (connected) => {
          client.connected = connected;
          if (connected && !client.requestedJoin) {
            client.requestedJoin = true;
            connection.send({ room_name: "recoverytest0001", name, disable_compression: true });
          }
        },
        (data) => {
          const message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
          if (message.State) {
            client.state = message.State.state;
            client.states++;
            return "state";
          }
          if (message.Kicked) return "kicked";
        },
        () => { throw new Error("Unexpected kick"); },
      );
      client.connection = connection;
      clients.push(client);
      connection.connect();
    }
    await until(() => clients.every((c) => c.state?.Initialize?.propagated.players.length === 4), "four joined players");
    const ids = clients.map((c) => player(c).id);
    clients[0].connection.send({ Action: "StartGame" });
    await until(() => clients.every((c) => c.state?.Draw), "game started");
    const initialDeck = clients[0].state.Draw.deck.length;
    await until(() => clients.every((c) => c.state.Draw.deck.length < initialDeck), "server-driven dealing");
    const states = clients.map((c) => c.states);

    // Drop raw TCP connections, without a WebSocket Close frame, and reject
    // retries briefly. This reproduces a shared intermediary/network failure.
    blocked = true;
    cutConnections();
    await until(() => clients.every((c) => !c.connected), "clients detecting reset");
    await delay(300);
    const empty = await (await fetch("http://127.0.0.1:3030/stats")).json();
    assert.equal(empty.num_players_online_now, 0);
    assert.equal(empty.num_active_games, 1, "room must survive loss of its final connection");
    await delay(1000);
    blocked = false;
    await until(() => clients.every((c, i) => c.connected && c.states > states[i]), "automatic rejoin and fresh state");
    await until(() => heartbeats >= 8, "heartbeat replies on initial and replacement sockets");

    const repliesBeforeIdle = heartbeats;
    await until(() => heartbeats >= repliesBeforeIdle + clients.length,
      "periodic heartbeat replies after recovery", 35000);

    assert.deepEqual(clients.map((c) => player(c).id), ids, "player identities must survive reconnect");
    for (const client of clients) {
      assert.ok(client.state.Draw, "the same game must resume rather than returning to the lobby");
      assert.equal(client.state.Draw.propagated.players.length, 4, "no duplicate players");
    }
    const recovered = await (await fetch("http://127.0.0.1:3030/stats")).json();
    assert.equal(recovered.num_players_online_now, 4);
    assert.equal(recovered.num_active_games, 1);
    assert.equal(recovered.num_games_created, 1);
    console.log("PASS: four clients recovered from a shared TCP reset, rejoined the same game, and kept their identities.");
  } finally {
    clients.forEach((c) => c.connection.stop());
    blocked = true;
    cutConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
