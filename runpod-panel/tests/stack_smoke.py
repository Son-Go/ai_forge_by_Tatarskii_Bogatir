"""Check the isolated stack with the panel healthy or stopped."""

import argparse
import base64
import json
from time import monotonic, sleep
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4

CHAT = "http://127.0.0.1:19080"
GRAFANA = "http://127.0.0.1:19030"
PANEL = "http://127.0.0.1:18765"
HTTP = build_opener(ProxyHandler({}))
GRAFANA_HEADERS = {
    "Authorization": "Basic " + base64.b64encode(b"admin:local-fixture-grafana").decode()
}


def fetch(url, *, data=None, headers=None, method=None):
    with HTTP.open(Request(url, data, headers or {}, method=method), timeout=20) as response:
        return response.read(), response.headers, response.status


def check_catalog():
    deadline = monotonic() + 30
    while monotonic() < deadline:
        try:
            assert fetch(CHAT + "/health/ready")[2] == 200
            return
        except HTTPError as error:
            if error.code != 503:
                raise
            sleep(1)
    raise AssertionError("The synthetic catalog did not become ready")


def check_chat():
    markup, _, status = fetch(CHAT + "/")
    assert status == 200 and b"<html" in markup
    assert fetch(CHAT + "/health/live")[2] == 200
    check_catalog()

    headers = {"Origin": CHAT, "Content-Type": "application/json"}
    base = CHAT + "/api/v1/sessions"
    body, response_headers, status = fetch(base, headers=headers, method="POST")
    assert status == 201
    headers["Cookie"] = response_headers["Set-Cookie"].split(";", 1)[0]
    session_id = json.loads(body)["session_id"]
    url = f"{base}/{session_id}/messages"
    body = json.dumps({"client_message_id": str(uuid4()), "text": "Подберите DemoMail."}).encode()
    raw, info, status = fetch(url, data=body, headers=headers)
    assert status == 200 and info["Content-Type"].startswith("text/event-stream")
    events = []
    for frame in raw.decode().replace("\r\n", "\n").split("\n\n"):
        fields = dict(line.split(":", 1) for line in frame.splitlines() if ":" in line)
        if "event" in fields and "data" in fields:
            events.append((fields["event"].strip(), json.loads(fields["data"])))
    assert events[0][0] == "accepted" and events[-1][0] == "done", events
    assert events[-1][1]["outcome"] == "recommend", events
    assert any(kind == "delta" and "DemoMail" in json.dumps(data) for kind, data in events), events
    completed = events[-1][1]["message"]
    history, _, _ = fetch(f"{base}/{session_id}", headers=headers)
    restored = json.loads(history)["messages"][-1]
    for field in ("text", "cards", "sources"):
        assert restored[field] == completed[field], (field, restored, completed)
    return events[0][1]["request_id"]


def check_grafana(request_id):
    deadline = monotonic() + 60
    while monotonic() < deadline:
        try:
            health, _, _ = fetch(GRAFANA + "/api/health")
            if json.loads(health).get("database") == "ok":
                break
        except (URLError, ConnectionError, TimeoutError):
            pass
        sleep(1)
    else:
        raise AssertionError("Grafana did not finish starting")

    url = GRAFANA + "/api/dashboards/uid/runpod-token-usage"
    try:
        fetch(url)
        raise AssertionError("Grafana offered anonymous access")
    except HTTPError as error:
        assert error.code == 401
    assert (
        json.loads(fetch(url, headers=GRAFANA_HEADERS)[0])["dashboard"]["uid"]
        == "runpod-token-usage"
    )

    # A standard recommendation uses only the interpretation call.
    url = GRAFANA + "/api/datasources/proxy/uid/loki/loki/api/v1/query_range?"
    query = '{service="ml-service"} | json | request_id="' + request_id + '"'
    deadline = monotonic() + 40
    while monotonic() < deadline:
        body, _, _ = fetch(
            url + urlencode({"query": query, "since": "5m"}), headers=GRAFANA_HEADERS
        )
        entries = json.loads(body)["data"]["result"]
        rows = [json.loads(value) for stream in entries for _, value in stream["values"]]
        if rows:
            assert [(row["stage"], row["status"], row["usage_status"]) for row in rows] == [
                ("interpret", "ok", "reported")
            ], rows
            return
        sleep(2)
    raise AssertionError("Grafana Loki datasource did not report the interpretation call")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("panel", choices=["on", "off"])
    args = parser.parse_args()
    if args.panel == "on":
        assert json.loads(fetch(PANEL + "/healthz")[0]) == {"status": "ok"}
    else:
        try:
            fetch(PANEL + "/healthz")
            raise AssertionError("Panel port still reachable")
        except URLError as error:
            assert not isinstance(error, HTTPError)
    request_id = check_chat()
    check_grafana(request_id)
    print(f"Panel {args.panel}: chat, SSE recommendation, ML and Grafana passed")


if __name__ == "__main__":
    main()
