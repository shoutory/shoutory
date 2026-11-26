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
# A nightly image has no release tag, so its About page links the commit it was built from; a release leaves it empty.
ARG SHOUTORY_SOURCE_COMMIT=""
RUN pnpm run build
# The runtime keeps the repository layout, so only production dependencies are installed again, from the lockfile, for
# the api and what it depends on; the build output stays where it is.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules packages/providers/*/node_modules \
  && pnpm install --frozen-lockfile --prod --filter @shoutory/api... \
  && mkdir /data

# ffprobe and ffmpeg, an LGPL-only build from pinned FFmpeg source that reads and writes local files only (the probe of an
# uploaded video, and its stream copy without metadata). The toolchain comes from Debian's package index at build time and
# is never copied out; the shipped input is the tarball, FFmpeg 9.0.2 of 2026-09-18, pinned by sha256 (its signature was
# checked once against the release key; docs/dependencies.md).
# The same Debian 13 base as the build stage above, so the binary links the glibc the distroless runtimes carry. Index digest read 2026-11-20.
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS ffmpeg
RUN apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends gcc make libc6-dev xz-utils \
  && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz /src/ffmpeg.tar.xz
WORKDIR /src
# No GPL or nonfree option, no network, no encoder or decoder, one protocol (file), the two demuxers a video upload needs
# and the three muxers that write its copy back in the container it came in.
RUN tar -xJf ffmpeg.tar.xz --strip-components=1 \
  && ./configure --disable-everything --disable-autodetect --disable-network --disable-doc \
    --disable-ffplay --disable-x86asm \
    --enable-protocol=file --enable-demuxer=mov,matroska --enable-muxer=mp4,mov,webm \
  && make -j"$(nproc)" ffmpeg ffprobe \
  && install -s ffmpeg ffprobe /usr/local/bin/ \
  && ldd /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
  && ! ldd /usr/local/bin/ffmpeg /usr/local/bin/ffprobe | grep -q "not found"

# The files both images carry, one copy of the layout: the repository files the runtime needs, and the data folder.
FROM scratch AS app
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
COPY --from=build /app/packages/provider-sdk/package.json /app/packages/provider-sdk/package.json
COPY --from=build /app/packages/provider-sdk/dist /app/packages/provider-sdk/dist
COPY --from=build /app/packages/provider-sdk/node_modules /app/packages/provider-sdk/node_modules
COPY --from=build /app/packages/provider-registry/package.json /app/packages/provider-registry/package.json
COPY --from=build /app/packages/provider-registry/dist /app/packages/provider-registry/dist
COPY --from=build /app/packages/provider-registry/node_modules /app/packages/provider-registry/node_modules
COPY --from=build /app/packages/providers/mastodon/package.json /app/packages/providers/mastodon/package.json
COPY --from=build /app/packages/providers/mastodon/dist /app/packages/providers/mastodon/dist
COPY --from=build /app/packages/providers/mastodon/node_modules /app/packages/providers/mastodon/node_modules
COPY --from=build /data /data

# The debug image, for support only (a release builds it with `--target debug`): the same files on the distroless
# debug variant, which adds a busybox shell. Node 26.13.0 on Debian 13, the debug build of the same distroless source
# commits as the default image below (`node --version` prints v26.13.0 in both); uploaded 2026-10-31T23:45:59Z per the
# registry's tag list. Index digest read 2026-11-20.
FROM gcr.io/distroless/nodejs26-debian13:debug-nonroot@sha256:cbe836227180a05575ec5d3c7075df4ea73649ead0df6be06e92d34586d248c8 AS debug
ARG SHOUTORY_RELEASE_CHANNEL
WORKDIR /app
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=app /app /app
COPY --from=app --chown=nonroot:nonroot /data /data
ENV TZ=UTC
ENV SHOUTORY_RELEASE_CHANNEL=${SHOUTORY_RELEASE_CHANNEL}
ENV SHOUTORY_WEB_ROOT=/app/apps/web/dist/client
ENV SHOUTORY_FFPROBE_PATH=/usr/local/bin/ffprobe
ENV SHOUTORY_FFMPEG_PATH=/usr/local/bin/ffmpeg
ENV NODE_ENV=production
USER nonroot
VOLUME /data
ENTRYPOINT ["/nodejs/bin/node", "--import", "/app/apps/api/dist/telemetry/preload.js", "/app/apps/api/dist/main.js"]

# Distroless Node 26.13.0 on Debian 13, the nonroot variant, built from its source commit of 2026-11-02 (the image config
# carries no date). Index digest read 2026-11-20.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:9b945e92c1b5463a4b75f11e8417515e4bea7355f6adfd79ec220fbbe905dda8
ARG SHOUTORY_RELEASE_CHANNEL
WORKDIR /app
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=app /app /app
COPY --from=app --chown=nonroot:nonroot /data /data
ENV TZ=UTC
ENV SHOUTORY_RELEASE_CHANNEL=${SHOUTORY_RELEASE_CHANNEL}
ENV SHOUTORY_WEB_ROOT=/app/apps/web/dist/client
ENV SHOUTORY_FFPROBE_PATH=/usr/local/bin/ffprobe
ENV SHOUTORY_FFMPEG_PATH=/usr/local/bin/ffmpeg
ENV NODE_ENV=production
USER nonroot
VOLUME /data
ENTRYPOINT ["/nodejs/bin/node", "--import", "/app/apps/api/dist/telemetry/preload.js", "/app/apps/api/dist/main.js"]
