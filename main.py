import hmac
import os
import threading
import time
from collections import defaultdict

from flask import Flask, jsonify, render_template_string, request

from keep_alive import keep_alive

app = Flask(__name__)

# Retrieves your secret key password from Replit's background environment
SECRET_PASSWORD = os.environ.get("APP_PASSWORD")
PORT = int(os.environ.get("PORT", "8080"))

# Behind Replit's edge the socket address is the proxy's, so X-Forwarded-For is
# the only real client identity. Directly exposed, that header is
# attacker-controlled, so it is only trusted when a proxy is known to be there.
TRUST_PROXY = os.environ.get("TRUST_PROXY") == "1" or bool(
    os.environ.get("REPLIT_DEV_DOMAIN")
)

MAX_ATTEMPTS = 5
ATTEMPT_WINDOW_SECONDS = 5 * 60
MAX_PASSWORD_BYTES = 512

_attempts_lock = threading.Lock()
_attempts = defaultdict(lambda: [0, 0.0])


def client_address():
    if TRUST_PROXY:
        forwarded = request.headers.get("X-Forwarded-For", "")
        first = forwarded.split(",")[0].strip()
        if first:
            return first

    return request.remote_addr or "unknown"


def rate_limited(address):
    """Fixed window per address. Returns True when the caller is over budget."""
    now = time.monotonic()
    with _attempts_lock:
        # Drop expired windows here rather than on a timer: without eviction the
        # dict grew one permanent entry per source address seen.
        for key in [k for k, (_, reset) in _attempts.items() if reset <= now]:
            del _attempts[key]

        count, reset_at = _attempts[address]

        return reset_at > now and count >= MAX_ATTEMPTS


def record_attempt(address):
    now = time.monotonic()
    with _attempts_lock:
        count, reset_at = _attempts[address]
        if reset_at > now:
            _attempts[address] = [count + 1, reset_at]
        else:
            _attempts[address] = [1, now + ATTEMPT_WINDOW_SECONDS]


def clear_attempts(address):
    with _attempts_lock:
        _attempts.pop(address, None)


def passwords_match(supplied, expected):
    if not expected or supplied is None:
        return False
    # compare_digest raises TypeError on non-ASCII str input, so a password with
    # any accented character used to 500 instead of being rejected. Comparing
    # the UTF-8 bytes keeps it constant-time and total.
    supplied_bytes = supplied.encode("utf-8")
    if len(supplied_bytes) > MAX_PASSWORD_BYTES:
        return False

    return hmac.compare_digest(supplied_bytes, expected.encode("utf-8"))


@app.after_request
def secure_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    # Every response here is gate state; caching any of it risks serving one
    # visitor's unlocked page to the next.
    response.headers["Cache-Control"] = "no-store"

    return response


@app.route("/health")
def health():
    return jsonify({"status": "ok", "configured": bool(SECRET_PASSWORD)})


# Simple HTML login page layout for your web browser view
LOGIN_PAGE = """
<!DOCTYPE html>
<html>
<head>
    <title>Protected App</title>
    <style>
        body { font-family: sans-serif; background: #121212; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .login-box { background: #1e1e1e; padding: 30px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); text-align: center; }
        input[type="password"] { padding: 10px; width: 200px; border-radius: 4px; border: 1px solid #333; background: #2a2a2a; color: white; margin-bottom: 15px; text-align: center; }
        input[type="submit"] { background: #0070f3; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; }
        input[type="submit"]:hover { background: #0051b3; }
        .error { color: #ff3333; margin-top: 10px; font-size: 14px; }
    </style>
</head>
<body>
    <div class="login-box">
        <h3>App is Locked</h3>
        <form method="POST" action="/">
            <input type="password" name="browser_password" placeholder="Enter Password" required><br>
            <input type="submit" value="Unlock App">
        </form>
        {% if error %} <p class="error">{{ error }}</p> {% endif %}
    </div>
</body>
</html>
"""


@app.route("/", methods=["GET", "POST"])
def protect_root():
    # An unset APP_PASSWORD silently rejected every request, which looks
    # identical to a wrong password. Say so instead of leaving it a mystery.
    if not SECRET_PASSWORD:
        return (
            jsonify({"error": "APP_PASSWORD is not configured on this deployment."}),
            503,
        )

    address = client_address()
    if rate_limited(address):
        return (
            render_template_string(
                LOGIN_PAGE, error="Too many attempts. Try again shortly."
            ),
            429,
        )

    # 1. Handle Automatic Python Script Access (via Header Verification)
    incoming_header_password = request.headers.get("X-App-Password")
    if incoming_header_password is not None:
        if passwords_match(incoming_header_password, SECRET_PASSWORD):
            clear_attempts(address)

            return jsonify(
                {"status": "Success", "message": "Access granted to automation script."}
            )
        record_attempt(address)

        return jsonify({"error": "Access denied."}), 401

    # 2. Handle Manual Browser Access (via Form Password Submission)
    if request.method == "POST":
        incoming_browser_password = request.form.get("browser_password")
        if passwords_match(incoming_browser_password, SECRET_PASSWORD):
            clear_attempts(address)

            # Successfully authenticated via browser
            return "<h1>Access Granted</h1><p>You have unlocked the application session successfully.</p>"

        record_attempt(address)

        return render_template_string(LOGIN_PAGE, error="Incorrect Password!"), 401

    # 3. Default state when clicking the "Open in new tab" button
    return render_template_string(LOGIN_PAGE, error=None)


if __name__ == "__main__":
    # Started here rather than at import time so the module can be imported by a
    # WSGI server (gunicorn, etc.) without spawning a stray listener.
    keep_alive()
    # threaded=True so one slow client can't block every other request; the
    # single-threaded default made this trivially wedgeable.
    app.run(host="0.0.0.0", port=PORT, threaded=True)
