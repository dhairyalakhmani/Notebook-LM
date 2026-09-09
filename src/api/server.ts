// Must come first: config.ts reads process.env at module scope.
import "../env.ts";

import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { existsSync, readdirSync, rmSync } from "node:fs";
import * as config from "../config.ts";
import { handleApi } from "./router.ts";
import { registerReadRoutes, registerWriteRoutes } from "./handlers.ts";
import { serveStatic } from "./static.ts";
import { closeServices, notebookStore } from "./services.ts";
import { demandAuth, isAuthorised, isLoopback, isPublicPath, readCredentials } from "./auth.ts";

function sweepStaging(): number {
  if (!existsSync(config.TMP_DIR)) return 0;
  let removed = 0;
  for (const entry of readdirSync(config.TMP_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      rmSync(join(config.TMP_DIR, entry.name), { force: true });
      removed += 1;
    } catch {
      // Still held open by something; it will be swept next start.
    }
  }
  return removed;
}

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

  const users = readCredentials(process.env["NOTEBOOK_AUTH"]);
  // Fail closed. Binding anything but loopback without credentials would put
  // every document and the Groq key behind a URL and nothing else, so it is
  // refused at startup rather than served and regretted.
  if (!isLoopback(host) && users.size === 0) {
    console.error(
      `refusing to start: --host ${host} is reachable from outside this machine and ` +
        "NOTEBOOK_AUTH is empty. " +
        'Set NOTEBOOK_AUTH="name:password" (comma-separated for more people), ' +
        "or bind 127.0.0.1.",
    );
    process.exit(1);
  }

  registerReadRoutes();
  registerWriteRoutes();

  // Uploads stage into TMP_DIR before their hash is known. A crash mid-upload
  // leaves the part-file behind, and nothing else ever looks at it again.
  const swept = sweepStaging();
  if (swept > 0) console.log(`swept ${swept} abandoned upload(s) from ${config.TMP_DIR}`);

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (users.size > 0 && !isPublicPath(request.url) && !isAuthorised(request, users)) {
          demandAuth(response);
          return;
        }
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
  console.log(
    `  auth        ${users.size === 0 ? "off (loopback only)" : `${users.size} user(s)`}`,
  );
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
