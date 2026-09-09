import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  response.end(text);
}

export async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  type: string = contentTypeFor(path),
): Promise<void> {
  const { size } = await stat(path);
  const range = request.headers.range;

  if (range) {
    const parsed = /bytes=(\d*)-(\d*)/.exec(range);
    const start = parsed?.[1] ? Number(parsed[1]) : 0;
    const end = parsed?.[2] ? Number(parsed[2]) : size - 1;
    if (start >= size || end >= size || start > end) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    response.writeHead(206, {
      "Content-Type": type,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    });
    createReadStream(path, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  createReadStream(path).pipe(response);
}

const MAX_JSON_BYTES = 64 * 1024;

export async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_JSON_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

export async function readBodyToFile(
  request: IncomingMessage,
  filePath: string,
  limitBytes: number,
): Promise<{ bytes: number; hash: string }> {
  const { createHash } = await import("node:crypto");
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const { Transform } = await import("node:stream");

  const digest = createHash("sha256");
  let bytes = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, next) {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        // Fails the pipeline, which destroys the write stream and the request.
        next(new Error(`the upload exceeds the ${limitBytes}-byte limit`));
        return;
      }
      digest.update(chunk);
      next(null, chunk);
    },
  });

  await pipeline(request, meter, createWriteStream(filePath));

  return { bytes, hash: digest.digest("hex").slice(0, 12) };
}
