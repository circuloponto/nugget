"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RotateCcw, TriangleAlert } from "lucide-react";
import Modal from "./Modal";
import Tabs from "./Tabs";
import { IC, IC_SM } from "./icons";

export type ThemeId = "yellow" | "bw" | "hc";

const THEMES: { id: ThemeId; label: string }[] = [
  { id: "yellow", label: "Yellow" },
  { id: "bw", label: "Black & white" },
  { id: "hc", label: "High contrast" },
];

/** Every colour the app uses, and where. Each is a CSS variable of the same name (--bg, --ink, ...). */
const TOKENS: { id: string; label: string; role: string }[] = [
  { id: "bg", label: "Background", role: "page, top bar, highlights, selected cards" },
  { id: "ink", label: "Ink", role: "text, borders, hard shadows, primary buttons" },
  { id: "card", label: "Card", role: "panels, menus, modals, fields" },
  { id: "accent", label: "Accent", role: "shadows, target notes, scrollbar, playhead (decorative; never text)" },
  { id: "muted", label: "Muted text", role: "hints and secondary text" },
  { id: "soft", label: "Soft line", role: "fret lines, table rules, grid" },
  { id: "faint", label: "Faint fill", role: "fret inlays, bar tracks, code" },
  { id: "hover", label: "Hover fill", role: "what a button turns when you point at it" },
  { id: "teal", label: "Data", role: "generator series, runs, highlighted patterns" },
  { id: "ok", label: "Valid", role: "text that says something is valid" },
  { id: "bad", label: "Error", role: "text for errors and warnings" },
];

type Overrides = Partial<Record<ThemeId, Record<string, string>>>;
const HEX = /^#[0-9a-f]{6}$/i;
const STORE_THEME = "nugget-theme";
const STORE_COLORS = "nugget-colors";

const readColors = (): Overrides => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_COLORS) ?? "{}");
    const out: Overrides = {};
    for (const t of THEMES) {
      const m = raw?.[t.id];
      if (m && typeof m === "object") out[t.id] = Object.fromEntries(Object.entries(m).filter(([k, v]) => TOKENS.some((x) => x.id === k) && typeof v === "string" && HEX.test(v))) as Record<string, string>;
    }
    return out;
  } catch {
    return {};
  }
};

function apply(theme: ThemeId, over: Overrides) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  for (const t of TOKENS) {
    const v = over[theme]?.[t.id];
    if (v) root.style.setProperty(`--${t.id}`, v);
    else root.style.removeProperty(`--${t.id}`);
  }
}

// ── contrast ────────────────────────────────────────────────────────────────
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const PAIRS: { fg: string; bg: string; label: string }[] = [
  { fg: "ink", bg: "card", label: "Ink on cards" },
  { fg: "ink", bg: "bg", label: "Ink on the page" },
  { fg: "muted", bg: "card", label: "Muted text on cards" },
  { fg: "bg", bg: "ink", label: "Page colour on ink (primary buttons)" },
  { fg: "bad", bg: "card", label: "Error text on cards" },
];

/** The settings dialog: theme and one colour picker per colour. It also applies the saved choices when the app opens. */
export default function Appearance({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [theme, setTheme] = useState<ThemeId>("yellow");
  const [over, setOver] = useState<Overrides>({});
  const [, force] = useState(0);

  // the page script has applied the saved theme and colours already; this mirrors them into the controls
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    const saved = readColors();
    const id: ThemeId = t === "bw" || t === "hc" ? t : "yellow";
    setTheme(id);
    setOver(saved);
    apply(id, saved);
  }, []);

  const save = useCallback((t: ThemeId, o: Overrides) => {
    try {
      localStorage.setItem(STORE_THEME, t);
      localStorage.setItem(STORE_COLORS, JSON.stringify(o));
    } catch {
      /* a blocked store only means the choice is not remembered */
    }
  }, []);

  const pickTheme = (t: ThemeId) => {
    setTheme(t);
    apply(t, over);
    save(t, over);
    force((n) => n + 1);
  };
  const setColor = (id: string, hex: string) => {
    const next: Overrides = { ...over, [theme]: { ...(over[theme] ?? {}), [id]: hex } };
    setOver(next);
    apply(theme, next);
    save(theme, next);
  };
  const resetOne = (id: string) => {
    const mine = { ...(over[theme] ?? {}) };
    delete mine[id];
    const next: Overrides = { ...over, [theme]: mine };
    setOver(next);
    apply(theme, next);
    save(theme, next);
  };
  const resetTheme = () => {
    const next: Overrides = { ...over, [theme]: {} };
    setOver(next);
    apply(theme, next);
    save(theme, next);
  };

  const value = (id: string): string => {
    const o = over[theme]?.[id];
    if (o) return o;
    if (typeof document === "undefined") return "#000000"; // server render: the dialog is closed, nothing is shown
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--${id}`).trim();
    return HEX.test(v) ? v.toLowerCase() : "#000000";
  };
  const changed = (id: string) => !!over[theme]?.[id];
  const nChanged = TOKENS.filter((t) => changed(t.id)).length;

  return (
    <Modal open={open} onClose={onClose} title="Settings" size="wide" testId="settings" footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <h3 style={{ marginTop: 0 }}>Theme</h3>
      <Tabs label="Theme" value={theme} onChange={pickTheme} tabs={THEMES.map((t) => ({ id: t.id, label: t.label, testId: `theme-${t.id}` }))} />
      <p className="hint" style={{ marginTop: 8 }}>Each theme keeps its own colours. Changes are saved on this computer and applied as the page opens.</p>

      <div className="appearance-head">
        <h3>Colours</h3>
        <button className="btn small" onClick={resetTheme} disabled={nChanged === 0} data-testid="colors-reset">
          <RotateCcw {...IC_SM} /> Reset this theme{nChanged ? ` (${nChanged})` : ""}
        </button>
      </div>
      <div className="swatch-grid" data-testid="swatches">
        {TOKENS.map((t) => {
          const v = value(t.id);
          return (
            <div key={t.id} className={`swatch${changed(t.id) ? " changed" : ""}`} data-token={t.id}>
              <input type="color" value={v} onChange={(e) => setColor(t.id, e.target.value)} aria-label={`${t.label} colour`} data-testid={`color-${t.id}`} />
              <span className="swatch-text">
                <b>{t.label}</b>
                <small>{t.role}</small>
              </span>
              <code>{v}</code>
              <button className="icon-btn" onClick={() => resetOne(t.id)} disabled={!changed(t.id)} aria-label={`Reset ${t.label}`} title="Back to the theme's own colour">
                <RotateCcw {...IC_SM} />
              </button>
            </div>
          );
        })}
      </div>

      <h3>Contrast of the colours you have chosen</h3>
      <ul className="contrast-list" data-testid="contrast">
        {PAIRS.map((p) => {
          const r = contrast(value(p.fg), value(p.bg));
          const level = r >= 7 ? "AAA" : r >= 4.5 ? "AA" : "below AA";
          return (
            <li key={p.label} className={r >= 4.5 ? "ok-row" : "warn-row"} data-pair={`${p.fg}-${p.bg}`}>
              {r >= 4.5 ? <Check {...IC_SM} /> : <TriangleAlert {...IC_SM} />}
              <span>{p.label}</span>
              <b>{r.toFixed(1)}:1</b>
              <small>{level}</small>
            </li>
          );
        })}
      </ul>
      <p className="hint">Text should reach 4.5:1 (AA); the design aims for 7:1. The accent colour is for shadows and marks only, so it is not checked as text.</p>
    </Modal>
  );
}
