# Sketch — Showdown ladder bot. Multi-arch (node:22 has arm64 for Raspberry Pi).
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt
RUN git clone --depth 1 https://github.com/smogon/pokemon-showdown && cd pokemon-showdown && npm ci && npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-numpy ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /opt/pokemon-showdown /app/pokemon-showdown
COPY . /app
RUN npm install --omit=dev ws && mkdir -p /app/replays/own /app/replays/all /app/manager/queue /app/models /app/data
ENV PS_PATH=/app/pokemon-showdown
# team file and game cap are overridable from compose
CMD ["sh", "-c", "if [ -f data/public_replays.tar.gz ] && [ $(ls replays/*.json 2>/dev/null | wc -l) -lt 1000 ]; then echo unpacking public replays; tar -xzf data/public_replays.tar.gz -C replays; fi; if [ \"$MANAGER\" = \"1\" ]; then (node manager.js 2>&1 | sed -u 's/^/[manager] /') & fi; exec node bot.js ${TEAM:-team_trickroom_v8.json} ${GAMES:-100000}"]
