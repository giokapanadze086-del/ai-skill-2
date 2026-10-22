/*
 * BTU AI Skills Digital Passport: PDF generator.
 * Fills BTU's blank multi-page template (assets/passport-template.pdf) with a
 * passport version's data. Output is deterministic: the same version data
 * always produces byte-identical PDF, so the document hash registered on the
 * blockchain can be re-checked at any time.
 *
 * Requires the global PDFLib (pdf-lib 1.17.1).
 */
(function (root) {
  "use strict";

  // Template geometry in PDF points, measured from the TOP-left corner of an
  // A4 landscape page (841.89 x 595.28). Converted to pdf-lib's bottom-left
  // origin with Y().
  const PAGE_H = 595.276;
  const Y = (top) => PAGE_H - top;

  const T = {
    cover: {
      name: { x: 196, base: 272, size: 20 },
      surname: { x: 246, base: 313.5, size: 20 },
      date: { x: 650, base: 266, size: 15 },
      passportId: { x: 684, base: 510, size: 11 },
      code: { x: 115, labelBase: 503, codeBase: 517 },
    },
    // "PASSPORT ID:" label positions per template page (value goes after/below)
    idAfter: { 2: { x: 153, base: 491 }, 4: { x: 153, base: 491 } },
    idBelow: { 1: { x: 684, base: 510 }, 3: { x: 684, base: 510 } },
    // Page 2 legend: the template still prints the old stamp icons, so they are
    // covered and redrawn in the current design. box = [x0, top, x1, bottom].
    legend: [
      { category: "AI Skill", box: [449, 125.5, 540, 156.5], cx: 494.5, cy: 140, scale: 0.68 },
      { category: "AI Applied Skill", box: [673.5, 127.5, 764, 157], cx: 719, cy: 142, scale: 0.78 },
      { category: "AI Advanced Skill", box: [517.5, 278, 629, 308], cx: 573, cy: 293, scale: 0.72 },
    ],
    grid: {
      cols: [[78, 208.5], [217.5, 348.5], [357.5, 487.9], [496.9, 627.9], [636.9, 767.4]],
      rows: [[138.5, 290.5], [300, 452]],
    },
    table: {
      cols: { stamp: [81.5, 204], skill: [204, 300.5], desc: [300.5, 445.4], through: [445.4, 620.4], date: [620.4, 763.9] },
      rows: [[189.5, 243], [243, 297], [297, 351], [351, 405], [405, 459.5]],
    },
  };

  // Stamp designs (BTU passport design, October 2026):
  //   AI Skill          red triangle      "AI SKILL / FOCUSED LEARNING"
  //   AI Applied Skill  purple tilted bar "AI APPLIED SKILL / APPLIED LEARNING"
  //   AI Advanced Skill navy round seal   "AI ADVANCED SKILL / EXTENDED ACADEMIC LEARNING"
  const STAMP = {
    "AI Skill": { color: [255, 59, 59], title: "AI SKILL", sub: "FOCUSED LEARNING", angle: -4, shape: "triangle" },
    "AI Applied Skill": { color: [94, 0, 255], title: "AI APPLIED SKILL", sub: "APPLIED LEARNING", angle: 6, shape: "bar" },
    "AI Advanced Skill": { color: [20, 36, 120], title: "AI ADVANCED SKILL", sub: "EXTENDED ACADEMIC LEARNING", angle: 0, shape: "seal" },
  };

  const fmtDate = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split("-"); return d + "." + m + "." + y; };

  function wrap(text, font, size, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(test, size) <= maxWidth || !line) line = test;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Draws centered multi-line text inside [x0,x1], vertically centered on midTop (top-origin).
  function centeredBlock(page, lines, font, size, x0, x1, midTop, color, lead) {
    const lh = lead || size * 1.2;
    const total = lines.length * lh;
    let top = midTop - total / 2;
    for (const ln of lines) {
      const w = font.widthOfTextAtSize(ln, size);
      page.drawText(ln, { x: x0 + (x1 - x0 - w) / 2, y: Y(top + size * 0.95), size, font, color });
      top += lh;
    }
  }

  // Centered text stack in the stamp's local coordinates (origin = stamp centre, y up).
  function stack(page, items, white, yTop) {
    let y = yTop;
    for (const it of items) {
      y -= it.size;
      const w = it.font.widthOfTextAtSize(it.text, it.size);
      page.drawText(it.text, { x: -w / 2, y, size: it.size, font: it.font, color: white });
      y -= it.gap == null ? it.size * 0.18 : it.gap;
    }
  }

  function drawStamp(PDFLib, page, fonts, category, cx, cyTop, scale, angle) {
    const { rgb, pushGraphicsState, popGraphicsState, translate, rotateDegrees } = PDFLib;
    const st = STAMP[category];
    if (!st) return;
    const s = scale || 1;
    const col = rgb(st.color[0] / 255, st.color[1] / 255, st.color[2] / 255);
    const white = rgb(1, 1, 1);
    page.pushOperators(pushGraphicsState(), translate(cx, Y(cyTop)), rotateDegrees(angle == null ? st.angle : angle));
    if (st.shape === "triangle") {
      // SVG path coordinates (y down) relative to the centre.
      const w = 64 * s, h = 54 * s, top = -h * 0.52;
      page.drawSvgPath("M 0 " + top + " L " + w / 2 + " " + (top + h) + " L " + -w / 2 + " " + (top + h) + " Z", { x: 0, y: 0, color: col });
      const k = 9 * s; // inner chevron parallel to the two upper edges
      page.drawSvgPath("M " + -k + " " + (top + 2.3 * k) + " L 0 " + (top + 0.8 * k) + " L " + k + " " + (top + 2.3 * k), { x: 0, y: 0, borderColor: white, borderWidth: 0.7 * s });
      stack(page, [
        { text: "AI", font: fonts.bold, size: 6.2 * s, gap: 0.6 * s },
        { text: "SKILL", font: fonts.bold, size: 6.2 * s, gap: 1.4 * s },
        { text: "FOCUSED", font: fonts.reg, size: 3.9 * s, gap: 0.5 * s },
        { text: "LEARNING", font: fonts.reg, size: 3.9 * s },
      ], white, 4.5 * s);
    } else if (st.shape === "seal") {
      const r = 27 * s;
      page.drawCircle({ x: 0, y: 0, size: r, color: col });
      page.drawCircle({ x: 0, y: 0, size: r - 2.6 * s, borderColor: white, borderWidth: 0.6 * s });
      stack(page, [
        { text: "AI", font: fonts.bold, size: 4.6 * s, gap: 0.5 * s },
        { text: "ADVANCED", font: fonts.bold, size: 4.6 * s, gap: 0.5 * s },
        { text: "SKILL", font: fonts.bold, size: 4.6 * s, gap: 1.6 * s },
        { text: "EXTENDED", font: fonts.reg, size: 3.3 * s, gap: 0.4 * s },
        { text: "ACADEMIC", font: fonts.reg, size: 3.3 * s, gap: 0.4 * s },
        { text: "LEARNING", font: fonts.reg, size: 3.3 * s },
      ], white, 14.6 * s);
    } else {
      const w = 112 * s, h = 32 * s;
      page.drawRectangle({ x: -w / 2, y: -h / 2, width: w, height: h, color: col });
      page.drawRectangle({ x: -w / 2 + 2.5 * s, y: -h / 2 + 2.5 * s, width: w - 5 * s, height: h - 5 * s, borderColor: white, borderWidth: 0.6 * s });
      const tSize = 10 * s, sSize = 7 * s;
      const tW = fonts.bold.widthOfTextAtSize(st.title, tSize);
      const sW = fonts.reg.widthOfTextAtSize(st.sub, sSize);
      page.drawText(st.title, { x: -tW / 2, y: 1.4 * s, size: tSize, font: fonts.bold, color: white });
      page.drawText(st.sub, { x: -sW / 2, y: -7.6 * s, size: sSize, font: fonts.reg, color: white });
      page.drawLine({ start: { x: -sW / 2, y: -9.2 * s }, end: { x: sW / 2, y: -9.2 * s }, thickness: 0.5 * s, color: white });
    }
    page.pushOperators(popGraphicsState());
  }

  function drawPassportId(page, fonts, pid, tplIndex, black) {
    const after = T.idAfter[tplIndex], below = T.idBelow[tplIndex];
    if (after) page.drawText(pid, { x: after.x, y: Y(after.base), size: 11, font: fonts.bold, color: black });
    if (below) page.drawText(pid, { x: below.x, y: Y(below.base), size: 11, font: fonts.bold, color: black });
  }

  /**
   * data: {
   *   passportId, firstName, lastName, firstIssued (YYYY-MM-DD),
   *   version (e.g. "V2"), issuedAt (ISO), verificationCode,
   *   skills: [{ recordId, skillId, name, category, description, earnedThrough, dateEarned }]
   * }
   */
  async function build(data, templateBytes) {
    const PDFLib = root.PDFLib;
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const tpl = await PDFDocument.load(templateBytes, { updateMetadata: false });
    const doc = await PDFDocument.create({ updateMetadata: false });
    const fonts = { bold: await doc.embedFont(StandardFonts.HelveticaBold), reg: await doc.embedFont(StandardFonts.Helvetica), mono: await doc.embedFont(StandardFonts.CourierBold) };
    const black = rgb(0.07, 0.07, 0.07), white = rgb(1, 1, 1), grey = rgb(0.35, 0.35, 0.35);
    const skills = data.skills.slice();
    const gridPages = Math.max(1, Math.ceil(skills.length / 10));
    const tablePages = Math.max(1, Math.ceil(skills.length / 5));
    const order = [0, 1].concat(Array(gridPages).fill(2), Array(tablePages).fill(3));
    const copied = await doc.copyPages(tpl, order);
    copied.forEach((p) => doc.addPage(p));
    const pages = doc.getPages();
    const verifyUrl = `https://ai-skill-pink.vercel.app/#verify?code=${encodeURIComponent(data.verificationCode)}`;
    const qrApiUrl = `https://quickchart.io/qr?text=${encodeURIComponent(verifyUrl)}&size=150&margin=1`;


    const qrImageBytes = await fetch(qrApiUrl).then((res) => res.arrayBuffer());
    const qrImage = await doc.embedPng(qrImageBytes);

    // ---- Page 1: cover ----
  
    const p1 = pages[0];
    p1.drawText(data.firstName.toUpperCase(), { x: T.cover.name.x, y: Y(T.cover.name.base), size: T.cover.name.size, font: fonts.reg, color: black });
    p1.drawText(data.lastName.toUpperCase(), { x: T.cover.surname.x, y: Y(T.cover.surname.base), size: T.cover.surname.size, font: fonts.reg, color: black });
    p1.drawText(fmtDate(data.firstIssued), { x: T.cover.date.x, y: Y(T.cover.date.base), size: T.cover.date.size, font: fonts.reg, color: black });
    drawPassportId(p1, fonts, data.passportId, 1, black);
    p1.drawText("VERIFICATION CODE (" + data.version + ")", { x: T.cover.code.x, y: Y(T.cover.code.labelBase), size: 7, font: fonts.bold, color: grey });
    p1.drawText(data.verificationCode, { x: T.cover.code.x, y: Y(T.cover.code.codeBase), size: 10.5, font: fonts.mono, color: black });

    // === QR კოდის ჩასმა წითლად მონიშნულ ადგილას ===
    p1.drawImage(qrImage, {
      x:160,
      y: Y(415),
      width: 80,
      height: 80,
    });

    // ---- Page 3 (+ continuation): verified skillset grid ----
    for (let g = 0; g < gridPages; g++) {
      const page = pages[2 + g];
      drawPassportId(page, fonts, data.passportId, 3, black);
      const chunk = skills.slice(g * 10, g * 10 + 10);
      chunk.forEach((sk, i) => {
        const [x0, x1] = T.grid.cols[i % 5];
        const [t0, t1] = T.grid.rows[Math.floor(i / 5)];
        page.drawRectangle({ x: x0 + 4, y: Y(t1 - 4), width: x1 - x0 - 8, height: t1 - t0 - 8, color: white });
        const date = fmtDate(sk.dateEarned);
        const dw = fonts.reg.widthOfTextAtSize(date, 7);
        page.drawText(date, { x: x0 + (x1 - x0 - dw) / 2, y: Y(t0 + 14), size: 7, font: fonts.reg, color: grey });
        page.drawLine({ start: { x: x0 + 4, y: Y(t0 + 20) }, end: { x: x1 - 4, y: Y(t0 + 20) }, thickness: 0.6, color: rgb(0.8, 0.8, 0.8) });
        drawStamp(PDFLib, page, fonts, sk.category, (x0 + x1) / 2, t0 + 56, 0.95);
        const nameLines = wrap(sk.name.toUpperCase(), fonts.bold, 8, x1 - x0 - 14).slice(0, 4);
        centeredBlock(page, nameLines, fonts.bold, 8, x0, x1, t0 + 108, black, 9.4);
        const cat = sk.category.toUpperCase();
        const cw = fonts.reg.widthOfTextAtSize(cat, 7);
        page.drawText(cat, { x: x0 + (x1 - x0 - cw) / 2, y: Y(t0 + 108 + nameLines.length * 4.7 + 9), size: 7, font: fonts.reg, color: black });
      });
    }

    // ---- Page 4 (+ continuation): AI skill supplement table ----
    const tc = T.table.cols;
    for (let t = 0; t < tablePages; t++) {
      const page = pages[2 + gridPages + t];
      drawPassportId(page, fonts, data.passportId, 4, black);
      const chunk = skills.slice(t * 5, t * 5 + 5);
      chunk.forEach((sk, i) => {
        const [r0, r1] = T.table.rows[i];
        const mid = (r0 + r1) / 2;
        page.drawRectangle({ x: tc.stamp[0] + 2, y: Y(r1 - 2), width: tc.stamp[1] - tc.stamp[0] - 4, height: r1 - r0 - 4, color: white });
        drawStamp(PDFLib, page, fonts, sk.category, (tc.stamp[0] + tc.stamp[1]) / 2, mid, 0.84);
        centeredBlock(page, wrap(sk.name.toUpperCase(), fonts.bold, 7.4, tc.skill[1] - tc.skill[0] - 8).slice(0, 4), fonts.bold, 7.4, tc.skill[0], tc.skill[1], mid, black, 8.8);
        centeredBlock(page, wrap(sk.description.toUpperCase(), fonts.reg, 5.4, tc.desc[1] - tc.desc[0] - 10).slice(0, 6), fonts.reg, 5.4, tc.desc[0], tc.desc[1], mid, black, 6.6);
        centeredBlock(page, wrap(sk.earnedThrough.toUpperCase(), fonts.reg, 6.4, tc.through[1] - tc.through[0] - 12).slice(0, 3), fonts.reg, 6.4, tc.through[0], tc.through[1], mid, black, 7.8);
        centeredBlock(page, [fmtDate(sk.dateEarned)], fonts.bold, 9, tc.date[0], tc.date[1], mid, black);
      });
    }

    // Fixed metadata so output is deterministic for a given version.
    const when = new Date(data.issuedAt);
    doc.setTitle("BTU AI Skills Digital Passport " + data.passportId + " " + data.version, { showInWindowTitleBar: true });
    doc.setAuthor("Business and Technology University (BTU)");
    doc.setSubject("Verification code: " + data.verificationCode);
    doc.setKeywords([data.passportId, data.version, data.verificationCode]);
    doc.setCreator("BTU AI Skills Passport Service");
    doc.setProducer("BTU AI Skills Passport Service");
    doc.setCreationDate(when);
    doc.setModificationDate(when);
    return doc.save({ useObjectStreams: false });
  }

  root.PassportPDF = { build, STAMP, fmtDate };
})(typeof window !== "undefined" ? window : globalThis);
