import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "./renderApp.tsx";
import { server } from "./msw/server.ts";
import { asked, askResponse, DOC_A, DOC_B, summaries } from "./msw/handlers.ts";
import { messages } from "../shared/messages.ts";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  Util: { transform: () => [1, 0, 0, 1, 0, 0] },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 775,
      getPage: () =>
        Promise.resolve({
          getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, 1, 0, 0] }),
          render: () => ({ promise: Promise.resolve() }),
          getTextContent: () => Promise.resolve({ items: [] }),
        }),
    }),
    destroy: () => Promise.resolve(),
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "worker.js" }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  asked.length = 0;
  localStorage.clear();
});

async function loaded() {
  await waitFor(() => expect(screen.getByText("2 of 2 searched")).toBeInTheDocument());
}

describe("the notebook shell", () => {
  it("lists both sources with their real sizes", async () => {
    renderApp();
    await loaded();
    expect(screen.getByText("dbms-notes")).toBeInTheDocument();
    const rail = screen.getByLabelText("Sources");
    expect(rail.textContent).toContain("19.7 MB");
    expect(rail.textContent).toContain("775 pages");
  });

  it("offers to create one when there are no notebooks", async () => {
    server.use(http.get("/api/notebooks", () => HttpResponse.json({ notebooks: [] })));
    renderApp({ url: "/" });
    await waitFor(() =>
      expect(screen.getByText(messages.notebooksEmpty.title)).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: messages.notebooksEmpty.action }),
    ).toBeInTheDocument();
  });

  it("explains a failed load and offers a retry, rather than showing nothing", async () => {
    server.use(
      http.get("/api/notebooks/:name", () =>
        HttpResponse.json({ error: { code: "internal", message: "boom" } }, { status: 500 }),
      ),
    );
    renderApp();
    await waitFor(() => expect(screen.getByText(messages.sourcesFailed.title)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: messages.sourcesFailed.action })).toBeInTheDocument();
  });
});

