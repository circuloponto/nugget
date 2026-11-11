/**
 * Source-fidelity cross-check. A converter can produce well-formed MusicXML whose measures add up and whose
 * notation is still wrong: music21 turns a missing or incomplete bar into rests ("padding"), and can drop a note
 * at a strain end. Neither shows up in the MusicXML alone. When the original notation is kept next to the
 * converted score, this aligns the two sequences of notes and rests and reports where they disagree.
 *
 * Only ABC is understood today. Other sources report `checked: false`; nothing is guessed.
 */
import type { CorpusPiece, ImportIssue } from "./types";

export interface FidelityReport {
  readonly checked: boolean;
  readonly reason?: string;
  readonly abcNotes: number;
  readonly abcRests: number;
  readonly xmlNotes: number;
  readonly xmlRests: number;
  /** Notes written in the original that have no counterpart in the conversion. */
  readonly lostNotes: number;
  /** Notes in the conversion that the original does not have. */
  readonly extraNotes: number;
  /** Ids of rests in the conversion that the original does not write: suspected converter padding. */
  readonly paddingRests: readonly string[];
  /** Rests the original writes that the conversion lacks. */
  readonly lostRests: number;
}

type Tok = "N" | "R";

/** Notes and rests of an ABC tune body, in order. Chords/grace notes/decorations/lyrics are not counted as notes. */
export function abcTokens(abc: string): Tok[] {
  const body = abc
    .split(/\r?\n/)
    .filter((l) => !/^[A-Za-z]:/.test(l) && !l.trimStart().startsWith("%"))
    .join("\n")
    .replace(/%.*$/gm, "")
    .replace(/"[^"]*"/g, "")
    .replace(/![^!]*!/g, "")
    .replace(/\+[^+]*\+/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\[[A-Za-z]:[^\]]*\]/g, "");
  const out: Tok[] = [];
  for (const c of body) {
    if (/[A-Ga-g]/.test(c)) out.push("N");
    else if (c === "z" || c === "Z" || c === "x" || c === "X") out.push("R");
  }
  return out;
}

export function pieceTokens(piece: CorpusPiece): { tok: Tok; id: string }[] {
  const out: { tok: Tok; id: string }[] = [];
  for (const e of piece.events) {
    if (e.kind === "rest") out.push({ tok: "R", id: e.id });
    else for (let k = 0; k < (e.tiedParts?.length ?? 1); k++) out.push({ tok: "N", id: e.id });
  }
  return out;
}

export function crossCheckAbc(piece: CorpusPiece): FidelityReport {
  const abc = piece.provenance.originalNotation;
  const xml = pieceTokens(piece);
  const base = { abcNotes: 0, abcRests: 0, xmlNotes: xml.filter((t) => t.tok === "N").length, xmlRests: xml.filter((t) => t.tok === "R").length, lostNotes: 0, extraNotes: 0, paddingRests: [] as string[], lostRests: 0 };
  if (!abc || abc.format !== "abc") return { checked: false, reason: abc ? `original notation is ${abc.format}, which is not understood` : "no original notation is kept", ...base };
  const a = abcTokens(abc.text);
  const maxTokens = 5000;
  if (a.length > maxTokens || xml.length > maxTokens) return { checked: false, reason: "too long to align", ...base };
  const n = a.length;
  const m = xml.length;
  // longest common subsequence of the suffixes, so that walking forward pairs the EARLIEST equal tokens
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === xml[j]!.tok ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  let i = 0;
  let j = 0;
  let lostNotes = 0;
  let lostRests = 0;
  let extraNotes = 0;
  const padding: string[] = [];
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === xml[j]!.tok && dp[i]![j] === dp[i + 1]![j + 1]! + 1) {
      i++;
      j++;
    } else if (j >= m || (i < n && dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      if (a[i] === "N") lostNotes++;
      else lostRests++;
      i++;
    } else {
      const t = xml[j]!;
      if (t.tok === "R") padding.push(t.id);
      else extraNotes++;
      j++;
    }
  }
  return { checked: true, abcNotes: a.filter((t) => t === "N").length, abcRests: a.filter((t) => t === "R").length, xmlNotes: base.xmlNotes, xmlRests: base.xmlRests, lostNotes, extraNotes, paddingRests: [...new Set(padding)], lostRests };
}

/** The piece with unmatched rests marked as suspected converter padding (their time is kept; their meaning is not trusted). */
export function applyFidelity(piece: CorpusPiece, f: FidelityReport): CorpusPiece {
  if (!f.checked || f.paddingRests.length === 0) return piece;
  const pad = new Set(f.paddingRests);
  return { ...piece, events: piece.events.map((e) => (e.kind === "rest" && pad.has(e.id) ? { ...e, suspect: "converter-padding" as const } : e)) };
}

export function fidelityIssues(f: FidelityReport): ImportIssue[] {
  if (!f.checked) return [{ severity: "info", code: "fidelity-unchecked", message: `the conversion was not compared with the original: ${f.reason}` }];
  const out: ImportIssue[] = [];
  if (f.lostNotes > 0) out.push({ severity: "warning", code: "note-lost-in-conversion", message: `the original writes ${f.lostNotes} note(s) that the converted score lacks (abc ${f.abcNotes} vs xml ${f.xmlNotes}); the converter replaced them with rests or dropped them` });
  if (f.extraNotes > 0) out.push({ severity: "warning", code: "note-added-in-conversion", message: `the converted score has ${f.extraNotes} note(s) the original does not write` });
  if (f.paddingRests.length > 0) out.push({ severity: "warning", code: "converter-padding-rests", message: `${f.paddingRests.length} of ${f.xmlRests} rests are not in the original notation (it writes ${f.abcRests}); they are suspected converter padding and are excluded from silence statistics` });
  if (f.lostRests > 0) out.push({ severity: "warning", code: "rest-lost-in-conversion", message: `the original writes ${f.lostRests} rest(s) that the converted score lacks` });
  return out;
}
