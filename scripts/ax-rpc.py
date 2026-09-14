#!/usr/bin/env python3
"""ax-explorer JSON-RPC CLI client — drive the loopback server for observe+act.

Usage:
  ./ax-rpc.py ping
  ./ax-rpc.py permissions
  ./ax-rpc.py list-apps
  ./ax-rpc.py frontmost
  ./ax-rpc.py tree <pid> [depth]
  ./ax-rpc.py tree-text <pid> [depth]
  ./ax-rpc.py menu <pid>
  ./ax-rpc.py element-at <x> <y>
  ./ax-rpc.py trace <x> <y>
  ./ax-rpc.py actuate <pid> <a,b,c> <action>        # path as comma list
  ./ax-rpc.py focus <pid> <a,b,c>
  ./ax-rpc.py scroll-to <pid> <a,b,c>
  ./ax-rpc.py set-value <pid> <a,b,c> <text>        # + post-verify
  ./ax-rpc.py set-position <pid> <a,b,c> <x> <y>    # + post-verify
  ./ax-rpc.py scroll <x> <y> <lines>
  ./ax-rpc.py key <combo>
  ./ax-rpc.py type-keys <text>
  ./ax-rpc.py click <x> <y>
  ./ax-rpc.py dc <x> <y>                            # double click
  ./ax-rpc.py right-click <x> <y>
  ./ax-rpc.py drag <fx> <fy> <tx> <ty> [steps]
  ./ax-rpc.py observe-register <pid>
  ./ax-rpc.py observe-unregister <pid>
  ./ax-rpc.py observe-wait <pid> [timeout]          # block for a UI change
  ./ax-rpc.py shot <pid> [out.png]                  # screenshot to file

Set AX_RPC_* for server defaults. Exits 1 and prints the RPC error on failure.
"""

import base64
import json
import os
import sys
import urllib.request

ENDPOINT = os.environ.get("AX_RPC_URL", "http://127.0.0.1:8931/rpc")
TOKEN_FILE = os.path.expanduser("~/.ax-explorer/rpc.token")
_counter = 0


def _token():
    """Bearer token for the loopback server (AX_RPC_TOKEN wins; else file)."""
    t = os.environ.get("AX_RPC_TOKEN")
    if t:
        return t
    try:
        with open(TOKEN_FILE) as f:
            t = f.read().strip()
        return t or None
    except OSError:
        return None


def rpc(method, params=None):
    global _counter
    _counter += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _counter, "method": method, "params": params or {}})
    headers = {"Content-Type": "application/json"}
    tok = _token()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    req = urllib.request.Request(ENDPOINT, data=body.encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        out = json.load(resp)
    if "error" in out:
        sys.stderr.write(f"[rpc] {method}: {out['error']['message']}\n")
        sys.exit(1)
    return out.get("result")


def path(v):
    return [int(x) for x in v.split(",")] if v else []


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return
    cmd, rest = a[0], a[1:]
    try:
        if cmd == "ping":
            print(rpc("ax.ping"))
        elif cmd == "permissions":
            print(json.dumps(rpc("ax.permissions"), ensure_ascii=False, indent=2))
        elif cmd == "list-apps":
            for app in rpc("ax.list_apps"):
                print(f"{app['pid']:<7} {app['name']}")
        elif cmd == "frontmost":
            print(rpc("ax.frontmost"))
        elif cmd in ("tree", "tree-text"):
            pid, depth = int(rest[0]), (int(rest[1]) if len(rest) > 1 else 10)
            node = rpc("ax.tree", {"pid": pid, "depth": depth}) if cmd == "tree" else rpc("ax.tree.text", {"pid": pid, "depth": depth})
            print(node if isinstance(node, str) else json.dumps(node, ensure_ascii=False, indent=2))
        elif cmd == "menu":
            print(json.dumps(rpc("ax.menu_bar", {"pid": int(rest[0])}), ensure_ascii=False, indent=2))
        elif cmd in ("element-at", "trace"):
            x, y = float(rest[0]), float(rest[1])
            print(json.dumps(rpc("ax." + cmd.replace("-", "_"), {"x": x, "y": y}), ensure_ascii=False, indent=2))
        elif cmd == "actuate":
            pid, pth, action = int(rest[0]), path(rest[1]), rest[2]
            print(json.dumps(rpc("ax.actuate", {"pid": pid, "path": pth, "action": action}), ensure_ascii=False))
        elif cmd == "focus":
            print(json.dumps(rpc("ax.focus", {"pid": int(rest[0]), "path": path(rest[1])}), ensure_ascii=False))
        elif cmd == "scroll-to":
            print(json.dumps(rpc("ax.scroll_to", {"pid": int(rest[0]), "path": path(rest[1])}), ensure_ascii=False))
        elif cmd == "set-value":
            pid, pth, text = int(rest[0]), path(rest[1]), " ".join(rest[2:])
            print(json.dumps(rpc("ax.set_value", {"pid": pid, "path": pth, "text": text}), ensure_ascii=False))
        elif cmd == "set-position":
            pid, pth, x, y = int(rest[0]), path(rest[1]), float(rest[2]), float(rest[3])
            print(json.dumps(rpc("ax.set_position", {"pid": pid, "path": pth, "x": x, "y": y}), ensure_ascii=False))
        elif cmd == "scroll":
            x, y, lines = float(rest[0]), float(rest[1]), float(rest[2])
            print(json.dumps(rpc("ax.scroll", {"x": x, "y": y, "lines": lines}), ensure_ascii=False))
        elif cmd == "key":
            print(json.dumps(rpc("ax.key", {"combo": rest[0]}), ensure_ascii=False))
        elif cmd == "type-keys":
            print(json.dumps(rpc("ax.type_keys", {"text": " ".join(rest)}), ensure_ascii=False))
        elif cmd in ("click", "dc", "right-click"):
            name = {"click": "click_at", "dc": "double_click_at", "right-click": "right_click_at"}[cmd]
            x, y = float(rest[0]), float(rest[1])
            print(json.dumps(rpc("ax." + name, {"x": x, "y": y}), ensure_ascii=False))
        elif cmd == "drag":
            fx, fy, tx, ty = (float(v) for v in rest[:4])
            params = {"from_x": fx, "from_y": fy, "to_x": tx, "to_y": ty}
            if len(rest) > 4:
                params["steps"] = int(rest[4])
            print(json.dumps(rpc("ax.drag", params), ensure_ascii=False))
        elif cmd == "observe-register":
            print(json.dumps(rpc("ax.observe.register", {"pid": int(rest[0])}), ensure_ascii=False))
        elif cmd == "observe-unregister":
            print(json.dumps(rpc("ax.observe.unregister", {"pid": int(rest[0])}), ensure_ascii=False))
        elif cmd == "observe-wait":
            pid = int(rest[0])
            timeout = int(rest[1]) if len(rest) > 1 else 1
            print(json.dumps(rpc("ax.observe.wait", {"pid": pid, "timeout": timeout}), ensure_ascii=False))
        elif cmd == "shot":
            pid = int(rest[0])
            out = rest[1] if len(rest) > 1 else f"/tmp/ax-shot-{pid}.png"
            data = rpc("ax.screenshot", {"pid": pid})
            with open(out, "wb") as f:
                f.write(base64.b64decode(data["image"].split(",", 1)[1]))
            print(f"saved {len(data['image'])} bytes -> {out} (window {data['window_id']})")
        else:
            sys.stderr.write(f"未知命令: {cmd}\n")
            print(__doc__)
            sys.exit(2)
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"HTTP {e.code}: {e.read().decode()}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()