describe("asking a question", () => {
  it("sends the question that was typed", async () => {
    const user = userEvent.setup();
    renderApp();
    await loaded();

    const box = screen.getByLabelText("Your question");
    await user.type(box, "what is queuing delay?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(asked.length).toBe(1));
    expect(asked[0]?.body).toMatchObject({ question: "what is queuing delay?" });
  });

  it("shows the question immediately, before any answer arrives", async () => {
    server.use(
      http.post("/api/notebooks/:name/ask", async () => {
        await delay(300);
        return HttpResponse.json(askResponse);
      }),
    );
    const user = userEvent.setup();
    renderApp();
    await loaded();
    await user.type(screen.getByLabelText("Your question"), "does it appear at once?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("does it appear at once?")).toBeInTheDocument());
    expect(screen.getByText(/Searching your sources/)).toBeInTheDocument();
  });

  it("keeps the typed question and offers a retry when the request fails", async () => {
    server.use(
      http.post("/api/notebooks/:name/ask", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "upstream died" } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderApp();
    await loaded();
    await user.type(screen.getByLabelText("Your question"), "this will fail");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText(messages.askFailed.title)).toBeInTheDocument());
    expect(screen.getByText("this will fail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: messages.askFailed.action })).toBeInTheDocument();
  });

  it("shows a real countdown on a rate limit, derived from the server's delay", async () => {
    server.use(
      http.post("/api/notebooks/:name/ask", () =>
        HttpResponse.json(
          {
            error: {
              code: "rate_limited",
              message: "slow down",
              retryAfterMs: 30_000,
              phase: "answer",
            },
          },
          { status: 429 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderApp();
    await loaded();
    await user.type(screen.getByLabelText("Your question"), "too many questions");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText(messages.quotaWait.title)).toBeInTheDocument());
    // ~30s, from the server's own retryAfterMs.
    expect(screen.getByText(/^(29|30)s$/)).toBeInTheDocument();
  });

  it("refuses to send when every source is unticked", async () => {
    const user = userEvent.setup();
    renderApp();
    await loaded();
    await user.click(screen.getByLabelText("Unselect every source"));

    expect(screen.getByText(messages.blockedScopeEmpty.body)).toBeInTheDocument();
    expect(screen.getByLabelText("Your question")).toBeDisabled();
  });
});

describe("the honest non-answers", () => {
  it("renders a refusal as a dignified answer, not an error", async () => {
    renderApp();
    await loaded();
    expect(screen.getByText(messages.refusedByModel.title)).toBeInTheDocument();
    expect(screen.getByText(/don't cover this/)).toBeInTheDocument();
  });

  it("shows which half of the search found each passage", async () => {
    const user = userEvent.setup();
    renderApp();
    await loaded();
    await user.click(screen.getByText(/retrieval ·/));
    // A dash under cosine means BM25 alone found it — the interesting case.
    const table = screen.getByRole("table");
    expect(within(table).getByText("0.810")).toBeInTheDocument();
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("citations across two documents", () => {
  it("opens the document the citation belongs to, not the first one", async () => {
    const user = userEvent.setup();
    const { router } = renderApp();
    await loaded();

    const [inline] = screen.getAllByRole("link", { name: /Citation 2: open dbms-notes\.md/ });
    await user.click(inline!);

    await waitFor(() => {
      const search = new URLSearchParams(router.state.location.search);
      expect(search.get("doc")).toBe(DOC_B);
      expect(search.get("cite")).toBe("t42.2");
    });
  });

  it("marks a citation current by identity, never by page number", async () => {
    const user = userEvent.setup();
    renderApp();
    await loaded();

    const [inline] = screen.getAllByRole("link", { name: /Citation 1: open Networking\.pdf/ });
    await user.click(inline!);

    await waitFor(() => {
      const one = screen.getAllByRole("link", { name: /Citation 1:/ })[0];
      expect(one).toHaveAttribute("aria-current", "true");
    });
    for (const two of screen.getAllByRole("link", { name: /Citation 2:/ })) {
      expect(two).not.toHaveAttribute("aria-current");
    }
  });

  it("heals a URL whose doc and citation disagree", async () => {
    // From a hand-edited link or a stale bookmark. The citation wins.
    const { router } = renderApp({
      url: `/n/networking?doc=${DOC_A}&page=48&cite=t42.2`,
    });
    await loaded();
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get("doc")).toBe(DOC_B);
    });
  });

  it("reproduces a deep link to a cited page", async () => {
    renderApp({ url: `/n/networking?doc=${DOC_A}&page=48&cite=t42.1` });
    await loaded();
    await waitFor(() => expect(screen.getByText(/cited here/)).toBeInTheDocument());
  });
});

describe("scope and the viewer are independent", () => {
  it("unticking the displayed source does not change what is displayed", async () => {
    const user = userEvent.setup();
    renderApp({ url: `/n/networking?doc=${DOC_A}` });
    await loaded();

    await user.click(screen.getByLabelText("Search Networking"));

    // Still the same document in the viewer header.
    const viewer = screen.getByLabelText("Document");
    expect(within(viewer).getByText("Networking")).toBeInTheDocument();
  });

  it("never falls back to another document when the asked-for one is gone", async () => {
    renderApp({ url: "/n/networking?doc=cccccccccccc&page=10" });
    await loaded();
    await waitFor(() => expect(screen.getByText(messages.sourceRemoved.title)).toBeInTheDocument());
    expect(screen.queryByText("dbms-notes.md")).not.toBeInTheDocument();
  });
});

describe("the source detail", () => {
  it("shows the ingest numbers that were actually measured", async () => {
    renderApp({ url: `/n/networking/source/${DOC_A}` });
    await waitFor(() => expect(screen.getByText("499")).toBeInTheDocument());
    expect(screen.getByText("2,474")).toBeInTheDocument();
    expect(screen.getByText("18.4s")).toBeInTheDocument();
  });

  it("says so plainly when a source has no measurements", async () => {
    renderApp({ url: `/n/networking/source/${DOC_B}` });
    await waitFor(() =>
      expect(screen.getByText(/No ingest measurements were recorded/)).toBeInTheDocument(),
    );
  });
});

describe("the keyboard", () => {
  it("opens the notebook palette on Ctrl+K, even while typing", async () => {
    const user = userEvent.setup();
    renderApp();
    await loaded();

    await user.click(screen.getByLabelText("Your question"));
    await user.type(screen.getByLabelText("Your question"), "half a question");
    await user.keyboard("{Control>}k{/Control}");

    await waitFor(() => expect(screen.getByLabelText("Notebook name")).toBeInTheDocument());
    // And the half-typed question is still there.
    expect(screen.getByLabelText("Your question")).toHaveValue("half a question");
  });

  it("filters the palette and navigates on Enter", async () => {
    const user = userEvent.setup();
    const { router } = renderApp();
    await loaded();

    await user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByLabelText("Notebook name");
    await user.type(search, "dbms");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(router.state.location.pathname).toBe("/n/dbms"));
  });

  it("focuses the composer on / but not while typing", async () => {
    const user = userEvent.setup();
    renderApp();
    await loaded();

    const composer = screen.getByLabelText("Your question");
    await user.keyboard("/");
    expect(composer).toHaveFocus();

    await user.keyboard("http://example.com/path");
    expect(composer).toHaveValue("http://example.com/path");
  });

  it("toggles the panes with [ and ]", async () => {
    const user = userEvent.setup();
    renderApp();
    await loaded();

    expect(screen.getByLabelText("Sources")).toBeInTheDocument();
    await user.keyboard("[[]");
    await waitFor(() => expect(screen.queryByLabelText("Sources")).not.toBeInTheDocument());
    await user.keyboard("[[]");
    await waitFor(() => expect(screen.getByLabelText("Sources")).toBeInTheDocument());
  });

  it("pages the document with the arrow keys, without filling the history", async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ url: `/n/networking?doc=${DOC_A}&page=10` });
    await loaded();

    const before = router.state.location.key;
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get("page")).toBe("11"),
    );
    expect(router.state.location.key).not.toBe(before);
    expect(router.state.historyAction).toBe("REPLACE");
  });
});

describe("the rail lists notebooks and sources together", () => {
  it("lists every notebook in the rail, not behind a dropdown", async () => {
    renderApp();
    await loaded();

    const rail = screen.getByLabelText("Notebooks");
    expect(within(rail).getByText("networking")).toBeInTheDocument();
    expect(within(rail).getByText("dbms")).toBeInTheDocument();
  });

  it("marks the notebook you are in", async () => {
    renderApp();
    await loaded();
    const rail = screen.getByLabelText("Notebooks");
    const current = within(rail).getByRole("link", { name: /networking/ });
    expect(current).toHaveAttribute("aria-current", "page");
  });

  it("offers to create a notebook even when notebooks already exist", async () => {
    const user = userEvent.setup();
    const created: unknown[] = [];
    server.use(
      http.post("/api/notebooks", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        created.push(body);
        return HttpResponse.json(
          { name: body.name, sources: 0, pages: 0, createdAt: null, lastMessageAt: null },
          { status: 201 },
        );
      }),
    );

    renderApp();
    await loaded();

    await user.click(screen.getByRole("button", { name: "New notebook" }));
    const input = await screen.findByLabelText("New notebook name");
    await user.type(input, "My Reading{Enter}");

    await waitFor(() => expect(created).toEqual([{ name: "My Reading" }]));
  });

  it("navigates into the notebook it just created", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/notebooks", () =>
        HttpResponse.json(
          { name: "fresh", sources: 0, pages: 0, createdAt: null, lastMessageAt: null },
          { status: 201 },
        ),
      ),
      http.get("/api/notebooks/fresh", () =>
        HttpResponse.json({ name: "fresh", sources: [], turns: [], totalTurns: 0 }),
      ),
    );

    const { router } = renderApp();
    await loaded();
    await user.click(screen.getByRole("button", { name: "New notebook" }));
    await user.type(await screen.findByLabelText("New notebook name"), "fresh{Enter}");

    await waitFor(() => expect(router.state.location.pathname).toBe("/n/fresh"));
  });

  it("cancels naming on Escape", async () => {
    const user = userEvent.setup();
    renderApp();
    await loaded();

    await user.click(screen.getByRole("button", { name: "New notebook" }));
    const input = await screen.findByLabelText("New notebook name");
    await user.type(input, "never mind{Escape}");

    await waitFor(() =>
      expect(screen.queryByLabelText("New notebook name")).not.toBeInTheDocument(),
    );
  });

  it("still offers to add a source when the notebook is empty", async () => {
    server.use(
      http.get("/api/notebooks/:name", () =>
        HttpResponse.json({ name: "networking", sources: [], turns: [], totalTurns: 0 }),
      ),
    );
    renderApp();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add a source/ })).toBeInTheDocument(),
    );
    // And a real file input behind it, not a button that does nothing.
    const rail = screen.getByLabelText("Sources");
    expect(rail.querySelector('input[type="file"]')).toBeInTheDocument();
  });

  it("asks before deleting a notebook, and sends nothing until confirmed", async () => {
    const user = userEvent.setup();
    let called = 0;
    server.use(
      http.delete("/api/notebooks/:name", () => {
        called += 1;
        return HttpResponse.json({ removed: true, sourcesReleased: 0, messagesRemoved: 0 });
      }),
    );

    renderApp();
    await loaded();

    await user.click(screen.getByRole("button", { name: "Delete dbms" }));

    expect(await screen.findByRole("button", { name: "Keep" })).toBeInTheDocument();
    expect(called).toBe(0);
  });

  it("reports what the server actually released, not what it assumed", async () => {
    const user = userEvent.setup();
    server.use(
      http.delete("/api/notebooks/:name", () =>
        HttpResponse.json({ removed: true, sourcesReleased: 1, messagesRemoved: 4 }),
      ),
    );

    renderApp();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Delete dbms" }));
    await user.click(await screen.findByRole("button", { name: messages.notebookDelete.action }));

    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent("1 source released");
    expect(note).toHaveTextContent("4 messages deleted");
  });

  it("leaves the notebook you were reading when you delete it", async () => {
    const user = userEvent.setup();
    server.use(
      http.delete("/api/notebooks/:name", () =>
        HttpResponse.json({ removed: true, sourcesReleased: 1, messagesRemoved: 0 }),
      ),
    );

    const { router } = renderApp();
    await loaded();

    // networking is the notebook on screen.
    await user.click(screen.getByRole("button", { name: "Delete networking" }));
    await user.click(await screen.findByRole("button", { name: messages.notebookDelete.action }));

    // Staying would leave the reader looking at a notebook that is gone.
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("stays where you are when you delete a different notebook", async () => {
    const user = userEvent.setup();
    let remaining = summaries;
    server.use(
      http.get("/api/notebooks", () => HttpResponse.json({ notebooks: remaining })),
      http.delete("/api/notebooks/:name", ({ params }) => {
        remaining = remaining.filter((entry) => entry.name !== params["name"]);
        return HttpResponse.json({ removed: true, sourcesReleased: 0, messagesRemoved: 0 });
      }),
    );

    const { router } = renderApp();
    await loaded();

    await user.click(screen.getByRole("button", { name: "Delete dbms" }));
    await user.click(await screen.findByRole("button", { name: messages.notebookDelete.action }));

    const notebooks = screen.getByLabelText("Notebooks");
    await waitFor(() =>
      expect(within(notebooks).queryByRole("link", { name: /dbms/ })).not.toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe("/n/networking");
  });

  it("puts the notebook back when the delete fails", async () => {
    const user = userEvent.setup();
    let served = 0;
    server.use(
      http.get("/api/notebooks", async () => {
        served += 1;
        if (served > 1) await delay("infinite");
        return HttpResponse.json({ notebooks: summaries });
      }),
      http.delete("/api/notebooks/:name", () => HttpResponse.json({}, { status: 500 })),
    );

    renderApp();
    await loaded();

    await user.click(screen.getByRole("button", { name: "Delete dbms" }));
    await user.click(await screen.findByRole("button", { name: messages.notebookDelete.action }));

    const notebooks = screen.getByLabelText("Notebooks");
    await waitFor(() =>
      expect(within(notebooks).getByRole("link", { name: /dbms/ })).toBeInTheDocument(),
    );
  });

  it("scrolls the notebooks inside their own box, not the whole rail", async () => {
    renderApp();
    await loaded();

    const notebooks = screen.getByLabelText("Notebooks");
    const sources = screen.getByLabelText("Sources");

    expect(notebooks.contains(sources)).toBe(false);
    expect(sources.contains(notebooks)).toBe(false);

    // Each list scrolls independently.
    expect(notebooks.querySelector("[data-scroll]")).not.toBeNull();
    expect(sources.querySelector("[data-scroll]")).not.toBeNull();
  });

  it("keeps the controls out of the scrolling lists", async () => {
    renderApp();
    await loaded();

    const notebooks = screen.getByLabelText("Notebooks");
    const sources = screen.getByLabelText("Sources");

    const notebookScroll = notebooks.querySelector("[data-scroll]")!;
    const sourceScroll = sources.querySelector("[data-scroll]")!;

    expect(notebookScroll.contains(screen.getByRole("button", { name: "New notebook" }))).toBe(
      false,
    );
    expect(sourceScroll.contains(screen.getByRole("button", { name: /Add a source/ }))).toBe(false);
  });
});
