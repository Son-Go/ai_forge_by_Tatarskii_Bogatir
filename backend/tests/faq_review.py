"""Exercise Java FAQ against an empty loopback PostgreSQL and a local HTTP substitute for FastAPI."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

from manager_handoff import run as manager_regression
from sse_timeout import port

QUESTION = "Как включить двухфакторную аутентификацию?"
ANSWER = "Чтобы включить двухфакторную аутентификацию, откройте настройки профиля."
TIMEOUT_QUESTION = "Как открыть настройки профиля?"
TIMEOUT_ANSWER = "Чтобы открыть настройки профиля, выберите раздел «Профиль»."
OWNER = "owner_test_" + "a" * 43
OTHER = "other_test_" + "b" * 43
TOKEN = "faq-test-only"


class ReviewMock(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_payload(self, body, content_type="application/json", delay=0):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.flush()
        time.sleep(delay)
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        assert self.headers["Authorization"] == f"Bearer {TOKEN}"
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/internal/v1/interpret":
            handoff = data["text"] in self.server.handoff_questions
            self.server.handoff_questions.discard(data["text"])
            result = {"intent": "known_product" if handoff else "product_question",
                      "product_query": "MissingDemoProduct" if handoff else data["text"],
                      "updates": [], "clarification_candidates": [], "model_version": "fixture"}
        elif self.path == "/internal/v1/compose":
            self.server.compositions += 1
            return self.send_payload(b'event: complete\ndata: {"prompt_version":"fixture"}\n\n', "text/event-stream")
        elif self.path == "/internal/v1/faq/review":
            self.server.reviews.append(data)
            answer = TIMEOUT_ANSWER if "открыть" in data["question"] else ANSWER
            assert data["deadline_ms"] == 1000 and len(data["sources"]) <= 3
            source = next(s["id"] for s in data["sources"] if answer in s["text"])
            result = {"verdict": "publish", "reason_code": "supported", "question": data["question"],
                      "answer": answer, "source_ids": [source], "prompt_version": "fixture", "model_version": "fixture"}
            if self.server.force_unknown_source:
                self.server.force_unknown_source = False
                result["source_ids"] = [str(uuid4())]
            if data["question"] == TIMEOUT_QUESTION.lower().rstrip("?"):
                self.server.timeout_calls += 1
                if self.server.timeout_calls == 1 or self.server.force_timeout:
                    return self.send_payload(json.dumps(result).encode(), delay=2)
        else:
            return self.send_error(501)
        self.send_payload(json.dumps(result).encode())


def exercise(origin, mock, sql):
    def call(path, method="GET", *, token=None, cookie=None, body=None, expected=200):
        headers = {"Origin": origin, "Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if cookie:
            headers["Cookie"] = cookie
        request = Request(origin + path, data=json.dumps(body).encode() if body is not None else None,
                          headers=headers, method=method)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            content = response.read().decode()
            assert response.code == expected, (path, response.code, content[:300])
            body = json.loads(content) if response.headers.get_content_type() == "application/json" else content
            return body, response.headers

    def new_session():
        body, headers = call("/api/v1/sessions", "POST", expected=201)
        return f"/api/v1/sessions/{body['session_id']}", headers["Set-Cookie"].split(";", 1)[0]

    def ask(path, cookie, text):
        stream, _ = call(path + "/messages", "POST", cookie=cookie,
                         body={"client_message_id": str(uuid4()), "text": text})
        assert "event:done" in stream
        return call(path, cookie=cookie)[0]["messages"][-1]

    def case(question, answer=None, clarification=None):
        path, cookie = new_session()
        mock.handoff_questions.add(question)
        ask(path, cookie, question)
        handoff = call(path + "/handoff", cookie=cookie)[0]["handoff"]
        manager = f"/api/v1/manager/handoffs/{handoff['handoff_id']}"
        call(manager + "/claim", "POST", token=OWNER)
        call(manager + "/faq", token=OWNER, expected=404)
        if clarification:
            ask(path, cookie, clarification)
        if answer:
            call(manager + "/messages", "POST", token=OWNER, body={"message_id": str(uuid4()), "text": answer})
        with ThreadPoolExecutor(max_workers=2) as pool:
            resolved = list(pool.map(lambda _: call(manager + "/resolve", "POST", token=OWNER)[0], range(2)))
        assert resolved[0] == resolved[1] and resolved[0]["status"] == "resolved"
        call(manager + "/faq", token=OTHER, expected=404)
        return manager, path, cookie

    def candidate(manager, status, reason=None):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            data = call(manager + "/faq", token=OWNER)[0]["candidate"]
            if data and data["status"] == status and (reason is None or data["reason_code"] == reason):
                return data
            time.sleep(0.08)
        raise AssertionError((manager, status, data))

    auto, _, _ = case(QUESTION, ANSWER)
    published = candidate(auto, "published")
    assert published["attempts"] == 1 and len(published["sources"]) == 1
    assert sql(f"SELECT count(*) FROM support_faq WHERE candidate_id = '{published['candidate_id']}';") == "1"
    client, cookie = new_session()
    before = mock.compositions
    for question in (QUESTION, "Подскажите, как включить двухфакторную аутентификацию?"):
        reply = ask(client, cookie, question)
        assert reply["text"] == ANSWER and reply["sources"][0]["id"] == published["source_id"], reply
    assert mock.compositions == before
    for question in ("Как отключить двухфакторную аутентификацию?", "Как не включить двухфакторную аутентификацию?"):
        assert ask(client, cookie, question)["text"] != ANSWER

    personal, path, cookie = case("Какие документы нужны?", "Ваши документы проверены.")
    candidate(personal, "case_specific")
    assert call(path, cookie=cookie)[0]["messages"][-1]["text"] == "Ваши документы проверены."
    assert len(mock.reviews) == 1

    confidential, _, _ = case(QUESTION, "Тестовский: " + ANSWER)
    candidate(confidential, "needs_review", "insufficient_evidence")
    assert "[скрыто]" in mock.reviews[-1]["answer"] and "тестовский" not in str(mock.reviews[-1]).lower()

    mock.force_unknown_source = True
    forged, _, _ = case(QUESTION, ANSWER)
    assert candidate(forged, "needs_review", "insufficient_evidence")["source_id"] is None

    empty, _, _ = case("Какие параметры журналирования задать?")
    assert call(empty + "/faq", token=OWNER)[0]["candidate"] is None

    manual, _, _ = case("Какие горячие клавиши поддерживаются?", "Откройте меню.")
    candidate(manual, "needs_review", "insufficient_evidence")
    choices = call(manual + "/faq?" + urlencode({"source_query": "профиль"}),
                   token=OWNER)[0]["candidate"]["sources"]
    assert choices
    payload = {"question": "Как открыть настройки профиля DemoMail Standard?",
               "answer": TIMEOUT_ANSWER, "source_id": choices[0]["id"], "product": "DemoMail", "edition": "Standard"}
    call(manual + "/faq/approve", "POST", token=OTHER, body=payload, expected=404)
    bad = {**payload, "source_id": str(uuid4())}
    assert call(manual + "/faq/approve", "POST", token=OWNER, body=bad, expected=409)[0]["code"] == "FAQ_SOURCE_UNAVAILABLE"
    for _ in range(2):
        assert call(manual + "/faq/approve", "POST", token=OWNER, body=payload)[0]["candidate"]["status"] == "published"
    client, cookie = new_session()
    assert ask(client, cookie, payload["question"])["text"] == TIMEOUT_ANSWER
    assert ask(client, cookie, payload["question"].replace("Standard", "Pro"))["text"] != TIMEOUT_ANSWER

    ambiguous, _, _ = case("Как перенастроить интерфейс?", "Откройте меню.", "И как назначить роли?")
    assert candidate(ambiguous, "needs_review", "ambiguous_pair")["attempts"] == 0
    for _ in range(2):
        assert call(ambiguous + "/faq/reject", "POST", token=OWNER)[0]["candidate"]["status"] == "rejected"

    timeout_case, _, _ = case(TIMEOUT_QUESTION, TIMEOUT_ANSWER)
    pending = candidate(timeout_case, "queued", "review_unavailable")
    assert pending["attempts"] == 1 and mock.timeout_calls == 1
    cid = pending["candidate_id"]
    assert sql(f"SELECT next_check_at > now() FROM support_faq_candidates WHERE candidate_id = '{cid}';") == "t"
    sql(f"UPDATE support_faq_candidates SET next_check_at = now() WHERE candidate_id = '{cid}';")
    assert candidate(timeout_case, "published")["attempts"] == 2
    assert mock.timeout_calls == 2 and sql(f"SELECT count(*) FROM support_faq WHERE candidate_id = '{cid}';") == "1"
    mock.force_timeout = True
    exhausted, _, _ = case(TIMEOUT_QUESTION, TIMEOUT_ANSWER)
    for attempts in (1, 2):
        deadline = time.monotonic() + 10
        while True:
            pending = candidate(exhausted, "queued", "review_unavailable")
            if pending["attempts"] == attempts:
                break
            assert time.monotonic() < deadline
            time.sleep(0.08)
        cid = pending["candidate_id"]
        assert sql(f"SELECT review_token IS NULL FROM support_faq_candidates WHERE candidate_id = '{cid}';") == "t"
        sql(f"UPDATE support_faq_candidates SET next_check_at = now() WHERE candidate_id = '{cid}';")
    assert candidate(exhausted, "needs_review", "review_unavailable")["attempts"] == 3
    mock.force_timeout = False
    for _ in range(2):
        assert call(auto + "/faq/unpublish", "POST", token=OWNER)[0]["candidate"]["status"] == "unpublished"
    client, cookie = new_session()
    assert ask(client, cookie, QUESTION)["text"] != ANSWER
    sql("""
        INSERT INTO knowledge_documents(document_id, source_url, title, fetched_at, content_hash, version)
        SELECT gen_random_uuid(), source_url, title, fetched_at + interval '1 day', content_hash, 'fixture-next'
        FROM knowledge_documents WHERE version = 'fixture';
    """)
    assert ask(client, cookie, TIMEOUT_QUESTION)["text"] != TIMEOUT_ANSWER
    print("PASS: FAQ approval, grounding, history, conservative matching, retries, access, and removal")


def run(args):
    def sql(statement):
        return subprocess.check_output([
            "docker", "compose", "-f", args.compose_file, "exec", "-T", "postgres",
            "psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-U", "faq_check", "-d", "faq_check",
        ], input=statement, text=True).strip()

    origin = f"http://127.0.0.1:{port()}"
    with tempfile.TemporaryDirectory() as temp, ThreadingHTTPServer(("127.0.0.1", 0), ReviewMock) as mock:
        mock.compositions = 0
        mock.reviews = []
        mock.timeout_calls = 0
        mock.force_timeout = False
        mock.force_unknown_source = False
        mock.handoff_questions = set()
        threading.Thread(target=mock.serve_forever, daemon=True).start()
        db_address = subprocess.check_output(
            ["docker", "compose", "-f", args.compose_file, "port", "postgres", "5432"], text=True,
        ).strip()
        feed = Path(temp, "feed.xml")
        feed.write_text("""<yml_catalog date="2026-11-26 12:00"><shop><offers>
          <offer id="fixture" available="true"><name>Fixture</name><url>https://example.test/product</url>
            <price>100</price><currencyId>RUB</currencyId></offer>
          </offers></shop></yml_catalog>""")
        knowledge = Path(temp, "knowledge.json")
        knowledge.write_text(json.dumps([{"source_url": "https://docs.softline.ru/faq-fixture", "title": "Fixture",
            "fetched_at": "2026-11-26T12:00:00+03:00", "version": "fixture",
            "chunks": [{"text": ANSWER}, {"text": TIMEOUT_ANSWER}]}]))
        env = {**os.environ, "SERVER_ADDRESS": "127.0.0.1", "SERVER_PORT": origin.rsplit(":", 1)[1],
               "MANAGEMENT_SERVER_PORT": "0", "CHAT_PUBLIC_ORIGIN": origin,
               "SPRING_DATASOURCE_URL": f"jdbc:postgresql://{db_address}/faq_check",
               "SPRING_DATASOURCE_USERNAME": "faq_check", "SPRING_DATASOURCE_PASSWORD": "faq_check_fixture",
               "CATALOG_FEED_URL": "", "CATALOG_FEED_FILE": str(feed), "CATALOG_KNOWLEDGE_FILE": str(knowledge),
               "MANAGER_ACCESS_TOKENS": f"owner={OWNER},other={OTHER}",
               "ML_BASE_URL": f"http://127.0.0.1:{mock.server_port}", "ML_DATA_REGION": "RU", "ML_SERVICE_TOKEN": TOKEN,
               "FAQ_REVIEW_ENABLED": "true", "FAQ_REVIEW_TIMEOUT_MS": "1000", "FAQ_REVIEW_POLL_MS": "150"}
        log = Path(temp, "backend.log")
        with log.open("w") as out:
            java = subprocess.Popen(["java", "-jar", args.jar], env=env, stdout=out, stderr=out)
            try:
                deadline = time.monotonic() + 22
                while "Catalog check complete" not in log.read_text():
                    assert time.monotonic() < deadline and java.poll() is None, "Backend failed to start"
                    time.sleep(0.1)
                assert sql("SELECT count(*) FROM chat_handoffs;") == "0", "Use a disposable database"
                manager_regression(origin, [OWNER, OTHER])
                exercise(origin, mock, sql)
            except Exception:
                print(log.read_text()[-6000:])
                raise
            finally:
                java.terminate()
                try:
                    java.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    java.kill()
                    java.wait()
                mock.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose-file", required=True, help="Disposable postgres service with a loopback port")
    parser.add_argument("--jar", default="backend/target/support-agent-0.1.0-SNAPSHOT.jar")
    run(parser.parse_args())
