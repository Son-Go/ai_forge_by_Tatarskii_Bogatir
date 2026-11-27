"""Exercise approvals against a disposable Compose stack with an empty quote_check DB."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import subprocess
import unicodedata
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4


def run(origin, compose_file, trial_payment=False, invoice_output=None):
    def sql(statement):
        return subprocess.check_output([
            "docker", "compose", "-f", compose_file, "exec", "-T", "postgres",
            "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "quote_check", "-d", "quote_check",
        ], input=statement, text=True).strip()

    def call(path, cookie=None, body=None, expected=200):
        headers = {"Origin": origin}
        if cookie:
            headers["Cookie"] = cookie
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(origin + path, method="POST", headers=headers,
                          data=json.dumps(body).encode() if body is not None else None)
        try:
            response = urlopen(request, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            assert response.status == expected, (path, response.status, expected)
            payload = response.read()
            return response.headers, json.loads(payload) if response.headers.get_content_type() == "application/json" else payload

    sessions = "/api/v1/sessions"

    def new_session(cookie=None):
        headers, body = call(sessions, cookie=cookie, expected=201)
        return UUID(body["session_id"]), headers["Set-Cookie"].split(";", 1)[0]

    def activate(price, long_name=False):
        version = uuid4()
        name = "repeat('Лицензия на программное обеспечение ', 60) || 'Конец позиции'" if long_name else "'Synthetic offer'"
        sql(f"""
          INSERT INTO catalog_imports (import_id, source, sha256, snapshot_at, status)
          VALUES ('{version}', 'synthetic', repeat('0', 64), now(), 'activated');
          INSERT INTO catalog_offers (import_id, offer_id, name, product_url, price, currency, available)
          VALUES ('{version}', 'synthetic-quote-offer', {name}, 'https://example.test/offer', {price}, 'RUB', true);
          INSERT INTO catalog_head (singleton, active_import_id) VALUES (true, '{version}')
          ON CONFLICT (singleton) DO UPDATE SET active_import_id = EXCLUDED.active_import_id;
        """)
        return version

    assert sql("SELECT count(*) FROM catalog_imports;") == "0", "An empty fixture database is required"
    version = activate(125)
    session, cookie = new_session()
    other_session, _ = new_session(cookie)
    _, foreign_cookie = new_session()
    def select_in_fixture(version):
        sql(f"""
          UPDATE chat_sessions SET selected_import_id = offer.import_id, selected_offer_id = offer.offer_id,
              selected_card = jsonb_build_object(
                'offer_id', offer.offer_id, 'catalog_version', offer.import_id,
                'name', offer.name, 'product_url', offer.product_url,
                'availability', 'available', 'price', jsonb_build_object('amount', offer.price::text, 'currency', offer.currency),
                'attributes', '{{}}'::jsonb, 'source_ids', '[]'::jsonb)
          FROM catalog_offers offer
          WHERE session_id = '{session}' AND offer.import_id = '{version}' AND offer.offer_id = 'synthetic-quote-offer';
        """)

    select_in_fixture(version)
    base = f"{sessions}/{session}"

    def pdf_text(pdf):
        text = unicodedata.normalize("NFKC", subprocess.check_output(["pdftotext", "-", "-"], input=pdf).decode())
        assert "черновик" not in text.casefold()
        return text

    def quote(quantity, customer="Synthetic customer"):
        headers, pdf = call(base + "/quote-drafts", cookie, {"customer_name": customer, "quantity": quantity})
        assert pdf.startswith(b"%PDF-") and headers["X-Invoice-Drafts-Enabled"] == "true"
        assert headers.get_filename() == "quote.pdf"
        quote_id = str(UUID(headers["X-Quote-Id"]))
        text = pdf_text(pdf)
        assert "ПАО «Софтлайн»" in text and "Артикул" in text and "Итого" in text and quote_id in text
        assert "Куда:" in text and "Срок поставки: уточняет менеджер." in text
        if customer == "Synthetic customer":
            assert "Куда: Synthetic customer" in text
        return quote_id

    def approve(quote_id, expected=204, owner=cookie):
        return call(base + f"/quote-drafts/{quote_id}/approval", owner, expected=expected)[1]

    def issued_invoice(quote_id):
        headers, pdf = call(base + "/invoice-drafts", cookie, {"quote_id": quote_id})
        assert headers.get_filename() == "invoice.pdf" and pdf.startswith(b"%PDF-")
        number = headers["X-Invoice-Number"]
        assert headers["X-Invoice-Purpose"] == ("test_payment" if trial_payment else "agreement")
        if trial_payment:
            assert number and re.fullmatch(r"TEST-[0-9]{8,}", number)
        else:
            assert number is None
        return pdf, number

    def invoice(quote_id, expected=200):
        if expected == 200:
            return issued_invoice(quote_id)[0]
        headers, payload = call(base + "/invoice-drafts", cookie, {"quote_id": quote_id}, expected)
        assert headers["X-Invoice-Number"] is None
        return payload

    first = quote(2)
    assert invoice(first, 409)["code"] == "QUOTE_APPROVAL_REQUIRED"
    assert approve(first, 404, foreign_cookie)["code"] == "SESSION_NOT_FOUND"
    assert call(f"{sessions}/{other_session}/invoice-drafts", cookie, {"quote_id": first}, 404)[1]["code"] == "QUOTE_NOT_FOUND"
    approve(first)
    approve(first)
    with ThreadPoolExecutor(max_workers=2) as executor:
        copies = list(executor.map(issued_invoice, [first, first]))
    assert copies[0] == copies[1]
    first_pdf, first_number = copies[0]
    if invoice_output:
        Path(invoice_output).write_bytes(first_pdf)
    invoice_text = pdf_text(first_pdf)
    assert "Сумма по счёту: 250 RUB" in invoice_text and f"Основание: одобренное КП {first}" in invoice_text
    if trial_payment:
        assert "Счёт на оплату" in invoice_text and f"Номер счёта: {first_number}" in invoice_text
        assert "Тестовый выпуск" in invoice_text
        assert sql(f"SELECT invoice_number FROM quote_drafts WHERE quote_id = '{first}';") == first_number
    else:
        assert "Счёт для согласования" in invoice_text and "Оплата по документу не предусмотрена" in invoice_text
    for field in (
        "ПАО «Софтлайн»", "ИНН 7736227885", "КПП 774950001", "ОГРН 1027736009333",
        "БИК 044525593", "40702810502300000368", "30101810200000000593",
        "Покупатель", "Synthetic customer", "Synthetic offer", "Кол-во", "Цена, RUB",
    ):
        assert field in invoice_text, field
    second = quote(3)
    assert first != second
    assert approve(first, 409)["code"] == "QUOTE_SUPERSEDED"
    assert invoice(second, 409)["code"] == "QUOTE_APPROVAL_REQUIRED"
    approve(second)
    version = activate(150)
    assert invoice(second, 409)["code"] == "OFFER_CHANGED"
    assert issued_invoice(first) == copies[0]
    call(base + "/selection", cookie, {"offer_id": "synthetic-quote-offer", "catalog_version": str(version)})
    replacement = quote(3)
    assert invoice(replacement, 409)["code"] == "QUOTE_APPROVAL_REQUIRED"
    approve(replacement)
    replacement_pdf, replacement_number = issued_invoice(replacement)
    assert "Сумма по счёту: 450 RUB" in pdf_text(replacement_pdf)
    if trial_payment:
        assert first_number != replacement_number

    version = activate(150, long_name=True)
    select_in_fixture(version)
    long_quote = quote(1, "Щ" * 159 + "Я")
    approve(long_quote)
    pages = pdf_text(invoice(long_quote)).strip().split("\f")
    assert len(pages) > 1
    assert all("Наименование" in page and "Банковские реквизиты поставщика" in page for page in pages)
    assert pages[0].count("Щ") == 159 and "Я" in pages[0]
    assert "Конец позиции" in " ".join(pages[-1].split())
    assert "Сумма по счёту: 150 RUB" in pages[-1]
    assert sum("Сумма по счёту:" in page for page in pages) == 1
    mode = "test payment" if trial_payment else "agreement"
    print(f"PASS: owner scope, approval, concurrent identical PDF, catalog reapproval, {mode} invoice fields and pagination")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--compose-file", required=True)
    parser.add_argument("--trial-payment", action="store_true")
    parser.add_argument("--invoice-output")
    args = parser.parse_args()
    run(args.origin, args.compose_file, args.trial_payment, args.invoice_output)
