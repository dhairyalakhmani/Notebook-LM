import { useCallback, useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { applyTheme, nextTheme, readTheme } from "./theme.ts";
import { IconButton, VisuallyHidden } from "../shared/ui/primitives.tsx";
import styles from "./layout.module.css";
import type { ThemeChoice } from "./theme.ts";

const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "Theme: following your system",
  light: "Theme: light",
  dark: "Theme: dark",
};

function announcementFor(pathname: string): string {
  const match = /^\/n\/([^/]+)(?:\/source\/(.+))?$/.exec(pathname);
  if (!match) return "";
  const notebook = decodeURIComponent(match[1]!);
  return match[2] ? `Source detail, ${notebook}` : `Conversation, ${notebook}`;
}

export function RootLayout() {
  const [theme, setTheme] = useState<ThemeChoice>(() => readTheme());
  const location = useLocation();
  const announcement = announcementFor(location.pathname);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const cycle = useCallback(() => setTheme((current) => nextTheme(current)), []);

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <Link to="/" className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            nb
          </span>
          <span>NoteBook</span>
        </Link>
        <div className={styles.barSpacer} />
        <IconButton
          icon={theme === "dark" ? "moon" : "sun"}
          label={THEME_LABEL[theme]}
          onClick={cycle}
        />
      </header>

      <Outlet />

      <div aria-live="polite" role="status">
        <VisuallyHidden>{announcement}</VisuallyHidden>
      </div>
    </div>
  );
}
