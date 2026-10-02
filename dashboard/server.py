import os
import hashlib
import hmac
import json
import datetime
import logging
import requests
from functools import wraps
from urllib.parse import urlsplit
from flask import Flask, jsonify, request, send_from_directory, render_template, render_template_string, redirect, url_for, session, make_response

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("brain-service")

app = Flask(__name__)

# Authentication & Session Settings
# Both secrets are required; fail closed rather than shipping a known default
# password / an ephemeral session key that silently invalidates sessions.
app.secret_key = os.environ.get("FLASK_SECRET")
ADMIN_PASS = os.environ.get("ADMIN_PASS")
if not app.secret_key or not ADMIN_PASS:
    raise RuntimeError(
        "FLASK_SECRET and ADMIN_PASS environment variables are required. "
        "Provide them via the deployment Secret (deploy-helm.sh) or a local .env file."
    )
app.permanent_session_lifetime = datetime.timedelta(minutes=30)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GO_INVENTORY_URL = os.getenv("GO_INVENTORY_URL", "http://127.0.0.1:8080/api/v1/inventory")
NSAA_DEFAULT_ENDPOINT = os.getenv("NSAA_ENDPOINT_URL", "http://nsaa-agent-service.nsaa-system.svc:8000/api/v1/telemetry")

# Base URL of the in-pod Go operator API (same host/port as the inventory feed).
# The Go operator serves action/resource/dependency endpoints on 127.0.0.1:8080
# but is not exposed externally, so the dashboard proxies to it.
_inv = urlsplit(GO_INVENTORY_URL)
OPERATOR_BASE_URL = os.getenv("GO_OPERATOR_URL", f"{_inv.scheme}://{_inv.netloc}")

# Build / version metadata. APP_GIT_SHA and APP_BUILD_TIME are stamped into the
# image at build time (Dockerfile ARG -> ENV, populated by the deploy scripts);
# they default to "unknown" for local runs. Exposed via /version and in the UI
# header so a running deployment can be matched to the exact source it was built
# from. Bump APP_VERSION on releases (or override via the APP_VERSION env var).
APP_VERSION = os.getenv("APP_VERSION", "1.8.0-beta")
GIT_SHA = os.getenv("APP_GIT_SHA", "unknown")
BUILD_TIME = os.getenv("APP_BUILD_TIME", "unknown")


@app.context_processor
def inject_build_metadata():
    """Makes build/version info available to every Jinja template."""
    return {"app_version": APP_VERSION, "git_sha": GIT_SHA, "build_time": BUILD_TIME}

# =============================================================================
# AUTHENTICATION MIDDLEWARE & LOGIN ROUTES
# =============================================================================
def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('logged_in'):
            client_ip = request.headers.get('X-Forwarded-For', request.remote_addr)
            logger.warning(f"Unauthorized access attempt to {request.path} from IP: {client_ip}")
            if request.path.startswith('/api/'):
                return jsonify({"error": "Unauthorized. Please log in first."}), 401
            return redirect(url_for('login'))
        session.permanent = True
        return f(*args, **kwargs)
    return decorated

LOGIN_TEMPLATE = '''
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hybrid Console - Authentication</title>
    <style>
        body { background: #0b0f19; color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: #111827; padding: 2.5rem; border-radius: 12px; border: 1px solid #1f2937; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); width: 100%; max-width: 380px; }
        h2 { margin-top: 0; color: #3b82f6; font-size: 1.5rem; text-align: center; }
        .error { background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; color: #f87171; padding: 10px; border-radius: 6px; font-size: 0.875rem; margin-bottom: 1rem; text-align: center; }
        input[type="password"] { width: 100%; padding: 12px; border-radius: 6px; border: 1px solid #374151; background: #1f2937; color: #fff; font-size: 1rem; box-sizing: border-box; margin-bottom: 1.5rem; }
        input[type="password"]:focus { outline: none; border-color: #3b82f6; }
        button { width: 100%; background: #2563eb; color: white; padding: 12px; border: none; border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #1d4ed8; }
    </style>
</head>
<body>
    <div class="card">
        <h2>Hybrid Console Login</h2>
        {% if error %}
            <div class="error">{{ error }}</div>
        {% endif %}
        <form method="post">
            <input type="password" name="password" placeholder="Enter Cluster Admin Password" required autofocus>
            <button type="submit">Authenticate</button>
        </form>
    </div>
</body>
</html>
'''

