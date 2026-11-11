/**
 * Fixtures for the corpus tests: tiny MusicXML scores written by hand, so every expectation can be checked
 * by reading the score, plus a ZIP writer (stored or deflated) for the archive tests.
 */
import { corpus } from "../src";

export const DIV = 4; // divisions per quarter note: quarter 4, eighth 2, half 8, whole 16

export interface NoteSpec {
  /** "C4", "F#4", "Bb3", or "r" for a rest */
  readonly p: string;
  /** duration in divisions (quarter = 4) */
  readonly d: number;
  readonly type?: string;
  readonly dots?: number;
  readonly tie?: "start" | "stop" | "both";
  readonly tuplet?: readonly [number, number];
  readonly grace?: boolean;
  readonly extra?: string;
  /** raw alter override, e.g. 0.5 */
  readonly alter?: number;
}

const TYPE_BY_DIV: Record<number, string> = { 1: "16th", 2: "eighth", 4: "quarter", 8: "half", 16: "whole" };

export function note(s: NoteSpec): string {
  const rest = s.p === "r";
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s.p);
  const type = s.type ?? TYPE_BY_DIV[s.d];
  const pitch = rest
    ? "<rest/>"
    : `<pitch><step>${m![1]}</step>${s.alter !== undefined ? `<alter>${s.alter}</alter>` : m![2] ? `<alter>${m![2] === "#" ? 1 : -1}</alter>` : ""}<octave>${m![3]}</octave></pitch>`;
  const ties = s.tie === "start" || s.tie === "both" ? `<tie type="start"/>` : "";
  const ties2 = s.tie === "stop" || s.tie === "both" ? `<tie type="stop"/>` : "";
  const tm = s.tuplet ? `<time-modification><actual-notes>${s.tuplet[0]}</actual-notes><normal-notes>${s.tuplet[1]}</normal-notes></time-modification>` : "";
  const dots = "<dot/>".repeat(s.dots ?? 0);
  const nots = s.tie ? `<notations>${s.tie === "start" || s.tie === "both" ? `<tied type="start"/>` : ""}${s.tie === "stop" || s.tie === "both" ? `<tied type="stop"/>` : ""}</notations>` : "";
  if (s.grace) return `<note><grace slash="yes"/>${pitch}${type ? `<type>${type}</type>` : ""}</note>`;
  return `<note>${pitch}<duration>${s.d}</duration>${ties2}${ties}${type ? `<type>${type}</type>` : ""}${dots}${tm}${nots}${s.extra ?? ""}</note>`;
}

export const harmony = (root: string, kind: string, bass?: string, alter?: number): string =>
  `<harmony><root><root-step>${root}</root-step>${alter ? `<root-alter>${alter}</root-alter>` : ""}</root><kind>${kind}</kind>${bass ? `<bass><bass-step>${bass}</bass-step></bass>` : ""}</harmony>`;

export interface MeasureSpec {
  readonly body: string;
  readonly number?: string;
  readonly attrs?: string;
  readonly left?: string;
  readonly right?: string;
}

export function score(measures: readonly (string | MeasureSpec)[], opts: { beats?: number; beatType?: number; fifths?: number; mode?: string | null; title?: string; creator?: string; extraRoot?: string; parts?: number; doctype?: string } = {}): string {
  const beats = opts.beats ?? 4;
  const beatType = opts.beatType ?? 4;
  const mode = opts.mode === undefined ? "major" : opts.mode;
  const ms = measures.map((m, i) => {
    const spec: MeasureSpec = typeof m === "string" ? { body: m } : m;
    const attrs =
      i === 0
        ? `<attributes><divisions>${DIV}</divisions><key><fifths>${opts.fifths ?? 0}</fifths>${mode ? `<mode>${mode}</mode>` : ""}</key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`
        : "";
    return `<measure number="${spec.number ?? i + 1}">${attrs}${spec.attrs ?? ""}${spec.left ? `<barline location="left">${spec.left}</barline>` : ""}${spec.body}${spec.right ? `<barline location="right">${spec.right}</barline>` : ""}</measure>`;
  });
  const part = (id: string) => `<part id="${id}">${ms.join("")}</part>`;
  const partList = `<part-list><score-part id="P1"><part-name/></score-part>${opts.parts && opts.parts > 1 ? `<score-part id="P2"><part-name/></score-part>` : ""}</part-list>`;
  return `<?xml version="1.0" encoding="utf-8"?>${opts.doctype ?? `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">`}<score-partwise version="4.0"><work><work-title>${opts.title ?? "Test"}</work-title></work><identification>${opts.creator ? `<creator type="composer">${opts.creator}</creator>` : ""}</identification>${partList}${part("P1")}${opts.parts && opts.parts > 1 ? part("P2") : ""}${opts.extraRoot ?? ""}</score-partwise>`;
}

