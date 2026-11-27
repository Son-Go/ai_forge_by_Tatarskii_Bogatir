"""Exercise the manager queue over HTTP against a disposable, configured backend."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4


QUEUE = "/api/v1/manager/handoffs"
SESSIONS = "/api/v1/sessions"


def accepted_messages(metrics_url):
    with urlopen(metrics_url, timeout=10) as response:
        for line in response.read().decode().splitlines():
            if line.startswith("chat_user_messages_accepted_total "):
                return float(line.split()[1])
    raise AssertionError("Missing chat_user_messages_accepted_total")


def run(origin, managers, metrics_url=None):
    def call(path, *, method="GET", body=None, cookie=None, token=None, expected=200):
        headers = {"Origin": origin}
        if cookie:
            headers["Cookie"] = cookie
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
        data = None if body is None else json.dumps(body).encode()
        request = Request(origin + path, data=data, headers=headers, method=method)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            assert response.code in ({expected} if isinstance(expected, int) else expected), (path, response.code)
            if path.startswith(QUEUE):
                assert response.headers.get("Cache-Control") == "no-store"
            payload = response.read().decode()
            if response.headers.get_content_type() == "application/json":
                payload = json.loads(payload)
            return response.code, payload, response.headers

    def new_session():
        _, session, headers = call(SESSIONS, method="POST", expected=201)
        return f"{SESSIONS}/{session['session_id']}", headers["Set-Cookie"].split(";", 1)[0]

    def send(path, cookie, text, message_id=None):
        body = {"client_message_id": message_id or str(uuid4()), "text": text}
        _, stream, _ = call(path + "/messages", method="POST", cookie=cookie, body=body)
        assert "event:accepted" in stream and "event:done" in stream, stream
        return stream

    def handoff(path, cookie):
        return call(path + "/handoff", cookie=cookie)[1]["handoff"]

    assert call(QUEUE, expected=401)[1]["code"] == "MANAGER_AUTH_REQUIRED"
    assert call(QUEUE + "/" + str(uuid4()) + "/claim", method="POST", expected=401)[1]["code"] == "MANAGER_AUTH_REQUIRED"
    path, cookie = new_session()
    assert handoff(path, cookie) is None
    assert call(QUEUE, cookie=cookie, expected=401)[1]["code"] == "MANAGER_AUTH_REQUIRED"
    document = "Пожалуйста, проверьте наши документы по заказу."
    client_message = str(uuid4())
    if metrics_url:
        before = accepted_messages(metrics_url)
    assert "event:status" not in send(path, cookie, document, client_message)
    if metrics_url:
        assert accepted_messages(metrics_url) == before + 1
    queued = handoff(path, cookie)
    assert queued["reason"] == "document_review" and queued["status"] == "queued"
    send(path, cookie, document, client_message)
    if metrics_url:
        assert accepted_messages(metrics_url) == before + 1
    assert handoff(path, cookie) == queued
    case = QUEUE + "/" + queued["handoff_id"]
    for token in managers:
        queue = call(QUEUE, token=token)[1]
        assert [item["handoff_id"] for item in queue] == [queued["handoff_id"]]
        assert "messages" not in queue[0]
        call(case, token=token, expected=404)

    def claim(token):
        result = call(case + "/claim", method="POST", token=token, expected={200, 409})
        return result[0], token

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = sorted(pool.map(claim, managers))
    assert [code for code, _ in results] == [200, 409]
    manager, other = [token for _, token in results]
    assert call(case + "/claim", method="POST", token=manager)[1]["status"] == "in_progress"
    assert call(QUEUE, token=other)[1] == []
    call(case, token=other, expected=404)
    call(case + "/resolve", method="POST", token=other, expected=404)
    send(path, cookie, "Дополнительные сведения для менеджера.")
    read = call(case, token=manager)[1]
    assert read["handoff"]["status"] == "in_progress"
    assert [m["text"] for m in read["messages"] if m["role"] == "user"] == [
        document, "Дополнительные сведения для менеджера."
    ]
    reply = {"message_id": str(uuid4()), "text": "Взял документы на проверку."}
    call(case + "/messages", method="POST", token=other, body=reply, expected=404)
    first = call(case + "/messages", method="POST", token=manager, body=reply)[1]
    second = call(case + "/messages", method="POST", token=manager, body=reply)[1]
    assert first == second and first["sender"] == "manager" and first["role"] == "assistant"
    conflict = {**reply, "text": "Другой текст с тем же идентификатором."}
    assert call(case + "/messages", method="POST", token=manager, body=conflict, expected=409)[1]["code"] == "IDEMPOTENCY_CONFLICT"
    _, foreign_cookie = new_session()
    call(path, cookie=foreign_cookie, expected=404)
    call(path + "/handoff", cookie=foreign_cookie, expected=404)
    assert call(path, cookie=cookie)[1]["messages"][-1] == first
    resolved = call(case + "/resolve", method="POST", token=manager)[1]
    assert resolved["status"] == "resolved" and handoff(path, cookie)["status"] == "resolved"
    assert call(case + "/resolve", method="POST", token=manager)[1] == resolved
    assert call(case + "/messages", method="POST", token=manager, body=reply)[1] == first
    new_reply = {**reply, "message_id": str(uuid4())}
    assert call(case + "/messages", method="POST", token=manager, body=new_reply, expected=409)[1]["code"] == "HANDOFF_RESOLVED"
    assert sum(message["id"] == reply["message_id"] for message in call(path, cookie=cookie)[1]["messages"]) == 1

    assert "event:status" not in send(path, cookie, "Можно заказать продукт, которого нет в каталоге?")
    new_case = handoff(path, cookie)
    assert new_case["reason"] == "off_catalog_order" and new_case["status"] == "queued"
    assert new_case["handoff_id"] != queued["handoff_id"]
    archived = call(case, token=manager)[1]["messages"]
    assert archived[-1] == first
    if metrics_url:
        assert accepted_messages(metrics_url) == before + 3
        print("PASS: new messages without model calls counted once, including saved-turn replay")
    print("PASS: permissions, concurrent claim, client follow-up, manager reply/retry, resolve, and off-catalog order")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True, help="Use a disposable backend on loopback with an active test catalog")
    parser.add_argument("--metrics-url", help="Verify the accepted-message counter at the private Prometheus endpoint")
    args = parser.parse_args()
    if not args.origin.startswith(("http://127.0.0.1:", "http://localhost:")):
        parser.error("This check requires a loopback backend")
    managers = [entry.split("=", 1)[-1] for entry in os.environ.get("MANAGER_ACCESS_TOKENS", "").split(",")]
    if len(managers) != 2 or not all(managers):
        parser.error("Configure exactly two test managers in MANAGER_ACCESS_TOKENS")
    run(args.origin, managers, args.metrics_url)
