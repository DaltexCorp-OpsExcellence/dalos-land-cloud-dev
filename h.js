'use strict';
/* Harvest link form page (h.html). Static, no dependencies.
   Network: ONLY POST harvest-link/form and harvest-link/submit, header content-type only, token in the JSON body.
   Token: read once from #t=, kept in memory, stripped from the address bar. No logging of any kind.
   DOM: createElement / textContent only. */
(() => {
  // Frame guard (Ash): if this page is embedded, render a blank body and make no network calls.
  // Accessing window.top can throw in some cross-origin iframes; treat that as framed too.
  function isFramed() {
    try { return window.top !== window.self; } catch (e) { return true; }
  }
  if (isFramed()) {
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    const blank = function () { if (document.body) document.body.replaceChildren(); };
    if (document.body) blank();
    else document.addEventListener('DOMContentLoaded', blank);
    return;
  }

  // ───────── token: capture first, strip from the address bar ─────────
  // Shape matches the deployed harvest-link edge function (TOKEN_RE / newToken):
  // 32-byte secret as base64url with no padding → exactly 43 chars, [A-Za-z0-9_-].
  const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
  let TOKEN = '';
  function captureToken() {
    const raw = location.hash || '';
    if (!raw) return false;
    let t = '';
    try { t = new URLSearchParams(raw.slice(1)).get('t') || ''; } catch (e) { t = ''; }
    history.replaceState(null, '', location.pathname);
    TOKEN = TOKEN_RE.test(t) ? t : '';
    return true;
  }
  captureToken();

  // ───────── constants ─────────
  const BASE = 'https://sfyjvgjwvtwkrnqrvqyc.supabase.co/functions/v1/harvest-link';
  const FIELDS = ['to_packhouse_t', 'field_sorting_t', 'local_sales_t', 'waste_t'];
  const FIELD_AR = { to_packhouse_t: 'وارد محطة', field_sorting_t: 'فرز', local_sales_t: 'محلي', waste_t: 'هالك' };
  const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const STATUS_AR = {
    pending: 'مستني تأكيد', confirmed: 'اتسجل', cancelled: 'اتلغى', canceled: 'اتلغى',
    expired: 'انتهى', stale: 'الأرقام اتغيرت',
  };
  const RATE_AR = {
    rate_limited: 'محاولات كتير. استنى شوية وجرّب تاني.',
    too_many_pending: 'عندك تسجيلات لسه مستنية تأكيد. أكّد أو ألغِ في الشات الأول.',
    submit_cap: 'وصلت للحد الأقصى للإرسال من اللينك ده. ارجع للشات.',
    cap_reached: 'وصلت للحد الأقصى للإرسال من اللينك ده. ارجع للشات.',
  };
  const ERR_AR = {
    missing_value: 'اكتب كل الأرقام، أو استخدم مسح',
    missing_block: 'لازم تختار الحوشة قبل الإرسال',
    missing_plot: 'لازم تختار الحوشة قبل الإرسال',
    invalid_block: 'لازم تختار الحوشة قبل الإرسال',
    zero_row: 'مينفعش كل الأرقام تبقى صفر',
    over_limit: 'الرقم أكبر من المسموح',
    over_field_limit: 'الرقم أكبر من المسموح',
    over_plot_limit: 'إجمالي الحوشة أكبر من المسموح',
    negative: 'الرقم لازم يكون صفر أو أكتر',
    bad_number: 'رقم مش صحيح',
    invalid_number: 'رقم مش صحيح',
    too_many_decimals: 'رقمين بعد العلامة بالكتير',
    day_out_of_window: 'التاريخ ده برّه الفترة المسموحة',
    out_of_scope: 'الحوشة دي مش من مزارعك',
    duplicate_block: 'الحوشة دي متكررة في نفس الإرسال',
    replace_too_old: 'الإدخال ده أقدم من 7 أيام ومينفعش يتعدل من اللينك، كلّم المسؤول.',
    nothing_to_clear: 'مفيش تسجيل يتمسح',
    clear_disabled: 'المسح مش متاح دلوقتي',
    clear_not_confirmed: 'لازم تأكّد المسح الأول',
    too_many_rows: 'حوش كتير في إرسال واحد',
    too_many_clears: 'مسح كتير في إرسال واحد',
  };
  const LOCK_NOTE = 'الإدخال ده أقدم من 7 أيام ومينفعش يتعدل من اللينك، كلّم المسؤول.';
  const NET_TITLE = 'حصلت مشكلة في الاتصال';
  const NET_TEXT = 'حاول تاني بعد شوية.';

  const APP = document.getElementById('app');

  // ───────── DOM helpers (no HTML strings) ─────────
  function add(e, k) {
    if (k == null || k === false) return;
    if (Array.isArray(k)) { k.forEach((x) => add(e, x)); return; }
    e.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
  }
  function h(tag, cls, ...kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    kids.forEach((k) => add(e, k));
    return e;
  }
  function attr(e, o) {
    Object.keys(o).forEach((k) => {
      const v = o[k];
      if (v == null || v === false) return;
      e.setAttribute(k, v === true ? '' : String(v));
    });
    return e;
  }
  function clearEl(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  const num = (v) => h('span', 'num', v);
  const code = (v) => h('span', 'code', v);
  const dot = () => h('span', 'dot', '·');
  function button(cls, text, onClick) {
    const b = attr(h('button', cls, text), { type: 'button' });
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // ───────── numbers ─────────
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const r2 = (n) => Math.round(n * 100) / 100;
  const fmt = (n) => (isNum(n) ? String(r2(n)) : '');
  function normDigits(s) {
    return String(s == null ? '' : s)
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6F0))
      .replace(/[٫,]/g, '.')
      .replace(/[\s٬]/g, '');
  }
  function parseQty(s) {
    const t = normDigits(s);
    if (t === '') return { blank: true };
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return { bad: 'nan' };
    if ((t.split('.')[1] || '').length > 2) return { bad: 'dec' };
    const n = Number(t);
    if (!isNum(n) || n < 0) return { bad: 'nan' };
    return { n };
  }
  const sumFields = (o) => FIELDS.reduce((a, f) => a + (o && isNum(o[f]) ? o[f] : 0), 0);
  const clampPct = (p) => Math.max(0, Math.min(100, p));

  // ───────── dates ─────────
  function parseDay(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof d === 'string' ? d : '');
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function dayNodes(d, weekday, year) {
    const p = parseDay(d);
    if (!p || p.m < 1 || p.m > 12) return [typeof d === 'string' ? d : ''];
    const out = [];
    if (weekday) out.push(WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()] + ' ');
    out.push(num(String(p.d)), ' ' + MONTHS[p.m - 1]);
    if (year) out.push(' ', num(String(p.y)));
    return out;
  }
  function cairoParts(date, opts) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: 'Africa/Cairo' }, opts)).formatToParts(date);
      const o = {};
      parts.forEach((p) => { o[p.type] = p.value; });
      return o;
    } catch (e) { return null; }
  }
  function cairoToday() {
    const o = cairoParts(new Date(), { year: 'numeric', month: '2-digit', day: '2-digit' });
    return o ? o.year + '-' + o.month + '-' + o.day : '';
  }
  function cairoHM(iso) {
    const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (!isNum(t)) return '';
    const o = cairoParts(new Date(t), { hour: '2-digit', minute: '2-digit', hour12: false });
    return o && o.hour && o.minute ? (o.hour === '24' ? '00' : o.hour) + ':' + o.minute : '';
  }

  // ───────── API (the only network code) ─────────
  async function api(path, body) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
    try {
      const r = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        signal: ctrl ? ctrl.signal : undefined,
      });
      let data = null;
      try { data = await r.json(); } catch (e) { data = null; }
      return { status: r.status, data: data && typeof data === 'object' && !Array.isArray(data) ? data : {} };
    } catch (e) {
      return { status: 0, data: {} };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const errCode = (r) => (r && r.data && typeof r.data.error === 'string' ? r.data.error : '');

  // ───────── state ─────────
  const S = {
    form: null, farms: [], farmId: null, lockedFarm: null, cards: [], seq: 0,
    attempted: false, submitting: false, banner: null, submissions: [], sent: null,
    els: null,
  };
  let loadSeq = 0;

  const curFarm = () => S.farms.find((f) => f.id === S.farmId) || null;
  const plotOf = (id) => {
    const f = curFarm();
    return f && id ? f.plots.find((p) => p.block_id === id) || null : null;
  };
  const plotLabel = (p) => (p && typeof p.label === 'string' && p.label ? p.label : '—');
  const limits = () => (S.form && S.form.limits && typeof S.form.limits === 'object' ? S.form.limits : {});
  const limPos = (k, def) => { const v = limits()[k]; return isNum(v) && v > 0 ? v : def; };
  const maxRows = () => limPos('max_rows', 20);
  const maxClears = () => limPos('max_clears', 3);
  const wastePct = () => { const v = limits().waste_warn_pct; return isNum(v) && v >= 0 ? v : 15; };

  function isLockedPlot(p) {
    const ex = p && p.existing;
    if (!ex) return false;
    if (ex.replace_allowed === false) return true;
    if (ex.replace_allowed === undefined && S.form && typeof S.form.replace_min_day === 'string' &&
        typeof S.form.day === 'string' && S.form.day < S.form.replace_min_day) return true;
    return false;
  }
  const cardLocked = (c) => { const p = plotOf(c.blockId); return !!p && !!p.existing && (isLockedPlot(p) || c.forceLocked); };
  const seenVersion = (p) => (p && p.existing && typeof p.existing.seen_version === 'string' && p.existing.seen_version ? p.existing.seen_version : null);
  const canClearPlot = (p) => limits().clear_enabled === true && !!p && !!p.existing && !!seenVersion(p) && !isLockedPlot(p);
  const unlockedCards = () => S.cards.filter((c) => !cardLocked(c));
  const isEmptyCard = (c) => !c.blockId && !c.clear && FIELDS.every((f) => normDigits(c.vals[f]) === '');
  // An auto-added existing card whose four numbers still match the server is left out of
  // /submit and the footer (✏️ replaces only the edited entry; the others stay as they are).
  function sameAsExisting(c) {
    if (c.clear || !c.blockId) return false;
    const p = plotOf(c.blockId);
    if (!p || !p.existing) return false;
    return FIELDS.every((f) => {
      const q = parseQty(c.vals[f]);
      return !q.blank && !q.bad && isNum(q.n) && isNum(p.existing[f]) && r2(p.existing[f]) === r2(q.n);
    });
  }
  const sendable = () => unlockedCards().filter((c) => !isEmptyCard(c) && !sameAsExisting(c));
  function unusedPlots(except) {
    const f = curFarm();
    if (!f) return [];
    const used = new Set(S.cards.filter((c) => c !== except && c.blockId).map((c) => c.blockId));
    return f.plots.filter((p) => !used.has(p.block_id));
  }

  // ───────── cards ─────────
  function newCard(blockId) {
    const vals = {};
    FIELDS.forEach((f) => { vals[f] = ''; });
    return { id: ++S.seq, blockId: blockId || null, vals, clear: false, edited: false, touched: {}, stale: false, forceLocked: false, srv: null, el: null };
  }
  function prefill(c, ex) { FIELDS.forEach((f) => { c.vals[f] = ex && isNum(ex[f]) ? fmt(ex[f]) : ''; }); }

  function initCards() {
    S.cards = [];
    S.attempted = false;
    const farm = curFarm();
    if (!farm) return;
    farm.plots.forEach((p) => {
      if (p.existing) { const c = newCard(p.block_id); prefill(c, p.existing); S.cards.push(c); }
    });
    if (unusedPlots(null).length) S.cards.push(newCard(null));
  }

  function relinkCards(staleIds) {
    const farm = curFarm();
    if (!farm) { S.cards = []; return; }
    const ids = new Set(farm.plots.map((p) => p.block_id));
    S.cards = S.cards.filter((c) => !c.blockId || ids.has(c.blockId));
    S.cards.forEach((c) => {
      c.srv = null;
      c.forceLocked = false;
      c.stale = !!c.blockId && staleIds.indexOf(c.blockId) >= 0;
      if (c.stale) c.clear = false;
      if (c.clear && !canClearPlot(plotOf(c.blockId))) c.clear = false;
    });
    farm.plots.forEach((p) => {
      if (p.existing && !S.cards.some((c) => c.blockId === p.block_id)) {
        const c = newCard(p.block_id);
        prefill(c, p.existing);
        c.stale = staleIds.indexOf(p.block_id) >= 0;
        S.cards.push(c);
      }
    });
    if (!S.cards.length && unusedPlots(null).length) S.cards.push(newCard(null));
  }

  function isDirty() { return S.cards.some((c) => c.edited || c.clear); }

  // Card evaluation: client checks only; the server has the final say.
  function evalCard(c) {
    const p = plotOf(c.blockId);
    const r = { empty: false, ok: true, plotErr: false, fieldErr: {}, notes: [], warn: null, total: 0, nums: null, changed: {} };
    if (c.clear) return r;
    if (isEmptyCard(c)) { r.empty = true; r.ok = false; return r; }
    const show = (f) => S.attempted || !!c.touched[f];
    const canClr = canClearPlot(p);
    if (!c.blockId) { r.plotErr = true; r.ok = false; }
    const nums = {};
    let blanks = 0, bads = 0, shownBlank = false;
    const maxF = limits().max_t_per_field;
    FIELDS.forEach((f) => {
      const q = parseQty(c.vals[f]);
      if (q.blank) {
        blanks++;
        if (show(f)) { r.fieldErr[f] = true; shownBlank = true; }
      } else if (q.bad) {
        bads++;
        r.fieldErr[f] = true;
        r.notes.push(FIELD_AR[f] + ': ' + (q.bad === 'dec' ? 'رقمين بعد العلامة بالكتير' : 'رقم مش صحيح'));
      } else {
        nums[f] = q.n;
        r.total += q.n;
        if (isNum(maxF) && q.n > maxF) {
          bads++;
          r.fieldErr[f] = true;
          r.notes.push(FIELD_AR[f] + ': أكبر من الحد (' + fmt(maxF) + ' ط)');
        }
        if (p && p.existing) r.changed[f] = !isNum(p.existing[f]) || r2(p.existing[f]) !== r2(q.n);
      }
    });
    if (blanks) r.ok = false;
    if (shownBlank) r.notes.unshift('اكتب كل الأرقام' + (canClr ? '، أو استخدم مسح' : ''));
    if (bads) r.ok = false;
    if (!blanks && !bads) {
      r.nums = nums;
      if (r.total === 0) {
        r.ok = false;
        if (S.attempted || FIELDS.every((f) => c.touched[f])) {
          r.notes.push('مينفعش كل الأرقام تبقى صفر' + (canClr ? '. لو عايز تشيل تسجيل اليوم استخدم مسح' : ''));
        }
      }
      const maxP = limits().max_t_per_plot_day;
      if (isNum(maxP) && r.total > maxP) { r.ok = false; r.notes.push('إجمالي الحوشة أكبر من الحد (' + fmt(maxP) + ' ط)'); }
      if (r.total > 0 && (nums.waste_t / r.total) * 100 > wastePct()) r.warn = (nums.waste_t / r.total) * 100;
    }
    return r;
  }

  // ───────── screens ─────────
  function header(meta) {
    const brand = h('div', 'brand-row',
      h('div', 'titles', attr(h('div', 'logo', 'DalOS'), { dir: 'ltr' }), h('h1', null, 'تسجيل الحصاد')));
    if (meta && S.form && typeof S.form.supervisor_name === 'string' && S.form.supervisor_name) {
      brand.appendChild(h('div', 'who', S.form.supervisor_name));
    }
    return h('header', 'form-header', brand, meta || null);
  }
  function screen(parts) {
    S.els = null;
    clearEl(APP);
    add(APP, parts);
  }
  function showLoading() {
    screen([header(null), h('main', 'center-body mid',
      h('div', 'loading', attr(h('div', 'spinner'), { 'aria-hidden': 'true' }), h('p', null, 'جاري التحميل…')))]);
  }
  function statusScreen(icon, iconCls, title, body, action) {
    screen([header(null), h('main', 'center-body mid',
      h('div', 'status-hero', h('div', 'status-icon ' + iconCls, icon), h('h1', null, title), body ? h('p', null, body) : null),
      action || null)]);
  }
  function showLinkGone() {
    S.form = null;
    statusScreen('⏱', 'dead', 'الرابط انتهى، ابعت سجل تاني',
      ['اللينك صالح ', num('3'), ' ساعات وبس، وليك لوحدك. ارجع للشات واكتب ', h('strong', 'kw', 'سجل'), ' وهيوصلك لينك جديد.']);
  }
  function showPaused(retry) {
    statusScreen('⏸', 'dead', 'الخدمة متوقفة مؤقتاً', 'جرّب تاني بعد شوية أو كلّم المسؤول.',
      button('btn ghost', 'حاول تاني', retry));
  }
  function showRate(c, retry) {
    const b = button('btn ghost', 'حاول تاني', retry);
    b.disabled = true;
    setTimeout(() => { b.disabled = false; }, 15000);
    statusScreen('!', 'dead', RATE_AR[c] || RATE_AR.rate_limited, 'استنى شوية وبعدين جرّب تاني.', b);
  }
  function showNetErr(retry) {
    statusScreen('!', 'err', NET_TITLE, NET_TEXT, button('btn ghost', 'حاول تاني', retry));
  }
  function failForm(r, retry) {
    if (r.status === 410) return showLinkGone();
    if (r.status === 423) return showPaused(retry);
    if (r.status === 429) return showRate(errCode(r), retry);
    return showNetErr(retry);   // 500 / 503 / 413 / 404 / 405 / network / timeout
  }

  // ───────── /form ─────────
  function normFarms(d) {
    const farms = Array.isArray(d.farms) ? d.farms : [];
    return farms.filter((f) => f && typeof f === 'object' && typeof f.id === 'string').map((f) => ({
      id: f.id,
      name: typeof f.name === 'string' ? f.name : '',
      plots: (Array.isArray(f.plots) ? f.plots : []).filter((p) => p && typeof p === 'object' && typeof p.block_id === 'string')
        .map((p) => ({
          block_id: p.block_id,
          label: typeof p.label === 'string' ? p.label : '',
          progress: p.progress && typeof p.progress === 'object' ? p.progress : null,
          existing: p.existing && typeof p.existing === 'object' ? p.existing : null,
        })),
    }));
  }
  function acceptForm(d, keep, staleIds) {
    S.form = d;
    S.sent = null;
    S.submitting = false;
    S.farms = normFarms(d);
    S.submissions = Array.isArray(d.submissions) ? d.submissions.filter((x) => x && typeof x === 'object') : [];
    const lf = d.farm && typeof d.farm === 'object' && typeof d.farm.farm_id === 'string' ? d.farm : null;
    S.lockedFarm = lf ? { id: lf.farm_id, name: typeof lf.name === 'string' ? lf.name : '' } : null;
    if (S.lockedFarm) {
      S.farmId = S.lockedFarm.id;
    } else if (!S.farms.some((f) => f.id === S.farmId)) {
      const firstWithPlots = S.farms.find((f) => f.plots.length);
      S.farmId = firstWithPlots ? firstWithPlots.id : (S.farms[0] ? S.farms[0].id : null);
    }
    if (keep) {
      relinkCards(staleIds);
      S.banner = { kind: 'amber', title: 'الأرقام اتغيرت', text: 'في تسجيل اتعدل للحوشة دي من وقت ما فتحت. راجع الأرقام وابعت تاني.' };
    } else {
      S.banner = null;
      initCards();
    }
    renderForm();
  }
  async function openForm(day) {
    if (!TOKEN_RE.test(TOKEN)) { showLinkGone(); return; }
    const my = ++loadSeq;
    showLoading();
    const body = { token: TOKEN };
    if (day) body.day = day;
    const r = await api('/form', body);
    if (my !== loadSeq) return;
    if (r.status !== 200) { failForm(r, () => openForm(day)); return; }
    acceptForm(r.data, false, []);
  }

  // ───────── form rendering ─────────
  function renderForm() {
    if (!S.form) return;
    if (!S.farms.length || S.farms.every((f) => !f.plots.length)) {
      statusScreen('!', 'dead', 'مفيش حوش متاحة ليك، كلّم المسؤول.', '', null);
      return;
    }
    const farmSel = attr(h('select'), { id: 'farm' });
    if (S.lockedFarm) {
      const o = attr(h('option', null, S.lockedFarm.name || '—'), { value: S.lockedFarm.id });
      o.selected = true;
      farmSel.appendChild(o);
      farmSel.disabled = true;
      attr(farmSel, { 'aria-disabled': 'true' });
    } else {
      S.farms.forEach((f) => {
        const o = attr(h('option', null, f.name || '—'), { value: f.id });
        if (f.id === S.farmId) o.selected = true;
        farmSel.appendChild(o);
      });
      farmSel.addEventListener('change', () => {
        const v = farmSel.value;
        if (v === S.farmId) return;
        const go = () => { S.farmId = v; S.banner = null; initCards(); renderForm(); };
        if (isDirty()) {
          dialog({ kicker: 'تغيير المزرعة', title: 'هتغيّر المزرعة؟', body: 'الأرقام اللي كتبتها هتتمسح.', ok: 'غيّر' },
            go, () => { farmSel.value = S.farmId; });
        } else go();
      });
    }
    const day = typeof S.form.day === 'string' ? S.form.day : '';
    const dayIn = attr(h('input'), {
      id: 'day', type: 'date',
      min: typeof S.form.day_min === 'string' ? S.form.day_min : null,
      max: typeof S.form.day_max === 'string' ? S.form.day_max : null,
    });
    dayIn.value = day;
    dayIn.addEventListener('change', () => {
      const v = dayIn.value;
      const mn = S.form.day_min, mx = S.form.day_max;
      if (!parseDay(v) || v === day || (typeof mn === 'string' && v < mn) || (typeof mx === 'string' && v > mx)) {
        dayIn.value = day;
        return;
      }
      const go = () => openForm(v);
      if (isDirty()) {
        dialog({ kicker: 'تغيير التاريخ', title: 'هتغيّر التاريخ؟', body: 'الأرقام اللي كتبتها هتتمسح.', ok: 'غيّر' },
          go, () => { dayIn.value = day; });
      } else go();
    });
    const meta = h('div', 'meta-row',
      h('div', 'field-mini', attr(h('label', null, 'المزرعة'), { for: 'farm' }), farmSel),
      h('div', 'field-mini', attr(h('label', null, 'التاريخ'), { for: 'day' }), dayIn));

    const bannerBox = h('div', 'banners');
    const cardsBox = h('div', 'cards');
    const farm = curFarm();
    if (farm && !farm.plots.length) {
      cardsBox.appendChild(h('div', 'note quiet',
        S.lockedFarm ? 'مفيش حوش في المزرعة دي، كلّم المسؤول.' : 'مفيش حوش في المزرعة دي، اختار مزرعة تانية.'));
    }
    S.cards.forEach((c, i) => cardsBox.appendChild(buildCard(c, i + 1)));
    const addBtn = button('btn-add', '+ حوشة تانية', () => {
      if (addBtn.disabled || S.submitting) return;
      const c = newCard(null);
      S.cards.push(c);
      renderForm();
      if (c.el && c.el.sel) c.el.sel.focus();
    });
    const main = h('main', 'form-main', bannerBox, cardsBox, addBtn);
    const foot = h('div', 'sticky');
    screen([header(meta), main, foot]);
    S.els = { bannerBox, addBtn, foot };
    refresh();
  }

  function buildProgress(pr, label, picked) {
    if (!pr) return null;
    const b = pr.budget_t;
    const k = isNum(picked) ? picked : pr.picked_t;
    let pct = !isNum(picked) && isNum(pr.pct) ? pr.pct : null;
    if (pct == null && isNum(b) && b > 0 && isNum(k)) pct = (k / b) * 100;
    const line = ['المخطط ', num(isNum(b) ? fmt(b) : '—'), ' ط · ' + label + ' ', num(isNum(k) ? fmt(k) : '—'), ' ط'];
    if (pct != null) line.push(' (', num(Math.round(pct) + '%'), ')');
    let bar = null;
    if (pct != null) {
      const fill = h('i');
      fill.style.setProperty('--w', clampPct(pct) + '%');
      bar = h('div', 'bar', fill);
    }
    return { line, bar };
  }

  function buildCard(c, idx) {
    const p = plotOf(c.blockId);
    const pre = 'c' + c.id;
    const sec = h('section', 'card');
    const removeBtn = attr(button('btn-x', '×', () => {
      if (S.submitting) return;
      S.cards = S.cards.filter((x) => x !== c);
      if (!S.cards.length && unusedPlots(null).length) S.cards.push(newCard(null));
      renderForm();
    }), { 'aria-label': 'حذف' });

    if (cardLocked(c)) {
      sec.className = 'card locked';
      add(sec, [
        h('div', 'badge-row', h('span', 'pill lock', 'مقفول · أقدم من ', num('7'), ' أيام')),
        h('div', 'card-head', h('h2', null, 'حوشة ' + idx)),
        removeBtn,
        h('div', 'plot-ro', h('span', 'code', plotLabel(p))),
      ]);
      const grid = h('div', 'qty-grid');
      FIELDS.forEach((f) => {
        const inp = attr(h('input'), { type: 'text', dir: 'ltr', readonly: true, tabindex: '-1', 'aria-label': FIELD_AR[f] });
        inp.value = isNum(p.existing[f]) ? fmt(p.existing[f]) : '—';
        grid.appendChild(h('div', 'qty', h('label', null, FIELD_AR[f]), h('div', 'qty-box ro', inp, h('span', 'unit', 'ط'))));
      });
      add(sec, [grid, h('div', 'note quiet', LOCK_NOTE)]);
      c.el = null;
      return sec;
    }

    const badges = h('div', 'badge-row');
    if (p && p.existing) badges.appendChild(h('span', 'pill warn js-replace-pill', 'مسجل قبل كده · هيتم الاستبدال'));
    if (c.stale) badges.appendChild(h('span', 'pill err', 'الأرقام اتغيرت'));
    if (badges.childNodes.length) sec.appendChild(badges);
    add(sec, [h('div', 'card-head', h('h2', null, attr(h('label', null, 'حوشة ' + idx), { for: pre + '-p' }))), removeBtn]);

    const sel = attr(h('select', 'plot'), { id: pre + '-p' });
    sel.appendChild(attr(h('option', null, 'اختار الحوشة'), { value: '' }));
    unusedPlots(c).forEach((pl) => {
      const o = attr(h('option', null, plotLabel(pl)), { value: pl.block_id });
      if (pl.block_id === c.blockId) o.selected = true;
      sel.appendChild(o);
    });
    if (!c.blockId) sel.value = '';
    sel.addEventListener('change', () => {
      const v = sel.value || null;
      c.blockId = v;
      c.clear = false;
      c.stale = false;
      c.srv = null;
      c.edited = true;
      c.forceLocked = false;
      const np = plotOf(v);
      if (np && np.existing && FIELDS.every((f) => normDigits(c.vals[f]) === '')) prefill(c, np.existing);
      renderForm();
    });
    sec.appendChild(sel);

    const pg = p ? buildProgress(p.progress, 'المسجل', null) : null;
    if (pg) sec.appendChild(h('div', 'progress', h('div', 'progress-line', pg.line), pg.bar));

    const grid = h('div', 'qty-grid');
    const boxes = {}, inputs = {};
    FIELDS.forEach((f) => {
      const id = pre + '-' + f;
      const inp = attr(h('input'), { id, type: 'text', inputmode: 'decimal', dir: 'ltr', autocomplete: 'off', maxlength: '12', enterkeyhint: 'next' });
      inp.value = c.vals[f];
      inp.addEventListener('input', () => { c.vals[f] = inp.value; c.edited = true; c.srv = null; refresh(); });
      inp.addEventListener('blur', () => {
        const q = parseQty(inp.value);
        if (!q.blank && !q.bad) { inp.value = normDigits(inp.value); c.vals[f] = inp.value; }
        c.touched[f] = true;
        refresh();
      });
      const box = h('div', 'qty-box', inp, h('span', 'unit', 'ط'));
      boxes[f] = box;
      inputs[f] = inp;
      const q = h('div', 'qty', attr(h('label', null, FIELD_AR[f]), { for: id }), box);
      if (p && p.existing) q.appendChild(h('div', 'was', 'كان: ', num(isNum(p.existing[f]) ? fmt(p.existing[f]) : '—')));
      grid.appendChild(q);
    });
    sec.appendChild(grid);
    const notes = h('div', 'notes');
    sec.appendChild(notes);

    if (canClearPlot(p)) {
      const used = S.cards.filter((x) => x.clear && x !== c).length;
      if (c.clear) {
        sec.appendChild(button('btn-clear undo', 'تراجع عن المسح', () => { c.clear = false; renderForm(); }));
      } else if (used < maxClears()) {
        sec.appendChild(button('btn-clear', 'مسح يوم الحوشة', () => {
          if (S.submitting) return;
          dialog({
            kicker: 'تأكيد تاني', title: 'مسح يوم الحوشة', danger: true, ok: 'امسح',
            body: ['متأكد إنك عايز تمسح تسجيل', attr(h('span', 'code plot-name', plotLabel(p)), { dir: 'ltr' }), ['ليوم ', dayNodes(S.form.day, false, false), '؟']],
          }, () => { c.clear = true; c.edited = true; c.srv = null; c.stale = false; renderForm(); });
        }));
      }
    }
    c.el = { sec, sel, boxes, inputs, notes };
    return sec;
  }

  function updateCardView(c) {
    if (!c.el || cardLocked(c)) return;
    const p = plotOf(c.blockId);
    const r = evalCard(c);
    const srv = c.srv;
    const visibleErr = !r.empty && (r.notes.length > 0 || (S.attempted && !r.ok) || !!srv);
    let cls = 'card';
    if (p && p.existing) cls += ' replace';
    if (c.clear) cls += ' is-clear';
    if (c.stale) cls += ' stale';
    if (visibleErr) cls += ' error';
    else if (r.warn != null) cls += ' warn';
    c.el.sec.className = cls;
    c.el.sel.classList.toggle('bad', (S.attempted && r.plotErr) || !!(srv && srv.plot));
    FIELDS.forEach((f) => {
      const b = c.el.boxes[f];
      b.className = 'qty-box' + (r.fieldErr[f] || (srv && srv.fields[f]) ? ' bad' : '') + (!c.clear && r.changed[f] ? ' changed' : '');
      c.el.inputs[f].disabled = c.clear || S.submitting;
    });
    c.el.sel.disabled = S.submitting;
    const pill = c.el.sec.querySelector('.js-replace-pill');
    if (pill && p && p.existing && !c.clear) {
      const keep = sameAsExisting(c);
      pill.className = (keep ? 'pill ok' : 'pill warn') + ' js-replace-pill';
      clearEl(pill);
      pill.appendChild(document.createTextNode(keep ? 'مسجل قبل كده' : 'مسجل قبل كده · هيتم الاستبدال'));
    }
    const n = c.el.notes;
    clearEl(n);
    if (c.clear) {
      n.appendChild(h('div', 'note red', 'هيتمسح تسجيل الحوشة دي ليوم ', dayNodes(S.form.day, false, false), ' بعد ما تأكّد في الشات.'));
      return;
    }
    if (S.attempted && r.plotErr) n.appendChild(h('div', 'note red', 'لازم تختار الحوشة قبل الإرسال.'));
    r.notes.forEach((t) => n.appendChild(h('div', 'note red', t)));
    if (srv) srv.notes.forEach((x) => n.appendChild(h('div', 'note red', x.msg, x.code ? h('span', 'code', x.code) : null)));
    if (r.warn != null) {
      n.appendChild(h('div', 'note amber', 'هالك أعلى من ' + fmt(wastePct()) + '٪ (', num(Math.round(r.warn) + '%'), ' من إجمالي اليوم).'));
    }
    if (sameAsExisting(c) && !c.stale) {
      n.appendChild(h('div', 'note quiet', 'نفس الأرقام المسجلة، مش هتتبعت. غيّر رقم عشان تستبدل.'));
    }
  }

  function renderBanners() {
    const box = S.els.bannerBox;
    clearEl(box);
    const b = S.banner;
    if (b) {
      const body = h('div', 'body', h('strong', null, b.title));
      if (b.text) body.appendChild(h('p', null, b.text));
      if (b.items) body.appendChild(h('ul', null, b.items.map((x) => h('li', null, x.msg, x.code ? h('span', 'code small', x.code) : null))));
      if (b.retry) body.appendChild(button('btn-retry', 'حاول تاني', () => { onSend(); }));
      box.appendChild(attr(h('div', 'banner ' + b.kind, h('div', 'ico', '!'), body), { role: b.kind === 'red' ? 'alert' : 'status' }));
    }
    const repl = sendable().filter((c) => { const p = plotOf(c.blockId); return p && p.existing && !c.clear; });
    if (repl.length) {
      const today = cairoToday();
      const isToday = S.form.day === today;
      const labels = [];
      repl.forEach((c, i) => { if (i) labels.push('، '); labels.push(code(plotLabel(plotOf(c.blockId)))); });
      box.appendChild(h('div', 'replace-banner', h('div', 'ico', '!'), h('div', 'body',
        h('strong', null, isToday ? 'هيتم استبدال تسجيل النهاردة' : ['هيتم استبدال تسجيل يوم ', dayNodes(S.form.day, false, false)]),
        h('p', null, 'حوشة ', labels, ' عندها أرقام متسجلة ' + (isToday ? 'اليوم' : 'اليوم ده') + '. لو أكّدت، الأرقام الجديدة هتحل محل القديمة.'))));
    }
  }

  function renderFooter() {
    const ft = S.els.foot;
    clearEl(ft);
    const send = sendable();
    const evals = send.map((c) => ({ c, r: evalCard(c) }));
    const total = evals.reduce((a, x) => a + (x.c.clear ? 0 : x.r.total), 0);
    const repl = evals.filter((x) => { const p = plotOf(x.c.blockId); return p && p.existing; });
    ft.className = 'sticky' + (repl.length ? ' replace-foot' : '');
    if (repl.length) {
      const rows = h('div', 'rows');
      repl.forEach(({ c, r }) => {
        const p = plotOf(c.blockId);
        const row = h('div', 'row', 'حوشة ', code(plotLabel(p)), ' — ');
        if (c.clear) {
          row.appendChild(h('span', 'gone', 'هيتمسح'));
        } else if (r.nums) {
          const ch = FIELDS.filter((f) => r.changed[f]);
          if (!ch.length) row.appendChild(document.createTextNode('نفس الأرقام'));
          ch.forEach((f, i) => {
            if (i) row.appendChild(document.createTextNode(' · '));
            add(row, [FIELD_AR[f] + ' كان ', h('span', 'qty-unit', num(isNum(p.existing[f]) ? fmt(p.existing[f]) : '—'), ' ط'), '، هيبقى ', h('span', 'qty-unit', num(fmt(r.nums[f])), ' ط')]);
          });
        } else {
          row.appendChild(document.createTextNode('الأرقام مش كاملة'));
        }
        rows.appendChild(row);
      });
      ft.appendChild(h('div', 'sticky-warn', 'هيتم استبدال تسجيل موجود', rows));
    }
    const ready = send.length > 0 && evals.every((x) => x.c.clear || x.r.ok) && !S.submitting;
    const btn = button('btn pri' + (ready ? '' : ' is-disabled'),
      S.submitting ? 'جاري الإرسال…' : ['إرسال ', dot(), ' ', num(String(send.length)), ' حوشة ', dot(), ' ', num(fmt(total)), ' ط'],
      onSend);
    attr(btn, { 'aria-disabled': ready ? 'false' : 'true' });
    if (S.submitting) btn.disabled = true;
    ft.appendChild(btn);
  }

  function refresh() {
    if (!S.els) return;
    S.cards.forEach(updateCardView);
    renderBanners();
    renderFooter();
    const a = S.els.addBtn;
    a.disabled = S.submitting || unlockedCards().length >= maxRows() || unusedPlots(null).length === 0;
  }

  function scrollToFirstError() {
    const t = APP.querySelector('.banner.red, .card.error');
    if (t && t.scrollIntoView) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ───────── dialog ─────────
  function dialog(o, onOk, onBack) {
    const prev = document.activeElement;
    const back = button('btn back', o.back || 'رجوع');
    const ok = button('btn ' + (o.danger ? 'danger' : 'go'), o.ok);
    const box = h('div', 'dialog',
      o.kicker ? h('div', 'kicker' + (o.danger ? '' : ' info'), o.kicker) : null,
      attr(h('h3', null, o.title), { id: 'dlg-title' }),
      o.body ? h('p', null, o.body) : null,
      h('div', 'dialog-actions', back, ok));
    const ov = attr(h('div', 'overlay', box), { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title' });
    let done = false;
    function close() {
      if (done) return false;
      done = true;
      ov.remove();
      document.removeEventListener('keydown', onKey);
      if (prev && prev.focus && document.contains(prev)) { try { prev.focus(); } catch (e) { /* ignore */ } }
      return true;
    }
    function cancel() { if (close() && onBack) onBack(); }
    function onKey(e) { if (e.key === 'Escape') cancel(); }
    back.addEventListener('click', cancel);
    ok.addEventListener('click', () => { if (close()) onOk(); });
    ov.addEventListener('click', (e) => { if (e.target === ov) cancel(); });
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey);
    back.focus();
  }

  // ───────── /submit ─────────
  function applyErrors(errors) {
    S.cards.forEach((c) => { c.srv = null; });
    const formErrs = [];
    (Array.isArray(errors) ? errors : []).forEach((e) => {
      if (!e || typeof e !== 'object') return;
      const cd = typeof e.code === 'string' ? e.code : '';
      const known = Object.prototype.hasOwnProperty.call(ERR_AR, cd);
      const c = typeof e.block_id === 'string' ? S.cards.find((x) => x.blockId === e.block_id) : null;
      if (!c) {
        formErrs.push({ msg: known ? ERR_AR[cd] : 'في مشكلة في الإرسال، راجع الأرقام', code: known ? null : cd.slice(0, 40) });
        return;
      }
      c.srv = c.srv || { fields: {}, plot: false, notes: [] };
      if (FIELDS.indexOf(e.field) >= 0) c.srv.fields[e.field] = true;
      else if (e.field === 'block_id') c.srv.plot = true;
      const msg = known ? ERR_AR[cd] : 'في مشكلة في الحوشة دي، راجع الأرقام';
      if (!c.srv.notes.some((x) => x.msg === msg)) c.srv.notes.push({ msg, code: known ? null : cd.slice(0, 40) });
      if (cd === 'replace_too_old') c.forceLocked = true;
    });
    S.banner = formErrs.length
      ? { kind: 'red', title: 'الإرسال ما اتمش', items: formErrs }
      : { kind: 'red', title: 'الإرسال ما اتمش', text: 'راجع الحوش اللي عليها علامة حمرا.' };
  }

  async function onSend() {
    if (!TOKEN_RE.test(TOKEN)) { showLinkGone(); return; }
    if (S.submitting || !S.form) return;
    const send = sendable();
    const evals = send.map((c) => ({ c, r: evalCard(c) }));
    if (!send.length || !evals.every((x) => x.c.clear || x.r.ok)) {
      S.attempted = true;
      if (!send.length) S.banner = { kind: 'red', title: 'مفيش حاجة تتبعت', text: 'اختار حوشة واكتب الأرقام قبل الإرسال.' };
      else if (S.banner && S.banner.kind === 'red' && S.banner.title === 'مفيش حاجة تتبعت') S.banner = null;
      refresh();
      scrollToFirstError();
      return;
    }
    const farm = curFarm();
    if (!farm) return;
    const ids = new Set(farm.plots.map((p) => p.block_id));
    const seen = new Set();
    const rows = [];
    const snap = [];
    for (const { c, r } of evals) {
      if (!ids.has(c.blockId) || seen.has(c.blockId)) {
        S.banner = { kind: 'red', title: 'الإرسال ما اتمش', text: 'في حوشة متكررة أو مش من المزرعة دي. راجع الحوش.' };
        refresh();
        scrollToFirstError();
        return;
      }
      seen.add(c.blockId);
      const p = plotOf(c.blockId);
      const sv = seenVersion(p);
      if (c.clear) {
        rows.push({ block_id: c.blockId, seen_version: sv, clear: true, clear_confirmed: true });
      } else {
        const row = { block_id: c.blockId };
        FIELDS.forEach((f) => { row[f] = r.nums[f]; });
        row.seen_version = sv;
        row.clear = false;
        row.clear_confirmed = false;
        rows.push(row);
      }
      snap.push({
        block_id: c.blockId, label: p.label, progress: p.progress,
        op: c.clear ? 'clear' : (p.existing ? 'replace' : 'insert'),
        new: c.clear ? null : Object.assign({}, r.nums),
        old: p.existing ? Object.assign({}, p.existing) : null,
      });
    }
    const day = S.form.day;
    S.submitting = true;
    S.banner = null;
    refresh();
    APP.querySelectorAll('input, select, button').forEach((e) => { e.disabled = true; });
    const r = await api('/submit', { token: TOKEN, day, farm_id: farm.id, rows });
    S.submitting = false;

    if (r.status === 200) {
      S.sent = {
        ref: typeof r.data.ref === 'string' ? r.data.ref : '',
        deadline: r.data.confirm_deadline,
        summary: r.data.summary,
        farmName: farm.name,
        day,
        snap,
      };
      renderSent();
      return;
    }
    if (r.status === 410) { showLinkGone(); return; }
    if (r.status === 423) { showPaused(() => openForm(day)); return; }
    if (r.status === 409) {
      const staleIds = Array.isArray(r.data.block_ids) ? r.data.block_ids.filter((x) => typeof x === 'string') : [];
      const my = ++loadSeq;
      const f = await api('/form', { token: TOKEN, day });
      if (my !== loadSeq) return;
      if (f.status !== 200) { failForm(f, () => openForm(day)); return; }
      acceptForm(f.data, true, staleIds);
      scrollToFirstError();
      const t = APP.querySelector('.banner');
      if (t && t.scrollIntoView) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (r.status === 422) {
      applyErrors(r.data.errors);
      S.attempted = true;
      renderForm();
      scrollToFirstError();
      return;
    }
    if (r.status === 429) {
      S.banner = { kind: 'red', title: 'الإرسال ما اتمش', text: RATE_AR[errCode(r)] || RATE_AR.rate_limited };
    } else {
      S.banner = { kind: 'red', title: NET_TITLE, text: 'الأرقام اللي كتبتها لسه موجودة. حاول تاني.', retry: true };
    }
    renderForm();
    scrollToFirstError();
  }

  // ───────── sent screen (04) ─────────
  function renderSent() {
    const s = S.sent;
    const snapBy = {};
    s.snap.forEach((x) => { snapBy[x.block_id] = x; });
    const rows = Array.isArray(s.summary) && s.summary.length && s.summary.every((x) => x && typeof x === 'object')
      ? s.summary : s.snap;

    const meta = h('div', 'meta-row',
      h('div', 'field-mini', h('label', null, 'المزرعة'), h('div', 'date-box', s.farmName || '—')),
      h('div', 'field-mini', h('label', null, 'التاريخ'), h('div', 'date-box', dayNodes(s.day, false, true))));

    const summary = h('div', 'summary', h('div', 'sum-top', h('strong', null, 'مزرعة ' + (s.farmName || '')), dayNodes(s.day, true, true)));
    let total = 0;
    rows.forEach((row) => {
      const sn = typeof row.block_id === 'string' ? snapBy[row.block_id] : null;
      const nw = row.new && typeof row.new === 'object' ? row.new : null;
      const old = row.old && typeof row.old === 'object' ? row.old : null;
      const cleared = row.op === 'clear' || !nw;
      const newTot = cleared ? 0 : sumFields(nw);
      total += newTot;
      const label = typeof row.label === 'string' && row.label ? row.label : (sn ? sn.label : '') || '—';
      const ps = h('div', 'plot-sum', h('div', 'ph', h('div', 'title', label),
        cleared ? h('div', 'n gone', 'اتمسح') : h('div', 'n', num(fmt(newTot)), ' ط')));
      if (!cleared) {
        const v = (f) => num(isNum(nw[f]) ? fmt(nw[f]) : '—');
        ps.appendChild(h('div', 'nums', 'وارد محطة ', v('to_packhouse_t'), ' ط · فرز ', v('field_sorting_t'), ' · محلي ', v('local_sales_t'), ' · هالك ', v('waste_t')));
      }
      const pr = sn && sn.progress;
      if (pr && isNum(pr.picked_t)) {
        const after = Math.max(0, old ? pr.picked_t - sumFields(old) + newTot : pr.picked_t + newTot);
        const pg = buildProgress(pr, 'بعد التسجيل', after);
        ps.appendChild(h('div', 'prog', pg.line));
        if (pg.bar) ps.appendChild(pg.bar);
      }
      summary.appendChild(ps);
    });
    summary.appendChild(h('div', 'total-row', h('span', null, 'المجموع'),
      h('span', null, num(String(rows.length)), ' حوشة · ', num(fmt(total)), ' ط')));

    const dl = h('div', 'deadline');
    if (s.ref) add(dl, ['رقم المراجعة: ', code(s.ref)]);
    const hm = cairoHM(s.deadline);
    if (hm) { if (s.ref) dl.appendChild(h('br')); add(dl, ['أكّد قبل ', num(hm)]); }

    const again = button('btn ghost', 'إرسال تاني', () => openForm(s.day));

    const subs = [];
    if (s.ref) subs.push({ ref: s.ref, status: 'pending', day: s.day });
    S.submissions.forEach((x) => { if (typeof x.ref === 'string' && x.ref !== s.ref) subs.push(x); });
    let list = null;
    if (subs.length) {
      list = h('div', 'sub-list', h('h2', null, 'الإرسالات على اللينك ده'),
        h('ul', null, subs.map((x) => {
          const st = typeof x.status === 'string' ? x.status : '';
          const known = Object.prototype.hasOwnProperty.call(STATUS_AR, st);
          return h('li', null,
            h('span', null, code(String(x.ref || '—')), typeof x.day === 'string' ? h('span', 'meta', ' · ', dayNodes(x.day, false, false)) : null),
            h('span', 'pill ' + (st === 'confirmed' ? 'ok' : st === 'pending' ? 'warn' : 'lock'), known ? STATUS_AR[st] : h('span', 'code', st || '—')));
        })));
    }

    screen([header(meta), h('main', 'center-body',
      h('div', 'status-hero', h('div', 'status-icon ok', '✓'), h('h1', null, 'اتبعت للمراجعة'),
        h('p', null, 'الأرقام وصلت لدال. مش هتتسجل قبل ما تأكّد في الشات.')),
      summary, dl,
      h('div', 'hint-confirm', 'دلوقتي ارجع للشات وأكّد بـ ✅ تمام، سجّل'),
      again,
      h('div', 'again-note', 'تقدر تبعت أكتر من مرة، اللينك صالح ', num('3'), ' ساعات.'),
      list)]);
    window.scrollTo(0, 0);
  }

  // ───────── boot ─────────
  // Missing, empty, or wrong-shape tokens never reach /form; show the generic expired screen.
  function startForm() {
    S.farmId = null;
    S.lockedFarm = null;
    S.cards = [];
    S.sent = null;
    S.banner = null;
    if (!TOKEN_RE.test(TOKEN)) showLinkGone();
    else openForm(null);
  }
  window.addEventListener('hashchange', () => {
    if (captureToken()) startForm();
  });
  startForm();
})();
