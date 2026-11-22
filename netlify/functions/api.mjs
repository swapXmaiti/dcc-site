// Shared backend for Debasish Chemistry Classes: admissions, exam papers, answer keys, student attempts and results.
// Data lives in Netlify Blobs. The answer key, student passwords and admission details never leave the server.
import crypto from "node:crypto";

const legacyAdminPassword = () => process.env.ADMIN_PASSWORD || "";
const passwordHash = (password, salt) => crypto.scryptSync(password, salt, 64).toString("hex");
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
async function adminPasswordMatches(store, candidate) {
  const saved = await store.get("admin:password", { type: "json" });
  if (saved?.salt && saved?.hash) return safeEqual(passwordHash(String(candidate || ""), saved.salt), saved.hash);
  return !!legacyAdminPassword() && !!candidate && safeEqual(String(candidate), legacyAdminPassword());
}
const secret = () => process.env.APP_SECRET || crypto.createHash("sha256").update("dcc|" + legacyAdminPassword()).digest("hex");
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
  const admin = b => { if (!verify(b.token, "admin")) throw new Err("Please log in again.", 401); };
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

  const actions = {
    async adminLogin(b) { if (!(await adminPasswordMatches(store, b.password)) && !(process.env.ADMIN_RECOVERY_KEY && safeEqual(String(b.password || ""), process.env.ADMIN_RECOVERY_KEY))) throw new Err("Incorrect password.", 401); return { token: sign({ role: "admin" }, 12) }; },
    async adminChangePassword(b) {
      admin(b);
      if (!(await adminPasswordMatches(store, b.currentPassword)) && !(process.env.ADMIN_RECOVERY_KEY && safeEqual(String(b.currentPassword || ""), process.env.ADMIN_RECOVERY_KEY))) throw new Err("Current password or recovery key is incorrect.", 401);
      const next = String(b.newPassword || "");
      if (next.length < 10 || next.length > 128) throw new Err("New password must be 10–128 characters.");
      const salt = crypto.randomBytes(16).toString("hex");
      await S("admin:password", { salt, hash: passwordHash(next, salt), updatedAt: new Date().toISOString() });
      return { changed: true };
    },
    async adminGet(b) {
      admin(b); const exams = await J("exams"); await finalizeExpired(exams); await mergeInbox();
      const results = []; for (const k of await keys("res:")) { const r = await J(k); if (r) results.push(r); }
      return { admissions: await J("admissions"), enquiries: await J("enquiries"), exams, results };
    },
    async adminSet(b) {
      admin(b);
      for (const [name, value] of Object.entries(b.sets || {})) { if (!["admissions", "enquiries", "exams"].includes(name) || (name === "exams" ? typeof value !== "object" : !Array.isArray(value))) throw new Err("Bad data."); await S(name, value); }
      return {};
    },
    async adminPutPdf(b) { admin(b); if (typeof b.b64 !== "string" || b.b64.length > 5.6e6 || !b.id) throw new Err("PDF too large (max about 4 MB)."); await store.set("pdf:" + b.id, b.b64); return {}; },
    async adminGetPdf(b) {
      admin(b);
      const id = String(b.id || ""), exams = await J("exams", {});
      if (!id || !Object.values(exams).some(ex => ex.id === id && ex.hasPdf)) throw new Err("Question paper not found.", 404);
      const b64 = await store.get("pdf:" + id);
      if (!b64) throw new Err("Question paper is not available in shared storage.", 404);
      return { b64 };
    },
    async adminDelResults(b) {
      admin(b); const id = String(b.examId || "");
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
