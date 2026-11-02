/**
 * ============================================================
 *  約時間 — Google Apps Script 後端
 *  資料存在本試算表的兩個工作表：events、participants（另有 changes 供每日摘要用）
 *  部署方式見 backend-gas/README.md
 * ============================================================
 */

// ---------- 設定 ----------
const DIGEST_HOUR = 9;          // 每日摘要寄出的時間（小時，依試算表時區）
const MAX_DAYS = 62;            // 日期範圍上限
const EVENT_SHEET = 'events';
const PART_SHEET = 'participants';
const CHANGE_SHEET = 'changes';

// 新增欄位一律加在最右邊（readAll_ 依位置讀取）；舊工作表會在第一次使用時自動補上欄位標題，見 ensureColumns_
const EVENT_COLS = ['id', 'title', 'creatorName', 'creatorEmail', 'salt', 'pwHash', 'mode', 'hourStart', 'hourEnd', 'dateStart', 'dateEnd',
  'allowed', 'showResults', 'showNames', 'notifyMode', 'discordWebhook', 'finalSlots', 'finalNote', 'createdAt', 'updatedAt', 'extraOpen'];
const PART_COLS = ['eventId', 'name', 'email', 'salt', 'pwHash', 'slots', 'createdAt', 'updatedAt', 'extraSlots', 'extraAt'];
const CHANGE_COLS = ['eventId', 'name', 'action', 'at', 'sent'];

// ---------- 入口 ----------
function doGet() {
  return json_({ ok: true, service: '約時間 API', hint: '請用 POST 傳 JSON {action: ...}' });
}
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) { return json_({ ok: false, error: '請求不是合法 JSON' }); }
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const handler = HANDLERS[body.action];
    if (!handler) return json_({ ok: false, error: '未知的動作：' + body.action });
    return json_(handler(body));
  } catch (err) {
    return json_({ ok: false, error: '伺服器錯誤：' + err.message });
  } finally {
    lock.releaseLock();
  }
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- 初始化（第一次手動執行一次） ----------
function setup() {
  const ss = ss_();
  ensureSheet_(ss, EVENT_SHEET, EVENT_COLS);
  ensureSheet_(ss, PART_SHEET, PART_COLS);
  ensureSheet_(ss, CHANGE_SHEET, CHANGE_COLS);
  // 每日摘要觸發器（只建一個）
  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'sendDailyDigests');
  if (!exists) ScriptApp.newTrigger('sendDailyDigests').timeBased().atHour(DIGEST_HOUR).everyDays(1).create();
  Logger.log('設定完成：工作表與每日摘要觸發器已就緒。');
}
function ensureSheet_(ss, name, cols) {
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); }
  if (sh.getLastRow() === 0) { sh.appendRow(cols); sh.setFrozenRows(1); }
  else ensureColumns_(sh, cols);
}
/** 舊版工作表欄位比現在少時（例如升級前建立的），在最右邊補上欄位標題；既有資料不動 */
function ensureColumns_(sh, cols) {
  const have = sh.getLastColumn();
  if (have >= cols.length) return;
  if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
  sh.getRange(1, have + 1, 1, cols.length - have).setValues([cols.slice(have)]);
}
function colsOf_(name) { return name === EVENT_SHEET ? EVENT_COLS : name === PART_SHEET ? PART_COLS : CHANGE_COLS; }

