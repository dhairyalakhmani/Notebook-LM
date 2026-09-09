/**
 * Real accounts: register, sign in, sign out, and one person's workspace being
 * invisible to another.
 *
 * Everything goes over HTTP against a server wired exactly like src/api/server.ts,
 * because the gate is part of the behaviour being tested.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import "../src/env.ts";

const STORAGE = mkdtempSync(join(tmpdir(), "accounts-"));
process.env["NOTEBOOK_STORAGE_DIR"] = STORAGE;

const auth = await import("../src/api/auth.ts");
const accountsModule = await import("../src/api/accounts.ts");
const { handleApi } = await import("../src/api/router.ts");
const { registerReadRoutes, registerWriteRoutes } = await import("../src/api/handlers.ts");
const { closeServices } = await import("../src/api/services.ts");

let server: Server;
let base: string;

interface Reply {
  status: number;
  body: Record<string, unknown>;
  cookie: string | null;
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string | null } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.cookie) headers["Cookie"] = options.cookie;
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie ? (setCookie.split(";")[0] ?? null) : null;
  return { status: response.status, body, cookie };
}

// Everything the account database occupies. In WAL mode a recent write lives in
// the -wal companion, so reading accounts.db alone shows an empty file - and an
// "is not present" assertion against it would pass for the wrong reason.
function onDisk(): string {
  let text = "";
  for (const suffix of ["", "-wal"]) {
    try {
      text += readFileSync(join(STORAGE, `accounts.db${suffix}`)).toString("latin1");
    } catch {
      // The companion may not exist between checkpoints.
    }
  }
  return text;
}

async function signUp(user: string, password: string): Promise<string> {
  const reply = await call("/api/auth/register", { body: { user, password } });
  assert.equal(reply.status, 201, `register ${user}: ${JSON.stringify(reply.body)}`);
  assert.ok(reply.cookie, "register should set a session cookie");
  return reply.cookie;
}

before(async () => {
  auth.registerAuthRoutes();
  registerReadRoutes();
  registerWriteRoutes();
  server = createServer((request, response) => {
    void (async () => {
      const user = auth.currentUser(request);
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      if (user === null && path.startsWith("/api/") && !auth.isPublicPath(request.url)) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: "unauthorized", message: "sign in" } }));
        return;
      }
      if (await handleApi(request, response, user)) return;
      response.writeHead(404).end();
    })();
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  closeServices();
  auth.closeAccounts();
});

beforeEach(() => {
  accountsModule.resetThrottle();
});

describe("registering", () => {
  it("creates an account and signs you straight in", async () => {
    const cookie = await signUp("ada", "a-long-enough-password");
    const me = await call("/api/auth/me", { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body["user"], "ada");
  });

  it("refuses a name that is already taken", async () => {
    await signUp("grace", "a-long-enough-password");
    const again = await call("/api/auth/register", {
      body: { user: "grace", password: "another-long-password" },
    });
    assert.equal(again.status, 409);
    assert.equal((again.body["error"] as { code: string }).code, "name_taken");
  });

  it("refuses a short password", async () => {
    const reply = await call("/api/auth/register", { body: { user: "linus", password: "short" } });
    assert.equal(reply.status, 400);
    assert.match((reply.body["error"] as { message: string }).message, /at least 10/);
  });

  it("refuses a name that could escape the storage directory", async () => {
    for (const user of ["../elsewhere", "a/b", ".", ""]) {
      const reply = await call("/api/auth/register", {
        body: { user, password: "a-long-enough-password" },
      });
      assert.equal(reply.status, 400, `${JSON.stringify(user)} should be refused`);
    }
  });

  it("never stores the password itself", async () => {
    await signUp("edsger", "a-very-distinctive-password");
    const raw = onDisk();
    // Asserting the absence alone would pass vacuously if we were reading the
    // wrong file, so this also insists the hash IS there.
    assert.ok(raw.includes("scrypt$"), "a scrypt hash should be on disk");
    assert.ok(!raw.includes("a-very-distinctive-password"), "the password must not be");
  });
});

describe("signing in", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    await signUp("alan", "a-long-enough-password");

    const good = await call("/api/auth/login", {
      body: { user: "alan", password: "a-long-enough-password" },
    });
    assert.equal(good.status, 201);
    assert.ok(good.cookie);

    const bad = await call("/api/auth/login", {
      body: { user: "alan", password: "not-the-password" },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.cookie, null, "a failed login must not set a session");
  });

  it("says the same thing for an unknown name as for a wrong password", async () => {
    const unknown = await call("/api/auth/login", {
      body: { user: "nobody", password: "a-long-enough-password" },
    });
    const wrong = await call("/api/auth/login", {
      body: { user: "alan", password: "definitely-wrong" },
    });
    // Otherwise the reply tells an attacker which names exist.
    assert.equal(unknown.status, wrong.status);
    assert.deepEqual(unknown.body, wrong.body);
  });

  it("throttles repeated failures", async () => {
    await signUp("hopper", "a-long-enough-password");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await call("/api/auth/login", { body: { user: "hopper", password: "wrong" } });
    }
    const blocked = await call("/api/auth/login", {
      body: { user: "hopper", password: "wrong" },
    });
    assert.equal(blocked.status, 429);
    assert.ok(
      (blocked.body["error"] as { retryAfterMs: number }).retryAfterMs > 0,
      "the client needs to know how long to wait",
    );
  });
});

describe("signing out", () => {
  it("revokes the session, so the cookie stops working", async () => {
    const cookie = await signUp("ken", "a-long-enough-password");
    assert.equal((await call("/api/auth/me", { cookie })).status, 200);

    const out = await call("/api/auth/logout", { method: "POST", cookie });
    assert.equal(out.status, 201);

    // Not merely cleared in the browser: the server no longer honours it.
    assert.equal((await call("/api/auth/me", { cookie })).status, 401);
    assert.equal((await call("/api/notebooks", { cookie })).status, 401);
  });

  it("stores only a hash of the token, so the database holds nothing usable", async () => {
    const cookie = await signUp("dennis", "a-long-enough-password");
    const token = decodeURIComponent(cookie.split("=")[1] ?? "");
    assert.ok(token.length > 20);
    const raw = onDisk();
    assert.ok(raw.includes("scrypt$"), "sanity: we are reading the real contents");
    assert.ok(!raw.includes(token), "the session token must not be stored in the clear");
  });

  it("rejects an expired session", () => {
    const store = auth.accountStore();
    const token = store.issueSession("ken", Date.now() - accountsModule.SESSION_TTL_MS - 1000);
    assert.equal(store.resolveSession(token), null);
  });
});

describe("the gate", () => {
  it("refuses the data routes without a session", async () => {
    for (const path of ["/api/notebooks", "/api/notebooks/anything"]) {
      const reply = await call(path);
      assert.equal(reply.status, 401, `${path} should require a session`);
    }
  });

  it("leaves health and the auth routes open", async () => {
    assert.equal((await call("/api/health")).status, 200);
    assert.equal((await call("/api/auth/me")).status, 401, "open, but says you are not signed in");
  });
});

describe("each account gets its own workspace", () => {
  it("does not show one person the other's notebooks", async () => {
    const rob = await signUp("rob", "a-long-enough-password");
    const russ = await signUp("russ", "a-long-enough-password");

    assert.equal(
      (await call("/api/notebooks", { method: "POST", body: { name: "shared" }, cookie: rob }))
        .status,
      201,
    );

    const mine = (await call("/api/notebooks", { cookie: rob })).body as {
      notebooks: { name: string }[];
    };
    assert.deepEqual(
      mine.notebooks.map((n) => n.name),
      ["shared"],
    );

    const theirs = (await call("/api/notebooks", { cookie: russ })).body as {
      notebooks: { name: string }[];
    };
    assert.deepEqual(theirs.notebooks, [], "russ starts with an empty workspace");
  });

  it("keeps each account's databases in its own directory", async () => {
    const cookie = await signUp("brian", "a-long-enough-password");
    await call("/api/notebooks", { method: "POST", body: { name: "brians" }, cookie });
    assert.ok(existsSync(join(STORAGE, "users", "brian", "notebook.db")));
  });

  it("reports another person's notebook as absent, and will not delete it", async () => {
    const bjarne = await signUp("bjarne", "a-long-enough-password");
    const guido = await signUp("guido", "a-long-enough-password");
    await call("/api/notebooks", { method: "POST", body: { name: "cpp" }, cookie: bjarne });

    assert.equal((await call("/api/notebooks/cpp", { cookie: guido })).status, 404);
    assert.equal(
      (await call("/api/notebooks/cpp", { method: "DELETE", cookie: guido })).status,
      404,
    );

    const survivors = (await call("/api/notebooks", { cookie: bjarne })).body as {
      notebooks: { name: string }[];
    };
    assert.ok(
      survivors.notebooks.some((n) => n.name === "cpp"),
      "it must survive",
    );
  });
});
