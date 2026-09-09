import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useLogout } from "./api.ts";
import { Button } from "../../shared/ui/primitives.tsx";
import styles from "./auth.module.css";

/*
 * jsx-a11y models `dialog` as non-interactive, which a modal is not, and asks
 * for a keyboard handler beside the backdrop click - Escape, which the
 * platform handles and reports through `onClose`.
 */
/* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */

/**
 * Who is signed in, and a way out that asks first.
 *
 * This replaces a bare "x" beside the name, which read as "dismiss" and signed
 * you out on a single click with no confirmation. Signing out is cheap to undo
 * but annoying to do by accident, especially mid-question.
 *
 * A native `<dialog>`, so the focus trap, Escape handling and inert background
 * come from the platform rather than from code that has to remember them.
 */
export function SignOut({ user }: { user: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [asking, setAsking] = useState(false);
  const logout = useLogout();
  const navigate = useNavigate();

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (asking && !node.open) node.showModal();
    else if (!asking && node.open) node.close();
  }, [asking]);

  return (
    <span className={styles.who}>
      <span className={styles.name}>{user}</span>
      <Button variant="quiet" onClick={() => setAsking(true)}>
        Sign out
      </Button>

      <dialog
        ref={dialog}
        className={styles.confirmDialog}
        aria-label="Sign out"
        onClose={() => setAsking(false)}
        onClick={(event) => {
          if (event.target === dialog.current) setAsking(false);
        }}
      >
        {asking ? (
          <div className={styles.confirmInner}>
            <h2 className={styles.confirmTitle}>Sign out of {user}?</h2>
            <p className={styles.confirmBody}>
              Your notebooks stay where they are. You will need your password to come back.
            </p>
            <div className={styles.confirmActions}>
              <Button variant="quiet" onClick={() => setAsking(false)}>
                Stay signed in
              </Button>
              <Button
                variant="danger"
                disabled={logout.isPending}
                onClick={() =>
                  logout.mutate(undefined, {
                    onSettled: () => {
                      setAsking(false);
                      // Leave the notebook URL behind: it belongs to the
                      // account that is signing out.
                      void navigate("/", { replace: true });
                    },
                  })
                }
              >
                {logout.isPending ? "Signing out…" : "Sign out"}
              </Button>
            </div>
          </div>
        ) : null}
      </dialog>
    </span>
  );
}
