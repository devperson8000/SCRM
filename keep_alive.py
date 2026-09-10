import logging
import os
from threading import Thread

from flask import Flask

# Uptime-pinger target. This deliberately runs on its own port: it used to
# bind 8080, the same port main.py's app binds, so whichever started second
# died with EADDRINUSE — in practice the keep-alive thread won the race and
# the actual app never came up.
KEEP_ALIVE_PORT = int(os.environ.get("KEEP_ALIVE_PORT", "8081"))

app = Flask("keep_alive")

# The pinger hits this every few minutes; at Werkzeug's default log level that
# is pure noise drowning out the real app's request log.
logging.getLogger("werkzeug").setLevel(logging.WARNING)


@app.route("/")
def home():
    return "App is running in the background!"


@app.route("/health")
def health():
    return {"status": "ok"}, 200


def run():
    # use_reloader would fork a second process from a non-main thread, which
    # Werkzeug cannot do; it must stay off here.
    app.run(host="0.0.0.0", port=KEEP_ALIVE_PORT, use_reloader=False, threaded=True)


def keep_alive():
    # Non-daemon threads keep the interpreter alive after the main app exits,
    # so Ctrl-C left an orphan holding the port until it was killed by hand.
    t = Thread(target=run, name="keep_alive", daemon=True)
    t.start()

    return t
