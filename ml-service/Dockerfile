FROM ghcr.io/astral-sh/uv:0.10.2 AS uv
FROM python:3.13-slim AS build

COPY --from=uv /uv /bin/uv
WORKDIR /srv/ml-service
ENV UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project --no-cache

FROM python:3.13-slim
WORKDIR /srv/ml-service
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY --from=build /srv/ml-service/.venv .venv
COPY app app
USER 10001:10001
EXPOSE 8000
CMD [".venv/bin/python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
