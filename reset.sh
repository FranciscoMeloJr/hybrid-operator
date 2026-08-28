#!/usr/bin/env bash

NAMESPACE="hybrid-apps"

echo "=================================================="
echo " Initiating Environment Reset"
echo "=================================================="

echo "--> 1. Deleting Cluster-level RBAC (Roles & Bindings)..."
oc delete clusterrolebinding hybrid-intelligent-operator-binding --ignore-not-found
oc delete clusterrole hybrid-intelligent-operator-role --ignore-not-found

echo "--> 2. Deleting Application Resources (Deployments, Pods, Services, Routes)..."
oc delete deployment console-hybrid-app -n "$NAMESPACE" --ignore-not-found
oc delete svc console-hybrid-app -n "$NAMESPACE" --ignore-not-found
oc delete route console-hybrid-app -n "$NAMESPACE" --ignore-not-found
# Force delete any lingering/stuck pods to clear dead OVN interfaces
oc delete pods -l app=console-hybrid-app -n "$NAMESPACE" --force --grace-period=0 --ignore-not-found

echo "--> 3. Deleting Build Resources (BuildConfigs, ImageStreams, Builds)..."
oc delete bc hybrid-operator dashboard -n "$NAMESPACE" --ignore-not-found
oc delete is hybrid-operator dashboard -n "$NAMESPACE" --ignore-not-found
oc delete builds --all -n "$NAMESPACE"

echo "--> 4. Deleting Service Account..."
oc delete sa hybrid-intelligent-operator-sa -n "$NAMESPACE" --ignore-not-found

echo "=================================================="
echo " Reset Complete!"
echo " You can now run ./deploy.sh for a completely fresh start."
echo "=================================================="