import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IncomingMessage } from "node:http";
import { isAuthorised, isLoopback, isPublicPath, readCredentials } from "../src/api/auth.ts";

function requestWith(authorization?: string): IncomingMessage {
  return { headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
}

function basic(name: string, password: string): string {
  return `Basic ${Buffer.from(`${name}:${password}`, "utf8").toString("base64")}`;
}

describe("readCredentials", () => {
  it("reads nothing from an unset variable", () => {
    assert.equal(readCredentials(undefined).size, 0);
    assert.equal(readCredentials("").size, 0);
  });

  it("reads several people from one variable", () => {
    const users = readCredentials("alice:one, bob:two");
    assert.deepEqual([...users.keys()], ["alice", "bob"]);
    assert.equal(users.get("bob"), "two");
  });

  it("keeps a colon inside a password", () => {
    assert.equal(readCredentials("alice:a:b:c").get("alice"), "a:b:c");
  });

  it("refuses an entry that is not name:password", () => {
    assert.throws(() => readCredentials("alice"), /not "name:password"/);
    assert.throws(() => readCredentials(":secret"), /not "name:password"/);
    assert.throws(() => readCredentials("alice:"), /not "name:password"/);
  });
});

describe("isAuthorised", () => {
  const users = readCredentials("alice:correct-horse");

  it("accepts the right password", () => {
    assert.equal(isAuthorised(requestWith(basic("alice", "correct-horse")), users), true);
  });

  it("rejects a wrong password, an unknown user, and no header", () => {
    assert.equal(isAuthorised(requestWith(basic("alice", "wrong")), users), false);
    assert.equal(isAuthorised(requestWith(basic("mallory", "correct-horse")), users), false);
    assert.equal(isAuthorised(requestWith(), users), false);
  });

  it("rejects a password that is a prefix of the real one", () => {
    assert.equal(isAuthorised(requestWith(basic("alice", "correct-hors")), users), false);
    assert.equal(isAuthorised(requestWith(basic("alice", "correct-horse!")), users), false);
  });

  it("rejects a malformed or non-Basic header without throwing", () => {
    assert.equal(isAuthorised(requestWith("Bearer abc"), users), false);
    assert.equal(isAuthorised(requestWith("Basic !!!not-base64!!!"), users), false);
    assert.equal(isAuthorised(requestWith("Basic "), users), false);
    assert.equal(isAuthorised(requestWith(basic("alice", "")), users), false);
  });

  it("authorises nobody when no credentials are configured", () => {
    const none = readCredentials(undefined);
    assert.equal(isAuthorised(requestWith(basic("alice", "correct-horse")), none), false);
  });
});

describe("the gate's exemptions", () => {
  it("exempts only the health endpoint", () => {
    assert.equal(isPublicPath("/api/health"), true);
    assert.equal(isPublicPath("/api/health?verbose=1"), true);
    assert.equal(isPublicPath("/api/notebooks"), false);
    assert.equal(isPublicPath("/"), false);
    assert.equal(isPublicPath(undefined), false);
  });

  it("does not treat a path that merely starts with the health route as public", () => {
    assert.equal(isPublicPath("/api/healthz"), false);
    assert.equal(isPublicPath("/api/health/../notebooks"), false);
  });

  it("knows which hosts are reachable from outside", () => {
    assert.equal(isLoopback("127.0.0.1"), true);
    assert.equal(isLoopback("::1"), true);
    assert.equal(isLoopback("localhost"), true);
    assert.equal(isLoopback("0.0.0.0"), false);
    assert.equal(isLoopback("::"), false);
    assert.equal(isLoopback("192.168.1.10"), false);
  });
});
