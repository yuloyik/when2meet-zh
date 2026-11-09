/**
 * ============================================================
 *  約時間 — Google Apps Script 後端
 *  資料存在本試算表的兩個工作表：events、participants（另有 changes 供每日摘要用）
 *  部署方式見 backend-gas/README.md
 * ============================================================
 */

// [ 類別 ] Google Apps Script 後端 ( 試算表當資料庫 )
// [ 功能 ] 與 backend-local.js 邏輯一致，資料改存 Google 試算表，並提供真實的 email / Discord 通知。

// ev = event       ( 活動 )
// p  = participant ( 填寫者 )
// d  = data        ( 前端傳來的資料 )
// s  = slot        ( 時段 )
// sh = sheet       ( 工作表 )
// ss = spreadsheet ( 試算表 )
// ★ NOTE : 函式名稱結尾的底線 ( _ ) 代表內部函式，不會被外部呼叫

// #region // 設定

// 每日摘要寄出的整點
const DIGEST_HOUR = 9;          // 每日摘要寄出的時間（小時，依試算表時區）
// 日期範圍上限 ( 天 )
const MAX_DAYS = 62;            // 日期範圍上限
// 工作表名稱 ( 活動 / 填寫者 / 每日摘要待寄佇列 )
const EVENT_SHEET = 'events';
const PART_SHEET = 'participants';
const CHANGE_SHEET = 'changes';

// 新增欄位一律加在最右邊（readAll_ 依位置讀取）；舊工作表會在第一次使用時自動補上欄位標題，見 ensureColumns_
// [ events ] 活動欄位
const EVENT_COLS = ['id', 'title', 'creatorName', 'creatorEmail', 'salt', 'pwHash', 'mode', 'hourStart', 'hourEnd', 'dateStart', 'dateEnd',
  'allowed', 'showResults', 'showNames', 'notifyMode', 'discordWebhook', 'finalSlots', 'finalNote', 'createdAt', 'updatedAt', 'extraOpen', 'description', 'descriptionAt'];
// [ participants ] 填寫者欄位
const PART_COLS = ['eventId', 'name', 'email', 'salt', 'pwHash', 'slots', 'createdAt', 'updatedAt', 'extraSlots', 'extraAt'];
// [ changes ] 每日摘要的待寄異動
const CHANGE_COLS = ['eventId', 'name', 'action', 'at', 'sent'];


// #endregion //

// #region // 入口 ( doGet / doPost )

// 直接開網址 ( GET ) 時的說明
function doGet() {
  return json_({ ok: true, service: '約時間 API', hint: '請用 POST 傳 JSON {action: ...}' });
}
// 唯一入口 ( POST )：依 action 找處理函式，並在寫入鎖內執行
// NOTE : 前端以 text/plain 送 JSON ( 避免 CORS 預檢 )，所以這裡手動 JSON.parse
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) { return json_({ ok: false, error: '請求不是合法 JSON' }); }
  // 寫入鎖 ( 同一時間只讓一個請求執行 )，對應 FastAPI 的 _db_lock
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
// 回傳 JSON
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}


// #endregion //

// #region // 初始化 ( setup )

// NOTE : 部署後要手動執行一次 ( 建立工作表 + 每日摘要觸發器 )
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
// 建立工作表 ( 不存在才建立 )
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
// 工作表名稱 → 欄位定義
function colsOf_(name) { return name === EVENT_SHEET ? EVENT_COLS : name === PART_SHEET ? PART_COLS : CHANGE_COLS; }


// #endregion //

// #region // 資料存取 ( 讀寫試算表 )

