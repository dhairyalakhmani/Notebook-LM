import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPage, type ZoomMode } from "./PdfPage.tsx";
import type { PDFDocumentProxy } from "pdfjs-dist";

const renderPage = vi.fn(() => ({ promise: Promise.resolve() }));
const getPage = vi.fn();

vi.mock("pdfjs-dist", () => ({
  Util: { transform: () => [1, 0, 0, 10, 12, 40] },
  GlobalWorkerOptions: { workerSrc: "" },
}));

function fakeDoc(): PDFDocumentProxy {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
      transform: [1, 0, 0, -1, 0, 800 * scale],
      scale,
    }),
    render: renderPage,
    getTextContent: () =>
      Promise.resolve({
        items: [
          {
            str: "The most complicated and interesting component of nodal delay",
            transform: [10, 0, 0, 10, 50, 700],
          },
          { str: " is the queuing delay", transform: [10, 0, 0, 10, 50, 686] },
          { str: "unrelated line", transform: [10, 0, 0, 10, 50, 660] },
        ],
      }),
  };
  return {
    getPage: () => {
      getPage();
      return Promise.resolve(page);
    },
    numPages: 775,
  } as unknown as PDFDocumentProxy;
}

const SIZE = { width: 420, height: 900 };

beforeEach(() => {
  renderPage.mockClear();
  getPage.mockClear();
});

describe("PdfPage", () => {
  it("draws the page once it has a measured size", async () => {
    render(
      <PdfPage
        doc={fakeDoc()}
        page={48}
        zoom={{ kind: "fit-width" }}
        phrases={[]}
        available={SIZE}
      />,
    );
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
  });

  it("does not draw before the container has been measured", async () => {
    render(
      <PdfPage
        doc={fakeDoc()}
        page={48}
        zoom={{ kind: "fit-width" }}
        phrases={[]}
        available={{ width: 0, height: 0 }}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(renderPage).not.toHaveBeenCalled();
  });

  it("does NOT restart the draw when the parent passes an equal-but-new zoom object", async () => {
    const doc = fakeDoc();
    const view = render(
      <PdfPage doc={doc} page={48} zoom={{ kind: "fit-width" }} phrases={[]} available={SIZE} />,
    );
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
    expect(getPage).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      view.rerender(
        <PdfPage doc={doc} page={48} zoom={{ kind: "fit-width" }} phrases={[]} available={SIZE} />,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it("redraws when the zoom genuinely changes", async () => {
    const doc = fakeDoc();
    const view = render(
      <PdfPage doc={doc} page={48} zoom={{ kind: "fit-width" }} phrases={[]} available={SIZE} />,
    );
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));

    view.rerender(
      <PdfPage doc={doc} page={48} zoom={{ kind: "fit-page" }} phrases={[]} available={SIZE} />,
    );
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));

    const manual: ZoomMode = { kind: "manual", scale: 1.4 };
    view.rerender(<PdfPage doc={doc} page={48} zoom={manual} phrases={[]} available={SIZE} />);
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(3));
  });

  it("redraws when the page changes", async () => {
    const doc = fakeDoc();
    const view = render(
      <PdfPage doc={doc} page={48} zoom={{ kind: "fit-width" }} phrases={[]} available={SIZE} />,
    );
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));

    view.rerender(
      <PdfPage doc={doc} page={410} zoom={{ kind: "fit-width" }} phrases={[]} available={SIZE} />,
    );
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
  });

  it("builds a text layer and marks only the cited sentence", async () => {
    const { container } = render(
      <PdfPage
        doc={fakeDoc()}
        page={50}
        zoom={{ kind: "fit-width" }}
        phrases={[
          "The most complicated and interesting component of nodal delay is the queuing delay",
        ]}
        available={SIZE}
      />,
    );

    await waitFor(() => expect(container.querySelectorAll("span").length).toBe(3));
    const marked = [...container.querySelectorAll("span")].filter((s) => s.className !== "");
    expect(marked).toHaveLength(2);
    expect(marked.map((s) => s.textContent).join("")).toContain("queuing delay");
  });

  it("sizes the canvas for the device pixel ratio", async () => {
    const { container } = render(
      <PdfPage
        doc={fakeDoc()}
        page={48}
        zoom={{ kind: "fit-width" }}
        phrases={[]}
        available={SIZE}
      />,
    );
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));

    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(canvas!.style.width).toBe("394px");
    expect(canvas!.width).toBeGreaterThanOrEqual(394);
  });
});
