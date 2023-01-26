import WebSocket from "ws";

import type { AssetsManifest } from "./compiler/assets";

type Message =
  | { type: "RELOAD" }
  | { type: "HMR"; assetsManifest: AssetsManifest; updates: unknown[] }
  | { type: "LOG"; message: string };

type Broadcast = (message: Message) => void;

export let serve = (options: { port: number }) => {
  let wss = new WebSocket.Server({ port: options.port });

  let broadcast: Broadcast = (message) => {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  };

  let reload = () => broadcast({ type: "RELOAD" });

  let log = (messageText: string) => {
    let _message = `💿 ${messageText}`;
    console.log(_message);
    broadcast({ type: "LOG", message: _message });
  };

  let hmr = (assetsManifest: AssetsManifest, updates: unknown[]) => {
    broadcast({ type: "HMR", assetsManifest, updates });
  };

  return { reload, hmr, log, close: wss.close };
};
