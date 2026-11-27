from base64 import b64encode
from copy import deepcopy
from datetime import timedelta
from decimal import Decimal

import httpx
import pytest
from fastapi.testclient import TestClient

from panel.config import Config
from panel.main import create_app

from .mock_runpod import NOW, RunpodMock

AUTH = ("operator", "operator-password-for-local-tests")
HEADERS = {
    "x-panel-request": "1",
    "authorization": "Basic " + b64encode(":".join(AUTH).encode()).decode(),
}


@pytest.fixture
def mock():
    return RunpodMock()


@pytest.fixture
def app_factory(mock, tmp_path):
    config = Config(
        "local-endpoint",
        "manage-test",
        AUTH[1],
        tmp_path,
        billing_key="bill-test",
        inference_key="inference-test",
        model="synthetic-test",
        active_rate=Decimal("1.75"),
        flex_rate=Decimal("2.25"),
        rate_source="test fixture",
    )

    def make_app():
        return create_app(config, transport=httpx.MockTransport(mock), now=lambda: mock.now)

    return make_app


@pytest.fixture
def client(app_factory):
    with TestClient(app_factory(), base_url="http://127.0.0.1", headers=HEADERS) as client:
        yield client


def state(client):
    return client.get("/api/state").json()


def preview(client, action, **kwargs):
    draft = {"revision": state(client)["endpoint"]["data"]["revision"], "action": action, **kwargs}
    return draft, client.post("/api/preview", json=draft)


def submit(client, action, **kwargs):
    draft, response = preview(client, action, **kwargs)
    assert response.status_code == 200, response.json()
    preview_data = response.json()
    return preview_data, client.post(
        "/api/apply", json=draft | {"confirmation": preview_data["confirmation"]}
    )


def tick(client):
    control = client.app.state.control
    client.portal.call(control.tick)


def test_private_routes_and_origin(client, mock):
    for path in ("/", "/assets/panel.js", "/api/state", "/api/metrics", "/api/costs"):
        assert client.get(path, headers={"authorization": ""}).status_code == 401
    assert client.post("/api/probe", headers={"authorization": ""}).status_code == 401
    assert client.get("/healthz", headers={"authorization": ""}).json() == {"status": "ok"}
    assert client.post("/api/probe", headers={"x-panel-request": "0"}).status_code == 403
    assert client.post("/api/probe", headers={"origin": "https://foreign.test"}).status_code == 403
    assert client.post("/api/probe", headers={"sec-fetch-site": "same-site"}).status_code == 403
    assert client.get("/api/state", headers={"host": "foreign.test"}).status_code == 400
    assert not mock.calls


@pytest.mark.parametrize(
    "profile,expected",
    [
        ("economy", (0, 1)),
        ("always_ready", (1, 1)),
        ("autoscaling", (0, 2)),
        ("ready_with_capacity", (1, 2)),
    ],
)
def test_profiles_preserve_unedited_values(client, mock, profile, expected):
    mock.config["workers"]["max"] = 3
    before = deepcopy(mock.config)
    diff, result = submit(client, "profile", profile=profile)
    assert result.json()["status"] == "applied"
    assert (mock.config["workers"]["min"], mock.config["workers"]["max"]) == expected
    assert diff["diff"]
    assert diff["estimate"]["warm_two_hours"] == "3.50"
    assert mock.config["workers"]["initTimeout"] == before["workers"]["initTimeout"]
    assert mock.config["workers"]["idleTimeout"] == before["workers"]["idleTimeout"]
    assert mock.config["env"] == before["env"]
    assert mock.config["gpu"] == before["gpu"]
    assert "never-show-this-secret" not in client.get("/api/state").text


@pytest.mark.parametrize(
    "values,error",
    [
        ({"active": 2}, "active_exceeds_max"),
        ({"max": -1}, "invalid_input"),
        ({"active": True}, "invalid_input"),
        ({"max": 1.5}, "invalid_input"),
        ({"active": None}, "invalid_input"),
        ({"idle_timeout": 3601}, "invalid_input"),
        ({"active": 1, "idle_timeout": 30}, "idle_unavailable"),
        ({"gpu": "unapproved"}, "invalid_input"),
    ],
)
def test_workers_validation(client, mock, values, error):
    _, result = preview(client, "workers", **values)
    assert result.status_code == 422
    assert result.json()["error"] == error
    assert not mock.patches


