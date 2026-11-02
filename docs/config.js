// ============================================================
//  約時間 — 前端設定檔
//  部署時只需要改這一個檔案。
// ============================================================
window.APP_CONFIG = {
  // 後端模式：
  //   'local'  → 示範模式，資料只存在這台瀏覽器的 localStorage（不需要任何後端，適合先試玩）
  //   'remote' → 連到 API_BASE 指定的後端（Google Apps Script 或 FastAPI）
  BACKEND: 'remote',

  // 後端網址：
  //   GAS：     'https://script.google.com/macros/s/XXXXXXXX/exec'
  //   FastAPI： 由 FastAPI 直接服務前端時填 '/api'；前端放 GitHub Pages、後端另架時填完整網址，例如 'https://meet.example.com/api'
  API_BASE: 'https://script.google.com/macros/s/AKfycby49TvoLo5LBKxswGKtJRQb2-50K3ZZU_5LE-iLjTrf6HGZd-S04JE9anH7FtLDXH8R/exec',

  // GitHub repo 網址（頁尾連結，選填）
  REPO_URL: 'https://github.com/yuloyik/when2meet-zh',

  // 網站名稱（顯示在頁首）
  SITE_NAME: '約時間',

  // 逐小時模式的預設顯示範圍（可在建立活動時切成 0–24）
  DEFAULT_HOUR_START: 8,
  DEFAULT_HOUR_END: 22,

  // 粗略模式的時段定義（key 不要改，label / 起訖小時可改）
  COARSE_BLOCKS: [
    { key: 'am',   label: '上午', start: 8,  end: 12 },
    { key: 'noon', label: '中午', start: 12, end: 13 },
    { key: 'pm',   label: '下午', start: 13, end: 18 },
    { key: 'eve',  label: '晚上', start: 18, end: 22 },
  ],

  // 底色提示（不影響可否選擇）：午休與下班時間
  LUNCH_HOURS: [12],          // 淡灰
  WORK_START: 8,              // 早於此 → 淡灰
  WORK_END: 18,               // 晚於等於此 → 淡灰
};
