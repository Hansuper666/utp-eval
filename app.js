/*
 * UTP human evaluation - the page: sign-in, instructions and the practice filing, the note with its search (PDF.js),
 * the answer form, saving, coming back later, and the supervisor's overview.
 * The rules of the form are in logic.js; the server is a Google Apps Script web app (see config.js).
 */
(function () {
  'use strict';

  const L = window.UTPLogic;
  const CONFIG = window.UTP_CONFIG || {};
  const MANIFEST = window.UTP_MANIFEST || {filings: {}, example: null};
  const EXAMPLE = MANIFEST.example || null;
  const PRACTICE = EXAMPLE && EXAMPLE.practice ? EXAMPLE.practice : null;
  const API_URL = String(CONFIG.apiUrl || '').trim();
  const $ = (id) => document.getElementById(id);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const QUESTIONS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
  const SCREENS = ['auth', 'intro', 'app', 'done', 'super'];
  const MISSING_TITLE = 'Please answer every question before saving (the boxes marked in red):';

  /* ---------------------------------------------------------------- small helpers */
  function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
  const NS = 'utp.' + hash(API_URL) + '.';
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(NS + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(NS + key, JSON.stringify(value)); return true; } catch (e) { return false; } },
    del(key) { try { localStorage.removeItem(NS + key); } catch (e) { /* ignore */ } },
  };
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function prettyPeriod(period) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(period || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1] : '';
  }
  function prettyTime(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function show(screen) {
    for (const s of SCREENS) $('screen-' + s).hidden = s !== screen;
    if (screen === 'app') requestAnimationFrame(() => pdf.relayout());
  }

  /* ---------------------------------------------------------------- server */
  class ServerDown extends Error {}
  async function api(action, payload, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
    let body;
    try {
      const response = await fetch(API_URL, {
        method: 'POST', redirect: 'follow', cache: 'no-store', signal: controller.signal,
        headers: {'Content-Type': 'text/plain;charset=utf-8'},   // a "simple" request: no pre-flight, which Apps Script cannot answer
        body: JSON.stringify(Object.assign({action: action}, payload || {})),
      });
      body = await response.text();
    } catch (e) {
      throw new ServerDown('network');
    } finally {
      clearTimeout(timer);
    }
    try {
      const data = JSON.parse(body);
      if (data && typeof data === 'object' && typeof data.ok === 'boolean') return data;
    } catch (e) { /* not JSON: fall through */ }
    throw new ServerDown('unreadable reply');
  }
  const DOWN_TEXT = 'Cannot reach the server. Check your internet connection and try again.';

  /* ---------------------------------------------------------------- state */
  const state = {
    token: null, user: null, role: '', trained: false,
    assigned: [], answers: {}, unassignedLeft: 0, batchSize: 100,
    index: 0, mode: 'work', raw: L.blankRaw(), baseline: '', locked: false, busy: false, ack: null, showMissing: false,
    formFid: null,      // the filing whose answers are in the form right now ('EXAMPLE' for the practice filing)
    formBase: '',       // when that filing was last saved ('' if never): a draft only belongs to that version
    queue: [], flushing: false, ping: null,
    practice: {results: {}}, practiceOk: 0,
    superData: null, superOpen: {}, superPw: {},
  };
  const timer = {
    total: 0, since: null,
    start() { this.total = 0; this.since = document.hidden ? null : Date.now(); },
    pause() { if (this.since !== null) { this.total += Date.now() - this.since; this.since = null; } },
    resume() { if (this.since === null && !document.hidden && state.mode === 'work') this.since = Date.now(); },
    seconds() { return Math.round((this.total + (this.since === null ? 0 : Date.now() - this.since)) / 1000); },
  };
  const userKey = () => (state.user ? state.user.user_id : 'nobody');
  const draftKey = (fid) => 'draft.' + userKey() + '.' + fid;
  const queueKey = () => 'queue.' + userKey();
  const onboardKey = () => 'onboard.' + userKey();
  const practiceKey = () => 'practice.' + userKey();
  const currentFid = () => (state.assigned[state.index] ? state.assigned[state.index].filing_id : null);
  const isDone = (fid) => {
    const a = state.assigned.find((x) => x.filing_id === fid);
    return !!(a && a.done_at) || !!(state.answers[fid] && state.answers[fid].pending);
  };
  const doneCount = () => state.assigned.filter((a) => isDone(a.filing_id)).length;

  /* ---------------------------------------------------------------- the note: PDF.js viewer with search */
  const pdf = (() => {
    const lib = window.pdfjsLib;
    const V = window.pdfjsViewer;
    const ready = !!(lib && V && typeof lib.getDocument === 'function');
    const FS = (V && V.FindState) || {FOUND: 0, NOT_FOUND: 1, WRAPPED: 2, PENDING: 3};
    const source = {};
    let viewer = null, bus = null, links = null, task = null, doc = null, url = null, seq = 0;
    let scaleMode = 'page-width';
    let lastQuery = '';
    let pending = null;

    function init() {
      if (viewer || !ready) return;
      try { lib.GlobalWorkerOptions.workerSrc = 'pdfjs/pdf.worker.min.js'; } catch (e) { /* the worker script is loaded by the page */ }
      bus = new V.EventBus();
      links = new V.PDFLinkService({eventBus: bus});
      const finder = new V.PDFFindController({eventBus: bus, linkService: links});
      viewer = new V.PDFViewer({
        container: $('pdf-scroll'), viewer: $('pdf-pages'), eventBus: bus, linkService: links, findController: finder,
        textLayerMode: 1, annotationMode: lib.AnnotationMode.DISABLE, removePageBorders: true,
        // No PDF editing. With the editor on, PDF.js 3.11 fails while switching documents (its editor cleanup reads null).
        annotationEditorMode: lib.AnnotationEditorType ? lib.AnnotationEditorType.DISABLE : -1,
      });
      links.setViewer(viewer);
      bus.on('pagesinit', () => {
        applyScale();
        status('');
        updatePage();
        $('pdf-pages').dataset.ready = '1';
        if (pending) { const p = pending; pending = null; find(p.q, p.previous, p.fromStart); }
      });
      bus.on('pagechanging', updatePage);
      bus.on('scalechanging', updateZoom);
      bus.on('updatefindmatchescount', (e) => showCount(e.matchesCount, null));
      bus.on('updatefindcontrolstate', (e) => showCount(e.matchesCount, e.state));
      if (window.ResizeObserver) new ResizeObserver(relayout).observe($('pdf-scroll'));
    }
    function relayout() {
      if (!viewer || !doc || $('pdf-scroll').clientWidth === 0) return;
      if (scaleMode === 'page-width') viewer.currentScaleValue = 'page-width';
    }
    function applyScale() {
      if (!viewer || $('pdf-scroll').clientWidth === 0) return;
      viewer.currentScaleValue = scaleMode === 'page-width' ? 'page-width' : String(scaleMode);
    }
    function status(text, bad) {
      const s = $('pdf-status');
      s.textContent = text || '';
      s.hidden = !text;
      s.classList.toggle('is-bad', !!bad);
    }
    function updatePage() { $('pdf-page').textContent = doc && viewer ? 'page ' + viewer.currentPageNumber + ' of ' + viewer.pagesCount : ''; }
    function updateZoom() { $('pdf-zoom').textContent = viewer && doc ? Math.round(viewer.currentScale * 100) + '%' : ''; }
    function showCount(mc, findState) {
      const c = $('pdf-count');
      if (!lastQuery) { c.textContent = ''; c.classList.remove('is-none'); return; }
      const total = mc && typeof mc.total === 'number' ? mc.total : null;
      if (findState === FS.PENDING) { c.textContent = 'searching…'; c.classList.remove('is-none'); return; }
      if (findState === FS.NOT_FOUND || total === 0) { c.textContent = 'no match'; c.classList.add('is-none'); return; }
      if (total) { c.textContent = Math.max(1, mc.current || 1) + ' of ' + total + (total === 1 ? ' match' : ' matches'); c.classList.remove('is-none'); }
    }
    function resetFind() { lastQuery = ''; pending = null; $('pdf-count').textContent = ''; $('pdf-count').classList.remove('is-none'); }
    function localBytes(src) {
      const key = src.replace(/^.*\//, '').replace(/\.pdf$/i, '');
      return new Promise((resolve, reject) => {
        const bag = (window.UTP_PDFDATA = window.UTP_PDFDATA || {});
        const take = () => {
          const b64 = bag[key];
          delete bag[key];
          if (!b64) { reject(new Error('missing')); return; }
          const bin = atob(b64);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          resolve(out);
        };
        if (bag[key]) { take(); return; }
        const s = document.createElement('script');
        s.src = 'pdfdata/' + key + '.js';
        s.onload = () => { s.remove(); take(); };
        s.onerror = () => { s.remove(); reject(new Error('missing')); };
        document.head.appendChild(s);
      });
    }
    async function open(src) {
      init();
      if (!ready) { status('The viewer could not start in this browser. Use "Open the PDF in a new tab".', true); return; }
      if (src === url && (doc || task)) return;
      const mine = ++seq;
      url = src;
      resetFind();
      $('pdf-pages').dataset.ready = '';
      $('pdf-pages').dataset.src = src;
      status('Loading the note…');
      if (task) { const t = task; task = null; try { t.destroy(); } catch (e) { /* ignore */ } }
      let params;
      try {
        params = location.protocol === 'file:' ? {data: await localBytes(src)} : {url: src};
      } catch (e) {
        if (mine === seq) status('This copy of the website cannot read the PDF here. Use "Open the PDF in a new tab".', true);
        return;
      }
      if (mine !== seq) return;
      params.isEvalSupported = false;
      const t = lib.getDocument(params);
      task = t;
      let d;
      try {
        d = await t.promise;
      } catch (e) {
        if (mine === seq) { task = null; url = null; status('The note could not be loaded. Use "Open the PDF in a new tab", or reload the page.', true); }
        return;
      }
      if (mine !== seq) { try { d.destroy(); } catch (e) { /* ignore */ } return; }
      task = null;
      const old = doc;
      doc = d;
      viewer.setDocument(d);
      links.setDocument(d, null);
      if (old) { try { old.destroy(); } catch (e) { /* ignore */ } }
    }
    function close() {
      seq++;
      url = null;
      resetFind();
      status('');
      if (task) { try { task.destroy(); } catch (e) { /* ignore */ } task = null; }
      if (doc && viewer) {
        const old = doc;
        doc = null;
        viewer.setDocument(null);
        links.setDocument(null, null);
        try { old.destroy(); } catch (e) { /* ignore */ }
      }
      $('pdf-pages').dataset.ready = '';
      $('pdf-pages').dataset.src = '';
      updatePage();
    }
    function find(query, previous, fromStart) {
      const q = String(query || '').trim();
      if (!q) { clearFind(); return; }
      lastQuery = q;
      if (!doc || !viewer || $('pdf-pages').dataset.ready !== '1') { pending = {q: q, previous: previous, fromStart: fromStart}; $('pdf-count').textContent = 'searching…'; return; }
      if (fromStart) viewer.currentPageNumber = 1;
      $('pdf-count').classList.remove('is-none');
      bus.dispatch('find', {source: source, type: 'again', query: q, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: !!previous, matchDiacritics: false});
    }
    function clearFind() {
      resetFind();
      if (bus) bus.dispatch('findbarclose', {source: source});
    }
    /* Search while typing: a new text is searched; the same text again does nothing (Enter moves to the next match). */
    function findLive(query) {
      const q = String(query || '').trim();
      if (!q) { clearFind(); return; }
      if (q === lastQuery) return;
      find(q, false, false);
    }
    function zoomIn() { if (viewer && doc) { viewer.increaseScale(); scaleMode = viewer.currentScale; } }
    function zoomOut() { if (viewer && doc) { viewer.decreaseScale(); scaleMode = viewer.currentScale; } }
    function fitWidth() { scaleMode = 'page-width'; if (viewer && doc) viewer.currentScaleValue = 'page-width'; }
    return {open, close, find, findLive, clearFind, zoomIn, zoomOut, fitWidth, relayout, ready};
  })();

  /* ---------------------------------------------------------------- sign in */
  function setAuthTab(which) {
    const login = which === 'login';
    $('tab-login').classList.toggle('is-on', login);
    $('tab-signup').classList.toggle('is-on', !login);
    $('tab-login').setAttribute('aria-selected', String(login));
    $('tab-signup').setAttribute('aria-selected', String(!login));
    $('form-login').hidden = !login;
    $('form-signup').hidden = login;
    $('login-error').textContent = '';
    $('signup-error').textContent = '';
  }
  function setAuthStatus(text, kind, retry) {
    const s = $('auth-status');
    s.textContent = text || '';
    s.className = 'auth-status' + (kind ? ' is-' + kind : '');
    if (retry) {
      const b = el('button', 'btn btn-small', 'Try again');
      b.type = 'button';
      b.style.marginLeft = '8px';
      b.addEventListener('click', retry);
      s.appendChild(b);
    }
  }
  function setAuthBusy(busy) {
    ['login-submit', 'signup-submit'].forEach((id) => { $(id).disabled = busy || !API_URL || (id === 'signup-submit' && state.ping && state.ping.signup_open === false); });
    $('login-submit').textContent = busy ? 'Please wait…' : 'Log in';
    $('signup-submit').textContent = busy ? 'Please wait…' : 'Create account';
  }
  async function refreshPing() {
    try {
      const ping = await api('ping', {}, 20000);
      if (!ping.ok) return;
      state.ping = ping;
      if (ping.title) { document.title = ping.title; $('auth-title').textContent = ping.title; $('app-title').textContent = ping.title; $('super-title').textContent = ping.title; }
      $('signup-code-row').hidden = !ping.needs_access_code;
      const question = String(ping.check_question || '').trim();
      $('signup-check-row').hidden = !question;
      if (question) {
        $('signup-check-q').textContent = question;
        $('signup-check-hint').textContent = 'Yes makes your first batch ' + (ping.check_size || 26) + ' filings instead of ' + (ping.batch_size || 100) +
          '; everything else is the same. Answer Yes only if you are.';
      }
      if (!ping.signup_open) $('signup-error').textContent = 'New accounts are closed at the moment. Ask the organiser.';
      setAuthBusy(false);
      if (!$('auth-status').textContent) setAuthStatus('Connected to the server.', 'ok');
    } catch (e) {
      if (!$('screen-auth').hidden && !$('auth-status').textContent) setAuthStatus(DOWN_TEXT, 'bad', () => { setAuthStatus(''); refreshPing(); });
    }
  }
  async function onLogin(event) {
    event.preventDefault();
    const id = $('login-id').value.trim();
    const password = $('login-pass').value;
    $('login-error').textContent = '';
    if (!id || !password) { $('login-error').textContent = 'Type your ID and your password.'; return; }
    setAuthBusy(true);
    try {
      const r = await api('login', {user_id: id, password: password}, 45000);
      if (!r.ok) { $('login-error').textContent = r.error || 'Login failed.'; return; }
      $('login-pass').value = '';
      enter(r);
    } catch (e) {
      $('login-error').textContent = DOWN_TEXT;
    } finally {
      setAuthBusy(false);
    }
  }
  async function onSignup(event) {
    event.preventDefault();
    const id = $('signup-id').value.trim().toLowerCase();
    const password = $('signup-pass').value;
    const err = $('signup-error');
    err.textContent = '';
    if (!/^[a-z][a-z0-9._-]{2,31}$/.test(id)) { err.textContent = 'The ID must start with a letter and have 3 to 32 letters, digits, dots, dashes or underscores.'; return; }
    if (password.length < 6) { err.textContent = 'The password must have at least 6 characters.'; return; }
    if (password !== $('signup-pass2').value) { err.textContent = 'The two passwords are not the same.'; return; }
    let checker = false;
    if (!$('signup-check-row').hidden) {
      const picked = document.querySelector('input[name="signup-check"]:checked');
      if (!picked) { err.textContent = 'Answer the question "' + $('signup-check-q').textContent + '" (Yes or No).'; return; }
      checker = picked.value === 'yes';
    }
    setAuthBusy(true);
    try {
      const r = await api('signup', {user_id: id, password: password, name: $('signup-name').value, access_code: $('signup-code').value, checker: checker}, 60000);
      if (!r.ok) { err.textContent = r.error || 'The account could not be created.'; return; }
      $('signup-pass').value = ''; $('signup-pass2').value = '';
      enter(r);
    } catch (e) {
      err.textContent = DOWN_TEXT + ' If the account was created in the meantime, use "Log in".';
    } finally {
      setAuthBusy(false);
    }
  }
  async function resume(session) {
    show('auth');
    setAuthStatus('Loading your work…');
    setAuthBusy(true);
    try {
      const r = await api('state', {token: session.token}, 45000);
      if (r.ok) { enter({token: session.token, user: r.user, state: r.state}); return; }
      store.del('session');
      setAuthStatus(r.code === 'auth' ? 'Your login has expired. Please log in again.' : (r.error || ''), r.code === 'auth' ? '' : 'bad');
      if (session.user) $('login-id').value = session.user.user_id;
    } catch (e) {
      setAuthStatus(DOWN_TEXT, 'bad', () => resume(session));
    } finally {
      setAuthBusy(false);
    }
  }
  function leaveWork() {
    persistDraft();
    state.formFid = null;
    leavePracticeUi();
    timer.pause();
  }
  function requireLogin(message) {
    leaveWork();
    store.del('session');
    state.token = null;
    if (state.user) $('login-id').value = state.user.user_id;
    setAuthTab('login');
    setAuthStatus(message || 'Your login has expired. Please log in again.');
    show('auth');
  }
  async function logout() {
    if (state.queue.length) {
      const ok = await confirmBox(state.queue.length + (state.queue.length === 1 ? ' answer is' : ' answers are') +
        ' not uploaded yet. They stay in this browser and are uploaded the next time you log in here. Log out anyway?', 'Log out');
      if (!ok) return;
    }
    leaveWork();
    const token = state.token;
    store.del('session');
    Object.assign(state, {token: null, user: null, role: '', trained: false, assigned: [], answers: {}, queue: [], mode: 'work', superData: null, superOpen: {}, superPw: {}});
    pdf.close();
    setAuthTab('login');
    setAuthStatus('You are logged out.');
    show('auth');
    if (token) { try { await api('logout', {token: token}, 15000); } catch (e) { /* the login simply expires later */ } }
  }

  /* ---------------------------------------------------------------- after sign-in */
  function applyState(s) {
    s = s || {};
    state.assigned = (s.assigned || []).map((a) => ({filing_id: a.filing_id, done_at: a.done_at || ''}));
    state.answers = s.answers || {};
    state.unassignedLeft = s.unassigned_left || 0;
    state.batchSize = s.batch_size || 100;
    if (typeof s.trained === 'boolean') state.trained = s.trained;
    if (typeof s.role === 'string') state.role = s.role;
  }
  function enter(result) {
    state.formFid = null;
    state.token = result.token;
    state.user = result.user;
    state.role = (result.user && result.user.role) || (result.state && result.state.role) || '';
    state.trained = false;
    store.set('session', {token: state.token, user: state.user});
    setAuthStatus('');
    $('user-chip').textContent = state.user.name || state.user.user_id;
    if (state.role === 'supervisor') { showSupervisor(); return; }
    applyState(result.state);
    state.queue = store.get(queueKey(), []) || [];
    reconcileQueue();
    if (!state.trained && PRACTICE) {
      if (store.get(onboardKey(), '') === 'practice') openPractice(); else showIntro();
    } else {
      startWork();
    }
    flushQueue();
  }
  function reconcileQueue() {
    const keep = [];
    for (const item of state.queue) {
      if (!item || !item.filing_id || !item.save_id) continue;
      const server = state.answers[item.filing_id];
      if (server && !server.pending && server.saved_at && Date.parse(server.saved_at) > Date.parse(item.client_time)) continue;   // a newer answer exists
      keep.push(item);
      if (state.assigned.some((a) => a.filing_id === item.filing_id)) {
        state.answers[item.filing_id] = {answer: item.answer, raw: item.raw, saved_at: item.client_time, pending: true};
      }
    }
    state.queue = keep;
    saveQueue();
  }
  function saveQueue() { if (state.queue.length) store.set(queueKey(), state.queue); else store.del(queueKey()); updateChrome(); }
  function startWork() {
    leavePracticeUi();
    buildJump();
    const first = state.assigned.findIndex((a) => !isDone(a.filing_id));
    if (!state.assigned.length || first < 0) { showDone(); return; }
    show('app');
    openFiling(first);
  }
  function showIntro() {
    leaveWork();
    state.mode = 'intro';
    store.del(onboardKey());
    show('intro');
    window.scrollTo(0, 0);
  }

  /* ---------------------------------------------------------------- the form */
  const amountRows = {};
  function buildAmountRows() {
    document.querySelectorAll('[data-amounts]').forEach((box) => {
      for (const [path, label, note, kind] of L.AMOUNT_GROUPS[box.dataset.amounts]) {
        const id = 'in-' + path.replace(/\./g, '-');
        const row = el('div', 'amt' + (kind === 'balance' && path.indexOf('q4.') === 0 ? ' is-total' : '') + (kind === 'decrease' ? ' is-decrease' : ''));
        row.dataset.row = path;
        const lab = el('label', 'amt-label', label);
        lab.htmlFor = id;
        if (note) lab.appendChild(el('small', '', note));
        const ctl = el('div', 'amt-ctl');
        const input = document.createElement('input');
        input.type = 'text'; input.id = id; input.inputMode = 'decimal'; input.autocomplete = 'off'; input.spellcheck = false;
        input.dataset.path = path + '.v';
        const unit = document.createElement('select');
        unit.dataset.unit = path;
        unit.setAttribute('aria-label', 'Unit of: ' + label);
        const ph = el('option', '', 'unit…');
        ph.value = ''; ph.disabled = true;
        unit.appendChild(ph);
        for (const k of ['dollars', 'thousands', 'millions', 'billions']) { const o = el('option', '', L.UNIT_NAMES[k]); o.value = k; unit.appendChild(o); }
        const ngLab = el('label', 'ng');
        const ng = document.createElement('input');
        ng.type = 'checkbox'; ng.dataset.path = path + '.ng';
        ng.setAttribute('aria-label', label + ': not given');
        ngLab.append(ng, document.createTextNode(' not given'));
        let field = input;
        if (kind === 'decrease') {          // the parentheses of a decrease are part of the box: only the number is typed
          field = el('span', 'paren-box');
          field.title = 'A decrease: type only the number';
          field.append(el('span', 'paren', '('), input, el('span', 'paren', ')'));
        }
        ctl.append(field, unit, ngLab);
        const conv = el('p', 'conv');
        row.append(lab, ctl, conv);
        box.appendChild(row);
        amountRows[path] = {row: row, input: input, unit: unit, ng: ng, conv: conv, kind: kind};
      }
    });
  }
  function foreignRow(row) {
    const div = el('div', 'foreign-row');
    const j = document.createElement('input');
    j.type = 'text'; j.placeholder = 'country or group of countries'; j.value = row.j; j.dataset.f = 'j'; j.setAttribute('aria-label', 'Country');
    const y = document.createElement('input');
    y.type = 'text'; y.placeholder = 'years, e.g. 2015+'; y.value = row.y; y.dataset.f = 'y'; y.setAttribute('aria-label', 'Open years');
    const x = el('button', '', '×');
    x.type = 'button'; x.title = 'Remove this line'; x.dataset.remove = '1'; x.setAttribute('aria-label', 'Remove this line');
    div.append(j, y, x);
    return div;
  }
  function renderForeignRows(rows) {
    const box = $('foreign-rows');
    box.textContent = '';
    (rows && rows.length ? rows : [{j: '', y: ''}]).forEach((r) => box.appendChild(foreignRow(r)));
  }
  function readForeignRows() {
    return Array.from($('foreign-rows').children).map((div) => ({j: div.querySelector('[data-f="j"]').value, y: div.querySelector('[data-f="y"]').value}));
  }
  function fillForm(raw) {
    document.querySelectorAll('#answer-form [data-path]').forEach((e) => {
      const value = L.getPath(raw, e.dataset.path);
      if (e.type === 'radio') e.checked = e.value === value;
      else if (e.type === 'checkbox') e.checked = value === true;
      else e.value = value == null ? '' : value;
    });
    renderForeignRows(raw.q6.foreign);
    syncUnits();
  }
  /* The unit menu next to an amount shows that amount's own unit, or else the unit of the note. */
  function syncUnits() {
    const raw = state.raw;
    for (const path in amountRows) {
      const f = L.getPath(raw, path);
      const v = (f && f.u) || raw.default_unit || '';
      if (amountRows[path].unit.value !== v) amountRows[path].unit.value = v;
    }
  }
  function readForm() {
    const raw = state.raw;
    raw.q1 = '';
    document.querySelectorAll('#answer-form [data-path]').forEach((e) => {
      if (e.type === 'radio') { if (e.checked) L.setPath(raw, e.dataset.path, e.value); }
      else if (e.type === 'checkbox') L.setPath(raw, e.dataset.path, e.checked);
      else L.setPath(raw, e.dataset.path, e.value);
    });
    raw.q6.foreign = readForeignRows();
  }
  function setCheck(path, on) {
    const box = document.querySelector('#answer-form [data-path="' + path + '"]');
    if (box) box.checked = on;
  }
  /* Typing a value unticks "not given"/"not stated"; ticking it empties the box next to it. */
  function applyLinks(t) {
    const p = t.dataset ? t.dataset.path || '' : '';
    if (!p) {
      if (t.closest && t.closest('#foreign-rows') && String(t.value || '').trim()) setCheck('q6.foreign_ns', false);
      return;
    }
    if (/\.ng$/.test(p)) { if (t.checked) { const r = amountRows[p.slice(0, -3)]; if (r) r.input.value = ''; } return; }
    if (/\.v$/.test(p)) { if (t.value.trim()) setCheck(p.slice(0, -2) + '.ng', false); return; }
    if (p === 'q6.federal_ns' && t.checked) $('q6-federal').value = '';
    else if (p === 'q6.federal' && t.value.trim()) setCheck('q6.federal_ns', false);
    else if (p === 'q6.state_ns' && t.checked) { $('q6-state').value = ''; setCheck('q6.state_various', false); }
    else if (p === 'q6.state_various' && t.checked) { $('q6-state').value = ''; setCheck('q6.state_ns', false); }
    else if (p === 'q6.state' && t.value.trim()) { setCheck('q6.state_ns', false); setCheck('q6.state_various', false); }
    else if (p === 'q6.foreign_ns' && t.checked) renderForeignRows([{j: '', y: ''}]);
  }
  function applyEnabled() {
    const raw = state.raw;
    const lock = state.locked || state.busy;
    document.querySelectorAll('#answer-form input, #answer-form select, #answer-form textarea, #answer-form button').forEach((e) => {
      e.disabled = e.closest('.practice-check') ? state.busy : lock;
    });
    if (lock) return;
    for (const [path] of L.AMOUNT_GROUPS.q4) {
      const r = amountRows[path];
      r.input.disabled = raw.q4.no_table; r.unit.disabled = raw.q4.no_table; r.ng.disabled = raw.q4.no_table;
    }
    for (const path in amountRows) { if (L.getPath(raw, path).ng) amountRows[path].unit.disabled = true; }
  }
  function renderDerived() {
    const raw = state.raw;
    const out = L.computeAnswer(raw);
    const view = raw.q1 === 'yes' ? out : L.computeAnswer(Object.assign({}, raw, {q1: 'yes'}));   // conversions while question 1 is open
    $('when-yes').hidden = raw.q1 === 'no';
    syncUnits();
    for (const [path] of L.ALL_AMOUNTS) {
      const r = amountRows[path];
      const c = view.conv[path];
      r.row.classList.toggle('is-ng', !!L.getPath(raw, path).ng);
      r.input.classList.toggle('bad', !!(c && c.error));
      r.unit.classList.toggle('bad', !!(c && c.needUnit));
      r.conv.className = 'conv' + (c && (c.error || c.needUnit) ? ' is-bad' : '');
      r.conv.textContent = !c || c.ng ? '' : (c.error ? 'This is not a number.'
        : (c.needUnit ? 'Choose the unit.' : '= ' + L.fmt(c.millions) + ' million USD'));
    }
    document.querySelector('[data-amounts="q4"]').classList.toggle('is-off', raw.q4.no_table);
    for (const [key, box, input] of [['federal', 'conv-q6-federal', 'q6-federal'], ['state', 'conv-q6-state', 'q6-state']]) {
      const y = view.years[key];
      const c = $(box);
      c.className = 'conv' + (y && y.error ? ' is-bad' : '');
      c.textContent = !y ? '' : (y.error ? y.error : (y.years ? '= ' + y.years.join(', ') : ''));
      $(input).classList.toggle('bad', !!(y && y.error));
    }
    const tie = $('tieout');
    const typedQ4 = L.AMOUNT_GROUPS.q4.some(([p]) => L.getPath(raw, p).v.trim() !== '');
    const t = L.tieOut(Object.assign({}, raw, {q1: 'yes'}));
    if (raw.q1 === 'no' || raw.q4.no_table || !typedQ4) {
      tie.hidden = true;
    } else if (t) {
      tie.hidden = false;
      tie.className = 'tieout ' + (t.ok ? 'is-ok' : 'is-off');
      tie.textContent = 'Beginning balance + changes = ' + L.fmt(t.sum) + ' million. Ending balance = ' + L.fmt(t.ending) + ' million. ' +
        (t.diff === 0 ? 'They agree.' : (t.ok ? 'Difference ' + L.fmt(t.diff) + ': within rounding.' : 'They differ by ' + L.fmt(t.diff) + '.'));
    } else {
      tie.hidden = false;
      tie.className = 'tieout';
      tie.textContent = 'Type the beginning and the ending balance to see whether the rows add up.';
    }
    markMissing(out);
    applyEnabled();
    if (state.mode === 'practice') renderPractice();
    return out;
  }
  function missingTarget(path) {
    if (path === 'q1') return $('q1-choice');
    if (path === 'default_unit') return $('unit-row');
    if (amountRows[path]) return amountRows[path].row;
    if (path === 'q6.federal') return $('q6-federal-box');
    if (path === 'q6.state') return $('q6-state-box');
    if (path === 'q6.foreign') return $('q6-foreign-box');
    return null;
  }
  function markMissing(out) {
    document.querySelectorAll('#answer-form .is-missing').forEach((e) => e.classList.remove('is-missing'));
    if (!state.showMissing || state.mode !== 'work') return;
    for (const m of out.missing) { const t = missingTarget(m.path); if (t) t.classList.add('is-missing'); }
    if (out.errors.some((e) => e.path === 'default_unit')) $('unit-row').classList.add('is-missing');
  }
  function showProblems(kind, lines, title) {
    const box = $('problems');
    box.textContent = '';
    if (!lines || !lines.length) { box.hidden = true; return; }
    box.className = 'problems ' + (kind === 'error' ? 'is-error' : 'is-warn');
    box.appendChild(el('strong', '', title || (kind === 'error' ? 'Please correct before saving:' : 'Please look at this again. If it is right as it is, press "Save anyway".')));
    const ul = el('ul');
    lines.forEach((t) => ul.appendChild(el('li', '', t)));
    box.appendChild(ul);
    box.hidden = false;
  }
  function firstProblemPath(out) {
    const items = out.missing.concat(out.errors).slice().sort((a, b) => a.q - b.q);
    return items.length ? items[0].path : null;
  }
  function focusPath(path) {
    let target = null;
    const m = /^q6\.foreign\.(\d+)\.([jy])$/.exec(path);
    if (m) {
      const row = $('foreign-rows').children[Number(m[1])];
      target = row ? row.querySelector('[data-f="' + m[2] + '"]') : null;
    } else if (path === 'q1') target = document.querySelector('#answer-form input[name="q1"]');
    else if (path === 'q6.foreign') target = $('foreign-rows').querySelector('input');
    else if (path === 'default_unit') target = $('default-unit');
    else {
      const base = path.replace(/\.(v|ng)$/, '');
      target = amountRows[base] ? amountRows[base].input : document.querySelector('#answer-form [data-path="' + path + '"]');
    }
    if (target && typeof target.focus === 'function') {
      try { target.focus({preventScroll: true}); } catch (e) { target.focus(); }
      if (target.scrollIntoView) target.scrollIntoView({block: 'center'});
    }
  }
  function onFormChange(event) {
    if (state.locked || state.busy) return;
    const t = event ? event.target : null;
    if (t && t.dataset && /\.v$/.test(t.dataset.path || '')) {
      const r = amountRows[t.dataset.path.slice(0, -2)];
      const signs = /[()\-\u2212\u2012\u2013\u2014]/g;
      if (r && r.kind === 'decrease' && signs.test(t.value)) t.value = t.value.replace(signs, '');   // the box shows them already
    }
    if (t) applyLinks(t);
    readForm();
    if (t && t.dataset && t.dataset.unit) {
      const f = L.getPath(state.raw, t.dataset.unit);
      if (f) f.u = t.value === state.raw.default_unit ? '' : t.value;
    }
    state.ack = null;
    const out = renderDerived();
    if (state.showMissing && state.mode === 'work') {
      const lines = L.problemLines(out);
      if (lines.length) showProblems('error', lines, out.missing.length ? MISSING_TITLE : null); else showProblems(null);
    } else if (state.mode === 'work') {
      showProblems(null);
    }
    updateChrome();
    scheduleDraft();
  }

  /* ---------------------------------------------------------------- drafts (unsaved typing kept in this browser) */
  let draftTimer = null;
  function isDirty() { return state.formFid !== null && JSON.stringify(state.raw) !== state.baseline; }
  function persistDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    const fid = state.formFid;
    if (!fid || !state.user) return;
    if (isDirty()) store.set(draftKey(fid), {ts: Date.now(), base: state.formBase, raw: state.raw}); else store.del(draftKey(fid));
  }
  function scheduleDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(persistDraft, 250); }
  function pickRaw(fid) {
    const saved = state.answers[fid];
    let baseline = L.blankRaw();
    if (saved) baseline = (saved.raw && typeof saved.raw === 'object' && (saved.raw.q1 === 'yes' || saved.raw.q1 === 'no')) ? L.mergeRaw(saved.raw) : L.rawFromAnswer(saved.answer);
    state.baseline = JSON.stringify(baseline);
    state.formBase = saved && saved.saved_at ? saved.saved_at : '';
    const draft = store.get(draftKey(fid), null);
    if (draft && draft.raw && draft.base === state.formBase) return L.mergeRaw(draft.raw);   // unsaved typing on top of this version
    if (draft) store.del(draftKey(fid));                                                      // the answer was saved again since: the draft is out of date
    return clone(baseline);
  }

  /* ---------------------------------------------------------------- moving between filings */
  function buildJump() {
    const sel = $('jump');
    sel.textContent = '';
    state.assigned.forEach((a, i) => {
      const meta = MANIFEST.filings[a.filing_id] || {};
      const mark = state.answers[a.filing_id] && state.answers[a.filing_id].pending ? '↻' : (isDone(a.filing_id) ? '✓' : '○');
      const o = el('option', '', mark + '  ' + a.filing_id + '  ' + (meta.company || '') + (meta.period ? '  (' + meta.period.slice(0, 4) + ')' : ''));
      o.value = String(i);
      sel.appendChild(o);
    });
    sel.value = String(state.index);
  }
  function setFiscalYear(period) {
    $('q6-fy').textContent = period ? ' (this note: the fiscal year that ended ' + prettyPeriod(period) + ')' : '';
  }
  function showDocument(meta, missingText) {
    const hasPdf = !!(meta && meta.pdf);
    $('pdf-bar').hidden = !hasPdf;
    $('pdf-chips').hidden = !hasPdf;
    $('pdf-wrap').hidden = !hasPdf;
    $('pdf-link').hidden = !hasPdf;
    if (hasPdf) {
      $('no-pdf').hidden = true;
      $('pdf-link').href = meta.pdf;
      pdf.open(meta.pdf);
      return;
    }
    pdf.close();
    $('no-pdf').hidden = false;
    $('no-pdf').querySelector('h2').textContent = missingText ? 'PDF not found' : 'No income-tax note';
    const ps = $('no-pdf').querySelectorAll('p');
    ps[0].textContent = missingText || 'The financial statements of this filing contain no income-tax note, so there is nothing to read.';
    ps[1].hidden = !!missingText;
  }
  function openFiling(index) {
    persistDraft();
    state.formFid = null;
    leavePracticeUi();
    state.index = Math.max(0, Math.min(index, state.assigned.length - 1));
    const fid = currentFid();
    const meta = MANIFEST.filings[fid];
    $('filing-id').textContent = fid;
    $('filing-company').textContent = meta ? meta.company : '';
    $('filing-company').title = meta ? meta.company : '';
    $('filing-period').textContent = meta && meta.period ? 'fiscal year ended ' + prettyPeriod(meta.period) : '';
    setFiscalYear(meta ? meta.period : '');
    show('app');
    showDocument(meta, meta ? '' : 'This copy of the website has no PDF for filing ' + fid + '. Tell the organiser.');
    state.raw = pickRaw(fid);
    state.formFid = fid;
    state.locked = false;
    state.ack = null;
    state.showMissing = false;
    fillForm(state.raw);
    showProblems(null);
    renderDerived();
    document.querySelector('.form-head').hidden = false;
    $('form-scroll').scrollTop = 0;
    timer.start();
    updateChrome();
  }
  function nextOpenIndex(after) {
    const n = state.assigned.length;
    for (let step = 1; step <= n; step++) {
      const i = (after + step) % n;
      if (i !== after && !isDone(state.assigned[i].filing_id)) return i;
    }
    return -1;
  }
  function updateChrome() {
    const practice = state.mode === 'practice';
    const onboarding = practice && !state.trained;
    const total = state.assigned.length;
    const done = doneCount();
    $('progress-label').textContent = done + ' / ' + total + ' done';
    $('progress-fill').style.width = (total ? (100 * done / total) : 0) + '%';
    $('progress').hidden = onboarding;
    $('btn-example').hidden = onboarding || !PRACTICE;
    $('btn-example').textContent = practice ? 'Back to my filings' : 'Practice filing';
    const chip = $('pending-chip');
    chip.hidden = state.queue.length === 0;
    chip.textContent = state.queue.length + (state.queue.length === 1 ? ' answer' : ' answers') + ' waiting to upload';
    chip.title = 'Saved in this browser. They are uploaded automatically when the server can be reached. Click to try now.';
    $('btn-prev').hidden = practice;
    $('btn-skip').hidden = practice;
    $('btn-save').hidden = practice;
    $('btn-revert').hidden = practice || !isDirty() || state.busy;
    $('btn-back-intro').hidden = !onboarding;
    $('btn-start').hidden = !onboarding;
    $('btn-close-example').hidden = !practice || onboarding;
    const allOk = state.practiceOk >= QUESTIONS.length;
    $('btn-start').disabled = state.busy || !allOk;
    $('btn-start').textContent = state.busy && onboarding ? 'Please wait…' : 'Start my filings →';
    $('btn-prev').disabled = state.busy || state.index <= 0;
    $('btn-skip').disabled = state.busy;
    $('btn-save').disabled = state.busy;
    $('btn-save').textContent = state.busy ? 'Saving…' : (state.ack ? 'Save anyway →' : 'Save & next →');
    const status = $('save-status');
    if (practice) {
      status.textContent = onboarding ? (allOk ? 'All six answers are correct.' : 'Answer and check all six questions to start.') : 'Nothing here is saved as an answer.';
    } else {
      const fid = currentFid();
      const saved = fid ? state.answers[fid] : null;
      if (isDirty()) status.textContent = saved ? 'Changed, not saved yet' : '';
      else if (saved && saved.pending) status.textContent = 'Saved in this browser, waiting to upload';
      else if (saved) status.textContent = 'Saved ' + prettyTime(saved.saved_at);
      else status.textContent = '';
    }
    const sel = $('jump');
    if (sel.options.length === total) {
      state.assigned.forEach((a, i) => {
        const o = sel.options[i];
        const mark = state.answers[a.filing_id] && state.answers[a.filing_id].pending ? '↻' : (isDone(a.filing_id) ? '✓' : '○');
        if (o.textContent.charAt(0) !== mark) o.textContent = mark + o.textContent.slice(1);
      });
      sel.value = String(state.index);
    }
  }
  function showDone() {
    leaveWork();
    const n = state.assigned.length;
    $('done-text').textContent = n ? 'You have answered all ' + n + ' filings assigned to you.' : 'No filings are assigned to you at the moment. Ask the organiser.';
    const pending = state.queue.length;
    $('done-pending').hidden = pending === 0;
    $('done-pending').textContent = pending + (pending === 1 ? ' answer is' : ' answers are') +
      ' saved in this browser but not uploaded yet. Keep this page open while you are connected to the internet: the upload is automatic.';
    $('done-review').hidden = n === 0;
    const more = $('done-more');
    const can = n > 0 && pending === 0 && state.unassignedLeft > 0 && state.role === '';
    more.hidden = !can;
    more.textContent = 'Get ' + Math.min(state.batchSize, state.unassignedLeft) + ' more filings';
    $('done-error').textContent = '';
    show('done');
  }
  async function requestMore() {
    const b = $('done-more');
    b.disabled = true;
    $('done-error').textContent = '';
    try {
      const r = await api('more', {token: state.token}, 60000);
      if (r.ok) { applyState(r.state); reconcileQueue(); startWork(); return; }
      if (r.code === 'auth') { requireLogin(); return; }
      if (r.code === 'not_finished') { await reloadAssignments('The organiser added filings to your list.'); return; }
      $('done-error').textContent = r.error || 'No more filings could be assigned.';
    } catch (e) {
      $('done-error').textContent = DOWN_TEXT;
    } finally {
      b.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- saving */
  function setBusy(busy) { state.busy = busy; applyEnabled(); updateChrome(); }
  function markLocal(item) {
    state.answers[item.filing_id] = {answer: item.answer, raw: item.raw, saved_at: item.client_time, pending: true};
  }
  /* Sends one stored answer. Returns {kind: 'ok' | 'offline' | 'auth' | 'rejected', text?}. */
  async function upload(item) {
    let r;
    try {
      r = await api('save', {token: state.token, filing_id: item.filing_id, answer: item.answer, raw: item.raw, seconds: item.seconds, save_id: item.save_id}, 45000);
    } catch (e) {
      return {kind: 'offline'};
    }
    if (r.ok) {
      state.queue = state.queue.filter((q) => q.save_id !== item.save_id);
      const a = state.assigned.find((x) => x.filing_id === item.filing_id);
      if (a && !a.done_at) a.done_at = r.first_saved_at || r.saved_at;
      if (!state.queue.some((q) => q.filing_id === item.filing_id)) {
        state.answers[item.filing_id] = {answer: item.answer, raw: item.raw, saved_at: r.saved_at, first_saved_at: r.first_saved_at};
        if (state.formFid === item.filing_id && state.formBase === item.client_time) state.formBase = r.saved_at;
        const draft = store.get(draftKey(item.filing_id), null);
        if (draft && draft.base === item.client_time) { draft.base = r.saved_at; store.set(draftKey(item.filing_id), draft); }
      }
      saveQueue();
      return {kind: 'ok'};
    }
    if (r.code === 'auth') return {kind: 'auth'};
    if (r.code === 'busy' || r.code === 'server') return {kind: 'offline'};
    state.queue = state.queue.filter((q) => q.save_id !== item.save_id);
    saveQueue();
    return {kind: 'rejected', text: r.error || 'The server refused this answer.', code: r.code};
  }
  async function saveAndNext() {
    if (state.busy || state.locked || state.mode !== 'work') return;
    readForm();
    let out = L.computeAnswer(state.raw);
    if (out.errors.length || out.missing.length) {
      state.ack = null;
      state.showMissing = true;
      out = renderDerived();
      showProblems('error', L.problemLines(out), out.missing.length ? MISSING_TITLE : 'Please correct before saving:');
      const first = firstProblemPath(out);
      if (first) focusPath(first);
      updateChrome();
      return;
    }
    const signature = JSON.stringify(out.warnings);
    if (out.warnings.length && state.ack !== signature) {
      state.ack = signature;
      showProblems('warn', out.warnings);
      updateChrome();
      return;
    }
    const fid = currentFid();
    const earlier = state.queue.filter((q) => q.filing_id === fid);
    const item = {
      save_id: uuid(), filing_id: fid, answer: out.answer, raw: clone(state.raw),
      seconds: timer.seconds() + earlier.reduce((s, q) => s + (q.seconds || 0), 0), client_time: new Date().toISOString(),
    };
    state.queue = state.queue.filter((q) => q.filing_id !== fid).concat([item]);
    saveQueue();
    showProblems(null);
    setBusy(true);
    const result = await upload(item);
    setBusy(false);
    if (result.kind === 'rejected') {
      if (result.code === 'not_assigned') { await reloadAssignments(fid + ' is no longer on your list (the organiser changed your filings). Your list is up to date now.'); return; }
      showProblems('error', [result.text], 'This answer was not saved:');
      return;
    }
    if (result.kind !== 'ok') markLocal(item);
    store.del(draftKey(fid));
    state.baseline = JSON.stringify(state.raw);
    state.formBase = state.answers[fid] ? state.answers[fid].saved_at : state.formBase;
    state.ack = null;
    if (result.kind === 'auth') {
      requireLogin('Your login has expired. Log in again: the answer you just gave is kept in this browser and will be saved.');
      return;
    }
    const next = nextOpenIndex(state.index);
    if (next < 0) showDone(); else openFiling(next);
  }
  /* The organiser changed this evaluator's filings: fetch the list again and continue with the first open filing. */
  async function reloadAssignments(message) {
    try {
      const r = await api('state', {token: state.token}, 45000);
      if (r.ok) { applyState(r.state); reconcileQueue(); }
    } catch (e) { /* keep the list we have */ }
    leaveWork();
    startWork();
    if (!message) return;
    if (!$('screen-done').hidden) { $('done-pending').textContent = message; $('done-pending').hidden = false; }
    else showBanner(message, false);
  }
  /* Uploads what is still waiting. Runs after login, when the connection returns, and every 20 seconds. */
  async function flushQueue() {
    if (state.flushing || state.busy || !state.token || !state.queue.length) return;
    state.flushing = true;
    try {
      for (const item of state.queue.slice()) {
        if (!state.token) break;
        const result = await upload(item);
        if (result.kind === 'offline') break;
        if (result.kind === 'auth') { requireLogin('Your login has expired. Log in again: your answers are kept in this browser and will be saved.'); break; }
        if (result.kind === 'rejected') {
          const fid = item.filing_id;
          if (state.answers[fid] && state.answers[fid].pending) delete state.answers[fid];
          if (state.user) store.set(draftKey(fid), {ts: Date.now(), raw: item.raw});
          showBanner('The answer for ' + fid + ' could not be saved: ' + result.text + ' What you typed is still in this browser.', true);
          if (result.code === 'not_assigned') { await reloadAssignments(''); break; }
        }
      }
    } finally {
      state.flushing = false;
      updateChrome();
      if (!$('screen-done').hidden) showDone();
    }
  }
  function showBanner(text, isError) {
    const b = $('banner');
    b.textContent = text;
    b.className = 'banner' + (isError ? ' is-error' : '');
    const x = el('button', 'btn btn-small', 'Dismiss');
    x.type = 'button';
    x.addEventListener('click', () => { b.hidden = true; });
    b.appendChild(x);
    b.hidden = false;
  }

  /* ---------------------------------------------------------------- practice filing */
  function buildPracticeChecks() {
    document.querySelectorAll('.practice-check').forEach((box) => {
      const q = box.dataset.check;
      const b = el('button', 'btn btn-small btn-check', 'Check answer');
      b.type = 'button';
      b.dataset.checkBtn = q;
      const res = el('div', 'check-result');
      res.dataset.result = q;
      res.hidden = true;
      res.setAttribute('role', 'status');
      box.append(b, res);
    });
  }
  function leavePracticeUi() {
    if (state.mode === 'practice') persistDraft();
    if (state.mode === 'practice' || state.mode === 'intro') state.mode = 'work';
    document.body.classList.remove('is-practice');
    document.querySelectorAll('.practice-check').forEach((box) => { box.hidden = true; });
    $('practice-note').hidden = true;
  }
  function openPractice() {
    if (!EXAMPLE || !PRACTICE) { startWork(); return; }
    persistDraft();
    state.formFid = null;
    timer.pause();
    state.mode = 'practice';
    document.body.classList.add('is-practice');
    if (!state.trained) store.set(onboardKey(), 'practice');
    $('filing-id').textContent = 'PRACTICE';
    $('filing-company').textContent = EXAMPLE.company;
    $('filing-company').title = EXAMPLE.company;
    $('filing-period').textContent = 'fiscal year ended ' + prettyPeriod(EXAMPLE.period);
    setFiscalYear(EXAMPLE.period);
    show('app');
    showDocument(EXAMPLE, '');
    state.raw = pickRaw('EXAMPLE');
    state.formFid = 'EXAMPLE';
    state.locked = false;
    state.ack = null;
    state.showMissing = false;
    const saved = store.get(practiceKey(), null);
    state.practice = saved && saved.results && typeof saved.results === 'object' ? saved : {results: {}};
    document.querySelectorAll('.practice-check').forEach((box) => { box.hidden = false; });
    document.querySelectorAll('.check-result').forEach((box) => { box.dataset.key = ''; });
    $('practice-note').hidden = false;
    $('practice-steps').hidden = !!state.trained;
    $('practice-lead').textContent = state.trained
      ? 'Practice filing with known answers (Apple, fiscal year 2020). Answer a question and press "Check answer" under it. Nothing here is saved as an answer.'
      : 'This filing (Apple, fiscal year 2020) has known answers. Answer each question, then press "Check answer" under it: the page says whether you are right, and if not, why and where to look in the note. When all six are correct, "Start my filings" opens your own filings. Nothing here is saved as an answer.';
    document.querySelector('.form-head').hidden = true;
    fillForm(state.raw);
    showProblems(null);
    renderDerived();
    $('form-scroll').scrollTop = 0;
    updateChrome();
  }
  function closePractice() {
    leaveWork();
    if (!state.assigned.length) { showDone(); return; }
    show('app');
    openFiling(state.index);
  }
  function sigOf(q) { return JSON.stringify(L.practiceSlice(state.raw, q)); }
  function savePractice() { store.set(practiceKey(), state.practice); }
  function checkQuestion(q) {
    if (!PRACTICE || state.mode !== 'practice' || state.busy) return;
    readForm();
    const r = L.checkPractice(state.raw, PRACTICE)[q];
    state.practice.results[q] = {sig: sigOf(q), ok: r.ok, reasons: r.reasons, revealed: false};
    savePractice();
    renderPractice();
    updateChrome();
  }
  function actButton(act, q, label) {
    const b = el('button', 'btn btn-small', label);
    b.type = 'button';
    b.dataset.act = act;
    b.dataset.q = q;
    return b;
  }
  function renderPractice() {
    if (state.mode !== 'practice' || !PRACTICE) return;
    let nOk = 0;
    let changed = false;
    for (const q of QUESTIONS) {
      const box = document.querySelector('[data-result="' + q + '"]');
      let r = state.practice.results[q];
      if (r && r.sig !== sigOf(q)) { delete state.practice.results[q]; r = null; changed = true; }
      if (r && r.ok) nOk++;
      const key = r ? r.sig + '|' + r.ok + '|' + r.revealed + '|' + r.reasons.join('|') : '';
      if (box.dataset.key === key && key) continue;
      box.dataset.key = key;
      box.textContent = '';
      box.hidden = !r;
      if (!r) continue;
      const info = (PRACTICE.questions && PRACTICE.questions[q]) || {};
      box.className = 'check-result ' + (r.ok ? 'is-ok' : 'is-bad');
      const head = el('div');
      head.appendChild(el('span', 'badge ' + (r.ok ? 'badge-ok' : 'badge-bad'), r.ok ? 'Correct' : 'Not yet'));
      head.appendChild(document.createTextNode(r.ok ? (info.ok || '') : 'Look again:'));
      box.appendChild(head);
      if (r.ok) continue;
      const ul = el('ul');
      r.reasons.forEach((t) => ul.appendChild(el('li', '', t)));
      box.appendChild(ul);
      if (info.where) {
        const p = el('p', 'where');
        p.append(el('b', '', 'Where to look: '), document.createTextNode(info.where));
        box.appendChild(p);
      }
      const acts = el('div', 'check-actions');
      if (info.find) acts.appendChild(actButton('find', q, 'Show me in the PDF'));
      if (info.answer) acts.appendChild(actButton('reveal', q, r.revealed ? 'Hide the answer' : 'Show the answer'));
      box.appendChild(acts);
      if (r.revealed && info.answer) {
        const a = el('p', 'answer');
        a.append(el('b', '', 'Answer: '), document.createTextNode(info.answer));
        box.appendChild(a);
      }
    }
    if (changed) savePractice();
    state.practiceOk = nOk;
    $('practice-count').textContent = 'Correct so far: ' + nOk + ' of ' + QUESTIONS.length + ' questions';
    $('practice-fill').style.width = (100 * nOk / QUESTIONS.length) + '%';
  }
  function onPracticeAction(event) {
    const check = event.target.closest('[data-check-btn]');
    if (check) { checkQuestion(check.dataset.checkBtn); return; }
    const act = event.target.closest('[data-act]');
    if (!act || state.mode !== 'practice') return;
    const q = act.dataset.q;
    const info = (PRACTICE && PRACTICE.questions && PRACTICE.questions[q]) || {};
    if (act.dataset.act === 'find' && info.find) {
      $('pdf-q').value = info.find;
      pdf.find(info.find, false, true);
    } else if (act.dataset.act === 'reveal') {
      const r = state.practice.results[q];
      if (r) { r.revealed = !r.revealed; savePractice(); renderPractice(); }
    }
  }
  async function finishPractice() {
    if (state.busy || state.mode !== 'practice' || state.trained) return;
    setBusy(true);
    let ok = false;
    try {
      const r = await api('trained', {token: state.token}, 45000);
      if (!r.ok) {
        if (r.code === 'auth') { setBusy(false); requireLogin(); return; }
        showProblems('error', [r.error || 'The server did not accept this.'], 'Could not start:');
      } else {
        ok = true;
        state.trained = true;
        applyState(r.state);
        store.del(onboardKey());
      }
    } catch (e) {
      showProblems('error', [DOWN_TEXT], 'Could not start:');
    }
    setBusy(false);
    if (ok) { leaveWork(); startWork(); }
  }

  /* ---------------------------------------------------------------- supervisor */
  function showSupervisor() {
    leaveWork();
    state.mode = 'super';
    $('super-user').textContent = state.user.name || state.user.user_id;
    show('super');
    loadOverview();
  }
  async function loadOverview(keepMessage) {
    $('super-refresh').disabled = true;
    $('super-updated').textContent = 'Loading…';
    try {
      const r = await api('overview', {token: state.token}, 60000);
      if (!r.ok) {
        if (r.code === 'auth') { requireLogin(); return; }
        superMessage(r.error || 'The overview could not be loaded.', true);
        $('super-updated').textContent = '';
        return;
      }
      state.superData = r;
      if (keepMessage !== true) superMessage('', false);
      renderOverview();
      $('super-updated').textContent = 'Updated ' + prettyTime(r.server_time || new Date().toISOString());
    } catch (e) {
      superMessage(DOWN_TEXT, true);
      $('super-updated').textContent = '';
    } finally {
      $('super-refresh').disabled = false;
    }
  }
  function card(k, v, s) {
    const c = el('div', 'card');
    c.append(el('div', 'k', k), el('div', 'v', String(v)));
    if (s) c.appendChild(el('div', 's', s));
    return c;
  }
  function superMessage(text, isError) {
    const box = $('super-error');
    box.textContent = '';
    box.className = 'note ' + (isError ? 'note-warn' : 'note-info');
    $('super-msg').hidden = !text;
    if (!text) return;
    const x = el('button', 'btn btn-small', 'Dismiss');
    x.type = 'button';
    x.addEventListener('click', () => { $('super-msg').hidden = true; });
    box.append(el('span', 'super-msg-text', text), x);
  }
  async function setCount(userId) {
    const d = state.superData;
    const u = ((d && d.users) || []).find((x) => x.user_id === userId);
    const input = document.querySelector('[data-count-for="' + userId + '"]');
    if (!u || !input) return;
    const free = (d.totals && d.totals.free) || 0;
    const want = Number(input.value);
    if (input.value.trim() === '' || !Number.isInteger(want)) { superMessage('Type a whole number of filings for "' + userId + '".', true); return; }
    if (want < u.done) { superMessage('"' + userId + '" has already answered ' + u.done + ' filings, so the number cannot be lower than ' + u.done + '.', true); return; }
    if (want === u.assigned) { superMessage('"' + userId + '" already has ' + want + ' filings.', false); return; }
    if (want > u.assigned && free === 0) { superMessage('No unassigned filings are left. Lower the number of another evaluator first.', true); return; }
    if (want < u.assigned) {
      const n = u.assigned - want;
      const ok = await confirmBox('Take ' + n + ' unanswered filing' + (n === 1 ? '' : 's') + ' away from "' + userId + '"? ' +
        (n === 1 ? 'It goes' : 'They go') + ' back to the pool for other evaluators. Answered filings stay with "' + userId + '".', 'Take them away');
      if (!ok) return;
    }
    $('super-updated').textContent = 'Saving\u2026';
    try {
      const r = await api('set_assigned', {token: state.token, user_id: userId, count: want}, 60000);
      if (!r.ok) {
        if (r.code === 'auth') { requireLogin(); return; }
        superMessage(r.error || 'The number could not be changed.', true);
      } else {
        superMessage('"' + userId + '" now has ' + r.after + ' filings' + (r.added ? ' (' + r.added + ' added' + (r.short ? '; only ' + r.added + ' were free' : '') + ')' :
          (r.released ? ' (' + r.released + ' back in the pool)' : '')) + '. ' + r.free_left + ' filings are not assigned.', false);
      }
    } catch (e) {
      superMessage(DOWN_TEXT, true);
    }
    loadOverview(true);
  }
  async function deleteAccount(userId) {
    const u = ((state.superData && state.superData.users) || []).find((x) => x.user_id === userId);
    if (!u || u.deleted_at) return;
    const open = u.filings.filter((f) => !f.done_at).length;
    const done = u.filings.length - open;
    const ok = await confirmBox('Delete the account "' + u.user_id + '"' + (u.name && u.name !== u.user_id ? ' (' + u.name + ')' : '') + '? ' +
      'It can no longer log in. Its ' + done + ' answered filing' + (done === 1 ? '' : 's') + ' and all its answers are kept and stay visible here. ' +
      'Its ' + open + ' unfinished filing' + (open === 1 ? ' goes' : 's go') + ' back to the pool and will be given to other evaluators.', 'Delete account');
    if (!ok) return;
    $('super-updated').textContent = 'Deleting\u2026';
    try {
      const r = await api('delete_account', {token: state.token, user_id: userId}, 60000);
      if (!r.ok) {
        if (r.code === 'auth') { requireLogin(); return; }
        superMessage(r.error || 'The account could not be deleted.', true);
      }
    } catch (e) {
      superMessage(DOWN_TEXT, true);
    }
    loadOverview(true);
  }
  function filingsText(n, what) { return n + ' ' + (what ? what + ' ' : '') + 'filing' + (n === 1 ? '' : 's'); }
  async function restoreAccount(userId) {
    const d = state.superData;
    const u = ((d && d.users) || []).find((x) => x.user_id === userId);
    if (!u || !u.deleted_at) return;
    const parts = ['Restore the account "' + u.user_id + '"' + (u.name && u.name !== u.user_id ? ' (' + u.name + ')' : '') + '?',
      'It can log in again with its old password, and all its answers are still there.'];
    if (!u.freed) {
      parts.push('It keeps its ' + filingsText(u.assigned) + '.');
    } else {
      const back = u.freed_free || 0;
      const gone = u.freed - back;
      const others = Math.min(gone, Math.max(0, ((d.totals && d.totals.free) || 0) - back));
      if (!gone) {
        parts.push('It gets back the ' + filingsText(u.freed, 'unfinished') + ' that went back to the pool when it was deleted.');
      } else {
        parts.push('When it was deleted, ' + filingsText(u.freed, 'unfinished') + ' went back to the pool. ' +
          (back ? back + (back === 1 ? ' is' : ' are') + ' still free and ' + (back === 1 ? 'comes' : 'come') + ' back; ' : '') +
          'other evaluators took ' + gone + '.');
        parts.push(others === gone ? 'In their place it gets ' + filingsText(others, 'other free') + '.' :
          (others ? 'In their place it gets ' + filingsText(others, 'other free') + ', all that are free.' : 'No other filings are free to put in their place.'));
      }
    }
    if (!(await confirmBox(parts.join(' '), 'Restore account'))) return;
    $('super-updated').textContent = 'Restoring\u2026';
    try {
      const r = await api('restore_account', {token: state.token, user_id: userId}, 60000);
      if (!r.ok) {
        if (r.code === 'auth') { requireLogin(); return; }
        superMessage(r.error || 'The account could not be restored.', true);
      } else {
        let text = '"' + r.user_id + '" is restored and can log in again with its old password.';
        text += ' It has ' + filingsText(r.assigned) + ', ' + r.answered + ' of them answered.';
        const got = [];
        if (r.back) got.push(r.back + ' of its unfinished filings came back');
        if (r.added) got.push(filingsText(r.added, 'other free') + ' replace ones others took');
        if (got.length) text += ' ' + got.join(' and ') + '.';
        if (r.short) text += ' ' + r.short + (r.short === 1 ? ' was' : ' were') + ' not replaced because no filings are free; use Number of filings when some are free.';
        superMessage(text, false);
      }
    } catch (e) {
      superMessage(DOWN_TEXT, true);
    }
    loadOverview(true);
  }
  async function showPassword(userId) {
    try {
      const r = await api('show_password', {token: state.token, user_id: userId}, 45000);
      if (!r.ok) {
        if (r.code === 'auth') { requireLogin(); return; }
        superMessage(r.error || 'The password could not be shown.', true);
        return;
      }
      state.superPw[userId] = r.password || '';
      renderOverview();
    } catch (e) {
      superMessage(DOWN_TEXT, true);
    }
  }
  async function setPassword(userId) {
    const input = document.querySelector('[data-pw-for="' + userId + '"]');
    if (!input) return;
    const pw = input.value.trim();
    if (pw.length < 6) { superMessage('The new password of "' + userId + '" needs at least 6 characters.', true); return; }
    const ok = await confirmBox('Set the password of "' + userId + '" to "' + pw + '"? If "' + userId + '" is logged in anywhere, that login ends; ' +
      'they log in again with the new password.', 'Set password');
    if (!ok) return;
    $('super-updated').textContent = 'Saving\u2026';
    try {
      const r = await api('set_password', {token: state.token, user_id: userId, password: pw}, 60000);
      if (!r.ok) {
        if (r.code === 'auth') { requireLogin(); return; }
        superMessage(r.error || 'The password could not be set.', true);
      } else {
        state.superPw[userId] = r.password;
        superMessage('The password of "' + r.user_id + '" is now "' + r.password + '". Tell them; their open logins have ended.', false);
      }
    } catch (e) {
      superMessage(DOWN_TEXT, true);
    }
    loadOverview(true);
  }
  function passwordTools(u) {
    const box = el('div', 'pw-tools');
    box.appendChild(el('span', 'pw-label', 'Password'));
    const known = state.superPw[u.user_id];
    if (known === undefined) {
      const show = el('button', 'btn btn-small', 'Show password');
      show.type = 'button';
      show.dataset.pwShow = u.user_id;
      box.appendChild(show);
    } else {
      const value = known === '' ? el('span', 'pw-none', 'not kept for this account (made before passwords were kept); set a new one')
                                 : el('code', 'pw-value', known);
      value.dataset.pwOf = u.user_id;
      const hide = el('button', 'btn btn-small btn-quiet', 'Hide');
      hide.type = 'button';
      hide.dataset.pwHide = u.user_id;
      box.append(value, hide);
    }
    box.appendChild(el('span', 'pw-sep'));
    const lab = el('label', '', 'New password');
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.pwFor = u.user_id;
    input.id = 'pw-' + u.user_id;
    lab.htmlFor = input.id;
    const set = el('button', 'btn btn-small', 'Set password');
    set.type = 'button';
    set.dataset.pwSet = u.user_id;
    box.append(lab, input, set);
    return box;
  }
  function kindLabel(role) { return role === 'supervisor' ? 'Supervisor' : 'Evaluator'; }
  function renderOverview() {
    const d = state.superData;
    if (!d) return;
    const t = d.totals || {};
    const cards = $('super-cards');
    cards.textContent = '';
    const pct = t.filings ? Math.round(100 * (t.done || 0) / t.filings) : 0;
    cards.append(
      card('Filings', t.filings || 0, 'in the evaluation'),
      card('Answered by evaluators', t.done || 0, pct + '% of all filings'),
      card('Assigned to evaluators', t.assigned || 0, (t.free || 0) + ' not assigned yet'),
      card('Evaluators', t.evaluators || 0, t.deleted ? 'with a batch; ' + t.deleted + ' deleted account' + (t.deleted === 1 ? '' : 's') + ' not counted' : 'accounts with a batch'));
    $('super-check-n').textContent = String(d.check_size || 26);
    const users = (d.users || []).filter((u) => u.role !== 'supervisor');
    const rank = (u) => (u.deleted_at ? 1 : 0);        // evaluators first, then deleted accounts
    users.sort((a, b) => (rank(a) - rank(b)) || String(a.created_at).localeCompare(String(b.created_at)));
    const body = $('super-table').querySelector('tbody');
    body.textContent = '';
    if (!users.length) {
      const tr = el('tr');
      const td = el('td', '', 'Nobody has created an account yet.');
      td.colSpan = 10;
      tr.appendChild(td);
      body.appendChild(tr);
    }
    for (const u of users) {
      const open = !!state.superOpen[u.user_id];
      const tr = el('tr', 'user-row' + (open ? ' is-open' : '') + (u.deleted_at ? ' is-deleted' : ''));
      tr.dataset.user = u.user_id;
      const who = el('td', 'who');
      who.append(el('strong', '', u.name || u.user_id), el('span', '', u.user_id + (u.created_at ? ', since ' + prettyTime(u.created_at) : '')));
      const kind = el('td');
      kind.appendChild(el('span', 'kind' + (u.role ? ' kind-' + u.role : ''), kindLabel(u.role)));
      if (u.deleted_at) kind.append(document.createTextNode(' '), el('span', 'kind kind-deleted', 'Deleted'));
      const share = u.assigned ? Math.round(100 * u.done / u.assigned) : 0;
      const prog = el('td');
      const bar = el('span', 'bar');
      const fill = el('i');
      fill.style.width = share + '%';
      bar.appendChild(fill);
      prog.append(bar, document.createTextNode(share + '%'));
      tr.append(who, kind, el('td', '', u.practice_done_at ? prettyTime(u.practice_done_at) : 'not yet'),
        el('td', 'num', String(u.assigned)), el('td', 'num', String(u.done)), prog, el('td', 'num', String(u.flagged || 0)),
        el('td', '', u.last_saved_at ? prettyTime(u.last_saved_at) : '-'), el('td', 'num', String(u.minutes || 0)),
        el('td', 'chev', open ? 'Hide filings' : 'Show filings'));
      body.appendChild(tr);
      if (!open) continue;
      const sub = el('tr');
      const cell = el('td', 'filings-cell');
      cell.colSpan = 10;
      const nOpen = u.filings.filter((f) => !f.done_at).length;
      const head = el('div', 'filings-head');
      head.appendChild(el('span', '', u.filings.length + ' filings: ' + (u.filings.length - nOpen) + ' answered, ' + nOpen + ' not yet.'));
      if (u.deleted_at) {
        head.appendChild(el('span', 'deleted-note', 'Deleted ' + prettyTime(u.deleted_at) + '. This account cannot log in; its answers are kept.'));
        const res = el('button', 'btn btn-small', 'Restore account');
        res.type = 'button';
        res.dataset.restore = u.user_id;
        head.appendChild(res);
      } else {
        if (u.role === '') {           // an evaluator: the number of filings can be changed (not below the answered ones)
          const most = u.assigned + (t.free || 0);
          const box = el('span', 'assign-ctl');
          const lab = el('label', '', 'Number of filings');
          const input = document.createElement('input');
          input.type = 'number';
          input.min = String(u.done);
          input.max = String(most);
          input.step = '1';
          input.value = String(u.assigned);
          input.dataset.countFor = u.user_id;
          input.id = 'count-' + u.user_id;
          lab.htmlFor = input.id;
          const go = el('button', 'btn btn-small', 'Change');
          go.type = 'button';
          go.dataset.setCount = u.user_id;
          box.append(lab, input, go, el('span', 'assign-hint', 'from ' + u.done + ' (answered) to ' + most + ' (' + (t.free || 0) + ' free)'));
          head.appendChild(box);
        }
        const del = el('button', 'btn btn-small btn-danger', 'Delete account');
        del.type = 'button';
        del.dataset.delete = u.user_id;
        head.appendChild(del);
      }
      cell.appendChild(head);
      cell.appendChild(passwordTools(u));
      const grid = el('div', 'filing-grid');
      for (const f of u.filings) {
        const meta = MANIFEST.filings[f.filing_id] || {};
        const item = el('div', 'filing-item');
        const a = el('a', '', f.filing_id);
        a.href = meta.pdf || '#';
        a.target = '_blank';
        a.rel = 'noopener';
        a.title = 'Open the income-tax note of ' + f.filing_id;
        const co = el('span', 'co', (meta.company || '') + (meta.period ? ' (' + meta.period.slice(0, 4) + ')' : ''));
        co.title = meta.company || '';
        const st = el('span', 'st ' + (f.flag ? 'st-flag' : (f.done_at ? 'st-done' : 'st-open')),
          (f.done_at ? 'done ' + prettyTime(f.saved_at || f.done_at) : 'not yet') + (f.flag ? ', flagged' : ''));
        item.append(a, co, st);
        grid.appendChild(item);
      }
      cell.appendChild(grid);
      sub.appendChild(cell);
      body.appendChild(sub);
    }
    const allOpen = users.length > 0 && users.every((u) => state.superOpen[u.user_id]);
    $('super-expand').textContent = allOpen ? 'Hide all filing lists' : 'Show all filing lists';
  }

  /* ---------------------------------------------------------------- dialogs, divider, wiring */
  function confirmBox(text, okLabel) {
    return new Promise((resolve) => {
      const dlg = $('dlg-confirm');
      $('confirm-text').textContent = text;
      $('confirm-yes').textContent = okLabel || 'OK';
      const done = (value) => { dlg.close(); $('confirm-yes').onclick = null; $('confirm-no').onclick = null; dlg.oncancel = null; resolve(value); };
      $('confirm-yes').onclick = () => done(true);
      $('confirm-no').onclick = () => done(false);
      dlg.oncancel = (e) => { e.preventDefault(); done(false); };
      dlg.showModal();
    });
  }
  function wireDivider() {
    const ws = $('workspace');
    const divider = $('divider');
    const saved = store.get('split', null);
    if (typeof saved === 'number' && saved >= 25 && saved <= 75) document.documentElement.style.setProperty('--left', saved + '%');
    let dragging = false;
    divider.addEventListener('pointerdown', (e) => { dragging = true; ws.classList.add('is-drag'); divider.classList.add('is-drag'); divider.setPointerCapture(e.pointerId); e.preventDefault(); });
    divider.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const box = ws.getBoundingClientRect();
      const pct = Math.max(25, Math.min(75, 100 * (e.clientX - box.left) / box.width));
      document.documentElement.style.setProperty('--left', pct.toFixed(1) + '%');
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false; ws.classList.remove('is-drag'); divider.classList.remove('is-drag');
      store.set('split', parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left')));
      pdf.relayout();
    };
    divider.addEventListener('pointerup', stop);
    divider.addEventListener('pointercancel', stop);
  }
  function fillInstructions() {
    const tpl = $('tpl-instructions');
    const table = $('tpl-q6-table');
    for (const target of [$('intro-body'), $('dlg-instructions-body')]) {
      target.appendChild(tpl.content.cloneNode(true));
      const slot = target.querySelector('.q6-table');
      if (slot) slot.appendChild(table.content.cloneNode(true));
    }
    document.querySelector('#q6-howto .howto-body').appendChild(table.content.cloneNode(true));
  }
  function wire() {
    $('tab-login').addEventListener('click', () => setAuthTab('login'));
    $('tab-signup').addEventListener('click', () => setAuthTab('signup'));
    $('form-login').addEventListener('submit', onLogin);
    $('form-signup').addEventListener('submit', onSignup);

    $('intro-next').addEventListener('click', openPractice);
    $('intro-logout').addEventListener('click', logout);
    $('btn-back-intro').addEventListener('click', showIntro);
    $('btn-start').addEventListener('click', finishPractice);

    const form = $('answer-form');
    form.addEventListener('input', onFormChange);
    form.addEventListener('change', onFormChange);
    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('click', onPracticeAction);
    $('foreign-add').addEventListener('click', () => {
      $('foreign-rows').appendChild(foreignRow({j: '', y: ''}));
      setCheck('q6.foreign_ns', false);
      onFormChange();
      $('foreign-rows').lastChild.querySelector('input').focus();
    });
    $('foreign-rows').addEventListener('click', (e) => {
      if (!e.target.dataset.remove || state.locked || state.busy) return;
      const box = $('foreign-rows');
      if (box.children.length > 1) e.target.parentNode.remove();
      else box.querySelectorAll('input').forEach((i) => { i.value = ''; });
      onFormChange();
    });
    $('jump').addEventListener('change', () => openFiling(Number($('jump').value)));
    $('btn-prev').addEventListener('click', () => { if (state.index > 0) openFiling(state.index - 1); });
    $('btn-skip').addEventListener('click', () => {
      const next = nextOpenIndex(state.index);
      if (next >= 0) openFiling(next);
      else if (state.index + 1 < state.assigned.length) openFiling(state.index + 1);
      else $('save-status').textContent = 'This is the only filing left without an answer.';
    });
    $('btn-save').addEventListener('click', saveAndNext);
    $('btn-revert').addEventListener('click', () => {
      if (!state.formFid) return;
      store.del(draftKey(state.formFid));
      state.raw = JSON.parse(state.baseline);
      state.ack = null;
      fillForm(state.raw); showProblems(null); renderDerived(); updateChrome();
    });
    $('btn-close-example').addEventListener('click', closePractice);
    $('btn-example').addEventListener('click', () => { if (state.busy) return; if (state.mode === 'practice') closePractice(); else openPractice(); });
    $('btn-instructions').addEventListener('click', () => $('dlg-instructions').showModal());
    $('btn-logout').addEventListener('click', logout);
    $('done-logout').addEventListener('click', logout);
    $('done-review').addEventListener('click', () => { show('app'); openFiling(0); });
    $('done-more').addEventListener('click', requestMore);
    $('pending-chip').addEventListener('click', flushQueue);
    document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
    $('dlg-instructions').addEventListener('click', (e) => { if (e.target === $('dlg-instructions')) $('dlg-instructions').close(); });

    // The note is searched while the evaluator types (shortly after the last key); Enter and the buttons move between matches.
    let liveTimer = null;
    const searchSoon = () => { clearTimeout(liveTimer); liveTimer = setTimeout(() => pdf.findLive($('pdf-q').value), 200); };
    $('pdf-search').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(liveTimer); pdf.find($('pdf-q').value, false); });
    $('pdf-q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); clearTimeout(liveTimer); pdf.find($('pdf-q').value, e.shiftKey); }
    });
    $('pdf-q').addEventListener('input', (e) => {
      if (!$('pdf-q').value.trim()) { clearTimeout(liveTimer); pdf.clearFind(); return; }
      if (!e.isComposing) searchSoon();
    });
    $('pdf-q').addEventListener('compositionend', searchSoon);
    $('pdf-prev').addEventListener('click', () => pdf.find($('pdf-q').value, true));
    $('pdf-next').addEventListener('click', () => pdf.find($('pdf-q').value, false));
    $('pdf-chips').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-q]');
      if (!b) return;
      $('pdf-q').value = b.dataset.q;
      pdf.find(b.dataset.q, false);
    });
    $('pdf-zoom-in').addEventListener('click', pdf.zoomIn);
    $('pdf-zoom-out').addEventListener('click', pdf.zoomOut);
    $('pdf-fit').addEventListener('click', pdf.fitWidth);

    $('super-refresh').addEventListener('click', () => loadOverview());
    $('super-logout').addEventListener('click', logout);
    $('super-expand').addEventListener('click', () => {
      const users = ((state.superData && state.superData.users) || []).filter((u) => u.role !== 'supervisor');
      const allOpen = users.length > 0 && users.every((u) => state.superOpen[u.user_id]);
      state.superOpen = {};
      if (!allOpen) users.forEach((u) => { state.superOpen[u.user_id] = true; });
      renderOverview();
    });
    $('super-table').addEventListener('click', (e) => {
      const del = e.target.closest('[data-delete]');
      if (del) { deleteAccount(del.dataset.delete); return; }
      const res = e.target.closest('[data-restore]');
      if (res) { restoreAccount(res.dataset.restore); return; }
      const pwShow = e.target.closest('[data-pw-show]');
      if (pwShow) { showPassword(pwShow.dataset.pwShow); return; }
      const pwHide = e.target.closest('[data-pw-hide]');
      if (pwHide) { delete state.superPw[pwHide.dataset.pwHide]; renderOverview(); return; }
      const pwSet = e.target.closest('[data-pw-set]');
      if (pwSet) { setPassword(pwSet.dataset.pwSet); return; }
      if (e.target.closest('.pw-tools')) return;
      const setter = e.target.closest('[data-set-count]');
      if (setter) { setCount(setter.dataset.setCount); return; }
      if (e.target.closest('input, label')) return;
      if (e.target.closest('a')) return;
      const tr = e.target.closest('tr.user-row');
      if (!tr) return;
      state.superOpen[tr.dataset.user] = !state.superOpen[tr.dataset.user];
      renderOverview();
    });

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'Enter' && !$('screen-app').hidden && state.mode === 'work') { e.preventDefault(); saveAndNext(); return; }
      if (mod && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F') && !$('screen-app').hidden && !$('pdf-bar').hidden && !$('dlg-instructions').open) {
        e.preventDefault();
        $('pdf-q').focus();
        $('pdf-q').select();
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { timer.pause(); persistDraft(); } else { timer.resume(); flushQueue(); } });
    window.addEventListener('online', flushQueue);
    window.addEventListener('pagehide', persistDraft);
    window.addEventListener('beforeunload', (e) => { persistDraft(); if (state.queue.length) { e.preventDefault(); e.returnValue = ''; } });
    setInterval(flushQueue, 20000);
    wireDivider();
  }

  function boot() {
    fillInstructions();
    buildAmountRows();
    buildPracticeChecks();
    wire();
    setAuthTab('login');
    if (!API_URL) {
      show('auth');
      setAuthBusy(false);
      setAuthStatus('This copy of the website is not connected to its server yet: the address is missing in config.js.', 'bad');
      return;
    }
    const session = store.get('session', null);
    if (session && session.token) resume(session); else { show('auth'); setAuthBusy(false); }
    refreshPing();
  }
  boot();
})();
