// Must come first: config.ts reads process.env at module scope.
import "../env.ts";

import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import * as config from "../config.ts";
import { handleApi } from "./router.ts";
import { registerReadRoutes, registerWriteRoutes } from "./handlers.ts";
import { serveStatic } from "./static.ts";
import { closeServices, notebookStore } from "./services.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      static: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
    },
  });

  const port = Number(values.port ?? config.API_PORT);
  const host = values.host ?? config.API_HOST;
  const staticRoot = values.static ? resolve(values.static) : null;

  registerReadRoutes();
  registerWriteRoutes();

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (await handleApi(request, response)) return;
        if (staticRoot) {
          await serveStatic(request, response, staticRoot);
          return;
        }
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("This is the API server. The UI runs on the Vite dev server.\n");
      } catch (error) {
        console.error("unhandled request error:", error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    })();
  });

  const notebooks = notebookStore().listNotebooks();

  await new Promise<void>((ready) => server.listen(port, host, ready));

  console.log(`notebook api  http://${host}:${port}`);
  console.log(`  storage     ${config.STORAGE_DIR}`);
  console.log(
    `  notebooks   ${notebooks.length}` +
      (notebooks.length > 0
        ? ` (${notebooks.map((notebook) => notebook.notebook).join(", ")})`
        : ""),
  );
  if (staticRoot) console.log(`  serving     ${staticRoot}`);

  const shutdown = (signal: string) => {
    console.log(`\n${signal} - closing`);
    server.close(() => {
      closeServices();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

await main();
