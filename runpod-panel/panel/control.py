import asyncio
import fcntl
import hmac
import json
import secrets
import sqlite3
from contextlib import closing, contextmanager
from datetime import datetime, timedelta
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from .config import Config
from .runpod import ProviderError, Runpod, mapping, utc_now

PROFILES = {
    "economy": (0, 1),
    "always_ready": (1, 1),
    "autoscaling": (0, 2),
    "ready_with_capacity": (1, 2),
}
WARM_DURATION = timedelta(hours=2)
REVIEW_DELAY = timedelta(minutes=1)

# Configuration fields from the REST v2 endpoint schema. Runtime metadata is excluded.
CONFIG_FIELDS = (
    "id",
    "type",
    "name",
    "version",
    "workers",
    "scaling",
    "timeout",
    "flashboot",
    "image",
    "env",
    "args",
    "cmd",
    "entrypoint",
    "disk",
    "ports",
    "registry",
    "gpu",
    "cpu",
    "dataCenterIds",
    "networkVolumes",
    "mounts",
    "costCenter",
    "tags",
)
PUBLIC_FIELDS = {
    "min": "active",
    "max": "max",
    "idleTimeout": "idle_timeout",
    "name": "name",
    "timeout": "execution_timeout",
    "flashboot": "flashboot",
    "image": "image",
    "scaling": "scaling",
}
Fingerprint = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]


class PanelError(Exception):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class QueueDelay(StrictModel):
    type: Literal["QUEUE_DELAY"]
    queueDelay: Annotated[float, Field(ge=0.5)]


class RequestCount(StrictModel):
    type: Literal["REQUEST_COUNT"]
    requestCount: Annotated[int, Field(ge=1)]


class Change(StrictModel):
    revision: Fingerprint
    action: Literal["workers", "settings", "profile", "warm"]
    profile: Literal["economy", "always_ready", "autoscaling", "ready_with_capacity"] | None = None
    active: Annotated[int, Field(ge=0)] | None = None
    max: Annotated[int, Field(ge=0)] | None = None
    idle_timeout: Annotated[int, Field(ge=1, le=3600)] | None = None
    execution_timeout: Annotated[int, Field(ge=5000, le=604800000)] | None = None
    name: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]
        | None
    ) = None
    image: (
        Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,511}$")] | None
    ) = None
    flashboot: Literal["OFF", "FLASHBOOT", "PRIORITY_FLASHBOOT"] | None = None
    scaling: Annotated[QueueDelay | RequestCount, Field(discriminator="type")] | None = None

    @model_validator(mode="after")
    def fields_for_action(self):
        allowed = {
            "workers": {"active", "max", "idle_timeout"},
            "settings": {"name", "image", "flashboot", "scaling", "execution_timeout"},
            "profile": {"profile"},
            "warm": set(),
        }[self.action]
        provided = self.model_fields_set - {"revision", "action", "confirmation"}
        if (
            provided - allowed
            or any(getattr(self, field) is None for field in provided)
            or (self.action != "warm" and not provided)
        ):
            raise ValueError("Invalid action fields")
        return self


class Apply(Change):
    confirmation: Fingerprint


def idle_supported(endpoint: dict) -> bool:
    return not (
        endpoint["type"] == "QUEUE"
        and mapping(endpoint.get("scaling")).get("type") == "REQUEST_COUNT"
    )


class State:
    def __init__(self, config: Config):
        self.path = config.state_dir / f"{config.endpoint_id}.sqlite3"
        self.lock_path = config.state_dir / "panel.lock"

    @contextmanager
    def open(self):
        self.path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        # Only one panel process may operate this volume.
        with self.lock_path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with closing(sqlite3.connect(self.path)) as db, db:
                db.execute("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, value TEXT)")
                db.execute(
                    "CREATE TABLE IF NOT EXISTS signing_key (id INTEGER PRIMARY KEY, value BLOB)"
                )
                db.execute(
                    "INSERT OR IGNORE INTO signing_key VALUES (1, ?)", (secrets.token_bytes(32),)
                )
                self.key = db.execute("SELECT value FROM signing_key WHERE id = 1").fetchone()[0]
            yield

    def read(self) -> dict:
        with closing(sqlite3.connect(self.path)) as db, db:
            row = db.execute("SELECT value FROM state WHERE id = 1").fetchone()
        return json.loads(row[0]) if row else {"timer": None, "pending": None, "result": None}

    def save(self, state: dict) -> None:
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute(
                "INSERT OR REPLACE INTO state (id, value) VALUES (1, ?)",
                (json.dumps(state, allow_nan=False),),
            )


def projected(config: dict, patch: dict) -> dict:
    result = config | patch
    if "workers" in patch:
        result["workers"] = config["workers"] | patch["workers"]
    return result