@app.route('/login', methods=['GET', 'POST'])
def login():
    client_ip = request.headers.get('X-Forwarded-For', request.remote_addr)
    if request.method == 'POST':
        provided_pass = request.form.get('password', '')
        if hmac.compare_digest(provided_pass, ADMIN_PASS):
            session['logged_in'] = True
            session['user'] = 'cluster-admin'
            session.permanent = True
            logger.info(f"SUCCESSFUL LOGIN from IP: {client_ip} as user: cluster-admin")
            return redirect('/')
        else:
            logger.warning(f"FAILED LOGIN ATTEMPT from IP: {client_ip} using invalid credentials")
            return render_template_string(LOGIN_TEMPLATE, error="Invalid credentials. Access denied."), 403

    return render_template_string(LOGIN_TEMPLATE, error=None)

@app.route('/logout')
def logout():
    user = session.get('user', 'unknown')
    client_ip = request.headers.get('X-Forwarded-For', request.remote_addr)
    logger.info(f"USER LOGOUT: {user} logged out from IP: {client_ip}")
    session.clear()
    return redirect(url_for('login'))

# =============================================================================
# UI ASSET ROUTING (NSAA Pattern) - PRESERVED EXACTLY AS BEFORE
# =============================================================================
@app.route("/")
@requires_auth
def index():
    """Serves the main dashboard HTML."""
    return render_template("index.html")

@app.route("/ui/<path:filename>")
def serve_ui_assets(filename):
    """Serves decoupled JS/CSS assets."""
    ui_dir = os.path.join(BASE_DIR, "ui")
    if os.path.exists(os.path.join(ui_dir, filename)):
        resp = send_from_directory(ui_dir, filename)
        resp.headers["Cache-Control"] = "no-store"
        return resp
    return jsonify({"error": "Asset not found"}), 404

@app.route('/api/v1/catalog/targets')
@requires_auth
def get_targets():
    force_refresh = request.args.get('refresh', 'false').lower() == 'true'
    try:
        res = requests.get(GO_INVENTORY_URL, timeout=3)
        if res.status_code == 200:
            try:
                raw_data = res.json()
                payload_str = json.dumps(raw_data, sort_keys=True)
                etag = hashlib.md5(payload_str.encode('utf-8')).hexdigest()
                
                if not force_refresh and request.headers.get('If-None-Match') == etag:
                    return '', 304
                    
                response = make_response(jsonify(raw_data))
                response.headers['ETag'] = etag
                response.headers['Cache-Control'] = 'private, no-cache'
                return response
            except Exception:
                pass

        return (res.content, res.status_code, [("Content-Type", "application/json")])
    except Exception as e:
        logger.error(f"Failed to fetch inventory from local Go operator: {e}")
        return jsonify({"error": f"Failed to reach local Go operator: {str(e)}", "operators": []}), 502

@app.route('/api/v1/nsaa/dispatch', methods=['POST'])
@requires_auth
def dispatch_to_nsaa():
    req_payload = request.get_json(silent=True) or {}
    # Target is fixed to the server-configured endpoint to prevent SSRF via a
    # client-supplied URL. Override only via the NSAA_ENDPOINT_URL env var.
    target_url = NSAA_DEFAULT_ENDPOINT
    http_method = req_payload.get('method', 'POST').upper()

    try:
        # Pull live local data first to ensure payload is current
        res = requests.get(GO_INVENTORY_URL, timeout=5)
        inventory_data = res.json() if res.status_code == 200 else {}
    except Exception as e:
        return jsonify({"error": f"Failed to fetch local inventory for dispatch: {str(e)}"}), 502

    try:
        if http_method == 'GET':
            nsaa_res = requests.get(target_url, params={"data": json.dumps(inventory_data)}, timeout=5)
        else:
            nsaa_res = requests.post(target_url, json=inventory_data, headers={"Content-Type": "application/json"}, timeout=5)

        logger.info(f"Dispatched telemetry to NSAA ({target_url}) - Status: {nsaa_res.status_code}")
        return jsonify({
            "status": "Success",
            "nsaa_status_code": nsaa_res.status_code,
            "target_url": target_url,
            "message": "Successfully forwarded governance JSON payload to NSAA."
        })
    except Exception as e:
        logger.error(f"Failed to dispatch telemetry to NSAA at {target_url}: {e}")
        return jsonify({"error": f"Failed to connect to NSAA endpoint: {str(e)}"}), 502

