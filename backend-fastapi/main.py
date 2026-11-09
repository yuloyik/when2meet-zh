"""
約時間 — FastAPI + SQLite 自架後端
API 合約與 backend-gas/Code.gs 完全相同：POST /api  body = {"action": "...", ...}
同時直接服務 ../docs 的前端（config.js 把 API_BASE 設成 '/api' 即可）。

啟動：
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8000
"""
# [ 類別 ] 自架後端 ( FastAPI + SQLite )
# [ 功能 ] 與 backend-local.js 邏輯一致，資料改存 SQLite 檔案，並提供真實的 email / Discord 通知。

# ev  = event        ( 活動 )
# p   = participant  ( 填寫者 )
# d   = data         ( 前端傳來的資料 )
# s   = slot         ( 時段 )
# con = connection   ( 資料庫連線 )
# eid = event id     ( 活動 ID )
# lst = list         ( 清單 )

from __future__ import annotations

import hashlib
import json
import os
import secrets
import smtplib
import sqlite3
import threading
import time
import urllib.request
from datetime import date, datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

# region // 設定 ( 環境變數 )

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv()
except Exception:  # dotenv 是選用的
    pass

BASE_DIR = Path(__file__).resolve().parent
# 資料庫檔案位置
DB_PATH = os.environ.get("DB_PATH", str(BASE_DIR / "data" / "meet.sqlite3"))
# 前端資料夾 ( 預設為 ../docs )
FRONTEND_DIR = os.environ.get("FRONTEND_DIR", str(BASE_DIR.parent / "docs"))
# 前端網址 ( 通知信裡的連結用 )
FRONTEND_URL = os.environ.get("FRONTEND_URL", "").rstrip("/")
# 每日摘要寄出的整點 ( 伺服器本地時間 )
DIGEST_HOUR = int(os.environ.get("DIGEST_HOUR", "9"))
# 日期範圍上限 ( 天 )
MAX_DAYS = 62
# SMTP 寄信設定 ( 沒設定 SMTP_HOST 就只印在終端機 )
SMTP = {k: os.environ.get(k, "") for k in ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM")}

# endregion //

# region // 資料庫 ( SQLite )


# 寫入鎖 ( 同一時間只讓一個請求寫入 )，對應 GAS 的 LockService
_db_lock = threading.Lock()


# 開啟資料庫連線 ( WAL 模式 )
def db() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


# 建立資料表 ( 啟動時執行，已存在就略過 )
def init_db() -> None:
    with db() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
              id TEXT PRIMARY KEY, title TEXT, creatorName TEXT, creatorEmail TEXT, salt TEXT, pwHash TEXT,
              mode TEXT, hourStart INTEGER, hourEnd INTEGER, dateStart TEXT, dateEnd TEXT, allowed TEXT,
              showResults INTEGER, showNames INTEGER, notifyMode TEXT, discordWebhook TEXT,
              finalSlots TEXT DEFAULT '[]', finalNote TEXT DEFAULT '', createdAt TEXT, updatedAt TEXT,
              extraOpen INTEGER DEFAULT 0, description TEXT DEFAULT '', descriptionAt TEXT DEFAULT '');
            CREATE TABLE IF NOT EXISTS participants (
              eventId TEXT, name TEXT, email TEXT, salt TEXT, pwHash TEXT, slots TEXT,
              createdAt TEXT, updatedAt TEXT, extraSlots TEXT DEFAULT '[]', extraAt TEXT DEFAULT '',
              PRIMARY KEY (eventId, name));
            CREATE TABLE IF NOT EXISTS changes (
              id INTEGER PRIMARY KEY AUTOINCREMENT, eventId TEXT, name TEXT, action TEXT, at TEXT, sent INTEGER DEFAULT 0);
            """
        )
        # 舊資料庫升級：補上後來新增的欄位（已存在就略過，可重複執行）
        add_column(con, "events", "extraOpen", "INTEGER DEFAULT 0")
        add_column(con, "events", "description", "TEXT DEFAULT ''")
        add_column(con, "events", "descriptionAt", "TEXT DEFAULT ''")
        add_column(con, "participants", "extraSlots", "TEXT DEFAULT '[]'")
        add_column(con, "participants", "extraAt", "TEXT DEFAULT ''")


# 補欄位 ( 舊資料庫升級用 )
def add_column(con: sqlite3.Connection, table: str, col: str, ddl: str) -> None:
    have = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
    if col not in have:
        con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


# endregion //


# region // 時間 / ID & Password ( HASH )


# 現在時間 ( UTC )
def now() -> str:
    return datetime.now(timezone.utc).isoformat()


# 產生隨機 ID
def rand_id(n: int) -> str:
    # 字元表
    # ★ NOTE : 移除不容易辨識之字元 ( i l o 0 1 )
    chars = "abcdefghjkmnpqrstuvwxyz23456789"
    # 逐字元隨機抽取 ( secrets 為密碼學等級隨機 )
    return "".join(secrets.choice(chars) for _ in range(n))


# HASH 演算法 ( 密碼安全性 ) ( ★ 單向轉換 : Password -> HASH )
# 與 backend-local.js 相同：sha256( salt + ":" + 密碼 )
def hash_pw(salt: str, pw: str) -> str:
    return hashlib.sha256(f"{salt}:{pw}".encode("utf-8")).hexdigest()


# 失敗回應格式
def fail(msg: str) -> dict:
    return {"ok": False, "error": msg}


# endregion //


# region // 資料存取 ( 讀寫 SQLite )


# 資料列 → 活動物件 ( JSON 文字還原成陣列 / 布林 )
def row_event(r: sqlite3.Row) -> dict:
    ev = dict(r)
    ev["allowed"] = json.loads(ev.get("allowed") or "[]")
    ev["finalSlots"] = json.loads(ev.get("finalSlots") or "[]")
    ev["showResults"] = bool(ev["showResults"])
    ev["showNames"] = bool(ev["showNames"])
    ev["extraOpen"] = bool(ev.get("extraOpen"))
    return ev


# 資料列 → 填寫者物件
def row_part(r: sqlite3.Row) -> dict:
    p = dict(r)
    p["slots"] = json.loads(p.get("slots") or "[]")
    p["extraSlots"] = json.loads(p.get("extraSlots") or "[]")
    p["extraAt"] = p.get("extraAt") or ""
    return p


# 依 ID 找活動
def find_event(con: sqlite3.Connection, eid: str) -> dict | None:
    r = con.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone()
    return row_event(r) if r else None


# 取得活動的所有填寫者 ( 依建立時間排序 )
def list_parts(con: sqlite3.Connection, eid: str) -> list[dict]:
    return [row_part(r) for r in con.execute("SELECT * FROM participants WHERE eventId=? ORDER BY createdAt", (eid,))]


# 儲存活動 ( new=True 新增，否則更新 )
def save_event(con: sqlite3.Connection, ev: dict, new: bool = False) -> None:
    cols = ["id", "title", "creatorName", "creatorEmail", "salt", "pwHash", "mode", "hourStart", "hourEnd", "dateStart", "dateEnd",
            "allowed", "showResults", "showNames", "notifyMode", "discordWebhook", "finalSlots", "finalNote", "createdAt", "updatedAt", "extraOpen", "description", "descriptionAt"]
    vals = [json.dumps(ev[c], ensure_ascii=False) if c in ("allowed", "finalSlots")
            else int(bool(ev.get(c))) if c in ("showResults", "showNames", "extraOpen") else ev.get(c, "") for c in cols]
    if new:
        con.execute(f"INSERT INTO events ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals)
    else:
        con.execute("UPDATE events SET " + ",".join(f"{c}=?" for c in cols[1:]) + " WHERE id=?", vals[1:] + [ev["id"]])


# 儲存填寫者 ( new=True 新增，否則更新 )
def save_part(con: sqlite3.Connection, p: dict, new: bool = False) -> None:
    if new:
        con.execute("INSERT INTO participants (eventId,name,email,salt,pwHash,slots,extraSlots,extraAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (p["eventId"], p["name"], p["email"], p["salt"], p["pwHash"], json.dumps(p["slots"]),
                     json.dumps(p.get("extraSlots") or []), p.get("extraAt") or "", p["createdAt"], p["updatedAt"]))
    else:
        con.execute("UPDATE participants SET email=?, slots=?, extraSlots=?, extraAt=?, updatedAt=? WHERE eventId=? AND name=?",
                    (p["email"], json.dumps(p["slots"]), json.dumps(p.get("extraSlots") or []), p.get("extraAt") or "", p["updatedAt"], p["eventId"], p["name"]))


# endregion //


# region // 欄位類別 ( 輸出給前端的欄位 )


# [ Public ] 顯示公開欄位
def public_event(ev: dict) -> dict:
    return {k: ev.get(k) for k in ("id", "title", "creatorName", "mode", "hourStart", "hourEnd", "dateStart", "dateEnd", "allowed",
                                   "showResults", "showNames", "finalSlots", "finalNote", "extraOpen", "description", "descriptionAt", "createdAt", "updatedAt")}


# region // 日期與時段 ( 含補選 )

# ---- 補選（定案後在定案日期內重選）----
# 補選日期 = 定案時段所在的日期。填寫者有補選紀錄（extraAt 不為空）時，
# 有效空檔 = 「補選日期以外的原本空檔」+「補選日期內的補選空檔」；原本的 slots 不會被改動。
def slot_date(s: str) -> str:
    return str(s).split("|")[0]


# 定案時段
def final_dates(ev: dict) -> list[str]:
    return sorted({slot_date(s) for s in (ev.get("finalSlots") or [])})


# 有效補選時段
def effective_slots(ev: dict, p: dict) -> list[str]:
    dates = final_dates(ev)
    if not p.get("extraAt") or not dates:
        return p["slots"]
    allowed = set(ev["allowed"])
    keep = [s for s in p["slots"] if slot_date(s) not in dates]
    extra = [s for s in (p.get("extraSlots") or []) if s in allowed and slot_date(s) in dates]
    return sorted(set(keep + extra))


# endregion //


# 填寫者自己看到的資料 ( 原本的 slots，不含補選合併 )
def own_part(p: dict) -> dict:
    return {"name": p["name"], "email": p.get("email", ""), "slots": p["slots"], "extraSlots": p.get("extraSlots") or [], "extraAt": p.get("extraAt") or ""}


# [ Admin ] 顯示管理員欄位
def admin_event(ev: dict) -> dict:
    out = public_event(ev)
    out.update(creatorEmail=ev.get("creatorEmail", ""), notifyMode=ev.get("notifyMode"), discordWebhook=ev.get("discordWebhook", ""))
    return out


# [ Public ] 顯示填寫者清單 ( 關閉名單時顯示「參與者 N」，空檔為有效空檔 )
def pub_parts(lst: list[dict], show_names: bool, ev: dict) -> list[dict]:
    return [{"name": p["name"] if show_names else f"參與者 {i + 1}", "slots": effective_slots(ev, p)} for i, p in enumerate(lst)]


# [ Admin ] 顯示填寫者清單 ( 含 email、補選紀錄 )
def admin_parts(lst: list[dict], ev: dict) -> list[dict]:
    return [{"name": p["name"], "email": p.get("email", ""), "slots": effective_slots(ev, p), "extraSlots": p.get("extraSlots") or [],
             "extraAt": p.get("extraAt") or "", "createdAt": p["createdAt"], "updatedAt": p["updatedAt"]} for p in lst]


# endregion //


# region // 資料格式驗證


# 是否為 YYYY-MM-DD 日期
def is_date(s: Any) -> bool:
    try:
        date.fromisoformat(str(s))
        return True
    except Exception:
        return False


# 活動欄位驗證 ( 建立 / 修改活動時共用 )
def validate_event(d: dict) -> str | None:
    title = str(d.get("title") or "").strip()
    if not title:
        return "請輸入活動名稱"
    if len(title) > 80:
        return "活動名稱太長"
    if d.get("mode") not in ("hour", "coarse"):
        return "時間刻度不正確"
    try:
        hs, he = int(d.get("hourStart")), int(d.get("hourEnd"))
    except Exception:
        return "顯示小時範圍不正確"
    if not (0 <= hs < he <= 24):
        return "顯示小時範圍不正確"
    if not (is_date(d.get("dateStart")) and is_date(d.get("dateEnd"))):
        return "日期格式不正確"
    if d["dateStart"] > d["dateEnd"]:
        return "結束日期不可早於開始日期"
    if (date.fromisoformat(d["dateEnd"]) - date.fromisoformat(d["dateStart"])).days + 1 > MAX_DAYS:
        return f"日期範圍最多 {MAX_DAYS} 天"
    if not isinstance(d.get("allowed"), list):
        return "可選時段格式不正確"
    if len(d["allowed"]) == 0:
        return "請至少勾選一個可選時段"
    if d.get("notifyMode") not in ("none", "instant", "daily"):
        return "通知方式不正確"
    if d["notifyMode"] != "none" and not str(d.get("creatorEmail") or "").strip():
        return "填寫 email 可即時接收通知"
    if d.get("description") is not None and len(str(d.get("description"))) > 1000:
        return "說明太長（最多 1000 字）"
    if d.get("extraOpen") and not d.get("finalSlots"):
        return "開放補選需要先設定定案時段"
    return None


# endregion //


# region // 管理員驗證


# [ Admin ] 驗證創辦人密碼 ( 回傳 活動 與 錯誤訊息 )
def check_admin(con: sqlite3.Connection, d: dict) -> tuple[dict | None, dict | None]:
    ev = find_event(con, str(d.get("id")))
    if not ev:
        return None, fail("找不到這個活動")
    if ev["pwHash"] != hash_pw(ev["salt"], str(d.get("password") or "")):
        return None, fail("創辦人密碼不正確")
    return ev, None


# endregion //


# region // 通知 ( Email / Discord / 每日摘要 )


# 活動連結 ( 通知信用 )
def event_link(eid: str) -> str:
    return f"{FRONTEND_URL}/#/e/{eid}" if FRONTEND_URL else "（未設定 FRONTEND_URL）"


# 時段轉成文字 ( 通知信用 )
def fmt_slot(s: str) -> str:
    d, _, key = s.partition("|")
    names = {"am": "上午", "noon": "中午", "pm": "下午", "eve": "晚上"}
    return f"{d} {names.get(key, f'{key}:00–{int(key) + 1:02d}:00' if key.isdigit() else key)}"


# 寄 email ( 沒設定 SMTP 就只印在終端機 )
def send_mail(to: str, subject: str, body: str) -> bool:
    if not SMTP["SMTP_HOST"]:
        print(f"[mail 未設定 SMTP] to={to} subject={subject}\n{body}\n")
        return False
    msg = EmailMessage()
    msg["From"] = SMTP["SMTP_FROM"] or SMTP["SMTP_USER"]
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    try:
        port = int(SMTP["SMTP_PORT"] or 587)
        if port == 465:
            server = smtplib.SMTP_SSL(SMTP["SMTP_HOST"], port, timeout=15)
        else:
            server = smtplib.SMTP(SMTP["SMTP_HOST"], port, timeout=15)
            server.starttls()
        if SMTP["SMTP_USER"]:
            server.login(SMTP["SMTP_USER"], SMTP["SMTP_PASS"])
        server.send_message(msg)
        server.quit()
        return True
    except Exception as e:  # noqa: BLE001
        print("寄信失敗:", e)
        return False


# 推送到 Discord webhook
def send_discord(url: str, content: str) -> None:
    try:
        req = urllib.request.Request(url, data=json.dumps({"content": content}).encode(), headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:  # noqa: BLE001
        print("Discord 失敗:", e)


# 異動通知：Discord 一律推送；instant 立即寄信；daily 先記錄到 changes 表
def notify_change(con: sqlite3.Connection, ev: dict, who: str, what: str) -> None:
    text = f"【約時間】{who} {what} — {ev['title']}"
    if ev.get("discordWebhook"):
        threading.Thread(target=send_discord, args=(ev["discordWebhook"], f"{text}\n{event_link(ev['id'])}/admin"), daemon=True).start()
    if ev["notifyMode"] == "instant" and ev.get("creatorEmail"):
        threading.Thread(target=send_mail, args=(ev["creatorEmail"], text, f"{who} {what}。\n\n後台：{event_link(ev['id'])}/admin"), daemon=True).start()
    elif ev["notifyMode"] == "daily":
        con.execute("INSERT INTO changes (eventId,name,action,at,sent) VALUES (?,?,?,?,0)", (ev["id"], who, what, now()))


# 彙整尚未寄出的異動，寄出每日摘要
def send_daily_digests() -> None:
    with _db_lock, db() as con:
        rows = con.execute("SELECT * FROM changes WHERE sent=0 ORDER BY at").fetchall()
        by_event: dict[str, list] = {}
        for r in rows:
            by_event.setdefault(r["eventId"], []).append(r)
        for eid, lst in by_event.items():
            ev = find_event(con, eid)
            if ev and ev.get("creatorEmail") and ev["notifyMode"] == "daily":
                lines = "\n".join(f"・{r['name']} {r['action']}（{r['at'][:16].replace('T', ' ')}）" for r in lst)
                n = len(list_parts(con, eid))
                send_mail(ev["creatorEmail"], f"【約時間】每日摘要：{ev['title']}",
                          f"「{ev['title']}」過去一天有 {len(lst)} 筆異動：\n\n{lines}\n\n目前共 {n} 人填寫。\n後台：{event_link(eid)}/admin")
            con.execute("UPDATE changes SET sent=1 WHERE eventId=? AND sent=0", (eid,))


# 背景執行緒：每 60 秒檢查一次，到 DIGEST_HOUR 整點寄摘要 ( 同一天只寄一次 )
def digest_loop() -> None:
    last_day = None
    while True:
        t = time.localtime()
        if t.tm_hour == DIGEST_HOUR and last_day != t.tm_yday:
            last_day = t.tm_yday
            try:
                send_daily_digests()
            except Exception as e:  # noqa: BLE001
                print("每日摘要失敗:", e)
        time.sleep(60)


# endregion //


# region // 指令 ACTION


# 建立活動
def h_create_event(con, d):
    err = validate_event(d)
    if err:
        return fail(err)
    if len(str(d.get("password") or "")) < 4:
        return fail("密碼需要超過 4 個字元")
    # 生成 ID
    eid = rand_id(10)
    while find_event(con, eid):
        eid = rand_id(10)
    # 生成 SALT ( 密碼安全性 )
    salt = rand_id(16)
    ev = dict(id=eid, title=str(d["title"]).strip(), creatorName=str(d.get("creatorName") or "").strip(), creatorEmail=str(d.get("creatorEmail") or "").strip(),
              salt=salt, pwHash=hash_pw(salt, d["password"]), mode=d["mode"], hourStart=int(d["hourStart"]), hourEnd=int(d["hourEnd"]),
              dateStart=d["dateStart"], dateEnd=d["dateEnd"], allowed=sorted(set(map(str, d["allowed"]))), showResults=bool(d.get("showResults")),
              showNames=bool(d.get("showNames")), notifyMode=d["notifyMode"], discordWebhook=str(d.get("discordWebhook") or "").strip(),
              finalSlots=[], finalNote="", extraOpen=False,
              description=str(d.get("description") or "").strip(), descriptionAt=now() if str(d.get("description") or "").strip() else "",
              createdAt=now(), updatedAt=now())
    save_event(con, ev, new=True)
    return {"ok": True, "id": eid}


# 取得活動資訊
def h_get_event(con, d):
    ev = find_event(con, str(d.get("id")))
    if not ev:
        return fail("找不到這個活動")
    lst = list_parts(con, ev["id"])
    out = {"ok": True, "event": public_event(ev), "participantCount": len(lst)}
    if ev["showResults"]:
        out["participants"] = pub_parts(lst, ev["showNames"], ev)
    return out


# 加入活動
def h_join_event(con, d):
    ev = find_event(con, str(d.get("id")))
    if not ev:
        return fail("找不到這個活動")
    name = str(d.get("name") or "").strip()
    if not name:
        return fail("請輸入姓名或單位")
    if len(name) > 40:
        return fail("名稱太長")
    if len(str(d.get("password") or "")) < 4:
        return fail("密碼需要超過 4 個字元")
    if any(p["name"] == name for p in list_parts(con, ev["id"])):
        return fail("這個名稱已經有人用了；如果是你本人，請改用「修改我的選擇」登入")
    salt = rand_id(16)
    p = dict(eventId=ev["id"], name=name, email=str(d.get("email") or "").strip(), salt=salt, pwHash=hash_pw(salt, d["password"]), slots=[], extraSlots=[], extraAt="", createdAt=now(), updatedAt=now())
    save_part(con, p, new=True)
    notify_change(con, ev, name, "加入了活動")
    return {"ok": True, "participant": own_part(p)}


# 驗證填寫者身分 ( 名稱 + 密碼 )，回傳 ( 活動, 填寫者, 錯誤 )
def _auth_part(con, d):
    ev = find_event(con, str(d.get("id")))
    if not ev:
        return None, None, fail("找不到這個活動")
    name = str(d.get("name") or "").strip()
    p = next((x for x in list_parts(con, ev["id"]) if x["name"] == name), None)
    if not p or p["pwHash"] != hash_pw(p["salt"], str(d.get("password") or "")):
        return None, None, fail("名稱或密碼不正確")
    return ev, p, None


# 填寫者登入
def h_login_participant(con, d):
    ev, p, err = _auth_part(con, d)
    if err:
        return err
    return {"ok": True, "participant": own_part(p)}


# 儲存時段
def h_save_slots(con, d):
    ev, p, err = _auth_part(con, d)
    if err:
        return err
    allowed = set(ev["allowed"])
    p["slots"] = sorted({str(s) for s in (d.get("slots") or []) if str(s) in allowed})
    if d.get("email") is not None:
        p["email"] = str(d["email"]).strip()
    p["updatedAt"] = now()
    save_part(con, p)
    # NOTE : 在這裡寄送通知 ( 真實後端；示範模式僅記錄 )
    notify_change(con, ev, p["name"], f"更新了空檔（{len(p['slots'])} 格）")
    return {"ok": True, "participant": own_part(p), "notified": ev["notifyMode"]}


# 儲存補選時段
def h_save_extra_slots(con, d):
    ev, p, err = _auth_part(con, d)
    if err:
        return err
    if not ev["extraOpen"]:
        return fail("主約人目前沒有開放補選")
    dates = final_dates(ev)
    if not dates:
        return fail("尚未設定定案時段")
    allowed = set(ev["allowed"])
    p["extraSlots"] = sorted({str(s) for s in (d.get("slots") or []) if str(s) in allowed and slot_date(str(s)) in dates})
    p["extraAt"] = now()
    if d.get("email") is not None:
        p["email"] = str(d["email"]).strip()
    p["updatedAt"] = now()
    save_part(con, p)
    notify_change(con, ev, p["name"], f"補選了空檔（{len(p['extraSlots'])} 格）")
    return {"ok": True, "participant": own_part(p), "notified": ev["notifyMode"]}


# [ Admin ] 管理員登入
def h_admin_login(con, d):
    ev, err = check_admin(con, d)
    if err:
        return err
    return {"ok": True, "event": admin_event(ev), "participants": admin_parts(list_parts(con, ev["id"]), ev)}


# [ Admin ] 允許修改的欄位
FIELDS = ["title", "creatorName", "creatorEmail", "mode", "hourStart", "hourEnd", "dateStart", "dateEnd", "allowed", "showResults", "showNames", "notifyMode", "discordWebhook", "finalSlots", "finalNote", "extraOpen", "description"]


# [ Admin ] 更新活動資訊
def h_admin_update(con, d):
    ev, err = check_admin(con, d)
    if err:
        return err
    patch = d.get("patch") or {}
    merged = dict(ev)
    merged.update({f: patch[f] for f in FIELDS if f in patch})
    verr = validate_event(merged)
    if verr:
        return fail(verr)
    old_desc = str(ev.get("description") or "")
    ev.update({f: patch[f] for f in FIELDS if f in patch})
    ev["description"] = str(ev.get("description") or "").strip()
    if ev["description"] != old_desc:
        ev["descriptionAt"] = now() if ev["description"] else ""
    ev["hourStart"], ev["hourEnd"] = int(ev["hourStart"]), int(ev["hourEnd"])
    ev["allowed"] = sorted(set(map(str, ev["allowed"])))
    ev["finalSlots"] = sorted(set(map(str, ev.get("finalSlots") or [])))
    ev["extraOpen"] = bool(ev.get("extraOpen"))
    if patch.get("newPassword"):
        if len(str(patch["newPassword"])) < 4:
            return fail("密碼需要超過 4 個字元")
        ev["salt"] = rand_id(16)
        ev["pwHash"] = hash_pw(ev["salt"], patch["newPassword"])
    ev["updatedAt"] = now()
    save_event(con, ev)
    # 縮小可選範圍時，移除填寫者範圍外的選擇 ( 含補選 )
    allowed = set(ev["allowed"])
    stripped = 0
    for p in list_parts(con, ev["id"]):
        after = [s for s in p["slots"] if s in allowed]
        extra_after = [s for s in p["extraSlots"] if s in allowed]
        if len(after) != len(p["slots"]) or len(extra_after) != len(p["extraSlots"]):
            stripped += (len(p["slots"]) - len(after)) + (len(p["extraSlots"]) - len(extra_after))
            p["slots"], p["extraSlots"], p["updatedAt"] = after, extra_after, now()
            save_part(con, p)
    return {"ok": True, "event": admin_event(ev), "participants": admin_parts(list_parts(con, ev["id"]), ev), "strippedSlots": stripped}


# [ Admin ] 刪除參與者
def h_admin_delete_participant(con, d):
    ev, err = check_admin(con, d)
    if err:
        return err
    con.execute("DELETE FROM participants WHERE eventId=? AND name=?", (ev["id"], str(d.get("name") or "")))
    return {"ok": True, "event": admin_event(ev), "participants": admin_parts(list_parts(con, ev["id"]), ev)}


# [ Admin ] 寄送定案通知
def h_admin_notify_final(con, d):
    ev, err = check_admin(con, d)
    if err:
        return err
    if not ev["finalSlots"]:
        return fail("尚未設定定案時段")
    emails = [p["email"] for p in list_parts(con, ev["id"]) if p.get("email")]
    body = f"「{ev['title']}」已定案：\n\n" + "\n".join(fmt_slot(s) for s in ev["finalSlots"])
    if ev.get("finalNote"):
        body += f"\n\n{ev['finalNote']}"
    if d.get("message"):
        body += f"\n\n{d['message']}"
    if ev["extraOpen"]:
        body += "\n\n【開放補選】只限以下日期，請登入填寫頁重新選擇你有空的時段（其他日期原本填寫的紀錄會保留）：\n" + "、".join(final_dates(ev))
    body += f"\n\n查看：{event_link(ev['id'])}"
    for to in emails:
        threading.Thread(target=send_mail, args=(to, f"【約時間】{ev['title']} 已定案", body), daemon=True).start()
    return {"ok": True, "sent": len(emails)}


# action 名稱 → 處理函式 對照表
HANDLERS = {
    "createEvent": h_create_event, "getEvent": h_get_event, "joinEvent": h_join_event, "loginParticipant": h_login_participant,
    "saveSlots": h_save_slots, "saveExtraSlots": h_save_extra_slots, "adminLogin": h_admin_login, "adminUpdate": h_admin_update,
    "adminDeleteParticipant": h_admin_delete_participant, "adminNotifyFinal": h_admin_notify_final,
}


# endregion //

# region // FastAPI ( 對外入口 )


# 建立 FastAPI 應用
app = FastAPI(title="約時間 API")
# 允許任何來源呼叫 ( 前端放 GitHub Pages、後端自架時需要 )
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# 啟動時：建立資料表 + 啟動每日摘要的背景執行緒
@app.on_event("startup")
def _startup() -> None:
    init_db()
    threading.Thread(target=digest_loop, daemon=True).start()


# 直接開 /api 時的說明 ( GET )
@app.get("/api")
def api_info():
    return {"ok": True, "service": "約時間 API", "hint": "請用 POST 傳 JSON {action: ...}"}


# 唯一入口 ( POST )：依 action 找處理函式，並在寫入鎖內執行
# NOTE : 前端以 text/plain 送 JSON，所以這裡手動 json.loads，不用 FastAPI 的自動解析
@app.post("/api")
async def api(request: Request):
    try:
        body = json.loads((await request.body()).decode("utf-8") or "{}")
    except Exception:
        return JSONResponse(fail("請求不是合法 JSON"))
    handler = HANDLERS.get(body.get("action"))
    if not handler:
        return JSONResponse(fail(f"未知的動作：{body.get('action')}"))
    with _db_lock, db() as con:
        try:
            return JSONResponse(handler(con, body))
        except Exception as e:  # noqa: BLE001
            return JSONResponse(fail(f"伺服器錯誤：{e}"))


# 同時把前端 ( ../docs ) 當網頁服務，掛在 /
if Path(FRONTEND_DIR).is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


# endregion //
