FROM maven:3.9-eclipse-temurin-21 AS backend-build
WORKDIR /workspace/backend
COPY backend/pom.xml .
COPY backend/src/ ./src/
RUN --mount=type=cache,target=/root/.m2 mvn --batch-mode --no-transfer-progress package

FROM eclipse-temurin:21-jre AS backend
WORKDIR /app
COPY --from=backend-build /workspace/backend/target/support-agent-0.1.0-SNAPSHOT.jar ./support-agent.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "support-agent.jar"]

FROM ghcr.io/astral-sh/uv:0.10.2 AS uv

FROM python:3.13-slim AS ml-build
COPY --from=uv /uv /bin/uv
WORKDIR /srv/ml-service
ENV UV_LINK_MODE=copy
COPY ml-service/pyproject.toml ml-service/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project --no-cache

FROM python:3.13-slim AS ml-service
WORKDIR /srv/ml-service
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY --from=ml-build /srv/ml-service/.venv .venv
COPY ml-service/app/ ./app/
RUN install -d -o 10001 -g 10001 /var/log/ml-service
USER 10001:10001
EXPOSE 8000
CMD [".venv/bin/python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /workspace/frontend
RUN npm install --global pnpm@11.25.0
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

FROM caddy:2 AS caddy
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend-build /workspace/frontend/dist/ /srv/frontend/dist/
