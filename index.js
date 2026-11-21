const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const crypto = require("crypto");
const fs = require("fs");


// Silence harmless libsignal "Bad MAC / MessageCounterError / Failed to decrypt" log spam
// (happens when old/duplicate encrypted messages arrive; the bot keeps working)
const SIGNAL_NOISE = [
  "Failed to decrypt message",
  "Session error",
  "Bad MAC",
  "MessageCounterError",
  "Closing open session",
  "Closing session",
  "Removing old closed session",
  "Decrypted message with closed session",
  "SessionEntry",
];
for (const m of ["log", "info", "warn", "error"]) {
  const orig = console[m].bind(console);
  console[m] = (...a) => {
    const t = a.map((x) => (typeof x === "string" ? x : x?.message || "")).join(" ");
    if (SIGNAL_NOISE.some((n) => t.includes(n))) return;
    orig(...a);
  };
}
process.on("unhandledRejection", (e) => console.error("Unhandled:", e?.message || e));
process.on("uncaughtException", (e) => console.error("Uncaught:", e?.message || e));


// ───────────── SINGLE-INSTANCE LOCK ─────────────
// Two copies of the bot on one session = "Waiting for this message" + MessageCounterError.
const AUTH_DIR = process.env.AUTH_DIR || "auth"; // one folder per linked number when run by server.js
const LOCK = process.env.AUTH_DIR ? AUTH_DIR + ".lock" : "bot.lock";
try {
  const [pid, beat] = fs.readFileSync(LOCK, "utf8").split(":").map(Number);
  if (pid && pid !== process.pid && Date.now() - beat < 20000) {
    console.log("❌ Another copy of this bot is already running (pid " + pid + "). Stop it first, then start again.");
    process.exit(1);
  }
} catch {}
const beat = () => { try { fs.writeFileSync(LOCK, process.pid + ":" + Date.now()); } catch {} };
beat();
setInterval(beat, 5000).unref();
process.on("exit", () => { try { fs.unlinkSync(LOCK); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

// Simple caches Baileys recommends (retry counters + group metadata)
const makeCache = () => {
  const m = new Map();
  return {
    get: (k) => m.get(k),
    set: (k, v) => { m.set(k, v); if (m.size > 3000) m.delete(m.keys().next().value); },
    del: (k) => m.delete(k),
    flushAll: () => m.clear(),
  };
};
const retryCache = makeCache();
const groupCache = makeCache();

// ───────────── CONFIG ─────────────
const BOT_NAME = "MERLIN EXE";
const PHONE_NUMBER = process.env.BOT_NUMBER || "2349064331053"; // country code + number, no "+"
const PREFIX = ".";
// Free Fire ban-check endpoint. Use {uid} as the placeholder, e.g. https://your-api.example/check?uid={uid}
// Set it with an environment variable:  FF_API_URL="https://..."  (or paste it below)
const FF_API_URL = process.env.FF_API_URL || "";
const PICTURE_URL =
  "https://res.cloudinary.com/dqqyvozdw/image/upload/v1795272481/ztuzwsv64ajkamfaycon.jpg";
// ──────────────────────────────────

const startedAt = Date.now();

// Small message cache so WhatsApp retry requests ("Waiting for this message") can be answered
const msgStore = new Map();
const remember = (m) => {
  if (!m?.key?.id || !m.message) return;
  msgStore.set(m.key.id, m);
  if (msgStore.size > 2000) msgStore.delete(msgStore.keys().next().value);
};

// ───────────── ANTI-BAN SAFEGUARDS ─────────────
// Human-like behaviour lowers (never removes) the risk of WhatsApp flagging the number:
// typing indicator + random delay before each reply, per-user cooldown, no unsolicited messages.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
async function safeSend(sock, jid, content, opts) {
  try { await sock.sendPresenceUpdate("composing", jid); } catch {}
  await sleep(rand(700, 1800));
  const m = await sock.sendMessage(jid, content, opts);
  try { await sock.sendPresenceUpdate("paused", jid); } catch {}
  remember(m);
  return m;
}
const cmdLog = new Map(); // sender -> timestamps of recent commands
const rateLimited = (who) => {
  const now = Date.now();
  const recent = (cmdLog.get(who) || []).filter((t) => now - t < 60000);
  if (recent.length >= 12 || (recent.length && now - recent[recent.length - 1] < 1500)) {
    cmdLog.set(who, recent);
    return true;
  }
  recent.push(now);
  cmdLog.set(who, recent);
  return false;
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Unicode sans-serif bold (𝗔𝗕𝗖 𝗮𝗯𝗰 𝟭𝟮𝟯)
const bold = (t) =>
  [...String(t)]
    .map((c) => {
      const x = c.codePointAt(0);
      if (x >= 65 && x <= 90) return String.fromCodePoint(0x1d5d4 + x - 65);
      if (x >= 97 && x <= 122) return String.fromCodePoint(0x1d5ee + x - 97);
      if (x >= 48 && x <= 57) return String.fromCodePoint(0x1d7ec + x - 48);
      return c;
    })
    .join("");
const BN = bold(BOT_NAME);

const box = (title, body) =>
  `╔═══〘 💀 ${BN} ⚡ 〙═══╗\n` +
  `║ 🖥️ ${bold(title)}\n` +
  `╚══════════════════════╝\n\n` +
  `${body}\n\n` +
  `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n` +
  `🕶️ ${bold("Powered by")} ${BN} ☠️`;

const MENU = `╔══════════════════════╗
║ 💀 ${BN} ⚡
║ 🕶️ ${bold("Elite WhatsApp Hacker Bot")}
╚══════════════════════╝

👑 ${bold("Owner")}: wa.me/${PHONE_NUMBER}
🔑 ${bold("Prefix")}: [ ${PREFIX} ]
🟢 ${bold("Status")}: ONLINE

┏━━━ 🖥️ ${bold("SYSTEM")} ━━━┓
┃ ⚡ ${PREFIX}ping   ⚡ ${PREFIX}speed
┃ 🕒 ${PREFIX}time   📅 ${PREFIX}date
┃ ⏱️ ${PREFIX}uptime 💾 ${PREFIX}sysinfo
┃ 👑 ${PREFIX}owner  🪪 ${PREFIX}whoami
┃ ℹ️ ${PREFIX}about  📜 ${PREFIX}menu
┗━━━━━━━━━━━━━━━━┛

┏━━━ 💻 ${bold("HACKER TOOLS")} ━━━┓
┃ 👾 ${PREFIX}hack @user (prank)
┃ 🔐 ${PREFIX}password [length]
┃ #️⃣ ${PREFIX}hash <text>
┃ 🧬 ${PREFIX}b64 <text>  ${PREFIX}unb64 <text>
┃ 📡 ${PREFIX}morse <text>
┃ 💻 ${PREFIX}binary <text>
┗━━━━━━━━━━━━━━━━┛

┏━━━ 🎮 ${bold("GAMING & MUSIC")} ━━━┓
┃ 🔥 ${PREFIX}ffban <uid> (Free Fire)
┃ 🎵 ${PREFIX}song <name>
┗━━━━━━━━━━━━━━━━┛

┏━━━ 🎲 ${bold("FUN")} ━━━┓
┃ 🎲 ${PREFIX}roll  🪙 ${PREFIX}flip
┃ 🎱 ${PREFIX}8ball <question>
┃ 😂 ${PREFIX}joke  🧠 ${PREFIX}fact
┃ 💬 ${PREFIX}quote
┃ 😇 ${PREFIX}truth  😈 ${PREFIX}dare
┃ 💘 ${PREFIX}love name1, name2
┃ ⭐ ${PREFIX}rate <thing>
┃ 🎯 ${PREFIX}pick a, b, c
┗━━━━━━━━━━━━━━━━┛

┏━━━ 🛠️ ${bold("TOOLS")} ━━━┓
┃ 🧮 ${PREFIX}calc <expr>
┃ ⚖️ ${PREFIX}bmi <kg> <meters>
┃ 🌡️ ${PREFIX}temp 30c | 86f
┃ 🔤 ${PREFIX}upper  ${PREFIX}lower
┃ 🔁 ${PREFIX}reverse  🤪 ${PREFIX}mock
┃ 🔢 ${PREFIX}count  🗣️ ${PREFIX}echo
┗━━━━━━━━━━━━━━━━┛

┏━━━ 👥 ${bold("GROUP")} ━━━┓
┃ 📊 ${PREFIX}groupinfo
┃ 📢 ${PREFIX}tagall (owner only)
┗━━━━━━━━━━━━━━━━┛

┏━━━ 🚔 ${bold("JAIL")} ━━━┓
┃ 🔒 ${PREFIX}jail @user (or reply)
┃ 🔓 ${PREFIX}free @user (or reply)
┃ 📋 ${PREFIX}jaillist
┃ 🗑️ Jailed members get EVERYTHING
┃ deleted (text, stickers, media,
┃ view-once, voice, docs...) until freed
┃ ⚠️ Bot must be group admin
┗━━━━━━━━━━━━━━━━┛

▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
🕶️ ${bold("Powered by")} ${BN} ☠️`;

const JOKES = [
  "Why do programmers prefer dark mode? Because light attracts bugs. 🐛",
  "I told my computer I needed a break. It said: no problem, I'll go to sleep. 😴",
  "Why was the JavaScript developer sad? He didn't know how to null his feelings. 😢",
  "There are 10 kinds of people: those who understand binary and those who don't. 💻",
  "A SQL query walks into a bar, walks up to two tables and asks: can I join you? 🍻",
  "Why did the developer go broke? He used up all his cache. 💸",
];
const FACTS = [
  "Honey never spoils. Edible honey has been found in ancient Egyptian tombs. 🍯",
  "Octopuses have three hearts and blue blood. 🐙",
  "Bananas are berries, but strawberries are not. 🍌",
  "A day on Venus is longer than a year on Venus. 🪐",
  "The first computer bug was a real moth found in a Harvard computer in 1947. 🦋",
  "Nigeria is the most populous country in Africa. 🇳🇬",
];
const QUOTES = [
  "“The best way to predict the future is to create it.” — Peter Drucker",
  "“Success is the sum of small efforts repeated day in and day out.” — Robert Collier",
  "“It always seems impossible until it's done.” — Nelson Mandela",
  "“Don't watch the clock; do what it does. Keep going.” — Sam Levenson",
  "“Whether you think you can or you think you can't, you're right.” — Henry Ford",
];
const TRUTHS = [
  "What is the most embarrassing thing you've ever done?",
  "What's a secret talent nobody knows about?",
  "Who was your first crush?",
  "What's the last lie you told?",
  "What's your biggest fear?",
];
const DARES = [
  "Send a voice note singing your favorite song. 🎤",
  "Change your WhatsApp status to 'I love Mondays' for an hour.",
  "Text the 5th person in your contacts 'I miss you'.",
  "Do 15 push-ups and send proof. 💪",
  "Talk in rhymes for the next 5 minutes.",
];
const BALL = [
  "It is certain.", "Without a doubt.", "Yes, definitely.", "Most likely.",
  "Ask again later.", "Cannot predict now.", "Don't count on it.",
  "My sources say no.", "Very doubtful.",
];


// ───────────── JAIL SYSTEM ─────────────
const JAIL_FILE = process.env.AUTH_DIR ? AUTH_DIR + "-jail.json" : "jail.json";
let jailDb = {}; // { groupJid: { userId: { crime, years, since } } }
try { jailDb = JSON.parse(fs.readFileSync(JAIL_FILE, "utf8")); } catch {}
const saveJail = () => {
  try { fs.writeFileSync(JAIL_FILE, JSON.stringify(jailDb, null, 2)); } catch {}
};
const uid = (jid = "") => jid.split("@")[0].split(":")[0];

const CRIMES = [
  "Stealing the last piece of meat from the pot 🍖",
  "Sending 'good morning' to 500 people at 3AM ⏰",
  "Replying 'k' to a 10-paragraph message 😤",
  "Eating jollof rice without inviting anybody 🍛",
  "Using 1% battery and still asking for a charger 🔋",
  "Leaving people on 'seen' for 3 days 👀",
  "Hacking NEPA to take light 💡",
  "Selling fake Rolex in Computer Village ⌚",
  "Dancing shaku-shaku in a funeral 🕺",
  "Fighting a goat over a plate of amala 🐐",
  "Impersonating Burna Boy at a wedding 🎤",
  "Stealing WiFi from the whole estate 📶",
  "Sharing fake news in the family group 📰",
  "Forwarding 'forward this to 10 people or die' chain messages ⛓️",
  "Overspeeding on a bicycle 🚲",
  "Being too fine without a license 😎",
  "Stealing the group admin's yam 🍠",
  "Spamming the group with voice notes of 7 minutes 🎙️",
  "Running away with the party's small chops 🍢",
  "Making noise during Super Eagles match 🦅",
  "Changing the group name without permission ✏️",
  "Sending 'who has data?' every Monday 📵",
  "Crossing the road like a Lagos danfo driver 🚌",
  "Putting pineapple on pizza 🍍",
];
const YEARS = [1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 50, 99, 100, 250, 500, 1000];

const getMentioned = (msg) => {
  const m = msg.message || {};
  const ctx =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo || {};
  const list = [...(ctx.mentionedJid || [])];
  if (!list.length && ctx.participant) list.push(ctx.participant); // replied-to user
  return list;
};
const isAdminOrOwner = async (sock, jid, sender, ctxOwner) => {
  if (ctxOwner) return true;
  const meta = await sock.groupMetadata(jid);
  return meta.participants.some((p) => uid(p.id) === uid(sender) && p.admin);
};

// Each command gets (args, ctx) and returns a string (auto-styled),
// or an object passed straight to sock.sendMessage.
const commands = {
  // ── General ──
  menu: () => ({ image: { url: PICTURE_URL }, caption: MENU }),
  ping: () => box("PING", "🏓 Pong! I'm alive and kicking ⚡"),
  speed: (_a, { msg }) => {
    const ts = Number(msg.messageTimestamp) || Date.now() / 1000;
    const ms = Math.max(0, Math.round(Date.now() - ts * 1000));
    return box("SPEED", `⚡ Response time: *${ms} ms*`);
  },
  time: () =>
    box(
      "TIME",
      "🕒 " + new Date().toLocaleTimeString("en-NG", { timeZone: "Africa/Lagos" })
    ),
  date: () =>
    box(
      "DATE",
      "📅 " +
        new Date().toLocaleDateString("en-NG", {
          timeZone: "Africa/Lagos",
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })
    ),
  uptime: () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    return box(
      "UPTIME",
      `⏱️ ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`
    );
  },
  owner: () => box("OWNER", `👑 *${BOT_NAME}*\n📞 wa.me/${PHONE_NUMBER}`),
  about: () =>
    box(
      "ABOUT",
      `🧙‍♂️ I am *${BOT_NAME}*, a magical WhatsApp bot.\n📜 Send *${PREFIX}menu* to see all my spells.`
    ),

  // ── Fun ──
  roll: (args) => {
    const sides = Math.min(Math.max(parseInt(args[0]) || 6, 2), 1000000);
    return box("DICE", `🎲 You rolled *${1 + Math.floor(Math.random() * sides)}* (d${sides})`);
  },
  flip: () => box("COIN FLIP", Math.random() < 0.5 ? "🪙 *Heads*" : "🪙 *Tails*"),
  "8ball": (args) =>
    box(
      "MAGIC 8-BALL",
      args.length ? `🎱 ${pick(BALL)}` : `❓ Ask a question: ${PREFIX}8ball will I be rich?`
    ),
  joke: () => box("JOKE", "😂 " + pick(JOKES)),
  fact: () => box("FACT", "🧠 " + pick(FACTS)),
  quote: () => box("QUOTE", "💬 " + pick(QUOTES)),
  truth: () => box("TRUTH", "😇 " + pick(TRUTHS)),
  dare: () => box("DARE", "😈 " + pick(DARES)),
  love: (args) => {
    const names = args.join(" ").split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length < 2) return box("LOVE", `Usage: ${PREFIX}love Ada, Chidi`);
    const pct = Math.floor(Math.random() * 101);
    return box("LOVE METER", `💘 ${names[0]} ❤️ ${names[1]}\n📊 Match: *${pct}%*`);
  },
  rate: (args) =>
    args.length
      ? box("RATING", `⭐ *${args.join(" ")}* gets *${Math.floor(Math.random() * 11)}/10*`)
      : box("RATING", `Usage: ${PREFIX}rate my cooking`),
  pick: (args) => {
    const options = args.join(" ").split(",").map((s) => s.trim()).filter(Boolean);
    return options.length > 1
      ? box("PICKER", `🎯 I choose: *${pick(options)}*`)
      : box("PICKER", `Usage: ${PREFIX}pick pizza, rice, beans`);
  },

  // ── Tools ──
  calc: (args) => {
    const expr = args.join(" ");
    if (!expr) return box("CALCULATOR", `Usage: ${PREFIX}calc 12*(3+4)`);
    if (!/^[0-9+\-*/().%\s^]+$/.test(expr))
      return box("CALCULATOR", "❌ Only numbers and + - * / % ^ ( ) allowed.");
    try {
      const result = Function(`"use strict"; return (${expr.replace(/\^/g, "**")})`)();
      return Number.isFinite(result)
        ? box("CALCULATOR", `🧮 ${expr} = *${result}*`)
        : box("CALCULATOR", "❌ Math error.");
    } catch {
      return box("CALCULATOR", "❌ Invalid expression.");
    }
  },
  password: (args) => {
    const len = Math.min(Math.max(parseInt(args[0]) || 12, 6), 64);
    const chars =
      "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?";
    let out = "";
    for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
    return box("PASSWORD", `🔐 \`${out}\`\n_Don't reuse it anywhere else!_`);
  },
  bmi: (args) => {
    const kg = parseFloat(args[0]);
    const m = parseFloat(args[1]);
    if (!kg || !m) return box("BMI", `Usage: ${PREFIX}bmi 70 1.75`);
    const v = kg / (m * m);
    const cat = v < 18.5 ? "Underweight" : v < 25 ? "Normal" : v < 30 ? "Overweight" : "Obese";
    return box("BMI", `⚖️ BMI: *${v.toFixed(1)}*\n📌 Category: *${cat}*`);
  },
  temp: (args) => {
    const m = (args[0] || "").match(/^(-?\d+(?:\.\d+)?)([cCfF])$/);
    if (!m) return box("TEMPERATURE", `Usage: ${PREFIX}temp 30c  or  ${PREFIX}temp 86f`);
    const n = parseFloat(m[1]);
    return box(
      "TEMPERATURE",
      m[2].toLowerCase() === "c"
        ? `🌡️ ${n}°C = *${((n * 9) / 5 + 32).toFixed(1)}°F*`
        : `🌡️ ${n}°F = *${(((n - 32) * 5) / 9).toFixed(1)}°C*`
    );
  },
  upper: (args) => box("UPPERCASE", args.join(" ").toUpperCase() || `Usage: ${PREFIX}upper hello`),
  lower: (args) => box("LOWERCASE", args.join(" ").toLowerCase() || `Usage: ${PREFIX}lower HELLO`),
  reverse: (args) =>
    box("REVERSE", [...args.join(" ")].reverse().join("") || `Usage: ${PREFIX}reverse hello`),
  mock: (args) =>
    box(
      "MOCK",
      [...args.join(" ")].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join("") ||
        `Usage: ${PREFIX}mock hello world`
    ),
  binary: (args) => {
    const t = args.join(" ");
    return box(
      "BINARY",
      t
        ? [...Buffer.from(t)].map((b) => b.toString(2).padStart(8, "0")).join(" ")
        : `Usage: ${PREFIX}binary hi`
    );
  },
  count: (args) => {
    const t = args.join(" ");
    if (!t) return box("COUNT", `Usage: ${PREFIX}count some text here`);
    return box("COUNT", `🔢 Characters: *${t.length}*\n📝 Words: *${args.length}*`);
  },
  echo: (args) => box("ECHO", "🗣️ " + (args.join(" ") || `Say something after ${PREFIX}echo`)),

  // ── Group ──
  groupinfo: async (_a, { sock, jid, isGroup }) => {
    if (!isGroup) return box("GROUP INFO", "❌ This command only works in groups.");
    const meta = await sock.groupMetadata(jid);
    const admins = meta.participants.filter((p) => p.admin).length;
    return box(
      "GROUP INFO",
      `📛 Name: *${meta.subject}*\n👥 Members: *${meta.participants.length}*\n🛡️ Admins: *${admins}*\n📝 Description: ${meta.desc || "None"}`
    );
  },
  tagall: async (args, { sock, jid, isGroup, isOwner }) => {
    if (!isGroup) return box("TAG ALL", "❌ This command only works in groups.");
    if (!isOwner) return box("TAG ALL", "🚫 Only the owner can use this command.");
    const meta = await sock.groupMetadata(jid);
    const ids = meta.participants.map((p) => p.id);
    const list = ids.map((id) => `🔹 @${id.split("@")[0]}`).join("\n");
    return {
      text: `📢 *${args.join(" ") || "Attention everyone!"}*\n\n${list}\n\n🔮 _${BOT_NAME}_ ⚡`,
      mentions: ids,
    };
  },

  // ── Hacker tools ──
  whoami: (_a, { sender, isGroup, isOwner }) =>
    box("WHOAMI", `🪪 User: *${uid(sender)}*\n💬 Chat: *${isGroup ? "Group" : "Private"}*\n👑 Access: *${isOwner ? "ROOT (owner)" : "USER"}*`),
  sysinfo: () => {
    const os = require("os");
    const mem = (b) => (b / 1024 / 1024).toFixed(0) + " MB";
    return box(
      "SYSTEM INFO",
      `🖥️ OS: *${os.type()} ${os.release()}*\n⚙️ CPU: *${os.cpus()[0]?.model || "?"}* x${os.cpus().length}\n💾 RAM: *${mem(os.totalmem() - os.freemem())} / ${mem(os.totalmem())}*\n🟩 Node: *${process.version}*`
    );
  },
  hash: (args) => {
    const t = args.join(" ");
    if (!t) return box("HASH", `Usage: ${PREFIX}hash hello`);
    const h = (a) => crypto.createHash(a).update(t).digest("hex");
    return box("HASH", `🔐 MD5:\n\`${h("md5")}\`\n\n🔐 SHA1:\n\`${h("sha1")}\`\n\n🔐 SHA256:\n\`${h("sha256")}\``);
  },
  b64: (args) => {
    const t = args.join(" ");
    return box("BASE64 ENCODE", t ? `🧬 \`${Buffer.from(t).toString("base64")}\`` : `Usage: ${PREFIX}b64 hello`);
  },
  unb64: (args) => {
    const t = args.join(" ");
    return box("BASE64 DECODE", t ? `🧬 ${Buffer.from(t, "base64").toString("utf8") || "❌ Invalid base64"}` : `Usage: ${PREFIX}unb64 aGVsbG8=`);
  },
  morse: (args) => {
    const M = { a:".-",b:"-...",c:"-.-.",d:"-..",e:".",f:"..-.",g:"--.",h:"....",i:"..",j:".---",k:"-.-",l:".-..",m:"--",n:"-.",o:"---",p:".--.",q:"--.-",r:".-.",s:"...",t:"-",u:"..-",v:"...-",w:".--",x:"-..-",y:"-.--",z:"--..","0":"-----","1":".----","2":"..---","3":"...--","4":"....-","5":".....","6":"-....","7":"--...","8":"---..","9":"----." };
    const t = args.join(" ").toLowerCase();
    if (!t) return box("MORSE", `Usage: ${PREFIX}morse sos`);
    return box("MORSE", "📡 " + [...t].map((c) => (c === " " ? "/" : M[c] || "")).filter(Boolean).join(" "));
  },
  hack: async (args, { sock, jid, msg, send }) => {
    const target = getMentioned(msg)[0];
    const who = target ? "@" + uid(target) : args.join(" ") || "target";
    const mentions = target ? [target] : [];
    const bar = (p) => "█".repeat(p / 10) + "░".repeat(10 - p / 10) + ` ${p}%`;
    const frame = (txt, p) => ({ text: box("HACKING", `👾 ${txt}\n[${bar(p)}]`), ment
