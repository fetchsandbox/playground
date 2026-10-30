FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY src ./src
COPY verify/request.mjs ./verify/request.mjs
ARG DELIVERY=delivery.mjs
RUN cp src/${DELIVERY} /tmp/delivery.mjs && cp /tmp/delivery.mjs src/delivery.mjs && rm /tmp/delivery.mjs
USER node
CMD ["node","src/server.mjs"]
