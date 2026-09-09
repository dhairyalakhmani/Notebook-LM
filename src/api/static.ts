import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { sendFile } from "./http.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

function resolveWithin(root: string, urlPath: string): string | null {
  const candidate = resolve(join(root, normalize(urlPath)));
  const base = resolve(root);
  if (candidate !== base && !candidate.startsWith(base + sep)) return null;
  return candidate;
}

export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end("malformed URL");
    return;
  }

  const index = join(root, "index.html");
  let file = resolveWithin(root, path);

  if (file === null) {
    // Escaped the root. Answer with the app rather than confirming the probe.
    file = index;
  } else if (!existsSync(file) || statSync(file).isDirectory()) {
    file = index;
  }

  if (!existsSync(file)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(
      "No build found. Run `npm run build` first, or use `npm run dev` for the dev server.",
    );
    return;
  }

  await sendFile(request, response, file);
}
