import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A minimal ZIP writer, so a real .docx can be built in a test without adding a
 * dependency for it.
 *
 * Entries are *stored*, never deflated - a ZIP reader accepts that, and it
 * removes the only part that would need a compression library. Paths use forward
 * slashes, which is what OOXML readers require and what Windows'
 * `Compress-Archive` gets wrong.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  data: Buffer;
}

export function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 10); // method: stored
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + entry.data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

const CONTENT_TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

/** One Word paragraph. `style` is a style id such as "Heading1"; null for body. */
export interface Paragraph {
  style: string | null;
  text: string;
}

/**
 * Writes a real .docx carrying genuine Word heading styles, and returns its
 * path. This is what makes the DOCX test meaningful: mammoth has to map
 * "Heading1" to `<h1>` for the loader to produce explicit heading levels.
 */
export function writeDocx(paragraphs: Paragraph[], name = "fixture.docx"): string {
  const body = paragraphs
    .map(
      (paragraph) =>
        `<w:p><w:pPr>${
          paragraph.style ? `<w:pStyle w:val="${paragraph.style}"/>` : ""
        }</w:pPr><w:r><w:t xml:space="preserve">${paragraph.text}</w:t></w:r></w:p>`,
    )
    .join("");

  const document = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

  const path = join(mkdtempSync(join(tmpdir(), "nblm-")), name);
  writeFileSync(
    path,
    zip([
      { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
      { name: "_rels/.rels", data: Buffer.from(RELS, "utf8") },
      { name: "word/document.xml", data: Buffer.from(document, "utf8") },
    ]),
  );
  return path;
}

/** Writes an .html file and returns its path. */
export function writeHtml(html: string, name = "fixture.html"): string {
  const path = join(mkdtempSync(join(tmpdir(), "nblm-")), name);
  writeFileSync(path, html, "utf8");
  return path;
}
