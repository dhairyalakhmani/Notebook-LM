import { badRequest, HttpError } from "./errors.ts";
import { supportedExtensions } from "../loaders/index.ts";

const SUPPORTED = new Set(supportedExtensions());

const DOCUMENT_ID = /^[0-9a-f]{12}$/;

const NOTEBOOK_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export function documentId(value: string): string {
  if (!DOCUMENT_ID.test(value)) {
    throw badRequest(`'${value}' is not a document id (expected 12 hex characters)`);
  }
  return value;
}

export function notebookName(value: string): string {
  const trimmed = value.trim();
  if (!NOTEBOOK_NAME.test(trimmed)) {
    throw badRequest(
      `'${value}' is not a valid notebook name. Use letters, digits, spaces, ` +
        `dots, dashes or underscores, up to 64 characters, starting with a ` +
        `letter or digit.`,
    );
  }
  return trimmed;
}

export function requiredQuery(query: URLSearchParams, name: string): string {
  const value = query.get(name)?.trim();
  if (!value) throw badRequest(`the '${name}' query parameter is required`);
  return value;
}

export function intQuery(
  query: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = query.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw badRequest(`'${name}' must be a number, got '${raw}'`);
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function documentIdList(query: URLSearchParams, name: string): string[] | undefined {
  const raw = query.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map(documentId);
}

export function uploadFilename(query: URLSearchParams): string {
  const raw = requiredQuery(query, "filename");

  const base = raw.split(/[\\/]/).pop() ?? "";
  if (base === "" || base === "." || base === "..") {
    throw badRequest(`'${raw}' is not a filename`);
  }
  if (base.length > 255) throw badRequest("that filename is too long");
  if (base.includes("\u0000")) {
    throw badRequest("that filename contains a null byte");
  }

  const dot = base.lastIndexOf(".");
  const extension = dot === -1 ? "" : base.slice(dot).toLowerCase();
  if (!SUPPORTED.has(extension)) {
    throw new HttpError(
      415,
      "unsupported_type",
      `'${extension || base}' is not a supported source. ` +
        `Accepted: ${[...SUPPORTED].sort().join(", ")}.`,
    );
  }
  return base;
}
