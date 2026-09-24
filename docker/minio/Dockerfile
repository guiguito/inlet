# The object store of the bundled deployment: MinIO's last community release, built from
# its archived AGPL source (github.com/minio/minio).
#
# MinIO withdrew its community distribution on September 11, 2026: the minio/minio images
# left Docker Hub and dl.min.io answers 410 Gone. Rather than pin a stranger's rebuild,
# Inlet builds and publishes its own, from this file, as ghcr.io/guiguito/inlet-minio
# (.github/workflows/minio-image.yml). A stopgap: the source is no longer maintained, so no
# security fixes will come. It is reachable only on the compose network, and replacing it
# with a maintained S3 server is tracked in docs/DECISIONS.md section 30.
#
# Same interface as the image it replaces: `minio server /data`, root, data in /data, so an
# existing miniodata volume keeps working. The healthcheck uses MinIO's own liveness route
# because the `mc` client it used to call is gone as well.
ARG MINIO_TAG=RELEASE.2025-10-15T17-29-55Z

FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
ARG MINIO_TAG
ARG TARGETOS
ARG TARGETARCH
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "$MINIO_TAG" https://github.com/minio/minio.git /src
WORKDIR /src
# MinIO's own version stamping, so `minio --version` and the server banner name the release.
RUN LDFLAGS="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go)" \
 && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath -tags kqueue -ldflags "$LDFLAGS -s -w" -o /out/minio .

FROM alpine:3.22
ARG MINIO_TAG
LABEL org.opencontainers.image.source="https://github.com/guiguito/inlet" \
      org.opencontainers.image.description="MinIO ${MINIO_TAG}, built from its archived source for Inlet's bundled deployment" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${MINIO_TAG}"
RUN apk add --no-cache ca-certificates
COPY --from=build /out/minio /usr/bin/minio
EXPOSE 9000 9001
VOLUME ["/data"]
HEALTHCHECK --interval=5s --timeout=5s --retries=30 CMD wget -q --spider http://127.0.0.1:9000/minio/health/live || exit 1
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
