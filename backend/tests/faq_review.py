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
DEFERRED_PAYMENT = "Мне дорого, можно рассчитаться через 30 дней?"
NEGATED_DEFERRAL = "Отсрочка нам не нужна"


RESPONSE_FEED = """<yml_catalog date="2026-11-26 12:00">
    <shop>
        <offers>
            <offer id="mail-small" available="true">
                <name>MDaemon Messaging Server</name>
                <url>https://example.test/mail-small</url>
                <price>100</price>
                <currencyId>RUB</currencyId>
                <param name="К-во пользователей до">20</param>
                <param name="Алиас">Mail Suite</param>
            </offer>
            <offer id="mail-renewal" available="true">
                <name>MDaemon Messaging Server продление</name>
                <url>https://example.test/mail-renewal</url>
                <price>125</price>
                <currencyId>RUB</currencyId>
                <param name="К-во пользователей до">50</param>
                <param name="Тип лицензии">Продление</param>
                <param name="Срок действия">12 мес.</param>
            </offer>
            <offer id="bat-pro" available="true">
                <name>The Bat! Лицензия Professional</name>
                <url>https://example.test/bat-pro</url>
                <price>120</price>
                <currencyId>RUB</currencyId>
                <vendorCode>BAT-PRO</vendorCode>
                <param name="Операционная система">Windows</param>
            </offer>
            <offer id="protect-local" available="true">
                <name>Защита рабочих станций Safe Suite</name>
                <url>https://example.test/protect-local</url>
                <price>110</price>
                <currencyId>RUB</currencyId>
                <param name="К-во пользователей до">50</param>
                <param name="Операционная система">Windows</param>
                <param name="Тип развёртывания">Локальное</param>
            </offer>
            <offer id="protect-cloud" available="true">
                <name>Защита рабочих станций Cloud Suite</name>
                <url>https://example.test/protect-cloud</url>
                <price>110</price>
                <currencyId>RUB</currencyId>
                <param name="К-во пользователей до">100</param>
                <param name="Операционная система">Windows</param>
                <param name="Тип развёртывания">Cloud</param>
            </offer>
            <offer id="protect-unknown" available="true">
                <name>Защита рабочих станций Unknown Suite</name>
                <url>https://example.test/protect-unknown</url>
                <price>110</price>
                <currencyId>RUB</currencyId>
                <param name="К-во пользователей до">100</param>
                <param name="Операционная система">Windows</param>
            </offer>
        </offers>
    </shop>
</yml_catalog>"""


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
            self.server.interpreted.append(data["text"])
            result = {"intent": "product_question", "product_query": data["text"],
                      "updates": [], "clarification_candidates": [], "model_version": "fixture",
                      **self.server.interpretations.get(data["text"], {})}
            if data["text"] == DEFERRED_PAYMENT:
                result["signals"] = [{"kind": "price_objection", "evidence": "Мне дорого"},
                                     {"kind": "payment_deferral", "evidence": "рассчитаться через 30 дней"}]
            if data["text"] == NEGATED_DEFERRAL:
                # A model mistake must not override an explicit rejection.
                result["signals"] = [{"kind": "payment_deferral", "evidence": "Отсрочка"}]
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


def chat_client(origin):
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
            raw = response.read()
            content = raw if response.headers.get_content_type() == "application/pdf" else raw.decode()
            assert response.code == expected, (path, response.code, content[:300])
            body = json.loads(content) if response.headers.get_content_type() == "application/json" else content
            return body, response.headers

    def new_session():
        body, headers = call("/api/v1/sessions", "POST", expected=201)
        return f"/api/v1/sessions/{body['session_id']}", headers["Set-Cookie"].split(";", 1)[0]

    def ask(path, cookie, text, message_id=None):
        stream, _ = call(path + "/messages", "POST", cookie=cookie,
                         body={"client_message_id": message_id or str(uuid4()), "text": text})
        assert "event:done" in stream
        return call(path, cookie=cookie)[0]["messages"][-1]

    return call, new_session, ask


