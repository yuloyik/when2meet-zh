// ============================================================
//  示範模式後端：資料只存在瀏覽器 localStorage。
//  邏輯刻意與 backend-gas/Code.gs、backend-fastapi/main.py 一致，
//  可當成 API 合約的參考實作。
// ============================================================
(function () {
  const KEY = 'yueshijian:db';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || { events: {}, participants: {} }; }
    catch (e) { return { events: {}, participants: {} }; }
  }
  function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }
  function now() { return new Date().toISOString(); }
  function randId(n) {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = ''; const buf = new Uint8Array(n); crypto.getRandomValues(buf);
    for (let i = 0; i < n; i++) s += chars[buf[i] % chars.length];
    return s;
  }
  async function sha256(str) {
    if (crypto.subtle) {
      const data = new TextEncoder().encode(str);
      const hash = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return 'plain:' + str; // 非安全環境 (file://) 的退路
  }
  async function hashPw(salt, pw) { return sha256(salt + ':' + pw); }
  function fail(msg) { return { ok: false, error: msg }; }

  function publicEvent(ev) {
    return {
      id: ev.id, title: ev.title, creatorName: ev.creatorName, mode: ev.mode,
      hourStart: ev.hourStart, hourEnd: ev.hourEnd, dateStart: ev.dateStart, dateEnd: ev.dateEnd,
      allowed: ev.allowed, showResults: ev.showResults, showNames: ev.showNames,
      finalSlots: ev.finalSlots || [], finalNote: ev.finalNote || '', extraOpen: !!ev.extraOpen,
      createdAt: ev.createdAt, updatedAt: ev.updatedAt,
    };
  }
  function adminEvent(ev) {
    return Object.assign(publicEvent(ev), { creatorEmail: ev.creatorEmail, notifyMode: ev.notifyMode, discordWebhook: ev.discordWebhook || '' });
  }

  // ---- 補選（定案後在定案日期內重選）----
  // 補選日期 = 定案時段所在的日期。填寫者有補選紀錄（extraAt 不為空）時，
  // 有效空檔 = 「補選日期以外的原本空檔」+「補選日期內的補選空檔」；原本的 slots 不會被改動。
  function slotDate(s) { return String(s).split('|')[0]; }
  function finalDates(ev) { return Array.from(new Set((ev.finalSlots || []).map(slotDate))).sort(); }
  function effectiveSlots(ev, p) {
    const dates = finalDates(ev);
    if (!p.extraAt || !dates.length) return p.slots;
    const allowed = new Set(ev.allowed);
    const keep = p.slots.filter(s => !dates.includes(slotDate(s)));
    const extra = (p.extraSlots || []).filter(s => allowed.has(s) && dates.includes(slotDate(s)));
    return Array.from(new Set(keep.concat(extra))).sort();
  }
  function ownParticipant(p) {
    return { name: p.name, email: p.email || '', slots: p.slots, extraSlots: p.extraSlots || [], extraAt: p.extraAt || '' };
  }
  function pubParticipants(list, showNames, ev) {
    return list.map((p, i) => ({ name: showNames ? p.name : ('參與者 ' + (i + 1)), slots: effectiveSlots(ev, p) }));
  }
  function adminParticipants(list, ev) {
    return list.map(p => ({ name: p.name, email: p.email || '', slots: effectiveSlots(ev, p), extraSlots: p.extraSlots || [], extraAt: p.extraAt || '', createdAt: p.createdAt, updatedAt: p.updatedAt }));
  }
  function validateEventFields(d, partial) {
    if (!partial || d.title !== undefined) { if (!d.title || String(d.title).trim().length === 0) return '請輸入活動名稱'; if (d.title.length > 80) return '活動名稱太長'; }
    if (!partial || d.mode !== undefined) { if (!['hour', 'coarse'].includes(d.mode)) return '時間刻度不正確'; }
    if (!partial || d.hourStart !== undefined || d.hourEnd !== undefined) {
      const hs = Number(d.hourStart), he = Number(d.hourEnd);
      if (!(hs >= 0 && he <= 24 && hs < he)) return '顯示小時範圍不正確';
    }
    if (!partial || d.dateStart !== undefined || d.dateEnd !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dateStart || '') || !/^\d{4}-\d{2}-\d{2}$/.test(d.dateEnd || '')) return '日期格式不正確';
      if (d.dateStart > d.dateEnd) return '結束日期不可早於開始日期';
      const days = (new Date(d.dateEnd) - new Date(d.dateStart)) / 86400000 + 1;
      if (days > 62) return '日期範圍最多 62 天';
    }
    if (!partial || d.allowed !== undefined) { if (!Array.isArray(d.allowed)) return '可選時段格式不正確'; if (d.allowed.length === 0) return '請至少勾選一個可選時段'; }
    if (!partial || d.notifyMode !== undefined) { if (!['none', 'instant', 'daily'].includes(d.notifyMode)) return '通知方式不正確'; }
    if (d.extraOpen && !(d.finalSlots && d.finalSlots.length)) return '開放補選需要先設定定案時段';
    return null;
  }

  const handlers = {
    async createEvent(d) {
      const err = validateEventFields(d, false); if (err) return fail(err);
      if (!d.password || d.password.length < 4) return fail('密碼至少 4 個字');
      if (d.notifyMode !== 'none' && !d.creatorEmail) return fail('要收通知就需要填 email');
      const db = load();
      let id; do { id = randId(10); } while (db.events[id]);
      const salt = randId(16);
      const ev = {
        id, title: d.title.trim(), creatorName: (d.creatorName || '').trim(), creatorEmail: (d.creatorEmail || '').trim(),
        salt, pwHash: await hashPw(salt, d.password),
        mode: d.mode, hourStart: Number(d.hourStart), hourEnd: Number(d.hourEnd), dateStart: d.dateStart, dateEnd: d.dateEnd,
        allowed: Array.from(new Set(d.allowed)), showResults: !!d.showResults, showNames: !!d.showNames,
        notifyMode: d.notifyMode, discordWebhook: (d.discordWebhook || '').trim(), finalSlots: [], finalNote: '', extraOpen: false,
        createdAt: now(), updatedAt: now(),
      };
      db.events[id] = ev; db.participants[id] = []; save(db);
      return { ok: true, id };
    },
    async getEvent(d) {
      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      const list = db.participants[d.id] || [];
      const out = { ok: true, event: publicEvent(ev), participantCount: list.length };
      if (ev.showResults) out.participants = pubParticipants(list, ev.showNames, ev);
      return out;
    },
    async joinEvent(d) {
      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      const name = (d.name || '').trim();
      if (!name) return fail('請輸入姓名或單位'); if (name.length > 40) return fail('名稱太長');
      if (!d.password || d.password.length < 4) return fail('密碼至少 4 個字');
      const list = db.participants[d.id];
      if (list.some(p => p.name === name)) return fail('這個名稱已經有人用了；如果是你本人，請改用「修改我的選擇」登入');
      const salt = randId(16);
      const p = { name, email: (d.email || '').trim(), salt, pwHash: await hashPw(salt, d.password), slots: [], extraSlots: [], extraAt: '', createdAt: now(), updatedAt: now() };
      list.push(p); save(db);
      return { ok: true, participant: ownParticipant(p) };
    },
    async loginParticipant(d) {
      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      const p = (db.participants[d.id] || []).find(x => x.name === (d.name || '').trim());
      if (!p || p.pwHash !== await hashPw(p.salt, d.password || '')) return fail('名稱或密碼不正確');
      return { ok: true, participant: ownParticipant(p) };
    },
    async saveSlots(d) {
      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      const p = (db.participants[d.id] || []).find(x => x.name === (d.name || '').trim());
      if (!p || p.pwHash !== await hashPw(p.salt, d.password || '')) return fail('名稱或密碼不正確');
      const allowed = new Set(ev.allowed);
      p.slots = Array.from(new Set((d.slots || []).filter(s => allowed.has(s))));
      if (d.email !== undefined) p.email = String(d.email).trim();
      p.updatedAt = now(); save(db);
      // 真實後端會在這裡寄通知；示範模式只記錄
      console.info('[示範模式] 通知創辦人：', ev.creatorEmail, `${p.name} 更新了「${ev.title}」`);
      return { ok: true, participant: ownParticipant(p), notified: ev.notifyMode };
    },
    async saveExtraSlots(d) {
      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      const p = (db.participants[d.id] || []).find(x => x.name === (d.name || '').trim());
      if (!p || p.pwHash !== await hashPw(p.salt, d.password || '')) return fail('名稱或密碼不正確');
      if (!ev.extraOpen) return fail('主約人目前沒有開放補選');
      const dates = finalDates(ev);
      if (!dates.length) return fail('尚未設定定案時段');
      const allowed = new Set(ev.allowed);
      p.extraSlots = Array.from(new Set((d.slots || []).filter(s => allowed.has(s) && dates.includes(slotDate(s)))));
      p.extraAt = now();
      if (d.email !== undefined) p.email = String(d.email).trim();
      p.updatedAt = now(); save(db);
      console.info('[示範模式] 通知創辦人：', ev.creatorEmail, `${p.name} 補選了「${ev.title}」`);
      return { ok: true, participant: ownParticipant(p), notified: ev.notifyMode };
    },
    async adminLogin(d) {
      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      if (ev.pwHash !== await hashPw(ev.salt, d.password || '')) return fail('創辦人密碼不正確');
      return { ok: true, event: adminEvent(ev), participants: adminParticipants(db.participants[d.id] || [], ev) };
    },
    async adminUpdate(d) {
      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      if (ev.pwHash !== await hashPw(ev.salt, d.password || '')) return fail('創辦人密碼不正確');
      const patch = d.patch || {};
      const merged = Object.assign({}, ev, patch);
      const err = validateEventFields(merged, false); if (err) return fail(err);
      if (merged.notifyMode !== 'none' && !merged.creatorEmail) return fail('要收通知就需要填 email');
      const fields = ['title', 'creatorName', 'creatorEmail', 'mode', 'hourStart', 'hourEnd', 'dateStart', 'dateEnd', 'allowed', 'showResults', 'showNames', 'notifyMode', 'discordWebhook', 'finalSlots', 'finalNote', 'extraOpen'];
      for (const f of fields) if (patch[f] !== undefined) ev[f] = patch[f];
      ev.hourStart = Number(ev.hourStart); ev.hourEnd = Number(ev.hourEnd);
      ev.allowed = Array.from(new Set(ev.allowed));
      ev.extraOpen = !!ev.extraOpen;
      if (patch.newPassword) { if (patch.newPassword.length < 4) return fail('密碼至少 4 個字'); ev.salt = randId(16); ev.pwHash = await hashPw(ev.salt, patch.newPassword); }
      const allowed = new Set(ev.allowed);
      let stripped = 0;
      for (const p of db.participants[d.id] || []) {
        const before = p.slots.length; p.slots = p.slots.filter(s => allowed.has(s)); stripped += before - p.slots.length;
        const eBefore = (p.extraSlots || []).length; p.extraSlots = (p.extraSlots || []).filter(s => allowed.has(s)); stripped += eBefore - p.extraSlots.length;
      }
      ev.updatedAt = now(); save(db);
      return { ok: true, event: adminEvent(ev), participants: adminParticipants(db.participants[d.id] || [], ev), strippedSlots: stripped };
    },
    async adminDeleteParticipant(d) {
      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      if (ev.pwHash !== await hashPw(ev.salt, d.password || '')) return fail('創辦人密碼不正確');
      db.participants[d.id] = (db.participants[d.id] || []).filter(p => p.name !== d.name); save(db);
      return { ok: true, event: adminEvent(ev), participants: adminParticipants(db.participants[d.id], ev) };
    },
    async adminNotifyFinal(d) {
      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      if (ev.pwHash !== await hashPw(ev.salt, d.password || '')) return fail('創辦人密碼不正確');
      const emails = (db.participants[d.id] || []).map(p => p.email).filter(Boolean);
      console.info('[示範模式] 寄送定案通知給：', emails, d.message, ev.extraOpen ? '（附補選說明：' + finalDates(ev).join('、') + '）' : '');
      return { ok: true, sent: emails.length, demo: true };
    },
  };

  window.LocalBackend = async function (action, payload) {
    const h = handlers[action]; if (!h) return fail('未知的動作：' + action);
    try { return await h(payload || {}); } catch (e) { console.error(e); return fail('示範模式發生錯誤：' + e.message); }
  };
})();