def test_idle_timeout_depends_on_endpoint_and_scaler(client, mock):
    mock.config["scaling"] = {"type": "REQUEST_COUNT", "requestCount": 3}
    _, result = preview(client, "workers", idle_timeout=20)
    assert result.json()["error"] == "idle_unavailable"
    mock.config["type"] = "LOAD_BALANCER"
    assert submit(client, "workers", idle_timeout=20)[1].json()["status"] == "applied"
    _, result = preview(client, "settings", scaling={"type": "QUEUE_DELAY", "queueDelay": 0.5})
    assert result.json()["error"] == "scaling_unavailable"


def test_settings_show_diff_and_verify_after_rollout(client, mock):
    diff, result = submit(
        client,
        "settings",
        name="Renamed",
        image="test/model:v2",
        flashboot="FLASHBOOT",
        scaling={"type": "QUEUE_DELAY", "queueDelay": 0.5},
        execution_timeout=60000,
    )
    assert diff["rollout_warning"]
    assert {"field": "image", "old": "test/model:v1", "new": "test/model:v2"} in diff["diff"]
    assert result.json()["status"] == "applied"
    latest = state(client)
    assert latest["endpoint"]["data"]["execution_timeout"] == 60000
    assert set(latest["endpoint"]["data"]["env_names"]) == {"HF_TOKEN", "MODEL_NAME"}
    assert latest["workers"]["data"] | {"observed_at": None} == {
        "ready": 1,
        "busy": 1,
        "starting": 1,
        "problem": 2,
        "stale_workers": 1,
        "current_ready": 1,
        "inactive_idle": 0,
        "jobs_in_progress": 2,
        "runtime_running": 2,
        "runtime_active": 3,
        "observed_at": None,
    }
    assert "env" not in mock.patches[-1]
    assert preview(client, "settings", env={"HF_TOKEN": "new-secret"})[1].status_code == 422


@pytest.mark.parametrize("endpoint_type", ["QUEUE", "LOAD_BALANCER"])
def test_idle_inventory_without_uptime_is_not_a_ready_worker(client, mock, endpoint_type):
    mock.config["type"] = endpoint_type
    mock.idle_uptime = None
    mock.health["workers"].update(ready=0, running=1, initializing=0, throttled=0, unhealthy=0)
    mock.health["jobs"]["inProgress"] = 0
    workers = state(client)["workers"]["data"]
    assert workers["ready"] == workers["current_ready"] == 0
    assert workers["inactive_idle"] == 1
    if endpoint_type == "QUEUE":
        assert workers["runtime_running"] == workers["runtime_active"] == 1
        assert workers["jobs_in_progress"] == workers["busy"] == workers["problem"] == 0
    else:
        assert "runtime_running" not in workers
        assert not any(path.endswith("/health") for _, path in mock.calls)


def test_queue_health_survives_inventory_failure_without_inventing_busy_count(client, mock):
    mock.worker_fault = True
    workers = state(client)["workers"]["data"]
    assert workers["ready"] == 1
    assert workers["jobs_in_progress"] == 2
    assert workers["busy"] is None


def test_inventory_used_when_queue_health_fails(client, mock):
    mock.health_fault = True
    mock.idle_uptime = None
    workers = state(client)["workers"]["data"]
    assert workers["ready"] == 0
    assert workers["runtime_error"] == "provider_response"


def test_probe_reports_local_timeout_separately(client, mock):
    mock.probe_fault = True
    mock.config["type"] = "LOAD_BALANCER"
    assert state(client)["probe_timeout_seconds"] == 120
    result = client.post("/api/probe").json()
    assert result["status"] == "probe_timeout"
    assert result["elapsed_ms"] >= 0
    assert mock.patches == []


def test_confirmation_tied_to_settings_and_requested_change(client, mock):
    draft, response = preview(client, "workers", max=2)
    confirm = response.json()["confirmation"]
    result = client.post("/api/apply", json=draft | {"max": 3, "confirmation": confirm})
    assert result.json()["error"] == "confirmation_expired"
    mock.config["env"]["HF_TOKEN"] = "changed-elsewhere"
    result = client.post("/api/apply", json=draft | {"confirmation": confirm})
    assert result.json()["error"] == "configuration_changed"
    assert not mock.patches