# =============================================================================
# OPERATOR API PROXY
# The Go operator serves these endpoints on 127.0.0.1:8080 (not externally
# routable). The frontend calls them on the dashboard origin, so we forward the
# same path through to the operator and relay its response. All require auth
# because several are mutating actions (approve / restart / delete).
# =============================================================================
def _proxy_to_operator():
    target = f"{OPERATOR_BASE_URL}{request.path}"
    try:
        if request.method == 'POST':
            resp = requests.post(target, json=request.get_json(silent=True) or {}, timeout=10)
        else:
            resp = requests.get(target, params=request.args, timeout=10)
    except Exception as e:
        logger.error(f"Operator proxy to {target} failed: {e}")
        return jsonify({"error": f"Failed to reach operator backend: {str(e)}"}), 502
    content_type = resp.headers.get('Content-Type', 'application/json')
    return (resp.content, resp.status_code, [("Content-Type", content_type)])

@app.route('/api/v1/actions/approve', methods=['POST'])
@app.route('/api/v1/actions/restart-pod', methods=['POST'])
@app.route('/api/v1/actions/delete', methods=['POST'])
@app.route('/api/v1/actions/change-channel', methods=['POST'])
@requires_auth
def proxy_operator_actions():
    return _proxy_to_operator()

@app.route('/api/v1/resources/subscription')
@app.route('/api/v1/resources/csv')
@app.route('/api/v1/resources/metrics')
@requires_auth
def proxy_operator_resources():
    return _proxy_to_operator()

@app.route('/api/v1/dependencies/graph')
@app.route('/api/v1/dependencies/impact/<path:operator>')
@requires_auth
def proxy_operator_dependencies(operator=None):
    return _proxy_to_operator()

@app.route('/api/v1/audit/events')
@requires_auth
def proxy_operator_audit():
    return _proxy_to_operator()

@app.route('/help')
@requires_auth
def help_page():
    return render_template('help.html')

@app.route('/features')
@requires_auth
def features_page():
    return render_template('features.html')

@app.route('/version')
def version():
    """Unauthenticated build marker for verifying the deployed image.
    Returns only non-sensitive build metadata (app version, git SHA, build time)
    so `curl https://<route>/version` confirms exactly which source is running."""
    return jsonify({
        "version": APP_VERSION,
        "git_sha": GIT_SHA,
        "build_time": BUILD_TIME,
    })

@app.route('/api/v1/remediate', methods=['POST'])
@requires_auth  # Uncomment if session authentication is enforced
def handle_remediation():
    data = request.get_json() or {}
    action = data.get('action')
    namespace = data.get('namespace')
    target = data.get('target')

    if not action or not namespace:
        return jsonify({"error": "Missing required fields: action and namespace"}), 400

    # Act as the decision routing API. 
    # For now, we simulate success for the UI implementation.
    # To enforce cluster-side changes, you can use the official python-kubernetes client here,
    # or forward the request to an internal listener on the Go Operator.
    
    return jsonify({
        "status": "Success",
        "action": action,
        "target": target,
        "message": f"Autonomous action '{action}' executed successfully on {target} in namespace {namespace}."
    })

@app.route('/api/v1/mock-nsaa', methods=['POST'])
def mock_nsaa_receiver():
    data = request.get_json() or {}
    logger.info("=== [MOCK NSAA RECEIVER] INCOMING TELEMETRY PAYLOAD ===")
    logger.info(json.dumps(data, indent=2))
    logger.info(f"Total Operators Received: {len(data.get('operators', []))}")
    logger.info("=====================================================")
    return jsonify({"status": "Received", "message": "Telemetry processed by mock agent"}), 200

if __name__ == '__main__':
    port = int(os.getenv("DASHBOARD_PORT", "5005"))
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"
    logger.info(f"Starting Hybrid Console v{APP_VERSION} (sha={GIT_SHA}, built={BUILD_TIME}) on port {port}")
    app.run(host='0.0.0.0', port=port, debug=debug)