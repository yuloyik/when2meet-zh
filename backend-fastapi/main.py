"""
約時間 — FastAPI + SQLite 自架後端
API 合約與 backend-gas/Code.gs 完全相同：POST /api  body = {"action": "...", ...}
同時直接服務 ../docs 的前端（config.js 把 API_BASE 設成 '/api' 即可）。

啟動：
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8000
"""
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

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv()
except Exception:  # dotenv 是選用的
    pass

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = os.environ.get("DB_PATH", str(BASE_DIR / "data" / "meet.sqlite3"))
FRONTEND_DIR = os.environ.get("FRONTEND_DIR", str(BASE_DIR.parent / "docs"))
FRONTEND_URL = os.environ.get("FRONTEND_URL", "").rstrip("/")
DIGEST_HOUR = int(os.environ.get("DIGEST_HOUR", "9"))
MAX_DAYS = 62
SMTP = {k: os.environ.get(k, "") for k in ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM")}

# ---------- 資料庫 ----------
_db_lock = threading.Lock()


def db() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init_db() -> None:
    with db() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
              id TEXT PRIMARY KEY, title TEXT, creatorName TEXT, creatorEmail TEXT, salt TEXT, pwHash TEXT,
              mode TEXT, hourStart INTEGER, hourEnd INTEGER, dateStart TEXT, dateEnd TEXT, allowed TEXT,
              showResults INTEGER, showNames INTEGER, notifyMode TEXT, discordWebhook TEXT,
              finalSlots TEXT DEFAULT '[]', finalNote TEXT DEFAULT '', createdAt TEXT, updatedAt TEXT,
              extraOpen INTEGER DEFAULT 0);
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
        add_column(con, "participants", "extraSlots", "TEXT DEFAULT '[]'")
        add_column(con, "participants", "extraAt", "TEXT DEFAULT ''")


def add_column(con: sqlite3.Connection, table: str, col: str, ddl: str) -> None:
    have = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
    if col not in have:
        con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


# ---------- 工具 ----------
def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def rand_id(n: int) -> str:
    chars = "abcdefghjkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(chars) for _ in range(n))


def hash_pw(salt: str, pw: str) -> str:
    return hashlib.sha256(f"{salt}:{pw}".encode("utf-8")).hexdigest()


def fail(msg: str) -> dict:
    return {"ok": False, "error": msg}


def row_event(r: sqlite3.Row) -> dict:
    ev = dict(r)
    ev["allowed"] = json.loads(ev.get("allowed") or "[]")
    ev["finalSlots"] = json.loads(ev.get("finalSlots") or "[]")
    ev["showResults"] = bool(ev["showResults"])
    ev["showNames"] = bool(ev["showNames"])
    ev["extraOpen"] = bool(ev.get("extraOpen"))
    return ev


def row_part(r: sqlite3.Row) -> dict:
    p = dict(r)
    p["slots"] = json.loads(p.get("slots") or "[]")
    p["extraSlots"] = json.loads(p.get("extraSlots") or "[]")
    p["extraAt"] = p.get("extraAt") or ""
    return p


def find_event(con: sqlite3.Connection, eid: str) -> dict | None:
    r = con.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone()
    return row_event(r) if r else None


def list_parts(con: sqlite3.Connection, eid: str) -> list[dict]:
    return [row_part(r) for r in con.execute("SELECT * FROM participants WHERE eventId=? ORDER BY createdAt", (eid,))]


def save_event(con: sqlite3.Connection, ev: dict, new: bool = False) -> None:
    cols = ["id", "title", "creatorName", "creatorEmail", "salt", "pwHash", "mode", "hourStart", "hourEnd", "dateStart", "dateEnd",
            "allowed", "showResults", "showNames", "notifyMode", "discordWebhook", "finalSlots", "finalNote", "createdAt", "updatedAt", "extraOpen"]
    vals = [json.dumps(ev[c], ensure_ascii=False) if c in ("allowed", "finalSlots")
            else int(bool(ev.get(c))) if c in ("showResults", "showNames", "extraOpen") else ev.get(c, "") for c in cols]
    if new:
        con.execute(f"INSERT INTO events ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals)
    else:
        con.execute("UPDATE events SET " + ",".join(f"{c}=?" for c in cols[1:]) + " WHERE id=?", vals[1:] + [ev["id"]])


def save_part(con: sqlite3.Connection, p: dict, new: bool = False) -> None:
    if new:
        con.execute("INSERT INTO participants (eventId,name,email,salt,pwHash,slots,extraSlots,extraAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (p["eventId"], p["name"], p["email"], p["salt"], p["pwHash"], json.dumps(p["slots"]),
                     json.dumps(p.get("extraSlots") or []), p.get("extraAt") or "", p["createdAt"], p["updatedAt"]))
    else:
        con.execute("UPDATE participants SET email=?, slots=?, extraSlots=?, extraAt=?, updatedAt=? WHERE eventId=? AND name=?",
                    (p["email"], json.dumps(p["slots"]), json.dumps(p.get("extraSlots") or []), p.get("extraAt") or "", p["updatedAt"], p["eventId"], p["name"]))


