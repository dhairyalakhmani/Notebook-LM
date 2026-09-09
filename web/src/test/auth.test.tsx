import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderApp } from "./renderApp.tsx";
import { server } from "./msw/server.ts";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Nobody is signed in: what a first visitor gets. */
function signedOut(): void {
  server.use(
    http.get("/api/auth/me", () =>
      HttpResponse.json(
        { error: { code: "unauthorized", message: "not signed in" } },
        {
          status: 401,
        },
      ),
    ),
  );
}

describe("signing in", () => {
  it("shows the sign-in screen instead of the app when nobody is signed in", async () => {
    signedOut();
    renderApp();

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    // The point of gating in the layout: no notebook UI renders at all.
    expect(screen.queryByLabelText("Notebooks")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New notebook" })).not.toBeInTheDocument();
  });

  it("sends what you typed and then shows the app", async () => {
    const user = userEvent.setup();
    signedOut();
    const sent: unknown[] = [];
    server.use(
      http.post("/api/auth/login", async ({ request }) => {
        sent.push(await request.json());
        // From here on the session exists.
        server.use(
          http.get("/api/auth/me", () =>
            HttpResponse.json({ user: "ada", createdAt: "2026-01-01T00:00:00.000Z" }),
          ),
        );
        return HttpResponse.json(
          { user: "ada", createdAt: "2026-01-01T00:00:00.000Z" },
          { status: 201 },
        );
      }),
    );

    renderApp();
    await user.type(await screen.findByLabelText("Name"), "ada");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(sent).toEqual([{ user: "ada", password: "a-long-enough-password" }]),
    );
    // And the app appears, without a reload.
    await waitFor(() => expect(screen.getByLabelText("Notebooks")).toBeInTheDocument());
  });

  it("shows the server's message when the password is wrong, and keeps the form", async () => {
    const user = userEvent.setup();
    signedOut();
    server.use(
      http.post("/api/auth/login", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "that name and password do not match" } },
          { status: 401 },
        ),
      ),
    );

    renderApp();
    await user.type(await screen.findByLabelText("Name"), "ada");
    await user.type(screen.getByLabelText("Password"), "wrong-password-here");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("that name and password do not match");
    // Not thrown away: the name is still there to correct the password against.
    expect(screen.getByLabelText("Name")).toHaveValue("ada");
  });

  it("does not ask for a signup code when the server does not require one", async () => {
    const user = userEvent.setup();
    signedOut();
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Create one/ }));
    // An input that is usually pointless reads as something you are missing.
    expect(screen.queryByLabelText("Signup code")).not.toBeInTheDocument();
  });

  it("asks for a signup code when the server does require one", async () => {
    const user = userEvent.setup();
    signedOut();
    server.use(
      http.get("/api/health", () =>
        HttpResponse.json({
          apiVersion: 1,
          signupCodeRequired: true,
          groqModel: "test-model",
          embedder: { modelId: "test-embedder", dimensions: 384 },
          notebooks: 0,
        }),
      ),
    );
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Create one/ }));
    expect(await screen.findByLabelText("Signup code")).toBeInTheDocument();
  });

  it("switches to creating an account and posts to register", async () => {
    const user = userEvent.setup();
    signedOut();
    const sent: unknown[] = [];
    server.use(
      http.post("/api/auth/register", async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json(
          { user: "grace", createdAt: "2026-01-01T00:00:00.000Z" },
          { status: 201 },
        );
      }),
      http.get("/api/auth/me", () =>
        HttpResponse.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 }),
      ),
    );

    renderApp();
    await user.click(await screen.findByRole("button", { name: /Create one/ }));
    expect(screen.getByRole("heading", { name: "Create an account" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "grace");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(sent).toEqual([{ user: "grace", password: "a-long-enough-password" }]),
    );
  });
});

describe("when signed in", () => {
  it("shows which account you are using", async () => {
    renderApp();
    expect(await screen.findByText("tester")).toBeInTheDocument();
    // Signing out is a labelled button that asks first; the flow itself is
    // covered in signedIn.test.tsx.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});
