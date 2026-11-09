# SPEC — 約時間（when2meet-zh）

## 1. 目標

無註冊、憑連結存取的約時間工具（when2meet 的中文版），前端純靜態可放 GitHub Pages，
後端二選一：Google Apps Script + Google 試算表（零費用）或 FastAPI + SQLite（自架）。兩者共用同一 API 合約。

## 2. 角色與權限

| 角色 | 身分 | 能做的事 |
|---|---|---|
| 創辦人 | 活動 ID + 創辦人密碼（此活動專用） | 看完整結果與名單、改設定、改可選時段、刪填寫者、定案、寄定案通知、改密碼 |
| 填寫者 | 活動 ID + 自取名稱 + 自設密碼（此活動專用） | 填寫 / 修改自己的空檔、留 email；若創辦人開放則看熱力圖（名單與否由創辦人決定） |
| 路人 | 活動 ID | 看活動標題、日期、人數；若創辦人開放則看熱力圖 |

活動 ID 為 10 碼隨機字串（去掉易混淆字元），只有拿到連結的人找得到。

## 3. 時段模型

- `slotId = "<YYYY-MM-DD>|<key>"`
  - 逐小時模式：`key` = 兩位數小時 `00`…`23`，代表 `HH:00–HH+1:00`
  - 粗略模式：`key` ∈ `am`(08–12) / `noon`(12–13) / `pm`(13–18) / `eve`(18–22)，定義在 `docs/config.js` `COARSE_BLOCKS`
- 活動欄位 `allowed: slotId[]` = 創辦人開放的格子；填寫者的 `slots` 必為 `allowed` 的子集合（後端強制過濾）。
- 逐小時模式顯示範圍 `hourStart`/`hourEnd`（預設 8/22，可切 0/24）。範圍縮小時：前端列出受影響的已填寫格子並要求創辦人確認，後端依新的 `allowed` 移除範圍外的選擇並回傳 `strippedSlots` 數。
- 底色提示（不影響可否選擇）：週六日與 `docs/holidays-tw.json` 內的日期 → 淡紅；午休（12 時）與下班（<8 或 ≥18）→ 淡灰；未開放 → 斜線。假日優先於灰底。

### 3.1 補選（定案後在定案日期內重選）

- 創辦人設定 `finalSlots` 後可開啟 `extraOpen`；**補選日期 = `finalSlots` 所在的日期**（去重、排序）。
- 開啟後，填寫者只能在補選日期內重新選擇（可增減，與一般選擇相同），結果存在 `extraSlots`，並記錄 `extraAt`。原本的 `slots` **不會被改動**。
- `extraSlots` 必為「`allowed` ∩ 補選日期」的子集合（後端強制過濾）：創辦人沒開放的格子，補選也不能選。
- 有效空檔（熱力圖、Top 排名、名單、`getEvent.participants`、`adminLogin.participants[].slots` 一律使用有效空檔）：
  - `extraAt` 為空，或沒有補選日期 → `slots`
  - 否則 → `slots` 中不在補選日期的格子 ∪ `extraSlots` 中在補選日期（且在 `allowed`）的格子
- 補選紀錄一旦存在就持續有效；`extraOpen` 只決定「現在能不能再補選」，關閉後恢復一般填寫，已補選的結果仍計入。
- 沒填過的人也可以 `joinEvent` 後直接補選。

## 4. 資料欄位

**event**：`id, title, creatorName, creatorEmail, salt, pwHash, mode('hour'|'coarse'), hourStart, hourEnd, dateStart, dateEnd, allowed[], showResults, showNames, notifyMode('none'|'instant'|'daily'), discordWebhook, finalSlots[], finalNote, createdAt, updatedAt, extraOpen, description, descriptionAt`

**participant**：`eventId, name(活動內唯一), email, salt, pwHash, slots[], createdAt, updatedAt, extraSlots[], extraAt`

**change**（每日摘要佇列）：`eventId, name, action, at, sent`

> 新增欄位一律加在最右邊（GAS 依欄位位置讀取）。GAS 在第一次使用時會自動補上舊工作表缺少的欄位標題；SQLite 在啟動時自動 `ALTER TABLE ADD COLUMN`。

密碼：`pwHash = hex(sha256(salt + ':' + password))`，salt 16 碼隨機。密碼最少 4 字。

驗證規則：標題 1–80 字；日期範圍 ≤ 62 天且起 ≤ 訖；`0 ≤ hourStart < hourEnd ≤ 24`；`allowed` 非空；`notifyMode ≠ none` 時 `creatorEmail` 必填；名稱 1–40 字；`extraOpen=true` 時 `finalSlots` 不可為空（錯誤訊息：「開放補選需要先設定定案時段」）。

## 5. API 合約

單一端點 `POST <API_BASE>`，body 為 JSON（`Content-Type: text/plain` 以避免 CORS 預檢），回應 JSON。
失敗一律 `{ok:false, error:"中文訊息"}`。

