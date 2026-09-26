import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Deep savanna-night palette: not casino-neon, not generic SaaS.
        ink: "#0E1512",        // near-black with a green undertone — the base surface
        panel: "#161F1A",      // card/panel surface, one step up from ink
        panelRaised: "#1E2A22",
        line: "#2A3730",       // hairline borders
        gold: "#C9A227",       // muted savanna-dusk gold — primary accent, used sparingly
        goldBright: "#E6C34D",
        ember: "#C9603C",      // secondary accent for odds/live/urgent states
        text: "#EDEFEA",
        textMuted: "#93A398",
        win: "#4C9A6A",
        loss: "#B25A4A",
      },
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [],
};

export default config;
