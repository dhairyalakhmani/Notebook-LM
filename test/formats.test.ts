import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { chunkDocument } from "../src/chunking/pipeline.ts";
import { cleanPages } from "../src/cleaning/index.ts";
import { htmlToLines } from "../src/loaders/html.ts";
import { loadDocument, supportedExtensions } from "../src/loaders/index.ts";
import { writeDocx, writeHtml } from "./fixtures.ts";

describe("htmlToLines", () => {
  it("takes heading levels from the tags, exactly", () => {
    const lines = htmlToLines("<h1>One</h1><h2>Two</h2><h3>Three</h3><p>Body.</p>");
    assert.deepEqual(
      lines.map((l) => [l.text, l.headingLevel ?? null]),
      [
        ["One", 1],
        ["Two", 2],
        ["Three", 3],
        ["Body.", null],
      ],
    );
  });

  it("drops navigation, scripts and footers", () => {
    const lines = htmlToLines(
      `<nav>Home Docs</nav><script>evil()</script><style>p{}</style>
       <p>Real content.</p><footer>Copyright</footer>`,
    );
    assert.deepEqual(
      lines.map((l) => l.text),
      ["Real content."],
    );
  });

  it("marks list items so they group into one list block", () => {
    const lines = htmlToLines("<ul><li>First</li><li>Second</li></ul>");
    assert.deepEqual(
      lines.map((l) => l.text),
      ["- First", "- Second"],
    );
  });

  it("flattens a nested list without losing the inner items", () => {
    const lines = htmlToLines("<ul><li>Outer<ul><li>Inner</li></ul></li></ul>");
    assert.deepEqual(
      lines.map((l) => l.text),
      ["- Outer", "- Inner"],
    );
  });

  it("carries table cells as data, not as spacing", () => {
    const lines = htmlToLines("<table><tr><td>North</td><td>120000</td></tr></table>");
    assert.deepEqual(lines[0]!.cells, ["North", "120000"]);
  });

  it("keeps one paragraph per block element", () => {
    const lines = htmlToLines("<div><p>One.</p><p>Two.</p></div>");
    assert.deepEqual(
      lines.map((l) => l.text),
      ["One.", "Two."],
    );
  });

  it("does not flatten nested structure into a single line", () => {
    const lines = htmlToLines("<section><h2>Title</h2><p>Body text.</p></section>");
    assert.equal(lines.length, 2);
  });
});

describe("HTML loader, end to end", () => {
  const path = writeHtml(
    `<html><head><title>Billing</title></head><body>
      <nav>Home</nav>
      <h1>Billing</h1>
      <h2>Retries</h2>
      <p>Failed charges are retried three times over seventy-two hours.</p>
      <h2>Refunds</h2>
      <p>A refund returns to the original payment method within ten days.</p>
      <table><tr><th>Region</th><th>Revenue</th></tr><tr><td>North</td><td>120000</td></tr></table>
      <footer>(c) 2026</footer>
    </body></html>`,
  );

  it("is a registered format", () => {
    assert.ok(supportedExtensions().includes(".html"));
  });

  it("produces an exact heading hierarchy", async () => {
    const { children } = await chunkDocument(cleanPages(await loadDocument(path)), "d");
    const retries = children.find((c) => c.text.includes("retried three times"));
    const refunds = children.find((c) => c.text.includes("original payment method"));
    assert.deepEqual(retries?.headingPath, ["Billing", "Retries"]);
    assert.deepEqual(refunds?.headingPath, ["Billing", "Refunds"]);
  });

  it("keeps the table recognisable after cleaning", async () => {
    const { children } = await chunkDocument(cleanPages(await loadDocument(path)), "d");
    assert.ok(
      children.some((c) => c.blockKinds.includes("table")),
      "a chunk must report that it holds a table",
    );
  });
});

describe("DOCX loader, end to end", () => {
  const path = writeDocx([
    { style: "Heading1", text: "Fleet Operations" },
    { style: "Heading2", text: "Vehicle Records" },
    { style: null, text: "Each vehicle row stores a VIN, a plate and its current branch." },
    { style: null, text: "A vehicle may transfer between branches without rewriting history." },
    { style: "Heading2", text: "Maintenance" },
    { style: null, text: "Service intervals are recorded per vehicle and drive availability." },
  ]);

  it("is a registered format", () => {
    assert.ok(supportedExtensions().includes(".docx"));
  });

  it("reads Word heading styles as real levels", async () => {
    // The whole reason DOCX is easier than PDF: nothing is inferred from fonts.
    const { children } = await chunkDocument(cleanPages(await loadDocument(path)), "d");
    const records = children.find((c) => c.text.includes("stores a VIN"));
    const maintenance = children.find((c) => c.text.includes("Service intervals"));
    assert.deepEqual(records?.headingPath, ["Fleet Operations", "Vehicle Records"]);
    assert.deepEqual(maintenance?.headingPath, ["Fleet Operations", "Maintenance"]);
  });

  it("groups the two subsections under one parent", async () => {
    const { parents, children } = await chunkDocument(cleanPages(await loadDocument(path)), "d");
    assert.equal(parents.length, 1, "both sections share the Fleet Operations ancestor");
    assert.equal(children.length, 2);
    assert.deepEqual(parents[0]!.headingPath, ["Fleet Operations"]);
  });

  it("keeps both paragraphs of a section together", async () => {
    const { children } = await chunkDocument(cleanPages(await loadDocument(path)), "d");
    const records = children.find((c) => c.text.includes("stores a VIN"));
    assert.match(records!.text, /without rewriting history/, "sibling paragraphs must stay");
  });
});

describe("unknown formats", () => {
  it("names the supported extensions in the error", async () => {
    await assert.rejects(() => loadDocument("nope.xyz"), /Supported:.*\.pdf/);
  });
});
