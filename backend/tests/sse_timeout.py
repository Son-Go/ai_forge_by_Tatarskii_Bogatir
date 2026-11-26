"""Regression check for a persisted partial answer after an upstream SSE timeout."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid


class MockMl(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/internal/v1/interpret":
            self.wait_if_cold("interpret", request)
            payload = json.dumps({
                "intent": "known_product",
                "product_query": "DemoMail",
                "updates": [],
                "clarification_candidates": [],
                "model_version": "fixture",
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wait_if_cold("compose", request)
            first = json.dumps({"text": "unverified text", "fact_ids": [request["facts"][0]["id"]]})
            self.wfile.write(f"event: block\ndata: {first}\n\n".encode())
            self.wfile.flush()
            if self.server.cold_delay:
                self.wfile.write(b'event: complete\ndata: {"model_version":"fixture","prompt_version":"fixture"}\n\n')
            else:
                time.sleep(6)

    def wait_if_cold(self, stage, request):
        if self.server.cold_delay and not self.server.cold_used and self.server.cold_stage == stage:
            self.server.cold_used = True
            self.server.cold_budget = request["deadline_ms"]
            time.sleep(self.server.cold_delay)


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run(args):
    origin = f"http://127.0.0.1:{port()}"
    with tempfile.TemporaryDirectory() as tmp, ThreadingHTTPServer(("127.0.0.1", 0), MockMl) as mock:
        mock.cold_delay = args.cold_delay
        mock.cold_stage = args.cold_stage
        mock.cold_used = False
        threading.Thread(target=mock.serve_forever, daemon=True).start()
        feed = Path(tmp, "test.xml")
        feed.write_text(f"""
<yml_catalog date="2026-11-26 12:00"><shop><offers>
    <offer id="{uuid.uuid4()}" available="true">
        <name>DemoMail</name><url>https://example.com/demo</url>
        <price>100</price><currencyId>RUB</currencyId>
    </offer>
</offers></shop></yml_catalog>
""".strip(), encoding="utf-8")
        env = {
            **os.environ,
            "SERVER_PORT": origin.rsplit(":", 1)[1],
            "SERVER_ADDRESS": "127.0.0.1",
            "SPRING_DATASOURCE_URL": args.jdbc_url,
            "SPRING_DATASOURCE_USERNAME": args.db_user,
            "CATALOG_FEED_FILE": str(feed),
            "CATALOG_KNOWLEDGE_FILE": "",
            "CHAT_PUBLIC_ORIGIN": origin,
            "CHAT_TURN_TIMEOUT_MS": "3000",
            "ML_BASE_URL": f"http://127.0.0.1:{mock.server_port}",
            "ML_SERVICE_TOKEN": "test-only",
            "ML_DATA_REGION": "RU",
        }
        if args.cold_delay:
            env.pop("CHAT_TURN_TIMEOUT_MS")
        log = Path(tmp, "backend.log")
        with log.open("w") as output:
            server = subprocess.Popen([args.java, "-jar", str(args.jar)], env=env, stdout=output, stderr=output)
            try:
                deadline = time.monotonic() + 20
                while "Catalog check complete" not in log.read_text():
                    if time.monotonic() > deadline or server.poll() is not None:
                        raise AssertionError("Backend did not activate the synthetic feed")
                    time.sleep(0.1)
                headers = {"Origin": origin, "Content-Type": "application/json"}
                with urlopen(Request(origin + "/api/v1/sessions", method="POST", headers=headers), timeout=10) as response:
                    session = json.load(response)["session_id"]
                    headers["Cookie"] = response.headers["Set-Cookie"].split(";", 1)[0]
                url = f"{origin}/api/v1/sessions/{session}"
                body = json.dumps({"client_message_id": str(uuid.uuid4()), "text": "DemoMail"}).encode()
                started = time.monotonic()
                with urlopen(Request(url + "/messages", body, headers), timeout=20) as response:
                    stream = response.read().decode()
                events = [line.removeprefix("event:").strip() for line in stream.splitlines() if line.startswith("event:")]
                assert "unverified text" not in stream
                with urlopen(Request(url, headers=headers), timeout=10) as response:
                    history = json.load(response)
                assert events[0] == "accepted" and "delta" in events, events
                answer = history["messages"][-1]
                assert answer["role"] == "assistant" and answer["text"]
                if args.cold_delay:
                    elapsed = time.monotonic() - started
                    assert events[-1] == "done" and answer["status"] == "complete", events
                    assert args.cold_delay <= elapsed < 120
                    assert args.cold_delay * 1000 < mock.cold_budget <= 120_000
                    assert any(line.startswith(":") and "waiting" in line for line in stream.splitlines())
                    warm_body = json.dumps({"client_message_id": str(uuid.uuid4()), "text": "DemoMail"}).encode()
                    warm_start = time.monotonic()
                    with urlopen(Request(url + "/messages", warm_body, headers), timeout=10) as response:
                        warm_stream = response.read().decode()
                    warm_elapsed = time.monotonic() - warm_start
                    assert "event:done" in warm_stream and warm_elapsed < 10
                    print(f"PASS: cold {args.cold_stage} {elapsed:.1f} s with SSE heartbeat, warm {warm_elapsed:.1f} s")
                else:
                    assert events[-1] == "failed" and answer["status"] == "partial", events
                    assert history["last_turn"]["error_code"] == "TURN_TIMEOUT", history["last_turn"]
                    print("PASS: streamed block retained as partial after model timeout")
            except (AssertionError, HTTPError, URLError):
                print(log.read_text()[-4000:])
                raise
            finally:
                server.terminate()
                try:
                    server.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
                mock.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jdbc-url", required=True, help="Use an empty, disposable PostgreSQL database on loopback")
    parser.add_argument("--db-user", default="postgres")
    parser.add_argument("--java", default="java")
    parser.add_argument("--jar", type=Path, default=Path("backend/target/support-agent-0.1.0-SNAPSHOT.jar"))
    parser.add_argument("--cold-delay", type=int, default=0, help="Simulate a cold response after this many seconds")
    parser.add_argument("--cold-stage", choices=("interpret", "compose"), default="interpret")
    arguments = parser.parse_args()
    if arguments.cold_delay != 0 and not 9 <= arguments.cold_delay <= 115:
        parser.error("--cold-delay must be between 9 and 115 seconds")
    if not arguments.jdbc_url.startswith(("jdbc:postgresql://127.0.0.1:", "jdbc:postgresql://localhost:")):
        parser.error("This check requires PostgreSQL on loopback")
    run(arguments)