// ---------- 試算表存取 ----------
/** 取得資料試算表：優先用指令碼屬性 SPREADSHEET_ID，否則用綁定的試算表 */
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('找不到資料試算表：請在「專案設定 → 指令碼屬性」新增 SPREADSHEET_ID（試算表網址 /d/ 後面那串）');
  return ss;
}
const checkedSheets_ = {};      // 每次請求每張工作表只檢查一次欄位
function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) { ensureSheet_(ss, name, colsOf_(name)); sh = ss.getSheetByName(name); }
  if (!checkedSheets_[name]) { ensureColumns_(sh, colsOf_(name)); checkedSheets_[name] = true; }
  return sh;
}
function readAll_(name, cols) {
  const sh = sheet_(name); const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  return values.map((row, i) => { const o = { _row: i + 2 }; cols.forEach((c, j) => { o[c] = row[j]; }); return o; });
}
function writeRow_(name, cols, rowIndex, obj) {
  const sh = sheet_(name); const row = cols.map(c => obj[c] === undefined ? '' : obj[c]);
  if (rowIndex) sh.getRange(rowIndex, 1, 1, cols.length).setValues([row]); else sh.appendRow(row);
}
function deleteRow_(name, rowIndex) { sheet_(name).deleteRow(rowIndex); }
function parseEvent_(r) {
  return Object.assign({}, r, {
    hourStart: Number(r.hourStart), hourEnd: Number(r.hourEnd),
    allowed: jsonArr_(r.allowed), finalSlots: jsonArr_(r.finalSlots),
    showResults: r.showResults === true || r.showResults === 'TRUE' || r.showResults === 'true',
    showNames: r.showNames === true || r.showNames === 'TRUE' || r.showNames === 'true',
    extraOpen: r.extraOpen === true || r.extraOpen === 'TRUE' || r.extraOpen === 'true',
    dateStart: dateStr_(r.dateStart), dateEnd: dateStr_(r.dateEnd), title: String(r.title), creatorName: String(r.creatorName || ''),
  });
}
function parseParticipant_(r) { return Object.assign({}, r, { slots: jsonArr_(r.slots), extraSlots: jsonArr_(r.extraSlots), extraAt: String(r.extraAt || ''), name: String(r.name), email: String(r.email || '') }); }
function jsonArr_(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function dateStr_(v) { if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd'); return String(v); }
function serializeEvent_(ev) { return Object.assign({}, ev, { allowed: JSON.stringify(ev.allowed), finalSlots: JSON.stringify(ev.finalSlots || []), showResults: ev.showResults ? 'TRUE' : 'FALSE', showNames: ev.showNames ? 'TRUE' : 'FALSE', extraOpen: ev.extraOpen ? 'TRUE' : 'FALSE' }); }
function serializeParticipant_(p) { return Object.assign({}, p, { slots: JSON.stringify(p.slots), extraSlots: JSON.stringify(p.extraSlots || []) }); }
function findEvent_(id) { const r = readAll_(EVENT_SHEET, EVENT_COLS).find(x => String(x.id) === String(id)); return r ? parseEvent_(r) : null; }
function listParticipants_(id) { return readAll_(PART_SHEET, PART_COLS).filter(x => String(x.eventId) === String(id)).map(parseParticipant_); }

// ---------- 工具 ----------
function now_() { return new Date().toISOString(); }
function randId_(n) { const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)]; return s; }
function sha256_(str) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return raw.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function hashPw_(salt, pw) { return sha256_(salt + ':' + pw); }
function fail_(msg) { return { ok: false, error: msg }; }
function uniq_(arr) { return Array.from(new Set(arr)); }
function publicEvent_(ev) {
  return { id: ev.id, title: ev.title, creatorName: ev.creatorName, mode: ev.mode, hourStart: ev.hourStart, hourEnd: ev.hourEnd, dateStart: ev.dateStart, dateEnd: ev.dateEnd,
    allowed: ev.allowed, showResults: ev.showResults, showNames: ev.showNames, finalSlots: ev.finalSlots || [], finalNote: String(ev.finalNote || ''), extraOpen: !!ev.extraOpen,
    createdAt: ev.createdAt, updatedAt: ev.updatedAt };
}
function adminEvent_(ev) { return Object.assign(publicEvent_(ev), { creatorEmail: String(ev.creatorEmail || ''), notifyMode: ev.notifyMode, discordWebhook: String(ev.discordWebhook || '') }); }