/** 取得資料試算表：優先用指令碼屬性 SPREADSHEET_ID，否則用綁定的試算表 */
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('找不到資料試算表：請在「專案設定 → 指令碼屬性」新增 SPREADSHEET_ID（試算表網址 /d/ 後面那串）');
  return ss;
}
const checkedSheets_ = {};      // 每次請求每張工作表只檢查一次欄位
// 取得工作表 ( 不存在就建立，並補齊欄位 )
function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) { ensureSheet_(ss, name, colsOf_(name)); sh = ss.getSheetByName(name); }
  if (!checkedSheets_[name]) { ensureColumns_(sh, colsOf_(name)); checkedSheets_[name] = true; }
  return sh;
}
// 讀出整張表，每列轉成物件 ( _row = 第幾列 )
function readAll_(name, cols) {
  const sh = sheet_(name); const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  return values.map((row, i) => { const o = { _row: i + 2 }; cols.forEach((c, j) => { o[c] = row[j]; }); return o; });
}
// 寫入一列 ( 有 rowIndex 就覆蓋，沒有就新增到最後 )
function writeRow_(name, cols, rowIndex, obj) {
  const sh = sheet_(name); const row = cols.map(c => obj[c] === undefined ? '' : obj[c]);
  if (rowIndex) sh.getRange(rowIndex, 1, 1, cols.length).setValues([row]); else sh.appendRow(row);
}
// 刪除一列
function deleteRow_(name, rowIndex) { sheet_(name).deleteRow(rowIndex); }
// 資料列 → 活動物件 ( 文字還原成陣列 / 布林 / 日期 )
function parseEvent_(r) {
  return Object.assign({}, r, {
    hourStart: Number(r.hourStart), hourEnd: Number(r.hourEnd),
    allowed: jsonArr_(r.allowed), finalSlots: jsonArr_(r.finalSlots),
    showResults: r.showResults === true || r.showResults === 'TRUE' || r.showResults === 'true',
    showNames: r.showNames === true || r.showNames === 'TRUE' || r.showNames === 'true',
    extraOpen: r.extraOpen === true || r.extraOpen === 'TRUE' || r.extraOpen === 'true',
    dateStart: dateStr_(r.dateStart), dateEnd: dateStr_(r.dateEnd), title: String(r.title), creatorName: String(r.creatorName || ''),
    description: descStr_(r.description), descriptionAt: String(r.descriptionAt || ''),
  });
}
// 資料列 → 填寫者物件
function parseParticipant_(r) { return Object.assign({}, r, { slots: jsonArr_(r.slots), extraSlots: jsonArr_(r.extraSlots), extraAt: String(r.extraAt || ''), name: String(r.name), email: String(r.email || '') }); }
// 說明欄：存成 JSON 字串 ( 避免換行 / 開頭是 = 時被試算表當成公式 )，讀出時還原
function descStr_(v) { if (v === '' || v === undefined || v === null) return ''; try { const s = JSON.parse(v); return typeof s === 'string' ? s : String(v); } catch (e) { return String(v); } }
// JSON 文字 → 陣列 ( 失敗就回傳空陣列 )
function jsonArr_(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
// 日期 → YYYY-MM-DD 文字 ( Sheets 會自動把日期轉成日期物件 )
function dateStr_(v) { if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd'); return String(v); }
// 物件 → 儲存格格式 ( 陣列轉 JSON 文字、布林轉 TRUE / FALSE )
function serializeEvent_(ev) { return Object.assign({}, ev, { allowed: JSON.stringify(ev.allowed), finalSlots: JSON.stringify(ev.finalSlots || []), showResults: ev.showResults ? 'TRUE' : 'FALSE', showNames: ev.showNames ? 'TRUE' : 'FALSE', extraOpen: ev.extraOpen ? 'TRUE' : 'FALSE', description: JSON.stringify(String(ev.description || '')) }); }
function serializeParticipant_(p) { return Object.assign({}, p, { slots: JSON.stringify(p.slots), extraSlots: JSON.stringify(p.extraSlots || []) }); }
// 依 ID 找活動
function findEvent_(id) { const r = readAll_(EVENT_SHEET, EVENT_COLS).find(x => String(x.id) === String(id)); return r ? parseEvent_(r) : null; }
// 取得活動的所有填寫者
function listParticipants_(id) { return readAll_(PART_SHEET, PART_COLS).filter(x => String(x.eventId) === String(id)).map(parseParticipant_); }


// #endregion //

// #region // 時間 / ID & Password ( HASH )

// 現在時間 ( UTC )
function now_() { return new Date().toISOString(); }
// 產生隨機 ID
// ★ NOTE : 移除不容易辨識之字元 ( i l o 0 1 )
// NOTE : GAS 沒有 crypto.getRandomValues，這裡用 Math.random()
function randId_(n) { const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)]; return s; }
// HASH 演算法 ( 密碼安全性 ) ( ★ 單向轉換 : Password -> HASH )
// NOTE : computeDigest 回傳有號位元組 ( 可能為負 )，要 & 0xff 轉成 0~255
function sha256_(str) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return raw.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
// 與 backend-local.js 相同：sha256( salt + ":" + 密碼 )
function hashPw_(salt, pw) { return sha256_(salt + ':' + pw); }
// 失敗回應格式
function fail_(msg) { return { ok: false, error: msg }; }
// 陣列去重
function uniq_(arr) { return Array.from(new Set(arr)); }


