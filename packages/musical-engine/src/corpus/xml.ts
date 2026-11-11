/**
 * A small, strict XML reader for untrusted files (MusicXML from a corpus archive).
 *
 * Deliberately not a general XML parser:
 *  - no DTD processing and no custom entities: a DOCTYPE with an internal subset (`[ ... ]`) is refused,
 *    so "billion laughs" and external-entity tricks have nothing to work with. An external DOCTYPE
 *    (MusicXML's own) is skipped and never fetched;
 *  - only the five predefined entities and numeric references are expanded; anything else is an error;
 *  - bounded size, depth and node count;
 *  - malformed input throws XmlError with a line number; nothing is repaired silently.
 */

export class XmlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = "XmlError";
  }
}

export interface XNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XNode[];
  /** Concatenated character data directly inside this element, trimmed. */
  readonly text: string;
  /** 1-based line of the start tag. */
  readonly line: number;
}

export interface XmlLimits {
  readonly maxChars: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}
export const DEFAULT_XML_LIMITS: XmlLimits = { maxChars: 20_000_000, maxDepth: 64, maxNodes: 2_000_000 };

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;

export function parseXml(text: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XNode {
  if (typeof text !== "string") throw new XmlError("input is not text", 1);
  if (text.length > limits.maxChars) throw new XmlError(`file is larger than ${limits.maxChars} characters`, 1);
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  let i = 0;
  let line = 1;
  let nodes = 0;
  const fail = (m: string): never => {
    throw new XmlError(m, line);
  };
  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (src.charCodeAt(k) === 10) line++;
    i = to;
  };
  const skipSpace = () => {
    while (i < src.length && /\s/.test(src[i]!)) advance(i + 1);
  };
  const readName = (): string => {
    if (!NAME_START.test(src[i] ?? "")) fail(`expected a name, found ${JSON.stringify(src[i] ?? "end of file")}`);
    const start = i;
    while (i < src.length && NAME_CHAR.test(src[i]!)) i++;
    return src.slice(start, i);
  };
  const decode = (s: string): string =>
    s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (_all, body: string) => {
      if (body[0] === "#") {
        const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return fail(`invalid character reference &${body};`);
        return String.fromCodePoint(code);
      }
      const known: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
      const v = known[body];
      return v === undefined ? fail(`unknown entity &${body}; (custom entities are not supported)`) : v;
    });

  interface Open {
    name: string;
    attrs: Record<string, string>;
    children: XNode[];
    text: string[];
    line: number;
  }
  const stack: Open[] = [];
  let root: XNode | null = null;

  const close = (open: Open): XNode => ({ name: open.name, attrs: open.attrs, children: open.children, text: open.text.join("").trim(), line: open.line });

  while (i < src.length) {
    if (src[i] !== "<") {
      const next = src.indexOf("<", i);
      const end = next === -1 ? src.length : next;
      const chunk = src.slice(i, end);
      if (stack.length === 0) {
        if (chunk.trim() !== "") fail("text outside the root element");
      } else if (chunk.includes("]]>")) fail("']]>' in character data");
      else stack[stack.length - 1]!.text.push(decode(chunk));
      advance(end);
      continue;
    }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end === -1) fail("unterminated comment");
      advance(end + 3);
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end === -1) fail("unterminated CDATA section");
      if (stack.length === 0) fail("CDATA outside the root element");
      stack[stack.length - 1]!.text.push(src.slice(i + 9, end));
      advance(end + 3);
    } else if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end === -1) fail("unterminated processing instruction");
      advance(end + 2);
    } else if (src.startsWith("<!DOCTYPE", i)) {
      if (root || stack.length) fail("DOCTYPE after the root element has started");
      // Scan to the closing '>' honouring quotes; refuse an internal subset.
      let k = i + 9;
      let quote = "";
      for (; k < src.length; k++) {
        const c = src[k]!;
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "[") fail("a DOCTYPE with an internal subset (entity declarations) is refused");
        else if (c === ">") break;
      }
      if (k >= src.length) fail("unterminated DOCTYPE");
      advance(k + 1);
    } else if (src.startsWith("</", i)) {
      advance(i + 2);
      const name = readName();
      skipSpace();
      if (src[i] !== ">") fail(`malformed closing tag </${name}`);
      advance(i + 1);
      const open = stack.pop();
      if (!open) fail(`unexpected closing tag </${name}>`);
      else if (open.name !== name) fail(`closing tag </${name}> does not match <${open.name}> opened on line ${open.line}`);
      else {
        const node = close(open);
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(node);
        else root = node;
      }
    } else if (src.startsWith("<!", i)) {
      fail("unsupported markup declaration");
    } else {
      advance(i + 1);
      const startLine = line;
      const name = readName();
      const attrs: Record<string, string> = {};
      for (;;) {
        skipSpace();
        const c = src[i];
        if (c === ">" || c === "/") break;
        if (c === undefined) fail(`unterminated tag <${name}`);
        const an = readName();
        skipSpace();
        if (src[i] !== "=") fail(`attribute ${an} has no value`);
        advance(i + 1);
        skipSpace();
        const q = src[i];
        if (q !== '"' && q !== "'") fail(`attribute ${an} value must be quoted`);
        const end = src.indexOf(q!, i + 1);
        if (end === -1) fail(`unterminated value for attribute ${an}`);
        const raw = src.slice(i + 1, end);
        if (raw.includes("<")) fail(`'<' inside attribute ${an}`);
        if (an in attrs) fail(`duplicate attribute ${an}`);
        attrs[an] = decode(raw);
        advance(end + 1);
      }
      if (root && stack.length === 0) fail("more than one root element");
      if (++nodes > limits.maxNodes) fail("too many elements");
      if (stack.length >= limits.maxDepth) fail(`nesting deeper than ${limits.maxDepth}`);
      const open: Open = { name, attrs, children: [], text: [], line: startLine };
      if (src[i] === "/") {
        advance(i + 1);
        if (src[i] !== ">") fail(`malformed empty tag <${name}`);
        advance(i + 1);
        const node = close(open);
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(node);
        else root = node;
      } else {
        advance(i + 1);
        stack.push(open);
      }
    }
  }
  if (stack.length) fail(`unclosed element <${stack[stack.length - 1]!.name}> opened on line ${stack[stack.length - 1]!.line}`);
  if (!root) fail("no root element");
  return root as unknown as XNode;
}

// ── navigation helpers ────────────────────────────────────────────────────
export const child = (n: XNode, name: string): XNode | undefined => n.children.find((c) => c.name === name);
export const childrenNamed = (n: XNode, name: string): XNode[] => n.children.filter((c) => c.name === name);
export const childText = (n: XNode, name: string): string | undefined => child(n, name)?.text;
