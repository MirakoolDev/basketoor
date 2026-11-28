"""DCAC tool handlers. Standard library only. Each tool is a thin call to DCAC's public agent API, which reads
Base and returns links or unsigned transactions. Handlers return a JSON string and never raise."""

import json
import urllib.request

API = "https://dcac.fun/api/agents"
UA = {"User-Agent": "dcac-hermes-plugin/1.0", "Content-Type": "application/json"}

# Kept in sync with https://dcac.fun/api/agents (the API is the source of truth; this is the offline fallback).
_FALLBACK = {
    "dcac_assets": "List what DCAC can buy on a schedule on Base, with live prices and whether each can buy now.",
    "dcac_indexes": "Browse Bankr index tokens on Base and whether DCAC can buy each on a schedule.",
    "dcac_quote": "Price a recurring-buy plan: per-buy amounts, fee, total USDC deposit, last buy date.",
    "dcac_build_plan": "A prefilled dcac.fun link plus unsigned approve and create transactions. Never signs.",
    "dcac_plans": "Every DCAC plan a wallet owns, with holdings, profit and next buy.",
    "dcac_plan": "One DCAC plan by number.",
    "dcac_build_cancel": "Unsigned transaction that stops a plan and refunds unspent USDC.",
}


def _request(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, headers=UA, method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8")
    except urllib.error.HTTPError as e:  # 400s carry {"error": "..."} worth showing
        return e.read().decode("utf-8")


def load_schemas():
    try:
        tools = json.loads(_request(""))["tools"]
        return {t["name"]: {"name": t["name"], "description": t["description"], "parameters": t["input"]} for t in tools}
    except Exception:  # noqa: BLE001
        return {n: {"name": n, "description": d, "parameters": {"type": "object", "properties": {}}} for n, d in _FALLBACK.items()}


def handler(name):
    def run(args: dict, **kwargs) -> str:
        try:
            return _request("/" + name.removeprefix("dcac_"), args or {})
        except Exception as e:  # noqa: BLE001
            return json.dumps({"error": f"DCAC API unavailable: {e}"})

    return run
