#!/usr/bin/env python3
"""KNXCoin protocol-v2 cloud miner used by the SCRM WISP service.

The WISP process starts/stops this file. It deliberately uses the browser-miner
session header so two independent Northflank WISP deployments can occupy the
same two mining slots without invalidating each other's templates.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import random
import signal
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

NODE_URL = os.getenv("KNX_NODE_URL", "https://knxcoin.vercel.app").rstrip("/")
API_KEY = os.getenv("KNX_API_KEY", "").strip()
SESSION_ID = os.getenv("KNX_MINER_SESSION_ID", "").strip() or str(uuid.uuid4())
STATUS_POLL_SECONDS = max(1.0, float(os.getenv("KNX_STATUS_POLL_SECONDS", "2")))
LOG_INTERVAL_SECONDS = max(1.0, float(os.getenv("KNX_LOG_INTERVAL_SECONDS", "5")))
HTTP_TIMEOUT_SECONDS = max(3.0, float(os.getenv("KNX_HTTP_TIMEOUT_SECONDS", "20")))
HASH_CHECK_INTERVAL = max(1024, int(os.getenv("KNX_HASH_CHECK_INTERVAL", "8192")))
HASH_THROTTLE_SECONDS = max(0.0, float(os.getenv("KNX_HASH_THROTTLE_MS", "1")) / 1000.0)
USER_AGENT = "scrm-cloud-miner/1.0"
RUNNING = True


def emit(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, "time": dt.datetime.now(dt.timezone.utc).isoformat(), **fields}, separators=(",", ":")), flush=True)


def sha256d(data: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def display_hash(raw: bytes) -> str:
    return raw[::-1].hex()


def header_bytes(version: int, previous_hash: str, merkle_root: str, timestamp: int, bits: int, nonce: int) -> bytes:
    return (
        struct.pack("<i", version)
        + bytes.fromhex(previous_hash)[::-1]
        + bytes.fromhex(merkle_root)[::-1]
        + struct.pack("<III", timestamp, bits, nonce)
    )


def coinbase_txid(template: dict, extranonce: str) -> str:
    reward = int(template["subsidy_shards"]) + int(template["fees_shards"])
    body = "knxcoin/coinbase/v2|{}|{}|{}|{}".format(
        template["height"], template["miner_address"], reward, extranonce
    )
    return hashlib.sha256(body.encode()).hexdigest()


def merkle_root(txids: list[str]) -> str:
    level = [bytes.fromhex(value)[::-1] for value in txids]
    if not level:
        raise ValueError("empty merkle tree")
    while len(level) > 1:
        if len(level) & 1:
            level.append(level[-1])
        level = [sha256d(level[i] + level[i + 1]) for i in range(0, len(level), 2)]
    return level[0][::-1].hex()


def request(path: str, payload: dict | None = None, *, method: str = "POST") -> dict:
    data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    headers = {
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
        "Authorization": "Bearer " + API_KEY,
        "x-knx-miner-session": SESSION_ID,
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(NODE_URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        message = f"HTTP {error.code}"
        try:
            body = json.loads(raw.decode("utf-8", "replace"))
            if isinstance(body, dict):
                message = str(body.get("error") or body.get("message") or message)
        except Exception:
            pass
        retry_after = error.headers.get("Retry-After")
        raise RuntimeError(f"{message}|status={error.code}|retry={retry_after or ''}") from error


def parse_error(error: Exception) -> tuple[int | None, float | None, str]:
    text = str(error)
    status = None
    retry = None
    for part in text.split("|"):
        if part.startswith("status="):
            try:
                status = int(part[7:])
            except ValueError:
                pass
        elif part.startswith("retry=") and part[6:]:
            try:
                retry = float(part[6:])
            except ValueError:
                pass
    return status, retry, text.split("|", 1)[0]


def template_expiry(template: dict) -> float:
    return dt.datetime.fromisoformat(str(template["expires_at"]).replace("Z", "+00:00")).timestamp()


def template_still_active(template: dict) -> bool:
    address = urllib.parse.quote(str(template["miner_address"]), safe="")
    status = request(f"/api/mining/status?address={address}", None, method="GET")
    active = status.get("active_template")
    return (
        isinstance(active, dict)
        and str(active.get("template_id")) == str(template["template_id"])
        and int(active.get("block_index", -1)) == int(template["height"])
    )


def mine(template: dict) -> tuple[dict | None, int, float]:
    target = int(str(template["target"]), 16)
    expiry = template_expiry(template)
    started = time.monotonic()
    attempts = 0
    next_status = time.monotonic() + STATUS_POLL_SECONDS
    next_log = time.monotonic() + LOG_INTERVAL_SECONDS

    for extra_value in range(1, 1 << 64):
        if not RUNNING or time.time() >= expiry:
            return None, attempts, attempts / max(0.001, time.monotonic() - started)

        extranonce = extra_value.to_bytes(8, "big").hex()
        root = merkle_root([coinbase_txid(template, extranonce)] + list(template.get("transaction_ids", [])))
        timestamp = max(int(time.time()), int(template["minimum_timestamp"]), int(template["timestamp"]))
        start_nonce = random.getrandbits(32)

        for offset in range(1 << 32):
            nonce = (start_nonce + offset) & 0xFFFF_FFFF
            raw = sha256d(
                header_bytes(
                    int(template["version"]),
                    str(template["previous_hash"]),
                    root,
                    timestamp,
                    int(template["bits"]),
                    nonce,
                )
            )
            attempts += 1

            if int.from_bytes(raw, "little") <= target:
                return {
                    "protocol_version": 2,
                    "template_id": template["template_id"],
                    "extranonce": extranonce,
                    "timestamp": timestamp,
                    "nonce": nonce,
                    "merkle_root": root,
                    "header_hash": display_hash(raw),
                }, attempts, attempts / max(0.001, time.monotonic() - started)

            if attempts % HASH_CHECK_INTERVAL == 0:
                if not RUNNING or time.time() >= expiry:
                    return None, attempts, attempts / max(0.001, time.monotonic() - started)

                now = time.monotonic()
                if now >= next_status:
                    try:
                        if not template_still_active(template):
                            emit("stale", height=int(template["height"]), attempts=attempts)
                            return None, attempts, attempts / max(0.001, now - started)
                    except Exception as error:
                        emit("status_warning", message=str(error)[:240])
                    next_status = now + STATUS_POLL_SECONDS

                if now >= next_log:
                    rate = attempts / max(0.001, now - started)
                    emit("mining", height=int(template["height"]), attempts=attempts, hash_rate_hs=round(rate, 2))
                    next_log = now + LOG_INTERVAL_SECONDS

                if HASH_THROTTLE_SECONDS:
                    time.sleep(HASH_THROTTLE_SECONDS)

    return None, attempts, attempts / max(0.001, time.monotonic() - started)


def submit_solution(solution: dict, expiry: float) -> dict | None:
    delay = 0.25
    for attempt in range(1, 7):
        if not RUNNING or time.time() >= expiry:
            return None
        try:
            return request("/api/mining/submit", solution)
        except Exception as error:
            status, retry_after, message = parse_error(error)
            if status in (404, 409, 410, 422):
                emit("submit_stale", message=message)
                return None
            if status in (401, 403):
                raise
            if status == 429 and retry_after is not None:
                delay = max(delay, retry_after)
            emit("submit_retry", attempt=attempt, message=message)
            time.sleep(min(delay, max(0.0, expiry - time.time())))
            delay = min(4.0, delay * 2)
    return None


def stop(*_args: object) -> None:
    global RUNNING
    RUNNING = False


def main() -> int:
    if not API_KEY:
        emit("fatal", message="KNX_API_KEY is not configured on this Northflank service")
        return 2

    # Keep the proxy responsive while hashing. Linux gives the WISP process
    # scheduling priority over this CPU-bound child.
    try:
        os.nice(10)
    except Exception:
        pass

    emit(
        "started",
        node=NODE_URL,
        session_id=SESSION_ID,
        status_poll_seconds=STATUS_POLL_SECONDS,
        hash_throttle_ms=HASH_THROTTLE_SECONDS * 1000,
    )

    delay = 1.0
    while RUNNING:
        try:
            template = request("/api/mining/template", {})
            delay = 1.0
            emit(
                "job",
                height=int(template["height"]),
                template_id=str(template["template_id"]),
                expires_at=str(template["expires_at"]),
            )
            solution, attempts, rate = mine(template)
            if not RUNNING:
                break
            if solution is None:
                continue

            emit("solved", height=int(template["height"]), attempts=attempts, hash_rate_hs=round(rate, 2), header_hash=solution["header_hash"])
            result = submit_solution(solution, template_expiry(template))
            if result and result.get("accepted"):
                emit("accepted", height=result.get("height", template["height"]), block_hash=result.get("hash", solution["header_hash"]))
        except Exception as error:
            status, retry_after, message = parse_error(error)
            if status in (409, 410):
                delay = 0.25
            elif status == 429:
                delay = max(1.0, retry_after or delay * 2)
            elif status == 503:
                delay = max(10.0, retry_after or 15.0)
            elif status in (401, 403):
                delay = 30.0
            else:
                delay = min(60.0, max(1.0, delay * 2))
            emit("retry", status=status, delay_seconds=round(delay, 2), message=message[:240])
            end = time.monotonic() + delay + random.random() * min(1.0, delay / 10)
            while RUNNING and time.monotonic() < end:
                time.sleep(0.1)

    emit("stopped")
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    raise SystemExit(main())
