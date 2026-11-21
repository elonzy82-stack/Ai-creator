// MERLIN EXE pairing website + backend (no dependencies, Node 18+).
// Serves /public and runs one bot process (index.js) per visitor number.
//   node server.js        -> http://localhost:3000
// Env: PORT (3000), BOT_LIMIT (50)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = parseInt(process.env.PORT) || 3000;
const LIMIT = parseInt(process.env.BOT_LIMIT) || 50;
const BOT_SCRIPT = process.env.BOT_SCRIPT || path.join(__dirname, "index.js");
const SESSIONS = path.join(__dirname, "sessions");
const PUBLIC = path.join(__dirname, "public");
fs.mkdirSync(SESSIONS, { recursive: true });

const bots = new Map(); // number -> { child, linked, killTimer, onCode }

function startBot(num, { restored = false } = {}) {
  const dir = path.join(SESSIONS, num);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { child: null, linked: restored, killTimer: null, onCode: null };
  const child = spawn(process.execPath, [BOT_SCRIPT], {
    env: { ...process.env, BOT_NUMBER: num, AUTH_DIR: path.join(dir, "auth") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  entry.child = child;
  bots.set(num, entry);

  const onData = (buf) => {
    const text = buf.toString();
    const m = text.match(/pairing code:\s*([A-Z0-9-]{6,12})/i);
    if (m && entry.onCode) { entry.onCode(m[1]); entry.onCode = null; }
    if (/connected/i.test(text) && !/pairing/i.test(text)) {
      entry.linked = true;
      clearTimeout(entry.killTimer);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", () => {
    clearTimeout(entry.killTimer);
    if (bots.get(num) === entry) bots.delete(num);
    if (!entry.linked) fs.rmSync(dir, { recursive: true, force: true }); // never finished pairing
  });
  // Not linked within 3 minutes -> stop it and free the slot.
  if (!restored) entry.killTimer = setTimeout(() => { if (!entry.linked) child.kill(); }, 180000);
  return entry;
}

function getCode(num) {
  return new Promise((resolve, reject) => {
    const old = bots.get(num);
    if (old) { old.linked = true; old.child.kill(); bots.delete(num); } // flag linked=true only to keep its folder; replaced below
    fs.rmSync(path.join(SESSIONS, num), { recursive: true, force: true });
    const entry = startBot(num);
    const timer = setTimeout(() => { entry.onCode = null; entry.child.kill(); reject(new Error("timeout")); }, 30000);
    entry.onCode = (code) => { clearTimeout(timer); resolve(code); };
  });
}

// Bring previously linked numbers back online after a restart.
function restoreSessions() {
  let delay = 0;
  for (const num of fs.readdirSync(SESSIONS)) {
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(SESSIONS, num, "auth", "creds.json"), "utf8"));
      if (creds.registered && /^\d{8,15}$/.test(num) && bots.size < LIMIT) {
        setTimeout(() => { if (!bots.has(num)) startBot(num, { restored: true }); }, (delay += 2000));
      }
    } catch {}
  }
}

const hits = new Map(); // ip -> timestamps
const limited = (ip) => {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 5;
};

const json = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  if (url.pathname === "/api/status" && req.method === "GET")
    return json(res, 200, { active: bots.size, limit: LIMIT });

  if (url.pathname === "/api/pair" && req.method === "POST") {
    if (limited(ip)) return json(res, 429, { error: "Too many tries. Wait a minute and try again." });
    let body = "";
    for await (const c of req) { body += c; if (body.length > 1024) return json(res, 413, { error: "Request too large." }); }
    let num;
    try { num = String(JSON.parse(body).number || "").replace(/\D/g, ""); } catch { return json(res, 400, { error: "Bad request." }); }
    if (!/^\d{8,15}$/.test(num)) return json(res, 400, { error: "Enter a valid number with country code, digits only." });
    const existing = bots.get(num);
    if (existing?.linked) return json(res, 409, { error: "This number is already linked to the bot." });
    if (!existing && bots.size >= LIMIT) return json(res, 503, { error: "Server is full. Try again later." });
    try { return json(res, 200, { code: await getCode(num) }); }
    catch { return json(res, 504, { error: "Could not get a code from WhatsApp. Check the number and try again." }); }
  }

  // static files
  let file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`MERLIN EXE site running on http://localhost:${PORT}`);
  restoreSessions();
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const b of bots.values()) b.child.kill(); process.exit(0); });
    
