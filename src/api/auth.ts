import { existsSync } from "node:fs";
import * as config from "../config.ts";
import {
  AccountStore,
  clearFailures,
  recordFailure,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  throttleFor,
} from "./accounts.ts";
import { badRequest, nameTaken, tooManyAttempts, unauthorized } from "./errors.ts";
import { isSafeUsername } from "./paths.ts";
import { route } from "./router.ts";
import { MAX_PASSWORD_CHARS, MIN_PASSWORD_CHARS } from "./dto.ts";
import { readJson } from "./http.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoginRequestDto, RegisterRequestDto, SessionDto } from "./dto.ts";

let accounts: AccountStore | null = null;

/** The account database is shared, and lives at the storage root: it is what
 *  maps a session to the per-user directory underneath it. */
export function accountStore(): AccountStore {
  accounts ??= new AccountStore(config.STORAGE_DIR);
  return accounts;
}

export function closeAccounts(): void {
  accounts?.close();
  accounts = null;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== name) continue;
    return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}

/** The signed-in user, or null. Identity, because the name selects storage. */
export function currentUser(request: IncomingMessage): string | null {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (token === null) return null;
  return accountStore().resolveSession(token)?.user ?? null;
}

function setSessionCookie(response: ServerResponse, token: string): void {
  response.setHeader(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      // Secure is omitted on plain http so this works on localhost; a deployment
      // is behind TLS, where the platform terminates https for us.
      ...(config.REQUIRE_SECURE_COOKIE ? ["Secure"] : []),
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ].join("; "),
  );
}

function clearSessionCookie(response: ServerResponse): void {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Routes that work without a session. Everything else needs one. */
export function isPublicPath(url: string | undefined): boolean {
  const path = (url ?? "").split("?")[0] ?? "";
  return (
    path === "/api/health" ||
    path === "/api/auth/register" ||
    path === "/api/auth/login" ||
    path === "/api/auth/logout" ||
    path === "/api/auth/me"
  );
}

function checkPassword(password: unknown): string {
  if (typeof password !== "string") throw badRequest("password must be a string");
  if (password.length < MIN_PASSWORD_CHARS) {
    throw badRequest(`password must be at least ${MIN_PASSWORD_CHARS} characters`);
  }
  if (password.length > MAX_PASSWORD_CHARS) {
    throw badRequest(`password must be at most ${MAX_PASSWORD_CHARS} characters`);
  }
  return password;
}

function checkName(name: unknown): string {
  if (typeof name !== "string") throw badRequest("user must be a string");
  const trimmed = name.trim();
  if (!isSafeUsername(trimmed)) {
    throw badRequest(
      "user must start with a letter or digit and contain only letters, digits, dot, dash or underscore (max 32)",
    );
  }
  return trimmed;
}

export function registerAuthRoutes(): void {
  route("POST", "/api/auth/register", async ({ request, response }): Promise<SessionDto> => {
    const body = await readJson<RegisterRequestDto>(request);
    const name = checkName(body.user);
    const password = checkPassword(body.password);

    // Optional gate on who may sign up at all. Without it, anyone with the URL
    // can create an account and spend the deployment's LLM quota.
    if (config.SIGNUP_CODE !== null && body.code !== config.SIGNUP_CODE) {
      throw unauthorized("that signup code is not right");
    }

    const store = accountStore();
    if (store.exists(name)) throw nameTaken(`the name '${name}' is taken`);
    await store.create(name, password);

    const token = store.issueSession(name);
    setSessionCookie(response, token);
    return { user: name, createdAt: new Date().toISOString() };
  });

  route("POST", "/api/auth/login", async ({ request, response }): Promise<SessionDto> => {
    const body = await readJson<LoginRequestDto>(request);
    const name = typeof body.user === "string" ? body.user.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    const waitMs = throttleFor(name);
    if (waitMs > 0) {
      throw tooManyAttempts("too many failed attempts; wait a moment", waitMs);
    }

    const store = accountStore();
    if (!(await store.verify(name, password))) {
      recordFailure(name);
      // One message for both causes: saying "no such user" would let anyone
      // enumerate who has an account.
      throw unauthorized("that name and password do not match");
    }

    clearFailures(name);
    const token = store.issueSession(name);
    setSessionCookie(response, token);
    return { user: name, createdAt: new Date().toISOString() };
  });

  route("POST", "/api/auth/logout", ({ request, response }): { ok: true } => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token !== null) accountStore().revokeSession(token);
    clearSessionCookie(response);
    return { ok: true };
  });

  route("GET", "/api/auth/me", ({ request }): SessionDto => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const session = token === null ? null : accountStore().resolveSession(token);
    if (!session) throw unauthorized("not signed in");
    return { user: session.user, createdAt: session.createdAt };
  });
}

/** Whether anyone has registered yet, so the UI can offer "create the first
 *  account" rather than a login form nobody can satisfy. */
export function hasAccounts(): boolean {
  if (!existsSync(`${config.STORAGE_DIR}/accounts.db`)) return false;
  return accountStore().count() > 0;
}
