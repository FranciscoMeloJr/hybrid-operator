# Stage 1: Build the Go binary
FROM registry.access.redhat.com/ubi9/go-toolset:latest AS builder
WORKDIR /workspace

# Fix permissions on workdir for unprivileged build execution
USER root
RUN chown -R 1001:0 /workspace && chmod -R g+rwX /workspace
USER 1001

# Copy Go module specs and source code
COPY --chown=1001:0 go.mod go.sum ./
RUN go mod download

COPY --chown=1001:0 main.go ./
COPY --chown=1001:0 api/ api/
COPY --chown=1001:0 pkg/ pkg/

# Build static binary into /tmp/manager
RUN CGO_ENABLED=0 GOOS=linux go build -a -o /tmp/manager main.go

# Stage 2: Minimal runtime image
FROM registry.access.redhat.com/ubi9/ubi-minimal:latest
WORKDIR /
COPY --from=builder /tmp/manager /manager

USER 65532:65532

ENTRYPOINT ["/manager"]