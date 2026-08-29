import os
import secrets
import datetime
import logging
import requests
from functools import wraps
from flask import Flask, jsonify, request, send_from_directory, render_template, render_template_string, redirect, url_for, session

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("brain-service")

app = Flask(__name__)

# Authentication & Session Settings
app.secret_key = os.environ.get("FLASK_SECRET", secrets.token_hex(32))
ADMIN_PASS = os.environ.get("ADMIN_PASS", "apotheosis-secure")
app.permanent_session_lifetime = datetime.timedelta(minutes=30)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GO_INVENTORY_URL = os.getenv("GO_INVENTORY_URL", "http://127.0.0.1:8080/api/v1/inventory")

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
        if provided_pass == ADMIN_PASS:
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
    try:
        res = requests.get(GO_INVENTORY_URL, timeout=3)
        return (res.content, res.status_code, [("Content-Type", "application/json")])
    except Exception as e:
        logger.error(f"Failed to fetch inventory from local Go operator: {e}")
        return jsonify({"error": f"Failed to reach local Go operator: {str(e)}", "operators": []}), 502

@app.route('/help')
@requires_auth
def help_page():
    return render_template('help.html')

@app.route('/features')
@requires_auth
def features_page():
    return render_template('features.html')

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
    
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5005, debug=True)