import json
from datetime import UTC, datetime, timedelta

import httpx

NOW = datetime(2026, 11, 27, 14, tzinfo=UTC)


class RunpodMock:
    def __init__(self):
        self.now = NOW
        self.config = {
            "id": "local-endpoint",
            "type": "QUEUE",
            "name": "Support model",
            "version": 4,
            "workers": {"min": 0, "max": 1, "idleTimeout": 15, "initTimeout": 600},
            "scaling": {"type": "QUEUE_DELAY", "queueDelay": 4},
            "timeout": 300000,
            "flashboot": "OFF",
            "image": "test/model:v1",
            "env": {"HF_TOKEN": "never-show-this-secret", "MODEL_NAME": "mock"},
            "gpu": {"pools": ["ADA_48_PRO"], "count": 1},
        }
        self.calls = []
        self.patches = []
        self.write_fault = None
        self.read_fault = False
        self.worker_fault = False
        self.cost_fault = False
        self.probe_fault = False
        self.probe_job_status = "COMPLETED"
        self.probe_output = [{"choices": [{"message": {"content": "OK."}}]}]
        self.probe_status_fault = False
        self.probe_submissions = []
        self.health_fault = False
        self.idle_uptime = 10
        self.health = {
            "jobs": {"inProgress": 2, "inQueue": 1},
            "workers": {
                "idle": 0,
                "ready": 1,
                "running": 2,
                "initializing": 1,
                "throttled": 1,
                "unhealthy": 1,
            },
        }

    def __call__(self, request):
        path = request.url.path
        self.calls.append((request.method, path))
        if path == "/v2/local-endpoint/run":
            assert request.method == "POST"
            assert request.headers["Authorization"] == "Bearer inference-test"
            body = json.loads(request.content)
            assert body["input"]["openai_route"] == "/v1/chat/completions"
            assert "exactly OK" in body["input"]["openai_input"]["messages"][0]["content"]
            self.probe_submissions.append(body)
            if self.probe_fault:
                raise httpx.ReadTimeout("fixture timeout", request=request)
            return httpx.Response(200, json={"id": "probe-fixture", "status": "IN_QUEUE"})
        if path == "/v2/local-endpoint/status/probe-fixture":
            assert request.method == "GET"
            assert request.headers["Authorization"] == "Bearer inference-test"
            if self.probe_status_fault:
                return httpx.Response(503)
            return httpx.Response(
                200,
                json={
                    "id": "probe-fixture",
                    "status": self.probe_job_status,
                    "output": self.probe_output,
                },
            )
        if path.endswith("/chat/completions"):
            assert request.headers["Authorization"] == "Bearer inference-test"
            assert request.method == "POST"
            assert "exactly OK" in request.content.decode()
            if self.probe_fault:
                raise httpx.ReadTimeout("fixture timeout", request=request)
            return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})
        if path == "/v2/local-endpoint/health":
            assert request.method == "GET"
            assert request.headers["Authorization"] == "Bearer inference-test"
            return (
                httpx.Response(503) if self.health_fault else httpx.Response(200, json=self.health)
            )
        if path.startswith("/v2/billing"):
            assert request.headers["Authorization"] == "Bearer bill-test"
            if self.cost_fault:
                return httpx.Response(403, text="provider must not be forwarded")
            if path.endswith("/balance"):
                return httpx.Response(200, json={"balanceAmount": 42.18, "billingMode": "PREPAID"})
            params = request.url.params
            assert params["serverlessId"] == "local-endpoint"
            days = int(params["lastN"])
            end = self.now.replace(hour=0) + timedelta(days=1)
            start = end - timedelta(days=days)
            return httpx.Response(
                200,
                json={
                    "records": [
                        {
                            "serverlessId": "local-endpoint",
                            "startTime": (end - timedelta(days=1)).isoformat(),
                            "endTime": end.isoformat(),
                            "totalAmount": 1.23,
                        }
                    ],
                    "metadata": {
                        "recordCount": 1,
                        "query": {
                            "startTime": start.isoformat(),
                            "endTime": end.isoformat(),
                            "bucketSize": "day",
                            "serverlessId": "local-endpoint",
                        },
                        "totals": {"totalAmount": 1.23},
                    },
                },
            )
        assert request.headers["Authorization"] == "Bearer manage-test"
        assert path.startswith("/v2/serverless/local-endpoint")
        if path.endswith("/workers"):
            if self.worker_fault:
                return httpx.Response(503)
            return httpx.Response(
                200,
                json={
                    "summary": {
                        "idle": 1,
                        "running": 1,
                        "initializing": 1,
                        "throttled": 1,
                        "unhealthy": 1,
                        "total": 5,
                    },
                    "workers": [
                        {
                            "status": status,
                            "isStale": status == "RUNNING",
                            "uptimeSeconds": self.idle_uptime if status == "IDLE" else 60,
                        }
                        for status in ("IDLE", "RUNNING", "INITIALIZING", "THROTTLED", "UNHEALTHY")
                    ],
                },
            )
        if path.endswith("/metrics/requests"):
            return httpx.Response(
                200,
                json={
                    "records": [
                        {
                            "time": (self.now - timedelta(hours=3)).isoformat(),
                            "requests": 8,
                            "failed": 1,
                            "executionTimeMs": {"p95": 50},
                            "delayTimeMs": {"p95": 25},
                        },
                        {"time": self.now.isoformat(), "requests": 0, "failed": 0},
                    ],
                    "pagination": {"hasNextPage": False},
                },
            )
        if path.endswith("/metrics/cold-starts"):
            return httpx.Response(200, json={"records": [], "pagination": {"hasNextPage": False}})
        assert path == "/v2/serverless/local-endpoint"
        if request.method == "GET":
            if self.read_fault:
                return httpx.Response(503, text="never-show-this-secret")
            return httpx.Response(200, json=self.config)
        change = json.loads(request.content)
        self.patches.append(change)
        fault = self.write_fault
        if fault == "rejected":
            return httpx.Response(422, text="never-show-this-secret")
        if fault != "timeout":
            for key, value in change.items():
                if key == "workers":
                    self.config[key].update(value)
                else:
                    self.config[key] = value
            if "image" in change:
                self.config["version"] += 1
        if fault in {"timeout", "timeout_applied"}:
            self.write_fault = None
            raise httpx.ReadTimeout("never-show-this-secret", request=request)
        return httpx.Response(200, json=self.config)
