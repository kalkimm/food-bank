(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const TZ = 'Asia/Kuala_Lumpur';
  const LAST_KEY = 'foodbank:last-order';
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const PROGRAM_RE = /^[A-Z0-9][A-Z0-9 \/-]{1,19}$/;

  // Malaysian mobile number. Accepts 0123456789, 012-345 6789 or +60123456789
  // and returns it as 0123456789 (10 or 11 digits starting with 01), or null.
  function normalizePhone(raw) {
    const s = String(raw).trim();
    if (!/^[0-9+() -]+$/.test(s)) return null;
    let d = s.replace(/\D/g, '');
    if (/^601/.test(d)) d = '0' + d.slice(2);
    return /^01[0-9]{8,9}$/.test(d) ? d : null;
  }

  // ---------- tiny helpers ----------
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else if (k in e) e[k] = v;
        else e.setAttribute(k, v);
      }
    }
    kids.flat().forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return e;
  }

  function formatTime(iso) {
    try {
      return new Intl.DateTimeFormat('en-MY', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: TZ
      }).format(new Date(iso));
    } catch (e) {
      return String(iso);
    }
  }

  function monthKey(date) {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', timeZone: TZ
    }).format(date);
  }

  function waLink(number, order) {
    const lines = [
      'New order for Food Bank UiTMCS 2',
      'Order no: #' + order.claim_id,
      'Name: ' + order.name,
      'Student ID: ' + order.student_id,
      'Kod Program: ' + (order.program_code || '-'),
      'Nombor Telefon: ' + (order.phone || '-'),
      'Email: ' + order.email,
      'Items:'
    ];
    order.items.forEach((i) => lines.push('- ' + i.name + ' x' + i.quantity));
    lines.push('Ordered: ' + formatTime(order.claimed_at));
    return 'https://wa.me/' + String(number).replace(/\D/g, '') +
      '?text=' + encodeURIComponent(lines.join('\n'));
  }

  function saveLast(order) {
    try { localStorage.setItem(LAST_KEY, JSON.stringify(order)); } catch (e) { /* ignore */ }
  }
  function loadLast() {
    try {
      const raw = localStorage.getItem(LAST_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- setup check ----------
  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    String(cfg.SUPABASE_URL).indexOf('YOUR_') === -1 &&
    String(cfg.SUPABASE_ANON_KEY).indexOf('YOUR_') === -1;

  if (!configured || !window.supabase) {
    $('loading').hidden = true;
    const b = $('banner');
    b.hidden = false;
    b.textContent = !configured
      ? 'This site is not set up yet. Open config.js and add your Supabase URL and key.'
      : 'Could not load the required files. Check your internet connection and refresh.';
    return;
  }

  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // ---------- state ----------
  let settings = { claims_open: true, pickup_location: '', pickup_note: '', whatsapp_number: '' };
  let cards = [];

  const form = $('order-form');
  const nameInput = $('student-name');
  const idInput = $('student-id');
  const emailInput = $('student-email');
  const programInput = $('student-program');
  const phoneInput = $('student-phone');
  const errorEl = $('form-error');
  const submitBtn = $('submit-btn');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    errorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function hideError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  idInput.addEventListener('input', () => {
    idInput.value = idInput.value.replace(/\D/g, '');
  });

  // ---------- product card ----------
  function productCard(p) {
    const soldOut = p.stock !== null && p.stock <= 0;
    const limit = p.max_per_student === null ? 99 : p.max_per_student;
    const left = p.stock === null ? 99 : p.stock;
    const maxQty = soldOut ? 0 : Math.min(limit, left);
    let qty = 0;

    const qtyEl = h('span', { class: 'qty', text: '0' });
    const minus = h('button', { type: 'button', class: 'step', disabled: true, text: '−' });
    minus.setAttribute('aria-label', 'Less ' + p.name);
    const plus = h('button', { type: 'button', class: 'step', disabled: soldOut, text: '+' });
    plus.setAttribute('aria-label', 'More ' + p.name);

    function set(n) {
      qty = Math.max(0, Math.min(maxQty, n));
      qtyEl.textContent = String(qty);
      minus.disabled = qty <= 0;
      plus.disabled = qty >= maxQty;
    }
    minus.addEventListener('click', () => set(qty - 1));
    plus.addEventListener('click', () => set(qty + 1));

    const pills = [];
    if (soldOut) {
      pills.push(h('span', { class: 'pill out', text: 'Sold out' }));
    } else {
      if (p.max_per_student !== null) pills.push(h('span', { class: 'pill', text: 'Max ' + p.max_per_student + ' per student' }));
      if (p.stock !== null) pills.push(h('span', { class: 'pill' + (p.stock <= 5 ? ' warn' : ''), text: p.stock + ' left' }));
    }

    const photo = p.photo_url && /^(https:\/\/|data:image\/)/.test(p.photo_url)
      ? h('img', { class: 'thumb', src: p.photo_url, alt: '', loading: 'lazy' })
      : h('div', { class: 'thumb', text: '🍽️' });

    const el = h('div', { class: 'product' + (soldOut ? ' soldout' : '') },
      photo,
      h('div', { class: 'info' },
        h('div', { class: 'name', text: p.name }),
        pills.length ? h('div', { class: 'pills' }, pills) : null
      ),
      h('div', { class: 'stepper' }, minus, qtyEl, plus)
    );

    return { el: el, product: p, getQty: () => qty };
  }

  function renderProducts(products) {
    const box = $('products');
    box.textContent = '';
    cards = products.map(productCard);
    if (!cards.length) {
      box.append(h('p', { class: 'muted', text: 'No items are available right now.' }));
    }
    cards.forEach((c) => box.append(c.el));
  }

  // ---------- order summary ----------
  function renderOrder(container, order) {
    container.textContent = '';
    container.append(
      h('div', { class: 'order-ref', text: 'Order #' + order.claim_id }),
      h('div', null, h('strong', { text: order.name }), ' (ID ' + order.student_id + ')'),
      h('div', { class: 'muted small' },
        order.program_code ? h('div', { text: 'Kod Program: ' + order.program_code }) : null,
        order.phone ? h('div', { text: 'Nombor Telefon: ' + order.phone }) : null,
        h('div', { text: order.email })
      ),
      h('ul', null, order.items.map((i) => h('li', { text: i.name + ' × ' + i.quantity }))),
      h('div', { class: 'muted small', text: 'Ordered ' + formatTime(order.claimed_at) })
    );
  }

  function setWhatsApp(anchor, order) {
    const digits = String(settings.whatsapp_number || '').replace(/\D/g, '');
    if (digits.length < 8) {
      anchor.hidden = true;
      return;
    }
    anchor.hidden = false;
    anchor.href = waLink(digits, order);
  }

  function showLastOrder() {
    const box = $('last-order');
    const last = loadLast();
    if (!last || !last.items || monthKey(new Date(last.claimed_at)) !== monthKey(new Date())) {
      box.hidden = true;
      return;
    }
    box.textContent = '';
    const summary = h('div', { class: 'summary' });
    renderOrder(summary, last);
    const wa = h('a', { class: 'btn small', target: '_blank', rel: 'noopener', text: 'Send to admin on WhatsApp' });
    setWhatsApp(wa, last);
    box.append(h('h3', { text: 'Your order this month' }), summary, wa);
    box.hidden = false;
  }

  // ---------- data ----------
  async function loadData() {
    const [s, p] = await Promise.all([
      client.from('settings').select('*').eq('id', 1).maybeSingle(),
      client.from('products').select('*').eq('active', true)
        .order('sort_order', { ascending: true }).order('name', { ascending: true })
    ]);
    if (s.error) throw s.error;
    if (p.error) throw p.error;
    if (s.data) settings = s.data;
    return p.data || [];
  }

  function applySettings() {
    const banner = $('banner');

    if (settings.pickup_location && settings.pickup_location.trim()) {
      $('pickup-location').textContent = settings.pickup_location;
    }
    const note = $('pickup-note');
    if (settings.pickup_note && settings.pickup_note.trim()) {
      note.textContent = settings.pickup_note;
      note.hidden = false;
    } else {
      note.hidden = true;
    }

    if (!settings.claims_open) {
      banner.textContent = 'Orders are closed right now. Please check again later.';
      banner.hidden = false;
      form.hidden = true;
    } else {
      banner.hidden = true;
      if ($('done-view').hidden) form.hidden = false;
    }
  }

  async function refresh() {
    const products = await loadData();
    renderProducts(products);
    applySettings();
    showLastOrder();
  }

  function friendly(error) {
    if (error && error.code === 'P0001' && error.message) return error.message;
    if (error && /fetch|network|failed/i.test(error.message || '')) {
      return 'Could not reach the server. Check your internet and try again.';
    }
    return 'Something went wrong. Please try again.';
  }

  // ---------- submit ----------
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    hideError();

    const name = nameInput.value.trim();
    const sid = idInput.value.trim();
    const email = emailInput.value.trim().toLowerCase();
    const program = programInput.value.trim().toUpperCase();
    const phone = normalizePhone(phoneInput.value);
    if (name.length < 2) return showError('Enter your full name.');
    if (!/^[0-9]{5,15}$/.test(sid)) {
      return showError('Enter a valid student ID (numbers only, 5 to 15 digits).');
    }
    if (!PROGRAM_RE.test(program)) return showError('Enter your Kod Program, for example CS110.');
    if (!phone) return showError('Enter a valid Malaysian phone number, for example 0123456789.');
    if (!EMAIL_RE.test(email) || email.length > 254) return showError('Enter a valid email address.');
    const items = cards
      .map((c) => ({ product_id: c.product.id, quantity: c.getQty() }))
      .filter((i) => i.quantity > 0);
    if (!items.length) return showError('Choose at least one item.');

    submitBtn.disabled = true;
    submitBtn.textContent = 'Placing order…';

    let result;
    try {
      result = await client.rpc('submit_claim', {
        p_student_id: sid,
        p_student_name: name,
        p_student_email: email,
        p_student_phone: phone,
        p_program_code: program,
        p_items: items
      });
    } catch (e) {
      result = { error: e };
    }

    submitBtn.disabled = false;
    submitBtn.textContent = 'Place order';

    if (result.error) {
      showError(friendly(result.error));
      // stock may have changed, so refresh the list quietly
      refresh().catch(() => {});
      return;
    }

    const order = {
      claim_id: result.data.claim_id,
      claimed_at: result.data.claimed_at,
      items: result.data.items,
      name: name,
      student_id: sid,
      email: email,
      program_code: program,
      phone: phone
    };
    saveLast(order);

    renderOrder($('done-summary'), order);
    setWhatsApp($('wa-btn'), order);
    form.hidden = true;
    $('last-order').hidden = true;
    $('done-view').hidden = false;
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { /* ignore */ }
  });

  $('back-btn').addEventListener('click', () => {
    $('done-view').hidden = true;
    nameInput.value = '';
    idInput.value = '';
    programInput.value = '';
    phoneInput.value = '';
    emailInput.value = '';
    refresh().catch(() => {});
  });

  // ---------- start ----------
  refresh()
    .then(() => {
      $('loading').hidden = true;
    })
    .catch(() => {
      $('loading').hidden = true;
      const b = $('banner');
      b.textContent = 'Could not load the page. Check your internet and refresh.';
      b.hidden = false;
    });
})();
