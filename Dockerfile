# VibeCoder in hosted mode (docs/HOSTING.md, option B).
#   docker build -t vibecoder .
#   docker run -p 7860:7860 -e VIBE_ACCESS_CODE=choose-a-long-code vibecoder
# 7860 is the port Hugging Face Docker Spaces expect.

FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY ui/package.json ui/package-lock.json ./ui/
RUN npm --prefix ui ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
# git: generated projects are versioned; the runtime check and builds use npm.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/grammars ./grammars
RUN useradd --create-home vibe && mkdir -p /data/projects && chown -R vibe /data
USER vibe
WORKDIR /data/projects
ENV NODE_ENV=production
EXPOSE 7860
CMD ["node", "/app/dist/cli.js", "/data/projects", "--hosted", "--host=0.0.0.0", "--port=7860"]