| action | 參數 | 回傳 |
|---|---|---|
| `createEvent` | event 欄位（不含 id/salt/pwHash）+ `password` | `{ok, id}` |
| `getEvent` | `id` | `{ok, event(公開欄位), participantCount, participants?}`，`participants` 僅在 `showResults` 時回傳，`showNames=false` 時名稱改為「參與者 N」 |
| `joinEvent` | `id, name, password, email?` | `{ok, participant:{name,email,slots,extraSlots,extraAt}}`；名稱重複則錯誤 |
| `loginParticipant` | `id, name, password` | 同上（`slots` 是原本的選擇，不含補選合併） |
| `saveSlots` | `id, name, password, slots[], email?` | `{ok, participant, notified}`；slots 會被過濾成 allowed 子集合；觸發通知 |
| `saveExtraSlots` | `id, name, password, slots[], email?` | `{ok, participant, notified}`；需 `extraOpen` 且已有定案時段（否則「主約人目前沒有開放補選」/「尚未設定定案時段」）；`slots` 會被過濾成 allowed ∩ 補選日期，整份覆蓋 `extraSlots`，更新 `extraAt`；觸發通知（「補選了空檔」） |
| `adminLogin` | `id, password` | `{ok, event(含 creatorEmail/notifyMode/discordWebhook), participants:[{name,email,slots(有效空檔),extraSlots,extraAt,createdAt,updatedAt}]}` |
| `adminUpdate` | `id, password, patch{任意 event 欄位（含 extraOpen）, newPassword?}` | 同 adminLogin + `strippedSlots`（含被移除的 `extraSlots`） |
| `adminDeleteParticipant` | `id, password, name` | 同 adminLogin |
| `adminNotifyFinal` | `id, password, message?` | `{ok, sent}`；寄給有留 email 的填寫者 |

公開欄位：`id, title, creatorName, mode, hourStart, hourEnd, dateStart, dateEnd, allowed, showResults, showNames, finalSlots, finalNote, extraOpen, description, descriptionAt, createdAt, updatedAt`。

**說明欄（公告）**：`description` 純文字、≤ 1000 字（錯誤訊息：「說明太長（最多 1000 字）」），可在建立活動或 `adminUpdate` 時設定；內容有變動時後端更新 `descriptionAt`（清空則為空字串）。填寫頁在標題下方顯示，並每 60 秒 / 切回分頁時重抓 `getEvent` 以取得最新公告。GAS 以 JSON 字串存入儲存格（避免被當成公式）。

## 6. 通知

- `instant`：`joinEvent` / `saveSlots` 後立即寄 email 給 `creatorEmail`。
- `daily`：寫入 `changes`，由排程（GAS 時間觸發器 / FastAPI 背景執行緒）每天 `DIGEST_HOUR` 彙整寄出。
- `discordWebhook` 有值時，不論 notifyMode 一律同時推送。
- `adminNotifyFinal`：定案通知，寄給所有有留 email 的填寫者；`extraOpen` 為真時信中另附「開放補選」說明與補選日期。

## 7. 前端畫面

- `#/new`：建立活動（三段：資訊 / 時間範圍與可選格子 / 顯示與通知）→ 成功頁顯示填寫連結與後台連結。
- `#/e/<id>`：填寫頁。未登入可看熱力圖（若開放）；登入（第一次填寫 / 修改我的選擇）後可拖曳塗選、疊看熱力圖、點名單標示某人空檔、儲存、留 email。
  - 補選模式（`extraOpen` 且已定案）：格子只顯示補選日期，只能編輯補選；按鈕為「儲存補選」，呼叫 `saveExtraSlots`。起始選擇：已補選過 → `extraSlots`；還沒 → 原本 `slots` 中在補選日期內的格子。
- `#/e/<id>/admin`：後台。熱力圖 + 誰有空 + 最多人時段 Top 8 + 名單（可刪；開放補選時標示「已補選 / 未補選」）、設定（含「開放補選」開關）、可選時段（含範圍切換與縮小警告）、定案與通知。
- 登入狀態存 `sessionStorage`（關分頁即清除），每次請求重送名稱 + 密碼，後端無 session。

## 8. 非目標（目前不做）

- 多時區、跨日時段、重複週期、匯出 ics、找回密碼、活動自動過期刪除。

## 9. 驗收清單

- [ ] 建立逐小時 / 粗略兩種活動並拖曳塗選
- [ ] 第二人用相同名稱加入被拒；正確密碼可登入修改
- [ ] showResults 關閉時填寫者看不到他人；showNames 關閉時只看到「參與者 N」
- [ ] 後台縮小可選範圍時跳出確認，確認後範圍外選擇被移除且 `strippedSlots` 正確
- [ ] 0–24 切回 8–22 時，有範圍外選擇則確認；無則直接切換
- [ ] instant / daily / Discord 通知各寄出一次
- [ ] 定案後填寫頁顯示 ★ 與定案通知
- [ ] 沒儲存定案時段就開「開放補選」會被拒；開啟後填寫頁只剩補選日期、可增減，儲存後原本 `slots` 不變
- [ ] 補選結果只算在補選日期內；其他日期仍用原本的選擇；沒填過的人可直接補選
- [ ] 補選不能選到 `allowed` 以外或補選日期以外的格子（後端過濾）
- [ ] 後台名單顯示「已補選 / 未補選」；定案通知信附補選說明與日期
- [ ] 舊的 GAS 試算表 / SQLite 資料庫升級後可直接使用（自動補欄位）