// #endregion //
// #region // 欄位類別

// [ Public ] 顯示公開欄位
function publicEvent_(ev) {
  return { id: ev.id, title: ev.title, creatorName: ev.creatorName, mode: ev.mode, hourStart: ev.hourStart, hourEnd: ev.hourEnd, dateStart: ev.dateStart, dateEnd: ev.dateEnd,
    allowed: ev.allowed, showResults: ev.showResults, showNames: ev.showNames, finalSlots: ev.finalSlots || [], finalNote: String(ev.finalNote || ''), extraOpen: !!ev.extraOpen, description: String(ev.description || ''), descriptionAt: String(ev.descriptionAt || ''),
    createdAt: ev.createdAt, updatedAt: ev.updatedAt };
}
// [ Admin ] 顯示管理員欄位
function adminEvent_(ev) { return Object.assign(publicEvent_(ev), { creatorEmail: String(ev.creatorEmail || ''), notifyMode: ev.notifyMode, discordWebhook: String(ev.discordWebhook || '') }); }


// #endregion //

// #region // 日期與時段 ( 含補選 )

// ---- 補選（定案後在定案日期內重選）----
// 補選日期 = 定案時段所在的日期。填寫者有補選紀錄（extraAt 不為空）時，
// 有效空檔 = 「補選日期以外的原本空檔」+「補選日期內的補選空檔」；原本的 slots 不會被改動。
function slotDate_(s) { return String(s).split('|')[0]; }
// 定案時段
function finalDates_(ev) { return uniq_((ev.finalSlots || []).map(slotDate_)).sort(); }
// 有效補選時段
function effectiveSlots_(ev, p) {
  const dates = finalDates_(ev);
  if (!p.extraAt || !dates.length) return p.slots;
  const allowed = new Set(ev.allowed);
  const keep = p.slots.filter(s => dates.indexOf(slotDate_(s)) < 0);
  const extra = (p.extraSlots || []).filter(s => allowed.has(s) && dates.indexOf(slotDate_(s)) >= 0);
  return uniq_(keep.concat(extra)).sort();
}


// #endregion //
// #region // 填寫者資訊

// 填寫者自己看到的資料 ( 原本的 slots，不含補選合併 )
function ownParticipant_(p) { return { name: p.name, email: p.email, slots: p.slots, extraSlots: p.extraSlots || [], extraAt: p.extraAt || '' }; }
// [ Public ] 顯示填寫者清單 ( 關閉名單時顯示「參與者 N」，空檔為有效空檔 )
function pubParticipants_(list, showNames, ev) { return list.map((p, i) => ({ name: showNames ? p.name : ('參與者 ' + (i + 1)), slots: effectiveSlots_(ev, p) })); }
// [ Admin ] 顯示填寫者清單 ( 含 email、補選紀錄 )
function adminParticipants_(list, ev) { return list.map(p => ({ name: p.name, email: p.email, slots: effectiveSlots_(ev, p), extraSlots: p.extraSlots || [], extraAt: p.extraAt || '', createdAt: p.createdAt, updatedAt: p.updatedAt })); }


// #endregion //
// #region // 資料格式驗證

// 活動欄位驗證 ( 建立 / 修改活動時共用 )
function validateEvent_(d) {
  if (!d.title || String(d.title).trim().length === 0) return '請輸入活動名稱'; if (String(d.title).length > 80) return '活動名稱太長';
  if (['hour', 'coarse'].indexOf(d.mode) < 0) return '時間刻度不正確';
  const hs = Number(d.hourStart), he = Number(d.hourEnd); if (!(hs >= 0 && he <= 24 && hs < he)) return '顯示小時範圍不正確';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dateStart || '') || !/^\d{4}-\d{2}-\d{2}$/.test(d.dateEnd || '')) return '日期格式不正確';
  if (d.dateStart > d.dateEnd) return '結束日期不可早於開始日期';
  const days = (new Date(d.dateEnd) - new Date(d.dateStart)) / 86400000 + 1; if (days > MAX_DAYS) return '日期範圍最多 ' + MAX_DAYS + ' 天';
  if (!Array.isArray(d.allowed)) return '可選時段格式不正確'; if (d.allowed.length === 0) return '請至少勾選一個可選時段';
  if (['none', 'instant', 'daily'].indexOf(d.notifyMode) < 0) return '通知方式不正確';
  if (d.notifyMode !== 'none' && !d.creatorEmail) return '填寫 email 可即時接收通知';
  if (d.description !== undefined && String(d.description).length > 1000) return '說明太長（最多 1000 字）';
  if (d.extraOpen && !(d.finalSlots && d.finalSlots.length)) return '開放補選需要先設定定案時段';
  return null;
}


