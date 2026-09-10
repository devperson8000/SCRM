// Theme definitions and application utilities

export type ThemeId =
  | "cyber-green"
  | "midnight-blue"
  | "purple-neon"
  | "ice-glass"
  | "hacker-terminal"
  | "classic";

export interface ThemeDef {
  id: ThemeId;
  label: string;
  accent: string;
  accentDim: string;
  accentGlow: string;
  accentBorder: string;
  accentText: string;
  bg: string;
  bgSecondary: string;
  swatchColor: string;
}

export const THEMES: ThemeDef[] = [
  {
    id: "cyber-green",
    label: "Cyber Green",
    accent: "#00ff88",
    accentDim: "rgba(0,255,136,0.15)",
    accentGlow: "rgba(0,255,136,0.3)",
    accentBorder: "rgba(0,255,136,0.4)",
    accentText: "#00ff88",
    bg: "#060c0e",
    bgSecondary: "#0a1214",
    swatchColor: "#00ff88",
  },
  {
    id: "classic",
    label: "Classic",
    accent: "#a078ff",
    accentDim: "rgba(160,120,255,0.15)",
    accentGlow: "rgba(160,120,255,0.3)",
    accentBorder: "rgba(160,120,255,0.4)",
    accentText: "#c0a0ff",
    bg: "#0a0818",
    bgSecondary: "#0f0d20",
    swatchColor: "#a078ff",
  },
  {
    id: "midnight-blue",
    label: "Midnight Blue",
    accent: "#00a8ff",
    accentDim: "rgba(0,168,255,0.15)",
    accentGlow: "rgba(0,168,255,0.3)",
    accentBorder: "rgba(0,168,255,0.4)",
    accentText: "#60c8ff",
    bg: "#060912",
    bgSecondary: "#0a0e1a",
    swatchColor: "#00a8ff",
  },
  {
    id: "purple-neon",
    label: "Purple Neon",
    accent: "#bf5fff",
    accentDim: "rgba(191,95,255,0.15)",
    accentGlow: "rgba(191,95,255,0.3)",
    accentBorder: "rgba(191,95,255,0.4)",
    accentText: "#d890ff",
    bg: "#090612",
    bgSecondary: "#0e0818",
    swatchColor: "#bf5fff",
  },
  {
    id: "ice-glass",
    label: "Ice Glass",
    accent: "#88d8ff",
    accentDim: "rgba(136,216,255,0.15)",
    accentGlow: "rgba(136,216,255,0.25)",
    accentBorder: "rgba(136,216,255,0.35)",
    accentText: "#aae4ff",
    bg: "#070b12",
    bgSecondary: "#0b1018",
    swatchColor: "#88d8ff",
  },
  {
    id: "hacker-terminal",
    label: "Hacker Terminal",
    accent: "#00ff41",
    accentDim: "rgba(0,255,65,0.12)",
    accentGlow: "rgba(0,255,65,0.28)",
    accentBorder: "rgba(0,255,65,0.38)",
    accentText: "#00ff41",
    bg: "#020805",
    bgSecondary: "#050f08",
    swatchColor: "#00ff41",
  },
];

export function getTheme(id: ThemeId): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

let themeStyleEl: HTMLStyleElement | null = null;

export function applyTheme(id: ThemeId): void {
  const t = getTheme(id);
  if (!themeStyleEl) {
    themeStyleEl = document.createElement("style");
    themeStyleEl.id = "scramjet-theme-vars";
    document.head.appendChild(themeStyleEl);
  }
  themeStyleEl.textContent = `
:root {
  --accent: ${t.accent};
  --accent-dim: ${t.accentDim};
  --accent-glow: ${t.accentGlow};
  --accent-border: ${t.accentBorder};
  --accent-text: ${t.accentText};
  --bg: ${t.bg};
  --bg-secondary: ${t.bgSecondary};
}
body { background: ${t.bg} !important; }
`;
}
