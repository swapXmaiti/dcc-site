// Shared backend for Debasish Chemistry Classes: admissions, exam papers, answer keys, student attempts and results.
// Data lives in Netlify Blobs. The answer key, student passwords and admission details never leave the server.
import crypto from "node:crypto";

const adminPassword = () => process.env.ADMIN_PASSWORD || "";
const secret = () => {
  if (!process.env.APP_SECRET) throw new Error("APP_SECRET is not configured.");
  return process.env.APP_SECRET;
};
const hashPassword = async password => {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = await new Promise((resolve, reject) => crypto.scrypt(String(password), salt, 64, (e, key) => e ? reject(e) : resolve(key)));
  return "scrypt$" + salt + "$" + Buffer.from(derived).toString("base64url");
};
const checkPassword = async (password, encoded) => {
  try {
    const [kind, salt, expected] = String(encoded).split("$");
    if (kind !== "scrypt" || !salt || !expected) return false;
    const actual = await new Promise((resolve, reject) => crypto.scrypt(String(password), salt, 64, (e, key) => e ? reject(e) : resolve(key)));
    const wanted = Buffer.from(expected, "base64url");
    return wanted.length === actual.length && crypto.timingSafeEqual(wanted, actual);
  } catch { return false; }
};
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
const mac = body => crypto.createHmac("sha256", secret()).update(body).digest("base64url");
const sign = (p, hours) => { const body = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + hours * 3600e3 })).toString("base64url"); return body + "." + mac(body); };
const verify = (t, role) => {
  try {
    const [body, sig] = String(t).split("."), ok = mac(body);
    if (!sig || sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() && p.role === role ? p : null;
  } catch { return null; }
};
class Err extends Error { constructor(m, s = 400) { super(m); this.status = s; } }
const enc = encodeURIComponent, f2 = v => +v.toFixed(2), GRACE = 5000;

export function makeApi(store) {
  const J = async (k, d = null) => (await store.get(k, { type: "json" })) ?? d;
  const S = (k, v) => store.setJSON(k, v);
  const keys = async prefix => (await store.list({ prefix })).blobs.map(b => b.key);
  const admin = async b => {
    const p = verify(b.token, "admin"), version = await J("auth:version", 0);
    if (!p || p.cv !== version) throw new Err("Please log in again.", 401);
  };
  const student = b => { const p = verify(b.token, "student"); if (!p) throw new Err("Session expired. Please log in again.", 401); return p; };
  const metaOf = ex => ({ examId: ex.id, tag: ex.tag, title: ex.title, duration: ex.duration, correct: ex.correct, negative: ex.negative, n: ex.key.length, pages: ex.pdfPages });
  const cleanAns = (ans, n) => { const o = {}; Object.keys(ans || {}).forEach(k => { const i = +k, v = ans[k]; if (Number.isInteger(i) && i >= 0 && i < n && [0, 1, 2, 3].includes(v)) o[i] = v; }); return o; };

  async function score(ex, sess, ans, auto) {
    let c = 0, w = 0, b = 0;
    ex.key.forEach((k, i) => { const a = ans[i]; if (a === undefined) b++; else if ("ABCD"[a] === k) c++; else w++; });
    const total = f2(ex.key.length * sess.m), sc = f2(c * sess.m - w * sess.ng);
    const r = { id: "R" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), exam_id: ex.id, tag: ex.tag, student_id: sess.sid, name: sess.name, class_grade: sess.cls,
      score: sc, total, gained: f2(c * sess.m), lost: f2(w * sess.ng), correct: c, wrong: w, blank: b, percent: total ? Math.max(0, Math.round(sc / total * 1000) / 10) : 0,
      time_taken: Math.round((Math.min(Date.now(), sess.end) - sess.start) / 1000), submitted_at: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), auto: !!auto };
    await S(`res:${ex.id}:${enc(sess.sid)}`, r); await store.delete(`sess:${enc(sess.sid)}`);
    return r;
  }
  // attempts whose time ran out (browser closed, phone died...) are scored automatically
  async function finalizeExpired(exams) {
    for (const k of await keys("sess:")) {
      const s = await J(k); if (!s) continue;
      if (Date.now() <= s.end + GRACE) continue;
      const ex = Object.values(exams || {}).find(e => e.id === s.examId);
      if (ex) await score(ex, s, s.ans || {}, true); else await store.delete(k);
    }
  }
  async function mergeInbox() {
    for (const k of await keys("inbox:")) {
      const it = await J(k); if (!it) { await store.delete(k); continue; }
      const list = await J(it.kind); if (!list) continue;   // stays queued until the list exists
      it.record.id = list.length ? Math.max(...list.map(x => x.id || 0)) + 1 : 1; list.unshift(it.record); await S(it.kind, list); await store.delete(k);
    }
  }


  const validMeetUrl = value => {
    try { const u = new URL(String(value || "")); return u.protocol === "https:" && (u.hostname === "meet.google.com" || u.hostname.endsWith(".meet.google.com")); } catch { return false; }
  };
  const classList = async () => await J("classes:list", []);
  const encryptSecret = value => {
    const key = crypto.createHash("sha256").update(secret()).digest(), iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv), data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
  };
  const decryptSecret = value => {
    const [iv, tag, data] = String(value || "").split(".");
    const key = crypto.createHash("sha256").update(secret()).digest(), decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  };
  async function googleAccessToken() {
    const encrypted = await J("google:refresh");
    if (!encrypted) throw new Err("Connect the teacher's Google account first.", 503);
    const refresh_token = decryptSecret(encrypted);
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || "", client_secret: process.env.GOOGLE_CLIENT_SECRET || "", refresh_token, grant_type: "refresh_token" }) });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Err("Google connection expired or could not be refreshed.", 502);
    return data.access_token;
  }

  const findStudent = async (id, password) => {
    const sid = String(id || "").trim().toLowerCase(), list = await J("admissions", []);
    return list.find(a => a.exam_id && String(a.exam_id).toLowerCase() === sid && a.exam_pass === password) || null;
  };
  const actions = {
    async adminLogin(b) {
      const stored = await J("auth:password"), initial = adminPassword();
      if (!stored && !initial) throw new Err("Admin security is not configured. Set ADMIN_PASSWORD and APP_SECRET in Netlify environment variables.", 503);
      const ok = stored ? await checkPassword(b.password, stored) : sameSecret(b.password, initial);
      if (!ok) throw new Err("Incorrect password.", 401);
      if (!stored) await S("auth:password", await hashPassword(initial));
      const cv = await J("auth:version", 0);
      return { token: sign({ role: "admin", cv }, 12) };
    },
    async adminChangePassword(b) {
      await admin(b);
      const password = String(b.newPassword || "");
      if (password.length < 12) throw new Err("Use a new password with at least 12 characters.");
      await S("auth:password", await hashPassword(password));
      await S("auth:version", (await J("auth:version", 0)) + 1);
      return { changed: true, reLoginRequired: true };
    },
    async adminRecoverPassword(b) {
      const recoveryKey = process.env.DCC_MASTER_RECOVERY_KEY;
      if (!recoveryKey) throw new Err("Owner recovery is not configured on the server.", 503);
      if (!sameSecret(b.recoveryKey, recoveryKey)) throw new Err("Recovery verification failed.", 401);
      const password = String(b.newPassword || "");
      if (password.length < 12) throw new Err("Use a new password with at least 12 characters.");
      await S("auth:password", await hashPassword(password));
      await S("auth:version", (await J("auth:version", 0)) + 1);
      return { changed: true, reLoginRequired: true };
    },


    async adminGoogleStart(b) {
      await admin(b);
      const { GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI } = process.env;
      if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI || !process.env.GOOGLE_CLIENT_SECRET) throw new Err("Google OAuth is not configured in Netlify yet.", 503);
      const state = sign({ role: "googleOAuth", nonce: crypto.randomBytes(16).toString("hex") }, 0.25);
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI, response_type: "code", scope: "https://www.googleapis.com/auth/drive.readonly", access_type: "offline", prompt: "consent", state }).toString();
      return { url: url.toString() };
    },
    async classGoogleList(b) {
      await admin(b);
      const token = await googleAccessToken();
      const q = "trashed=false and mimeType='video/mp4'";
      const url = "https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({ q, pageSize: "100", orderBy: "createdTime desc", fields: "files(id,name,mimeType,createdTime,size)" });
      const response = await fetch(url, { headers: { authorization: "Bearer " + token } }), data = await response.json();
      if (!response.ok) throw new Err("Google Drive could not list recordings. Check the Drive API and OAuth permissions.", 502);
      return { recordings: data.files || [] };
    },
    async classAdminAttachRecording(b) {
      await admin(b);
      const classId = String(b.classId || ""), fileId = String(b.fileId || ""), name = String(b.name || "Meet recording").slice(0, 160);
      const list = await classList(), item = list.find(x => x.id === classId);
      if (!item || !fileId) throw new Err("Choose a class and a Drive recording.");
      const token = await googleAccessToken();
      const r = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?fields=id,name,mimeType", { headers: { authorization: "Bearer " + token } });
      const file = await r.json();
      if (!r.ok || !file.id || !String(file.mimeType || "").startsWith("video/")) throw new Err("That Drive file is not an accessible video recording.");
      const recordings = [...(item.recordings || []).filter(x => x.id !== file.id), { id: file.id, name: file.name || name }];
      await S("classes:list", list.map(x => x.id === classId ? { ...x, recordings } : x));
      return {};
    },
    async classRecordingPlay(b) {
      const p = verify(b.token, "classStudent");
      if (!p) throw new Err("Please sign in again.", 401);
      const id = String(b.recordingId || ""), access = await J("class-access:" + enc(id) + ":" + enc(p.sid));
      if (!access) throw new Err("Your teacher has not granted access to this recording.", 403);
      const used = await J("class-views:" + enc(id) + ":" + enc(p.sid), 0);
      if (used >= access.maxViews) throw new Err("You have used all allowed views.", 403);
      const token = sign({ role: "classPlay", sid: p.sid, fileId: id }, 1 / 12);
      return { url: (process.env.URL || "") + "/.netlify/functions/api?play=" + encodeURIComponent(token) };
    },
    async classAdminList(b) {
      await admin(b);
      const admissions = await J("admissions", []);
      return { classes: await classList(), students: admissions.filter(a => a.exam_id && a.exam_pass).map(a => ({ id: String(a.exam_id), name: String(a.student_name || ""), batch: String(a.class_grade || "") })) };
    },
    async classAdminSave(b) {
      await admin(b);
      const title = String(b.title || "").trim().slice(0, 120), batch = String(b.batch || "").trim().slice(0, 80);
      const meetUrl = String(b.meetUrl || "").trim();
      if (!title || !batch || !validMeetUrl(meetUrl)) throw new Err("Enter a title, batch and valid Google Meet link.");
      const list = await classList(), id = String(b.id || ("CLS" + Date.now()));
      const old = list.find(x => x.id === id);
      const item = { id, title, batch, meetUrl, startsAt: String(b.startsAt || "").slice(0, 40), published: !!b.published, archived: false, recordings: old?.recordings || [], updatedAt: new Date().toISOString() };
      const next = old ? list.map(x => x.id === id ? item : x) : [item, ...list];
      await S("classes:list", next); return { classes: next };
    },
    async classAdminArchive(b) {
      await admin(b);
      const id = String(b.id || ""), list = await classList();
      await S("classes:list", list.map(x => x.id === id ? { ...x, archived: true, published: false } : x));
      return {};
    },
    async classAdminGrant(b) {
      await admin(b);
      const classId = String(b.classId || ""), recordingId = String(b.recordingId || ""), sid = String(b.studentId || "").trim();
      const maxViews = Math.max(0, Math.min(100, Math.floor(Number(b.maxViews))));
      if (!classId || !recordingId || !sid || !Number.isFinite(maxViews) || maxViews < 1) throw new Err("Choose a student and set at least one allowed view.");
      const admissions = await J("admissions", []);
      if (!admissions.some(a => String(a.exam_id || "").toLowerCase() === sid.toLowerCase() && a.exam_pass)) throw new Err("Student ID not found.");
      await S("class-access:" + enc(recordingId) + ":" + enc(sid), { classId, recordingId, studentId: sid, maxViews, grantedAt: Date.now() });
      return {};
    },
    async classStudentLogin(b) {
      const a = await findStudent(b.id, b.password);
      if (!a) throw new Err("Incorrect Student ID or password.", 401);
      const token = sign({ role: "classStudent", sid: a.exam_id, name: a.student_name, batch: a.class_grade }, 8);
      return { token, student: { id: a.exam_id, name: a.student_name, batch: a.class_grade } };
    },
    async classStudentData(b) {
      const p = verify(b.token, "classStudent");
      if (!p) throw new Err("Session expired. Please log in again.", 401);
      const classes = (await classList()).filter(c => c.published && !c.archived && String(c.batch).toLowerCase() === String(p.batch || "").toLowerCase());
      const recordings = [];
      for (const c of classes) for (const rec of c.recordings || []) {
        const access = await J("class-access:" + enc(rec.id) + ":" + enc(p.sid));
        if (access) {
          const used = await J("class-views:" + enc(rec.id) + ":" + enc(p.sid), 0);
          recordings.push({ classId: c.id, recordingId: rec.id, title: rec.name, maxViews: access.maxViews, used, remaining: Math.max(0, access.maxViews - used) });
        }
      }
      return { classes: classes.map(c => ({ id: c.id, title: c.title, batch: c.batch, startsAt: c.startsAt, meetUrl: c.meetUrl })), recordings };
    },
    async adminGet(b) {
      await admin(b); const exams = await J("exams"); await finalizeExpired(exams); await mergeInbox();
      const results = []; for (const k of await keys("res:")) { const r = await J(k); if (r) results.push(r); }
      return { admissions: await J("admissions"), enquiries: await J("enquiries"), exams, results };
    },
    async adminSet(b) {
      await admin(b);
      for (const [name, value] of Object.entries(b.sets || {})) { if (!["admissions", "enquiries", "exams"].includes(name) || (name === "exams" ? typeof value !== "object" : !Array.isArray(value))) throw new Err("Bad data."); await S(name, value); }
      return {};
    },
    async adminPutPdf(b) { await admin(b); if (typeof b.b64 !== "string" || b.b64.length > 5.6e6 || !b.id) throw new Err("PDF too large (max about 4 MB)."); await store.set("pdf:" + b.id, b.b64); return {}; },
    async adminGetPdf(b) {
      await admin(b);
      const id = String(b.id || "");
      if (!id || id.length > 120) throw new Err("Invalid paper ID.");
      const ex = Object.values(await J("exams", {})).find(e => e.id === id);
      if (!ex || !ex.hasPdf) throw new Err("No question paper is registered for this exam.", 404);
      const b64 = await store.get("pdf:" + id);
      if (!b64) throw new Err("The stored question paper was not found.", 404);
      return { b64, filename: String(ex.pdfName || "question-paper.pdf").replace(/[^a-zA-Z0-9._-]/g, "_") };
    },
    async adminDelResults(b) {
      await admin(b); const id = String(b.examId || "");
      if (b.sid) { await store.delete(`res:${id}:${enc(b.sid)}`); return {}; }
      for (const k of await keys(`res:${id}:`)) await store.delete(k);
      for (const k of await keys("sess:")) { const s = await J(k); if (s && s.examId === id) await store.delete(k); }
      if (!b.keepPdf) await store.delete("pdf:" + id);
      return {};
    },
    async form(b) {
      if (!["admissions", "enquiries"].includes(b.kind) || typeof b.record !== "object" || !b.record) throw new Err("Bad form.");
      if ((await keys("inbox:")).length > 500) throw new Err("Too many pending forms, please call us.");
      const rec = {}; Object.entries(b.record).slice(0, 20).forEach(([k, v]) => { if (/^exam_/.test(k) || k === "id" || !["string", "number"].includes(typeof v)) return; rec[String(k).slice(0, 40)] = String(v).slice(0, k === "message" || k === "notes" ? 1000 : 200); });
      rec.status = "New"; rec.created_at = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      await S(`inbox:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, { kind: b.kind, record: rec }); return {};
    },
    async publicInfo() {
      const exams = await J("exams", {}); await finalizeExpired(exams); const out = {};
      for (const ex of Object.values(exams)) {
        if (!ex.showResults) continue; const rs = [];
        for (const k of await keys(`res:${ex.id}:`)) { const r = await J(k); if (r) rs.push({ name: r.name, class_grade: r.class_grade, score: r.score, total: r.total, percent: r.percent, time_taken: r.time_taken }); }
        out[ex.tag] = { title: ex.title, results: rs };
      }
      return { results: out };
    },
    async studentLogin(b) {
      const sid = String(b.id || "").trim().toLowerCase(), adms = await J("admissions", []);
      const a = adms.find(x => x.exam_id && String(x.exam_id).toLowerCase() === sid && x.exam_pass === b.pw);
      if (!a) throw new Err("Incorrect Student ID or password.", 401);
      const exams = await J("exams", {}); await finalizeExpired(exams);
      const st = { student_name: a.student_name, class_grade: a.class_grade, exam_id: a.exam_id }, ex = exams[a.exam_tag];
      if (!ex) return { status: "notag", student: st };
      const done = await J(`res:${ex.id}:${enc(a.exam_id)}`); if (done) return { status: "done", student: st, result: done, title: ex.title };
      const token = sign({ role: "student", sid: a.exam_id, tag: a.exam_tag, name: a.student_name, cls: a.class_grade }, 8), sess = await J(`sess:${enc(a.exam_id)}`);
      if (sess && sess.examId === ex.id) return { status: "resume", token, student: st, meta: metaOf(ex), remaining: sess.end - Date.now(), ans: sess.ans || {} };
      if (!ex.active || !ex.key.length || !ex.hasPdf) return { status: "closed", student: st };
      return { status: "ready", token, student: st, meta: metaOf(ex) };
    },
    async studentStart(b) {
      const p = student(b), ex = (await J("exams", {}))[p.tag];
      if (!ex || !ex.active || !ex.key.length || !ex.hasPdf) throw new Err("There is no exam open right now.");
      if (await J(`res:${ex.id}:${enc(p.sid)}`)) throw new Err("You have already submitted this test.");
      let sess = await J(`sess:${enc(p.sid)}`);
      if (!(sess && sess.examId === ex.id)) {
        if (b.snap && b.snap !== [ex.correct, ex.negative, ex.duration, ex.key.length].join("|")) return { changed: true, meta: metaOf(ex) };
        const now = Date.now(); sess = { examId: ex.id, sid: p.sid, name: p.name, cls: p.cls, start: now, end: now + ex.duration * 60000, m: ex.correct, ng: ex.negative, ans: {} }; await S(`sess:${enc(p.sid)}`, sess);
      }
      return { remaining: sess.end - Date.now(), ans: sess.ans };
    },
    async studentFlag(b) {
      const p = student(b);
      const reason = String(b.reason || "").slice(0, 40);
      if (!["tab-hidden", "fullscreen-exit"].includes(reason)) throw new Err("Invalid integrity event.");
      const key = "exam-flags:" + enc(p.sid), events = await J(key, []);
      events.push({ reason, at: Date.now() });
      await S(key, events.slice(-100));
      return { recorded: true };
    },
    async studentSave(b) {
      const p = student(b), sess = await J(`sess:${enc(p.sid)}`); if (!sess) throw new Err("No active test.");
      if (Date.now() > sess.end + GRACE) return { expired: true };
      const ex = (await J("exams", {}))[p.tag]; sess.ans = cleanAns(b.ans, ex.key.length); await S(`sess:${enc(p.sid)}`, sess); return {};
    },
    async studentPdf(b) {
      const p = student(b), ex = (await J("exams", {}))[p.tag], sess = await J(`sess:${enc(p.sid)}`);
      if (!ex || !sess || sess.examId !== ex.id) throw new Err("Start the test first.");
      const b64 = await store.get("pdf:" + ex.id); if (!b64) throw new Err("The question paper is not available.", 404); return { b64 };
    },
    async studentSubmit(b) {
      const p = student(b), ex = (await J("exams", {}))[p.tag]; if (!ex) throw new Err("Exam not found.");
      const done = await J(`res:${ex.id}:${enc(p.sid)}`); if (done) return { result: done };
      const sess = await J(`sess:${enc(p.sid)}`); if (!sess || sess.examId !== ex.id) throw new Err("No active test to submit.");
      const ans = Date.now() <= sess.end + 30000 && b.ans ? cleanAns(b.ans, ex.key.length) : (sess.ans || {});
      return { result: await score(ex, sess, ans, b.auto) };
    },
  };

  return async function handle(req) {
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.has("code") && url.searchParams.has("state")) {
        const state = verify(url.searchParams.get("state"), "googleOAuth");
        if (!state || !url.searchParams.get("code")) return new Response("Google connection failed: invalid OAuth state.", { status: 400 });
        try {
          const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: url.searchParams.get("code"), client_id: process.env.GOOGLE_CLIENT_ID || "", client_secret: process.env.GOOGLE_CLIENT_SECRET || "", redirect_uri: process.env.GOOGLE_REDIRECT_URI || "", grant_type: "authorization_code" }) });
          const data = await response.json();
          if (!response.ok || !data.refresh_token) return new Response("Google did not return a refresh token. Reconnect and approve Drive access.", { status: 400 });
          await S("google:refresh", encryptSecret(data.refresh_token));
          return new Response("<h2>Google Drive connected.</h2><p>You can close this tab and return to the Class Portal.</p>", { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        } catch { return new Response("Could not securely save the Google connection.", { status: 500 }); }
      }
      const play = url.searchParams.get("play");
      if (play) {
        const p = verify(play, "classPlay");
        if (!p) return json({ error: "Playback link expired. Request a new one." }, 401);
        const access = await J("class-access:" + enc(p.fileId) + ":" + enc(p.sid));
        const used = await J("class-views:" + enc(p.fileId) + ":" + enc(p.sid), 0);
        if (!access || used >= access.maxViews) return json({ error: "No recording views remain." }, 403);
        const token = await googleAccessToken();
        const upstream = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(p.fileId) + "?alt=media", { headers: { authorization: "Bearer " + token } });
        if (!upstream.ok) return json({ error: "Google Drive could not stream this recording." }, 502);
        await S("class-views:" + enc(p.fileId) + ":" + enc(p.sid), used + 1);
        return new Response(upstream.body, { headers: { "content-type": upstream.headers.get("content-type") || "video/mp4", "cache-control": "private, no-store", "content-disposition": "inline" } });
      }
      return json({ error: "Unknown GET action." }, 404);
    }
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    try {
      const b = await req.json(), fn = actions[b.action]; if (!fn) throw new Err("Unknown action.");
      return json(await fn(b));
    } catch (e) { return json({ error: e instanceof Err ? e.message : "Server error." }, e instanceof Err ? e.status : 500); }
  };
}

export default async (req) => {
  const { getStore } = await import("@netlify/blobs");
  return makeApi(getStore({ name: "dcc", consistency: "strong" }))(req);
};