// ---- 補選（定案後在定案日期內重選）----
// 補選日期 = 定案時段所在的日期。填寫者有補選紀錄（extraAt 不為空）時，
// 有效空檔 = 「補選日期以外的原本空檔」+「補選日期內的補選空檔」；原本的 slots 不會被改動。
function slotDate_(s) { return String(s).split('|')[0]; }
function finalDates_(ev) { return uniq_((ev.finalSlots || []).map(slotDate_)).sort(); }
function effectiveSlots_(ev, p) {
  const dates = finalDates_(ev);
  if (!p.extraAt || !dates.length) return p.slots;
  const allowed = new Set(ev.allowed);
  const keep = p.slots.filter(s => dates.indexOf(slotDate_(s)) < 0);
  const extra = (p.extraSlots || []).filter(s => allowed.has(s) && dates.indexOf(slotDate_(s)) >= 0);
  return uniq_(keep.concat(extra)).sort();
}
function ownParticipant_(p) { return { name: p.name, email: p.email, slots: p.slots, extraSlots: p.extraSlots || [], extraAt: p.extraAt || '' }; }
function pubParticipants_(list, showNames, ev) { return list.map((p, i) => ({ name: showNames ? p.name : ('參與者 ' + (i + 1)), slots: effectiveSlots_(ev, p) })); }
function adminParticipants_(list, ev) { return list.map(p => ({ name: p.name, email: p.email, slots: effectiveSlots_(ev, p), extraSlots: p.extraSlots || [], extraAt: p.extraAt || '', createdAt: p.createdAt, updatedAt: p.updatedAt })); }
function validateEvent_(d) {
  if (!d.title || String(d.title).trim().length === 0) return '請輸入活動名稱'; if (String(d.title).length > 80) return '活動名稱太長';
  if (['hour', 'coarse'].indexOf(d.mode) < 0) return '時間刻度不正確';
  const hs = Number(d.hourStart), he = Number(d.hourEnd); if (!(hs >= 0 && he <= 24 && hs < he)) return '顯示小時範圍不正確';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dateStart || '') || !/^\d{4}-\d{2}-\d{2}$/.test(d.dateEnd || '')) return '日期格式不正確';
  if (d.dateStart > d.dateEnd) return '結束日期不可早於開始日期';
  const days = (new Date(d.dateEnd) - new Date(d.dateStart)) / 86400000 + 1; if (days > MAX_DAYS) return '日期範圍最多 ' + MAX_DAYS + ' 天';
  if (!Array.isArray(d.allowed)) return '可選時段格式不正確'; if (d.allowed.length === 0) return '請至少勾選一個可選時段';
  if (['none', 'instant', 'daily'].indexOf(d.notifyMode) < 0) return '通知方式不正確';
  if (d.notifyMode !== 'none' && !d.creatorEmail) return '要收通知就需要填 email';
  if (d.extraOpen && !(d.finalSlots && d.finalSlots.length)) return '開放補選需要先設定定案時段';
  return null;
}
function checkAdmin_(d) { const ev = findEvent_(d.id); if (!ev) return [null, fail_('找不到這個活動')]; if (ev.pwHash !== hashPw_(ev.salt, d.password || '')) return [null, fail_('創辦人密碼不正確')]; return [ev, null]; }

