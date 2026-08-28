import os
from flask import Flask, jsonify, request, send_from_directory
import numpy as np
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("brain-service")

app = Flask(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# --- ALL YOUR EXISTING API ROUTES STAY HERE ---
# (@app.route('/api/telemetry', ...)
# (@app.route('/api/v1/catalog/targets', ...)

# =============================================================================
# UI ASSET ROUTING (NSAA Pattern)
# =============================================================================
@app.route("/")
def index():
    """Serves the main dashboard HTML[cite: 1]."""
    ui_dir = os.path.join(BASE_DIR, "ui")
    resp = send_from_directory(ui_dir, "index.html")
    resp.headers["Cache-Control"] = "no-store"
    return resp

@app.route("/ui/<path:filename>")
def serve_ui_assets(filename):
    """Serves decoupled JS/CSS assets[cite: 1]."""
    ui_dir = os.path.join(BASE_DIR, "ui")
    if os.path.exists(os.path.join(ui_dir, filename)):
        resp = send_from_directory(ui_dir, filename)
        resp.headers["Cache-Control"] = "no-store"
        return resp
    return jsonify({"error": "Asset not found"}), 404

@app.route('/api/v1/catalog/targets')
def get_targets():
    return jsonify({
        "operators": [
            {
                "subscription": "hybrid-intelligent-operator",
                "namespace": "hybrid-apps",
                "channel": "alpha",
                "canUpgrade": True,
                "installedVersion": "v1.0.0",
                "targetVersion": "v1.1.0"
            }
        ]
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5005)