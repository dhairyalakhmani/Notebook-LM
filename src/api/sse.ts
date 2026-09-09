import type { ServerResponse } from "node:http";

const HEARTBEAT_MS = 15_000;

export interface SseStream {
  send: (data: unknown, id: number) => void;
  close: () => void;
  readonly closed: boolean;
}

export function openSse(response: ServerResponse): SseStream {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();

  response.write("retry: 2000\n\n");

  let closed = false;
  const finish = () => {
    closed = true;
    clearInterval(heartbeat);
  };

  const heartbeat = setInterval(() => {
    if (closed) return;
    if (!response.write(": ping\n\n")) return;
  }, HEARTBEAT_MS);

  response.on("close", finish);
  response.on("error", finish);

  return {
    get closed() {
      return closed;
    },
    send: (data, id) => {
      if (closed) return;
      response.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close: () => {
      if (closed) return;
      response.write("event: done\ndata: {}\n\n");
      finish();
      response.end();
    },
  };
}
