import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Users = ReadonlyMap<string, string>;

export function readCredentials(raw: string | undefined): Users {
  const users = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const at = trimmed.indexOf(":");
    if (at <= 0 || at === trimmed.length - 1) {
      throw new Error(`NOTEBOOK_AUTH entry is not "name:password": ${JSON.stringify(trimmed)}`);
    }
    users.set(trimmed.slice(0, at), trimmed.slice(at + 1));
  }
  return users;
}

// Compared as digests so the check is constant time AND independent of length;
// comparing the raw strings would return early on a length mismatch and leak
// how long the real password is.
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function isAuthorised(request: IncomingMessage, users: Users): boolean {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return false;
  }

  const at = decoded.indexOf(":");
  if (at === -1) return false;

  // A password may contain a colon; a username may not.
  const expected = users.get(decoded.slice(0, at));
  if (expected === undefined) return false;
  return sameSecret(decoded.slice(at + 1), expected);
}

export function demandAuth(response: ServerResponse): void {
  response.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="NoteBook", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end("Authentication required.\n");
}

// Exempt so a platform health check does not need credentials. It reveals the
// model name and embedding dimensions, and nothing about any document.
export function isPublicPath(url: string | undefined): boolean {
  return (url ?? "").split("?")[0] === "/api/health";
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
