import { join } from "node:path";
import * as config from "../config.ts";

// A username becomes a directory name, so it is constrained to something that
// cannot escape. readCredentials rejects anything else at startup, and this is
// the second check: the one place a name is turned into a path.
export const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function isSafeUsername(name: string): boolean {
  return USERNAME.test(name) && name !== "." && name !== "..";
}

/**
 * Where one caller's notebooks live.
 *
 * With no credentials configured there is no caller to separate, so this is
 * the storage root and everything behaves as it always has - which is what
 * keeps local development and the whole existing test suite unchanged.
 */
export function userRoot(user: string | null): string {
  if (user === null) return config.STORAGE_DIR;
  if (!isSafeUsername(user)) throw new Error(`unsafe username: ${JSON.stringify(user)}`);
  return join(config.STORAGE_DIR, "users", user);
}

export function userSourcesDir(user: string | null): string {
  return join(userRoot(user), "sources");
}

export function userTmpDir(user: string | null): string {
  return join(userRoot(user), "tmp");
}