def public_event(ev: dict) -> dict:
    return {k: ev.get(k) for k in ("id", "title", "creatorName", "mode", "hourStart", "hourEnd", "dateStart", "dateEnd", "allowed",
                                   "showResults", "showNames", "finalSlots", "finalNote", "extraOpen", "createdAt", "updatedAt")}


# ---- 補選（定案後在定案日期內重選）----
# 補選日期 = 定案時段所在的日期。填寫者有補選紀錄（extraAt 不為空）時，
# 有效空檔 = 「補選日期以外的原本空檔」+「補選日期內的補選空檔」；原本的 slots 不會被改動。
def slot_date(s: str) -> str:
    return str(s).split("|")[0]


def final_dates(ev: dict) -> list[str]:
    return sorted({slot_date(s) for s in (ev.get("finalSlots") or [])})


def effective_slots(ev: dict, p: dict) -> list[str]:
    dates = final_dates(ev)
    if not p.get("extraAt") or not dates:
        return p["slots"]
    allowed = set(ev["allowed"])
    keep = [s for s in p["slots"] if slot_date(s) not in dates]
    extra = [s for s in (p.get("extraSlots") or []) if s in allowed and slot_date(s) in dates]
    return sorted(set(keep + extra))


def own_part(p: dict) -> dict:
    return {"name": p["name"], "email": p.get("email", ""), "slots": p["slots"], "extraSlots": p.get("extraSlots") or [], "extraAt": p.get("extraAt") or ""}


def admin_event(ev: dict) -> dict:
    out = public_event(ev)
    out.update(creatorEmail=ev.get("creatorEmail", ""), notifyMode=ev.get("notifyMode"), discordWebhook=ev.get("discordWebhook", ""))
    return out


def pub_parts(lst: list[dict], show_names: bool, ev: dict) -> list[dict]:
    return [{"name": p["name"] if show_names else f"參與者 {i + 1}", "slots": effective_slots(ev, p)} for i, p in enumerate(lst)]


def admin_parts(lst: list[dict], ev: dict) -> list[dict]:
    return [{"name": p["name"], "email": p.get("email", ""), "slots": effective_slots(ev, p), "extraSlots": p.get("extraSlots") or [],
             "extraAt": p.get("extraAt") or "", "createdAt": p["createdAt"], "updatedAt": p["updatedAt"]} for p in lst]


def is_date(s: Any) -> bool:
    try:
        date.fromisoformat(str(s))
        return True
    except Exception:
        return False


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
        return "要收通知就需要填 email"
    if d.get("extraOpen") and not d.get("finalSlots"):
        return "開放補選需要先設定定案時段"
    return None


def check_admin(con: sqlite3.Connection, d: dict) -> tuple[dict | None, dict | None]:
    ev = find_event(con, str(d.get("id")))
    if not ev:
        return None, fail("找不到這個活動")
    if ev["pwHash"] != hash_pw(ev["salt"], str(d.get("password") or "")):
        return None, fail("創辦人密碼不正確")
    return ev, None


# ---------- 通知 ----------
def event_link(eid: str) -> str:
    return f"{FRONTEND_URL}/#/e/{eid}" if FRONTEND_URL else "（未設定 FRONTEND_URL）"


def fmt_slot(s: str) -> str:
    d, _, key = s.partition("|")
    names = {"am": "上午", "noon": "中午", "pm": "下午", "eve": "晚上"}
    return f"{d} {names.get(key, f'{key}:00–{int(key) + 1:02d}:00' if key.isdigit() else key)}"


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


