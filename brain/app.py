# brain.py
from flask import Flask, request, jsonify
import numpy as np
import threading
import time
from kubernetes import client, config
from kubernetes.client.rest import ApiException

app = Flask(__name__)

# Simple in-memory database to store rolling telemetry history per pod
pod_history = {}
MEMORY_LIMIT_MB = 512  # Threshold we want to predict against

# Global variable to store the latest cluster snapshot
cluster_snapshot = {"status": "UNKNOWN", "nodes": [], "unhealthy_pods": []}

def monitor_cluster_status():
    """Background loop that connects directly to OpenShift to pull cluster health."""
    print("[INIT] Starting background cluster visibility thread...")
    try:
        # Tries to load the same config your local 'oc' or 'kubectl' command uses
        config.load_kube_config()
    except Exception as e:
        print(f"[ERROR] Could not load kubeconfig: {e}")
        print("[WARN] External brain running without active cluster visibility.")
        return

    v1 = client.CoreV1Api()

    while True:
        try:
            nodes_health = []
            unhealthy_pods = []
            cluster_healthy = True

            # 1. Inspect Node Statuses
            nodes = v1.list_node(timeout_seconds=5)
            for node in nodes.items:
                # Find the 'Ready' condition status
                ready_status = next((c.status for c in node.status.conditions if c.type == 'Ready'), 'Unknown')
                nodes_health.append({"name": node.metadata.name, "ready": ready_status})
                if ready_status != "True":
                    cluster_healthy = False

            # 2. Inspect Pod Statuses across your target namespace
            target_namespace = "eap-helm"
            pods = v1.list_namespaced_pod(namespace=target_namespace, timeout_seconds=5)
            for pod in pods.items:
                if pod.status.phase not in ["Running", "Succeeded"]:
                    unhealthy_pods.append({
                        "name": pod.metadata.name,
                        "phase": pod.status.phase,
                        "message": pod.status.message or "Check logs/events"
                    })

            # Update our global memory cache
            global cluster_snapshot
            cluster_snapshot = {
                "status": "HEALTHY" if (cluster_healthy and len(unhealthy_pods) == 0) else "DEGRADED",
                "nodes": nodes_health,
                "unhealthy_pods": unhealthy_pods,
                "last_updated": time.strftime("%Y-%m-%d %H:%M:%S")
            }

            print(f"[CLUSTER VISIBILITY] Status: {cluster_snapshot['status']} | Active Nodes: {len(nodes_health)} | Unhealthy Pods in '{target_namespace}': {len(unhealthy_pods)}")

        except ApiException as e:
            print(f"[CLUSTER VISIBILITY ERROR] Failed to fetch OCP state: {e}")
        except Exception as e:
            print(f"[CLUSTER VISIBILITY ERROR] Unexpected error: {e}")

        time.sleep(15)  # Poll the cluster API every 15 seconds

@app.route('/api/telemetry', methods=['POST'])
def receive_telemetry():
    data = request.json
    pod_name = data.get('pod_name')
    current_mem = data.get('memory_mb')  # Current memory in MB
    
    if not pod_name or current_mem is None:
        return jsonify({"error": "Invalid telemetry payload"}), 400

    # Maintain a sliding window of the last 5 data points
    if pod_name not in pod_history:
        pod_history[pod_name] = []
    pod_history[pod_name].append(current_mem)
    if len(pod_history[pod_name]) > 5:
        pod_history[pod_name].pop(0)

    history = pod_history[pod_name]
    action = "NONE"
    reason = "Normal operating parameters"

    # If we have enough data points, calculate the trajectory
    if len(history) >= 3:
        x = np.arange(len(history))
        y = np.array(history)
        slope, intercept = np.polyfit(x, y, 1)

        # If the slope is positive, predict future usage
        if slope > 0:
            projected_mem_next_cycle = history[-1] + slope
            if projected_mem_next_cycle > MEMORY_LIMIT_MB:
                action = "RESTART_PROACTIVE"
                reason = f"Memory leak projected. Next cycle expected {projected_mem_next_cycle:.1f}MB, exceeding limit of {MEMORY_LIMIT_MB}MB."

    print(f"[BRAIN] Pod: {pod_name} | History: {history} | Action Decision: {action}")
    return jsonify({
        "action": action, 
        "reason": reason,
        "global_cluster_status": cluster_snapshot["status"]
    }), 200

# Endpoint to let you check what the brain sees from a browser or curl command
@app.route('/api/brain-context', methods=['GET'])
def get_brain_context():
    return jsonify({
        "telemetry_memory_histories": pod_history,
        "cluster_view": cluster_snapshot
    }), 200

if __name__ == '__main__':
    # Spin up the OpenShift monitoring loop in a background thread
    bg_thread = threading.Thread(target=monitor_cluster_status, daemon=True)
    bg_thread.start()
    
    # Runs outside OCP on port 5005
    app.run(host='0.0.0.0', port=5005)