/* Bedrock lender portal. Plain static JS, no build step.
   Rule: user data is only ever put on the page with textContent / createTextNode. Never innerHTML. */
(function () {
  "use strict";
  var CFG = window.PORTAL_CONFIG || {};
  var PREVIEW = /[?&]preview=1(&|$)/.test(location.search);
  var MAX_BYTES = 26214400;
  var ALLOWED_EXT = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", csv: "text/csv" };
  var STEPS = [["received", "Received"], ["reviewing", "Reviewing"], ["terms_sent", "Terms sent"],
    ["terms_accepted", "Terms accepted"], ["paperwork", "Paperwork and checks"], ["closing", "Closing"],
    ["funded", "Funded"]];
  /* "complete" (ledger exited) shows as the last step, labelled Complete, never as Funded */
  var STEP_BLURB = {
    received: "We have your deal. A person is about to look at it.",
    reviewing: "We are reading your deal and checking the numbers.",
    terms_sent: "We sent terms. Take a look and tell us what you think.",
    terms_accepted: "You said yes to the terms. Next is the paperwork.",
    paperwork: "We are collecting papers and running checks.",
    closing: "We are getting ready to close.",
    funded: "Closed and funded.",
    complete: "All done on this deal.",
    not_moving_forward: "We are not moving forward on this one."
  };
  var REASONS = { not_a_fit_now: "It is not a fit right now.", numbers_didnt_work: "The numbers did not work.",
    missing_papers: "We were missing papers.", sponsor_withdrew: "The sponsor stepped back.", other: "Another reason. See the notes." };
  var SECTIONS = { you: "About you", property: "The property", plan: "The plan", value: "Value", costs: "Costs",
    senior: "Senior lender terms", cash: "Cash going in", track: "Track record and guarantee", also: "A few more things", timing: "Timing" };
  var SECTION_ORDER = ["you", "property", "plan", "value", "costs", "senior", "cash", "track", "also", "timing"];
  var TODO_STATUS = { open: ["Needs you", "o"], waiting_check: ["We are checking it", "y"], done: ["Done", "g"], waived: ["Not needed", ""] };
  var DRAFT_KEY = "bedrock_portal_draft_v1";

  /* ---------- tiny helpers ---------- */
  function h(tag, props) {
    var el = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function $(s, r) { return (r || document).querySelector(s); }
  function store(op, k, v) {
    try {
      if (op === "get") return window.localStorage.getItem(k);
      if (op === "set") window.localStorage.setItem(k, v);
      if (op === "del") window.localStorage.removeItem(k);
    } catch (e) { /* storage may be blocked */ }
    return null;
  }
  function sess(op, k, v) {
    try {
      if (op === "get") return window.sessionStorage.getItem(k);
      if (op === "set") window.sessionStorage.setItem(k, v);
      if (op === "del") window.sessionStorage.removeItem(k);
    } catch (e) { /* ignore */ }
    return null;
  }
  function fmtDate(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d)) return String(s);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function ageDays(s) { var d = new Date(s); return isNaN(d) ? 0 : Math.max(0, Math.floor((Date.now() - d.getTime()) / 864e5)); }
  function stepLabel(k) { if (k === "complete") return "Complete"; for (var i = 0; i < STEPS.length; i++) if (STEPS[i][0] === k) return STEPS[i][1]; return k === "not_moving_forward" ? "Not moving forward" : String(k || ""); }
  function stepIndex(k) { if (k === "complete") return STEPS.length - 1; for (var i = 0; i < STEPS.length; i++) if (STEPS[i][0] === k) return i; return -1; }
  function goodUrl(u) { return typeof u === "string" && /^https:\/\//.test(u) && u.indexOf("__") < 0; }
  function money(v) {
    if (v == null || v === "") return "";
    var n = Number(v);
    return isNaN(n) ? String(v) : "$" + n.toLocaleString("en-US");
  }
  function planLabel(v) {
    var f = (FORM || []).filter(function (x) { return x.id === "plan_type"; })[0];
    if (f && f.options) for (var i = 0; i < f.options.length; i++) if (f.options[i].value === v) return f.options[i].label;
    return v || "";
  }

  /* ---------- form definition ---------- */
  var FORM = [];
  function loadForm() {
    if (FORM.length) return Promise.resolve(FORM);
    return fetch("form-v1.json", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("form");
      return r.json();
    }).then(function (j) { FORM = j; return j; });
  }

  /* ---------- fake backend for ?preview=1 ---------- */
  function makeFake() {
    var now = Date.now(), DAY = 864e5, seq = 100;
    function iso(d) { return new Date(now - d * DAY).toISOString(); }
    var starters = ["Appraisal", "Purchase contract", "Senior lender's term sheet (does not need to be signed)", "Budget for the work", "Sponsor's company papers", "Guarantor's money statement"];
    function mkTodos(dealId, texts, status) {
      return texts.map(function (t) { return { id: "t" + (++seq), deal_id: dealId, text: t, kind: "upload", status: status || "open", made_by: "starter", created_at: iso(1) }; });
    }
    function answers(street, city, st, zip, plan) {
      return { name: "Pat Sample", company: "Sample Lending Co (fake)", email: "lender1@example.test", role: "loan_officer",
        street: street, city: city, state: st, zip: zip, plan_type: plan, purchase_price: 250000, arv: 420000, budget_total: 80000,
        senior_loan_amount: 200000, closing_date: "2026-12-15" };
    }
    var users = {
      "lender1@example.test": { id: "u1", email: "lender1@example.test", name: "Pat Sample", company: "Sample Lending Co (fake)", staff: false },
      "lender2@example.test": { id: "u2", email: "lender2@example.test", name: "Robin Example", company: "Example Mortgage (fake)", staff: false },
      "staff@example.test": { id: "s1", email: "staff@example.test", name: "Staff Sample", company: "Bedrock (fake)", staff: true }
    };
    var deals = [];
    function D(o) {
      o.id = "d" + (++seq);
      o.todos = o.todos || []; o.notes = o.notes || []; o.files = o.files || [];
      o.todos.forEach(function (t) { t.deal_id = o.id; });
      deals.push(o); return o;
    }
    var d1 = D({ owner: "u1", address: "123 Test St, Sampletown, FL 33000", plan_type: "fix_flip", submitted_at: iso(0.5), step: "received", step_date: iso(0.5), submit_email: "lender1@example.test", submitter_role: "loan_officer", new_sender: true, ledger_deal_key: null, answers: answers("123 Test St", "Sampletown", "FL", "33000", "fix_flip") });
    d1.todos = mkTodos(d1.id, starters);
    var d2 = D({ owner: "u1", address: "45 Example Ave, Fakeville, GA 30000", plan_type: "apartments_value_add", submitted_at: iso(6), step: "terms_sent", step_date: iso(2), submit_email: "lender1@example.test", submitter_role: "loan_officer", new_sender: false, ledger_deal_key: "FAKE-KEY-45", answers: answers("45 Example Ave", "Fakeville", "GA", "30000", "apartments_value_add"),
      notes: [{ id: "n1", text: "We sent terms today. Call Shravaan if you have questions. (fake note)", visible_to_lender: true, created_at: iso(2) }] });
    d2.todos = [{ id: "t" + (++seq), text: "Tell us if the terms work for you", kind: "answer", status: "open", made_by: "staff", created_at: iso(2) }];
    var d3 = D({ owner: "u1", address: "9 Demo Road, Mockton, TX 75000", plan_type: "build_new", submitted_at: iso(20), step: "paperwork", step_date: iso(3), submit_email: "lender1@example.test", submitter_role: "loan_officer", new_sender: false, ledger_deal_key: "FAKE-KEY-9", answers: answers("9 Demo Road", "Mockton", "TX", "75000", "build_new"),
      notes: [{ id: "n2", text: "Thanks for the appraisal. We are checking it now. (fake note)", visible_to_lender: true, created_at: iso(3) }, { id: "n3", text: "Staff only note. You should never see this one.", visible_to_lender: false, created_at: iso(3) }] });
    d3.todos = [
      { id: "t" + (++seq), text: "Purchase contract", kind: "upload", status: "open", made_by: "starter", created_at: iso(20) },
      { id: "t" + (++seq), text: "Sponsor's company papers", kind: "upload", status: "open", made_by: "starter", created_at: iso(20) },
      { id: "t" + (++seq), text: "Appraisal", kind: "upload", status: "waiting_check", made_by: "starter", created_at: iso(20) },
      { id: "t" + (++seq), text: "Budget for the work", kind: "upload", status: "done", made_by: "starter", created_at: iso(20) }];
    d3.files = [{ id: "f1", original_name: "budget-fake.pdf", size_bytes: 120000, created_at: iso(10), check_status: "ok", todo_id: d3.todos[3].id },
      { id: "f2", original_name: "appraisal-fake.pdf", size_bytes: 450000, created_at: iso(3), check_status: "pending", todo_id: d3.todos[2].id }];
    D({ owner: "u1", address: "77 Pretend Ln, Testburg, OH 44000", plan_type: "fix_flip", submitted_at: iso(30), step: "not_moving_forward", reason_code: "missing_papers", step_date: iso(8), submit_email: "lender1@example.test", submitter_role: "loan_officer", new_sender: false, ledger_deal_key: "FAKE-KEY-77", answers: answers("77 Pretend Ln", "Testburg", "OH", "44000", "fix_flip"),
      notes: [{ id: "n4", text: "We never got the purchase contract. Send it and we will look again. (fake note)", visible_to_lender: true, created_at: iso(8) }] });
    var d5 = D({ owner: "u2", address: "500 Sample Blvd, Faketown, NC 27000", plan_type: "apartments_stabilized", submitted_at: iso(14), step: "reviewing", step_date: iso(12), submit_email: "lender2@example.test", submitter_role: "broker", new_sender: false, ledger_deal_key: null, answers: answers("500 Sample Blvd", "Faketown", "NC", "27000", "apartments_stabilized") });
    d5.todos = [{ id: "t" + (++seq), text: "Rent roll", kind: "upload", status: "open", made_by: "engine", created_at: iso(12) }];
    D({ owner: "u2", address: "1 Placeholder Way, Demoville, AZ 85000", plan_type: "commercial", submitted_at: iso(45), step: "closing", step_date: iso(1), submit_email: "lender2@example.test", submitter_role: "broker", new_sender: false, ledger_deal_key: "FAKE-KEY-1", answers: answers("1 Placeholder Way", "Demoville", "AZ", "85000", "commercial") });
    var requests = [{ id: "r1", email: "newperson@example.test", name: "New Person", company: "Fake Capital Group", created_at: iso(1), status: "waiting" },
      { id: "r2", email: "another@example.test", name: "Another Sample", company: "Pretend Lending", created_at: iso(3), status: "waiting" }];
    var cur = null;
    try { var saved = sess("get", "fake_user"); if (saved && users[saved]) cur = users[saved]; } catch (e) { /* ignore */ }
    function mine() { return deals.filter(function (d) { return cur && d.owner === cur.id; }); }
    function find(id) { var r = deals.filter(function (d) { return d.id === id; })[0]; if (!r) throw new Error("not found"); return r; }
    function wait(v) { return new Promise(function (res) { setTimeout(function () { res(v); }, 120); }); }
    function row(d) {
      return { id: d.id, deal_id: d.id, address: d.address, plan_type: d.plan_type, submitted_at: d.submitted_at, step: d.step, step_date: d.step_date,
        reason_code: d.reason_code || null, open_todo_count: d.todos.filter(function (t) { return t.status === "open"; }).length };
    }
    return {
      session: function () { return wait(cur ? { user: { id: cur.id, email: cur.email }, name: cur.name, isStaff: cur.staff, aal: "aal2" } : null); },
      start: function (email) {
        var e = String(email || "").toLowerCase();
        if (!users[e] && !requests.some(function (r) { return r.email === e; })) requests.push({ id: "r" + (++seq), email: e, name: "", company: "", created_at: iso(0), status: "waiting" });
        return wait({ ok: true, message: "If you sent us a deal with this email, or we already know you, a code is on its way. If not, our team will look at your request and email you." });
      },
      verifyCode: function (email, code) {
        var u = users[String(email || "").toLowerCase()];
        if (u && String(code).trim() === "123456") { cur = u; sess("set", "fake_user", u.email); return wait({ ok: true }); }
        return wait({ ok: false, error: "That code did not work. Check it and try again." });
      },
      signOut: function () { cur = null; sess("del", "fake_user"); return wait(true); },
      submit: function (p) {
        var deal = D({ owner: null, address: [p.street, p.city, p.state, p.zip].filter(Boolean).join(", "), plan_type: p.plan_type, submitted_at: new Date().toISOString(), step: "received", step_date: new Date().toISOString(), submit_email: p.email, submitter_role: p.role, new_sender: true, ledger_deal_key: null, answers: p });
        deal.todos = mkTodos(deal.id, starters);
        if (cur && cur.email === String(p.email).toLowerCase()) deal.owner = cur.id;
        return wait({ ok: true, deal_ref: "BR-TEST-" + (1000 + seq), next: { book_call_url: "https://example.test/book-a-call", track_url: "#/signin" } });
      },
      claimDeals: function () { return wait(0); },
      updateProfile: function () { return wait(true); },
      myDeals: function () { return wait(mine().map(row)); },
      dealDetail: function (id) {
        var d = find(id);
        if (!cur || (d.owner !== cur.id && !cur.staff)) throw new Error("not yours");
        return wait({ deal: row(d), answers: d.answers, todos: d.todos.slice(), files: d.files.slice(),
          notes: d.notes.filter(function (n) { return cur.staff || n.visible_to_lender; }) });
      },
      uploadFile: function (dealId, todoId, file) {
        var d = find(dealId);
        d.files.push({ id: "f" + (++seq), original_name: file.name, size_bytes: file.size, created_at: new Date().toISOString(), check_status: "ok", todo_id: todoId });
        d.todos.forEach(function (t) { if (t.id === todoId) t.status = "done"; });
        return wait({ ok: true });
      },
      staffListDeals: function () {
        return wait(deals.map(function (d) { var r = row(d); r.submit_email = d.submit_email; r.submitter_role = d.submitter_role; r.new_sender = d.new_sender; r.unverified_sender = d.new_sender; r.is_new = d.step === 'received'; r.stale = ['funded','complete','not_moving_forward'].indexOf(d.step) < 0 && ageDays(d.step_date) > 7; r.age_days = ageDays(d.submitted_at); r.ledger_deal_key = d.ledger_deal_key; return r; }));
      },
      staffDealDetail: function (id) { return this.dealDetail(id); },
      staffRequests: function () { return wait(requests.filter(function (r) { return r.status === "waiting"; })); },
      staffDecide: function (id, ok) { requests.forEach(function (r) { if (r.id === id) r.status = ok ? "approved" : "denied"; }); return wait(true); },
      staffLink: function (id, key) { find(id).ledger_deal_key = key; return wait(true); },
      staffAddTodo: function (id, text, kind) { find(id).todos.push({ id: "t" + (++seq), text: text, kind: kind || "upload", status: "open", made_by: "staff", created_at: new Date().toISOString() }); return wait(true); },
      staffSetTodo: function (todoId, status) { deals.forEach(function (d) { d.todos.forEach(function (t) { if (t.id === todoId) t.status = status; }); }); return wait(true); },
      staffAddNote: function (id, text, vis) { find(id).notes.push({ id: "n" + (++seq), text: text, visible_to_lender: !!vis, created_at: new Date().toISOString() }); return wait(true); },
      staffSetStep: function (id, step, reason, note) { var d = find(id); d.step = step; d.reason_code = reason || null; d.step_date = new Date().toISOString(); if (note) d.notes.push({ id: "n" + (++seq), text: note, visible_to_lender: true, created_at: d.step_date }); return wait(true); },
      staffOpenFile: function () { return wait({ url: null, fake: true }); },
      staffMfa: function () { return wait(/[?&]mfa=setup/.test(location.search) && !window.__mfaDone ? { needed: true, hasFactor: false } : { needed: false }); },
      mfaEnroll: function () {
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/><path d="M1 1h3v3H1zM6 1h3v3H6zM1 6h3v3H1zM6 6h1v1H6zM8 8h1v1H8z" fill="#1D1712"/></svg>';
        return wait({ factorId: "preview", qr: "data:image/svg+xml;utf8," + encodeURIComponent(svg), secret: "PREVIEW SECRET ABCD" });
      },
      mfaEnrollVerify: function (id, code) { if (String(code).trim() !== "123456") return Promise.reject(new Error("That code did not work. Preview: use 123456.")); window.__mfaDone = true; return wait(true); }
    };
  }

  /* ---------- real backend (supabase-js) ---------- */
  // Names follow build/API-NAMES.md: only supabase.rpc("portal_<name>", {p_...}) and the edge functions.
  function friendly(msg) {
    msg = String(msg || "");
    if (msg.indexOf("portal_disabled") >= 0) return "Back soon.";
    if (msg.indexOf("not_signed_in") >= 0 || msg.indexOf("not_allowed") >= 0) return "Please sign in again.";
    if (msg.indexOf("not_found") >= 0) return "We can't find that deal.";
    if (msg.indexOf("staff_only") >= 0) return "This page is for staff who finished the second check.";
    if (msg.indexOf("limit:") >= 0) return "That's the limit for now.";
    var m = msg.match(/invalid: ?([a-z_0-9]+): ?(.*)/);
    if (m) return m[2] || "Please check " + m[1] + ".";
    return "Something went wrong. Try again.";
  }
  function makeReal() {
    var N = { rpcPrefix: "portal_", fn: { start: "portal-start", submit: "portal-submit", uploadCheck: "portal-upload-check", fileOpen: "portal-file-open" }, bucket: "portal-files" };
    var sb = null;
    function client() {
      if (sb) return sb;
      if (!window.supabase || !window.supabase.createClient) throw new Error("The page could not load. Please refresh.");
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
      return sb;
    }
    function rpc(name, args) {
      return client().rpc(N.rpcPrefix + name, args || {}).then(function (r) {
        if (r && r.error) throw new Error(friendly(r.error.message));
        return r ? r.data : null;
      });
    }
    function fn(name, body, headers) {
      return fetch(CFG.supabaseUrl + "/functions/v1/" + name, { method: "POST",
        headers: Object.assign({ "Content-Type": "application/json", apikey: CFG.anonKey }, headers || {}), body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, message: "Something went wrong. Try again." }; }); });
    }
    function authHeader() {
      return client().auth.getSession().then(function (r) {
        var s = r.data && r.data.session;
        return s ? { Authorization: "Bearer " + s.access_token } : {};
      });
    }
    return {
      session: function () {
        return client().auth.getSession().then(function (r) {
          var s = r.data && r.data.session;
          if (!s) return null;
          return rpc("my_profile").then(function (p) {
            p = p || {};
            return { user: { id: s.user.id, email: s.user.email }, name: p.name || "", isStaff: !!p.is_staff, aal: p.aal || "aal1" };
          }, function () { return { user: { id: s.user.id, email: s.user.email }, name: "", isStaff: false, aal: "aal1" }; });
        });
      },
      start: function (email, token, name, company) {
        return fn(N.fn.start, { email: email, turnstile_token: token, name: name || undefined, company: company || undefined });
      },
      verifyCode: function (email, code) {
        return client().auth.verifyOtp({ email: email, token: String(code).trim(), type: "email" }).then(function (r) {
          return r.error ? { ok: false, error: "That code did not work. Check it and try again." } : { ok: true };
        });
      },
      signOut: function () { return client().auth.signOut(); },
      submit: function (payload) { return fn(N.fn.submit, payload); },
      claimDeals: function () { return rpc("claim_my_deals"); },
      updateProfile: function (name, phone) { return rpc("update_my_profile", { p_name: name, p_phone: phone }); },
      myDeals: function () { return rpc("my_deals").then(function (r) { return r || []; }); },
      dealDetail: function (id) { return rpc("deal_detail", { p_deal_id: id }); },
      staffDealDetail: function (id) { return rpc("staff_deal_detail", { p_deal_id: id }); },
      uploadFile: function (dealId, todoId, file) {
        var c = client(), reg;
        return rpc("register_upload", { p_deal_id: dealId, p_todo_id: todoId, p_original_name: file.name, p_mime: file.type, p_size_bytes: file.size }).then(function (r) {
          reg = r || {};
          return c.storage.from(N.bucket).upload(reg.path, file, { contentType: file.type, upsert: false });
        }).then(function (r) {
          if (r.error) throw new Error("The upload did not work. Please try again.");
          return authHeader();
        }).then(function (hd) { return fn(N.fn.uploadCheck, { file_id: reg.file_id }, hd); })
          .then(function (r) { if (r && r.ok === false) throw new Error((r.message) || "We could not accept that file. Try a PDF, picture, Word, Excel or CSV."); return r; });
      },
      staffListDeals: function () { return rpc("staff_list_deals").then(function (r) { return r || []; }); },
      staffRequests: function () { return rpc("staff_list_access_requests").then(function (r) { return (r || []).filter(function (x) { return x.status === "waiting"; }); }); },
      staffDecide: function (id, approve) { return rpc("staff_decide_access", { p_request_id: id, p_approve: approve }); },
      staffLink: function (id, key) { return rpc("staff_link_deal", { p_deal_id: id, p_ledger_deal_key: key }); },
      staffAddTodo: function (id, text, kind) { return rpc("staff_add_todo", { p_deal_id: id, p_text: text, p_kind: kind || "upload" }); },
      staffSetTodo: function (todoId, status) { return rpc("staff_set_todo", { p_todo_id: todoId, p_status: status }); },
      staffAddNote: function (id, text, vis) { return rpc("staff_add_note", { p_deal_id: id, p_text: text, p_visible: !!vis }); },
      staffSetStep: function (id, step, reason, note) { return rpc("staff_set_step", { p_deal_id: id, p_step: step || null, p_reason_code: reason || null, p_note: note || null }); },
      staffOpenFile: function (fileId) { return authHeader().then(function (hd) { return fn(N.fn.fileOpen, { file_id: fileId }, hd); }); },
      staffMfa: function () {
        return client().auth.mfa.getAuthenticatorAssuranceLevel().then(function (r) {
          var d = r.data || {};
          return { needed: d.currentLevel !== "aal2", hasFactor: d.nextLevel === "aal2" };
        });
      },
      mfaEnroll: function () {
        return client().auth.mfa.enroll({ factorType: "totp", friendlyName: "Bedrock staff " + Date.now() }).then(function (r) {
          if (r.error || !r.data) throw new Error("Could not start the setup. Please try again.");
          return { factorId: r.data.id, qr: r.data.totp && r.data.totp.qr_code, secret: r.data.totp && r.data.totp.secret };
        });
      },
      mfaEnrollVerify: function (factorId, code) {
        return client().auth.mfa.challengeAndVerify({ factorId: factorId, code: String(code).trim() })
          .then(function (r) { if (r.error) throw new Error("That code did not work. Check the time on your phone and try the newest code."); return true; });
      },
      mfaVerify: function (code) {
        var c = client();
        return c.auth.mfa.listFactors().then(function (r) {
          var f = r.data && r.data.totp && r.data.totp[0];
          if (!f) throw new Error("No second-check device is set up for this account.");
          return c.auth.mfa.challengeAndVerify({ factorId: f.id, code: String(code).trim() });
        }).then(function (r) { if (r.error) throw new Error("That code did not work."); return true; });
      }
    };
  }

  var api = PREVIEW ? makeFake() : makeReal();

  /* ---------- Turnstile ---------- */
  var tsLoading = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (tsLoading) return tsLoading;
    tsLoading = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    return tsLoading;
  }
  // gives { el, token() }
  function turnstileBox() {
    var box = h("div", { class: "tswrap" });
    var token = "";
    if (PREVIEW) { token = "preview"; return { el: box, token: function () { return token; } }; }
    var key = CFG.turnstileSiteKey;
    if (key && key.indexOf("__") < 0) {
      loadTurnstile().then(function () {
        window.turnstile.render(box, { sitekey: key, callback: function (t) { token = t; }, "expired-callback": function () { token = ""; } });
      }).catch(function () { box.textContent = "The safety check could not load. Please refresh."; });
    }
    return { el: box, token: function () { return token; } };
  }

  /* ---------- shell: nav, banner ---------- */
  var SESSION = null;
  function setNav() {
    var nav = $("#nav"), hash = location.hash || "#/";
    var items = [];
    if (SESSION && SESSION.isStaff) items.push(["#/staff", "Staff", ""]);
    items.push(SESSION ? ["#/deals", "My deals", ""] : ["#/signin", "Sign in", ""]);
    items.push(["#/send", "Send a deal", "go"]);
    nav.replaceChildren();
    items.forEach(function (it) {
      var a = h("a", { href: it[0], text: it[1], class: it[2] || null });
      if (hash.indexOf(it[0]) === 0 || (it[0] === "#/deals" && hash.indexOf("#/deal/") === 0)) a.setAttribute("aria-current", "page");
      nav.appendChild(a);
    });
    var b = $("#banner");
    if (PREVIEW) {
      b.hidden = false;
      b.replaceChildren(h("b", { text: "Preview." }), " Fake data, nothing is sent. Sign in as lender1@example.test (or lender2, or staff) with code 123456.");
    }
  }
  function signOut() { api.signOut().then(function () { SESSION = null; location.hash = "#/"; route(); }); }

  /* ---------- shared bits ---------- */
  function msg(text, kind) { return h("div", { class: "msg" + (kind ? " " + kind : ""), role: kind === "error" ? "alert" : "status", text: text }); }
  function stepBar(step) {
    var idx = stepIndex(step);
    var ol = h("ol", { class: "steps", "aria-label": "Where your deal is" });
    STEPS.forEach(function (s, i) {
      var label = (i === STEPS.length - 1 && step === "complete") ? "Complete" : s[1];
      var cls = i < idx ? "done" : i === idx ? (step === "complete" || step === "funded" ? "done" : "now") : "";
      var li = h("li", { class: cls }, label);
      if (i === idx) { li.setAttribute("aria-current", "step"); if (STEP_BLURB[step]) li.appendChild(h("span", { class: "blurb", text: STEP_BLURB[step] })); }
      ol.appendChild(li);
    });
    return ol;
  }
  function segBar(step) {
    var idx = stepIndex(step), d = h("div", { class: "seg", "aria-hidden": "true" });
    var finished = step === "funded" || step === "complete";
    STEPS.forEach(function (s, i) { d.appendChild(h("i", { class: i < idx || (finished && i === idx) ? "on" : i === idx ? "now" : "" })); });
    return d;
  }
  function stageTag(step) {
    var cls = step === "not_moving_forward" ? "stage-tag stop" : (step === "funded" || step === "complete") ? "stage-tag fin" : "stage-tag";
    return h("span", { class: cls, text: stepLabel(step) });
  }
  function stoppedBox(deal) {
    return h("div", { class: "stopped" }, h("strong", { text: "Not moving forward" }),
      h("p", { text: REASONS[deal.reason_code] || REASONS.other }));
  }
  function splitAddr(addr) {
    var s = String(addr || ""), i = s.indexOf(",");
    return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : [s || "Deal", ""];
  }
  function setMain(node, title) {
    var m = $("#main");
    m.replaceChildren(node);
    document.title = (title ? title + " | " : "") + "Bedrock for Loan Officers";
    window.scrollTo(0, 0);
  }
  function wrap() { var w = h("div", { class: "wrap" }); for (var i = 0; i < arguments.length; i++) add(w, arguments[i]); return w; }
  function needSignIn() {
    var d = wrap(h("div", { class: "signin" }, h("h1", { text: "Please sign in" }), h("p", { class: "lead", text: "Sign in to see your deals." }),
      h("div", { class: "cta" }, h("a", { class: "btn", href: "#/signin", text: "Sign in" }))));
    setMain(d, "Sign in");
  }

  /* ---------- screens ---------- */
  function landing() {
    var demoTodos = h("ul", { class: "todo-list" },
      h("li", { class: "todo-row st-done" }, h("span", { class: "todo-ic" }), h("div", { class: "todo-body" }, h("div", { class: "todo-title", text: "Purchase contract" }), h("div", { class: "todo-file", text: "contract-signed.pdf" }))),
      h("li", { class: "todo-row st-open" }, h("span", { class: "todo-ic" }), h("div", { class: "todo-body" }, h("div", { class: "todo-title", text: "Appraisal" }), h("div", { class: "todo-sub", text: "Needs you" }))));
    var demo = h("div", { class: "demo", "aria-label": "Example of a deal you can track", role: "img" },
      h("div", { class: "demo-label", text: "What you see for each deal" }),
      h("div", { class: "demo-top" }, h("div", null, h("div", { class: "demo-addr", text: "214 Oak Street" }), h("div", { class: "demo-city", text: "Example City · Fix and flip" })), stageTag("terms_sent")),
      segBar("terms_sent"),
      h("div", { class: "small mute", text: "Step 3 of " + STEPS.length }),
      h("div", { style: "margin-top:12px;border-top:1px solid var(--line)" }, demoTodos));
    var d = wrap(
      h("section", { class: "hero" },
        h("div", null,
          h("div", { class: "eyebrow", text: "For loan officers" }),
          h("h1", null, "As little as ", h("em", { text: "no money down" }), " for your borrowers."),
          h("p", { class: "lead", text: "Send a deal in about 3 minutes. Then track every step, like a permit, and see exactly what papers we still need." }),
          h("div", { class: "cta" },
            h("a", { class: "btn", href: "#/send", text: "Send a deal" }),
            h("a", { class: "btn ghost", href: SESSION ? "#/deals" : "#/signin", text: SESSION ? "My deals" : "Track my deals" }))),
        demo),
      h("section", { class: "how" },
        h("h2", { text: "How it works" }),
        h("ol", null,
          h("li", null, h("h3", { text: "Send the deal" }), h("p", { text: "A short form. No account needed to send." })),
          h("li", null, h("h3", { text: "Watch it move" }), h("p", { text: "Every deal shows its step, from received to funded." })),
          h("li", null, h("h3", { text: "Send what we need" }), h("p", { text: "A clear to-do list. Upload papers right on the page." }))),
        h("div", { class: "ai" },
          h("div", null, h("h3", { text: "Use an AI tool?" }), h("p", { text: "Your AI assistant can read our plain page and send a deal for you." })),
          h("a", { class: "btn small", href: "llms.txt", text: "Open the AI page" }))),
      faq());
    setMain(d);
  }


  function helpLine() {
    return h("p", { class: "helpline" }, "Stuck or have a question? Email ", h("a", { href: "mailto:info@mybedrock.app", text: "info@mybedrock.app" }), " and a person will help.");
  }
  function faq() {
    var qa = [
      ["What does Bedrock do?", "When your borrower is short on cash for a deal, our investors put in the missing money. They come in as partners (equity), not as another loan."],
      ["Is this a second loan?", "No. Our money is equity, a partner's share in the deal. Your loan stays the main loan."],
      ["What does \u201cno money down\u201d mean?", "Our investors can fill some or all of the cash your borrower is short. How much depends on the deal."],
      ["Does it cost anything to send a deal?", "No. Sending a deal is free. If we offer terms, they list our service fee, which pays for the setup, legal work and offering papers."],
      ["Do I need an account or a password?", "No account to send a deal. To track it, type your email and we email you a 6-digit code. There is no password."],
      ["Who will I talk to?", "Shravaan from our team calls to welcome you and talk through the deal."],
      ["Who can see my deals?", "Only you (the email you sent the deal from) and the Bedrock team."],
      ["What if I do not have every number?", "Send what you have. A best guess is fine, and the extra questions are optional."]
    ];
    return h("section", { class: "faq" }, h("h2", { text: "Common questions" }),
      qa.map(function (x) { return h("details", null, h("summary", { text: x[0] }), h("p", { text: x[1] })); }),
      helpLine());
  }

  function readDraft() {
    var raw = store("get", DRAFT_KEY);
    if (!raw) return {};
    try { var j = JSON.parse(raw); return (j && j.values) || {}; } catch (e) { return {}; }
  }

  function fmtMoneyInput(el) {
    var n0 = num(el.value);
    if (/[kmt]/i.test(el.value) && !isNaN(n0)) { el.value = n0.toLocaleString("en-US"); return; }
    var t = el.value.replace(/[$,\s]/g, "");
    if (/^\d+(\.\d{0,2})?$/.test(t)) { var p = t.split("."); el.value = Number(p[0]).toLocaleString("en-US") + (p.length > 1 ? "." + p[1] : ""); }
  }
  function fieldInput(f, value) {
    var id = "f_" + f.id, el, box;
    if (f.type === "select") {
      el = h("select", { id: id, name: f.id }, h("option", { value: "", text: "Choose one" }),
        (f.options || []).map(function (o) { return h("option", { value: o.value, text: o.label }); }));
      var tint = function () { el.classList.toggle("empty", !el.value); };
      el.addEventListener("change", tint); setTimeout(tint, 0);
    } else if (f.type === "textarea" || f.type === "url_list") {
      el = h("textarea", { id: id, name: f.id });
      if (f.type === "url_list") el.setAttribute("placeholder", "https://...");
    } else {
      var t = { email: "email", tel: "tel", date: "date", number: "text", money: "text", text: "text" }[f.type] || "text";
      el = h("input", { id: id, name: f.id, type: t });
      if (f.type === "money" || f.type === "number") el.setAttribute("inputmode", "decimal");
      if (f.type === "money") { el.addEventListener("blur", function () { fmtMoneyInput(el); }); el.setAttribute("placeholder", "250,000"); }
      if (f.type === "email") { el.setAttribute("autocomplete", "email"); el.setAttribute("autocapitalize", "off"); el.setAttribute("spellcheck", "false"); }
      if (f.id === "name") el.setAttribute("autocomplete", "name");
      if (f.id === "company") el.setAttribute("autocomplete", "organization");
      if (f.id === "phone") el.setAttribute("autocomplete", "tel");
      if (f.id === "street") el.setAttribute("autocomplete", "off");
      if (f.id === "state") { el.setAttribute("maxlength", "2"); el.setAttribute("autocapitalize", "characters"); el.setAttribute("placeholder", "FL"); }
      if (f.id === "zip") { el.setAttribute("inputmode", "numeric"); el.setAttribute("maxlength", "10"); }
    }
    if (f.required_at_send) el.setAttribute("aria-required", "true");
    if (value != null && value !== "") { el.value = value; if (f.type === "money") fmtMoneyInput(el); }
    box = f.type === "money" ? h("div", { class: "money" }, el) : el;
    var lab = h("label", { for: id }, f.label);
    var help = f.help ? h("span", { class: "help", id: id + "_help", text: f.help }) : null;
    var err = h("div", { class: "err", id: id + "_err", role: "alert" });
    el.setAttribute("aria-describedby", (help ? id + "_help " : "") + id + "_err");
    return { wrap: h("div", null, lab, box, help, err), input: el, err: err };
  }

  function sendScreen() {
    var holder = wrap(h("p", { class: "mute", text: "Loading the form..." }));
    holder.classList.add("narrow");
    setMain(holder, "Send a deal");
    loadForm().then(function (fields) {
      var draft = readDraft(), inputs = {};
      if (SESSION && SESSION.user && !draft.email) draft.email = SESSION.user.email;
      var form = h("form", { novalidate: true });
      var status = h("div", { id: "form_status" });
      var counters = [];

      function make(f) {
        var fi = fieldInput(f, draft[f.id]);
        inputs[f.id] = fi;
        var save = function () { saveDraft(inputs); counters.forEach(function (c) { c(); }); };
        fi.input.addEventListener("input", function () { fi.err.textContent = ""; fi.input.classList.remove("bad"); save(); });
        fi.input.addEventListener("change", save);
        return fi.wrap;
      }
      var quick = fields.filter(function (f) { return f.required_at_send; });
      var optional = fields.filter(function (f) { return !f.required_at_send; });
      var byId = {}; quick.forEach(function (f) { byId[f.id] = f; });
      function rowOf(ids, cls) { return h("div", { class: "row " + (cls || "two") }, ids.map(function (i) { return make(byId[i]); })); }
      function group(n, t) { return h("div", { class: "group" }, h("b", { text: String(n) }), h("h3", { text: t })); }

      var q = h("div", { class: "card" },
        h("h2", { text: "The quick part" }),
        h("p", { class: "card-sub", text: "All " + quick.length + " boxes here are needed. Everything below is optional. Not sure of a number? A best guess is fine." }),
        group(1, "You"), rowOf(["name", "company"]), rowOf(["email", "role"]),
        group(2, "The property"), h("div", { class: "row addr" }, make(byId.street), make(byId.state), make(byId.zip)), make(byId.city),
        group(3, "The numbers"), make(byId.plan_type), rowOf(["purchase_price", "arv"]), rowOf(["budget_total", "senior_loan_amount"]), make(byId.closing_date));
      form.appendChild(q);

      var acc = h("div", { class: "acc" });
      SECTION_ORDER.forEach(function (s) {
        var fs = optional.filter(function (f) { return f.section === s; });
        if (!fs.length) return;
        var count = h("span", { class: "count" });
        var body = h("div", { class: "body" }, fs.map(make));
        var det = h("details", { class: "sec" }, h("summary", null, h("span", { text: SECTIONS[s] }), count), body);
        var upd = function () {
          var n = fs.filter(function (f) { return inputs[f.id] && inputs[f.id].input.value; }).length;
          count.textContent = n ? n + " of " + fs.length + " filled" : fs.length + (fs.length === 1 ? " question" : " questions");
          count.className = "count" + (n ? " on" : "");
        };
        counters.push(upd);
        if (fs.some(function (f) { return draft[f.id]; })) det.open = true;
        acc.appendChild(det);
      });
      counters.forEach(function (c) { c(); });
      form.appendChild(h("section", { class: "more" }, h("h2", { text: "Add more if you have it" }),
        h("p", { text: "Optional. The more you share now, the faster we can send terms." }), acc));

      var ts = turnstileBox();
      var btn = h("button", { class: "btn", type: "submit", text: "Send my deal" });
      form.appendChild(ts.el);
      form.appendChild(status);
      form.appendChild(h("div", { class: "sendbar" }, btn));
      form.appendChild(h("div", { class: "formfoot" },
        h("span", { text: "Your answers are saved in this browser until you send." }),
        h("button", { class: "linkbtn", type: "button", text: "Clear the form", onclick: function () {
          if (window.confirm("Clear every answer on this form?")) { store("del", DRAFT_KEY); sendScreen(); }
        } })));

      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        status.replaceChildren();
        var res = collect(fields, inputs);
        var firstBad = null;
        fields.forEach(function (f) { inputs[f.id].err.textContent = ""; inputs[f.id].input.classList.remove("bad"); });
        Object.keys(res.errors).forEach(function (k) {
          inputs[k].err.textContent = res.errors[k]; inputs[k].input.classList.add("bad");
          if (!firstBad) firstBad = inputs[k].input;
        });
        if (firstBad) {
          var det = firstBad.closest("details"); if (det) det.open = true;
          var n = Object.keys(res.errors).length;
          status.appendChild(msg(n === 1 ? "One box needs a fix. It is marked in red." : n + " boxes need a fix. They are marked in red.", "error"));
          firstBad.focus({ preventScroll: true });
          firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        if (!PREVIEW && CFG.turnstileSiteKey && CFG.turnstileSiteKey.indexOf("__") < 0 && !ts.token()) {
          status.appendChild(msg("Please finish the safety check above, then press Send.", "error")); return;
        }
        var payload = res.values;
        payload.form_version = "v1";
        payload.turnstile_token = ts.token();
        btn.disabled = true; btn.textContent = "Sending...";
        api.submit(payload).then(function (r) {
          if (r && r.ok) {
            store("del", DRAFT_KEY);
            sess("set", "last_submit", JSON.stringify({ deal_ref: r.deal_ref, book: r.next && r.next.book_call_url, email: payload.email }));
            location.hash = "#/thanks";
          } else {
            btn.disabled = false; btn.textContent = "Send my deal";
            var field = r && r.field && inputs[r.field];
            if (field) { field.err.textContent = r.message || "Please check this one."; field.input.classList.add("bad"); field.input.focus(); }
            status.appendChild(msg((r && r.message) || "We could not send that just now. Please wait a minute and try again, or email info@mybedrock.app.", "error"));
          }
        }).catch(function () {
          btn.disabled = false; btn.textContent = "Send my deal";
          status.appendChild(msg("We could not send that just now. Please try again, or email info@mybedrock.app.", "error"));
        });
      });

      var page = wrap(h("div", { class: "page-head" }, h("h1", { text: "Send a deal" }),
          h("p", { class: "lead", text: "About 3 minutes. No account needed." }),
          h("div", { class: "aside" }, h("span", { text: "Using an AI assistant?" }), h("a", { href: "llms.txt", text: "Send from there" }))),
        form);
      page.classList.add("narrow");
      setMain(page, "Send a deal");
    }).catch(function () { setMain(wrap(msg("The form could not load. Please refresh.", "error")), "Send a deal"); });
  }


  function saveDraft(inputs) {
    var v = {};
    Object.keys(inputs).forEach(function (k) { if (inputs[k].input.value) v[k] = inputs[k].input.value; });
    store("set", DRAFT_KEY, JSON.stringify({ v: 1, values: v, saved: Date.now() }));
  }

  function num(s) {
    var t = String(s).toLowerCase().replace(/[$,\s]/g, "").replace(/dollars?$/, "");
    var mult = 1, m = t.match(/^(.*?)(k|thousand|m|mil|million)$/);
    if (m) { t = m[1]; mult = (m[2] === "k" || m[2] === "thousand") ? 1e3 : 1e6; }
    if (t === "" || !/^-?\d*\.?\d+$/.test(t)) return NaN;
    return Math.round(Number(t) * mult * 100) / 100;
  }
  function collect(fields, inputs) {
    var values = {}, errors = {};
    fields.forEach(function (f) {
      var raw = inputs[f.id].input.value.trim(), v = raw;
      if (!raw) { if (f.required_at_send) errors[f.id] = "We need this one."; return; }
      if (f.type === "money" || f.type === "number") {
        var n = num(raw);
        if (isNaN(n) || n < 0) { errors[f.id] = "Please type a number, like 250000 or 250k."; return; }
        if (f.required_at_send && f.type === "money" && n <= 0 && f.id !== "budget_total") { errors[f.id] = "This must be more than zero. A best guess is fine."; return; }
        v = n;
      } else if (f.type === "email") {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) { errors[f.id] = "That does not look like an email."; return; }
      } else if (f.type === "tel") {
        if (raw.replace(/\D/g, "").length < 7) { errors[f.id] = "That does not look like a phone number."; return; }
      } else if (f.type === "date") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || isNaN(new Date(raw))) { errors[f.id] = "Please pick a date."; return; }
      } else if (f.type === "url_list") {
        var lines = raw.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
        if (lines.some(function (u) { return !/^https:\/\/\S+$/.test(u); })) { errors[f.id] = "Use full links that start with https://, one per line."; return; }
        v = lines;
      }
      if (f.id === "state") { v = raw.toUpperCase(); if (!/^[A-Z]{2}$/.test(v)) { errors[f.id] = "Use two letters, like FL."; return; } }
      if (f.id === "zip") { if (!/^\d{5}(-\d{4})?$/.test(raw)) { errors[f.id] = "Use a 5 digit ZIP."; return; } v = raw.slice(0, 5); }
      values[f.id] = v;
    });
    return { values: values, errors: errors };
  }

  function thanks() {
    var info = {};
    try { info = JSON.parse(sess("get", "last_submit") || "{}"); } catch (e) { info = {}; }
    var book = goodUrl(info.book) ? info.book : goodUrl(CFG.bookCallUrl) ? CFG.bookCallUrl : null;
    var d = wrap(h("div", { class: "done-mark", "aria-hidden": "true" }),
      h("h1", { text: "We got your deal." }),
      h("p", { class: "lead", text: "Cleo is emailing you a confirmation now." }),
      info.deal_ref ? h("div", { class: "ref" }, h("span", { class: "mute", text: "Your reference" }), h("strong", { text: info.deal_ref })) : null,
      h("div", { class: "card", style: "margin-top:28px" }, h("h2", { text: "What happens next" }),
        h("ol", { class: "next" }, h("li", { text: "You get an email from Cleo that says we have your deal. If you do not see it, look in your spam or junk folder." }),
          h("li", { text: "Shravaan calls to welcome you and talk through the deal." }),
          h("li", { text: "You track every step, and send papers, on this site." + (info.email ? " To sign in, use the same email: " + info.email + "." : " To sign in, use the same email you just used.") }))),
      h("div", { class: "cta" },
        book ? h("a", { class: "btn", href: book, text: "Book a welcome call", rel: "noopener" }) : null,
        h("a", { class: book ? "btn ghost" : "btn", href: SESSION ? "#/deals" : "#/signin", text: "Track my deal" })),
      helpLine());
    d.classList.add("narrow");
    setMain(d, "Thank you");
  }

  function signin() {
    var step = 1, email = "";
    var box = h("div", { class: "card" });
    var head = h("h1", { text: "Track my deals" }), sub = h("p", { class: "lead", text: "Sign in with your email. We send you a 6-digit code. No password." });
    var d = wrap(h("div", { class: "signin" }, head, sub, box), helpLine());
    setMain(d, "Sign in");
    var ts = turnstileBox();
    function showEmail(note) {
      head.textContent = "Track my deals"; sub.textContent = "Sign in with your email. We send you a 6-digit code. No password.";
      var em = h("input", { id: "si_email", type: "email", autocomplete: "email", autocapitalize: "off", spellcheck: "false", value: email, placeholder: "you@company.com" });
      var nm = h("input", { id: "si_name", type: "text", autocomplete: "name" });
      var co = h("input", { id: "si_co", type: "text", autocomplete: "organization" });
      var more = h("details", { class: "newhere" }, h("summary", { text: "New here? Tell us who you are" }),
        h("div", null, h("label", { for: "si_name", text: "Your name" }), nm, h("label", { for: "si_co", text: "Company" }), co));
      var status = h("div"), btn = h("button", { class: "btn block", type: "submit", text: "Email me a code" });
      var f = h("form", { novalidate: true }, h("label", { for: "si_email", text: "Your email", style: "margin-top:0" }), em,
        h("span", { class: "help", text: "Sent us a deal before? Use that same email." }), ts.el, status, h("div", { style: "margin-top:16px" }, btn), more);
      f.addEventListener("submit", function (ev) {
        ev.preventDefault(); status.replaceChildren();
        var v = em.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { status.appendChild(msg("Please type your email.", "error")); return; }
        if (!PREVIEW && CFG.turnstileSiteKey && CFG.turnstileSiteKey.indexOf("__") < 0 && !ts.token()) { status.appendChild(msg("Please finish the safety check.", "error")); return; }
        email = v; btn.disabled = true; btn.textContent = "Sending...";
        api.start(v, ts.token(), nm.value.trim(), co.value.trim()).then(function (r) {
          step = 2; showCode((r && r.message) || "If you sent us a deal with this email, or we already know you, a code is on its way.");
        }).catch(function () { btn.disabled = false; btn.textContent = "Email me a code"; status.appendChild(msg("That did not work. Please try again.", "error")); });
      });
      box.replaceChildren(); add(box, [note ? msg(note) : null, f]);
      em.focus();
    }
    function showCode(note) {
      head.textContent = "Check your email"; sub.textContent = note;
      var code = h("input", { id: "si_code", class: "code-in", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "000000" });
      var status = h("div"), btn = h("button", { class: "btn block", type: "submit", text: "Sign in" });
      var resend = h("button", { class: "linkbtn", type: "button", text: "Send me a new code" });
      resend.addEventListener("click", function () {
        status.replaceChildren(); resend.disabled = true;
        api.start(email, ts.token(), "", "").then(function (r) {
          status.appendChild(msg((r && r.message) || "If you sent us a deal with this email, or we already know you, a new code is on its way."));
        }).catch(function () { status.appendChild(msg("That did not work. Please wait a minute and try again.", "error")); })
          .then(function () { setTimeout(function () { resend.disabled = false; }, 30000); });
      });
      var f = h("form", { novalidate: true }, h("label", { for: "si_code", text: "The 6-digit code sent to " + email, style: "margin-top:0" }), code,
        h("span", { class: "help", text: "The email comes from Cleo at Bedrock. Not there? Look in your spam or junk folder." }), status,
        h("div", { style: "margin-top:16px" }, btn),
        h("div", { class: "code-links" }, resend, h("button", { class: "linkbtn", type: "button", text: "Use a different email", onclick: function () { showEmail(); } })));
      code.addEventListener("input", function () { code.value = code.value.replace(/\D/g, "").slice(0, 6); });
      f.addEventListener("submit", function (ev) {
        ev.preventDefault(); status.replaceChildren();
        if (!code.value.trim()) { status.appendChild(msg("Please type the code from your email.", "error")); return; }
        btn.disabled = true; btn.textContent = "Checking...";
        api.verifyCode(email, code.value).then(function (r) {
          if (!r || !r.ok) { btn.disabled = false; btn.textContent = "Sign in"; status.appendChild(msg((r && r.error) || "That code did not work.", "error")); return; }
          return api.claimDeals().catch(function () { }).then(function () { return api.session(); }).then(function (s) {
            SESSION = s; location.hash = s && s.isStaff ? "#/staff" : "#/deals"; route();
          });
        }).catch(function () { btn.disabled = false; btn.textContent = "Sign in"; status.appendChild(msg("That did not work. Please try again.", "error")); });
      });
      var hint = PREVIEW ? h("p", { class: "small mute", text: "Preview: the code is 123456." }) : null;
      box.replaceChildren(); add(box, [hint, f]);
      code.focus();
    }
    showEmail();
  }

  function dealsScreen() {
    if (!SESSION) return needSignIn();
    setMain(wrap(h("h1", { text: "My deals" }), h("p", { class: "mute", text: "Loading..." })), "My deals");
    api.myDeals().then(function (rows) {
      var list = h("div", { class: "cards" });
      (rows || []).forEach(function (d) {
        var stopped = d.step === "not_moving_forward", a = splitAddr(d.address);
        var n = d.open_todo_count || 0;
        var need = stopped ? null : h("div", { class: "need" + (n ? "" : " none") },
          h("span", { text: n ? (n === 1 ? "1 thing needs you" : n + " things need you") : "Nothing needed from you" }), h("span", { class: "arrow" }));
        var card = h("a", { class: "card deal-card", href: "#/deal/" + encodeURIComponent(d.deal_id) },
          h("div", { class: "dc-top" }, h("div", { class: "dc-addr" }, h("h3", { text: a[0] }), a[1] ? h("div", { class: "city", text: a[1] }) : null), stageTag(d.step)),
          stopped ? h("p", { class: "small mute", style: "margin:12px 0 8px", text: REASONS[d.reason_code] || REASONS.other }) : segBar(d.step),
          h("div", { class: "meta" },
            h("span", { text: [planLabel(d.plan_type), d.submitted_at ? "Sent " + fmtDate(d.submitted_at) : ""].filter(Boolean).join(" · ") }),
            stopped ? null : h("span", { class: "nowrap", text: "Step " + (stepIndex(d.step) + 1) + " of " + STEPS.length })),
          need);
        list.appendChild(card);
      });
      var email = SESSION && SESSION.user && SESSION.user.email;
      var page = wrap(
        h("div", { class: "list-head" },
          h("div", null, h("h1", { text: "My deals" }),
            h("div", { class: "who" }, email ? h("span", { text: "Signed in as " + email }) : null, h("button", { class: "linkbtn", type: "button", text: "Sign out", onclick: signOut, style: "padding:0;min-height:0" }))),
          h("a", { class: "btn small dark", href: "#/send", text: "Send a new deal" })),
        rows && rows.length ? list : h("div", { class: "card empty" }, h("h2", { text: "No deals yet" }), h("p", { text: "Send your first deal. It takes about 3 minutes." }), h("a", { class: "btn", href: "#/send", text: "Send a deal" })));
      setMain(page, "My deals");
    }).catch(function () { setMain(wrap(msg("We could not load your deals. Please refresh.", "error")), "My deals"); });
  }

  function labelFor(id) { var f = FORM.filter(function (x) { return x.id === id; })[0]; return f ? f : { label: id, type: "text" }; }
  function showAnswer(id, v) {
    var f = labelFor(id);
    if (Array.isArray(v)) return v.join("\n");
    if (f.type === "money") return money(v);
    if (f.type === "date") return fmtDate(String(v) + "T12:00:00");
    if (f.type === "select" && f.options) { for (var i = 0; i < f.options.length; i++) if (f.options[i].value === v) return f.options[i].label; }
    if (f.type === "number" && /(%)/.test(f.label)) return String(v) + "%";
    return String(v);
  }

  function todoItem(t, dealId, files, refresh) {
    var st = TODO_STATUS[t.status] || [t.status, ""];
    var mine = (files || []).filter(function (f) { return f.todo_id === t.id; });
    var body = h("div", { class: "todo-body" }, h("div", { class: "todo-title", text: t.text }),
      h("div", { class: "todo-sub", text: t.status === "open" && t.kind === "answer" ? "We will ask you about this. Nothing to upload." : st[0] }));
    mine.forEach(function (f) { body.appendChild(h("div", { class: "todo-file", text: f.original_name })); });
    var li = h("li", { class: "todo-row st-" + t.status }, h("span", { class: "todo-ic", "aria-hidden": "true" }), body);
    if (t.status === "open" && t.kind !== "answer") {
      var input = h("input", { type: "file", id: "up_" + t.id, accept: ".pdf,.jpg,.jpeg,.png,.xlsx,.docx,.csv", style: "position:absolute;left:-9999px", "aria-label": "Upload: " + t.text });
      var status = h("div", { class: "upl-status", role: "status" });
      var btn = h("label", { class: "btn small ghost", for: "up_" + t.id, style: "margin:0", text: mine.length ? "Add another" : "Upload" });
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var ext = (file.name.split(".").pop() || "").toLowerCase();
        if (!ALLOWED_EXT[ext]) { status.className = "upl-status err"; status.textContent = "Please use a PDF, picture, Word, Excel or CSV file."; return; }
        if (file.size > MAX_BYTES) { status.className = "upl-status err"; status.textContent = "That file is too big. The limit is 25 MB."; return; }
        if (file.size === 0) { status.className = "upl-status err"; status.textContent = "That file is empty."; return; }
        var f2 = file;
        if (!file.type || file.type !== ALLOWED_EXT[ext]) { try { f2 = new File([file], file.name, { type: ALLOWED_EXT[ext] }); } catch (e) { f2 = file; } }
        status.className = "upl-status mute"; status.textContent = "Uploading " + file.name + "...";
        api.uploadFile(dealId, t.id, f2).then(function () { status.textContent = "Got it. Thank you."; refresh(); })
          .catch(function (e) { status.className = "upl-status err"; status.textContent = (e && e.message) || "The upload did not work. Please try again."; });
      });
      body.appendChild(status);
      li.appendChild(h("div", { class: "todo-act" }, input, btn));
    }
    return li;
  }

  function dealScreen(id) {
    if (!SESSION) return needSignIn();
    setMain(wrap(h("p", { class: "mute", text: "Loading..." })), "Deal");
    loadForm().then(function () { return api.dealDetail(id); }).then(function (data) {
      var d = data.deal, stopped = d.step === "not_moving_forward", an = data.answers || {};
      if (!d.address) d.address = [an.street, an.city, [an.state, an.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      if (!d.plan_type) d.plan_type = an.plan_type;
      var a = splitAddr(d.address);
      var open = data.todos.filter(function (t) { return t.status === "open" || t.status === "waiting_check"; });
      var done = data.todos.filter(function (t) { return t.status === "done" || t.status === "waived"; });
      var needs = open.filter(function (t) { return t.status === "open"; }).length;
      var refresh = function () { dealScreen(id); };
      var todoCard = h("div", { class: "card" },
        h("h2", { text: "What we need from you" }),
        h("p", { class: "card-sub", text: needs ? (needs === 1 ? "1 thing needs you." : needs + " things need you.") + (open.some(function (t) { return t.status === "open" && t.kind !== "answer"; }) ? " PDF, picture, Word, Excel or CSV, up to 25 MB." : "") : "Nothing right now. Thank you." }),
        open.length ? h("ul", { class: "todo-list" }, open.map(function (t) { return todoItem(t, d.deal_id, data.files, refresh); })) : null,
        open.some(function (t) { return t.status === "open" && t.kind !== "answer"; }) ? h("p", { class: "small mute", style: "margin:14px 0 0", text: "Tap Upload, then pick the file from your phone or computer. Trouble uploading? Email the paper to info@mybedrock.app with the property address." }) : null);
      if (done.length) todoCard.appendChild(h("details", { class: "done-fold" }, h("summary", { text: "Done (" + done.length + ")" }),
        h("ul", { class: "todo-list" }, done.map(function (t) { return todoItem(t, d.deal_id, data.files, refresh); }))));
      var noteCard = h("div", { class: "card" }, h("h2", { text: "Notes from Bedrock", style: "margin-bottom:16px" }),
        data.notes.length ? h("ul", { class: "notes" }, data.notes.map(function (n) {
          return h("li", null, h("div", { class: "when", text: fmtDate(n.created_at) }), h("div", { text: n.text }));
        })) : h("p", { class: "mute", style: "margin:0", text: "No notes yet." }));
      var groups = h("div");
      SECTION_ORDER.forEach(function (s) {
        var ids = FORM.filter(function (f) { return f.section === s && an[f.id] != null && an[f.id] !== "" && !(Array.isArray(an[f.id]) && !an[f.id].length); });
        if (!ids.length) return;
        var kv = h("dl", { class: "kv" });
        ids.forEach(function (f) {
          var v = showAnswer(f.id, an[f.id]), long = f.type === "textarea" || f.type === "url_list" || v.length > 40;
          kv.appendChild(h("dt", { text: f.label }));
          kv.appendChild(h("dd", { class: long ? "long" : null, text: v }));
        });
        groups.appendChild(h("div", { class: "kv-group" }, h("h4", { text: SECTIONS[s] }), kv));
      });
      var sent = h("details", { class: "sent" }, h("summary", { text: "What you sent us" }), h("div", { class: "body" }, groups.childNodes.length ? groups : h("p", { class: "mute", text: "Nothing to show." })));
      var stepCard = h("div", { class: "card" }, h("div", { class: "sec-title", text: stopped ? "Status" : "Step " + (stepIndex(d.step) + 1) + " of " + STEPS.length }),
        stopped ? stoppedBox(d) : stepBar(d.step));
      var page = wrap(h("a", { class: "back", href: "#/deals", text: "My deals" }),
        h("div", { class: "page-head" }, h("h1", { text: a[0] }),
          h("p", { class: "lead", style: "margin-top:6px", text: [a[1], planLabel(d.plan_type), d.submitted_at ? "Sent " + fmtDate(d.submitted_at) : ""].filter(Boolean).join(" · ") })),
        h("div", { class: "deal-grid" }, h("div", { class: "side" }, stepCard), h("div", { class: "main" }, todoCard, noteCard, sent)));
      setMain(page, d.address || "Deal");
    }).catch(function (e) {
      setMain(wrap(msg((e && e.message) || "We could not load that deal.", "error"), h("a", { class: "back", href: "#/deals", text: "My deals" })), "Deal");
    });
  }

  /* ---------- staff ---------- */
  function staffScreen() {
    if (!SESSION) return needSignIn();
    if (!SESSION.isStaff) return setMain(wrap(h("h1", { text: "Staff only" }), h("p", { text: "This page is for Bedrock staff." })), "Staff");
    setMain(wrap(h("p", { text: "Loading..." })), "Staff");
    api.staffMfa().then(function (m) {
      if (m && m.needed) return staffMfaScreen(m);
      return Promise.all([loadForm(), api.staffListDeals(), api.staffRequests()]).then(function (a) { staffBoard(a[1] || [], a[2] || []); });
    }).catch(function (e) { setMain(wrap(msg((e && e.message) || "We could not load the staff page.", "error")), "Staff"); });
  }
  function staffMfaSetup() {
    var box = h("div", { class: "card" }, h("p", { class: "mute", text: "Getting your setup ready..." }));
    var page = wrap(h("h1", { text: "Set up your second check" }),
      h("p", { class: "lead", text: "Staff pages need a code from an app on your phone. You do this once." }), box, helpLine());
    page.classList.add("narrow");
    setMain(page, "Staff");
    api.mfaEnroll().then(function (e) {
      var code = h("input", { type: "text", class: "code-in", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", id: "mfa_new", placeholder: "000000" });
      code.addEventListener("input", function () { code.value = code.value.replace(/\D/g, "").slice(0, 6); });
      var status = h("div"), btn = h("button", { class: "btn block", type: "submit", text: "Finish setup" });
      var f = h("form", { novalidate: true },
        h("ol", { class: "next" },
          h("li", { text: "On your phone, open an authenticator app (Google Authenticator or Microsoft Authenticator are free in the app store)." }),
          h("li", { text: "In the app, tap the + button, then scan this square with your phone camera." }),
          h("li", { text: "The app now shows a 6-digit code for Bedrock. Type it below." })),
        e.qr ? h("div", { class: "qr" }, h("img", { src: e.qr, alt: "Setup code to scan with your authenticator app", width: "180", height: "180" })) : null,
        e.secret ? h("p", { class: "small mute", style: "text-align:center" }, "Cannot scan? Type this key into the app instead: ", h("strong", { class: "nowrap", text: e.secret })) : null,
        h("label", { for: "mfa_new", text: "6-digit code from the app" }), code, status, h("div", { style: "margin-top:16px" }, btn));
      f.addEventListener("submit", function (ev) {
        ev.preventDefault(); status.replaceChildren();
        if (code.value.length !== 6) { status.appendChild(msg("Please type the 6-digit code from the app.", "error")); return; }
        btn.disabled = true; btn.textContent = "Checking...";
        api.mfaEnrollVerify(e.factorId, code.value).then(function () { return api.session(); }).then(function (s) { SESSION = s; staffScreen(); })
          .catch(function (er) { btn.disabled = false; btn.textContent = "Finish setup"; status.appendChild(msg((er && er.message) || "That code did not work.", "error")); });
      });
      box.replaceChildren(f);
    }).catch(function (er) { box.replaceChildren(msg((er && er.message) || "Could not start the setup. Please refresh.", "error")); });
  }
  function staffMfaScreen(m) {
    var code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "8", id: "mfa" });
    var status = h("div");
    var f = h("form", null, h("label", { for: "mfa", text: "Code from your authenticator app" }), code, status,
      h("div", { class: "linkrow" }, h("button", { class: "btn", type: "submit", text: "Continue" })));
    f.addEventListener("submit", function (ev) {
      ev.preventDefault(); status.replaceChildren();
      api.mfaVerify(code.value).then(function () { return api.session(); }).then(function (s) { SESSION = s; staffScreen(); })
        .catch(function (e) { status.appendChild(msg((e && e.message) || "That code did not work.", "error")); });
    });
    if (m.hasFactor === false) return staffMfaSetup();
    var page = wrap(h("h1", { text: "One more check" }), h("p", { class: "lead", text: "Staff pages need a second check. Open your authenticator app and type the 6-digit code for Bedrock." }), h("div", { class: "card" }, f));
    page.classList.add("narrow");
    setMain(page, "Staff");
  }

  function staffBoard(rows, requests) {
    var filter = "all";
    rows.forEach(function (d) {
      d._age = d.age_days != null ? d.age_days : ageDays(d.submitted_at);
      d._new = !!d.is_new;
      d._unv = !!d.unverified_sender;
      d._stale = !!d.stale;
    });
    rows.sort(function (a, b) { return b._age - a._age; });
    var listEl = h("div", { class: "staff-list" }), reqEl = h("div"), chipsEl = h("div", { class: "chips" });
    function reload() { staffScreen(); }
    function drawChips() {
      chipsEl.replaceChildren();
      [["all", "All (" + rows.length + ")"], ["new", "New (" + rows.filter(function (d) { return d._new; }).length + ")"],
        ["unv", "Unverified sender (" + rows.filter(function (d) { return d._unv; }).length + ")"],
        ["stale", "Stale (" + rows.filter(function (d) { return d._stale; }).length + ")"]].forEach(function (c) {
        chipsEl.appendChild(h("button", { type: "button", "aria-pressed": filter === c[0] ? "true" : "false", text: c[1], onclick: function () { filter = c[0]; drawChips(); drawList(); } }));
      });
    }
    function drawList() {
      listEl.replaceChildren();
      var shown = rows.filter(function (d) { return filter === "all" || (filter === "new" && d._new) || (filter === "unv" && d._unv) || (filter === "stale" && d._stale); });
      if (!shown.length) listEl.appendChild(h("p", { class: "mute", style: "padding:20px;margin:0", text: "Nothing here." }));
      shown.forEach(function (d) { listEl.appendChild(staffRow(d, reload)); });
    }
    reqEl.appendChild(h("h2", { style: "margin:36px 0 12px", text: "People asking for access (" + requests.length + ")" }));
    if (!requests.length) reqEl.appendChild(h("p", { class: "mute", text: "No one is waiting." }));
    requests.forEach(function (r) {
      reqEl.appendChild(h("div", { class: "card req-card" }, h("div", null, h("strong", { text: r.email }),
        h("div", { class: "small mute", text: [r.name, r.company, fmtDate(r.created_at)].filter(Boolean).join(" · ") })),
        h("div", { class: "right" },
          h("button", { class: "btn small", type: "button", text: "Approve", onclick: function () { api.staffDecide(r.id, true).then(reload); } }),
          h("button", { class: "btn small ghost", type: "button", text: "Deny", onclick: function () { api.staffDecide(r.id, false).then(reload); } }))));
    });
    drawChips(); drawList();
    setMain(wrap(h("h1", { text: "Staff" }), h("div", { class: "who" }, SESSION.user && SESSION.user.email ? h("span", { text: "Signed in as " + SESSION.user.email }) : null, h("button", { class: "linkbtn", type: "button", text: "Sign out", onclick: signOut, style: "padding:0;min-height:0" })),
      h("p", { class: "lead", text: "Every deal sent through the portal, oldest first. Open one to link it, add to-dos, notes or move its step." }), chipsEl, listEl, reqEl), "Staff");
  }

  function staffRow(d, reload) {
    var det = h("details", { class: "sec" });
    var sum = h("summary", null, h("span", { class: "srow" }, h("span", { class: "addr", text: d.address || "Deal" }),
      h("span", { class: "sub", text: d.submit_email + " · " + (d._age === 1 ? "1 day" : d._age + " days") + " old" }),
      h("span", { class: "tags" }, stageTag(d.step), d._new ? h("span", { class: "pill o", text: "New" }) : null, d._unv ? h("span", { class: "pill y", text: "Unverified sender" }) : null, d._stale ? h("span", { class: "pill y", text: "Stale" }) : null,
        d.ledger_deal_key ? null : h("span", { class: "pill", text: "Not linked" }))));
    var body = h("div", { class: "body" });
    var loaded = false;
    det.appendChild(sum); det.appendChild(body);
    det.addEventListener("toggle", function () {
      if (!det.open || loaded) return;
      loaded = true; body.textContent = "Loading...";
      api.staffDealDetail(d.deal_id).then(function (data) { body.replaceChildren(staffPanel(d, data, reload)); })
        .catch(function (e) { body.replaceChildren(msg((e && e.message) || "Could not load.", "error")); });
    });
    return det;
  }

  function staffPanel(d, data, reload) {
    var root = h("div", { class: "staff-panel" }), status = h("div", { role: "status" });
    function run(p) {
      status.replaceChildren(msg("Saving..."));
      return p.then(function () { status.replaceChildren(msg("Saved.", "good")); reload(); }).catch(function (e) { status.replaceChildren(msg((e && e.message) || "That did not save.", "error")); });
    }
    function sub(t) { return h("h3", { text: t }); }
    // link
    var key = h("input", { type: "text", id: "lk_" + d.deal_id, value: d.ledger_deal_key || "", placeholder: "Ledger deal key" });
    root.appendChild(sub("Link to the ledger"));
    root.appendChild(h("div", { class: "ctl" }, key,
      h("button", { class: "btn small", type: "button", text: "Link", onclick: function () { if (key.value.trim()) run(api.staffLink(d.deal_id, key.value.trim())); } })));
    // todos
    root.appendChild(sub("To-dos"));
    var ul = h("ul", { class: "clean" });
    data.todos.forEach(function (t) {
      var sel = h("select", { "aria-label": "Status for " + t.text },
        ["open", "waiting_check", "done", "waived"].map(function (s) { return h("option", { value: s, text: TODO_STATUS[s][0] }); }));
      sel.value = t.status;
      sel.addEventListener("change", function () { run(api.staffSetTodo(t.id, sel.value)); });
      ul.appendChild(h("li", null, h("span", { text: t.text }), sel));
    });
    root.appendChild(data.todos.length ? ul : h("p", { class: "mute", text: "No to-dos." }));
    var nt = h("input", { type: "text", "aria-label": "New to-do", placeholder: "New to-do" });
    var kind = h("select", { "aria-label": "Kind", class: "fit" }, [["upload", "Upload"], ["answer", "Answer"], ["other", "Other"]].map(function (k) { return h("option", { value: k[0], text: k[1] }); }));
    root.appendChild(h("div", { class: "ctl" }, nt, kind,
      h("button", { class: "btn small", type: "button", text: "Add to-do", onclick: function () { if (nt.value.trim()) run(api.staffAddTodo(d.deal_id, nt.value.trim(), kind.value)); } })));
    // files
    root.appendChild(sub("Files"));
    if (!data.files.length) root.appendChild(h("p", { class: "mute", text: "No files." }));
    data.files.forEach(function (f) {
      var canOpen = f.check_status === "ok";
      var b = h("button", { class: "btn small ghost", type: "button", text: canOpen ? "Open" : "Not checked yet", disabled: !canOpen, onclick: function () {
        api.staffOpenFile(f.id).then(function (r) {
          if (r && r.url && goodUrl(r.url)) window.open(r.url, "_blank", "noopener");
          else status.replaceChildren(msg(r && r.fake ? "Preview: a real file would open here." : "Could not open that file.", r && r.fake ? "" : "error"));
        });
      } });
      root.appendChild(h("div", { class: "ctl", style: "justify-content:space-between" }, h("span", { class: "small", style: "overflow-wrap:anywhere" }, f.original_name + " ", h("span", { class: "pill" + (canOpen ? " g" : " y"), text: canOpen ? "Checked" : f.check_status })), b));
    });
    // notes
    root.appendChild(sub("Notes"));
    data.notes.forEach(function (n) { root.appendChild(h("p", { class: "small", style: "margin:0 0 10px" }, h("span", { class: "pill " + (n.visible_to_lender ? "g" : ""), text: n.visible_to_lender ? "Lender sees" : "Staff only" }), " ", n.text)); });
    var nn = h("textarea", { "aria-label": "New note", placeholder: "New note" });
    var vis = h("input", { type: "checkbox", id: "vis_" + d.deal_id });
    root.appendChild(nn);
    root.appendChild(h("div", { class: "ctl" }, vis, h("label", { for: "vis_" + d.deal_id, style: "margin:0;font-weight:400", text: "Lender can see this" }),
      h("button", { class: "btn small", type: "button", text: "Add note", onclick: function () { if (nn.value.trim()) run(api.staffAddNote(d.deal_id, nn.value.trim(), vis.checked)); } })));
    // step
    root.appendChild(sub("Set the step"));
    var stepSel = h("select", { "aria-label": "Step", class: "fit" }, STEPS.concat([["complete", "Complete"], ["not_moving_forward", "Not moving forward"]]).map(function (s) { return h("option", { value: s[0], text: s[1] }); }));
    stepSel.value = d.step;
    var reason = h("select", { "aria-label": "Reason", class: "fit" }, Object.keys(REASONS).map(function (k) { return h("option", { value: k, text: REASONS[k] }); }));
    var stepNote = h("input", { type: "text", "aria-label": "Note to lender (optional)", placeholder: "Note to lender (optional)" });
    function syncReason() { reason.hidden = stepSel.value !== "not_moving_forward"; }
    stepSel.addEventListener("change", syncReason); syncReason();
    root.appendChild(h("div", { class: "ctl" }, stepSel, reason));
    root.appendChild(h("div", { class: "ctl" }, stepNote,
      h("button", { class: "btn small", type: "button", text: "Set step", onclick: function () {
        run(api.staffSetStep(d.deal_id, stepSel.value, stepSel.value === "not_moving_forward" ? reason.value : null, stepNote.value.trim()));
      } })));
    root.appendChild(status);
    return root;
  }

  /* ---------- router ---------- */
  function route() {
    var hash = location.hash || "#/", m;
    setNav();
    try {
      if (hash === "#/" || hash === "" || hash === "#") return landing();
      if (hash === "#/send") return sendScreen();
      if (hash === "#/thanks") return thanks();
      if (hash === "#/signin") return signin();
      if (hash === "#/deals") return dealsScreen();
      if ((m = hash.match(/^#\/deal\/(.+)$/))) return dealScreen(decodeURIComponent(m[1]));
      if (hash === "#/staff") return staffScreen();
      return setMain(wrap(h("h1", { text: "We could not find that page" }), h("a", { class: "btn", href: "#/", text: "Go home" })), "Not found");
    } catch (e) {
      setMain(wrap(msg("Something went wrong. Please refresh.", "error")));
    }
  }

  function start() {
    var ready;
    try { ready = api.session(); } catch (e) { ready = Promise.resolve(null); }
    Promise.all([Promise.resolve(ready).catch(function () { return null; }), loadForm().catch(function () { return []; })]).then(function (a) { var s = a[0];
      SESSION = s;
      window.addEventListener("hashchange", function () { setNav(); route(); });
      route();
    });
  }
  window.__portal = { route: route, api: api, preview: PREVIEW };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