def differences(config: dict, patch: dict) -> list[dict]:
    changed = [
        {"field": PUBLIC_FIELDS[key], "old": config.get(key), "new": value}
        for key, value in patch.items()
        if key != "workers"
    ]
    changed.extend(
        {"field": PUBLIC_FIELDS[key], "old": config["workers"].get(key), "new": value}
        for key, value in patch.get("workers", {}).items()
    )
    return changed


class Control:
    def __init__(self, config: Config, provider: Runpod, now=utc_now):
        self.config = config
        self.provider = provider
        self.state = State(config)
        self.lock = asyncio.Lock()
        self.now = now

    def _sign(self, value) -> str:
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        return hmac.digest(self.state.key, encoded, "sha256").hex()

    def _revision(self, config: dict) -> str:
        return self._sign({k: config[k] for k in CONFIG_FIELDS if k in config})

    def view(self, config: dict) -> dict:
        workers = config["workers"]
        scaling = mapping(config.get("scaling"))
        return {
            "revision": self._revision(config),
            "type": config["type"],
            "active": workers["min"],
            "max": workers["max"],
            "idle_timeout": workers.get("idleTimeout"),
            "idle_supported": idle_supported(config),
            "name": config.get("name"),
            "image": config.get("image"),
            "execution_timeout": config.get("timeout"),
            "flashboot": config.get("flashboot"),
            "scaling": {
                key: scaling[key]
                for key in ("type", "queueDelay", "requestCount")
                if key in scaling
            },
            "env_names": sorted(config["env"]) if isinstance(config.get("env"), dict) else None,
        }

    def status(self) -> dict:
        state = self.state.read()
        timer = state["timer"]
        pending = state["pending"]
        return {
            "timer": {k: v for k, v in timer.items() if k in {"until", "status"}}
            if timer
            else None,
            "pending": {
                "action": pending["action"],
                "review_at": (
                    datetime.fromisoformat(pending["started"]) + REVIEW_DELAY
                ).isoformat(),
            }
            if pending
            else None,
            "result": state["result"],
        }

    def estimate(self, active: int, maximum: int) -> dict:
        active_rate, flex_rate = self.config.active_rate, self.config.flex_rate
        active_cost = 0 if not active else active * active_rate if active_rate else None
        flex_count = maximum - active
        flex_cost = 0 if not flex_count else flex_count * flex_rate if flex_rate else None
        ceiling = None if active_cost is None or flex_cost is None else active_cost + flex_cost
        return {
            "active_hour": str(active_cost) if active_cost is not None else None,
            "ceiling_hour": str(ceiling) if ceiling is not None else None,
            "warm_two_hours": str(2 * active_rate) if active_rate is not None else None,
            "active_rate": str(active_rate) if active_rate is not None else None,
            "flex_rate": str(flex_rate) if flex_rate is not None else None,
            "source": self.config.rate_source or None,
        }

    def _patch_for(self, config: dict, change: Change, state: dict) -> dict:
        current = config["workers"]
        workers = {}
        if change.action == "profile":
            workers["min"], workers["max"] = PROFILES[change.profile]
        elif change.action == "warm":
            if current["min"] != 0 or not current["max"]:
                raise PanelError("warm_unavailable")
            workers["min"] = 1
        elif change.action == "workers":
            for key, value in (
                ("min", change.active),
                ("max", change.max),
                ("idleTimeout", change.idle_timeout),
            ):
                if value is not None:
                    workers[key] = value
        effective = current | workers
        if effective["min"] > effective["max"]:
            raise PanelError("active_exceeds_max", 422)
        if "idleTimeout" in workers and (
            not idle_supported(config) or effective["min"] == effective["max"]
        ):
            raise PanelError("idle_unavailable", 422)

        patch = {}
        if change.scaling is not None:
            if change.scaling.type == "QUEUE_DELAY" and config["type"] != "QUEUE":
                raise PanelError("scaling_unavailable", 422)
            patch["scaling"] = change.scaling.model_dump()
        for key, value in (
            ("name", change.name),
            ("image", change.image),
            ("flashboot", change.flashboot),
            ("timeout", change.execution_timeout),
        ):
            if value is not None:
                patch[key] = value
        patch = {k: v for k, v in patch.items() if v != config.get(k)}
        worker_patch = {k: v for k, v in workers.items() if current.get(k) != v}
        if worker_patch:
            patch["workers"] = worker_patch
        if not patch and not self._cancels_timer(change, state):
            raise PanelError("no_changes")
        return patch

    @staticmethod
    def _cancels_timer(change: Change, state: dict) -> bool:
        return state["timer"] is not None and (
            change.action == "profile" or change.active is not None
        )

    async def _prepare(self, change: Change, state: dict) -> tuple[dict, dict, str]:
        if state["pending"]:
            raise PanelError("write_pending")
        config = await self.provider.endpoint()
        if not hmac.compare_digest(self._revision(config), change.revision):
            raise PanelError("configuration_changed")
        patch = self._patch_for(config, change, state)
        confirmation = self._sign(
            [change.model_dump(exclude={"confirmation"}), patch, state["timer"]]
        )
        return config, patch, confirmation

    async def preview(self, change: Change) -> dict:
        async with self.lock:
            state = self.state.read()
            config, patch, confirmation = await self._prepare(change, state)
            workers = projected(config, patch)["workers"]
            return {
                "confirmation": confirmation,
                "diff": differences(config, patch),
                "rollout_warning": any(field in patch for field in ("image", "flashboot")),
                "capacity_warning": "workers" in patch or "scaling" in patch,
                "cancels_timer": self._cancels_timer(change, state),
                "estimate": self.estimate(workers["min"], workers["max"]),
            }

    async def apply(self, change: Apply) -> dict:
        async with self.lock:
            state = self.state.read()
            config, patch, confirmation = await self._prepare(change, state)
            if not hmac.compare_digest(confirmation, change.confirmation):
                raise PanelError("confirmation_expired")
            cancel_timer = self._cancels_timer(change, state)
            if not patch:
                state.update(timer=None, result={"status": "timer_cancelled"})
                self.state.save(state)
                return state["result"]
            return await self._write(state, config, patch, change.action, cancel_timer)

    async def _write(self, state, config, patch, action, cancel_timer=False) -> dict:
        next_config = projected(config, patch)
        started = self.now()
        state["pending"] = {
            "action": action,
            "patch": patch,
            "before": self._revision(config),
            "expected": self._revision(next_config),
            "started": started.isoformat(),
            "cancel_timer": cancel_timer,
        }
        state["result"] = {"status": "write_pending"}
        self.state.save(state)
        try:
            await self.provider.patch(patch)
        except ProviderError as exc:
            if not exc.uncertain:
                state.update(pending=None, result={"status": exc.code})
                if action == "restore":
                    state["timer"]["status"] = "timer_restore_failed"
                self.state.save(state)
                return state["result"]
            state["result"]["reason"] = exc.code
            self.state.save(state)
        return await self._reconcile(state)

    async def _reconcile(self, state, *, acknowledge=False) -> dict:
        pending = state["pending"]
        try:
            config = await self.provider.endpoint()
        except ProviderError as exc:
            return {"status": "write_pending", "reason": exc.code}

        patch, action = pending["patch"], pending["action"]
        revision = self._revision(config)
        applied = all(item["old"] == item["new"] for item in differences(config, patch))
        if applied:
            if action == "warm":
                state["timer"] = {
                    "until": (
                        datetime.fromisoformat(pending["started"]) + WARM_DURATION
                    ).isoformat(),
                    "expected": pending["expected"],
                    "status": "timer_active"
                    if revision == pending["expected"]
                    else "timer_conflict",
                }
            elif action == "restore" or pending["cancel_timer"]:
                state["timer"] = None
            status = "timer_restored" if action == "restore" else "applied"
        elif revision != pending["before"]:
            status = "write_conflict"
        elif (
            acknowledge and self.now() >= datetime.fromisoformat(pending["started"]) + REVIEW_DELAY
        ):
            status = "write_unconfirmed"
        else:
            return state["result"]

        if action == "restore" and status != "timer_restored":
            state["timer"]["status"] = "timer_conflict"
        state.update(pending=None, result={"status": status, "checked_at": self.now().isoformat()})
        self.state.save(state)
        return state["result"]

    async def review(self) -> dict:
        async with self.lock:
            state = self.state.read()
            return (
                await self._reconcile(state, acknowledge=True)
                if state["pending"]
                else (state["result"] or {"status": "no_pending"})
            )

    async def tick(self) -> None:
        async with self.lock:
            state = self.state.read()
            if state["pending"]:
                await self._reconcile(state)
                return
            timer = state["timer"]
            if (
                not timer
                or timer["status"] not in {"timer_active", "timer_read_failed"}
                or datetime.fromisoformat(timer["until"]) > self.now()
            ):
                return
            try:
                config = await self.provider.endpoint()
            except ProviderError:
                if timer["status"] != "timer_read_failed":
                    timer["status"] = "timer_read_failed"
                    self.state.save(state)
                return
            if self._revision(config) != timer["expected"]:
                timer["status"] = "timer_conflict"
                self.state.save(state)
                return
            await self._write(state, config, {"workers": {"min": 0}}, "restore")
