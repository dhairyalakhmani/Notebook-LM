import { readStored, writeStored } from "../shared/lib/useLocalStorage.ts";

export type ThemeChoice = "system" | "light" | "dark";

export function readTheme(): ThemeChoice {
  const stored = readStored<ThemeChoice>("theme", "system");
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  writeStored("theme", choice);
}

export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return choice === "system" ? "light" : choice === "light" ? "dark" : "system";
}
