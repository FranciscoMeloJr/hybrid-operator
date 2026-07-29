# ==========================================
# STAGE 1: Build the Go Operator Binary
# ==========================================
FROM golang:1.25-alpine AS builder

WORKDIR /app

# Leverage caching for dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy full source tree (including pkg/ directory)
COPY . .

# Compile static binary with stripped symbol tables
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o hybrid-operator main.go

# ==========================================
# STAGE 2: Secure Runtime Deployment
# ==========================================
FROM alpine:3.19

# Install trusted CA certs for outbound TLS/HTTPS calls to the telemetry brain
RUN apk --no-cache add ca-certificates

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/hybrid-operator /app/hybrid-operator

# OpenShift arbitrary UID compatibility (Group 0 permissions)
RUN chmod +x /app/hybrid-operator && \
    chgrp -R 0 /app && \
    chmod -R g=u /app

# Run as non-root (OpenShift will override UID dynamically anyway)
USER 10001

ENTRYPOINT ["/app/hybrid-operator"]