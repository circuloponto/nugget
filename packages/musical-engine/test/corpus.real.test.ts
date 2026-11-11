/// <reference types="node" />
/**
 * Regression pins on the REAL first corpus (Nottingham starter, 24 tunes). The archive is GPL-3.0 research data and
 * is git-ignored, so these tests skip when it is absent. They pin what was measured, with tolerances where the
 * measure is a heuristic, so a change in importer or analysis behaviour is noticed.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { corpus, validateMusicIR } from "../src";

const path = new URL("../../../data/corpus/incoming/nugget_folk_starter.zip", import.meta.url);
const present = existsSync(path);

describe.skipIf(!present)("the real Nottingham starter corpus", async () => {
  const contents = await corpus.readZip(new Uint8Array(present ? readFileSync(path) : []));
  const result = corpus.importArchive(contents);
  const analyses = result.pieces.map((p) => corpus.analyzeCorpusPiece(p.piece));
  const aggregate = corpus.aggregateAnalyses(analyses);

  it("opens without refused entries and keeps its licence", () => {
    expect(contents.entries).toHaveLength(59);
    expect(contents.refused).toEqual([]);
    expect(result.archiveIssues).toEqual([]);
    expect(result.corpus.license).toMatch(/GPL-3\.0/);
    expect(result.corpus.usage).toMatch(/commercial/);
  });

  it("imports 23 of 24 tunes; the 24th is genuinely two-voice and is refused, not flattened", () => {
    expect(result.pieces).toHaveLength(23);
    expect(result.failed.map((f) => [f.id, f.report.issues[0]!.code])).toEqual([["ashover_43_verdi-s-waltz", "chord-note"]]);
  });

  it("every imported tune is valid MusicIR, with provenance and its original ABC", () => {
    for (const p of result.pieces) {
      expect(p.ir, p.piece.id).not.toBeNull();
      expect(validateMusicIR(p.ir)).toEqual([]);
      expect(p.piece.provenance.originalNotation?.format).toBe("abc");
      expect(p.piece.provenance.catalog.title).toBeTruthy();
    }
  });

  it("matches the original ABC note for note in 22 tunes; Applejack's Reel lost one note in conversion", () => {
    const exact = result.pieces.filter((p) => p.report.fidelity!.checked && p.report.fidelity!.lostNotes === 0 && p.report.fidelity!.extraNotes === 0);
    expect(exact).toHaveLength(22);
    const bad = result.pieces.filter((p) => !exact.includes(p));
    expect(bad.map((p) => p.piece.id)).toEqual(["reel_12_applejack-s-reel"]);
    expect(bad[0]!.report.fidelity!.lostNotes).toBe(1);
    expect(bad[0]!.report.issues.map((i) => i.code)).toContain("note-lost-in-conversion");
  });

  it("only 2 of the 50 rests in the converted MusicXML are written in the originals; the rest are converter padding", () => {
    const written = analyses.reduce((a, x) => a + x.rhythm.restCount, 0);
    const suspect = analyses.reduce((a, x) => a + x.rhythm.suspectRests, 0);
    expect({ written, suspect }).toEqual({ written: 2, suspect: 48 });
    expect(aggregate.pooled.rhythm.rests.piecesWithRests).toBe(1);
  });

  it("records the notation features that are present, and none that are not", () => {
    const c = (k: keyof corpus.ImportCounts) => result.pieces.reduce((a, p) => a + p.report.counts[k], 0);
    expect(c("notes")).toBe(2307);
    expect(c("graceNotes")).toBe(0);
    expect(c("tiedChains")).toBeGreaterThan(30);
    expect(c("tupletNotes")).toBeGreaterThan(70);
    expect(c("meterChanges")).toBe(1);
    expect(c("keyChanges")).toBe(2);
    expect(result.pieces.filter((p) => p.piece.measures.some((m) => m.pickup))).toHaveLength(16);
  });

  it("finds almost every written repeat end as a phrase boundary, and phrases of a plausible length", () => {
    let written = 0;
    let found = 0;
    for (const p of result.pieces) {
      const line = corpus.melodyFromCorpusPiece(p.piece);
      const sel = new Set(corpus.analyzePhrases(line).candidates.filter((c) => c.selected).map((c) => c.index));
      line.notes.slice(0, -1).forEach((n, k) => {
        if (line.bars[n.bar]!.repeat?.backward && line.notes[k + 1]!.bar !== n.bar) {
          written++;
          if (sel.has(k)) found++;
        }
      });
    }
    expect(written).toBe(22);
    expect(found).toBeGreaterThanOrEqual(20);
    const bars = aggregate.pooled.phrases.barsPerPhrase;
    expect(bars.median).toBeGreaterThanOrEqual(1.5);
    expect(bars.median).toBeLessThanOrEqual(4);
    expect(bars.p25).toBeGreaterThanOrEqual(1);
  });

  it("measures what this corpus does: long runs of short notes are normal, and are usually followed by a held note", () => {
    const p = aggregate.pooled;
    expect(p.rhythm.shortRuns.shareOfNotesInRunsOf8Plus).toBeGreaterThan(0.3);
    expect(p.melody.joint.burstThenHoldShare).toBeGreaterThan(0.55);
    expect(p.melody.intervalClasses.step).toBeGreaterThan(0.5);
    expect(p.harmony.byStrength.strong).toBeGreaterThan(p.harmony.byStrength.weak);
  });

  it("is reproducible: importing and analysing again gives identical JSON", async () => {
    const again = corpus.importArchive(await corpus.readZip(new Uint8Array(readFileSync(path))));
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
    expect(JSON.stringify(corpus.aggregateAnalyses(again.pieces.map((p) => corpus.analyzeCorpusPiece(p.piece))))).toBe(JSON.stringify(aggregate));
  });
});