def test_api_failures_are_independent_and_redacted(client, mock):
    mock.read_fault = mock.worker_fault = mock.cost_fault = True
    overview = client.get("/api/state")
    assert overview.status_code == 200
    assert overview.json()["endpoint"]["error"] == "provider_response"
    assert overview.json()["workers"]["data"] is None
    assert "never-show-this-secret" not in overview.text
    assert client.get("/api/costs").json()["today"]["error"] == "provider_auth"
    mock.read_fault = False
    mock.write_fault = "rejected"
    _, result = submit(client, "workers", max=4)
    assert result.json()["status"] == "provider_rejected"
    assert "never-show-this-secret" not in result.text
    assert state(client)["pending"] is None


@pytest.mark.parametrize("applied", [True, False])
def test_timeout_checks_readback_without_repeating_patch(client, mock, applied):
    mock.write_fault = "timeout_applied" if applied else "timeout"
    _, result = submit(client, "workers", max=4)
    assert result.json()["status"] == ("applied" if applied else "write_pending")
    assert mock.calls[-2:] == [
        ("PATCH", "/v2/serverless/local-endpoint"),
        ("GET", "/v2/serverless/local-endpoint"),
    ]
    if not applied:
        assert preview(client, "workers", max=4)[1].json()["error"] == "write_pending"
        mock.now += timedelta(seconds=61)
        mock.read_fault = True
        assert client.post("/api/review").json()["status"] == "write_pending"
        mock.read_fault = False
        assert client.post("/api/review").json()["status"] == "write_unconfirmed"
        assert state(client)["pending"] is None
    assert len(mock.patches) == 1


def test_timer_survives_restart_and_restores_only_active(app_factory, mock):
    mock.config["workers"]["max"] = 2
    with TestClient(app_factory(), base_url="http://localhost", headers=HEADERS) as client:
        _, result = submit(client, "warm")
        assert result.json()["status"] == "applied"
        assert state(client)["timer"]["until"] == (NOW + timedelta(hours=2)).isoformat()
    mock.now += timedelta(hours=2, seconds=1)
    with TestClient(app_factory(), base_url="http://localhost", headers=HEADERS) as client:
        tick(client)
        assert state(client)["result"]["status"] == "timer_restored"
        assert state(client)["timer"] is None
    assert mock.patches == [{"workers": {"min": 1}}, {"workers": {"min": 0}}]
    assert mock.config["workers"]["max"] == 2


@pytest.mark.parametrize(
    "action,kwargs,final",
    [
        ("profile", {"profile": "ready_with_capacity"}, 1),
        ("workers", {"active": 0}, 0),
        ("workers", {"active": 1}, 1),
    ],
)
def test_manual_mode_cancels_restore(client, mock, action, kwargs, final):
    submit(client, "warm")
    diff, result = submit(client, action, **kwargs)
    assert diff["cancels_timer"]
    assert result.json()["status"] in {"applied", "timer_cancelled"}
    number_of_patches = len(mock.patches)
    mock.now += timedelta(hours=3)
    tick(client)
    assert state(client)["timer"] is None
    assert len(mock.patches) == number_of_patches
    assert mock.config["workers"]["min"] == final


def test_timer_retries_read_and_detects_drift_without_overwriting(client, mock):
    submit(client, "warm")
    mock.now += timedelta(hours=3)
    mock.read_fault = True
    tick(client)
    mock.read_fault = False
    assert state(client)["timer"]["status"] == "timer_read_failed"
    mock.config["workers"]["max"] = 2
    tick(client)
    assert state(client)["timer"]["status"] == "timer_conflict"
    assert mock.patches == [{"workers": {"min": 1}}]


def test_billing_metrics_and_probe(client):
    costs = client.get("/api/costs").json()
    assert costs["balance"]["data"] == {"amount": "42.18", "mode": "PREPAID"}
    for key, days in (("today", 1), ("week", 7), ("month", 30)):
        period = costs[key]["data"]
        assert period["total"] == "1.23"
        assert len(period["records"]) == days
        assert period["records"][-1] == {"day": "2026-11-27", "amount": "1.23"}
        assert all(row["amount"] is None for row in period["records"][:-1])
    metrics = client.get("/api/metrics").json()
    assert metrics["requests"]["data"]["requests"]["status"] == "current"
    assert metrics["requests"]["data"]["execution_p95"]["status"] == "stale"
    assert metrics["cold_starts"]["data"]["cold_starts"]["status"] == "unavailable"
    assert client.post("/api/probe").json()["status"] == "probe_queued"
    assert client.get("/api/probe").json()["status"] == "probe_ok"


