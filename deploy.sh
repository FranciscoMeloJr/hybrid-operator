#!/usr/bin/env bash
set -e

# ==============================================================================
# Global Variables
# ==============================================================================
NAMESPACE="hybrid-apps"
BRANCH_NAME="feat/multi-container-pod"
TARGET_NODE="worker-node-redacted"

# ==============================================================================
# Function: setup_git_branch
# ==============================================================================
setup_git_branch() {
    if git rev-parse --verify "$BRANCH_NAME" >/dev/null 2>&1; then
        echo "--> Switching to existing branch: $BRANCH_NAME"
        git checkout "$BRANCH_NAME"
    else
        echo "--> Creating new branch: $BRANCH_NAME"
        git checkout -b "$BRANCH_NAME"
    fi
}

# ==============================================================================
# Function: setup_namespace_and_rbac
# ==============================================================================
setup_namespace_and_rbac() {
    oc get project "$NAMESPACE" >/dev/null 2>&1 || oc new-project "$NAMESPACE"

    cat <<EOF | oc apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: hybrid-intelligent-operator-sa
  namespace: ${NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: hybrid-intelligent-operator-role
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "delete"]
  - apiGroups: ["operators.coreos.com", "packages.operators.coreos.com"]
    resources: ["subscriptions", "clusterserviceversions", "packagemanifests"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: hybrid-intelligent-operator-binding
subjects:
  - kind: ServiceAccount
    name: hybrid-intelligent-operator-sa
    namespace: ${NAMESPACE}
roleRef:
  kind: ClusterRole
  name: hybrid-intelligent-operator-role
  apiGroup: rbac.authorization.k8s.io
EOF
}

# ==============================================================================
# Function: setup_buildconfigs (BUMPED RESOURCES for faster compilation)
# ==============================================================================
setup_buildconfigs() {
    oc delete bc hybrid-operator -n "$NAMESPACE" --ignore-not-found
    oc delete bc dashboard -n "$NAMESPACE" --ignore-not-found

    cat <<EOF | oc apply -f -
apiVersion: image.openshift.io/v1
kind: ImageStream
metadata:
  name: hybrid-operator
  namespace: ${NAMESPACE}
---
apiVersion: image.openshift.io/v1
kind: ImageStream
metadata:
  name: dashboard
  namespace: ${NAMESPACE}
---
apiVersion: build.openshift.io/v1
kind: BuildConfig
metadata:
  name: hybrid-operator
  namespace: ${NAMESPACE}
spec:
  nodeSelector:
    kubernetes.io/hostname: ${TARGET_NODE}
  source:
    type: Binary
  strategy:
    type: Docker
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: "1"
      memory: 1Gi
  output:
    to:
      kind: ImageStreamTag
      name: hybrid-operator:latest
---
apiVersion: build.openshift.io/v1
kind: BuildConfig
metadata:
  name: dashboard
  namespace: ${NAMESPACE}
spec:
  nodeSelector:
    kubernetes.io/hostname: ${TARGET_NODE}
  source:
    type: Binary
  strategy:
    type: Docker
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: "1"
      memory: 1Gi
  output:
    to:
      kind: ImageStreamTag
      name: dashboard:latest
EOF
}

# ==============================================================================
# Function: deploy_application
# ==============================================================================
deploy_application() {
    cat <<EOF | oc apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: console-hybrid-app
  namespace: ${NAMESPACE}
  labels:
    app: console-hybrid-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: console-hybrid-app
  template:
    metadata:
      labels:
        app: console-hybrid-app
    spec:
      serviceAccountName: hybrid-intelligent-operator-sa
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: kubernetes.io/hostname
                    operator: In
                    values:
                      - ${TARGET_NODE}
      containers:
        # Container 1: Go Operator Engine
        - name: go-operator
          image: image-registry.openshift-image-registry.svc:5000/${NAMESPACE}/hybrid-operator:latest
          imagePullPolicy: Always
          resources:
            requests:
              cpu: 100m
              memory: 128Mi

        # Container 2: Python Web Console
        - name: web-dashboard
          image: image-registry.openshift-image-registry.svc:5000/${NAMESPACE}/dashboard:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 5005
              name: http
          env:
            - name: GO_INVENTORY_URL
              value: "http://127.0.0.1:8080/api/v1/inventory"
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
---
apiVersion: v1
kind: Service
metadata:
  name: console-hybrid-app
  namespace: ${NAMESPACE}
spec:
  selector:
    app: console-hybrid-app
  ports:
    - name: http
      port: 5005
      targetPort: 5005
---
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: console-hybrid-app
  namespace: ${NAMESPACE}
spec:
  to:
    kind: Service
    name: console-hybrid-app
  port:
    targetPort: http
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
EOF
}

# ==============================================================================
# Function: build_images_and_wait
# ==============================================================================
build_images_and_wait() {
    echo "--> Starting Go Operator container build (in background)..."
    oc start-build hybrid-operator --from-dir=./operator --follow -n "$NAMESPACE" &
    PID_OPERATOR=$!

    echo "--> Starting Web Dashboard container build (in background)..."
    oc start-build dashboard --from-dir=./dashboard --follow -n "$NAMESPACE" &
    PID_DASHBOARD=$!

    echo "--> Waiting for both builds to complete..."
    wait $PID_OPERATOR
    wait $PID_DASHBOARD
    echo "--> Both builds completed successfully!"
}

# ==============================================================================
# Function: verify_rollout
# ==============================================================================
verify_rollout() {
    # Force a rollout restart to bypass any Kubelet ImagePullBackOff timers 
    # that started while the deployment was waiting for the builds to finish
    echo "--> Triggering fresh rollout to pick up newly built images..."
    oc rollout restart deployment/console-hybrid-app -n "$NAMESPACE"

    oc rollout status deployment/console-hybrid-app -n "$NAMESPACE"

    ROUTE_URL=$(oc get route console-hybrid-app -n "$NAMESPACE" -o jsonpath='{.spec.host}')

    echo ""
    echo "=================================================="
    echo " Deployment Complete!"
    echo " Both 'go-operator' and 'web-dashboard' are running in 1 Pod."
    echo " Web Console URL: https://${ROUTE_URL}"
    echo "=================================================="
}

# ==============================================================================
# Main Execution Flow
# ==============================================================================
main() {
    echo "=================================================="
    echo " 1. Git Branch Setup"
    echo "=================================================="
    setup_git_branch

    echo "=================================================="
    echo " 2. Namespace & RBAC Setup"
    echo "=================================================="
    setup_namespace_and_rbac

    echo "=================================================="
    echo " 3. Re-creating BuildConfigs with Elevated Resources"
    echo "=================================================="
    setup_buildconfigs

    echo "=================================================="
    echo " 4. Applying Multi-Container Pod Deployment First"
    echo "=================================================="
    # Deploying now stages the infrastructure while builds process
    deploy_application

    echo "=================================================="
    echo " 5. Building Images (Parallel)"
    echo "=================================================="
    build_images_and_wait

    echo "=================================================="
    echo " 6. Verifying Deployment Rollout"
    echo "=================================================="
    verify_rollout
}

# Execute script
main "$@"