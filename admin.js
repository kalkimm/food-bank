(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const TZ = 'Asia/Kuala_Lumpur';
  const BUCKET = 'product-photos';
  const TITLES = { dashboard: 'Dashboard', orders: 'Orders', products: 'Products', settings: 'Settings' };
  const CLAIM_COLUMNS =
    'id, student_id, student_name, student_email, student_phone, program_code, ' +
    'claimed_at, claim_month, status, completed_at, ' +
    'claim_items(product_name, quantity)';

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

  let toastTimer;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3500);
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

  // shorter date for the table: leaves out the year when it is the current year
  function formatShort(iso) {
    try {
      const d = new Date(iso);
      const yearOf = (x) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: TZ }).format(x);
      const opts = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: TZ };
      if (yearOf(d) !== yearOf(new Date())) opts.year = 'numeric';
      return new Intl.DateTimeFormat('en-MY', opts).format(d);
    } catch (e) {
      return formatTime(iso);
    }
  }

  function currentMonthValue() {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', timeZone: TZ
    }).format(new Date());
  }

  function monthLabel(value) {
    const parts = String(value || '').split('-').map(Number);
    if (parts.length < 2 || !parts[0] || !parts[1]) return '';
    return new Date(Date.UTC(parts[0], parts[1] - 1, 1))
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function intOrNull(raw, label, min) {
    const s = String(raw).trim();
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error(label + ' must be a whole number.');
    if (n < min) throw new Error(label + ' must be ' + min + ' or more.');
    return n;
  }

  function errMsg(e) {
    return (e && e.message) ? e.message : 'Something went wrong.';
  }

  function itemsText(c) {
    return (c.claim_items || []).map((i) => i.product_name + ' x' + i.quantity).join(', ');
  }

  function badge(status) {
    return h('span', { class: 'badge ' + status, text: status === 'completed' ? 'Completed' : 'Pending' });
  }

  // ---------- setup ----------
  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    String(cfg.SUPABASE_URL).indexOf('YOUR_') === -1 &&
    String(cfg.SUPABASE_ANON_KEY).indexOf('YOUR_') === -1;

  function showLogin(msg) {
    $('app-view').hidden = true;
    $('login-view').hidden = false;
    const e = $('login-error');
    if (msg) { e.textContent = msg; e.hidden = false; } else { e.hidden = true; }
  }
  function showApp() {
    $('login-view').hidden = true;
    $('app-view').hidden = false;
  }

  if (!configured || !window.supabase) {
    showLogin(!configured
      ? 'Not set up yet. Open config.js and add your Supabase URL and key.'
      : 'Could not load the required files. Check your internet connection and refresh.');
    $('login-btn').disabled = true;
    return;
  }

  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const state = {
    claims: [],
    products: [],
    settings: null,
    channel: null,
    started: false,
    tab: 'dashboard',
    statusFilter: 'all',
    modalStudent: null
  };

  // ---------- sound ----------
  let audioCtx = null;
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* ignore */ }
  }
  function beep() {
    if (!$('sound').checked || !audioCtx) return;
    try {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g);
      g.connect(audioCtx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.1;
      o.start();
      o.stop(audioCtx.currentTime + 0.25);
    } catch (e) { /* ignore */ }
  }
  $('sound').addEventListener('change', unlockAudio);

  // ---------- login / logout ----------
  $('login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    unlockAudio();
    const btn = $('login-btn');
    btn.disabled = true;
    const { error } = await client.auth.signInWithPassword({
      email: $('login-email').value.trim(),
      password: $('login-password').value
    });
    btn.disabled = false;
    if (error) {
      showLogin('Wrong email or password.');
      return;
    }
    $('login-password').value = '';
    await enter();
  });

  $('logout-btn').addEventListener('click', async () => {
    stopRealtime();
    closeModal();
    await client.auth.signOut();
    state.started = false;
    showLogin();
  });

  async function enter() {
    const { data: sessionData } = await client.auth.getSession();
    if (!sessionData || !sessionData.session) {
      showLogin();
      return;
    }
    const { data: isAdmin, error } = await client.rpc('is_admin');
    if (error || !isAdmin) {
      await client.auth.signOut();
      showLogin('This account is not an admin.');
      return;
    }
    showApp();
    if (!state.started) {
      state.started = true;
      $('month-filter').value = currentMonthValue();
      showTab('dashboard');
    }
    await Promise.all([loadSettings(), loadProducts(), loadBlocked()]);
    await loadClaims();
    startRealtime();
  }

  // ---------- navigation ----------
  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('.nav-btn').forEach((b) => {
      if (b.dataset.tab === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    Object.keys(TITLES).forEach((n) => { $('tab-' + n).hidden = n !== name; });
    $('page-title').textContent = TITLES[name];
    const showPeriod = name === 'dashboard' || name === 'orders';
    $('period-controls').hidden = !showPeriod;
    $('period-label').hidden = !showPeriod;
  }

  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.addEventListener('click', () => showTab(b.dataset.tab));
  });

  document.querySelectorAll('.stat').forEach((b) => {
    b.addEventListener('click', () => {
      state.statusFilter = b.dataset.go;
      $('status-filter').value = state.statusFilter;
      showTab('orders');
      renderOrders();
    });
  });

  // ---------- realtime ----------
  function startRealtime() {
    stopRealtime();
    state.channel = client
      .channel('orders-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'claims' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          beep();
          toast('New order received');
        }
        loadClaims().catch(() => {});
      })
      .subscribe();
  }
  function stopRealtime() {
    if (state.channel) {
      client.removeChannel(state.channel);
      state.channel = null;
    }
  }

  // =====================================================================
  // ORDERS
  // =====================================================================
  async function fetchClaims(monthStart, studentId) {
    const out = [];
    const size = 1000;
    let from = 0;
    for (;;) {
      let q = client
        .from('claims')
        .select(CLAIM_COLUMNS)
        .order('claimed_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + size - 1);
      if (monthStart) q = q.eq('claim_month', monthStart);
      if (studentId) q = q.eq('student_id', studentId);
      const { data, error } = await q;
      if (error) throw error;
      out.push(...data);
      if (data.length < size) break;
      from += size;
    }
    return out;
  }

  async function loadClaims() {
    const allMonths = $('all-months').checked;
    const month = $('month-filter').value;
    $('month-filter').disabled = allMonths;
    $('period-label').textContent = allMonths ? 'All months' : monthLabel(month);
    try {
      state.claims = await fetchClaims(allMonths || !month ? null : month + '-01');
    } catch (e) {
      toast('Could not load orders: ' + errMsg(e), true);
      return;
    }
    renderAll();
    if (state.modalStudent) loadModal().catch(() => {});
  }

  function renderAll() {
    renderDashboard();
    renderOrders();
  }

  async function setStatus(c, status) {
    const { error } = await client.from('claims').update({
      status: status,
      completed_at: status === 'completed' ? new Date().toISOString() : null
    }).eq('id', c.id);
    if (error) return toast('Could not update: ' + errMsg(error), true);
    toast('Order #' + c.id + (status === 'completed' ? ' marked completed' : ' marked pending'));
    await loadClaims();
  }

  function statusButton(c, small) {
    const pending = c.status === 'pending';
    return h('button', {
      type: 'button',
      class: 'btn ' + (small ? 'small ' : '') + (pending ? 'primary' : ''),
      text: pending ? 'Mark completed' : 'Mark pending',
      onclick: () => setStatus(c, pending ? 'completed' : 'pending')
    });
  }

  // ---------- dashboard ----------
  function renderDashboard() {
    const all = state.claims;
    const pending = all.filter((c) => c.status === 'pending');
    const completed = all.filter((c) => c.status === 'completed');

    $('stat-total').textContent = String(all.length);
    $('stat-pending').textContent = String(pending.length);
    $('stat-completed').textContent = String(completed.length);

    const pct = all.length ? Math.round((completed.length / all.length) * 100) : 0;
    $('progress-fill').style.width = pct + '%';
    $('progress-fill').parentNode.setAttribute('aria-valuenow', String(pct));
    $('progress-text').textContent = all.length
      ? completed.length + ' of ' + all.length + ' orders picked up (' + pct + '%)'
      : 'No orders yet.';

    // items to prepare, from pending orders
    const totals = {};
    pending.forEach((c) => (c.claim_items || []).forEach((i) => {
      totals[i.product_name] = (totals[i.product_name] || 0) + i.quantity;
    }));
    const prep = $('prep-list');
    prep.textContent = '';
    const names = Object.keys(totals).sort();
    if (!names.length) {
      prep.append(h('p', { class: 'muted', text: 'Nothing to prepare. There are no pending orders.' }));
    }
    names.forEach((n) => {
      prep.append(h('div', { class: 'row-line' },
        h('span', { class: 'grow', text: n }),
        h('span', { class: 'num', text: String(totals[n]) })
      ));
    });

    // latest pending orders
    const latest = $('latest-list');
    latest.textContent = '';
    if (!pending.length) {
      latest.append(h('p', { class: 'muted', text: 'No pending orders.' }));
    }
    pending.slice(0, 5).forEach((c) => {
      latest.append(h('div', { class: 'row-line' },
        h('div', { class: 'grow' },
          h('div', null,
            h('button', { type: 'button', class: 'link', text: c.student_name, onclick: () => openStudent(c.student_id) }),
            ' ',
            h('span', { class: 'muted small', text: '#' + c.id })
          ),
          h('div', { class: 'muted small', text: itemsText(c) }),
          h('div', { class: 'muted small', text: formatTime(c.claimed_at) })
        ),
        statusButton(c, true)
      ));
    });
    if (pending.length > 5) {
      latest.append(h('p', { class: 'muted small', style: 'margin-top:10px' },
        'Showing 5 of ' + pending.length + '. ',
        h('button', {
          type: 'button', class: 'link', text: 'See all pending orders',
          onclick: () => { state.statusFilter = 'pending'; $('status-filter').value = 'pending'; showTab('orders'); renderOrders(); }
        })
      ));
    }
  }

  // ---------- orders list ----------
  function filteredOrders() {
    const q = $('search').value.trim().toLowerCase();
    return state.claims.filter((c) => {
      if (state.statusFilter !== 'all' && c.status !== state.statusFilter) return false;
      if (!q) return true;
      return c.student_id.toLowerCase().indexOf(q) !== -1 ||
        c.student_name.toLowerCase().indexOf(q) !== -1 ||
        (c.program_code || '').toLowerCase().indexOf(q) !== -1 ||
        (c.student_phone || '').indexOf(q) !== -1 ||
        (c.student_email || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderOrders() {
    const rows = filteredOrders();
    const body = $('orders-body');
    body.textContent = '';

    rows.forEach((c) => {
      body.append(h('tr', null,
        h('td', null, h('strong', { text: '#' + c.id }), h('div', null, badge(c.status))),
        h('td', { class: 'nowrap', text: formatShort(c.claimed_at) }),
        h('td', null,
          h('div', null, h('button', { type: 'button', class: 'link', text: c.student_name, onclick: () => openStudent(c.student_id) })),
          h('div', { class: 'muted small', text: 'ID ' + c.student_id + (c.program_code ? ', ' + c.program_code : '') }),
          c.student_phone ? h('div', { class: 'muted small', text: c.student_phone }) : null,
          h('div', { class: 'muted small', text: c.student_email || 'No email' })
        ),
        h('td', { text: itemsText(c) }),
        h('td', null, h('div', { class: 'actions' },
          statusButton(c, true),
          h('button', { type: 'button', class: 'btn small', text: 'Block ID', onclick: () => blockId(c.student_id) }),
          h('button', { type: 'button', class: 'btn small danger', text: 'Delete', onclick: () => deleteOrder(c) })
        ))
      ));
    });

    $('orders-empty').hidden = rows.length > 0;
    $('orders-count').textContent = rows.length + (rows.length === 1 ? ' order' : ' orders');
  }

  async function blockId(studentId) {
    const reason = window.prompt('Block student ID ' + studentId + ' from ordering?\nReason (optional):');
    if (reason === null) return;
    const { error } = await client.from('blocked_ids').upsert({
      student_id: studentId,
      reason: reason.trim() || null
    });
    if (error) return toast('Could not block: ' + errMsg(error), true);
    toast('ID ' + studentId + ' blocked');
    loadBlocked();
  }

  async function deleteOrder(c) {
    const ok = window.confirm(
      'Delete order #' + c.id + ' by ' + c.student_name + ' (' + c.student_id + ')?\n' +
      'Stock for these items is returned, and the student can order again this month.');
    if (!ok) return;
    const { error } = await client.rpc('admin_delete_claim', { p_claim_id: c.id, p_restore_stock: true });
    if (error) return toast('Could not delete: ' + errMsg(error), true);
    toast('Order deleted');
    await Promise.all([loadClaims(), loadProducts()]);
  }

  $('month-filter').addEventListener('change', () => loadClaims());
  $('all-months').addEventListener('change', () => loadClaims());
  $('search').addEventListener('input', renderOrders);
  $('status-filter').addEventListener('change', () => {
    state.statusFilter = $('status-filter').value;
    renderOrders();
  });
  $('refresh-btn').addEventListener('click', async () => {
    await loadClaims();
    toast('Refreshed');
  });

  // ---------- student details window ----------
  async function loadModal() {
    const sid = state.modalStudent;
    if (!sid) return;
    let orders;
    try {
      orders = await fetchClaims(null, sid);
    } catch (e) {
      return toast('Could not load student: ' + errMsg(e), true);
    }
    if (state.modalStudent !== sid) return;

    const latest = orders[0];
    $('modal-title').textContent = latest ? latest.student_name : 'Student ' + sid;
    $('modal-sub').textContent = latest
      ? ['ID ' + sid,
         latest.program_code ? 'Kod Program ' + latest.program_code : '',
         latest.student_phone || '',
         latest.student_email || 'no email'].filter(Boolean).join(', ') +
        ' (' + orders.length + (orders.length === 1 ? ' order' : ' orders') + ' in total)'
      : 'ID ' + sid;

    const box = $('modal-orders');
    box.textContent = '';
    if (!orders.length) box.append(h('p', { class: 'muted', text: 'No orders found for this student.' }));
    orders.forEach((c) => {
      box.append(h('div', { class: 'order-block' },
        h('div', { class: 'top' },
          h('div', null, h('strong', { text: 'Order #' + c.id }), ' ', badge(c.status)),
          statusButton(c, true)
        ),
        h('div', { class: 'muted small', text: formatTime(c.claimed_at) }),
        h('ul', { style: 'margin:8px 0 0;padding-left:20px' },
          (c.claim_items || []).map((i) => h('li', { text: i.product_name + ' × ' + i.quantity })))
      ));
    });
  }

  function openStudent(studentId) {
    state.modalStudent = studentId;
    $('modal-title').textContent = 'Student ' + studentId;
    $('modal-sub').textContent = 'Loading…';
    $('modal-orders').textContent = '';
    $('student-modal').hidden = false;
    loadModal();
  }

  function closeModal() {
    state.modalStudent = null;
    $('student-modal').hidden = true;
  }

  $('modal-close').addEventListener('click', closeModal);
  $('student-modal').addEventListener('click', (ev) => {
    if (ev.target === $('student-modal')) closeModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('student-modal').hidden) closeModal();
  });

  // ---------- Excel export ----------
  const XL_HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0E8F8' } };
  const XL_STATUS_FILL = {
    pending: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2C7' } },
    completed: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE1F3E9' } }
  };

  function styleSheet(ws) {
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FF16284F' } };
    head.fill = XL_HEADER_FILL;
    head.alignment = { vertical: 'middle', wrapText: true };
    head.height = 22;
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  }

  // Every item on its own line, for example "Bread x2" then "Biscuits x2"
  function itemsLines(c) {
    return (c.claim_items || []).map((i) => i.product_name + ' x' + i.quantity);
  }

  $('export-btn').addEventListener('click', async () => {
    if (!window.ExcelJS) return toast('The Excel library could not load. Check your internet.', true);
    const rows = filteredOrders();
    if (!rows.length) return toast('Nothing to export.', true);

    const btn = $('export-btn');
    btn.disabled = true;
    try {
      const wb = new window.ExcelJS.Workbook();
      wb.creator = 'Food Bank UiTMCS 2';

      // ----- Orders: one row per order, items one per line -----
      const ws = wb.addWorksheet('Orders');
      ws.columns = [
        { header: 'Order no', key: 'id', width: 10 },
        { header: 'Date & time', key: 'time', width: 22 },
        { header: 'Name', key: 'name', width: 30 },
        { header: 'Student ID', key: 'sid', width: 16 },
        { header: 'Kod Program', key: 'program', width: 14 },
        { header: 'Nombor Telefon', key: 'phone', width: 16 },
        { header: 'Email', key: 'email', width: 34 },
        { header: 'Items', key: 'items', width: 26 },
        { header: 'Status', key: 'status', width: 12 }
      ];
      rows.forEach((c) => {
        const lines = itemsLines(c);
        const row = ws.addRow({
          id: c.id,
          time: formatTime(c.claimed_at),
          name: c.student_name,
          sid: String(c.student_id),
          program: c.program_code || '',
          phone: c.student_phone || '',
          email: c.student_email || '',
          items: lines.join('\n'),
          status: c.status === 'completed' ? 'Completed' : 'Pending'
        });
        row.alignment = { vertical: 'top', wrapText: true };
        row.height = Math.max(1, lines.length) * 15 + 3;
        row.getCell('sid').numFmt = '@';
        row.getCell('phone').numFmt = '@';
        row.getCell('status').fill = XL_STATUS_FILL[c.status] || XL_STATUS_FILL.pending;
      });
      styleSheet(ws);

      // ----- Items: one row per item, handy for sorting and counting -----
      const wi = wb.addWorksheet('Items');
      wi.columns = [
        { header: 'Order no', key: 'id', width: 10 },
        { header: 'Date & time', key: 'time', width: 22 },
        { header: 'Name', key: 'name', width: 30 },
        { header: 'Student ID', key: 'sid', width: 16 },
        { header: 'Kod Program', key: 'program', width: 14 },
        { header: 'Nombor Telefon', key: 'phone', width: 16 },
        { header: 'Item', key: 'item', width: 28 },
        { header: 'Quantity', key: 'qty', width: 10 },
        { header: 'Status', key: 'status', width: 12 }
      ];
      const totals = {};
      rows.forEach((c) => (c.claim_items || []).forEach((i) => {
        const row = wi.addRow({
          id: c.id,
          time: formatTime(c.claimed_at),
          name: c.student_name,
          sid: String(c.student_id),
          program: c.program_code || '',
          phone: c.student_phone || '',
          item: i.product_name,
          qty: i.quantity,
          status: c.status === 'completed' ? 'Completed' : 'Pending'
        });
        row.getCell('sid').numFmt = '@';
        row.getCell('phone').numFmt = '@';
        totals[i.product_name] = (totals[i.product_name] || 0) + i.quantity;
      }));
      styleSheet(wi);

      // ----- Totals -----
      const wt = wb.addWorksheet('Totals');
      wt.columns = [
        { header: 'Item', key: 'item', width: 32 },
        { header: 'Total', key: 'total', width: 10 }
      ];
      Object.keys(totals).sort().forEach((k) => wt.addRow({ item: k, total: totals[k] }));
      styleSheet(wt);

      const label = $('all-months').checked ? 'all' : ($('month-filter').value || 'export');
      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: 'food-bank-orders-' + label + '.xlsx' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Excel file downloaded');
    } catch (e) {
      toast('Could not make the Excel file: ' + errMsg(e), true);
    }
    btn.disabled = false;
  });

  // =====================================================================
  // PRODUCTS
  // =====================================================================
  async function loadProducts() {
    const { data, error } = await client.from('products').select('*')
      .order('sort_order', { ascending: true }).order('name', { ascending: true });
    if (error) return toast('Could not load products: ' + errMsg(error), true);
    state.products = data || [];
    renderProducts();
  }

  function photoPathFromUrl(url) {
    if (!url) return null;
    const marker = '/' + BUCKET + '/';
    const i = url.indexOf(marker);
    return i === -1 ? null : decodeURIComponent(url.slice(i + marker.length).split('?')[0]);
  }

  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
        return reject(new Error('Choose a JPG, PNG or WEBP photo.'));
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 800;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob); else reject(new Error('Could not process that photo.'));
        }, 'image/jpeg', 0.82);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read that photo. Try a JPG or PNG.'));
      };
      img.src = url;
    });
  }

  async function uploadPhoto(file) {
    const blob = await resizeImage(file);
    const path = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
    const { error } = await client.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
    if (error) throw error;
    return client.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  async function removePhotoFile(url) {
    const path = photoPathFromUrl(url);
    if (!path) return;
    try { await client.storage.from(BUCKET).remove([path]); } catch (e) { /* ignore */ }
  }

  function productCard(p) {
    const nameI = h('input', { type: 'text', value: p.name, maxLength: 100 });
    nameI.setAttribute('aria-label', 'Product name');
    const maxI = h('input', { type: 'number', min: 1, step: 1, value: p.max_per_student === null ? '' : p.max_per_student, placeholder: 'No limit' });
    const stockI = h('input', { type: 'number', min: 0, step: 1, value: p.stock === null ? '' : p.stock, placeholder: 'Unlimited' });
    const orderI = h('input', { type: 'number', step: 1, value: p.sort_order });
    const activeI = h('input', { type: 'checkbox', checked: p.active, id: 'active-' + p.id });
    const fileI = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true });

    const hasPhoto = p.photo_url && /^(https:\/\/|data:image\/)/.test(p.photo_url);
    const thumb = hasPhoto
      ? h('img', { class: 'thumb big', src: p.photo_url, alt: '' })
      : h('div', { class: 'thumb big', text: '🍽️' });

    async function save() {
      try {
        const name = nameI.value.trim();
        if (!name) throw new Error('Name cannot be empty.');
        const max = intOrNull(maxI.value, 'Max per student', 1);
        const stock = intOrNull(stockI.value, 'Stock', 0);
        let order = intOrNull(orderI.value, 'List order', -100000);
        if (order === null) order = 0;
        const { error } = await client.from('products').update({
          name: name, max_per_student: max, stock: stock, sort_order: order, active: activeI.checked
        }).eq('id', p.id);
        if (error) throw error;
        toast('Saved');
        await loadProducts();
      } catch (e) {
        toast(errMsg(e), true);
      }
    }

    fileI.addEventListener('change', async () => {
      const file = fileI.files && fileI.files[0];
      if (!file) return;
      toast('Uploading photo…');
      try {
        const url = await uploadPhoto(file);
        const { error } = await client.from('products').update({ photo_url: url }).eq('id', p.id);
        if (error) throw error;
        await removePhotoFile(p.photo_url);
        toast('Photo updated');
        await loadProducts();
      } catch (e) {
        toast(errMsg(e), true);
      }
    });

    async function removePhoto() {
      if (!window.confirm('Remove the photo for ' + p.name + '?')) return;
      const { error } = await client.from('products').update({ photo_url: null }).eq('id', p.id);
      if (error) return toast(errMsg(error), true);
      await removePhotoFile(p.photo_url);
      toast('Photo removed');
      loadProducts();
    }

    async function del() {
      if (!window.confirm('Delete "' + p.name + '"?\nPast orders keep the item name.')) return;
      const { error } = await client.from('products').delete().eq('id', p.id);
      if (error) return toast(errMsg(error), true);
      await removePhotoFile(p.photo_url);
      toast('Product deleted');
      loadProducts();
    }

    return h('div', { class: 'prod-card' },
      thumb,
      h('div', { class: 'fields' },
        nameI,
        h('div', { class: 'row' },
          h('div', null, h('label', { text: 'Max per student' }), maxI),
          h('div', null, h('label', { text: 'Stock' }), stockI),
          h('div', null, h('label', { text: 'List order' }), orderI)
        ),
        h('div', { class: 'check' }, activeI, h('label', { for: 'active-' + p.id, text: 'Show to students' })),
        h('div', { class: 'btns' },
          h('button', { type: 'button', class: 'btn small primary', text: 'Save', onclick: save }),
          h('button', { type: 'button', class: 'btn small', text: hasPhoto ? 'Change photo' : 'Add photo', onclick: () => fileI.click() }),
          hasPhoto ? h('button', { type: 'button', class: 'btn small', text: 'Remove photo', onclick: removePhoto }) : null,
          h('button', { type: 'button', class: 'btn small danger', text: 'Delete', onclick: del }),
          fileI
        )
      )
    );
  }

  function renderProducts() {
    const list = $('products-list');
    list.textContent = '';
    state.products.forEach((p) => list.append(productCard(p)));
    $('products-empty').hidden = state.products.length > 0;
  }

  $('add-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('add-btn');
    btn.disabled = true;
    try {
      const name = $('add-name').value.trim();
      if (!name) throw new Error('Enter a product name.');
      const max = intOrNull($('add-max').value, 'Max per student', 1);
      const stock = intOrNull($('add-stock').value, 'Stock', 0);
      const nextOrder = state.products.reduce((m, p) => Math.max(m, p.sort_order), 0) + 1;

      const { data, error } = await client.from('products').insert({
        name: name, max_per_student: max, stock: stock, sort_order: nextOrder, active: true
      }).select().single();
      if (error) throw error;

      const file = $('add-photo').files && $('add-photo').files[0];
      if (file) {
        try {
          const url = await uploadPhoto(file);
          const r = await client.from('products').update({ photo_url: url }).eq('id', data.id);
          if (r.error) throw r.error;
        } catch (e) {
          toast('Product added, but the photo failed: ' + errMsg(e), true);
        }
      }
      $('add-form').reset();
      toast('Product added');
      await loadProducts();
    } catch (e) {
      toast(errMsg(e), true);
    }
    btn.disabled = false;
  });

  // =====================================================================
  // SETTINGS + BLOCKED IDS
  // =====================================================================
  async function loadSettings() {
    const { data, error } = await client.from('settings').select('*').eq('id', 1).maybeSingle();
    if (error) return toast('Could not load settings: ' + errMsg(error), true);
    if (!data) return;
    state.settings = data;
    $('set-open').checked = data.claims_open;
    $('set-limit').value = data.claims_per_month;
    $('set-location').value = data.pickup_location || '';
    $('set-pickup').value = data.pickup_note || '';
    $('set-wa').value = data.whatsapp_number || '';
  }

  $('settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('settings-btn');
    btn.disabled = true;
    try {
      const limit = intOrNull($('set-limit').value, 'Orders per month', 1);
      if (limit === null || limit > 50) throw new Error('Orders per month must be between 1 and 50.');

      const location = $('set-location').value.trim();
      if (!location) throw new Error('Enter the pickup location.');

      let wa = $('set-wa').value.replace(/\D/g, '');
      if (wa.charAt(0) === '0') wa = '60' + wa.slice(1);
      if (wa.length < 9 || wa.length > 15) throw new Error('Enter a valid WhatsApp number, for example 60123456789.');

      const { error } = await client.from('settings').update({
        claims_open: $('set-open').checked,
        claims_per_month: limit,
        pickup_location: location,
        pickup_note: $('set-pickup').value.trim(),
        whatsapp_number: wa
      }).eq('id', 1);
      if (error) throw error;
      $('set-wa').value = wa;
      toast('Settings saved');
    } catch (e) {
      toast(errMsg(e), true);
    }
    btn.disabled = false;
  });

  async function loadBlocked() {
    const { data, error } = await client.from('blocked_ids').select('*').order('created_at', { ascending: false });
    if (error) return toast('Could not load blocked IDs: ' + errMsg(error), true);
    const box = $('blocked-list');
    box.textContent = '';
    (data || []).forEach((b) => {
      box.append(h('div', { class: 'blocked-item' },
        h('div', null,
          h('strong', { text: b.student_id }),
          b.reason ? h('div', { class: 'muted small', text: b.reason }) : null
        ),
        h('button', {
          type: 'button', class: 'btn small', text: 'Unblock',
          onclick: async () => {
            const r = await client.from('blocked_ids').delete().eq('student_id', b.student_id);
            if (r.error) return toast(errMsg(r.error), true);
            toast('Unblocked');
            loadBlocked();
          }
        })
      ));
    });
    $('blocked-empty').hidden = (data || []).length > 0;
  }

  // ---------- start ----------
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      stopRealtime();
      state.started = false;
      showLogin();
    }
  });

  enter().catch((e) => showLogin('Could not connect: ' + errMsg(e)));
})();