def test_pending_warm_is_recovered_after_process_restart(app_factory, mock):
    with TestClient(app_factory(), base_url="http://localhost", headers=HEADERS) as client:
        mock.write_fault = "timeout"
        assert submit(client, "warm")[1].json()["status"] == "write_pending"
        assert state(client)["timer"] is None
    mock.config["workers"]["min"] = 1
    mock.now += timedelta(minutes=5)

    with TestClient(app_factory(), base_url="http://localhost", headers=HEADERS) as client:
        tick(client)
        assert state(client)["timer"]["until"] == (NOW + timedelta(hours=2)).isoformat()
        assert state(client)["result"]["status"] == "applied"
    assert mock.patches == [{"workers": {"min": 1}}]


def test_restore_timeout_is_reconciled_without_repeating_write(client, mock):
    submit(client, "warm")
    mock.now += timedelta(hours=2, seconds=1)
    mock.write_fault = "timeout"
    tick(client)
    assert state(client)["pending"]["action"] == "restore"
    tick(client)
    assert mock.patches == [{"workers": {"min": 1}}, {"workers": {"min": 0}}]
    mock.config["workers"]["min"] = 0
    tick(client)
    assert state(client)["result"]["status"] == "timer_restored"
    assert state(client)["timer"] is None


def test_secret_values_are_not_persisted_for_conflict_checks(client, mock):
    submit(client, "warm")
    store = client.app.state.control.state.path
    assert b"never-show-this-secret" not in store.read_bytes()
    for credential in ("inference-test", "manage-test", "bill-test", AUTH[1]):
        assert credential.encode() not in store.read_bytes()
    mock.config["env"]["HF_TOKEN"] = "changed-elsewhere"
    mock.now += timedelta(hours=2, seconds=1)
    tick(client)
    assert state(client)["timer"]["status"] == "timer_conflict"
    assert mock.patches == [{"workers": {"min": 1}}]


def test_queue_probe_uses_one_job_and_reports_progress(client, mock):
    assert state(client)["probe_timeout_seconds"] == 960
    assert client.get("/api/probe").json() is None
    assert client.post("/api/probe").json()["status"] == "probe_queued"
    mock.probe_status_fault = True
    pending = client.get("/api/probe").json()
    assert pending["status"] == "probe_queued"
    assert pending["status_error"] == "provider_response"
    mock.probe_status_fault = False
    mock.probe_job_status = "IN_PROGRESS"
    assert client.get("/api/probe").json()["status"] == "probe_processing"
    assert client.post("/api/probe").json()["status"] == "probe_processing"
    assert len(mock.probe_submissions) == 1
    assert mock.probe_submissions[0]["policy"] == {"ttl": 960000}
    mock.probe_job_status = "COMPLETED"
    result = client.get("/api/probe").json()
    assert result["status"] == "probe_ok"
    assert client.get("/api/probe").json() == result


def test_queue_probe_reports_last_state_when_local_wait_expires(client, mock):
    assert client.post("/api/probe").json()["status"] == "probe_queued"
    client.app.state.control.provider._probe_job.started -= 961
    assert client.get("/api/probe").json()["status"] == "probe_wait_queue_expired"
    assert not any("/status/" in path for _, path in mock.calls)


def test_uncertain_probe_submission_does_not_retry(client, mock):
    mock.probe_fault = True
    assert client.post("/api/probe").json()["status"] == "probe_submission_unknown"
    assert client.get("/api/probe").json() is None
    assert len(mock.probe_submissions) == 1


@pytest.mark.parametrize(
    "remote,status",
    [
        ("CANCELLED", "probe_cancelled"),
        ("TIMED_OUT", "probe_provider_timeout"),
        ("FAILED", "probe_failed"),
    ],
)
def test_queue_probe_reports_provider_terminal_status(client, mock, remote, status):
    mock.probe_job_status = remote
    assert client.post("/api/probe").json()["status"] == "probe_queued"
    assert client.get("/api/probe").json()["status"] == status
