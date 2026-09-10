const http = require("http");

http
  .createServer((req, res) => {
    res.write("App is running in the background!");
    res.end();
  })
  .listen(3000);

console.log("Background keep-alive server initiated.");

import { bootstrap } from "@mercuryworkshop/proxy-bootstrap";
import http from "node:http";
import express from "express";

const { routeRequest, routeUpgrade } = await bootstrap();

const app = express();

// Force Express to parse raw URL form submission inputs natively
app.use(express.urlencoded({ extended: true }));

// Grabs your secret password directly from your Replit project configurations
const SECURE_PASSWORD = process.env.APP_PASSWORD;

// Custom dark-themed prompt gateway template layout
const LOCKED_PAGE_HTML = `
<!DOCTYPE html>
<html>
<head>
		<title>Password Required</title>
		<style>
				body { font-family: sans-serif; background: #121212; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
				.box { background: #1e1e1e; padding: 30px; border-radius: 8px; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.3); width: 300px; }
				h3 { margin-top: 0; font-weight: 500; }
				input[type="password"] { padding: 12px; width: 85%; margin-bottom: 15px; border-radius: 6px; border: 1px solid #333; background: #2a2a2a; color: white; text-align: center; font-size: 16px; }
				input[type="submit"] { background: #0070f3; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-weight: bold; width: 93%; font-size: 15px; }
				input[type="submit"]:hover { background: #0051b3; }
		</style>
</head>
<body>
		<div class="box">
				<h3>App is Locked</h3>
				<form method="POST" action="/app-login-verify">
						<input type="password" name="typed_pwd" placeholder="Enter Password" required><br>
						<input type="submit" value="Unlock App">
				</form>
		</div>
</body>
</html>`;

// The exact endpoint checking manual browser form submissions
app.post("/app-login-verify", (req, res) => {
  if (req.body.typed_pwd === SECURE_PASSWORD) {
    // Sets a cookie so the proxy engine recognizes you on follow-up requests
    res.cookie("app_session_id", SECURE_PASSWORD, {
      httpOnly: true,
      path: "/",
    });
    return res.redirect("/");
  }
  // DEFINITELY blocks them if the password is wrong
  res.writeHead(403, { "Content-Type": "text/html" });
  res.end(
    "<h1 style='color:#ff3333; font-family:sans-serif; text-align:center; margin-top:20vh;'>Access Denied: Incorrect Password</h1>",
  );
});

app.use(express.static("public"));

// THE MASTER INTERCEPT ENGINE (Catches data before Mercury Workshop can see it)
const server = http.createServer((req, res) => {
  // 1. Always let the password checker endpoint process data via Express
  if (req.url === "/app-login-verify") {
    return app(req, res);
  }

  // 2. Python Script Bypass: Check for the script header key
  const hasValidHeader = req.headers["x-app-password"] === SECURE_PASSWORD;

  // 3. Browser Session Verification: Explicitly parse the raw cookies
  const hasValidCookie =
    req.headers.cookie &&
    req.headers.cookie.includes(`app_session_id=${SECURE_PASSWORD}`);

  if (hasValidHeader || hasValidCookie) {
    // Hand execution off to the proxy framework ONLY if authenticated!
    if (routeRequest(req, res)) return;
    return app(req, res);
  }

  // 4. FORCE BLOCK UNKNOWN USERS - Return the login dashboard prompt
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(LOCKED_PAGE_HTML);
});

// Blocks unauthorized background WebSocket proxy stream loops
server.on("upgrade", (req, socket, head) => {
  const hasValidHeader = req.headers["x-app-password"] === SECURE_PASSWORD;
  const hasValidCookie =
    req.headers.cookie &&
    req.headers.cookie.includes(`app_session_id=${SECURE_PASSWORD}`);

  if (hasValidHeader || hasValidCookie) {
    routeUpgrade(req, socket, head);
  } else {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
  }
});

server.listen(3030, () => {
  console.log("App safely locked down on port 3030.");
});
