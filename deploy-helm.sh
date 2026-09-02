#!/usr/bin/env bash
set -e

# ==============================================================================
# Global Defaults
# ==============================================================================
NAMESPACE="hybrid-apps"
BRANCH_NAME="feat/helm-chart"
CHART_PATH="./charts/hybrid-operator"
COMPONENT=""

# Load environment variables from .env
if [ -f .env ]; then
    echo "--> Loading configuration from .env file..."
    export $(grep -v '^#' .env | xargs)
else
    echo "--> ERROR: .env file not found!"
    exit 1
fi

if [ -z "$TARGET_NODE" ]; then
    echo "--> ERROR: TARGET_NODE is not defined in .env"
    exit 1
fi

# ==============================================================================
# Parse Command Line Flags
# ==============================================================================
usage() {
    echo "Usage: $0 [-n namespace] [-c component] [-h]"
    echo "  -n  Specify target namespace (default: hybrid-apps)"
    echo "  -c  Fast build specific component: 'dashboard' or 'hybrid-operator'"
    echo "  -h  Show this help message"
    exit 1
}

while getopts "n:c:h" opt; do
    case ${opt} in
        n ) NAMESPACE=$OPTARG ;;
        c ) COMPONENT=$OPTARG ;;
        h ) usage ;;
        ? ) usage ;;
    esac
done

# ==============================================================================
# Core Functions
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

deploy_helm_chart() {
    echo "--> Ensuring OpenShift project exists: ${NAMESPACE}"
    oc get project "$NAMESPACE" >/dev/null 2>&1 || oc new-project "$NAMESPACE"

    echo "--> Upgrading/Installing Helm release..."
    helm upgrade --install hybrid-operator "$CHART_PATH" \
      --namespace "$NAMESPACE" \
      --set targetNode="${TARGET_NODE}" \
      --set secrets.adminPass="${ADMIN_PASS}" \
      --set secrets.flaskSecret="${FLASK_SECRET}"
}

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

verify_rollout() {
    echo "--> Triggering fresh rollout to pick up newly built images..."
    oc rollout restart deployment/console-hybrid-app -n "$NAMESPACE"
    oc rollout status deployment/console-hybrid-app -n "$NAMESPACE"

    ROUTE_URL=$(oc get route console-hybrid-app -n "$NAMESPACE" -o jsonpath='{.spec.host}')
    
    echo ""
    echo "=================================================="
    echo " Helm Deployment Complete!"
    echo " Namespace: ${NAMESPACE}"
    echo " Web Console URL: https://${ROUTE_URL}"
    echo "=================================================="
}

# ==============================================================================
# Main Execution Flow
# ==============================================================================
if [ -z "$COMPONENT" ]; then
    echo "=================================================="
    echo " 1. Git Branch Setup"
    echo "=================================================="
    setup_git_branch

    echo "=================================================="
    echo " 2. Deploying Helm Chart ($NAMESPACE)"
    echo "=================================================="
    deploy_helm_chart

    echo "=================================================="
    echo " 3. Building Images (Parallel)"
    echo "=================================================="
    build_images_and_wait

    echo "=================================================="
    echo " 4. Verifying Deployment Rollout"
    echo "=================================================="
    verify_rollout

elif [ "$COMPONENT" == "dashboard" ] || [ "$COMPONENT" == "hybrid-operator" ]; then
    echo "=================================================="
    echo " Fast Build: $COMPONENT only ($NAMESPACE)"
    echo "=================================================="
    oc start-build "$COMPONENT" --from-dir="./${COMPONENT/hybrid-operator/operator}" --follow -n "$NAMESPACE"
    verify_rollout

else
    echo "ERROR: Invalid component specified."
    usage
fi