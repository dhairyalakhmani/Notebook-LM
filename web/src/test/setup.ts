import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  const dialog = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  if (typeof dialog["showModal"] !== "function") {
    dialog["showModal"] = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    dialog["show"] = function show(this: HTMLDialogElement) {
      this.open = true;
    };
    dialog["close"] = function close(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
  }

  const { cleanup } = await import("@testing-library/react");
  afterEach(() => cleanup());
}
