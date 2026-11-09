// backend-local.js

// [ 類別 ] 示範模式 ( 無架設後端 )
// [ 功能 ] 使用瀏覽器的 localStorage 作為資料庫，提供本地測試使用。

// p = participant（ 填寫者 ）
// d = data       （ 前端 ）
// s = slot       （ 時段 ）
// db = database  （ 資料庫 ）

(function () {

  // #region // 資料存取

  const KEY = 'yueshijian:db';

  function load() {

    try { return JSON.parse(localStorage.getItem(KEY)) || { events: {}, participants: {} }; }
    catch (e) { return { events: {}, participants: {} }; }

  }

  function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }
  function now() { return new Date().toISOString(); }

  // #endregion //


  // #region // ID & Password ( HASH )

  // 產生隨機 ID
  function randId(n) {

    // 字元表
    // ★ NOTE : 移除不容易辨識之字元 ( i l o 0 1 )
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';

    let s = ''; const buf = new Uint8Array(n); crypto.getRandomValues(buf);
    for (let i = 0; i < n; i++) s += chars[buf[i] % chars.length];
    return s;

  }

  // HASH 演算法 ( 密碼安全性 ) ( ★ 單向轉換 : Password -> HASH )
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

  // #endregion //


  // #region // 欄位類別

  // [ Public ] 顯示公開欄位
  function publicEvent(ev) {

    return {
      id: ev.id, title: ev.title, creatorName: ev.creatorName, mode: ev.mode,
      hourStart: ev.hourStart, hourEnd: ev.hourEnd, dateStart: ev.dateStart, dateEnd: ev.dateEnd,
      allowed: ev.allowed, showResults: ev.showResults, showNames: ev.showNames,
      finalSlots: ev.finalSlots || [], finalNote: ev.finalNote || '', extraOpen: !!ev.extraOpen,
      description: ev.description || '', descriptionAt: ev.descriptionAt || '',
      createdAt: ev.createdAt, updatedAt: ev.updatedAt,
    };

  }

  // [ Admin ] 顯示管理員欄位
  function adminEvent(ev) {

    return Object.assign(publicEvent(ev), { creatorEmail: ev.creatorEmail, notifyMode: ev.notifyMode, discordWebhook: ev.discordWebhook || '' });

  }

  // #endregion //


  // #region // 日期與時段

  function slotDate(s) { return String(s).split('|')[0]; }

  // 定案時段
  function finalDates(ev) { return Array.from(new Set((ev.finalSlots || []).map(slotDate))).sort(); }

  // 有效補選時段
  function effectiveSlots(ev, p) {

    const dates = finalDates(ev);
    if (!p.extraAt || !dates.length) return p.slots;
    const allowed = new Set(ev.allowed);
    const keep = p.slots.filter(s => !dates.includes(slotDate(s)));
    const extra = (p.extraSlots || []).filter(s => allowed.has(s) && dates.includes(slotDate(s)));
    return Array.from(new Set(keep.concat(extra))).sort();

  }

  // #endregion //


  // #region // 填寫者資訊

  function ownParticipant(p) {
    return { name: p.name, email: p.email || '', slots: p.slots, extraSlots: p.extraSlots || [], extraAt: p.extraAt || '' };
  }

  function pubParticipants(list, showNames, ev) {
    return list.map((p, i) => ({ name: showNames ? p.name : ('參與者 ' + (i + 1)), slots: effectiveSlots(ev, p) }));
  }

  function adminParticipants(list, ev) {
    return list.map(p => ({ name: p.name, email: p.email || '', slots: effectiveSlots(ev, p), extraSlots: p.extraSlots || [], extraAt: p.extraAt || '', createdAt: p.createdAt, updatedAt: p.updatedAt }));
  }

  // #endregion //


  // #region // 資料格式驗證
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
    if (d.description !== undefined && String(d.description).length > 1000) return '說明太長（最多 1000 字）';
    if (d.extraOpen && !(d.finalSlots && d.finalSlots.length)) return '開放補選需要先設定定案時段';
    
    return null;
  }

  // #endregion //


  // #region // 指令 ACTION

  const handlers = {

    // 建立活動
    async createEvent(d) {

      const err = validateEventFields(d, false); if (err) return fail(err);
      if (!d.password || d.password.length < 4) return fail('密碼需要超過 4 個字元');
      if (d.notifyMode !== 'none' && !d.creatorEmail) return fail('填寫 email 可即時接收通知');

      // 生成 ID
      const db = load();
      let id; do { id = randId(10); } while (db.events[id]);

      // 生成 SALT ( 密碼安全性 )
      const salt = randId(16);

      const ev = {
        id, title: d.title.trim(), creatorName: (d.creatorName || '').trim(), creatorEmail: (d.creatorEmail || '').trim(),
        salt, pwHash: await hashPw(salt, d.password),
        mode: d.mode, hourStart: Number(d.hourStart), hourEnd: Number(d.hourEnd), dateStart: d.dateStart, dateEnd: d.dateEnd,
        allowed: Array.from(new Set(d.allowed)), showResults: !!d.showResults, showNames: !!d.showNames,
        notifyMode: d.notifyMode, discordWebhook: (d.discordWebhook || '').trim(), finalSlots: [], finalNote: '', extraOpen: false,
        description: String(d.description || '').trim(), descriptionAt: String(d.description || '').trim() ? now() : '',
        createdAt: now(), updatedAt: now(),
      };

      db.events[id] = ev; db.participants[id] = []; save(db);
      return { ok: true, id };

    },

    // 取得活動資訊
    async getEvent(d) {

      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      const list = db.participants[d.id] || [];
      const out = { ok: true, event: publicEvent(ev), participantCount: list.length };

      if (ev.showResults) out.participants = pubParticipants(list, ev.showNames, ev);
      return out;

    },

    // 加入活動
    async joinEvent(d) {

      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');

      const name = (d.name || '').trim();
      if (!name) return fail('請輸入姓名或單位'); if (name.length > 40) return fail('名稱太長');

      if (!d.password || d.password.length < 4) return fail('密碼需要超過 4 個字元');

      const list = db.participants[d.id];
      if (list.some(p => p.name === name)) return fail('這個名稱已經有人用了；如果是你本人，請改用「修改我的選擇」登入');

      const salt = randId(16);

      const p = { name, email: (d.email || '').trim(), salt, pwHash: await hashPw(salt, d.password), slots: [], extraSlots: [], extraAt: '', createdAt: now(), updatedAt: now() };
      list.push(p); save(db);

      return { ok: true, participant: ownParticipant(p) };
    },

    // 填寫者登入
    async loginParticipant(d) {

      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      const p = (db.participants[d.id] || []).find(x => x.name === (d.name || '').trim());
      if (!p || p.pwHash !== await hashPw(p.salt, d.password || '')) return fail('名稱或密碼不正確');
      return { ok: true, participant: ownParticipant(p) };

    },

    // 儲存時段
    async saveSlots(d) {

      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      const p = (db.participants[d.id] || []).find(x => x.name === (d.name || '').trim());
      if (!p || p.pwHash !== await hashPw(p.salt, d.password || '')) return fail('名稱或密碼不正確');
      const allowed = new Set(ev.allowed);
      p.slots = Array.from(new Set((d.slots || []).filter(s => allowed.has(s))));
      if (d.email !== undefined) p.email = String(d.email).trim();
      p.updatedAt = now(); save(db);

      // NOTE : 真實後端會在這裡寄送通知 ( 示範模式僅會記錄資訊 )
      console.info('[示範模式] 通知創辦人：', ev.creatorEmail, `${p.name} 更新了「${ev.title}」`);
      return { ok: true, participant: ownParticipant(p), notified: ev.notifyMode };

    },

    // 儲存補選時段
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

    // [ Admin ] 管理員登入
    async adminLogin(d) {

      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      if (ev.pwHash !== await hashPw(ev.salt, d.password || '')) return fail('創辦人密碼不正確');
      return { ok: true, event: adminEvent(ev), participants: adminParticipants(db.participants[d.id] || [], ev) };

    },

    // [ Admin ] 更新活動資訊
    async adminUpdate(d) {

      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      if (ev.pwHash !== await hashPw(ev.salt, d.password || '')) return fail('創辦人密碼不正確');

      const patch = d.patch || {};
      const merged = Object.assign({}, ev, patch);

      const err = validateEventFields(merged, false); if (err) return fail(err);
      if (merged.notifyMode !== 'none' && !merged.creatorEmail) return fail('填寫 email 可即時接收通知');

      const fields = ['title', 'creatorName', 'creatorEmail', 'mode', 'hourStart', 'hourEnd', 'dateStart', 'dateEnd', 'allowed', 'showResults', 'showNames', 'notifyMode', 'discordWebhook', 'finalSlots', 'finalNote', 'extraOpen', 'description'];
      const oldDesc = String(ev.description || '');
      for (const f of fields) if (patch[f] !== undefined) ev[f] = patch[f];
      ev.description = String(ev.description || '').trim();
      if (ev.description !== oldDesc) ev.descriptionAt = ev.description ? now() : '';


      ev.hourStart = Number(ev.hourStart); ev.hourEnd = Number(ev.hourEnd);
      ev.allowed = Array.from(new Set(ev.allowed));
      ev.extraOpen = !!ev.extraOpen;


      if (patch.newPassword) { if (patch.newPassword.length < 4) return fail('密碼需要超過 4 個字元'); ev.salt = randId(16); ev.pwHash = await hashPw(ev.salt, patch.newPassword); }
      
      const allowed = new Set(ev.allowed);
      let stripped = 0;
      for (const p of db.participants[d.id] || []) {
        const before = p.slots.length; p.slots = p.slots.filter(s => allowed.has(s)); stripped += before - p.slots.length;
        const eBefore = (p.extraSlots || []).length; p.extraSlots = (p.extraSlots || []).filter(s => allowed.has(s)); stripped += eBefore - p.extraSlots.length;
      }


      ev.updatedAt = now(); save(db);

      return { ok: true, event: adminEvent(ev), participants: adminParticipants(db.participants[d.id] || [], ev), strippedSlots: stripped };

    },

    // [ Admin ] 刪除參與者
    async adminDeleteParticipant(d) {

      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      if (ev.pwHash !== await hashPw(ev.salt, d.password || '')) return fail('創辦人密碼不正確');
      db.participants[d.id] = (db.participants[d.id] || []).filter(p => p.name !== d.name); save(db);
      return { ok: true, event: adminEvent(ev), participants: adminParticipants(db.participants[d.id], ev) };

    },

    // [ Admin ] 寄送定案通知
    async adminNotifyFinal(d) {

      const db = load(); const ev = db.events[d.id]; if (!ev) return fail('找不到這個活動');
      if (ev.pwHash !== await hashPw(ev.salt, d.password || '')) return fail('創辦人密碼不正確');
      const emails = (db.participants[d.id] || []).map(p => p.email).filter(Boolean);
      console.info('[示範模式] 寄送定案通知給：', emails, d.message, ev.extraOpen ? '（附補選說明：' + finalDates(ev).join('、') + '）' : '');
      return { ok: true, sent: emails.length, demo: true };

    },
  };

  // #endregion //


  // #region // 對外入口

  window.LocalBackend = async function (action, payload) {
    const h = handlers[action]; if (!h) return fail('未知的動作：' + action);
    try { return await h(payload || {}); } catch (e) { console.error(e); return fail('示範模式發生錯誤：' + e.message); }
  };

  // #endregion //

})();
