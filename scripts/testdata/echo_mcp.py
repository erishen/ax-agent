#!/usr/bin/env python3
"""Tiny stdio JSON-RPC server used by the Rust MCP-client session-pool tests.

Speaks just enough of the MCP handshake (initialize / notifications/initialized
/ tools/list / tools/call) to let `mcp_client` reuse one child across several
tool calls, so tests can assert spawn-reuse without a real MCP server.

Behavior is stateless: replies "pong" to tools/call ping.
"""

import json
import os
import sys

PID = os.getpid()


def main() -> None:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except ValueError:
            continue
        rid = req.get("id")
        method = req.get("method")
        resp: dict = {"jsonrpc": "2.0", "id": rid}
        if method == "initialize":
            resp["result"] = {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "echo", "version": "0.0.1"},
            }
        elif method == "notifications/initialized":
            continue  # notification — no reply
        elif method == "tools/list":
            resp["result"] = {
                "tools": [
                    {
                        "name": "ping",
                        "description": "reply pong with the server pid",
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                ]
            }
        elif method == "tools/call":
            resp["result"] = {
                "content": [{"type": "text", "text": f"pong from pid {PID}"}]
            }
        else:
            resp["error"] = {"code": -32601, "message": "method not found"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