// ---------- 動作 ----------
const HANDLERS = {
  createEvent: function (d) {
    const err = validateEvent_(d); if (err) return fail_(err);
    if (!d.password || d.password.length < 4) return fail_('密碼至少 4 個字');
    const existing = readAll_(EVENT_SHEET, EVENT_COLS).map(r => String(r.id));
    let id; do { id = randId_(10); } while (existing.indexOf(id) >= 0);
    const salt = randId_(16);
    const ev = { id: id, title: String(d.title).trim(), creatorName: String(d.creatorName || '').trim(), creatorEmail: String(d.creatorEmail || '').trim(), salt: salt, pwHash: hashPw_(salt, d.password),
      mode: d.mode, hourStart: Number(d.hourStart), hourEnd: Number(d.hourEnd), dateStart: d.dateStart, dateEnd: d.dateEnd, allowed: uniq_(d.allowed), showResults: !!d.showResults, showNames: !!d.showNames,
      notifyMode: d.notifyMode, discordWebhook: String(d.discordWebhook || '').trim(), finalSlots: [], finalNote: '', extraOpen: false, createdAt: now_(), updatedAt: now_() };
    writeRow_(EVENT_SHEET, EVENT_COLS, null, serializeEvent_(ev));
    return { ok: true, id: id };
  },
  getEvent: function (d) {
    const ev = findEvent_(d.id); if (!ev) return fail_('找不到這個活動');
    const list = listParticipants_(d.id);
    const out = { ok: true, event: publicEvent_(ev), participantCount: list.length };
    if (ev.showResults) out.participants = pubParticipants_(list, ev.showNames, ev);
    return out;
  },
  joinEvent: function (d) {
    const ev = findEvent_(d.id); if (!ev) return fail_('找不到這個活動');
    const name = String(d.name || '').trim();
    if (!name) return fail_('請輸入姓名或單位'); if (name.length > 40) return fail_('名稱太長');
    if (!d.password || d.password.length < 4) return fail_('密碼至少 4 個字');
    if (listParticipants_(d.id).some(p => p.name === name)) return fail_('這個名稱已經有人用了；如果是你本人，請改用「修改我的選擇」登入');
    const salt = randId_(16);
    const p = { eventId: ev.id, name: name, email: String(d.email || '').trim(), salt: salt, pwHash: hashPw_(salt, d.password), slots: [], extraSlots: [], extraAt: '', createdAt: now_(), updatedAt: now_() };
    writeRow_(PART_SHEET, PART_COLS, null, serializeParticipant_(p));
    notifyChange_(ev, name, '加入了活動');
    return { ok: true, participant: ownParticipant_(p) };
  },
  loginParticipant: function (d) {
    const ev = findEvent_(d.id); if (!ev) return fail_('找不到這個活動');
    const p = listParticipants_(d.id).find(x => x.name === String(d.name || '').trim());
    if (!p || p.pwHash !== hashPw_(p.salt, d.password || '')) return fail_('名稱或密碼不正確');
    return { ok: true, participant: ownParticipant_(p) };
  },
  saveSlots: function (d) {
    const ev = findEvent_(d.id); if (!ev) return fail_('找不到這個活動');
    const p = listParticipants_(d.id).find(x => x.name === String(d.name || '').trim());
    if (!p || p.pwHash !== hashPw_(p.salt, d.password || '')) return fail_('名稱或密碼不正確');
    const allowed = new Set(ev.allowed);
    p.slots = uniq_((d.slots || []).filter(s => allowed.has(s)));
    if (d.email !== undefined) p.email = String(d.email).trim();
    p.updatedAt = now_();
    writeRow_(PART_SHEET, PART_COLS, p._row, serializeParticipant_(p));
    notifyChange_(ev, p.name, '更新了空檔（' + p.slots.length + ' 格）');
    return { ok: true, participant: ownParticipant_(p), notified: ev.notifyMode };
  },
  saveExtraSlots: function (d) {
    const ev = findEvent_(d.id); if (!ev) return fail_('找不到這個活動');
    const p = listParticipants_(d.id).find(x => x.name === String(d.name || '').trim());
    if (!p || p.pwHash !== hashPw_(p.salt, d.password || '')) return fail_('名稱或密碼不正確');
    if (!ev.extraOpen) return fail_('主約人目前沒有開放補選');
    const dates = finalDates_(ev);
    if (!dates.length) return fail_('尚未設定定案時段');
    const allowed = new Set(ev.allowed);
    p.extraSlots = uniq_((d.slots || []).filter(s => allowed.has(s) && dates.indexOf(slotDate_(s)) >= 0));
    p.extraAt = now_();
    if (d.email !== undefined) p.email = String(d.email).trim();
    p.updatedAt = now_();
    writeRow_(PART_SHEET, PART_COLS, p._row, serializeParticipant_(p));
    notifyChange_(ev, p.name, '補選了空檔（' + p.extraSlots.length + ' 格）');
    return { ok: true, participant: ownParticipant_(p), notified: ev.notifyMode };
  },
  adminLogin: function (d) {
    const [ev, err] = checkAdmin_(d); if (err) return err;
    return { ok: true, event: adminEvent_(ev), participants: adminParticipants_(listParticipants_(d.id), ev) };
  },
  adminUpdate: function (d) {
    const [ev, err] = checkAdmin_(d); if (err) return err;
    const patch = d.patch || {};
    const fields = ['title', 'creatorName', 'creatorEmail', 'mode', 'hourStart', 'hourEnd', 'dateStart', 'dateEnd', 'allowed', 'showResults', 'showNames', 'notifyMode', 'discordWebhook', 'finalSlots', 'finalNote', 'extraOpen'];
    const merged = Object.assign({}, ev); fields.forEach(f => { if (patch[f] !== undefined) merged[f] = patch[f]; });
    const verr = validateEvent_(merged); if (verr) return fail_(verr);
    fields.forEach(f => { if (patch[f] !== undefined) ev[f] = patch[f]; });
    ev.hourStart = Number(ev.hourStart); ev.hourEnd = Number(ev.hourEnd); ev.allowed = uniq_(ev.allowed); ev.extraOpen = !!ev.extraOpen;
    if (patch.newPassword) { if (String(patch.newPassword).length < 4) return fail_('密碼至少 4 個字'); ev.salt = randId_(16); ev.pwHash = hashPw_(ev.salt, patch.newPassword); }
    ev.updatedAt = now_();
    writeRow_(EVENT_SHEET, EVENT_COLS, ev._row, serializeEvent_(ev));
    const allowed = new Set(ev.allowed); let stripped = 0;
    listParticipants_(d.id).forEach(p => {
      const before = p.slots.length; const after = p.slots.filter(s => allowed.has(s));
      const eBefore = p.extraSlots.length; const eAfter = p.extraSlots.filter(s => allowed.has(s));
      if (after.length !== before || eAfter.length !== eBefore) { stripped += (before - after.length) + (eBefore - eAfter.length); p.slots = after; p.extraSlots = eAfter; p.updatedAt = now_(); writeRow_(PART_SHEET, PART_COLS, p._row, serializeParticipant_(p)); }
    });
    return { ok: true, event: adminEvent_(ev), participants: adminParticipants_(listParticipants_(d.id), ev), strippedSlots: stripped };
  },
  adminDeleteParticipant: function (d) {
    const [ev, err] = checkAdmin_(d); if (err) return err;
    const p = listParticipants_(d.id).find(x => x.name === String(d.name || ''));
    if (p) deleteRow_(PART_SHEET, p._row);
    return { ok: true, event: adminEvent_(ev), participants: adminParticipants_(listParticipants_(d.id), ev) };
  },
  adminNotifyFinal: function (d) {
    const [ev, err] = checkAdmin_(d); if (err) return err;
    if (!ev.finalSlots || !ev.finalSlots.length) return fail_('尚未設定定案時段');
    const emails = listParticipants_(d.id).map(p => p.email).filter(Boolean);
    const extraNote = ev.extraOpen ? '\n\n【開放補選】只限以下日期，請登入填寫頁重新選擇你有空的時段（其他日期原本填寫的紀錄會保留）：\n' + finalDates_(ev).join('、') : '';
    const body = '「' + ev.title + '」已定案：\n\n' + ev.finalSlots.map(fmtSlot_).join('\n') + (ev.finalNote ? '\n\n' + ev.finalNote : '') + (d.message ? '\n\n' + d.message : '') + extraNote + '\n\n查看：' + eventLink_(ev.id);
    emails.forEach(to => { try { MailApp.sendEmail({ to: to, subject: '【約時間】' + ev.title + ' 已定案', body: body, name: '約時間' }); } catch (e) { Logger.log('寄信失敗 ' + to + ': ' + e.message); } });
    return { ok: true, sent: emails.length };
  },
};