def exercise(origin, mock, sql):
    call, new_session, ask = chat_client(origin)

    def case(question, answer=None, clarification=None):
        path, cookie = new_session()
        ask(path, cookie, "Проверьте возможность поставки ExampleMail Enterprise.")
        # Seed the historical question to isolate review and publication from handoff routing.
        literal = question.replace("'", "''")
        session_id = path.rsplit("/", 1)[1]
        sql(f"UPDATE chat_messages SET body = '{literal}' WHERE session_id = '{session_id}' AND role = 'user';")
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

    for question, topic in (("Ключ не пришёл", "key_delivery"),
                            ("Ключ не активируется", "key_activation"), ("Хочу возврат", "refund")):
        path, cookie = new_session()
        instruction = ask(path, cookie, question)
        assert instruction["sources"][0]["url"].startswith("https://store.softline.ru/")
        assert call(path, cookie=cookie)[0]["support_topic"] == topic
        assert call(path + "/handoff", cookie=cookie)[0]["handoff"] is None
        ask(path, cookie, "Не помогло")
        handoff = call(path + "/handoff", cookie=cookie)[0]["handoff"]
        assert handoff["reason"] == "instruction_failed"
        ask(path, cookie, "Инструкция не сработала")
        assert call(path + "/handoff", cookie=cookie)[0]["handoff"] == handoff
        path_manager = "/api/v1/manager/handoffs/" + handoff["handoff_id"]
        call(path_manager + "/claim", "POST", token=OWNER)
        assert instruction in call(path_manager, token=OWNER)[0]["messages"]

    def select_fixture():
        path, cookie = new_session()
        offer = ask(path, cookie, "Fixture")["cards"][0]
        call(path + "/selection", "POST", cookie=cookie, body={
            "offer_id": offer["offer_id"], "catalog_version": offer["catalog_version"],
        })
        return path, cookie, offer

    other_path, other_cookie, _ = select_fixture()
    ask(other_path, other_cookie, "Нет")
    other_id = other_path.rsplit("/", 1)[1]
    assert sql(f"SELECT coupon_state IS NULL FROM chat_sessions WHERE session_id = '{other_id}';") == "t"
    assert "купон" in ask(other_path, other_cookie, "Мне дорого")["text"].lower()
    assert "100 RUB" in ask(other_path, other_cookie, "Сколько стоит?")["text"]
    ask(other_path, other_cookie, "Нет")
    assert sql(f"SELECT coupon_state IS NULL FROM chat_sessions WHERE session_id = '{other_id}';") == "t"
    assert "купон" in ask(other_path, other_cookie, "Мне дорого")["text"].lower()
    ask(other_path, other_cookie, "Да")
    assert sql(f"SELECT coupon_state FROM chat_sessions WHERE session_id = '{other_id}';") == "present"
    assert "100 RUB" in ask(other_path, other_cookie, "Сколько стоит?")["text"]
    ask(other_path, other_cookie, "Нет")
    assert sql(f"SELECT coupon_state FROM chat_sessions WHERE session_id = '{other_id}';") == "present"
    assert "price_terms" not in call(other_path, cookie=other_cookie)[0]
    direct_deferral = "Дорого, можно оплатить с отсрочкой?"
    ask(other_path, other_cookie, direct_deferral)
    assert call(other_path + "/handoff", cookie=other_cookie)[0]["handoff"]["reason"] == "payment_deferral"
    assert direct_deferral not in mock.interpreted

    path, cookie, offer = select_fixture()
    assert offer["availability"] == "unavailable" and offer["selectable"] and offer["price"]["amount"] == "100"
    for question in (NEGATED_DEFERRAL, "Какие способы оплаты?"):
        ask(path, cookie, question)
        assert call(path + "/handoff", cookie=cookie)[0]["handoff"] is None
    assert NEGATED_DEFERRAL in mock.interpreted
    assert "100 RUB" in ask(path, cookie, "Сколько стоит? Купона нет.")["text"]
    assert "price_terms" not in call(path, cookie=cookie)[0]
    assert "купон" in ask(path, cookie, "Мне дорого")["text"].lower()
    assert "95 RUB" in ask(path, cookie, "Нет")["text"]
    assert call(path, cookie=cookie)[0]["price_terms"] == {
        "base_amount": "100", "discount_percent": "5", "final_amount": "95", "currency": "RUB",
    }
    quote, headers = call(path + "/quote-drafts", "POST", cookie=cookie, body={
        "customer_name": "Synthetic customer", "quantity": 2,
    })
    quote_id = headers["X-Quote-Id"]
    assert call(path + "/invoice-drafts", "POST", cookie=cookie, body={"quote_id": quote_id},
                expected=409)[0]["code"] == "QUOTE_APPROVAL_REQUIRED"
    for _ in range(2):
        call(path + f"/quote-drafts/{quote_id}/approval", "POST", cookie=cookie, expected=204)
    invoice, headers = call(path + "/invoice-drafts", "POST", cookie=cookie, body={"quote_id": quote_id})
    invoice_number = headers["X-Invoice-Number"]
    assert headers["X-Invoice-Purpose"] == "test_payment" and invoice_number.startswith("TEST-")
    repeated_invoice, repeated_headers = call(path + "/invoice-drafts", "POST", cookie=cookie, body={"quote_id": quote_id})
    assert repeated_invoice == invoice and repeated_headers["X-Invoice-Number"] == invoice_number
    for pdf in (quote, invoice):
        text = subprocess.check_output(["pdftotext", "-", "-"], input=pdf).decode()
        assert "95" in text and "190" in text and "5%" in text
    assert "Счёт на оплату" in text and "Сумма по счёту: 190 RUB" in text and invoice_number in text
    assert call(path + "/handoff", cookie=cookie)[0]["handoff"] is None
    message_id = str(uuid4())
    reply = ask(path, cookie, DEFERRED_PAYMENT, message_id)
    assert mock.interpreted.count(DEFERRED_PAYMENT) == 1 and "скидк" not in reply["text"].lower()
    handoff = call(path + "/handoff", cookie=cookie)[0]["handoff"]
    assert handoff["reason"] == "payment_deferral"
    assert ask(path, cookie, DEFERRED_PAYMENT, message_id) == reply
    assert call(path + "/handoff", cookie=cookie)[0]["handoff"] == handoff
    assert sql(f"SELECT count(*) FROM chat_handoffs WHERE session_id = '{path.rsplit('/', 1)[1]}';") == "1"
    path_manager = "/api/v1/manager/handoffs/" + handoff["handoff_id"]
    call(path_manager + "/claim", "POST", token=OWNER)
    sales = call(path_manager, token=OWNER)[0]["sales_context"]
    assert sales["offer"] == offer and sales["quote"]["quote_id"] == quote_id
    assert sales["quote"]["approved"] and sales["quote"]["discount_percent"] == "5.00"
    print("PASS: support guides, handoff context, priced unavailable offer, discount, quote and invoice")


