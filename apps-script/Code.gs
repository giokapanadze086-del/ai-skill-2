/**
 * BTU AI Skills Digital Passport: Google Sheet connector (Google Apps Script).
 *
 * Bind this script to the Google Sheet that holds the "Passport Skill Records" tab
 * (Extensions → Apps Script), then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). Paste the /exec URL into the
 * website: Administration → Source settings.
 *
 * GET  ?action=read            → { rows: [ {studentId … syncError} ] }   (columns A–T)
 * POST {action:"append", rows:[{studentId … syncError}]}   adds rows from an uploaded results file
 *      (an enrollment row has Record ID "ENR-…" and empty skill columns: blank passport)
 * POST {action:"writeBack", updates:[{recordId, set:{…}}]}
 *      writes only system-managed fields: G (Passport ID), H (First Issued) on
 *      initial issuance, and Q–T (sync status, version, synced at, error).
 *
 * Column N (Badge/Stamp Code) is a formula in the sheet and is never written.
 * Protect columns Q–T against human edits in the live sheet.
 */
const SHEET_NAME = "Passport Skill Records";
const FIELDS = ["studentId", "firstName", "lastName", "email", "program", "educationLevel", "passportId", "firstIssued",
  "studentStatus", "recordId", "skillId", "skillName", "category", "badgeCode", "description", "dateEarned",
  "syncStatus", "syncedVersion", "syncedAt", "syncError"]; // A–T
const WRITABLE = { passportId: 7, firstIssued: 8, syncStatus: 17, syncedVersion: 18, syncedAt: 19, syncError: 20 }; // 1-based columns

function sheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error("Sheet not found: " + SHEET_NAME);
  return sh;
}

// The header row is the one whose column J says "Record ID" (row 4 in the BTU template).
function headerRow_(sh) {
  const top = sh.getRange(1, 1, Math.min(15, sh.getLastRow()), 20).getDisplayValues();
  for (let i = 0; i < top.length; i++) if (String(top[i][9]).trim() === "Record ID") return i + 1;
  throw new Error("Header row with 'Record ID' in column J not found");
}

function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, "UTC", "yyyy-MM-dd");
  return v == null ? "" : String(v).trim();
}

function readRows_() {
  const sh = sheet_();
  const h = headerRow_(sh);
  const n = sh.getLastRow() - h;
  if (n <= 0) return [];
  const values = sh.getRange(h + 1, 1, n, 20).getValues();
  const rows = [];
  for (const r of values) {
    if (!/^BTU-/.test(cell_(r[0])) || !cell_(r[9])) continue; // skip blank lines and the technical notes block
    const o = {};
    FIELDS.forEach((f, i) => (o[f] = cell_(r[i])));
    o.syncedAt = r[18] instanceof Date ? Utilities.formatDate(r[18], "UTC", "yyyy-MM-dd HH:mm") + " UTC" : o.syncedAt;
    rows.push(o);
  }
  return rows;
}
/**
 * ფუნქცია, რომელიც აგენერირებს QR კოდს და აგზავნის მეილს.
 * @param {string} studentName - სტუდენტის სახელი
 * @param {string} studentEmail - სტუდენტის ელ.ფოსტა
 * @param {string} skillName - სერტიფიკატის/უნარის დასახელება
 * @param {string} verificationCode - ვერიფიკაციის კოდი
 * @param {string} issueDateIso - გაცემის თარიღი (ISO ფორმატი)
 */