// ---------- 通知 ----------
function frontendBase_() {
  // 前端網址（用於信件連結），在「專案設定 → 指令碼屬性」設定 FRONTEND_URL，例如 https://你的帳號.github.io/when2meet-zh/
  return PropertiesService.getScriptProperties().getProperty('FRONTEND_URL') || '';
}
function eventLink_(id) { const b = frontendBase_(); return b ? b.replace(/\/?$/, '/') + '#/e/' + id : '（未設定 FRONTEND_URL）'; }
function adminLink_(id) { return eventLink_(id) + '/admin'; }
function fmtSlot_(s) {
  const parts = String(s).split('|'); const date = parts[0], key = parts[1];
  const names = { am: '上午', noon: '中午', pm: '下午', eve: '晚上' };
  return date + ' ' + (names[key] || (key + ':00–' + ('0' + (Number(key) + 1)).slice(-2) + ':00'));
}
function notifyChange_(ev, who, what) {
  const text = '【約時間】' + who + ' ' + what + ' — ' + ev.title;
  if (ev.discordWebhook) { try { UrlFetchApp.fetch(ev.discordWebhook, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ content: text + '\n' + adminLink_(ev.id) }), muteHttpExceptions: true }); } catch (e) { Logger.log('Discord 失敗: ' + e.message); } }
  if (ev.notifyMode === 'instant' && ev.creatorEmail) {
    try { MailApp.sendEmail({ to: ev.creatorEmail, subject: text, body: who + ' ' + what + '。\n\n後台：' + adminLink_(ev.id), name: '約時間' }); } catch (e) { Logger.log('寄信失敗: ' + e.message); }
  } else if (ev.notifyMode === 'daily') {
    writeRow_(CHANGE_SHEET, CHANGE_COLS, null, { eventId: ev.id, name: who, action: what, at: now_(), sent: 'FALSE' });
  }
}
/** 由時間觸發器每天呼叫：把未寄出的異動依活動彙整後寄給創辦人 */
function sendDailyDigests() {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const rows = readAll_(CHANGE_SHEET, CHANGE_COLS).filter(r => String(r.sent) !== 'TRUE');
    if (!rows.length) return;
    const byEvent = {}; rows.forEach(r => { (byEvent[r.eventId] = byEvent[r.eventId] || []).push(r); });
    const sh = sheet_(CHANGE_SHEET);
    Object.keys(byEvent).forEach(id => {
      const ev = findEvent_(id); const list = byEvent[id];
      if (ev && ev.creatorEmail && ev.notifyMode === 'daily') {
        const lines = list.map(r => '・' + r.name + ' ' + r.action + '（' + String(r.at).slice(0, 16).replace('T', ' ') + '）');
        const parts = listParticipants_(id);
        const body = '「' + ev.title + '」過去一天有 ' + list.length + ' 筆異動：\n\n' + lines.join('\n') + '\n\n目前共 ' + parts.length + ' 人填寫。\n後台：' + adminLink_(id);
        try { MailApp.sendEmail({ to: ev.creatorEmail, subject: '【約時間】每日摘要：' + ev.title, body: body, name: '約時間' }); } catch (e) { Logger.log('寄信失敗: ' + e.message); }
      }
      list.forEach(r => sh.getRange(r._row, CHANGE_COLS.indexOf('sent') + 1).setValue('TRUE'));
    });
  } finally { lock.releaseLock(); }
}