export const ctx = (id = "t1", catalog: Record<string, string> = {}): corpus.ImportContext => ({
  pieceId: id,
  provenance: { corpus: { id: "test-corpus", name: "Test corpus", license: "GPL-3.0", usage: "tests only" }, sourcePath: `${id}.musicxml`, format: "musicxml", catalog },
});

export function importOk(xml: string, id = "t1"): { piece: corpus.CorpusPiece; report: corpus.ImportReport } {
  const r = corpus.importMusicXml(xml, ctx(id));
  if (!r.ok) throw new Error("import failed: " + r.report.issues.map((i) => `${i.code}: ${i.message}`).join(" | "));
  return r;
}

export const codes = (r: corpus.ImportReport): string[] => r.issues.map((i) => i.code);

/** Build a melody line straight from a score body (4/4, divisions 4 unless told otherwise). */
export function lineOf(measures: readonly (string | MeasureSpec)[], opts: Parameters<typeof score>[1] = {}): corpus.MelodyLine {
  return corpus.melodyFromCorpusPiece(importOk(score(measures, opts)).piece);
}

/** A run of notes: "C4:2 D4:2 r:4 ..." (pitch:divisions). */
export function notes(spec: string): string {
  return spec
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [p, d] = tok.split(":");
      return note({ p: p!, d: Number(d) });
    })
    .join("");
}

// ── ZIP writer for tests ──────────────────────────────────────────────────
const enc = (s: string) => new TextEncoder().encode(s);
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as unknown as { CompressionStream: new (f: string) => { readable: { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } }; writable: { getWriter(): { write(c: Uint8Array): Promise<void>; close(): Promise<void> } } } }).CompressionStream;
  const cs = new CS("deflate-raw");
  const w = cs.writable.getWriter();
  void w.write(data).then(() => w.close());
  const r = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await r.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export interface ZipSpec {
  readonly name: string;
  readonly data: string | Uint8Array;
  readonly method?: 0 | 8;
  /** Override the header's claims, to build hostile archives. */
  readonly lie?: { readonly crc?: number; readonly usize?: number; readonly flags?: number };
}

export async function makeZip(files: readonly ZipSpec[]): Promise<Uint8Array> {
  const parts: number[][] = [];
  const central: number[][] = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === "string" ? enc(f.data) : f.data;
    const method = f.method ?? 8;
    const body = method === 8 ? await deflateRaw(raw) : raw;
    const crc = f.lie?.crc ?? corpus.crc32(raw);
    const usize = f.lie?.usize ?? raw.length;
    const flags = f.lie?.flags ?? 0;
    const name = enc(f.name);
    const local = [...le32(0x04034b50), ...le16(20), ...le16(flags), ...le16(method), ...le16(0), ...le16(0), ...le32(crc), ...le32(body.length), ...le32(usize), ...le16(name.length), ...le16(0), ...name, ...body];
    central.push([...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(flags), ...le16(method), ...le16(0), ...le16(0), ...le32(crc), ...le32(body.length), ...le32(usize), ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...name]);
    parts.push(local);
    offset += local.length;
  }
  const cd = central.flat();
  const eocd = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length), ...le32(cd.length), ...le32(offset), ...le16(0)];
  return new Uint8Array([...parts.flat(), ...cd, ...eocd]);
}
