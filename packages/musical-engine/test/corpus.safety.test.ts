import { describe, expect, it } from "vitest";
import { corpus } from "../src";
import { makeZip } from "./corpus.helpers";

describe("the XML reader is strict about untrusted input", () => {
  it("parses elements, attributes, text, CDATA, comments, processing instructions and a BOM", () => {
    const root = corpus.parseXml('\ufeff<?xml version="1.0"?><!-- c --><a x="1" y=\'two\'><b>t &amp; &lt;u&gt; &#65;&#x42;</b><c/><d><![CDATA[<raw>]]></d></a>');
    expect(root.name).toBe("a");
    expect(root.attrs).toEqual({ x: "1", y: "two" });
    expect(corpus.childText(root, "b")).toBe("t & <u> AB");
    expect(corpus.child(root, "c")).toBeDefined();
    expect(corpus.childText(root, "d")).toBe("<raw>");
  });

  it("skips MusicXML's own external DOCTYPE without fetching anything", () => {
    const root = corpus.parseXml('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd"><score-partwise/>');
    expect(root.name).toBe("score-partwise");
  });

  it("refuses a DOCTYPE with an internal subset (entity bombs and external entities)", () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';
    expect(() => corpus.parseXml(bomb)).toThrow(/internal subset/);
    const xxe = '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d>&x;</d>';
    expect(() => corpus.parseXml(xxe)).toThrow(/internal subset/);
  });

  it("rejects custom entities even without a DOCTYPE", () => {
    expect(() => corpus.parseXml("<a>&lol;</a>")).toThrow(/unknown entity/);
    expect(() => corpus.parseXml("<a>&#xD800;</a>")).toThrow(/character reference/);
  });

  it("reports malformed structure with a line number and repairs nothing", () => {
    const cases: [string, RegExp][] = [
      ["<a><b></a>", /does not match/],
      ["<a>", /unclosed element/],
      ["<a></a><b/>", /more than one root/],
      ["text<a/>", /text outside/],
      ['<a x="1" x="2"/>', /duplicate attribute/],
      ["<a x=1/>", /must be quoted/],
      ['<a x="<"/>', /'<' inside attribute/],
      ["<a><!-- open </a>", /unterminated comment/],
      ["", /no root/],
      ["</a>", /unexpected closing/],
    ];
    for (const [src, re] of cases) expect(() => corpus.parseXml(src), src).toThrow(re);
    try {
      corpus.parseXml("<a>\n<b>\n</a>");
    } catch (e) {
      expect(e).toBeInstanceOf(corpus.XmlError);
      expect((e as corpus.XmlError).line).toBe(3);
    }
  });

  it("bounds size, depth and element count", () => {
    expect(() => corpus.parseXml("<a><a><a><a/></a></a></a>", { maxChars: 1000, maxDepth: 3, maxNodes: 100 })).toThrow(/nesting deeper/);
    expect(() => corpus.parseXml("<a/>".repeat(1) + " ".repeat(10), { maxChars: 5, maxDepth: 9, maxNodes: 9 })).toThrow(/larger than/);
    expect(() => corpus.parseXml("<r>" + "<x/>".repeat(20) + "</r>", { maxChars: 1000, maxDepth: 9, maxNodes: 10 })).toThrow(/too many elements/);
  });
});

