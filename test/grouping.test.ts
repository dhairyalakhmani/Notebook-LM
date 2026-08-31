import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { chunkDocument } from "../src/chunking/pipeline.ts";
import * as config from "../src/config.ts";
import { pdfPages } from "./helpers.ts";
import type { LineSpec } from "./helpers.ts";

/** A domain heading with several table subsections under it - the shape that
 *  makes grouping worth doing. */
function domain(name: string, tables: string[]): LineSpec[] {
  const lines: LineSpec[] = [{ text: name, fontSize: 13, isBold: true, gap: 24 }];
  for (const table of tables) {
    lines.push({ text: table, fontSize: 13, isBold: true, gap: 20 });
    lines.push({
      text: `${table}_id (PK): identifies one row of ${table} and is referenced by the tables around it.`,
    });
    lines.push({
      text: `The ${table} table is normalised so that a change to its attributes does not rewrite related rows.`,
    });
  }
  return lines;
}

const pages = pdfPages([
  ...domain("1. USER DOMAIN", ["Customer", "Branch", "Violation"]),
  ...domain("2. FLEET DOMAIN", ["Vehicle", "Transfer"]),
]);

describe("ancestor grouping", () => {
  it("gives one parent per domain, not one per table", async () => {
    const { parents } = await chunkDocument(pages, "d");
    assert.equal(parents.length, 2, "two domains -> two parents");
  });

  it("fans out to several children per parent", async () => {
    const { parents, children } = await chunkDocument(pages, "d");
    assert.equal(children.length, 5, "five tables -> five children");
    assert.ok(
      children.length / parents.length >= 2,
      `expected fan-out, got ${children.length}/${parents.length}`,
    );
  });

  it("parents carry the shared ancestor path", async () => {
    const { parents } = await chunkDocument(pages, "d");
    assert.deepEqual(parents[0]!.headingPath, ["1. USER DOMAIN"]);
    assert.deepEqual(parents[1]!.headingPath, ["2. FLEET DOMAIN"]);
  });

  it("children keep their own deeper path - breadth above, precision below", async () => {
    const { children } = await chunkDocument(pages, "d");
    const branch = children.find((c) => c.text.includes("Branch_id"));
    assert.deepEqual(branch?.headingPath, ["1. USER DOMAIN", "Branch"]);
  });

  it("a parent now contains its siblings, so expansion returns real context", async () => {
    const { parents } = await chunkDocument(pages, "d");
    const userDomain = parents[0]!;
    for (const table of ["Customer", "Branch", "Violation"]) {
      assert.ok(userDomain.text.includes(`${table}_id`), `parent must contain ${table}`);
    }
    assert.ok(
      !userDomain.text.includes("Vehicle_id"),
      "grouping must not cross into another domain",
    );
  });

  it("never merges across domains and never exceeds the parent budget", async () => {
    const { parents } = await chunkDocument(pages, "d");
    for (const parent of parents) {
      assert.ok(
        parent.tokenCount <= config.PARENT_MAX_TOKENS,
        `parent of ${parent.tokenCount} exceeds ${config.PARENT_MAX_TOKENS}`,
      );
    }
  });

  it("a section with no ancestor still stands alone", async () => {
    const { parents } = await chunkDocument(
      pdfPages([
        { text: "Standalone", fontSize: 13, isBold: true },
        { text: "This section has no parent heading above it whatsoever." },
      ]),
      "d",
    );
    assert.equal(parents.length, 1);
    assert.deepEqual(parents[0]!.headingPath, ["Standalone"]);
  });

  it("splits a group when the siblings together exceed the budget", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `Table${i}`);
    const { parents, children } = await chunkDocument(
      pdfPages(domain("BIG DOMAIN", many)),
      "d",
    );
    assert.ok(parents.length > 1, "one domain too large for one parent must split");
    assert.equal(children.length, 40, "every table still becomes its own child");
    for (const parent of parents) {
      assert.ok(parent.tokenCount <= config.PARENT_MAX_TOKENS);
    }
  });

  it("every child still points at a real parent", async () => {
    const { parents, children } = await chunkDocument(pages, "d");
    const ids = new Set(parents.map((p) => p.chunkId));
    for (const child of children) {
      assert.ok(child.parentId && ids.has(child.parentId), "orphan child");
    }
  });
});
