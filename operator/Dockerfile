# ==========================================
# STAGE 1: Build the Go Operator Binary
# ==========================================
FROM golang:1.25-alpine AS builder

WORKDIR /app

# Leverage caching for dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source and compile optimization flags
COPY main.go .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o hybrid-operator main.go

# ==========================================
# STAGE 2: Secure Runtime Deployment
# ==========================================
FROM alpine:3.19

# Install base trusted certs for outbound TLS/HTTPS to the Flask brain
RUN apk --no-cache add ca-certificates

# Establish a neutral root-level path accessible to any arbitrary OpenShift UID
WORKDIR /app

# Bring binary over into the clean working directory
COPY --from=builder /app/hybrid-operator /app/hybrid-operator

# Ensure explicit execution rights are set on the binary
RUN chmod +x /app/hybrid-operator

# Execute using relative path syntax matching the new WORKDIR context
CMD ["./hybrid-operator"]