// #endregion //
// #region // 管理員驗證

// [ Admin ] 驗證創辦人密碼 ( 回傳 [活動, 錯誤] )
function checkAdmin_(d) { const ev = findEvent_(d.id); if (!ev) return [null, fail_('找不到這個活動')]; if (ev.pwHash !== hashPw_(ev.salt, d.password || '')) return [null, fail_('創辦人密碼不正確')]; return [ev, null]; }


// #endregion //

// #region // 指令 ACTION

// action 名稱 → 處理函式 對照表
const HANDLERS = {
  // 建立活動
  createEvent: function (d) {
    const err = validateEvent_(d); if (err) return fail_(err);
    if (!d.password || d.password.length < 4) return fail_('密碼需要超過 4 個字元');
    // 生成 ID
    const existing = readAll_(EVENT_SHEET, EVENT_COLS).map(r => String(r.id));
    let id; do { id = randId_(10); } while (existing.indexOf(id) >= 0);
    // 生成 SALT ( 密碼安全性 )
    const salt = randId_(16);
    const ev = { id: id, title: String(d.title).trim(), creatorName: String(d.creatorName || '').trim(), creatorEmail: String(d.creatorEmail || '').trim(), salt: salt, pwHash: hashPw_(salt, d.password),
      mode: d.mode, hourStart: Number(d.hourStart), hourEnd: Number(d.hourEnd), dateStart: d.dateStart, dateEnd: d.dateEnd, allowed: uniq_(d.allowed), showResults: !!d.showResults, showNames: !!d.showNames,
      notifyMode: d.notifyMode, discordWebhook: String(d.discordWebhook || '').trim(), finalSlots: [], finalNote: '', extraOpen: false, description: String(d.description || '').trim(), descriptionAt: String(d.description || '').trim() ? now_() : '', createdAt: now_(), updatedAt: now_() };
    writeRow_(EVENT_SHEET, EVENT_COLS, null, serializeEvent_(ev));
    return { ok: true, id: id };
  },
  // 取得活動資訊
  getEvent: function (d) {
    const ev = findEvent_(d.id); if (!ev) return fail_('找不到這個活動');
    const list = listParticipants_(d.id);
    const out = { ok: true, event: publicEvent_(ev), participantCount: list.length };
    if (ev.showResults) out.participants = pubParticipants_(list, ev.showNames, ev);
    return out;
  },
  // 加入活動
  joinEvent: function (d) {
    const ev = findEvent_(d.id); if (!ev) return fail_('找不到這個活動');
    const name = String(d.name || '').trim();
    if (!name) return fail_('請輸入姓名或單位'); if (name.length > 40) return fail_('名稱太長');
    if (!d.password || d.password.length < 4) return fail_('密碼需要超過 4 個字元');
    if (listParticipants_(d.id).some(p => p.name === name)) return fail_('這個名稱已經有人用了；如果是你本人，請改用「修改我的選擇」登入');
    const salt = randId_(16);
    const p = { eventId: ev.id, name: name, email: String(d.email || '').trim(), salt: salt, pwHash: hashPw_(salt, d.password), slots: [], extraSlots: [], extraAt: '', createdAt: now_(), updatedAt: now_() };
    writeRow_(PART_SHEET, PART_COLS, null, serializeParticipant_(p));
    notifyChange_(ev, name, '加入了活動');
    return { ok: true, participant: ownParticipant_(p) };
  },
  // 填寫者登入
  loginParticipant: function (d) {
    const ev = findEvent_(d.id); if (!ev) return fail_('找不到這個活動');
    const p = listParticipants_(d.id).find(x => x.name === String(d.name || '').trim());
    if (!p || p.pwHash !== hashPw_(p.salt, d.password || '')) return fail_('名稱或密碼不正確');
    return { ok: true, participant: ownParticipant_(p) };
  },
  // 儲存時段
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
  // 儲存補選時段
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
  // [ Admin ] 管理員登入
  adminLogin: function (d) {
    const [ev, err] = checkAdmin_(d); if (err) return err;
    return { ok: true, event: adminEvent_(ev), participants: adminParticipants_(listParticipants_(d.id), ev) };
  },
  // [ Admin ] 更新活動資訊
  adminUpdate: function (d) {
    const [ev, err] = checkAdmin_(d); if (err) return err;
    const patch = d.patch || {};
    const fields = ['title', 'creatorName', 'creatorEmail', 'mode', 'hourStart', 'hourEnd', 'dateStart', 'dateEnd', 'allowed', 'showResults', 'showNames', 'notifyMode', 'discordWebhook', 'finalSlots', 'finalNote', 'extraOpen', 'description'];
    const merged = Object.assign({}, ev); fields.forEach(f => { if (patch[f] !== undefined) merged[f] = patch[f]; });
    const verr = validateEvent_(merged); if (verr) return fail_(verr);
    const oldDesc = String(ev.description || '');
    fields.forEach(f => { if (patch[f] !== undefined) ev[f] = patch[f]; });
    ev.description = String(ev.description || '').trim();
    if (ev.description !== oldDesc) ev.descriptionAt = ev.description ? now_() : '';
    ev.hourStart = Number(ev.hourStart); ev.hourEnd = Number(ev.hourEnd); ev.allowed = uniq_(ev.allowed); ev.extraOpen = !!ev.extraOpen;
    if (patch.newPassword) { if (String(patch.newPassword).length < 4) return fail_('密碼需要超過 4 個字元'); ev.salt = randId_(16); ev.pwHash = hashPw_(ev.salt, patch.newPassword); }
    ev.updatedAt = now_();
    writeRow_(EVENT_SHEET, EVENT_COLS, ev._row, serializeEvent_(ev));
    // 縮小可選範圍時，移除填寫者範圍外的選擇 ( 含補選 )
    const allowed = new Set(ev.allowed); let stripped = 0;
    listParticipants_(d.id).forEach(p => {
      const before = p.slots.length; const after = p.slots.filter(s => allowed.has(s));
      const eBefore = p.extraSlots.length; const eAfter = p.extraSlots.filter(s => allowed.has(s));
      if (after.length !== before || eAfter.length !== eBefore) { stripped += (before - after.length) + (eBefore - eAfter.length); p.slots = after; p.extraSlots = eAfter; p.updatedAt = now_(); writeRow_(PART_SHEET, PART_COLS, p._row, serializeParticipant_(p)); }
    });
    return { ok: true, event: adminEvent_(ev), participants: adminParticipants_(listParticipants_(d.id), ev), strippedSlots: stripped };
  },
  // [ Admin ] 刪除參與者
  adminDeleteParticipant: function (d) {
    const [ev, err] = checkAdmin_(d); if (err) return err;
    const p = listParticipants_(d.id).find(x => x.name === String(d.name || ''));
    if (p) deleteRow_(PART_SHEET, p._row);
    return { ok: true, event: adminEvent_(ev), participants: adminParticipants_(listParticipants_(d.id), ev) };
  },
  // [ Admin ] 寄送定案通知
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


// #endregion //

// #region // 通知 ( Email / Discord / 每日摘要 )

// 前端網址 ( 通知信裡的連結用 )
function frontendBase_() {
  // 前端網址（用於信件連結），在「專案設定 → 指令碼屬性」設定 FRONTEND_URL，例如 https://你的帳號.github.io/when2meet-zh/
  return PropertiesService.getScriptProperties().getProperty('FRONTEND_URL') || '';
}
// 活動連結 ( 通知信用 )
function eventLink_(id) { const b = frontendBase_(); return b ? b.replace(/\/?$/, '/') + '#/e/' + id : '（未設定 FRONTEND_URL）'; }
// 後台連結 ( 通知信用 )
function adminLink_(id) { return eventLink_(id) + '/admin'; }
// 時段轉成文字 ( 通知信用 )
function fmtSlot_(s) {
  const parts = String(s).split('|'); const date = parts[0], key = parts[1];
  const names = { am: '上午', noon: '中午', pm: '下午', eve: '晚上' };
  return date + ' ' + (names[key] || (key + ':00–' + ('0' + (Number(key) + 1)).slice(-2) + ':00'));
}
// 異動通知：Discord 一律推送；instant 立即寄信；daily 先記錄到 changes 表
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


// #endregion //
