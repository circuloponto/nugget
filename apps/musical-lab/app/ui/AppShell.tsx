"use client";

import { useCallback, useEffect, useState } from "react";
import PhraseConstructor from "../phrase/PhraseConstructor";
import MusicalLab from "../lab/MusicalLab";
import CorpusExplorer from "../corpus/CorpusExplorer";
import ComparisonView from "../corpus/compare/ComparisonView";
import Lab from "../Lab";
import { Settings } from "lucide-react";
import Appearance from "./Appearance";
import { IC } from "./icons";
import { ShellContext } from "./shellContext";

export type ViewId = "workbench" | "lab" | "corpus" | "compare" | "evaluator";

const VIEWS: { id: ViewId; label: string; title: string; path: string }[] = [
  { id: "workbench", label: "Workbench", title: "Melodic Workbench", path: "/" },
  { id: "lab", label: "Lab", title: "Musical Lab", path: "/lab" },
  { id: "corpus", label: "Corpus", title: "Corpus Analysis", path: "/corpus" },
  { id: "compare", label: "Generator vs corpus", title: "Generator against the corpus", path: "/corpus/compare" },
  { id: "evaluator", label: "Evaluator", title: "Engine evaluator", path: "/evaluator" },
];

export const viewFromPath = (pathname: string): ViewId => {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/corpus/compare") return "compare";
  if (p === "/corpus") return "corpus";
  if (p === "/lab") return "lab";
  if (p === "/evaluator") return "evaluator";
  return "workbench"; // "/" and "/phrase"
};

/** A pixel nugget with a hard red shadow, drawn from a grid of squares like the rest of the look. */
const NUGGET = ["..XXXX..", ".XXXXXX.", "XXXXAXXX", "XXXXXXXX", "XXXXXXX.", ".XXXXX..", "..XXX..."];
function Logo() {
  const px = 4;
  const cells = NUGGET.flatMap((row, y) => [...row].map((c, x) => ({ c, x, y }))).filter((p) => p.c !== ".");
  return (
    <svg className="brand-logo" width="34" height="30" viewBox="0 0 34 30" aria-hidden="true" shapeRendering="crispEdges">
      {cells.map((p) => (
        <rect key={`s${p.x}-${p.y}`} x={p.x * px + 2} y={p.y * px + 2} width={px} height={px} fill="var(--accent)" />
      ))}
      {cells.map((p) => (
        <rect key={`i${p.x}-${p.y}`} x={p.x * px} y={p.y * px} width={px} height={px} fill={p.c === "A" ? "var(--bg)" : "var(--ink)"} />
      ))}
    </svg>
  );
}

/**
 * The one page of the app. The top bar carries the brand, the view tabs and the active view's own tools; every view
 * fills the rest of the window and scrolls only inside its panels, with the detail in modals and tabs. Views the user
 * has opened stay mounted (hidden), so switching tabs loses neither a result nor the audio position. The old URLs still
 * open the right view directly.
 */
export default function AppShell({ initial }: { initial: ViewId }) {
  const [view, setView] = useState<ViewId>(initial);
  const [visited, setVisited] = useState<ReadonlySet<ViewId>>(new Set([initial]));
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const go = useCallback((id: ViewId, push = true) => {
    setView(id);
    setVisited((v) => (v.has(id) ? v : new Set([...v, id])));
    if (push) window.history.pushState({ view: id }, "", VIEWS.find((x) => x.id === id)!.path);
  }, []);

  useEffect(() => {
    const onPop = () => go(viewFromPath(window.location.pathname), false);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [go]);

  useEffect(() => {
    document.title = `${VIEWS.find((v) => v.id === view)!.title} — Nugget`;
  }, [view]);

  const current = VIEWS.find((v) => v.id === view)!;
  const show = (id: ViewId) => visited.has(id);

  return (
    <ShellContext.Provider value={{ slot }}>
      <div className="shell">
        <header className="shell-top">
          <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go("workbench"); }} aria-label="Nugget, home">
            <Logo />
            <span>Nugget</span>
          </a>
          <span className="shell-sep" aria-hidden="true" />
          <h1 className="shell-title" data-testid="shell-title">{current.title}</h1>
          <nav className="shell-tabs" aria-label="Views">
            {VIEWS.map((v) => (
              <button key={v.id} className={v.id === view ? "on" : ""} aria-current={v.id === view ? "page" : undefined} onClick={() => go(v.id)} data-testid={`nav-${v.id}`}>
                {v.label}
              </button>
            ))}
          </nav>
          <div className="shell-tools" ref={setSlot} data-testid="shell-tools" />
          <button className="tool-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings: theme and colours" data-testid="shell-settings">
            <Settings {...IC} />
          </button>
        </header>

        <div className="views">
          <section className="view" hidden={view !== "workbench"} aria-label="Melodic Workbench">
            {show("workbench") && <PhraseConstructor active={view === "workbench"} />}
          </section>
          <section className="view" hidden={view !== "lab"} aria-label="Musical Lab">
            {show("lab") && <MusicalLab active={view === "lab"} />}
          </section>
          <section className="view" hidden={view !== "corpus"} aria-label="Corpus Analysis">
            {show("corpus") && <CorpusExplorer active={view === "corpus"} />}
          </section>
          <section className="view" hidden={view !== "compare"} aria-label="Generator against the corpus">
            {show("compare") && <ComparisonView active={view === "compare"} />}
          </section>
          <section className="view" hidden={view !== "evaluator"} aria-label="Engine evaluator">
            {show("evaluator") && <Lab active={view === "evaluator"} />}
          </section>
        </div>
      </div>
      <Appearance open={settingsOpen} onClose={closeSettings} />
    </ShellContext.Provider>
  );
}
