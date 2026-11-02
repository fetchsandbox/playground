# One image per workflow, any cloud. The runtime is an HTTP server on :8080 (POST /invocations, GET /ping).
#   AWS AgentCore (arm64):          docker build --platform linux/arm64 --build-arg WORKFLOW=<id> .
#   Cloud Run / Snowflake SPCS:     docker build --platform linux/amd64 --build-arg WORKFLOW=<id> .
# The workflow's policy defaults (policies/<id>.json) are bundled; POLICY_FILE / POLICY_JSON override them.
FROM public.ecr.aws/docker/library/node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY policies ./policies
RUN npm run bundle

FROM public.ecr.aws/docker/library/node:22-slim
ARG WORKFLOW
RUN test -n "$WORKFLOW" || (echo "build with --build-arg WORKFLOW=<id>" && exit 1)
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps PORT=8080 WORKFLOW=${WORKFLOW}
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.mjs"]
