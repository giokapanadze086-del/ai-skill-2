/*
 * BTU AI Skills Digital Passport: core service.
 *
 * - Google Sheet ("Passport Skill Records", columns A-T) is the data source.
 * - The service keeps its own SQL database (SQLite): students, skill catalog,
 *   passports, versions, issued skills, the blockchain ledger and sync runs.
 * - Sync reads the sheet with SQL (rows WHERE sync_status IN ('NOT SYNCED','FAILED')),
 *   updates each student's single passport, generates the PDF from BTU's template,
 *   registers the PDF hash on the ledger signed with BTU's issuer key, and writes
 *   columns G, H, Q-T back to the sheet.
 *
 * Environment-agnostic: the caller injects a SQL adapter, the PDF builder,
 * the template bytes, the sheet source and WebCrypto.
 */
(function (root) {
  "use strict";

  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS students (
       student_id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
       email TEXT NOT NULL UNIQUE, program TEXT, education_level TEXT, student_status TEXT)`,
    `CREATE TABLE IF NOT EXISTS skills (
       skill_id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
       badge_code TEXT NOT NULL, description TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS passports (
       passport_id TEXT PRIMARY KEY, student_id TEXT NOT NULL UNIQUE REFERENCES students(student_id),
       first_name TEXT NOT NULL, last_name TEXT NOT NULL, first_issued TEXT NOT NULL,
       latest_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS passport_skills (
       record_id TEXT PRIMARY KEY, passport_id TEXT NOT NULL REFERENCES passports(passport_id),
       skill_id TEXT NOT NULL REFERENCES skills(skill_id), date_earned TEXT NOT NULL,
       added_in_version INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS passport_versions (
       passport_id TEXT NOT NULL REFERENCES passports(passport_id), version INTEGER NOT NULL,
       verification_code TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL, doc_sha256 TEXT NOT NULL UNIQUE,
       signature TEXT NOT NULL, block_index INTEGER NOT NULL, tx_hash TEXT NOT NULL,
       status TEXT NOT NULL CHECK (status IN ('LATEST','SUPERSEDED')), skills_count INTEGER NOT NULL,
       PRIMARY KEY (passport_id, version))`,
    `CREATE TABLE IF NOT EXISTS ledger (
       block_index INTEGER PRIMARY KEY, created_at TEXT NOT NULL, action TEXT NOT NULL,
       ref TEXT NOT NULL, doc_sha256 TEXT, signature TEXT, issuer TEXT NOT NULL,
       prev_hash TEXT NOT NULL, block_hash TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sheet_rows (
       row_no INTEGER PRIMARY KEY, student_id TEXT, first_name TEXT, last_name TEXT, email TEXT,
       program TEXT, education_level TEXT, passport_id TEXT, first_issued TEXT, student_status TEXT,
       record_id TEXT, skill_id TEXT, skill_name TEXT, category TEXT, badge_code TEXT,
       description TEXT, date_earned TEXT, sync_status TEXT, synced_version TEXT, synced_at TEXT, sync_error TEXT)`,
    `CREATE TABLE IF NOT EXISTS sync_runs (
       run_id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT,
       source TEXT NOT NULL, rows_read INTEGER, rows_synced INTEGER, rows_failed INTEGER,
       passports_updated INTEGER, log TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_versions_doc ON passport_versions(doc_sha256)`,
    `CREATE INDEX IF NOT EXISTS idx_skills_passport ON passport_skills(passport_id, added_in_version)`,
    `CREATE INDEX IF NOT EXISTS idx_sheet_status ON sheet_rows(sync_status, student_id)`,
  ];

  const CATEGORIES = { "AI Skill": "BDG-AI-001", "AI Applied Skill": "BDG-AI-002", "AI Advanced Skill": "BDG-AI-003" };
  const EARNED_THROUGH = { "AI Skill": "Focused Learning", "AI Applied Skill": "Applied Learning", "AI Advanced Skill": "Extended Academic Learning" };
  const ISSUER = { name: "Business and Technology University (BTU)", did: "did:web:btu.edu.ge", domain: "btu.edu.ge" };
  const ZERO = "0".repeat(64);
  const SHEET_FIELDS = ["studentId", "firstName", "lastName", "email", "program", "educationLevel", "passportId", "firstIssued", "studentStatus", "recordId", "skillId", "skillName", "category", "badgeCode", "description", "dateEarned", "syncStatus", "syncedVersion", "syncedAt", "syncError"];
  const SQL_COLS = ["student_id", "first_name", "last_name", "email", "program", "education_level", "passport_id", "first_issued", "student_status", "record_id", "skill_id", "skill_name", "category", "badge_code", "description", "date_earned", "sync_status", "synced_version", "synced_at", "sync_error"];

  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const b64 = (buf) => { let s = ""; new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b))); return btoa(s); };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const canonical = (v) => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
    : v && typeof v === "object" ? "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}"
    : JSON.stringify(v);
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const fmtUtc = (iso) => iso.slice(0, 10) + " " + iso.slice(11, 16) + " UTC";
  const parseUtc = (s) => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(s || ""); return m ? m[1] + "T" + m[2] + ":00.000Z" : null; };

  function create(env) {
    const { sql, pdf, template, sheet, crypto } = env;
    const subtle = crypto.subtle;
    let issuerKeys = null; // { privateKey, publicKey, publicJwk, fingerprint }
    let sqlLog = null;

    const run = (q, p) => { if (sqlLog) sqlLog.push(q.replace(/\s+/g, " ").trim()); return sql.run(q, p || []); };
    const all = (q, p) => { if (sqlLog) sqlLog.push(q.replace(/\s+/g, " ").trim()); return sql.all(q, p || []); };
    const get = (q, p) => all(q, p)[0] || null;

    const sha256 = async (data) => hex(await subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));

    async function init(keyJwk) {
      SCHEMA.forEach((s) => sql.exec(s));
      if (keyJwk) {
        const priv = await subtle.importKey("jwk", keyJwk.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
        const pub = await subtle.importKey("jwk", keyJwk.publicJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
        issuerKeys = { privateKey: priv, publicKey: pub, publicJwk: keyJwk.publicJwk, fingerprint: await fingerprintOf(keyJwk.publicJwk) };
      } else {
        const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
        const publicJwk = await subtle.exportKey("jwk", kp.publicKey);
        issuerKeys = { privateKey: kp.privateKey, publicKey: kp.publicKey, publicJwk, fingerprint: await fingerprintOf(publicJwk) };
      }
      if (!get("SELECT block_index FROM ledger WHERE block_index = 0")) {
        const ref = canonical({ name: ISSUER.name, did: ISSUER.did, publicKey: { kty: issuerKeys.publicJwk.kty, crv: issuerKeys.publicJwk.crv, x: issuerKeys.publicJwk.x, y: issuerKeys.publicJwk.y }, fingerprint: issuerKeys.fingerprint });
        await addBlock("REGISTER_ISSUER", ref, null, null, env.genesisAt || "2026-09-01T09:00:00.000Z");
      }
    }
    async function exportIssuerKey() {
      return { privateJwk: await subtle.exportKey("jwk", issuerKeys.privateKey), publicJwk: issuerKeys.publicJwk };
    }
    async function fingerprintOf(jwk) {
      const h = await sha256(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
      return h.slice(0, 40).toUpperCase().match(/.{4}/g).join(":");
    }

    // ------------------------------------------------------------- ledger
    async function blockHashOf(b) {
      return sha256(canonical({ index: b.block_index, created_at: b.created_at, action: b.action, ref: b.ref, doc_sha256: b.doc_sha256 || null, signature: b.signature || null, issuer: b.issuer, prev_hash: b.prev_hash }));
    }
    async function addBlock(action, ref, docHash, signature, createdAt) {
      const prev = get("SELECT block_index, block_hash FROM ledger ORDER BY block_index DESC LIMIT 1");
      const b = { block_index: prev ? prev.block_index + 1 : 0, created_at: createdAt, action, ref, doc_sha256: docHash, signature, issuer: ISSUER.did, prev_hash: prev ? prev.block_hash : ZERO };
      b.block_hash = await blockHashOf(b);
      run(`INSERT INTO ledger (block_index, created_at, action, ref, doc_sha256, signature, issuer, prev_hash, block_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [b.block_index, b.created_at, b.action, b.ref, b.doc_sha256, b.signature, b.issuer, b.prev_hash, b.block_hash]);
      return b;
    }
    async function checkChain() {
      const blocks = sql.all("SELECT * FROM ledger ORDER BY block_index", []);
      const bad = [];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.prev_hash !== (i ? blocks[i - 1].block_hash : ZERO) || (await blockHashOf(b)) !== b.block_hash) bad.push(b.block_index);
      }
      return { ok: bad.length === 0, bad, length: blocks.length };
    }
    function registeredIssuer() {
      const g = sql.all("SELECT * FROM ledger WHERE block_index = 0", [])[0];
      return g ? JSON.parse(g.ref) : null;
    }

    // ---------------------------------------------------- signing / codes
    const signMessage = (pid, v, docHash, issuedAt) => `BTU-AI-PASSPORT|${pid}|V${v}|${docHash}|${issuedAt}`;
    async function sign(msg) {
      return b64(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, issuerKeys.privateKey, enc.encode(msg)));
    }
    async function verifySignature(msg, sigB64, publicJwk) {
      try {
        const key = await subtle.importKey("jwk", { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64(sigB64), enc.encode(msg));
      } catch (e) { return false; }
    }
    async function makeCode(pid, v, issuedAt) {
      const h = await sha256(`${pid}|V${v}|${issuedAt}|verification-code`);
      let bits = BigInt("0x" + h.slice(0, 15)), out = "";
      for (let i = 0; i < 12; i++) { out = CROCKFORD[Number(bits & 31n)] + out; bits >>= 5n; }
      return "BTUV-" + out.match(/.{4}/g).join("-");
    }

    // ------------------------------------------------------ passport data
    function versionData(passportId, v) {
      const p = get("SELECT * FROM passports WHERE passport_id = ?", [passportId]);
      const ver = get("SELECT * FROM passport_versions WHERE passport_id = ? AND version = ?", [passportId, v]);
      return buildData(p, v, ver.issued_at, ver.verification_code);
    }
    function buildData(p, v, issuedAt, code) {
      const skills = all(`SELECT ps.record_id, ps.skill_id, ps.date_earned, s.name, s.category, s.description
                          FROM passport_skills ps JOIN skills s ON s.skill_id = ps.skill_id
                          WHERE ps.passport_id = ? AND ps.added_in_version <= ?
                          ORDER BY ps.date_earned, ps.record_id`, [p.passport_id, v]);
      return {
        passportId: p.passport_id, firstName: p.first_name, lastName: p.last_name, firstIssued: p.first_issued,
        version: "V" + v, issuedAt, verificationCode: code,
        skills: skills.map((s) => ({ recordId: s.record_id, skillId: s.skill_id, name: s.name, category: s.category, description: s.description, earnedThrough: EARNED_THROUGH[s.category], dateEarned: s.date_earned })),
      };
    }
    async function renderPdf(passportId, v) {
      return pdf.build(versionData(passportId, v), template);
    }
    async function issueVersion(p, v, issuedAt) {
      const code = await makeCode(p.passport_id, v, issuedAt);
      const data = buildData(p, v, issuedAt, code);
      const bytes = await pdf.build(data, template);
      const docHash = await sha256(bytes);
      const signature = await sign(signMessage(p.passport_id, v, docHash, issuedAt));
      const block = await addBlock("ISSUE_PASSPORT_VERSION", p.passport_id + "|V" + v, docHash, signature, issuedAt);
      run("UPDATE passport_versions SET status = 'SUPERSEDED' WHERE passport_id = ? AND status = 'LATEST'", [p.passport_id]);
      run(`INSERT INTO passport_versions (passport_id, version, verification_code, issued_at, doc_sha256, signature, block_index, tx_hash, status, skills_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'LATEST', ?)`, [p.passport_id, v, code, issuedAt, docHash, signature, block.block_index, "0x" + block.block_hash, data.skills.length]);
      run("UPDATE passports SET latest_version = ? WHERE passport_id = ?", [v, p.passport_id]);
      return { version: v, code, docHash, block, skills: data.skills.length, bytes };
    }

    // -------------------------------------------------------------- sheet
    function stageSheet(rows) {
      run("DELETE FROM sheet_rows");
      const ph = SQL_COLS.map(() => "?").join(", ");
      rows.forEach((r, i) => {
        const vals = SHEET_FIELDS.map((f) => (r[f] == null ? "" : String(r[f]).trim()));
        vals[13] = CATEGORIES[vals[12]] || "CHECK CATEGORY"; // N: badge code is derived from M
        sql.run(`INSERT INTO sheet_rows (row_no, ${SQL_COLS.join(", ")}) VALUES (?, ${ph})`, [i].concat(vals));
      });
      if (sqlLog) sqlLog.push(`INSERT INTO sheet_rows (row_no, student_id, ..., sync_error) VALUES (...) -- ${rows.length} rows`);
    }
    function upsertReference() {
      run(`INSERT INTO students (student_id, first_name, last_name, email, program, education_level, student_status)
           SELECT student_id, first_name, last_name, lower(email), program, education_level, student_status
           FROM sheet_rows WHERE student_id <> '' AND email <> '' GROUP BY student_id
           ON CONFLICT(student_id) DO UPDATE SET program = excluded.program, education_level = excluded.education_level,
             student_status = excluded.student_status, email = excluded.email`);
      run(`INSERT INTO skills (skill_id, name, category, badge_code, description)
           SELECT skill_id, skill_name, category, badge_code, description FROM sheet_rows
           WHERE skill_id <> '' AND badge_code <> 'CHECK CATEGORY' GROUP BY skill_id
           ON CONFLICT(skill_id) DO NOTHING`);
    }
    // Enrollment rows (Record ID "ENR-…") carry only the student: they create a blank passport.
    const isEnrollment = (r) => /^ENR-/i.test(r.record_id) && !r.skill_id;
    function validate(r) {
      const req = isEnrollment(r)
        ? { student_id: "A", first_name: "B", last_name: "C", email: "D", record_id: "J" }
        : { student_id: "A", first_name: "B", last_name: "C", email: "D", student_status: "I", record_id: "J", skill_id: "K", skill_name: "L", category: "M", description: "O", date_earned: "P" };
      const missing = Object.keys(req).filter((k) => !r[k]).map((k) => req[k]);
      if (missing.length) return "Missing required column(s): " + missing.join(", ");
      if (isEnrollment(r)) return emailRe.test(r.email) ? null : "Invalid BTU email";
      if (!CATEGORIES[r.category]) return "Invalid Skill Category: " + r.category;
      if (!isoDate.test(r.date_earned)) return "Date Earned must be YYYY-MM-DD";
      if (!emailRe.test(r.email)) return "Invalid BTU email";
      const s = get("SELECT name, category FROM skills WHERE skill_id = ?", [r.skill_id]);
      if (s && (s.name !== r.skill_name || s.category !== r.category)) return "Skill ID " + r.skill_id + " does not match the skill catalog";
      if (r.passport_id) {
        const owner = get("SELECT student_id FROM passports WHERE passport_id = ?", [r.passport_id]);
        if (owner && owner.student_id !== r.student_id) return "Passport ID belongs to another student";
      }
      const p = get("SELECT passport_id FROM passports WHERE student_id = ?", [r.student_id]);
      if (p && r.passport_id && p.passport_id !== r.passport_id) return "Passport ID differs from the issued passport " + p.passport_id;
      return null;
    }
    function nextPassportId() {
      const rows = sql.all("SELECT passport_id FROM passports UNION SELECT passport_id FROM sheet_rows WHERE passport_id <> ''", []);
      const max = rows.reduce((m, r) => Math.max(m, Number(String(r.passport_id).replace(/\D/g, "")) || 0), 0);
      return "BTU-AI-" + String(max + 1).padStart(6, "0");
    }
    function ensurePassport(r, nowIso) {
      let p = get("SELECT * FROM passports WHERE student_id = ?", [r.student_id]);
      if (p) return { p, created: false };
      const pid = r.passport_id || nextPassportId();
      const first = r.first_issued && isoDate.test(r.first_issued) ? r.first_issued : nowIso.slice(0, 10);
      run(`INSERT INTO passports (passport_id, student_id, first_name, last_name, first_issued, latest_version, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`, [pid, r.student_id, r.first_name, r.last_name, first, nowIso]);
      return { p: get("SELECT * FROM passports WHERE passport_id = ?", [pid]), created: true };
    }

    // Rebuild the issuance ledger for rows the sheet already reports as SYNCED
    // (the provided test data starts with V1 issued on 2026-10-17 10:00 UTC).
    async function importExistingIssuance() {
      const rows = await sheet.read();
      stageSheet(rows);
      upsertReference();
      const synced = all(`SELECT * FROM sheet_rows WHERE sync_status = 'SYNCED'
                          ORDER BY student_id, CAST(substr(synced_version, 2) AS INTEGER), date_earned, record_id`);
      const groups = new Map();
      synced.forEach((r) => { const k = r.student_id + "|" + r.synced_version; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
      let n = 0;
      for (const [, grp] of groups) {
        const r0 = grp[0];
        const v = Number(String(r0.synced_version).replace(/\D/g, "")) || 1;
        const issuedAt = parseUtc(r0.synced_at) || "2026-10-17T10:00:00.000Z";
        const { p } = ensurePassport(r0, issuedAt);
        grp.filter((r) => r.skill_id).forEach((r) => run("INSERT OR IGNORE INTO passport_skills (record_id, passport_id, skill_id, date_earned, added_in_version) VALUES (?, ?, ?, ?, ?)", [r.record_id, p.passport_id, r.skill_id, r.date_earned, v]));
        await issueVersion(p, v, issuedAt);
        n++;
      }
      return n;
    }

    async function sync(opts) {
      const o = opts || {};
      const nowIso = o.now || new Date().toISOString();
      sqlLog = [];
      const steps = [];
      const rows = await sheet.read();
      steps.push("Google Sheet წაკითხულია: " + rows.length + " ჩანაწერი (" + sheet.label + ")");
      stageSheet(rows);
      upsertReference();
      const pending = all(`SELECT * FROM sheet_rows WHERE sync_status IN ('NOT SYNCED', 'FAILED')
                           ORDER BY student_id, date_earned, record_id`);
      steps.push("ახალი/ხელახლა საცდელი ჩანაწერი: " + pending.length);
      const updates = [], byStudent = new Map();
      let failed = 0;
      for (const r of pending) {
        const already = get(`SELECT ps.added_in_version, pv.issued_at FROM passport_skills ps
                             JOIN passport_versions pv ON pv.passport_id = ps.passport_id AND pv.version = ps.added_in_version
                             WHERE ps.record_id = ?`, [r.record_id]);
        if (already) { // idempotent: record was issued before, only the sheet status was missing
          updates.push({ rowNo: r.row_no, recordId: r.record_id, set: { syncStatus: "SYNCED", syncedVersion: "V" + already.added_in_version, syncedAt: fmtUtc(already.issued_at), syncError: "" } });
          continue;
        }
        const err = validate(r);
        if (err) {
          failed++;
          updates.push({ rowNo: r.row_no, recordId: r.record_id, set: { syncStatus: "FAILED", syncedVersion: "", syncedAt: "", syncError: err } });
          continue;
        }
        if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, []);
        byStudent.get(r.student_id).push(r);
      }
      const issued = [];
      for (const [studentId, recs] of byStudent) {
        const dupe = new Set();
        const fresh = recs.filter((r) => {
          if (dupe.has(r.record_id)) return false;
          dupe.add(r.record_id); return true;
        });
        const { p, created } = ensurePassport(fresh[0], nowIso);
        const skillRecs = fresh.filter((r) => r.skill_id);
        if (!skillRecs.length && p.latest_version > 0) { // already has a passport: nothing new to issue
          const cur = get("SELECT issued_at FROM passport_versions WHERE passport_id = ? AND version = ?", [p.passport_id, p.latest_version]);
          fresh.forEach((r) => updates.push({ rowNo: r.row_no, recordId: r.record_id, set: { syncStatus: "SYNCED", syncedVersion: "V" + p.latest_version, syncedAt: fmtUtc(cur.issued_at), syncError: "", passportId: p.passport_id, firstIssued: p.first_issued } }));
          steps.push("უკვე აქვს პასპორტი " + p.passport_id + " · " + p.first_name + " " + p.last_name + " (ახალი ვერსია არ საჭიროებს)");
          continue;
        }
        const v = p.latest_version + 1;
        skillRecs.forEach((r) => run("INSERT INTO passport_skills (record_id, passport_id, skill_id, date_earned, added_in_version) VALUES (?, ?, ?, ?, ?)", [r.record_id, p.passport_id, r.skill_id, r.date_earned, v]));
        const res = await issueVersion(p, v, nowIso);
        issued.push({ studentId, passportId: p.passport_id, name: p.first_name + " " + p.last_name, version: v, code: res.code, added: skillRecs.length, created, block: res.block.block_index });
        fresh.forEach((r) => updates.push({ rowNo: r.row_no, recordId: r.record_id, set: { syncStatus: "SYNCED", syncedVersion: "V" + v, syncedAt: fmtUtc(nowIso), syncError: "" } }));
        // Write the persistent Passport ID / First Issued back to every row of the student.
        all("SELECT row_no, record_id, passport_id, first_issued FROM sheet_rows WHERE student_id = ?", [studentId]).forEach((row) => {
          if (row.passport_id !== p.passport_id || row.first_issued !== p.first_issued) {
            const u = updates.find((x) => x.rowNo === row.row_no);
            const extra = { passportId: p.passport_id, firstIssued: p.first_issued };
            if (u) Object.assign(u.set, extra); else updates.push({ rowNo: row.row_no, recordId: row.record_id, set: extra });
          }
        });
        steps.push((created ? (skillRecs.length ? "ახალი პასპორტი " : "ახალი ცარიელი პასპორტი ") : "განახლდა ") + p.passport_id + " · " + p.first_name + " " + p.last_name + " → V" + v + " (+" + skillRecs.length + " უნარი) · ბლოკი #" + res.block.block_index);
      }
      if (updates.length) {
        await sheet.writeBack(updates);
        updates.forEach((u) => {
          const sets = Object.keys(u.set).map((k) => SQL_COLS[SHEET_FIELDS.indexOf(k)] + " = ?");
          sql.run(`UPDATE sheet_rows SET ${sets.join(", ")} WHERE row_no = ?`, Object.values(u.set).concat([u.rowNo]));
        });
        steps.push("Google Sheet-ში ჩაიწერა სტატუსი (Q–T) " + updates.length + " სტრიქონზე");
      }
      const synced = updates.filter((u) => u.set.syncStatus === "SYNCED").length;
      const log = { steps, sql: sqlLog.slice(0, 60), issued, failed: updates.filter((u) => u.set.syncStatus === "FAILED").map((u) => ({ recordId: u.recordId, error: u.set.syncError })) };
      sqlLog = null;
      sql.run(`INSERT INTO sync_runs (started_at, finished_at, source, rows_read, rows_synced, rows_failed, passports_updated, log)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [nowIso, new Date().toISOString(), sheet.label, rows.length, synced, failed, issued.length, JSON.stringify(log)]);
      return { rowsRead: rows.length, pending: pending.length, synced, failed, issued, log };
    }

    // -------------------------------------------------------- verification
    async function verifyVersion(ver) {
      const p = get("SELECT * FROM passports WHERE passport_id = ?", [ver.passport_id]);
      const block = get("SELECT * FROM ledger WHERE block_index = ?", [ver.block_index]);
      const issuer = registeredIssuer();
      const chain = await checkChain();
      const onChain = !!block && block.action === "ISSUE_PASSPORT_VERSION" && block.doc_sha256 === ver.doc_sha256 && block.ref === ver.passport_id + "|V" + ver.version;
      const sigOk = !!issuer && !!block && (await verifySignature(signMessage(ver.passport_id, ver.version, block.doc_sha256, block.created_at), block.signature, issuer.publicKey));
      const latest = get("SELECT version, verification_code FROM passport_versions WHERE passport_id = ? AND status = 'LATEST'", [ver.passport_id]);
      const data = buildData(p, ver.version, ver.issued_at, ver.verification_code);
      return { found: true, passport: p, version: ver, block, issuer, chain, onChain, issuerOk: sigOk && block.issuer === issuer.did, documentOk: onChain && chain.ok, isLatest: ver.status === "LATEST", latest, data };
    }
    async function verifyCode(code) {
      const c = String(code || "").trim().toUpperCase().replace(/\s+/g, "");
      const ver = get("SELECT * FROM passport_versions WHERE verification_code = ?", [c]);
      if (!ver) return { found: false, code: c };
      return verifyVersion(ver);
    }
    async function verifyPdf(bytes, code) {
      const docHash = await sha256(bytes);
      const ver = get("SELECT * FROM passport_versions WHERE doc_sha256 = ?", [docHash]);
      let expected = null;
      if (code) expected = get("SELECT * FROM passport_versions WHERE verification_code = ?", [String(code).trim().toUpperCase()]);
      if (!ver) return { found: false, docHash, matchesCode: false, expected };
      const res = await verifyVersion(ver);
      return Object.assign(res, { docHash, matchesCode: !expected || expected.doc_sha256 === docHash, expected });
    }
    async function officialPdf(passportId, v) {
      const bytes = await renderPdf(passportId, v);
      const ver = get("SELECT doc_sha256 FROM passport_versions WHERE passport_id = ? AND version = ?", [passportId, v]);
      const ok = ver && (await sha256(bytes)) === ver.doc_sha256;
      if (!ok) throw new Error("Regenerated PDF does not match the registered hash");
      return bytes;
    }

    // --------------------------------------------------------------- reads
    const q = {
      passports: () => sql.all(`SELECT p.*, s.email, s.program, s.education_level, s.student_status, v.verification_code, v.issued_at AS latest_issued_at, v.skills_count
                                FROM passports p JOIN students s ON s.student_id = p.student_id
                                LEFT JOIN passport_versions v ON v.passport_id = p.passport_id AND v.status = 'LATEST'
                                ORDER BY p.passport_id`, []),
      passportByEmail: (email) => sql.all(`SELECT p.*, s.email, s.program, s.education_level FROM passports p JOIN students s ON s.student_id = p.student_id WHERE lower(s.email) = lower(?)`, [String(email).trim()])[0] || null,
      studentByEmail: (email) => sql.all("SELECT * FROM students WHERE lower(email) = lower(?)", [String(email).trim()])[0] || null,
      versions: (pid) => sql.all("SELECT * FROM passport_versions WHERE passport_id = ? ORDER BY version DESC", [pid]),
      ledger: () => sql.all("SELECT * FROM ledger ORDER BY block_index DESC", []),
      runs: () => sql.all("SELECT * FROM sync_runs ORDER BY run_id DESC LIMIT 20", []),
      sheetRows: () => sql.all("SELECT * FROM sheet_rows ORDER BY row_no", []),
      skills: () => sql.all("SELECT * FROM skills ORDER BY skill_id", []),
      students: () => sql.all("SELECT * FROM students ORDER BY student_id", []),
      counts: () => sql.all(`SELECT (SELECT COUNT(*) FROM passports) AS passports, (SELECT COUNT(*) FROM passport_versions) AS versions,
                                    (SELECT COUNT(*) FROM ledger) AS blocks, (SELECT COUNT(*) FROM passport_skills) AS skills`, [])[0],
    };

    return {
      init, exportIssuerKey, importExistingIssuance, sync, verifyCode, verifyPdf, officialPdf, renderPdf, versionData,
      checkChain, registeredIssuer, q, sha256, issuerFingerprint: () => issuerKeys.fingerprint, nextPassportId,
      stageSheet: (rows) => { stageSheet(rows); upsertReference(); },
    };
  }

  root.PassportCore = { create, CATEGORIES, EARNED_THROUGH, ISSUER, SHEET_FIELDS, canonical };
})(typeof window !== "undefined" ? window : globalThis);
