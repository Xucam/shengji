import * as React from "react";
import { AppState, AppStateContext } from "./AppStateProvider";
import websocketHandler from "./websocketHandler";
import WasmContext from "./WasmContext";
import WebsocketConnection from "./WebsocketConnection";
import { GameMessage } from "./gen-types";

interface Context {
  send: (value: any) => void;
}

export const WebsocketContext = React.createContext<Context>({
  send: () => {},
});

const WebsocketProvider = (props: React.PropsWithChildren) => {
  const { state, updateState } = React.useContext(AppStateContext);
  const { decodeWireFormat } = React.useContext(WasmContext);
  const current = React.useRef({ state, updateState, decodeWireFormat });
  current.current = { state, updateState, decodeWireFormat };
  const connection = React.useRef<WebsocketConnection | null>(null);

  React.useEffect(() => {
    const runtimeWebsocketHost = (window as any)._WEBSOCKET_HOST;
    const uri =
      runtimeWebsocketHost !== undefined && runtimeWebsocketHost !== null
        ? runtimeWebsocketHost
        : (location.protocol === "https:" ? "wss://" : "ws://") +
          location.host +
          location.pathname +
          (location.pathname.endsWith("/") ? "api" : "/api");
    const applyUpdate = (partial: Partial<AppState>): void => {
      // Preserve ordered message updates even before React commits a render.
      current.current.state = { ...current.current.state, ...partial };
      current.current.updateState(partial);
    };
    const transport = new WebsocketConnection(
      uri,
      (connected) =>
        applyUpdate({
          connected,
          ...(connected
            ? { everConnected: true, connectionStopped: false }
            : {}),
        }),
      (data) => {
        const message = (
          typeof data === "string"
            ? JSON.parse(data)
            : current.current.decodeWireFormat(
                new Uint8Array(data as ArrayBuffer),
              )
        ) as GameMessage;
        if ("Kicked" in message) return "kicked";
        applyUpdate(
          websocketHandler(current.current.state, message, transport.send),
        );
        if ("State" in message) return "state";
      },
      () => applyUpdate({ connectionStopped: true }),
    );
    connection.current = transport;
    const onVisible = (): void => {
      if (document.visibilityState === "visible") transport.probe();
    };
    window.addEventListener("online", transport.probe);
    document.addEventListener("visibilitychange", onVisible);
    transport.connect();
    return () => {
      window.removeEventListener("online", transport.probe);
      document.removeEventListener("visibilitychange", onVisible);
      connection.current = null;
      transport.stop();
    };
  }, []);

  const send = React.useCallback((value: any): void => {
    connection.current?.send(value);
  }, []);
  (window as any).send = send;
  return (
    <WebsocketContext.Provider value={{ send }}>
      {props.children}
    </WebsocketContext.Provider>
  );
};

export default WebsocketProvider;
