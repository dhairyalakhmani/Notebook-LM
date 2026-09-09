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
import { sendJson } from "./http.ts";
import { closeServices } from "./services.ts";
import {
  accountStore,
  closeAccounts,
  currentUser,
  isPublicPath,
  registerAuthRoutes,
} from "./auth.ts";

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

  registerAuthRoutes();
  registerReadRoutes();
  registerWriteRoutes();

  const accounts = accountStore();
  const expired = accounts.sweepSessions();
  if (expired > 0) console.log(`swept ${expired} expired session(s)`);

  // Uploads stage into TMP_DIR before their hash is known. A crash mid-upload
  // leaves the part-file behind, and nothing else ever looks at it again.
  const swept = sweepStaging();
  if (swept > 0) console.log(`swept ${swept} abandoned upload(s) from ${config.TMP_DIR}`);

  const server = createServer((request, response) => {
    void (async () => {
      try {
        // The app shell is served to anyone: the browser needs the bundle in
        // order to render the sign-in screen. Every /api route except the auth
        // ones requires a session, and the data lives behind those.
        const user = currentUser(request);
        const path = (request.url ?? "/").split("?")[0] ?? "/";
        if (user === null && path.startsWith("/api/") && !isPublicPath(request.url)) {
          sendJson(response, 401, {
            error: { code: "unauthorized", message: "sign in to continue" },
          });
          return;
        }
        if (await handleApi(request, response, user)) return;
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

  await new Promise<void>((ready) => server.listen(port, host, ready));

  console.log(`notebook api  http://${host}:${port}`);
  console.log(
    `  accounts    ${accounts.count()}` +
      (config.SIGNUP_CODE === null ? " (signup open)" : " (signup code required)"),
  );
  console.log(`  storage     ${config.STORAGE_DIR}`);
  if (staticRoot) console.log(`  serving     ${staticRoot}`);

  const shutdown = (signal: string) => {
    console.log(`\n${signal} - closing`);
    server.close(() => {
      closeServices();
      closeAccounts();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

await main();