def exercise_responses(origin, mock, sql):
    call, new_session, ask = chat_client(origin)

    def interpretation(text, intent, product=None, values=(), candidates=(), signals=()):
        mock.interpretations[text] = {
            "intent": intent, "product_query": product,
            "updates": [{"op": "set", "field": field, "value": value, "evidence": evidence}
                        for field, value, evidence in values],
            "clarification_candidates": list(candidates),
            "signals": [{"kind": kind, "evidence": evidence} for kind, evidence in signals],
        }
        return text

    path, cookie = new_session()
    first = interpretation("Нужна лицензия MDaemon на 50 пользователей", "known_product", "MDaemon",
                           [("product_name", "MDaemon", "MDaemon"), ("seats", 50, "50 пользователей")])
    recommendation = ask(path, cookie, first)
    assert recommendation["cards"][0]["attributes"]["seats"] == 50
    second = interpretation("Исправь на 20 пользователей", "known_product", "MDaemon",
                            [("seats", 20, "20 пользователей")])
    assert ask(path, cookie, second)["cards"][0]["attributes"]["seats"] == 20
    question = interpretation("А для какой ОС подходит The Bat! Professional?", "product_question", "The Bat! Professional",
                              [("product_name", "The Bat! Professional", "The Bat! Professional")])
    reply = ask(path, cookie, question)
    assert reply["cards"][0]["offer_id"] == "bat-pro" and "Windows" in reply["text"], reply
    assert all("The Bat!" in source["title"] for source in reply["sources"])
    linux = interpretation("А он работает на Linux?", "product_question", "MDaemon")
    reply = ask(path, cookie, linux)
    assert "совместимость с Linux" in reply["text"] and "не удалось подтвердить" in reply["text"], reply
    assert all("MDaemon" in card["name"] for card in reply["cards"]), reply
    where = interpretation("А он разворачивается в облаке?", "product_question", "MDaemon")
    assert "способ развёртывания" in ask(path, cookie, where)["text"]
    assert ask(path, cookie, interpretation("Сколько стоит Mail Suite?", "product_question", "Mail Suite"))["cards"], "alias"
    assert "120 RUB" in ask(path, cookie, interpretation("Какова цена BAT-PRO?", "product_question", "BAT-PRO"))["text"]
    compatible = interpretation("Снова подбери MDaemon", "known_product", "MDaemon")
    assert ask(path, cookie, compatible)["cards"][0]["attributes"]["seats"] == 20
    assert "генерация" not in reply["text"].lower()
    assert mock.compositions == 0 and mock.interpreted.count(first) == 1
    first_request = interpretation("Уточните, какая ОС у MDaemon?", "product_question", "MDaemon")
    saved_reply = ask(path, cookie, first_request)
    assert saved_reply["sources"] and call(path, cookie=cookie)[0]["messages"][-1] == saved_reply

    path, cookie = new_session()
    renewal = interpretation("Нужно продление MDaemon Standard на 50 пользователей на год", "known_product",
                             "MDaemon Standard", [("product_name", "MDaemon Standard", "MDaemon Standard"),
                             ("license_kind", "renewal", "продление"), ("seats", 50, "50 пользователей"),
                             ("license_term_months", 12, "на год")])
    reply = ask(path, cookie, renewal)
    assert "Standard" in reply["text"] and "продление" in reply["text"], reply
    assert [card["offer_id"] for card in reply["cards"]] == ["mail-renewal"], reply
    assert call(path + "/handoff", cookie=cookie)[0]["handoff"] is None

    path, cookie = new_session()
    values = [("use_case", "защита рабочих станций", "защита рабочих станций"), ("seats", 35, "35 сотрудников"),
              ("deployment", "on_prem", "локально"), ("platform", "Windows", "Windows"),
              ("domestic_required", True, "желательно из реестра российского ПО")]
    protection = interpretation("Нужна защита рабочих станций для 35 сотрудников. Windows, локально, желательно из реестра российского ПО.",
                                "needs_solution", values=values, candidates=["product_name", "edition"])
    reply = ask(path, cookie, protection)
    assert [card["offer_id"] for card in reply["cards"]] == ["protect-local"], reply
    assert reply["cards"][0]["attributes"].get("registry_number") is None
    incomplete = interpretation("Нужна защита рабочих станций для 75 сотрудников. Windows, локально.",
                                 "needs_solution", values=[values[0], ("seats", 75, "75 сотрудников"), *values[2:4]],
                                 candidates=["product_name", "edition"])
    reply = ask(path, cookie, incomplete)
    assert "способ развёртывания" in reply["text"] and "название" not in reply["text"], reply
    assert [card["offer_id"] for card in reply["cards"]] == ["protect-unknown"], reply

    path, cookie = new_session()
    for question in ("Можно узнать условия отсрочки оплаты?", "Можно узнать, какие условия отсрочки оплаты?"):
        interpretation(question, "known_product", signals=[("payment_deferral", "отсрочки")])
        answer = ask(path, cookie, question)
        assert "условия отсрочки" in answer["text"] and "подтвердить" in answer["text"], answer
        assert call(path + "/handoff", cookie=cookie)[0]["handoff"] is None
    card_question = interpretation("Отсрочку не хочу, можно оплатить сразу картой?", "known_product",
                                   signals=[("payment_deferral", "Отсрочку")])
    answer = ask(path, cookie, card_question)
    assert "банковской картой" in answer["text"] and answer["sources"], answer
    outside = ask(path, cookie, "Как узнать, можно ли заказать ПО вне каталога?")
    assert outside["sources"] and call(path + "/handoff", cookie=cookie)[0]["handoff"] is None
    assert "артикул" in ask(path, cookie, "Проверьте возможность поставки.")["text"]
    assert call(path + "/handoff", cookie=cookie)[0]["handoff"] is None
    hypothetical = ask(path, cookie, "Что делать, если ключ не пришёл?")
    assert hypothetical["sources"] and call(path, cookie=cookie)[0].get("support_topic") is None
    refund = ask(path, cookie, "Как вернуть товар?")
    assert refund["sources"] and call(path, cookie=cookie)[0].get("support_topic") is None
    own = ask(path, cookie, "Мой ключ не активируется")
    assert own["sources"] and call(path, cookie=cookie)[0]["support_topic"] == "key_activation"
    ask(path, cookie, "Не помогло")
    assert call(path + "/handoff", cookie=cookie)[0]["handoff"]["reason"] == "instruction_failed"

    path, cookie = new_session()
    ask(path, cookie, "Прошу отсрочку оплаты до следующего месяца")
    assert call(path + "/handoff", cookie=cookie)[0]["handoff"]["reason"] == "payment_deferral"
    path, cookie = new_session()
    ask(path, cookie, DEFERRED_PAYMENT)
    assert call(path + "/handoff", cookie=cookie)[0]["handoff"]["reason"] == "payment_deferral"
    assert mock.interpreted.count(DEFERRED_PAYMENT) == 1
    assert mock.compositions == 0, "Typical questions and recommendations must skip composition"
    print("PASS: product context, confirmed attributes, partial family, task filters, guide vs handoff and no compose")


