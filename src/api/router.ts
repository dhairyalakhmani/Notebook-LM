import { toApiError } from "./errors.ts";
import { sendJson } from "./http.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  params: string[];
  query: URLSearchParams;
}

type Handler = (context: RequestContext) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: Route[] = [];

export function route(method: string, path: string, handler: Handler): void {
  const pattern = new RegExp(
    "^" + path.replace(/\//g, "\\/").replace(/:[A-Za-z]+/g, "([^/]+)") + "$",
  );
  routes.push({ method, pattern, handler });
}

export const HANDLED = Symbol("handled");

export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    // A malformed percent-escape. Only worth answering if it was aimed at us.
    if (!url.pathname.startsWith("/api/")) return false;
    sendJson(response, 400, {
      error: { code: "bad_request", message: "malformed URL encoding" },
    });
    return true;
  }

  if (!path.startsWith("/api/")) return false;

  const method = (request.method ?? "GET").toUpperCase();
  const allowed = new Set<string>();

  for (const candidate of routes) {
    const match = candidate.pattern.exec(path);
    if (!match) continue;
    allowed.add(candidate.method);
    if (candidate.method !== method) continue;

    try {
      const result: unknown = await candidate.handler({
        request,
        response,
        params: match.slice(1).map((value) => value ?? ""),
        query: url.searchParams,
      });
      if (result !== HANDLED && !response.writableEnded) {
        sendJson(response, method === "POST" ? 201 : 200, result);
      }
    } catch (error) {
      const { status, body } = toApiError(error);
      if (response.headersSent) {
        response.end();
      } else {
        if (status === 429 && body.error.retryAfterMs !== undefined) {
          response.setHeader("Retry-After", String(Math.ceil(body.error.retryAfterMs / 1000)));
        }
        sendJson(response, status, body);
      }
    }
    return true;
  }

  if (allowed.size > 0) {
    response.setHeader("Allow", [...allowed].sort().join(", "));
    sendJson(response, 405, {
      error: { code: "bad_request", message: `${method} not allowed on ${path}` },
    });
    return true;
  }

  sendJson(response, 404, { error: { code: "not_found", message: `no route ${path}` } });
  return true;
}

export function resetRoutes(): void {
  routes.length = 0;
}
