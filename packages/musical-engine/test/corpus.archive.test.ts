import { describe, expect, it } from "vitest";
import { corpus, validateMusicIR } from "../src";
import { harmony, makeZip, note, score } from "./corpus.helpers";

const good = (extra = "") => score([harmony("C", "major") + note({ p: "C4", d: 8 }) + note({ p: "E4", d: 8 }) + extra, harmony("G", "dominant") + note({ p: "D4", d: 16 })], { title: "Good" });
const chordy = score([note({ p: "C4", d: 8 }) + `<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>8</duration></note>` + note({ p: "D4", d: 8 })]);

const manifest = (pieces: unknown[], extra: object = {}) =>
  JSON.stringify({ dataset: "Test Folk — cleaned", dataset_repository: "https://example.org/repo", dataset_license: "GNU General Public License version 3 (GPL-3.0)", license_url: "https://example.org/LICENSE", conversion: "music21 ABC-to-MusicXML", pieces, ...extra });

const entry = (stem: string, extra: object = {}) => ({ file_stem: stem, title: `Title ${stem}`, category: "reel", meter: "4/4", key: "C", source_annotation: "A. Singer", musicxml_file: `MusicXML/${stem}.musicxml`, abc_file: `ABC/${stem}.abc`, ...extra });

async function open(files: { name: string; data: string }[]) {
  return corpus.readZip(await makeZip(files));
}

describe("importing a corpus archive", () => {
  it("imports each listed piece, keeps licence, attribution and the original notation, and projects to MusicIR", async () => {
    const z = await open([
      { name: "pack/manifest.json", data: manifest([entry("one"), entry("two")]) },
      { name: "pack/MusicXML/one.musicxml", data: good() },
      { name: "pack/MusicXML/two.musicxml", data: good() },
      { name: "pack/ABC/one.abc", data: "X:1\nT:One\nK:C\nCEG|\n" },
      { name: "pack/ABC/two.abc", data: "X:2\nT:Two\nK:C\nCEG|\n" },
    ]);
    const r = corpus.importArchive(z);
    expect(r.archiveIssues).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.pieces.map((p) => p.piece.id)).toEqual(["one", "two"]);
    expect(r.corpus).toMatchObject({ license: "GNU General Public License version 3 (GPL-3.0)", repository: "https://example.org/repo", licenseUrl: "https://example.org/LICENSE" });
    expect(r.corpus.usage).toMatch(/commercial/);
    const p = r.pieces[0]!.piece;
    expect(p.provenance.catalog).toMatchObject({ source_annotation: "A. Singer", category: "reel", title: "Title one" });
    expect(p.provenance.originalNotation).toMatchObject({ format: "abc", path: "pack/ABC/one.abc" });
    expect(p.provenance.originalNotation!.text).toContain("T:One");
    expect(p.provenance.conversion).toEqual({ from: "abc", tool: "music21 ABC-to-MusicXML" });
    expect(r.pieces.every((x) => x.ir && validateMusicIR(x.ir).length === 0)).toBe(true);
  });

  it("a piece that fails is reported with its reasons while the others still import", async () => {
    const z = await open([
      { name: "manifest.json", data: manifest([entry("ok"), entry("poly"), entry("gone")]) },
      { name: "MusicXML/ok.musicxml", data: good() },
      { name: "MusicXML/poly.musicxml", data: chordy },
    ]);
    const r = corpus.importArchive(z);
    expect(r.pieces.map((p) => p.piece.id)).toEqual(["ok"]);
    expect(r.failed.map((f) => [f.id, f.report.issues[0]!.code])).toEqual([["poly", "chord-note"], ["gone", "musicxml-missing"]]);
    expect(r.failed.every((f) => f.report.status === "failed")).toBe(true);
  });

  it("warns about scores the manifest does not list and originals it cannot find", async () => {
    const z = await open([
      { name: "manifest.json", data: manifest([entry("one")]) },
      { name: "MusicXML/one.musicxml", data: good() },
      { name: "MusicXML/stray.musicxml", data: good() },
    ]);
    const r = corpus.importArchive(z);
    const codes = r.archiveIssues.map((i) => i.code);
    expect(codes).toContain("unlisted-score");
    expect(codes).toContain("original-missing");
    expect(r.pieces).toHaveLength(1);
  });

  it("treats the manifest as untrusted: unsafe ids, escaping paths, duplicates, wrong shapes", async () => {
    const z = await open([
      { name: "manifest.json", data: manifest([entry("../evil"), entry("ok", { musicxml_file: "../../etc/passwd" }), entry("dup"), entry("dup"), 7, entry("fine")]) },
      { name: "MusicXML/dup.musicxml", data: good() },
      { name: "MusicXML/fine.musicxml", data: good() },
    ]);
    const r = corpus.importArchive(z);
    expect(r.pieces.map((p) => p.piece.id)).toEqual(["dup", "fine"]);
    expect(r.failed.map((f) => f.id)).toEqual(["ok"]);
    const msgs = r.archiveIssues.map((i) => i.message).join(" | ");
    expect(msgs).toMatch(/unsafe/);
    expect(msgs).toMatch(/duplicate piece id dup/);
    expect(msgs).toMatch(/not an object/);
  });

  it("reports a missing or ambiguous manifest, bad JSON, and a missing licence", async () => {
    expect(corpus.importArchive(await open([{ name: "a.txt", data: "x" }])).archiveIssues[0]!.code).toBe("no-manifest");
    expect(corpus.importArchive(await open([{ name: "a/manifest.json", data: "{}" }, { name: "b/manifest.json", data: "{}" }])).archiveIssues[0]!.code).toBe("several-manifests");
    expect(corpus.importArchive(await open([{ name: "manifest.json", data: "{not json" }])).archiveIssues[0]!.code).toBe("manifest-unreadable");
    expect(corpus.importArchive(await open([{ name: "manifest.json", data: JSON.stringify({ pieces: "no" }) }])).archiveIssues[0]!.code).toBe("manifest-shape");
    const nolic = corpus.importArchive(await open([{ name: "manifest.json", data: JSON.stringify({ pieces: [] }) }]));
    expect(nolic.archiveIssues.map((i) => i.code)).toContain("license-missing");
    expect(nolic.corpus.license).toBe("unknown");
  });

  it("surfaces refused zip entries instead of hiding them", async () => {
    const z = await open([
      { name: "manifest.json", data: manifest([entry("one")]) },
      { name: "MusicXML/one.musicxml", data: good() },
      { name: "../escape.musicxml", data: good() },
    ]);
    const r = corpus.importArchive(z);
    expect(r.archiveIssues.map((i) => i.code)).toContain("entry-refused");
    expect(r.pieces).toHaveLength(1);
  });

  it("the whole import is deterministic", async () => {
    const files = [
      { name: "manifest.json", data: manifest([entry("one"), entry("two")]) },
      { name: "MusicXML/one.musicxml", data: good() },
      { name: "MusicXML/two.musicxml", data: good("") },
    ];
    const a = corpus.importArchive(await open(files));
    const b = corpus.importArchive(await open(files));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
