/* ============================================================
   約時間 — 前端主程式（純 Vanilla JS，無建置步驟）
   路由：#/new  建立活動
         #/e/<id>        填寫頁
         #/e/<id>/admin  創辦人後台
   ============================================================ */
(function () {

  'use strict';
  const CFG = window.APP_CONFIG || {};
  const app = document.getElementById('app');
  let HOLIDAYS = {};
  const DOW = ['日', '一', '二', '三', '四', '五', '六'];


  // #region // 後端呼叫
  async function api(action, payload) {

    // 示範模式
    if (CFG.BACKEND === 'local') return window.LocalBackend(action, payload);

    // API_BASE
    if (!CFG.API_BASE) return { ok: false, error: '尚未設定 API_BASE（請編輯 config.js）' };

    try {
      const res = await fetch(CFG.API_BASE, {

        method: 'POST', redirect: 'follow',

        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        // NOTE : 用 text/plain 送 JSON：避免瀏覽器預檢 (preflight)，GAS 與 FastAPI 都能接

        body: JSON.stringify(Object.assign({ action }, payload || {})),

      });

      const text = await res.text();
      try { return JSON.parse(text); } catch (e) { return { ok: false, error: '後端回應不是 JSON：' + text.slice(0, 120) }; }
    } catch (e) { return { ok: false, error: '連線失敗：' + e.message }; }

  }

  // #endregion //


  // #region // 小工具
  // NOTE : 使用純文字處理 ( 取代 innerHTML ) 以避免惡意程式碼 XSS

  function el(tag, attrs, ...children) {

    const n = document.createElement(tag);

    if (attrs) for (const [k, v] of Object.entries(attrs)) {

      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);

    }

    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;

  }

  // 跳出短暫提示 ( 右下角 )
  function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('show'), 2200); }
  
  // 複製到剪貼簿
  async function copyText(text) { try { await navigator.clipboard.writeText(text); toast('已複製'); } catch (e) { prompt('請手動複製：', text); } }
  
  // 補零 ( EX : 8 → 08 )
  function pad2(n) { return String(n).padStart(2, '0'); }
  
  // 今日日期字串
  function todayStr(offset = 0) { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  
  // 產生日期 ( 上限 200 天 )
  function listDates(a, b) {
    const out = []; const d = new Date(a + 'T00:00:00'); const end = new Date(b + 'T00:00:00');
    while (d <= end && out.length < 200) { out.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`); d.setDate(d.getDate() + 1); }
    return out;
  }

  function dowOf(date) { return new Date(date + 'T00:00:00').getDay(); }

  // 休息日判定
  function isRest(date) { const w = dowOf(date); return w === 0 || w === 6 || !!HOLIDAYS[date]; }

  function holidayName(date) { return HOLIDAYS[date] || ''; }

  // 清單條列
  function rowsFor(ev) {
    if (ev.mode === 'coarse') return CFG.COARSE_BLOCKS.map(b => ({ key: b.key, label: `${b.label} ${pad2(b.start)}–${pad2(b.end)}`, short: b.label, start: b.start, end: b.end }));
    const rows = []; for (let h = ev.hourStart; h < ev.hourEnd; h++) rows.push({ key: pad2(h), label: `${pad2(h)}:00`, short: `${pad2(h)}:00`, start: h, end: h + 1 });
    return rows;
  }

  // 日期 & 時段
  function slotId(date, key) { return `${date}|${key}`; }

  function parseSlot(id) { const [date, key] = id.split('|'); return { date, key }; }

  // 補選日期 ( 創辦人開放補選且已有定案時，填寫頁進入「補選模式」)
  function finalDates(ev) { return [...new Set((ev.finalSlots || []).map(s => parseSlot(s).date))].sort(); }
  function inExtraMode(ev) { return !!ev.extraOpen && finalDates(ev).length > 0; }

  // 午休 / 下班時間判定 ( 淡灰色 )
  function isOff(row) {
    if (CFG.LUNCH_HOURS.includes(row.start) && row.end - row.start === 1) return true;
    if (row.key === 'noon') return true;
    return row.start < CFG.WORK_START || row.start >= CFG.WORK_END;
  }

  // 日期格式轉化 ( 自然語言 )
  function fmtDateShort(date) { const [, m, d] = date.split('-'); return `${Number(m)}/${Number(d)} (${DOW[dowOf(date)]})`; }
  function fmtSlot(ev, id) {
    const { date, key } = parseSlot(id); const row = rowsFor(ev).find(r => r.key === key);
    if (!row) return `${fmtDateShort(date)} ${key}`;
    return ev.mode === 'coarse' ? `${fmtDateShort(date)} ${row.short} ${pad2(row.start)}:00–${pad2(row.end)}:00` : `${fmtDateShort(date)} ${pad2(row.start)}:00–${pad2(row.end)}:00`;
  }

  // 依據日期、時段排序
  function slotSortKey(ev, id) { const { date, key } = parseSlot(id); const row = rowsFor(ev).find(r => r.key === key); return `${date}|${pad2(row ? row.start : 99)}`; }
  function sortSlots(ev, arr) { return [...arr].sort((a, b) => slotSortKey(ev, a).localeCompare(slotSortKey(ev, b))); }
  
  // 填寫連結 & 後臺連結
  function eventUrl(id) { return location.origin + location.pathname + '#/e/' + id; }
  function adminUrl(id) { return eventUrl(id) + '/admin'; }
  
  function sess(key, val) { if (val === undefined) { try { return JSON.parse(sessionStorage.getItem(key)); } catch (e) { return null; } } if (val === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(val)); }
  
  // 預設開放
  function defaultAllowed(ev) {
    const out = [];
    for (const date of listDates(ev.dateStart, ev.dateEnd)) { if (isRest(date)) continue; for (const r of rowsFor(ev)) { if (isOff(r)) continue; out.push(slotId(date, r.key)); } }
    return out;
  }

  // #endregion //


  // #region // 時間欄位建置

  // opts: { event, selected:Set, allowed:Set|null, heat:Map<slot,string[]>|null, total, finalSet, hlSet,
  //         interactive, onChange(), onHover(slotId|null), headerToggle, dates?:string[] 只顯示這些日期 }

  function buildGrid(opts) {

    const ev = opts.event; const dates = opts.dates || listDates(ev.dateStart, ev.dateEnd); const rows = rowsFor(ev);
    const grid = el('div', { class: 'grid' + (ev.mode === 'coarse' ? ' coarse' : '') + (opts.heat ? ' heatmode' : '') });

    grid.style.gridTemplateColumns = `auto repeat(${dates.length}, minmax(${ev.mode === 'coarse' ? 72 : 56}px, 1fr))`;
    grid.append(el('div', { class: 'corner' }));

    for (const date of dates) {

      const rest = isRest(date);
      const h = el('div', { class: 'dhead' + (rest ? ' rest' : ''), 'data-date': date },
        el('div', null, date.slice(5).replace('-', '/')), el('div', { class: 'dow' }, '週' + DOW[dowOf(date)]),
        holidayName(date) ? el('span', { class: 'hol' }, holidayName(date)) : null);

      grid.append(h);

    }

    const cells = new Map();

    for (const row of rows) {

      grid.append(el('div', { class: 'rhead' }, row.label));

      for (const date of dates) {

        const id = slotId(date, row.key);
        const blocked = opts.allowed && !opts.allowed.has(id);
        const c = el('div', { class: 'cell' + (isRest(date) ? ' rest' : isOff(row) ? ' off' : '') + (blocked ? ' blocked' : ''), 'data-id': id });

        if (opts.heat && !blocked) {
          const n = (opts.heat.get(id) || []).length; const total = opts.total || 0;
          if (n > 0) { const op = total ? Math.max(0.15, 0.15 + 0.8 * (n / total)) : 0.3; c.append(el('div', { class: 'heat', style: `opacity:${op.toFixed(2)}` })); c.append(el('div', { class: 'cnt' }, String(n))); }
        }

        if (opts.selected && opts.selected.has(id)) c.classList.add('sel');
        if (opts.finalSet && opts.finalSet.has(id)) c.classList.add('final');
        if (opts.hlSet && opts.hlSet.has(id)) c.classList.add('hl');

        cells.set(id, c); grid.append(c);
      }

    }

    // hover
    grid.addEventListener('pointerover', e => { const c = e.target.closest('.cell'); if (opts.onHover) opts.onHover(c ? c.dataset.id : null); });
    grid.addEventListener('pointerleave', () => opts.onHover && opts.onHover(null));

    // header click → 整欄切換
    if (opts.interactive && opts.headerToggle) grid.addEventListener('click', e => {
      const h = e.target.closest('.dhead'); if (!h) return; const date = h.dataset.date;
      const ids = rows.map(r => slotId(date, r.key)).filter(id => !(opts.allowed && !opts.allowed.has(id)));
      const allOn = ids.every(id => opts.selected.has(id));
      for (const id of ids) { if (allOn) opts.selected.delete(id); else opts.selected.add(id); cells.get(id).classList.toggle('sel', !allOn); }
      opts.onChange && opts.onChange();
    });

    // 拖曳塗選
    if (opts.interactive) {
      let paint = null;
      const apply = (c) => { if (!c || c.classList.contains('blocked')) return; const id = c.dataset.id; if (paint.state) opts.selected.add(id); else opts.selected.delete(id); c.classList.toggle('sel', paint.state); };
      grid.addEventListener('pointerdown', e => {
        const c = e.target.closest('.cell'); if (!c || c.classList.contains('blocked')) return;
        e.preventDefault(); paint = { state: !opts.selected.has(c.dataset.id) }; apply(c); grid.setPointerCapture(e.pointerId);
      });
      grid.addEventListener('pointermove', e => { if (!paint) return; const t = document.elementFromPoint(e.clientX, e.clientY); apply(t && t.closest('.cell')); });
      const stop = () => { if (paint) { paint = null; opts.onChange && opts.onChange(); } };
      grid.addEventListener('pointerup', stop); grid.addEventListener('pointercancel', stop);
    }
    return el('div', { class: 'grid-wrap' }, grid);
  }

  function legend(extra) {
    return el('div', { class: 'legend' },
      el('span', null, el('i', { class: 'sw rest' }), '週末 / 國定假日（可選，僅提示）'),
      el('span', null, el('i', { class: 'sw off' }), '午休 / 下班時間（可選，僅提示）'),
      el('span', null, el('i', { class: 'sw blocked' }), '創辦人未開放'),
      extra || null);
  }

  function heatLegend() { return el('span', null, el('span', { class: 'heatbar' }, [0.15, 0.35, 0.55, 0.75, 0.95].map(o => el('i', { style: `opacity:${o}` }))), ' 有空人數少 → 多'); }

  function heatFrom(participants) { const m = new Map(); for (const p of participants) for (const s of p.slots) { if (!m.has(s)) m.set(s, []); m.get(s).push(p.name); } return m; }
  
  function hoverInfoBox(ev, heat, participants, allNames) {
    const box = el('div', { class: 'hover-info muted' }, '把滑鼠移到格子上，看看誰有空。');
    return { node: box, update(id) {
      if (!id) { box.className = 'hover-info muted'; box.textContent = '把滑鼠移到格子上，看看誰有空。'; return; }
      const yes = heat.get(id) || []; const names = allNames || participants.map(p => p.name);
      box.className = 'hover-info';
      box.replaceChildren(el('div', null, el('strong', null, fmtSlot(ev, id))), el('div', null, `有空 ${yes.length} / ${names.length} 人`),
        el('div', { class: 'names' }, names.map(n => el('span', { class: yes.includes(n) ? '' : 'no' }, n))));
    } };
  }

  function topSlots(ev, heat, total, n = 5) {
    const arr = [...heat.entries()].filter(([, v]) => v.length > 0).sort((a, b) => b[1].length - a[1].length || slotSortKey(ev, a[0]).localeCompare(slotSortKey(ev, b[0]))).slice(0, n);
    if (!arr.length) return el('p', { class: 'muted' }, '還沒有人填寫。');
    return el('ol', null, arr.map(([id, v]) => el('li', null, `${fmtSlot(ev, id)} — ${v.length}/${total} 人`)));
  }

  // #endregion //



  // 說明欄 / 公告（填寫頁與後台預覽共用）
  function fmtStamp(iso) { const t = new Date(iso); return isNaN(t) ? '' : t.toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function announceBox(ev) {
    if (!ev.description) return null;
    return el('div', { class: 'notice announce' }, el('strong', null, '📢 公告'), ev.descriptionAt ? el('span', { class: 'meta' }, '　更新於 ' + fmtStamp(ev.descriptionAt)) : null, el('div', { class: 'announce-body' }, ev.description));
  }

  // #region // < 頁面 > 建立活動

  function viewNew() {
    const st = { title: '', creatorName: '', creatorEmail: '', password: '', password2: '', dateStart: todayStr(1), dateEnd: todayStr(14),
      mode: 'hour', hourStart: CFG.DEFAULT_HOUR_START, hourEnd: CFG.DEFAULT_HOUR_END, showResults: true, showNames: true, notifyMode: 'none', discordWebhook: '', description: '' };
    let selected = new Set(defaultAllowed(st));
    let gridHost = el('div'); let msg = el('div');

    const inp = (key, type, attrs) => el('input', Object.assign({ type, value: st[key], oninput: e => { st[key] = e.target.value; } }, attrs || {}));
    const field = (label, node, hint) => el('div', { class: 'field' }, el('label', null, label), node, hint ? el('span', { class: 'hint' }, hint) : null);

    function rebuildGrid(resetSelection) {
      if (resetSelection) selected = new Set(defaultAllowed(st));
      else { const valid = new Set(); for (const d of listDates(st.dateStart, st.dateEnd)) for (const r of rowsFor(st)) valid.add(slotId(d, r.key)); selected = new Set([...selected].filter(s => valid.has(s))); }
      gridHost.replaceChildren(buildGrid({ event: st, selected, allowed: null, interactive: true, headerToggle: true }));
    }
    const modeSeg = el('div', { class: 'seg' },
      el('button', { type: 'button', class: st.mode === 'hour' ? 'active' : '', onclick: e => { st.mode = 'hour'; seg(e); hourRangeRow.classList.remove('hidden'); rebuildGrid(true); } }, '逐小時'),
      el('button', { type: 'button', class: st.mode === 'coarse' ? 'active' : '', onclick: e => { st.mode = 'coarse'; seg(e); hourRangeRow.classList.add('hidden'); rebuildGrid(true); } }, '上午 / 中午 / 下午 / 晚上'));
    function seg(e) { [...e.currentTarget.parentNode.children].forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); }
    const rangeSeg = el('div', { class: 'seg' },
      el('button', { type: 'button', class: 'active', onclick: e => { st.hourStart = CFG.DEFAULT_HOUR_START; st.hourEnd = CFG.DEFAULT_HOUR_END; seg(e); rebuildGrid(false); } }, `${pad2(CFG.DEFAULT_HOUR_START)}:00–${pad2(CFG.DEFAULT_HOUR_END)}:00`),
      el('button', { type: 'button', onclick: e => { st.hourStart = 0; st.hourEnd = 24; seg(e); rebuildGrid(false); } }, '00:00–24:00'));
    const hourRangeRow = field('逐小時模式顯示範圍', rangeSeg, '建立後仍可在後台切換。');

    const quick = el('div', { class: 'btn-group' },
      el('button', { type: 'button', class: 'small', onclick: () => { rebuildGrid(true); } }, '預設：工作時間（不含午休、週末假日）'),
      el('button', { type: 'button', class: 'small', onclick: () => { selected = new Set(); for (const d of listDates(st.dateStart, st.dateEnd)) for (const r of rowsFor(st)) if (r.start >= CFG.WORK_START && r.end <= CFG.WORK_END) selected.add(slotId(d, r.key)); rebuildGrid(false); } }, '工作時間 08–18（含週末假日）'),
      el('button', { type: 'button', class: 'small', onclick: () => { selected = new Set(); for (const d of listDates(st.dateStart, st.dateEnd)) for (const r of rowsFor(st)) selected.add(slotId(d, r.key)); rebuildGrid(false); } }, '全部開放'),
      el('button', { type: 'button', class: 'small', onclick: () => { selected = new Set(); rebuildGrid(false); } }, '全部清除'));

    const notifySel = el('select', { onchange: e => { st.notifyMode = e.target.value; emailField.querySelector('input').required = st.notifyMode !== 'none'; } },
      el('option', { value: 'none' }, '不通知'), el('option', { value: 'instant' }, '每次有人填寫 / 修改就寄 email'), el('option', { value: 'daily' }, '每天寄一封摘要 email'));
    const emailField = field('創辦人 email', inp('creatorEmail', 'email', { placeholder: '選填；要收通知或寄定案通知時需要' }));

    async function submit(e) {
      e.preventDefault(); msg.replaceChildren();
      if (st.password !== st.password2) return showMsg('兩次輸入的密碼不一致', 'error');
      const payload = Object.assign({}, st, { allowed: [...selected] }); delete payload.password2;
      const btn = e.submitter; btn.disabled = true;
      const r = await api('createEvent', payload); btn.disabled = false;
      if (!r.ok) return showMsg(r.error, 'error');
      sess('admin:' + r.id, { password: st.password });
      app.replaceChildren(el('div', { class: 'card narrow' },
        el('h2', null, '活動已建立 🎉'),
        el('p', null, '把「填寫連結」傳給要約的人；「後台連結」只給自己留著，進入時需要剛才設定的創辦人密碼。'),
        el('div', { class: 'field' }, el('label', null, '填寫連結（給大家）'), el('div', { class: 'linkbox' }, el('input', { type: 'text', readonly: true, value: eventUrl(r.id) }), el('button', { type: 'button', onclick: () => copyText(eventUrl(r.id)) }, '複製'))),
        el('div', { class: 'field' }, el('label', null, '後台連結（創辦人）'), el('div', { class: 'linkbox' }, el('input', { type: 'text', readonly: true, value: adminUrl(r.id) }), el('button', { type: 'button', onclick: () => copyText(adminUrl(r.id)) }, '複製'))),
        el('div', { class: 'notice warn' }, '密碼不會另外寄給你，請自行記下。忘記密碼將無法進入後台。'),
        el('div', { class: 'btn-group' }, el('a', { class: 'btn primary', href: '#/e/' + r.id + '/admin' }, '進入後台'), el('a', { class: 'btn', href: '#/e/' + r.id }, '看填寫頁'))));
    }
    function showMsg(text, cls) { msg.replaceChildren(el('div', { class: 'notice ' + (cls || '') }, text)); msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }

    const form = el('form', { onsubmit: submit },
      el('div', { class: 'card' },
        el('h2', null, '1. 活動資訊'),
        el('div', { class: 'row' },
          field('活動名稱 *', inp('title', 'text', { required: true, maxlength: 80, placeholder: '例如：期末評圖時間調查' })),
          field('你的名字 / 單位', inp('creatorName', 'text', { maxlength: 40, placeholder: '會顯示在填寫頁' }))),
        el('div', { class: 'row' },
          field('創辦人密碼 *', inp('password', 'password', { required: true, minlength: 4, autocomplete: 'new-password' }), '只用在這個活動的後台，與其他帳號無關'),
          field('再輸入一次 *', inp('password2', 'password', { required: true, minlength: 4, autocomplete: 'new-password' }))),
        emailField,
        field('說明 / 公告（選填）', el('textarea', { maxlength: 1000, placeholder: '例如：評圖地點、注意事項、截止時間…', oninput: e => { st.description = e.target.value; } }), '填寫者打開頁面就會看到；建立後可在後台隨時修改。')),
      el('div', { class: 'card' },
        el('h2', null, '2. 時間範圍'),
        el('div', { class: 'row' },
          field('開始日期', inp('dateStart', 'date', { onchange: e => { st.dateStart = e.target.value; if (st.dateEnd < st.dateStart) st.dateEnd = st.dateStart; rebuildGrid(true); } })),
          field('結束日期', inp('dateEnd', 'date', { onchange: e => { st.dateEnd = e.target.value; rebuildGrid(true); } }), '最多 62 天'),
          field('時間刻度', modeSeg), hourRangeRow),
        el('h3', null, '勾選「可以選擇」的時段'),
        el('p', { class: 'muted' }, '預設只開放工作時間；填寫者只能在你開放的格子裡選。滑鼠拖曳可連續塗選，點日期可整欄切換。'),
        quick, el('div', { style: 'height:8px' }), gridHost, legend(el('span', null, el('i', { class: 'sw sel' }), '開放填寫'))),
      el('div', { class: 'card' },
        el('h2', null, '3. 顯示與通知'),
        el('div', { class: 'row' },
          el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: true, onchange: e => { st.showResults = e.target.checked; } }), '讓填寫者看到大家的交集（熱力圖）'),
          el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: true, onchange: e => { st.showNames = e.target.checked; } }), '顯示名單（關掉則只顯示人數）')),
        el('div', { class: 'row' }, field('通知方式', notifySel, CFG.BACKEND === 'local' ? '示範模式不會真的寄信' : '需要上面填 email'),
          field('Discord Webhook（選填）', inp('discordWebhook', 'text', { placeholder: 'https://discord.com/api/webhooks/…' }), '填了就同時推到 Discord 頻道')),
        msg,
        el('div', { class: 'btn-group' }, el('button', { type: 'submit', class: 'primary' }, '建立活動'))));
    app.replaceChildren(el('h1', null, '建立約時間活動'), form);
    rebuildGrid(true);
  }

  // #endregion //


  // #region // < 頁面 > 填寫畫面

  async function viewEvent(id) {
    app.replaceChildren(el('p', { class: 'muted' }, '載入中…'));
    const r = await api('getEvent', { id });
    if (!r.ok) return app.replaceChildren(el('div', { class: 'card narrow notice error' }, r.error));
    const ev = r.event; let others = r.participants || []; let total = r.participantCount || 0;
    const allowed = new Set(ev.allowed);
    let me = null; let session = sess('p:' + id); let selected = new Set(); let showHeat = ev.showResults; let hl = new Set(); let dirty = false;
    let extraSel = new Set(); // 補選模式下我在定案日期內的選擇（不動原本的 selected / me.slots）

    // 說明欄：每 60 秒與切回分頁時重新抓一次，讓填寫者看到最新公告
    const announceHost = el('div');
    const renderAnnounce = () => announceHost.replaceChildren(...[announceBox(ev)].filter(Boolean));
    renderAnnounce();
    const annTimer = setInterval(() => pollAnnounce(), 60000);
    const onVisible = () => { if (!document.hidden) pollAnnounce(); };
    document.addEventListener('visibilitychange', onVisible);
    async function pollAnnounce() {
      if (!announceHost.isConnected) { clearInterval(annTimer); document.removeEventListener('visibilitychange', onVisible); return; }
      const rr = await api('getEvent', { id });
      if (rr.ok && (rr.event.description !== ev.description || rr.event.descriptionAt !== ev.descriptionAt)) { ev.description = rr.event.description || ''; ev.descriptionAt = rr.event.descriptionAt || ''; renderAnnounce(); }
    }

    const head = el('div', { class: 'card' },
      el('h1', null, ev.title), ev.creatorName ? el('p', { class: 'muted' }, '主約人：' + ev.creatorName) : null,
      el('p', { class: 'muted' }, `${ev.dateStart} ～ ${ev.dateEnd}　·　目前 `, el('strong', { id: 'cnt' }, String(total)), ' 人已填寫'),
      announceHost,
      ev.finalSlots && ev.finalSlots.length ? el('div', { class: 'notice ok' }, el('strong', null, '★ 已定案：'), sortSlots(ev, ev.finalSlots).map(fmtSlot.bind(null, ev)).join('、'), ev.finalNote ? el('div', null, ev.finalNote) : null) : null,
      el('div', { class: 'linkbox' }, el('input', { type: 'text', readonly: true, value: eventUrl(id) }), el('button', { type: 'button', onclick: () => copyText(eventUrl(id)) }, '複製連結')));

    const loginMsg = el('div');
    let tab = 'new';
    const nameI = el('input', { type: 'text', maxlength: 40, required: true, placeholder: '例如：王小明 / 行銷部' });
    const pwI = el('input', { type: 'password', minlength: 4, required: true, autocomplete: 'off', placeholder: '至少 4 個字，只用於這個活動' });
    const emailI = el('input', { type: 'email', placeholder: '選填；主約人定案時可通知你' });
    const emailField = el('div', { class: 'field' }, el('label', null, 'Email'), emailI);
    const tabs = el('div', { class: 'tabs' },
      el('button', { type: 'button', class: 'active', onclick: e => { tab = 'new'; [...tabs.children].forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); emailField.classList.remove('hidden'); } }, '第一次填寫'),
      el('button', { type: 'button', onclick: e => { tab = 'login'; [...tabs.children].forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); emailField.classList.add('hidden'); } }, '修改我的選擇'));
    const loginCard = el('div', { class: 'card' }, el('h2', null, '我是誰？'), tabs,
      el('form', { onsubmit: async e => {
        e.preventDefault(); loginMsg.replaceChildren();
        const payload = { id, name: nameI.value.trim(), password: pwI.value, email: emailI.value.trim() };
        const rr = await api(tab === 'new' ? 'joinEvent' : 'loginParticipant', payload);
        if (!rr.ok) return loginMsg.replaceChildren(el('div', { class: 'notice error' }, rr.error));
        session = { name: payload.name, password: payload.password }; sess('p:' + id, session);
        await refresh(); mount();
      } },
        el('div', { class: 'row' }, el('div', { class: 'field' }, el('label', null, '姓名或單位 *'), nameI), el('div', { class: 'field' }, el('label', null, '密碼 *'), pwI), emailField),
        loginMsg, el('div', { class: 'btn-group' }, el('button', { type: 'submit', class: 'primary' }, '開始填寫'))));

    const gridHost = el('div'); const side = el('div', { class: 'side' }); const saveMsg = el('div');
    const myEmailI = el('input', { type: 'email', placeholder: '選填' });
    const myNoteI = el('textarea', { maxlength: 500, placeholder: '例如：我只有 12/03 上午可以；或需要提早離開…（選填）', oninput: () => { dirty = true; saveBtn.disabled = false; } });

    async function refresh() {
      if (session) {
        const rr = await api('loginParticipant', { id, name: session.name, password: session.password });
        if (rr.ok) { me = rr.participant; selected = new Set(me.slots); myEmailI.value = me.email || ''; myNoteI.value = me.note || ''; }
        else { session = null; sess('p:' + id, null); me = null; }
      }
      const rr2 = await api('getEvent', { id });
      if (rr2.ok) { others = rr2.participants || []; total = rr2.participantCount || 0; Object.assign(ev, rr2.event); }
      if (me) { // 補選的起始選擇：已補選過 → 用補選紀錄；還沒 → 以原本在定案日期內的選擇為底
        const dates = finalDates(ev); const inDates = s => dates.includes(parseSlot(s).date);
        extraSel = new Set((me.extraAt ? me.extraSlots : me.slots).filter(inDates));
      }
    }
    function render() {
      const cntEl = head.querySelector('#cnt'); if (cntEl) cntEl.textContent = String(total);
      const canSeeOthers = ev.showResults;
      const heat = canSeeOthers ? heatFrom(others) : null;
      const info = canSeeOthers ? hoverInfoBox(ev, heat, others) : null;
      const extra = inExtraMode(ev); // 補選模式：只顯示並只能編輯定案日期
      gridHost.replaceChildren(buildGrid({ event: ev, selected: me ? (extra ? extraSel : selected) : null, allowed, heat: (canSeeOthers && showHeat) ? heat : null, total,
        dates: extra ? finalDates(ev) : undefined,
        finalSet: new Set(ev.finalSlots || []), hlSet: hl, interactive: !!me, headerToggle: true,
        onChange: () => { dirty = true; saveBtn.disabled = false; }, onHover: info ? sid => info.update(sid) : null }));
      side.replaceChildren();
      if (canSeeOthers) {
        side.append(el('div', { class: 'box' }, el('h3', null, '誰有空？'), info.node));
        side.append(el('div', { class: 'box' }, el('h3', null, '最多人有空的時段'), topSlots(ev, heat, total)));
        side.append(el('div', { class: 'box' }, el('h3', null, `已填寫（${others.length}）`), el('ul', null, others.map(p => el('li', { class: hl.size && p.slots.every(s => hl.has(s)) && hl.size === p.slots.length ? 'active' : '', onclick: () => { const same = hl.size === p.slots.length && p.slots.every(s => hl.has(s)); hl = same ? new Set() : new Set(p.slots); render(); } }, el('span', null, p.name), el('span', { class: 'meta' }, p.slots.length + ' 格'))))),
          el('small', null, '點名字可在格子上標示該人的空檔。'));
      } else side.append(el('div', { class: 'box muted' }, '主約人目前未公開其他人的選擇。'));
    }
    const saveBtn = el('button', { type: 'button', class: 'primary', disabled: true, onclick: async () => {
      saveBtn.disabled = true; saveMsg.replaceChildren();
      const extra = inExtraMode(ev);
      const rr = await api(extra ? 'saveExtraSlots' : 'saveSlots', { id, name: session.name, password: session.password, slots: [...(extra ? extraSel : selected)], email: myEmailI.value.trim(), note: myNoteI.value.trim() });
      if (!rr.ok) { saveBtn.disabled = false; return saveMsg.replaceChildren(el('div', { class: 'notice error' }, rr.error)); }
      dirty = false; toast(extra ? '補選已儲存' : '已儲存'); await refresh(); render();
    } }, '儲存我的空檔');
    const heatToggle = el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: showHeat, onchange: e => { showHeat = e.target.checked; render(); } }), '疊上大家的空檔');

    function mount() {
      const extra = inExtraMode(ev);
      saveBtn.textContent = extra ? '儲存補選' : '儲存我的空檔';
      const fillCard = el('div', { class: 'card' },
        extra ? el('div', { class: 'notice warn' }, el('strong', null, '補選中：'), `主約人已定案，只開放在 ${finalDates(ev).map(fmtDateShort).join('、')} 重新選擇你有空的時段；其他日期原本填寫的紀錄會保留。沒填過的人也可以直接補選。`) : null,
        me ? el('div', { class: 'row', style: 'justify-content:space-between;align-items:center' },
          el('div', { class: 'grow-0' }, el('strong', null, me.name), el('span', { class: 'muted' }, extra ? '　把這幾天你有空的時段塗起來（拖曳可連選，再點一次可取消），然後按儲存補選。' : '　把你有空的時段塗起來（拖曳可連選），然後按儲存。')),
          el('div', { class: 'grow-0 btn-group' }, ev.showResults ? heatToggle : null, el('button', { type: 'button', class: 'small', onclick: () => { if (dirty && !confirm('尚未儲存，確定登出？')) return; session = null; me = null; sess('p:' + id, null); mount(); } }, '登出')))
          : el('p', { class: 'muted' }, ev.showResults ? '下方是目前大家的空檔，登入後即可填寫自己的。' : '登入後即可填寫。'),
        el('div', { class: 'split' }, el('div', null, gridHost, legend(el('span', null, el('i', { class: 'sw sel' }), '我有空'), ev.showResults ? heatLegend() : null)), side),
        me ? el('div', { class: 'field', style: 'margin-top:14px' }, el('label', null, '備註：其他時間需求（選填，只有主約人看得到）'), myNoteI) : null,
        me ? el('div', { class: 'row', style: 'margin-top:14px' }, el('div', { class: 'field' }, el('label', null, '我的 email（選填，定案時通知我）'), myEmailI), el('div', { class: 'grow-0 btn-group' }, saveBtn)) : null, saveMsg);
      app.replaceChildren(...[head, me ? null : loginCard, fillCard].filter(Boolean));
      render();
    }
    await refresh(); mount();
    window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  // #endregion //


  // #region // < 頁面 > 管理員後台

  async function viewAdmin(id) {
    app.replaceChildren(el('p', { class: 'muted' }, '載入中…'));
    let session = sess('admin:' + id); let data = null;
    async function login(pw) { const rr = await api('adminLogin', { id, password: pw }); if (rr.ok) { data = rr; session = { password: pw }; sess('admin:' + id, session); } return rr; }
    if (session) { const rr = await login(session.password); if (!rr.ok) { session = null; sess('admin:' + id, null); } }
    if (!session) {
      const pwI = el('input', { type: 'password', required: true, autocomplete: 'off' }); const m = el('div');
      return app.replaceChildren(el('div', { class: 'card narrow' }, el('h2', null, '創辦人後台'), el('p', { class: 'muted' }, '請輸入建立活動時設定的創辦人密碼。'),
        el('form', { onsubmit: async e => { e.preventDefault(); const rr = await login(pwI.value); if (!rr.ok) return m.replaceChildren(el('div', { class: 'notice error' }, rr.error)); viewAdmin(id); } },
          el('div', { class: 'field' }, el('label', null, '密碼'), pwI), m, el('button', { type: 'submit', class: 'primary' }, '進入後台')),
        el('p', null, el('a', { href: '#/e/' + id }, '← 回填寫頁'))));
    }

    let ev = data.event; let parts = data.participants; let hl = new Set(); let viewMode = 'heat'; // 'heat' | 'final'
    let finalSel = new Set(ev.finalSlots || []);
    const gridHost = el('div'); const side = el('div', { class: 'side' }); const statusLine = el('div');
    async function adminCall(action, payload, successMsg) {
      const rr = await api(action, Object.assign({ id, password: session.password }, payload));
      if (!rr.ok) { toast(rr.error); return rr; }
      if (rr.event) { ev = rr.event; parts = rr.participants; }
      if (successMsg) toast(successMsg);
      return rr;
    }
    function renderGrid() {
      const heat = heatFrom(parts); const info = hoverInfoBox(ev, heat, parts);
      const allowed = new Set(ev.allowed);
      gridHost.replaceChildren(buildGrid({ event: ev, selected: viewMode === 'final' ? finalSel : null, allowed, heat, total: parts.length,
        finalSet: viewMode === 'heat' ? new Set(ev.finalSlots || []) : null, hlSet: hl, interactive: viewMode === 'final', onHover: sid => info.update(sid),
        onChange: () => { finalBtns.classList.remove('hidden'); } }));
      side.replaceChildren(
        el('div', { class: 'box' }, el('h3', null, '誰有空？'), info.node),
        el('div', { class: 'box' }, el('h3', null, '最多人有空的時段'), topSlots(ev, heat, parts.length, 8)),
        el('div', { class: 'box' }, el('h3', null, `已填寫（${parts.length}）`),
          el('ul', null, parts.map(p => el('li', { class: hl.size && hl.size === p.slots.length && p.slots.every(s => hl.has(s)) ? 'active' : '', onclick: () => { const same = hl.size === p.slots.length && p.slots.every(s => hl.has(s)); hl = same ? new Set() : new Set(p.slots); renderGrid(); } },
            el('span', null, p.name, p.email ? el('span', { class: 'meta' }, ' · ' + p.email) : null, p.note ? el('span', { class: 'p-note' }, '📝 ' + p.note) : null),
            el('span', { class: 'btn-group' }, ev.extraOpen ? el('span', { class: 'meta' }, p.extraAt ? '已補選' : '未補選') : null, el('span', { class: 'meta' }, p.slots.length + ' 格'), el('button', { type: 'button', class: 'small danger', title: '刪除此人', onclick: async e => { e.stopPropagation(); if (!confirm(`確定刪除「${p.name}」的填寫資料？`)) return; await adminCall('adminDeleteParticipant', { name: p.name }, '已刪除'); hl = new Set(); renderGrid(); } }, '✕'))))),
          el('small', null, '點名字可標示該人的空檔；✕ 可刪除該人。')));
    }
    const finalBtns = el('div', { class: 'btn-group hidden' },
      el('button', { type: 'button', class: 'primary', onclick: async () => { await adminCall('adminUpdate', { patch: { finalSlots: [...finalSel] } }, '定案時段已儲存'); finalBtns.classList.add('hidden'); renderGrid(); refreshFinalNotice(); } }, '儲存定案時段'),
      el('button', { type: 'button', onclick: () => { finalSel = new Set(ev.finalSlots || []); finalBtns.classList.add('hidden'); renderGrid(); } }, '還原'));
    const modeSeg = el('div', { class: 'seg' },
      el('button', { type: 'button', class: 'active', onclick: e => { viewMode = 'heat'; segActivate(e); renderGrid(); } }, '查看交集'),
      el('button', { type: 'button', onclick: e => { viewMode = 'final'; segActivate(e); renderGrid(); } }, '選擇定案時段 ★'));
    function segActivate(e) { [...e.currentTarget.parentNode.children].forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); }

    // ---- 說明欄（公告）----
    const descI = el('textarea', { maxlength: 1000, placeholder: '例如：評圖地點、注意事項、截止時間…（留空則填寫頁不顯示）' }, ev.description || '');
    const descPreview = el('div'); const descStamp = el('span', { class: 'meta' });
    function refreshDesc() { descStamp.textContent = ev.descriptionAt ? '目前公告更新於 ' + fmtStamp(ev.descriptionAt) : '目前沒有公告'; descPreview.replaceChildren(...[announceBox(ev)].filter(Boolean)); }
    const descCard = el('div', { class: 'card' }, el('h2', null, '說明欄（公告）'),
      el('p', { class: 'muted' }, '填寫者打開填寫頁就會看到，儲存後他們的頁面會在 1 分鐘內（或切回分頁時）自動更新。'),
      el('div', { class: 'field' }, descI),
      el('div', { class: 'btn-group' }, el('button', { type: 'button', class: 'primary', onclick: async () => {
        const rr = await adminCall('adminUpdate', { patch: { description: descI.value.trim() } }, '公告已更新');
        if (rr.ok) { descI.value = ev.description || ''; refreshDesc(); }
      } }, '儲存公告'), descStamp), descPreview);
    refreshDesc();

    // ---- 設定表單 ----
    const f = {};
    const mk = (key, type, attrs) => (f[key] = el('input', Object.assign({ type, value: ev[key] || '' }, attrs || {})));
    const notifySel = el('select', null, el('option', { value: 'none' }, '不通知'), el('option', { value: 'instant' }, '每次有人填寫 / 修改就寄 email'), el('option', { value: 'daily' }, '每天寄一封摘要 email')); notifySel.value = ev.notifyMode || 'none';
    const showResultsI = el('input', { type: 'checkbox', checked: ev.showResults }); const showNamesI = el('input', { type: 'checkbox', checked: ev.showNames });
    const extraOpenI = el('input', { type: 'checkbox', checked: !!ev.extraOpen });
    const settingsMsg = el('div');
    const settingsCard = el('div', { class: 'card' }, el('h2', null, '設定'),
      el('form', { onsubmit: async e => {
        e.preventDefault(); settingsMsg.replaceChildren();
        const patch = { title: f.title.value.trim(), creatorName: f.creatorName.value.trim(), creatorEmail: f.creatorEmail.value.trim(), notifyMode: notifySel.value, discordWebhook: f.discordWebhook.value.trim(), showResults: showResultsI.checked, showNames: showNamesI.checked, finalNote: f.finalNote.value.trim(), extraOpen: extraOpenI.checked };
        if (f.newPassword.value) patch.newPassword = f.newPassword.value;
        const rr = await adminCall('adminUpdate', { patch }, '設定已儲存');
        if (!rr.ok) { extraOpenI.checked = !!ev.extraOpen; return settingsMsg.replaceChildren(el('div', { class: 'notice error' }, rr.error)); }
        if (patch.newPassword) { session = { password: patch.newPassword }; sess('admin:' + id, session); f.newPassword.value = ''; }
        titleH.textContent = ev.title; renderGrid(); refreshFinalNotice();
      } },
        el('div', { class: 'row' }, el('div', { class: 'field' }, el('label', null, '活動名稱'), mk('title', 'text', { required: true, maxlength: 80 })), el('div', { class: 'field' }, el('label', null, '主約人名稱'), mk('creatorName', 'text', { maxlength: 40 }))),
        el('div', { class: 'row' }, el('div', { class: 'field' }, el('label', null, '創辦人 email'), mk('creatorEmail', 'email')), el('div', { class: 'field' }, el('label', null, '通知方式'), notifySel), el('div', { class: 'field' }, el('label', null, 'Discord Webhook'), mk('discordWebhook', 'text', { placeholder: '選填' }))),
        el('div', { class: 'row' }, el('label', { class: 'toggle' }, showResultsI, '讓填寫者看到大家的交集'), el('label', { class: 'toggle' }, showNamesI, '顯示名單（關掉則填寫者只看到人數）')),
        el('div', { class: 'row' }, el('label', { class: 'toggle' }, extraOpenI, '開放補選：填寫者只能在「定案時段所在的日期」重新選擇（需先儲存定案時段；其他日期原本的紀錄會保留，關閉後恢復一般填寫）')),
        el('div', { class: 'row' }, el('div', { class: 'field' }, el('label', null, '定案附註（顯示在填寫頁與定案通知）'), mk('finalNote', 'text', { placeholder: '例如：地點在 302 教室' })), el('div', { class: 'field' }, el('label', null, '更改創辦人密碼'), mk('newPassword', 'password', { autocomplete: 'new-password', placeholder: '留空則不變' }))),
        settingsMsg, el('button', { type: 'submit', class: 'primary' }, '儲存設定')));

    // ---- 可選時段 ----
    let allowedSel = new Set(ev.allowed); let draft = { mode: ev.mode, hourStart: ev.hourStart, hourEnd: ev.hourEnd, dateStart: ev.dateStart, dateEnd: ev.dateEnd };
    const allowedHost = el('div'); const allowedMsg = el('div');
    function draftEvent() { return Object.assign({}, ev, draft); }
    function renderAllowed() { allowedHost.replaceChildren(buildGrid({ event: draftEvent(), selected: allowedSel, allowed: null, interactive: true, headerToggle: true })); }
    function slotsOutside(dev) { const valid = new Set(); for (const d of listDates(dev.dateStart, dev.dateEnd)) for (const r of rowsFor(dev)) valid.add(slotId(d, r.key)); return { allowedOut: [...allowedSel].filter(s => !valid.has(s)), partOut: parts.flatMap(p => p.slots.filter(s => !valid.has(s)).map(s => ({ name: p.name, s }))) }; }
    function tryRange(hs, he, e) {
      const dev = Object.assign(draftEvent(), { hourStart: hs, hourEnd: he }); const out = slotsOutside(dev);
      if (out.partOut.length) {
        const list = out.partOut.slice(0, 8).map(x => `${x.name}：${fmtSlot(ev, x.s)}`).join('\n');
        if (!confirm(`注意：有 ${out.partOut.length} 筆已填寫的空檔落在新範圍之外，縮小範圍後這些選擇會被刪除：\n\n${list}${out.partOut.length > 8 ? '\n…' : ''}\n\n確定要變更範圍嗎？`)) return;
      }
      draft.hourStart = hs; draft.hourEnd = he; segActivate(e);
      allowedSel = new Set([...allowedSel].filter(s => !out.allowedOut.includes(s))); renderAllowed();
    }
    const rangeSeg = el('div', { class: 'seg' },
      el('button', { type: 'button', class: ev.hourStart === CFG.DEFAULT_HOUR_START && ev.hourEnd === CFG.DEFAULT_HOUR_END ? 'active' : '', onclick: e => tryRange(CFG.DEFAULT_HOUR_START, CFG.DEFAULT_HOUR_END, e) }, `${pad2(CFG.DEFAULT_HOUR_START)}:00–${pad2(CFG.DEFAULT_HOUR_END)}:00`),
      el('button', { type: 'button', class: ev.hourStart === 0 && ev.hourEnd === 24 ? 'active' : '', onclick: e => tryRange(0, 24, e) }, '00:00–24:00'));
    const dateS = el('input', { type: 'date', value: ev.dateStart, onchange: e => { draft.dateStart = e.target.value; renderAllowed(); } });
    const dateE = el('input', { type: 'date', value: ev.dateEnd, onchange: e => { draft.dateEnd = e.target.value; renderAllowed(); } });
    const allowedCard = el('div', { class: 'card' }, el('h2', null, '可選時段'),
      el('p', { class: 'muted' }, '填寫者只能在開放的格子裡選。縮小開放範圍時，已填寫者落在範圍外的選擇會被移除（由創辦人承擔）。'),
      el('div', { class: 'row' }, el('div', { class: 'field' }, el('label', null, '開始日期'), dateS), el('div', { class: 'field' }, el('label', null, '結束日期'), dateE),
        ev.mode === 'hour' ? el('div', { class: 'field' }, el('label', null, '顯示範圍'), rangeSeg) : null),
      el('div', { class: 'btn-group' },
        el('button', { type: 'button', class: 'small', onclick: () => { allowedSel = new Set(defaultAllowed(draftEvent())); renderAllowed(); } }, '預設：工作時間（不含午休、週末假日）'),
        el('button', { type: 'button', class: 'small', onclick: () => { allowedSel = new Set(); const dev = draftEvent(); for (const d of listDates(dev.dateStart, dev.dateEnd)) for (const r of rowsFor(dev)) allowedSel.add(slotId(d, r.key)); renderAllowed(); } }, '全部開放'),
        el('button', { type: 'button', class: 'small', onclick: () => { allowedSel = new Set(); renderAllowed(); } }, '全部清除')),
      el('div', { style: 'height:8px' }), allowedHost, legend(el('span', null, el('i', { class: 'sw sel' }), '開放填寫')), allowedMsg,
      el('div', { class: 'btn-group', style: 'margin-top:10px' },
        el('button', { type: 'button', class: 'primary', onclick: async () => {
          allowedMsg.replaceChildren();
          const dev = draftEvent(); const valid = new Set(); for (const d of listDates(dev.dateStart, dev.dateEnd)) for (const r of rowsFor(dev)) valid.add(slotId(d, r.key));
          const newAllowed = [...allowedSel].filter(s => valid.has(s));
          const lost = parts.flatMap(p => p.slots.filter(s => !newAllowed.includes(s)).map(s => `${p.name}：${fmtSlot(ev, s)}`));
          if (lost.length && !confirm(`有 ${lost.length} 筆已填寫的空檔不在新的開放範圍內，儲存後會被移除：\n\n${lost.slice(0, 8).join('\n')}${lost.length > 8 ? '\n…' : ''}\n\n確定儲存？`)) return;
          const rr = await adminCall('adminUpdate', { patch: { allowed: newAllowed, hourStart: draft.hourStart, hourEnd: draft.hourEnd, dateStart: draft.dateStart, dateEnd: draft.dateEnd } }, '可選時段已更新');
          if (!rr.ok) return allowedMsg.replaceChildren(el('div', { class: 'notice error' }, rr.error));
          if (rr.strippedSlots) allowedMsg.replaceChildren(el('div', { class: 'notice warn' }, `已移除 ${rr.strippedSlots} 筆範圍外的選擇。`));
          allowedSel = new Set(ev.allowed); finalSel = new Set(ev.finalSlots || []); renderGrid(); renderAllowed();
        } }, '儲存可選時段'),
        el('button', { type: 'button', onclick: () => { draft = { mode: ev.mode, hourStart: ev.hourStart, hourEnd: ev.hourEnd, dateStart: ev.dateStart, dateEnd: ev.dateEnd }; allowedSel = new Set(ev.allowed); dateS.value = ev.dateStart; dateE.value = ev.dateEnd; renderAllowed(); } }, '還原')));

    // ---- 定案通知 ----
    const finalNotice = el('div'); const notifyMsgI = el('textarea', { placeholder: '選填：附在信裡的話，例如「請準時出席，地點 302 教室」' }); const notifyOut = el('div');
    function refreshFinalNotice() {
      const emails = parts.filter(p => p.email).length;
      finalNotice.replaceChildren(ev.finalSlots && ev.finalSlots.length
        ? el('div', { class: 'notice ok' }, el('strong', null, '目前定案：'), sortSlots(ev, ev.finalSlots).map(s => fmtSlot(ev, s)).join('、'), ev.finalNote ? ` — ${ev.finalNote}` : '')
        : el('div', { class: 'notice' }, '尚未定案。切到上方「選擇定案時段 ★」在格子上點選後儲存。'),
        el('p', { class: 'muted' }, `已留 email 的填寫者：${emails} / ${parts.length} 人。`),
        ev.extraOpen ? el('p', { class: 'muted' }, `補選中（限 ${finalDates(ev).map(fmtDateShort).join('、')}）：已補選 ${parts.filter(p => p.extraAt).length} / ${parts.length} 人。定案通知會附上補選說明。`) : null);
    }
    const notifyCard = el('div', { class: 'card' }, el('h2', null, '定案與通知'), finalNotice,
      el('div', { class: 'field' }, el('label', null, '通知內容'), notifyMsgI),
      el('div', { class: 'btn-group' }, el('button', { type: 'button', onclick: async () => {
        if (!(ev.finalSlots && ev.finalSlots.length)) return toast('請先儲存定案時段');
        if (!confirm('確定寄送定案通知給所有有留 email 的填寫者？')) return;
        const rr = await adminCall('adminNotifyFinal', { message: notifyMsgI.value.trim() });
        if (rr.ok) notifyOut.replaceChildren(el('div', { class: 'notice ok' }, rr.demo ? `（示範模式）模擬寄出 ${rr.sent} 封` : `已寄出 ${rr.sent} 封`));
      } }, '寄送定案通知'), el('small', { class: 'muted' }, '這個功能不是每次都需要，不用就不用。')), notifyOut);

    const titleH = el('h1', null, ev.title);
    app.replaceChildren(
      el('div', { class: 'card' }, titleH, el('p', { class: 'muted' }, '創辦人後台　·　', el('a', { href: '#/e/' + id }, '前往填寫頁'), '　·　', el('a', { href: '#', onclick: e => { e.preventDefault(); sess('admin:' + id, null); viewAdmin(id); } }, '登出')),
        el('div', { class: 'row' },
          el('div', { class: 'field' }, el('label', null, '填寫連結（給大家）'), el('div', { class: 'linkbox' }, el('input', { type: 'text', readonly: true, value: eventUrl(id) }), el('button', { type: 'button', onclick: () => copyText(eventUrl(id)) }, '複製'))),
          el('div', { class: 'field' }, el('label', null, '後台連結（只給自己）'), el('div', { class: 'linkbox' }, el('input', { type: 'text', readonly: true, value: adminUrl(id) }), el('button', { type: 'button', onclick: () => copyText(adminUrl(id)) }, '複製'))))),
      el('div', { class: 'card' }, el('div', { class: 'row', style: 'justify-content:space-between;align-items:center' }, el('h2', { class: 'grow-0', style: 'margin:0' }, '大家的空檔'), el('div', { class: 'grow-0 btn-group' }, modeSeg, finalBtns)),
        el('p', { class: 'muted' }, '顏色越深代表越多人有空；格子上的數字是有空人數。★ 為定案時段。'),
        el('div', { class: 'split' }, el('div', null, gridHost, legend(heatLegend())), side)),
      descCard, settingsCard, allowedCard, notifyCard);
    renderGrid(); renderAllowed(); refreshFinalNotice();
  }

  // #endregion //




  // #region // 路由 Route ( 單頁應用 SPA )

  function route() {

    const h = location.hash || '#/new';
    let m;
    if ((m = h.match(/^#\/e\/([A-Za-z0-9_-]+)\/admin\/?$/))) return viewAdmin(m[1]);
    if ((m = h.match(/^#\/e\/([A-Za-z0-9_-]+)\/?$/))) return viewEvent(m[1]);

    return viewNew();

  }

  // #endregion //


  // #region // 啟動 Boot

  async function boot() {
    
    document.getElementById('siteName').textContent = CFG.SITE_NAME || '約時間'; document.title = CFG.SITE_NAME || '約時間';
    if (CFG.BACKEND === 'local') document.getElementById('demoBadge').classList.remove('hidden');
    if (CFG.REPO_URL) document.getElementById('repoLink').href = CFG.REPO_URL;
    try { const r = await fetch('holidays-tw.json', { cache: 'no-cache' }); const j = await r.json(); delete j._comment; HOLIDAYS = j; } catch (e) { console.warn('無法載入假日表', e); }
    window.addEventListener('hashchange', route); route();
  }

  boot();

  // #endregion //

})();
