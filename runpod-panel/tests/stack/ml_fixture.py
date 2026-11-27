import json

import httpx
from app.main import create_app


def respond(request):
    assert request.url.host == "api.runpod.ai"
    assert request.url.path == "/v2/mock-chat-endpoint/openai/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer local-fixture-inference"
    payload = json.loads(request.content)
    if not payload["stream"]:
        result = {
            "intent": "known_product",
            "product_query": "DemoMail",
            "updates": [],
            "clarification_candidates": [],
        }
        return httpx.Response(
            200,
            json={
                "id": "interpret-fixture",
                "choices": [{"message": {"content": json.dumps(result)}}],
                "usage": {"prompt_tokens": 24, "completion_tokens": 10},
            },
        )
    facts = json.loads(payload["messages"][1]["content"])["facts"]
    result = {"text": "DemoMail доступен в тестовом каталоге.", "fact_ids": [facts[0]["id"]]}
    chunks = [
        {"id": "compose-fixture", "choices": [{"delta": {"content": json.dumps(result) + "\n"}}]},
        {
            "id": "compose-fixture",
            "choices": [],
            "usage": {"prompt_tokens": 32, "completion_tokens": 8},
        },
    ]
    stream = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=stream)


def make_app():
    return create_app(runpod_transport=httpx.MockTransport(respond))
