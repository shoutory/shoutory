# The Shoutory image: built on the official Node image, run on a distroless Node with no shell. Every image is named
# by version and digest, with the date its digest was read on the line above; a newer digest is a reviewed change.
#
# Build:  docker build -f docker/Dockerfile --build-arg SHOUTORY_RELEASE_CHANNEL=stable -t shoutory .
ARG SHOUTORY_RELEASE_CHANNEL=stable

# Node 26.13.0 on Debian 13 slim, same glibc as the runtime base below. Index digest read 2026-11-20; its manifests
# were created 2026-11-05.
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
# pnpm 12.17.0 is copied from its official image as it is, with no install script (published 2026-10-30; index digest read 2026-11-20).
COPY --from=ghcr.io/pnpm/pnpm:12.17.0@sha256:172468925f0ca368313c09867081a43e298eaeb13dee8f7e4356bfad45dd8b15 /opt/pnpm /opt/pnpm
ENV PATH=/opt/pnpm:$PATH
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build
# The runtime keeps the repository layout, so only production dependencies are installed again, from the lockfile, for
# the api and what it depends on; the build output stays where it is.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules packages/providers/*/node_modules \
  && pnpm install --frozen-lockfile --prod --filter @shoutory/api... \
  && mkdir /data

# Distroless Node 26.13.0 on Debian 13, the nonroot variant, built from its source commit of 2026-11-02 (the image config
# carries no date). Index digest read 2026-11-20.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:9b945e92c1b5463a4b75f11e8417515e4bea7355f6adfd79ec220fbbe905dda8
ARG SHOUTORY_RELEASE_CHANNEL
WORKDIR /app
# The root package.json holds the version the admin screen shows (read from beside the build).
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/package.json /app/apps/api/package.json
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /app/apps/web/dist /app/apps/web/dist
COPY --from=build /app/packages/core/package.json /app/packages/core/package.json
COPY --from=build /app/packages/core/dist /app/packages/core/dist
COPY --from=build /app/packages/core/node_modules /app/packages/core/node_modules
COPY --from=build /app/packages/db/package.json /app/packages/db/package.json
COPY --from=build /app/packages/db/dist /app/packages/db/dist
COPY --from=build /app/packages/db/migrations /app/packages/db/migrations
COPY --from=build /app/packages/db/node_modules /app/packages/db/node_modules
COPY --from=build --chown=nonroot:nonroot /data /data
ENV TZ=UTC
ENV SHOUTORY_RELEASE_CHANNEL=${SHOUTORY_RELEASE_CHANNEL}
ENV SHOUTORY_WEB_ROOT=/app/apps/web/dist/client
ENV NODE_ENV=production
USER nonroot
VOLUME /data
ENTRYPOINT ["/nodejs/bin/node", "/app/apps/api/dist/main.js"]
