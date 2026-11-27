FROM ghcr.io/astral-sh/uv:0.10.2 AS uv
FROM python:3.13-slim
COPY --from=uv /uv /bin/uv
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY panel/ panel/
RUN mkdir /data && chown 10001:10001 /data && chmod 700 /data
USER 10001:10001
CMD ["/app/.venv/bin/uvicorn", "panel.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--no-proxy-headers", "--timeout-graceful-shutdown", "8"]