describe("the ZIP reader treats the archive as hostile", () => {
  it("reads stored and deflated entries and verifies them", async () => {
    const zip = await makeZip([
      { name: "a/hello.txt", data: "hello world ".repeat(50), method: 8 },
      { name: "b.txt", data: "stored", method: 0 },
    ]);
    const z = await corpus.readZip(zip);
    expect(z.refused).toEqual([]);
    expect(z.entries.map((e) => e.path)).toEqual(["a/hello.txt", "b.txt"]);
    expect(new TextDecoder().decode(z.entries[1]!.bytes)).toBe("stored");
    expect(z.entries[0]!.bytes.length).toBe("hello world ".length * 50);
  });

  it("refuses entries whose names escape the folder, and says why", async () => {
    const zip = await makeZip([
      { name: "../evil.txt", data: "x" },
      { name: "/abs.txt", data: "x" },
      { name: "C:\\win.txt", data: "x" },
      { name: "ok/../../up.txt", data: "x" },
      { name: "fine.txt", data: "x" },
    ]);
    const z = await corpus.readZip(zip);
    expect(z.entries.map((e) => e.path)).toEqual(["fine.txt"]);
    expect(z.refused.map((r) => r.name)).toEqual(["../evil.txt", "/abs.txt", "C:\\win.txt", "ok/../../up.txt"]);
    expect(z.refused.every((r) => r.reason.length > 0)).toBe(true);
    expect(corpus.sanitizeZipPath("a\\b/c.txt")).toEqual({ ok: true, path: "a/b/c.txt" });
  });

  it("detects corruption (CRC) and lying size headers", async () => {
    const zip = await makeZip([
      { name: "bad-crc.txt", data: "some content here", lie: { crc: 12345 } },
      { name: "bad-size.txt", data: "some content here", lie: { usize: 4 }, method: 0 },
      { name: "good.txt", data: "fine" },
    ]);
    const z = await corpus.readZip(zip);
    expect(z.entries.map((e) => e.path)).toEqual(["good.txt"]);
    expect(z.refused.find((r) => r.name === "bad-crc.txt")!.reason).toMatch(/CRC/);
    expect(z.refused.find((r) => r.name === "bad-size.txt")!.reason).toMatch(/size/);
  });

  it("stops a decompression bomb by its inflated size, not by trusting the header", async () => {
    const zip = await makeZip([{ name: "bomb.txt", data: "A".repeat(2_000_000), lie: { usize: 1000 } }]);
    const z = await corpus.readZip(zip, { maxEntries: 10, maxEntryBytes: 1_000_000, maxTotalBytes: 2_000_000, maxRatio: 100000 });
    expect(z.entries).toEqual([]);
    expect(z.refused[0]!.reason).toMatch(/inflates|size|decompress/);
  });

  it("refuses an extreme compression ratio and oversized declared entries", async () => {
    const zip = await makeZip([{ name: "ratio.txt", data: "A".repeat(500_000) }, { name: "small.txt", data: "ok" }]);
    const z = await corpus.readZip(zip, { maxEntries: 10, maxEntryBytes: 10_000_000, maxTotalBytes: 10_000_000, maxRatio: 50 });
    expect(z.entries.map((e) => e.path)).toEqual(["small.txt"]);
    expect(z.refused[0]!.reason).toMatch(/ratio/);
    const big = await corpus.readZip(zip, { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 10_000_000, maxRatio: 1e9 });
    expect(big.refused.find((r) => r.name === "ratio.txt")!.reason).toMatch(/declared size/);
  });

  it("refuses encrypted entries and duplicate names, and caps the entry count and total size", async () => {
    const zip = await makeZip([
      { name: "secret.txt", data: "x", lie: { flags: 1 } },
      { name: "dup.txt", data: "one" },
      { name: "dup.txt", data: "two" },
    ]);
    const z = await corpus.readZip(zip);
    expect(z.entries.map((e) => e.path)).toEqual(["dup.txt"]);
    expect(z.refused.map((r) => r.reason).join("|")).toMatch(/encrypted.*duplicate/);
    await expect(corpus.readZip(zip, { maxEntries: 2, maxEntryBytes: 1e6, maxTotalBytes: 1e6, maxRatio: 1000 })).rejects.toThrow(/entries/);
    const two = await makeZip([{ name: "a", data: "x".repeat(600) , method: 0}, { name: "b", data: "y".repeat(600), method: 0 }]);
    await expect(corpus.readZip(two, { maxEntries: 5, maxEntryBytes: 1e6, maxTotalBytes: 1000, maxRatio: 1000 })).rejects.toThrow(/inflates to more than/);
  });

  it("rejects files that are not ZIPs, and truncated ZIPs, without throwing anything odd", async () => {
    await expect(corpus.readZip(new TextEncoder().encode("this is not a zip file at all"))).rejects.toThrow(/not a ZIP/);
    const zip = await makeZip([{ name: "a.txt", data: "hello" }]);
    await expect(corpus.readZip(zip.slice(0, zip.length - 30))).rejects.toThrow();
  });
});
