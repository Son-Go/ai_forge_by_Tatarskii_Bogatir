"""Run the operator UI and API against the local HTTP transport fixture."""

import httpx

from panel.main import create_app
from panel.runpod import utc_now

from .mock_runpod import RunpodMock


def make_app():
    fixture = RunpodMock()
    fixture.now = utc_now()
    return create_app(transport=httpx.MockTransport(fixture))
