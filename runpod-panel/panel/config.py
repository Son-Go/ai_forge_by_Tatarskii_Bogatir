import os
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Config:
    endpoint_id: str
    management_key: str = field(repr=False)
    operator_password: str = field(repr=False)
    state_dir: Path
    operator_user: str = "operator"
    billing_key: str = field(default="", repr=False)
    inference_key: str = field(default="", repr=False)
    model: str = ""
    active_rate: Decimal | None = None
    flex_rate: Decimal | None = None
    rate_source: str = ""
    ml_concurrency: int | None = None
    grafana_url: str = "http://127.0.0.1:3000/d/runpod-token-usage"
    probe_seconds: int = 960

    @classmethod
    def from_environment(cls):
        def read_rate(name: str) -> Decimal | None:
            try:
                raw = os.getenv(name)
                if not raw:
                    return None
                rate = Decimal(raw)
                if rate.is_finite() and 0 < rate <= 1000 and rate.as_tuple().exponent >= -12:
                    return rate
            except InvalidOperation:
                pass
            raise ValueError(f"Invalid {name}")

        instance = cls(
            endpoint_id=os.getenv("PANEL_ENDPOINT_ID", ""),
            management_key=os.getenv("PANEL_MANAGEMENT_KEY", ""),
            operator_password=os.getenv("PANEL_OPERATOR_PASSWORD", ""),
            state_dir=Path(os.getenv("PANEL_STATE_DIR", "/data")),
            operator_user=os.getenv("PANEL_OPERATOR_USER", "operator"),
            billing_key=os.getenv("PANEL_BILLING_KEY", ""),
            inference_key=os.getenv("PANEL_INFERENCE_KEY", ""),
            model=os.getenv("PANEL_MODEL", ""),
            active_rate=read_rate("PANEL_ACTIVE_USD_PER_WORKER_HOUR"),
            flex_rate=read_rate("PANEL_FLEX_USD_PER_WORKER_HOUR"),
            rate_source=os.getenv("PANEL_RATE_SOURCE", "").strip(),
            ml_concurrency=int(os.getenv("PANEL_ML_CONCURRENCY") or "0") or None,
            grafana_url=os.getenv("PANEL_GRAFANA_URL")
            or "http://127.0.0.1:3000/d/runpod-token-usage",
            probe_seconds=int(os.getenv("PANEL_PROBE_TIMEOUT_SECONDS") or "960"),
        )
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", instance.endpoint_id):
            raise ValueError("Invalid PANEL_ENDPOINT_ID")
        if not instance.management_key or len(instance.operator_password) < 24:
            raise ValueError("Set PANEL_MANAGEMENT_KEY and a password of at least 24 characters")
        if (
            not re.fullmatch(r"[!-~]{1,64}", instance.operator_user)
            or ":" in instance.operator_user
        ):
            raise ValueError("Invalid PANEL_OPERATOR_USER")
        if not instance.operator_password.isascii() or not instance.operator_password.isprintable():
            raise ValueError("PANEL_OPERATOR_PASSWORD must contain printable ASCII")
        if bool(instance.inference_key) != bool(instance.model):
            raise ValueError("Set PANEL_INFERENCE_KEY and PANEL_MODEL together")
        if (instance.active_rate or instance.flex_rate) and not instance.rate_source:
            raise ValueError("Set PANEL_RATE_SOURCE when configuring rates")
        url = urlsplit(instance.grafana_url)
        if url.scheme not in {"https", "http"} or not url.hostname or url.username is not None:
            raise ValueError("Invalid PANEL_GRAFANA_URL")
        if not 1 <= instance.probe_seconds <= 1800 or (instance.ml_concurrency or 0) < 0:
            raise ValueError("Invalid panel probe timeout or ML concurrency")
        return instance
