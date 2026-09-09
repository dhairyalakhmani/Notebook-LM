import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderApp } from "./renderApp.tsx";
import { server } from "./msw/server.ts";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function signedOut(): void {
  server.use(
    http.get("/api/auth/me", () =>
      HttpResponse.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 }),
    ),
  );
}

describe("signing in from a stale URL", () => {
  it("lands on the index rather than another account's notebook", async () => {
    const user = userEvent.setup();
    signedOut();
    server.use(
      http.post("/api/auth/login", () => {
        server.use(
          http.get("/api/auth/me", () =>
            HttpResponse.json({ user: "fresh", createdAt: "2026-01-01T00:00:00.000Z" }),
          ),
        );
        return HttpResponse.json(
          { user: "fresh", createdAt: "2026-01-01T00:00:00.000Z" },
          { status: 201 },
        );
      }),
      http.get("/api/notebooks", () => HttpResponse.json({ notebooks: [] })),
    );

    // The address left behind by whoever was signed in before.
    const { router } = renderApp({ url: "/n/networking" });

    await user.type(await screen.findByLabelText("Name"), "fresh");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    // And not the dead end this used to produce.
    expect(screen.queryByText(/No such notebook/i)).not.toBeInTheDocument();
  });
});

describe("a notebook URL that does not exist", () => {
  it("offers a way back instead of dead-ending", async () => {
    server.use(
      http.get("/api/notebooks/:name", () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "no notebook 'gone'" } },
          { status: 404 },
        ),
      ),
    );
    renderApp({ url: "/n/gone" });

    const back = await screen.findByRole("link", { name: /Back to your notebooks/i });
    expect(back).toHaveAttribute("href", "/");
  });
});

describe("the first notebook", () => {
  it("asks for a name instead of inventing one", async () => {
    const user = userEvent.setup();
    const created: unknown[] = [];
    server.use(
      http.get("/api/notebooks", () => HttpResponse.json({ notebooks: [] })),
      http.post("/api/notebooks", async ({ request }) => {
        created.push(await request.json());
        return HttpResponse.json(
          { name: "Thesis", sources: 0, pages: 0, createdAt: null, lastMessageAt: null },
          { status: 201 },
        );
      }),
    );

    // The index route is where the empty state lives.
    renderApp({ url: "/" });
    const field = await screen.findByLabelText("Name");
    await user.type(field, "Thesis");
    await user.click(screen.getByRole("button", { name: /Create a notebook/i }));

    // It used to post the hardcoded name "my notebook".
    await waitFor(() => expect(created).toEqual([{ name: "Thesis" }]));
  });
});

describe("the panes", () => {
  it("hides and shows the sources rail", async () => {
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getByLabelText("Notebooks and sources")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Hide sources" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Notebooks and sources")).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Show sources" }));
    await waitFor(() => expect(screen.getByLabelText("Notebooks and sources")).toBeInTheDocument());
  });
});

describe("signing out", () => {
  it("asks first, and does nothing until confirmed", async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.post("/api/auth/logout", () => {
        calls += 1;
        return HttpResponse.json({ ok: true });
      }),
    );

    renderApp();
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    const dialog = await screen.findByRole("dialog", { name: "Sign out" });
    expect(within(dialog).getByText(/Sign out of tester\?/)).toBeInTheDocument();
    expect(calls).toBe(0);

    await user.click(within(dialog).getByRole("button", { name: "Stay signed in" }));
    expect(calls).toBe(0);
  });

  it("signs out when confirmed", async () => {
    const user = userEvent.setup();
    let out = false;
    server.use(
      http.post("/api/auth/logout", () => {
        out = true;
        return HttpResponse.json({ ok: true });
      }),
      http.get("/api/auth/me", () =>
        out
          ? HttpResponse.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 })
          : HttpResponse.json({ user: "tester", createdAt: "2026-01-01T00:00:00.000Z" }),
      ),
    );

    renderApp();
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign out" });
    await user.click(within(dialog).getAllByRole("button", { name: "Sign out" })[0]!);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});