def send_discord(url: str, content: str) -> None:
    try:
        req = urllib.request.Request(url, data=json.dumps({"content": content}).encode(), headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:  # noqa: BLE001
        print("Discord 失敗:", e)


def notify_change(con: sqlite3.Connection, ev: dict, who: str, what: str) -> None:
    text = f"【約時間】{who} {what} — {ev['title']}"
    if ev.get("discordWebhook"):
        threading.Thread(target=send_discord, args=(ev["discordWebhook"], f"{text}\n{event_link(ev['id'])}/admin"), daemon=True).start()
    if ev["notifyMode"] == "instant" and ev.get("creatorEmail"):
        threading.Thread(target=send_mail, args=(ev["creatorEmail"], text, f"{who} {what}。\n\n後台：{event_link(ev['id'])}/admin"), daemon=True).start()
    elif ev["notifyMode"] == "daily":
        con.execute("INSERT INTO changes (eventId,name,action,at,sent) VALUES (?,?,?,?,0)", (ev["id"], who, what, now()))


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


# ---------- 動作 ----------
def h_create_event(con, d):
    err = validate_event(d)
    if err:
        return fail(err)
    if len(str(d.get("password") or "")) < 4:
        return fail("密碼至少 4 個字")
    eid = rand_id(10)
    while find_event(con, eid):
        eid = rand_id(10)
    salt = rand_id(16)
    ev = dict(id=eid, title=str(d["title"]).strip(), creatorName=str(d.get("creatorName") or "").strip(), creatorEmail=str(d.get("creatorEmail") or "").strip(),
              salt=salt, pwHash=hash_pw(salt, d["password"]), mode=d["mode"], hourStart=int(d["hourStart"]), hourEnd=int(d["hourEnd"]),
              dateStart=d["dateStart"], dateEnd=d["dateEnd"], allowed=sorted(set(map(str, d["allowed"]))), showResults=bool(d.get("showResults")),
              showNames=bool(d.get("showNames")), notifyMode=d["notifyMode"], discordWebhook=str(d.get("discordWebhook") or "").strip(),
              finalSlots=[], finalNote="", extraOpen=False, createdAt=now(), updatedAt=now())
    save_event(con, ev, new=True)
    return {"ok": True, "id": eid}


def h_get_event(con, d):
    ev = find_event(con, str(d.get("id")))
    if not ev:
        return fail("找不到這個活動")
    lst = list_parts(con, ev["id"])
    out = {"ok": True, "event": public_event(ev), "participantCount": len(lst)}
    if ev["showResults"]:
        out["participants"] = pub_parts(lst, ev["showNames"], ev)
    return out


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
        return fail("密碼至少 4 個字")
    if any(p["name"] == name for p in list_parts(con, ev["id"])):
        return fail("這個名稱已經有人用了；如果是你本人，請改用「修改我的選擇」登入")
    salt = rand_id(16)
    p = dict(eventId=ev["id"], name=name, email=str(d.get("email") or "").strip(), salt=salt, pwHash=hash_pw(salt, d["password"]), slots=[], extraSlots=[], extraAt="", createdAt=now(), updatedAt=now())
    save_part(con, p, new=True)
    notify_change(con, ev, name, "加入了活動")
    return {"ok": True, "participant": own_part(p)}


def _auth_part(con, d):
    ev = find_event(con, str(d.get("id")))
    if not ev:
        return None, None, fail("找不到這個活動")
    name = str(d.get("name") or "").strip()
    p = next((x for x in list_parts(con, ev["id"]) if x["name"] == name), None)
    if not p or p["pwHash"] != hash_pw(p["salt"], str(d.get("password") or "")):
        return None, None, fail("名稱或密碼不正確")
    return ev, p, None


def h_login_participant(con, d):
    ev, p, err = _auth_part(con, d)
    if err:
        return err
    return {"ok": True, "participant": own_part(p)}


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
    notify_change(con, ev, p["name"], f"更新了空檔（{len(p['slots'])} 格）")
    return {"ok": True, "participant": own_part(p), "notified": ev["notifyMode"]}


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


def h_admin_login(con, d):
    ev, err = check_admin(con, d)
    if err:
        return err
    return {"ok": True, "event": admin_event(ev), "participants": admin_parts(list_parts(con, ev["id"]), ev)}


FIELDS = ["title", "creatorName", "creatorEmail", "mode", "hourStart", "hourEnd", "dateStart", "dateEnd", "allowed", "showResults", "showNames", "notifyMode", "discordWebhook", "finalSlots", "finalNote", "extraOpen"]


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
    ev.update({f: patch[f] for f in FIELDS if f in patch})
    ev["hourStart"], ev["hourEnd"] = int(ev["hourStart"]), int(ev["hourEnd"])
    ev["allowed"] = sorted(set(map(str, ev["allowed"])))
    ev["finalSlots"] = sorted(set(map(str, ev.get("finalSlots") or [])))
    ev["extraOpen"] = bool(ev.get("extraOpen"))
    if patch.get("newPassword"):
        if len(str(patch["newPassword"])) < 4:
            return fail("密碼至少 4 個字")
        ev["salt"] = rand_id(16)
        ev["pwHash"] = hash_pw(ev["salt"], patch["newPassword"])
    ev["updatedAt"] = now()
    save_event(con, ev)
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


def h_admin_delete_participant(con, d):
    ev, err = check_admin(con, d)
    if err:
        return err
    con.execute("DELETE FROM participants WHERE eventId=? AND name=?", (ev["id"], str(d.get("name") or "")))
    return {"ok": True, "event": admin_event(ev), "participants": admin_parts(list_parts(con, ev["id"]), ev)}


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


HANDLERS = {
    "createEvent": h_create_event, "getEvent": h_get_event, "joinEvent": h_join_event, "loginParticipant": h_login_participant,
    "saveSlots": h_save_slots, "saveExtraSlots": h_save_extra_slots, "adminLogin": h_admin_login, "adminUpdate": h_admin_update,
    "adminDeleteParticipant": h_admin_delete_participant, "adminNotifyFinal": h_admin_notify_final,
}

# ---------- FastAPI ----------
app = FastAPI(title="約時間 API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
def _startup() -> None:
    init_db()
    threading.Thread(target=digest_loop, daemon=True).start()


@app.get("/api")
def api_info():
    return {"ok": True, "service": "約時間 API", "hint": "請用 POST 傳 JSON {action: ...}"}


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


if Path(FRONTEND_DIR).is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
