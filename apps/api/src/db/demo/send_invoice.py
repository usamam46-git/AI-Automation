"""
src/db/demo/send_invoice.py — sign and POST the demo invoice.

    docker exec -w /app aap_api python -m src.db.demo.send_invoice

The invoice workflow is webhook-triggered, not manual, and that is deliberate:
"Run now" sends an empty `trigger_payload`, so a manual invoice workflow has
nothing to extract from and the extraction agent would be inventing an invoice.
This script is the other half of that decision — one command that produces a
real, correctly signed inbound request.

It is also the only place in the repo that constructs the signature, so it
doubles as executable documentation of the scheme:

    signed material = f"{unix_timestamp}.{raw_request_body}"
    X-AAP-Signature = "sha256=" + hex(HMAC-SHA256(secret, signed_material))
    X-AAP-Timestamp = the same unix_timestamp

Two properties worth understanding before changing anything here. **The
timestamp is inside the signed material**, so a captured request cannot be
replayed past the server's freshness window — changing the timestamp invalidates
the signature. And **the signature covers the exact bytes sent**, not a
re-serialised copy of the parsed JSON: key order and whitespace are part of what
is signed, which is why the body is serialised exactly once below and both
hashed and posted from that same `bytes` object.

Every rejection comes back as one byte-identical 401 — unknown workflow, wrong
trigger type, no secret, forged signature, stale timestamp. That is
anti-enumeration and is not going to tell you which one you hit. If you get a
401, the overwhelmingly likely cause is a stale secret: re-run the seed with
`--rotate-webhook-secret`.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import sys
import time
import uuid
from pathlib import Path

import httpx

from src.db.demo.graphs import SAMPLE_INVOICE_PAYLOAD
from src.db.demo.seed import DEFAULT_STATE_FILE

#: The api container serves on 0.0.0.0:8000, so localhost works when this runs
#: inside `aap_api`. From another container it is `http://api:8000`; from the
#: host it is whatever `API_PORT` maps to.
DEFAULT_BASE_URL = "http://localhost:8000"

SIGNATURE_HEADER = "X-AAP-Signature"
TIMESTAMP_HEADER = "X-AAP-Timestamp"


def _load_state(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise SystemExit(
            f"No demo state at {path}.\n"
            f"Run the seed first:  python -m src.db.demo.seed --email you@example.com\n"
            f"If the workflow already has a secret, add --rotate-webhook-secret so a readable one is written."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def _sign(secret: str, timestamp: int, body: bytes) -> str:
    material = f"{timestamp}.".encode() + body
    return "sha256=" + hmac.new(secret.encode("utf-8"), material, hashlib.sha256).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Sign and POST the demo invoice at the webhook trigger.")
    parser.add_argument("--state-file", type=Path, default=DEFAULT_STATE_FILE, help=f"Seed state written by seed.py (default {DEFAULT_STATE_FILE}).")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"API base URL (default {DEFAULT_BASE_URL}).")
    parser.add_argument("--workflow-id", help="Override the workflow id from the state file.")
    parser.add_argument("--secret", help="Override the signing secret from the state file.")
    parser.add_argument("--payload-file", type=Path, help="A JSON file to send instead of the built-in INV-2291 invoice.")
    parser.add_argument(
        "--amount",
        type=float,
        help=(
            "Override the invoice gross total. Below 1000 the graph takes the auto_post branch and never "
            "stops for approval — useful for showing that the gate is a rule, not a step."
        ),
    )
    parser.add_argument("--tamper", action="store_true", help="Send a deliberately invalid signature, to show the 401.")
    args = parser.parse_args()

    state = {} if (args.workflow_id and args.secret) else _load_state(args.state_file)
    workflow_id = args.workflow_id or state.get("invoice_workflow_id")
    secret = args.secret or state.get("webhook_secret")
    if not workflow_id or not secret:
        raise SystemExit(f"State at {args.state_file} is missing the workflow id or the secret. Re-run the seed with --rotate-webhook-secret.")

    payload = json.loads(args.payload_file.read_text(encoding="utf-8")) if args.payload_file else json.loads(json.dumps(SAMPLE_INVOICE_PAYLOAD))
    if args.amount is not None:
        payload["totals"]["net"] = args.amount
        payload["totals"]["gross"] = args.amount
        payload["lines"][0]["line_total"] = args.amount
        payload["lines"][0]["unit_price"] = round(args.amount / payload["lines"][0]["qty"], 2)
        # A resent invoice number is a duplicate to the AP policy's §7 control,
        # so vary it with the amount rather than sending INV-2291 twice.
        payload["document"]["number"] = f"INV-{uuid.uuid4().hex[:4].upper()}"

    # Serialised ONCE. Signing a second serialisation of the same dict is the
    # classic way to produce a signature that does not match the bytes on the
    # wire — json.dumps is not guaranteed to be byte-stable across calls with
    # different arguments, and httpx's own `json=` would re-encode it.
    body = json.dumps(payload).encode("utf-8")
    timestamp = int(time.time())
    signature = _sign(secret, timestamp, body)
    if args.tamper:
        signature = "sha256=" + "0" * 64

    url = f"{args.base_url.rstrip('/')}/api/v1/triggers/workflows/{workflow_id}"
    print(f"POST {url}")
    print(f"  {TIMESTAMP_HEADER}: {timestamp}")
    print(f"  {SIGNATURE_HEADER}: {signature[:20]}…")
    print(f"  {len(body)} bytes · {payload['document']['number']} · {payload['totals']['gross']} {payload['totals']['ccy']}")

    try:
        response = httpx.post(
            url,
            content=body,
            headers={
                "Content-Type": "application/json",
                SIGNATURE_HEADER: signature,
                TIMESTAMP_HEADER: str(timestamp),
            },
            timeout=30.0,
        )
    except httpx.HTTPError as exc:
        raise SystemExit(f"\nCould not reach the API at {args.base_url}: {exc}") from exc

    print(f"\n← HTTP {response.status_code}")
    try:
        print(json.dumps(response.json(), indent=2))
    except ValueError:
        print(response.text)

    if response.status_code == 202:
        run_id = response.json().get("id")
        print(f"\nWatch it: /executions/{run_id}")
        print("It should reach waiting_approval and hold there. Nothing is written to the ledger until you approve.")
    elif response.status_code == 401:
        print(
            "\n401 is the uniform rejection — it does not say which check failed, on purpose.\n"
            "If you did not pass --tamper, the secret is almost certainly stale:\n"
            "  python -m src.db.demo.seed --email you@example.com --rotate-webhook-secret",
            file=sys.stderr,
        )
        raise SystemExit(1)
    else:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
