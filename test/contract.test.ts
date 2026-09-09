import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { API_VERSION, MAX_UPLOAD_BYTES, MIN_QUOTE_CHARS } from "../src/api/dto.ts";

const CONTRACT = "src/api/dto.ts";
const source = readFileSync(CONTRACT, "utf8");

describe("the wire contract", () => {
  it("has no import statements at all", () => {
    const imports = source.split("\n").filter((line) => /^\s*import\s/.test(line));
    assert.deepEqual(imports, [], `${CONTRACT} must not import anything`);
  });

  it("exports only types and primitive constants", () => {
    const runtime = source
      .split("\n")
      .filter((line) => /^export\s+(function|class|enum|let|var|default)\b/.test(line));
    assert.deepEqual(runtime, [], `${CONTRACT} must hold no runtime code`);
  });

  it("only exports constants whose values are primitives", () => {
    for (const value of [API_VERSION, MIN_QUOTE_CHARS, MAX_UPLOAD_BYTES]) {
      assert.equal(typeof value, "number");
    }
  });

  it("has the browser importing the quote floor rather than restating it", () => {
    const highlight = readFileSync("web/src/features/viewer/highlight.ts", "utf8");
    assert.match(
      highlight,
      /import \{[^}]*MIN_QUOTE_CHARS[^}]*\}/,
      "the matcher must import the floor from the contract",
    );
    assert.doesNotMatch(highlight, /const MIN_PHRASE\s*=\s*\d/, "a hardcoded floor has come back");
  });
});