def exercise_snapshot(origin, mock, sql):
    call, new_session, ask = chat_client(origin)
    assert int(sql("SELECT count(*) FROM catalog_offers;")) >= 100_000

    def ask_catalog(text, product, intent="known_product", **requirements):
        mock.interpretations[text] = {"intent": intent, "product_query": product, "updates": [
            {"op": "set", "field": field, "value": value, "evidence": evidence}
            for field, (value, evidence) in requirements.items()
        ]}
        return ask(path, cookie, text)

    path, cookie = new_session()
    ask_catalog("Подбери MDaemon на 50 пользователей", "MDaemon",
                product_name=("MDaemon", "MDaemon"), seats=(50, "50 пользователей"))
    ask_catalog("Исправь на 20 пользователей", "MDaemon", seats=(20, "20 пользователей"))
    reply = ask_catalog("Для какой ОС подходит The Bat! Professional?", "The Bat! Professional", "product_question")
    assert reply["cards"] and all("The Bat!" in card["name"] for card in reply["cards"]), reply
    assert "операционную систему" in reply["text"], reply
    reply = ask_catalog("А MDaemon поддерживает Linux?", "MDaemon", "product_question")
    assert "совместимость с Linux" in reply["text"], reply
    session_id = path.rsplit("/", 1)[1]
    assert sql(f"SELECT requirements->>'seats' FROM chat_sessions WHERE session_id = '{session_id}';") == "20"
    assert ask_catalog("Снова подбери MDaemon", "MDaemon")["cards"]

    path, cookie = new_session()
    reply = ask_catalog("Нужно продление MDaemon Standard на 50 пользователей на год", "MDaemon Standard",
                        product_name=("MDaemon Standard", "MDaemon Standard"),
                        license_kind=("renewal", "продление"), seats=(50, "50 пользователей"),
                        license_term_months=(12, "на год"))
    assert "Standard" in reply["text"] and reply["cards"], reply
    assert any(card["attributes"].get("seats") == 50 and card["attributes"].get("license_term_months") == 12
               and card["attributes"].get("license_kind") == "renewal" for card in reply["cards"]), reply
    assert call(path + "/handoff", cookie=cookie)[0]["handoff"] is None
    path, cookie = new_session()
    reply = ask_catalog("Нужна защита рабочих станций для 35 сотрудников. Windows, локально, желательно из реестра.",
                        None, "needs_solution", use_case=("защита рабочих станций", "защита рабочих станций"),
                        seats=(35, "35 сотрудников"), platform=("Windows", "Windows"),
                        deployment=("on_prem", "локально"), domestic_required=(True, "желательно из реестра"))
    assert "способ развёртывания" in reply["text"] and reply["cards"], reply
    assert mock.compositions == 0
    print("PASS: full catalog import, The Bat! vs MDaemon, partial Standard renewal and deployment evidence")


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
        mock.interpreted = []
        mock.force_timeout = False
        mock.force_unknown_source = False
        mock.interpretations = {}
        threading.Thread(target=mock.serve_forever, daemon=True).start()
        db_address = subprocess.check_output(
            ["docker", "compose", "-f", args.compose_file, "port", "postgres", "5432"], text=True,
        ).strip()
        feed = args.catalog_file or Path(temp, "feed.xml")
        if not args.catalog_file:
            feed.write_text(RESPONSE_FEED if args.response_quality else """<yml_catalog date="2026-11-26 12:00"><shop><offers>
          <offer id="fixture" available="false"><name>Fixture</name><url>https://example.test/product</url>
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
               "FAQ_REVIEW_ENABLED": "true", "FAQ_REVIEW_TIMEOUT_MS": "1000", "FAQ_REVIEW_POLL_MS": "150",
               "CHAT_QUOTES_ENABLED": "true", "CHAT_INVOICE_DRAFTS_ENABLED": "true",
               "CHAT_TEST_PAYMENT_INVOICES_ENABLED": "true", "CHAT_DISCOUNT_PERCENT": "5"}
        log = Path(temp, "backend.log")
        with log.open("w") as out:
            java = subprocess.Popen(["java", "-jar", args.jar], env=env, stdout=out, stderr=out)
            try:
                deadline = time.monotonic() + (150 if args.catalog_file else 22)
                while "Catalog check complete" not in log.read_text():
                    assert time.monotonic() < deadline and java.poll() is None, "Backend failed to start"
                    time.sleep(0.1)
                assert sql("SELECT count(*) FROM chat_handoffs;") == "0", "Use a disposable database"
                if args.catalog_file:
                    exercise_snapshot(origin, mock, sql)
                elif args.response_quality:
                    exercise_responses(origin, mock, sql)
                else:
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
    parser.add_argument("--response-quality", action="store_true")
    parser.add_argument("--catalog-file", type=Path, help="Path to the full catalog snapshot")
    parser.add_argument("--jar", default="backend/target/support-agent-0.1.0-SNAPSHOT.jar")
    run(parser.parse_args())
