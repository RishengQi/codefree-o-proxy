#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CodeFree-O refresh token 到期巡检（每日定时，剩余 < 2 天或已过期时企微提醒）

用法:
  python3 check-token-expiry.py                # 正常巡检（可发告警）
  python3 check-token-expiry.py --dry-run      # 只打印，不发企微
  python3 check-token-expiry.py --days 2       # 阈值天数（默认 2）
  python3 check-token-expiry.py --webhook KEY  # 指定企微机器人 key

数据来源: /opt/codefree-o-proxy/.auth-state.json（代理刷新成功后写入）
          回退 ~/.codefree-o/.local/share/codefree.json
重复告警抑制: 同一到期时间 20 小时内只提醒一次（状态存 .expiry-alert.json）
"""
import argparse
import http.client
import json
import os
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILES = [
    os.path.join(BASE_DIR, ".auth-state.json"),
    os.path.expanduser("~/.codefree-o/.local/share/codefree.json"),
]
# 固定为脚本同目录下的常量文件名；with_name 不接受路径分隔符，避免路径穿越
ALERT_STATE = Path(__file__).resolve().with_name(".expiry-alert.json")
DEFAULT_WEBHOOK = os.environ.get("CODEFREE_ALERT_WEBHOOK", "")
BJ = timezone(timedelta(hours=8))
SUPPRESS_HOURS = 20


def log(msg):
    print(f"{datetime.now(BJ).strftime('%Y-%m-%d %H:%M:%S')} [CodeFreeToken巡检] {msg}", flush=True)


def load_expiry():
    """返回 (expiresAt_ms, 来源文件)"""
    for path in STATE_FILES:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            exp = data.get("refreshCfTokenExpiresAt")
            if exp:
                return int(exp), path
        except FileNotFoundError:
            continue
        except Exception as exc:
            log(f"读取 {path} 失败: {exc}")
    return None, None


def send_wecom(key, text):
    # 固定企微主机，避免 SSRF；用 http.client 直连，webhook key 不进入进程命令行
    path = f"/cgi-bin/webhook/send?key={urllib.parse.quote(key, safe='')}"
    payload = json.dumps({"msgtype": "text", "text": {"content": text}}, ensure_ascii=False).encode("utf-8")
    conn = http.client.HTTPSConnection("qyapi.weixin.qq.com", timeout=15)
    try:
        conn.request("POST", path, body=payload, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        return resp.read().decode("utf-8", "replace").strip()
    except Exception as exc:
        return json.dumps({"errcode": -1, "errmsg": str(exc)}, ensure_ascii=False)
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=2.0, help="剩余天数阈值（默认 2 天）")
    ap.add_argument("--webhook", default=DEFAULT_WEBHOOK)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if args.webhook and not os.environ.get("CODEFREE_ALERT_WEBHOOK"):
        log("提示：建议使用环境变量 CODEFREE_ALERT_WEBHOOK，避免 --webhook 出现在命令历史/进程列表")

    expires_at, source = load_expiry()
    if not expires_at:
        log("未找到 refreshCfTokenExpiresAt（认证文件缺失？），跳过")
        return 1

    now = datetime.now(timezone.utc)
    exp_dt = datetime.fromtimestamp(expires_at / 1000, BJ)
    remain = exp_dt - datetime.now(BJ)
    remain_h = remain.total_seconds() / 3600
    state = "已过期" if remain_h <= 0 else f"剩余 {remain_h:.1f} 小时"
    log(f"refresh token 到期时间 {exp_dt.strftime('%Y-%m-%d %H:%M:%S')}（北京），{state}；来源 {source}")

    if remain_h > args.days * 24:
        log(f"剩余超过 {args.days:g} 天，无需提醒")
        return 0

    # 重复告警抑制：同一到期时间 20 小时内只提醒一次
    try:
        prev = json.loads(ALERT_STATE.read_text(encoding="utf-8"))
    except Exception:
        prev = {}
    last_at = prev.get("lastAlertAt", 0)
    last_exp = prev.get("lastAlertExpiresAt", 0)
    if int(last_exp) == expires_at and (datetime.now().timestamp() * 1000 - int(last_at)) < SUPPRESS_HOURS * 3600 * 1000:
        log("同一到期时间已在 20 小时内提醒过，跳过")
        return 0

    title = "【CodeFree 通道告警】CodeFree-O 登录凭据已过期" if remain_h <= 0 else "【CodeFree 通道预警】CodeFree-O 登录凭据即将过期"
    text = (
        f"{title}\n"
        f"到期时间：{exp_dt.strftime('%Y-%m-%d %H:%M')}（北京）\n"
        f"当前状态：{state}\n"
        f"影响：走 codefree provider 的会话（如 <pi-bot> 机器人）将返回 401 auth_expired\n"
        f"处理：在 CodeFree-O 客户端重新登录，然后 systemctl restart codefree-o-proxy"
    )
    if args.dry_run:
        log("[dry-run] 将推送:\n" + text)
        return 0
    if not args.webhook:
        log("未配置企微 webhook（CODEFREE_ALERT_WEBHOOK 或 --webhook），跳过推送")
        return 0

    resp = send_wecom(args.webhook, text)
    log(f"企微推送返回: {resp}")
    if '"errcode":0' in resp.replace(" ", ""):
        ALERT_STATE.write_text(
            json.dumps({"lastAlertAt": int(datetime.now().timestamp() * 1000),
                        "lastAlertExpiresAt": expires_at}),
            encoding="utf-8",
        )
    else:
        log("企微推送未成功，状态不更新（下次会重试）")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
