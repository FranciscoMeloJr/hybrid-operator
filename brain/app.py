import json
import logging
import re
import threading
import time
import os
import requests
from typing import Any, Dict, List, Tuple

from flask import Flask, jsonify, request
from kubernetes import client, config
from kubernetes.client.rest import ApiException
import numpy as np

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("brain-service")
app = Flask(__name__)

# =============================================================================
# 1. STATE & STORAGE
# =============================================================================
pod_history: Dict[str, List[float]] = {}
MEMORY_LIMIT_MB = 512  # Memory threshold to predict against

# Global cache for the latest OLM inventory evaluated in Python
evaluated_olm_inventory: List[Dict[str, Any]] = []

# =============================================================================
# 2. HELPER FUNCTIONS & SEMVER PARSING
# =============================================================================
def parse_semver(version_str: str) -> Tuple[int, int, int]:
    """Extracts major.minor.patch integers from version string."""
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", str(version_str))
    if match:
        return tuple(map(int, match.groups()))
    return (0, 0, 0)

# =============================================================================
# 3. KUBERNETES OLM DISCOVERY (Python-native via CustomObjectsApi)
# =============================================================================
def collect_and_evaluate_olm_inventory():
    """Reads Subscriptions & PackageManifests using standard Kubernetes API client."""
    global evaluated_olm_inventory
    
    try:
        config.load_incluster_config()
    except Exception:
        try:
            config.load_kube_config()
        except Exception as e:
            logger.warning(f"Could not load kubeconfig: {e}")
            return

    custom_api = client.CustomObjectsApi()
    
    try:
        # 1. Fetch all OLM Subscriptions across the cluster
        subs = custom_api.list_cluster_custom_object(
            group="operators.coreos.com",
            version="v1alpha1",
            plural="subscriptions"
        )
        
        inventory = []
        for item in subs.get("items", []):
            spec = item.get("spec", {})
            status = item.get("status", {})
            metadata = item.get("metadata", {})
            
            pkg_name = spec.get("name") or spec.get("packageName")
            channel = spec.get("channel", "")
            namespace = metadata.get("namespace", "openshift-operators")
            installed_csv = status.get("installedCSV", "")
            current_version_str = status.get("currentCSV", "")
            
            # Extract semver string from CSV name if needed (e.g., 'my-op.v1.2.3' -> '1.2.3')
            installed_ver = parse_semver(installed_csv)
            installed_ver_str = f"{installed_ver[0]}.{installed_ver[1]}.{installed_ver[2]}"
            
            target_csv = ""
            target_ver_str = installed_ver_str
            can_upgrade = False
            upgrade_type = "NONE"

            # 2. Query PackageManifest for target head in channel
            if pkg_name:
                try:
                    pkg_manifest = custom_api.get_namespaced_custom_object(
                        group="packages.operators.coreos.com",
                        version="v1",
                        namespace=namespace,
                        plural="packagemanifests",
                        name=pkg_name
                    )
                    
                    channels = pkg_manifest.get("status", {}).get("channels", [])
                    target_ch = next((ch for ch in channels if ch.get("name") == channel), None)
                    
                    if target_ch:
                        csv_desc = target_ch.get("currentCSVDesc", {})
                        target_csv = csv_desc.get("name", "")
                        raw_target_ver = csv_desc.get("version", "")
                        
                        target_v = parse_semver(raw_target_ver or target_csv)
                        target_ver_str = f"{target_v[0]}.{target_v[1]}.{target_v[2]}"

                        if target_v > installed_ver:
                            can_upgrade = True
                            if target_v[0] > installed_ver[0]:
                                upgrade_type = "MAJOR"
                            elif target_v[1] > installed_ver[1]:
                                upgrade_type = "MINOR"
                            else:
                                upgrade_type = "PATCH"
                                
                except ApiException as e:
                    logger.debug(f"Could not fetch PackageManifest '{pkg_name}': {e.reason}")

            inventory.append({
                "subscription": metadata.get("name"),
                "package": pkg_name,
                "namespace": namespace,
                "channel": channel,
                "installed_csv": installed_csv,
                "installed_version": installed_ver_str,
                "target_csv": target_csv,
                "target_version": target_ver_str,
                "can_upgrade": can_upgrade,
                "upgrade_type": upgrade_type
            })

        evaluated_olm_inventory = inventory
        logger.info(f"[DISCOVERY] Evaluated {len(inventory)} OLM Subscriptions via Python K8s Client.")

    except Exception as e:
        logger.error(f"[DISCOVERY ERROR] Failed to run OLM evaluation: {e}")

def background_discovery_loop():
    """Runs OLM evaluation loop every 30 seconds."""
    while True:
        collect_and_evaluate_olm_inventory()
        time.sleep(30)

# =============================================================================
# 4. REST API ENDPOINTS
# =============================================================================

# A. Pod Memory Telemetry (Workload Predictive Analysis)
@app.route('/api/telemetry', methods=['POST'])
def receive_telemetry():
    data = request.json or {}
    pod_name = data.get('pod_name')
    current_mem = data.get('memory_mb')
    
    if not pod_name or current_mem is None:
        return jsonify({"error": "Invalid telemetry payload"}), 400

    if pod_name not in pod_history:
        pod_history[pod_name] = []
    
    pod_history[pod_name].append(current_mem)
    if len(pod_history[pod_name]) > 5:
        pod_history[pod_name].pop(0)

    history = pod_history[pod_name]
    action = "NONE"
    reason = "Normal operating parameters"

    if len(history) >= 3:
        x = np.arange(len(history))
        y = np.array(history)
        slope, _ = np.polyfit(x, y, 1)
        if slope > 0:
            projected_mem = history[-1] + slope
            if projected_mem > MEMORY_LIMIT_MB:
                action = "RESTART_PROACTIVE"
                reason = f"Memory leak projected ({projected_mem:.1f}MB exceeds limit of {MEMORY_LIMIT_MB}MB)."

    return jsonify({"action": action, "reason": reason}), 200

# B. Catalog Targets & Upgrade Eligibility
@app.route('/api/v1/catalog/targets', methods=['GET'])
def get_catalog_targets():
    # Attempt to proxy to the richer Go Operator Backend data first
    try:
        go_url = os.environ.get("GO_INVENTORY_URL", "http://127.0.0.1:8080/api/v1/inventory")
        resp = requests.get(go_url, timeout=5)
        if resp.status_code == 200:
            return jsonify(resp.json()), 200
    except Exception as e:
        logger.error(f"[PROXY ERROR] Could not reach Go sensor at {go_url}: {e}")
        
    # Fallback to the Python memory cache if the Go Sensor is unreachable
    upgradeable = [op for op in evaluated_olm_inventory if op.get("can_upgrade")]
    return jsonify({
        "total": len(evaluated_olm_inventory),
        "upgradeable_count": len(upgradeable),
        "operators": evaluated_olm_inventory
    }), 200

# C. Brain Context / Debug Endpoint
@app.route('/api/brain-context', methods=['GET'])
def get_brain_context():
    return jsonify({
        "pod_memory_histories": pod_history,
        "operator_inventory": evaluated_olm_inventory
    }), 200

# =============================================================================
# 5. ENTRYPOINT
# =============================================================================
if __name__ == '__main__':
    # Start Python background discovery loop
    thread = threading.Thread(target=background_discovery_loop, daemon=True)
    thread.start()
    
    app.run(host='0.0.0.0', port=5005)