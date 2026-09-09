import { useState } from "react";
import { useLogin, useRegister } from "./api.ts";
import { asApiError } from "../../shared/lib/http.ts";
import { MIN_PASSWORD_CHARS } from "../../types.ts";
import { Button } from "../../shared/ui/primitives.tsx";
import styles from "./auth.module.css";

type Mode = "sign-in" | "create";

/**
 * The sign-in screen.
 *
 * One form for both modes, because they take the same fields and differ only in
 * which endpoint they post to. Errors come back from the server and are shown
 * verbatim: "that name and password do not match" is deliberately the same
 * message for a wrong password and an unknown name, so the screen must not
 * try to be more specific than the server was.
 */
export function SignIn() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  const login = useLogin();
  const register = useRegister();
  const pending = login.isPending || register.isPending;
  const failure = login.error ?? register.error;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const name = user.trim();
    if (name === "" || password === "") return;
    if (mode === "sign-in") {
      login.mutate({ user: name, password });
    } else {
      register.mutate({ user: name, password, ...(code.trim() ? { code: code.trim() } : {}) });
    }
  };

  return (
    <main className={styles.screen} data-scroll>
      <form className={styles.card} onSubmit={submit}>
        <h1 className={styles.title}>{mode === "sign-in" ? "Sign in" : "Create an account"}</h1>
        <p className={styles.blurb}>
          Your notebooks, sources and conversations are private to your account.
        </p>

        <div className={styles.field}>
          <label htmlFor="auth-name">Name</label>
          <input
            id="auth-name"
            className={styles.input}
            value={user}
            onChange={(event) => setUser(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={32}
            required
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            className={styles.input}
            type="password"
            {...(mode === "create" ? { "aria-describedby": "auth-password-hint" } : {})}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            // Tells the browser's password manager which of the two this is,
            // so it offers to save a new one rather than autofilling the old.
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            minLength={mode === "create" ? MIN_PASSWORD_CHARS : undefined}
            required
          />
          {mode === "create" ? (
            <span id="auth-password-hint" className={styles.hint}>
              At least {MIN_PASSWORD_CHARS} characters.
            </span>
          ) : null}
        </div>

        {mode === "create" ? (
          <div className={styles.field}>
            <label htmlFor="auth-code">Signup code</label>
            <input
              id="auth-code"
              className={styles.input}
              aria-describedby="auth-code-hint"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
            />
            <span id="auth-code-hint" className={styles.hint}>
              Only if you were given one.
            </span>
          </div>
        ) : null}

        {failure ? (
          <p className={styles.error} role="alert">
            {asApiError(failure).message}
          </p>
        ) : null}

        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"}
        </Button>

        <button
          type="button"
          className={styles.switch}
          onClick={() => {
            setMode(mode === "sign-in" ? "create" : "sign-in");
            login.reset();
            register.reset();
          }}
        >
          {mode === "sign-in" ? "No account yet? Create one" : "Already have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}
