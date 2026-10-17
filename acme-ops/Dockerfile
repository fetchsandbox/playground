# AgentCore Runtime requires linux/arm64 and an HTTP server on :8080.
# One image per workflow: docker build --build-arg WORKFLOW=support-escalation .
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run bundle

FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-slim
ARG WORKFLOW
RUN test -n "$WORKFLOW" || (echo "build with --build-arg WORKFLOW=<id>" && exit 1)
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps PORT=8080 WORKFLOW=${WORKFLOW}
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.mjs"]
