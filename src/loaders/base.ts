import { access } from "node:fs/promises";
import { extname } from "node:path";
import type { DocumentPage } from "../models.ts";

export abstract class DocumentLoader {
  abstract readonly extensions: readonly string[];

  handles(filePath: string): boolean {
    return this.extensions.includes(extname(filePath).toLowerCase());
  }

  protected async validate(filePath: string): Promise<void> {
    try {
      await access(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }
    if (!this.handles(filePath)) {
      throw new Error(
        `${this.constructor.name} expects one of ${this.extensions.join(", ")}, ` +
          `got: ${extname(filePath)}`,
      );
    }
  }

  abstract load(filePath: string): Promise<DocumentPage[]>;
}
