/*
 * Minimal .xlsx / .csv reader (no dependencies). Reads the first worksheet of an
 * Excel workbook into an array of rows (arrays of strings). Uses the browser's
 * DecompressionStream to unzip the workbook. Date cells become YYYY-MM-DD.
 */
(function (root) {
  "use strict";
  const td = new TextDecoder();

  async function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("ფაილი Excel (.xlsx) ფორმატში არ არის");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = {};
    for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      entries[td.decode(u8.subarray(p + 46, p + 46 + nlen))] = { method, csize, off };
      p += 46 + nlen + elen + clen;
    }
    return async (name) => {
      const e = entries[name];
      if (!e) return null;
      const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
      const data = u8.subarray(start, start + e.csize);
      if (e.method === 0) return td.decode(data);
      const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
      return td.decode(out);
    };
  }

  const xml = (s) => new DOMParser().parseFromString(s, "application/xml");
  const byTag = (node, tag) => Array.from(node.getElementsByTagNameNS("*", tag));
  const colIndex = (ref) => { const m = /^([A-Z]+)/.exec(ref || ""); let n = 0; if (m) for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const serialToDate = (v) => new Date(Date.UTC(1899, 11, 30) + Math.round(Number(v) * 86400000)).toISOString().slice(0, 10);

  async function readXlsx(buf) {
    const read = await unzip(buf);
    const wb = xml(await read("xl/workbook.xml"));
    const first = byTag(wb, "sheet")[0];
    if (!first) throw new Error("Excel-ში ფურცელი ვერ მოიძებნა");
    const rid = first.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || first.getAttribute("r:id");
    let target = "worksheets/sheet1.xml";
    const relsTxt = await read("xl/_rels/workbook.xml.rels");
    if (relsTxt) { const rel = byTag(xml(relsTxt), "Relationship").find((r) => r.getAttribute("Id") === rid); if (rel) target = rel.getAttribute("Target"); }
    const path = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    const sstTxt = await read("xl/sharedStrings.xml");
    const strings = sstTxt ? byTag(xml(sstTxt), "si").map((si) => byTag(si, "t").map((t) => t.textContent).join("")) : [];
    // Which cell styles are dates
    const dateStyles = new Set();
    const stylesTxt = await read("xl/styles.xml");
    if (stylesTxt) {
      const st = xml(stylesTxt);
      const custom = {};
      byTag(st, "numFmt").forEach((f) => (custom[f.getAttribute("numFmtId")] = f.getAttribute("formatCode") || ""));
      const cellXfs = byTag(st, "cellXfs")[0];
      if (cellXfs) Array.from(cellXfs.children).forEach((xf, i) => {
        const id = Number(xf.getAttribute("numFmtId") || 0);
        const code = custom[id] || "";
        if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, ""))) dateStyles.add(i);
      });
    }
    const sheet = xml(await read(path));
    const rows = [];
    byTag(sheet, "row").forEach((r) => {
      const out = [];
      byTag(r, "c").forEach((c) => {
        const t = c.getAttribute("t"), s = Number(c.getAttribute("s") || 0);
        const v = byTag(c, "v")[0], is = byTag(c, "is")[0];
        let val = "";
        if (t === "s") val = strings[Number(v && v.textContent)] || "";
        else if (t === "inlineStr") val = is ? byTag(is, "t").map((x) => x.textContent).join("") : "";
        else if (t === "b") val = v && v.textContent === "1" ? "TRUE" : "FALSE";
        else if (v) val = !t && dateStyles.has(s) && /^\d+(\.\d+)?$/.test(v.textContent) ? serialToDate(v.textContent) : v.textContent;
        out[colIndex(c.getAttribute("r"))] = String(val).trim();
      });
      rows.push(Array.from(out, (x) => x || ""));
    });
    return rows.filter((r) => r.some((x) => x));
  }

  function readCsv(text) {
    const delim = (text.split(/\r?\n/)[0].match(/;/g) || []).length > (text.split(/\r?\n/)[0].match(/,/g) || []).length ? ";" : text.includes("\t") ? "\t" : ",";
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell.trim()); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
    return rows.filter((r) => r.some((x) => x));
  }

  async function readTable(file) {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 2));
    if (head[0] === 0x50 && head[1] === 0x4b) return readXlsx(buf); // "PK" zip
    if (/\.xls$/i.test(file.name)) throw new Error("ძველი .xls ფორმატი არ არის მხარდაჭერილი. შეინახეთ ფაილი .xlsx-ად.");
    return readCsv(td.decode(buf).replace(/^﻿/, ""));
  }

  root.TableReader = { readTable, readXlsx, readCsv };
})(typeof window !== "undefined" ? window : globalThis);