function processPassportAndSendEmail(studentName, studentEmail, skillName, verificationCode, issueDateIso) {
  // ვერიფიკაციის გვერდის ბმული უნიკალური კოდით
  var verificationUrl = "https://btumobility.ge/#verify?code=" + encodeURIComponent(verificationCode);
  
  // 1. QR კოდის გენერირება ვერიფიკაციის ბმულზე
  var qrCodeApiUrl = "https://quickchart.io/qr?text=" + encodeURIComponent(verificationUrl) + "&size=250";
  var qrCodeBlob = UrlFetchApp.fetch(qrCodeApiUrl).getBlob().setName("Certificate_Verification_QR.png");
  
  // 2. მეილის გაგზავნა
  var subject = "თქვენი AI Skills Digital Passport მზად არის!";
  var htmlBody = "" +
    "<h2>გამარჯობა " + studentName + ",</h2>" +
    "<p>თქვენი სერთიფიკატი/პასპორტი წარმატებით დაგენერირდა.</p>" +
    "<p><b>ვერიფიკაციის კოდი:</b> " + verificationCode + "</p>" +
    "<p>სანდოობის შესამოწმებლად შეგიძლიათ გადახვიდეთ ბმულზე: <a href='" + verificationUrl + "'>სერთიფიკატის ვერიფიკაცია</a> ან დაასკანიროთ მიმაგრებული QR კოდი.</p>" +
    "<br><p>პატივისცემით,<br>BTU გუნდი</p>";
    
  GmailApp.sendEmail(studentEmail, subject, "", {
    htmlBody: htmlBody,
    attachments: [qrCodeBlob] 
  });
}
function testMyFunction() {
  processPassportAndSendEmail(
    "გიორგი მაისურაძე", 
    "test@example.com", // შეცვალეთ თქვენი რეალური მეილით ტესტირებისთვის
    "https://www.linkedin.com/in/giorgi-example/"
    
  );
}

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "read";
  if (action !== "read") return json_({ error: "Unknown action" });
  return json_({ rows: readRows_(), readAt: new Date().toISOString() });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    if (body.action === "append" && Array.isArray(body.rows)) return json_(appendRows_(body.rows));
    if (body.action !== "writeBack" || !Array.isArray(body.updates)) return json_({ error: "Bad request" });
    const sh = sheet_();
    const h = headerRow_(sh);
    const n = sh.getLastRow() - h;
    const ids = sh.getRange(h + 1, 10, n, 1).getDisplayValues().map((r) => r[0].trim());
    let written = 0;
    for (const u of body.updates) {
      const idx = ids.indexOf(String(u.recordId));
      if (idx < 0) continue;
      const row = h + 1 + idx;
      Object.keys(u.set || {}).forEach((k) => {
        if (WRITABLE[k]) sh.getRange(row, WRITABLE[k]).setValue(u.set[k]);
      });
      written++;
    }
    return json_({ ok: true, written });
  } finally {
    lock.releaseLock();
  }
}

// Adds new skill records (from an uploaded event results file) right after the last
// data row, above the technical notes block. Column N gets the badge-code formula.
function appendRows_(rows) {
  const sh = sheet_();
  const h = headerRow_(sh);
  const n = Math.max(0, sh.getLastRow() - h);
  const ids = n ? sh.getRange(h + 1, 1, n, 1).getDisplayValues().map((r) => r[0].trim()) : [];
  let last = h;
  ids.forEach((v, i) => { if (/^BTU-/.test(v)) last = h + 1 + i; });
  if (!rows.length) return { ok: true, appended: 0 };
  sh.insertRowsAfter(last, rows.length);
  const values = rows.map((o, i) => FIELDS.map((f, c) => {
    if (c === 13) return '=IF(M' + (last + 1 + i) + '="","",IF(M' + (last + 1 + i) + '="AI Skill","BDG-AI-001",IF(M' + (last + 1 + i) + '="AI Applied Skill","BDG-AI-002",IF(M' + (last + 1 + i) + '="AI Advanced Skill","BDG-AI-003","CHECK CATEGORY"))))';
    return o[f] == null ? "" : o[f];
  }));
  sh.getRange(last + 1, 1, rows.length, 20).setValues(values);
  return { ok: true, appended: rows.length };
}
var dateObj = new Date(issueDateIso || new Date());
var year = dateObj.getFullYear();
var month = dateObj.getMonth() + 1;
var expYear = year + 3; // +3 წელი


function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
