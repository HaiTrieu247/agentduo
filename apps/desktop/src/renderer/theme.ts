// Light, dark or as the system is, and the font size: on the document, where styles.css reads them. The reused chat
// styles read VS Code's theme variables, which styles.css defines for each theme.
export type Theme = "system" | "light" | "dark";
export const FONT_RANGE = { min: 11, max: 20, default: 13 } as const;

export function resolveTheme(theme: Theme, systemDark: boolean): "light" | "dark" {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

export function clampFontSize(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : FONT_RANGE.default;
  return Math.min(FONT_RANGE.max, Math.max(FONT_RANGE.min, v));
}

export function applyAppearance(o: { theme: Theme; dark: boolean; fontSize: number }, doc: Document = document): "light" | "dark" {
  const resolved = resolveTheme(o.theme, o.dark);
  doc.documentElement.dataset.theme = resolved;
  doc.documentElement.style.setProperty("--font-size", `${clampFontSize(o.fontSize)}px`);
  doc.documentElement.style.colorScheme = resolved;
  // The chat's own styles tune small status text for light themes by this class, as in VS Code.
  doc.body.classList.toggle("vscode-light", resolved === "light");
  doc.body.classList.toggle("vscode-dark", resolved === "dark");
  return resolved;
}
