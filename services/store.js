const fs = require("fs");
const path = require("path");

const DB_DIR = path.join(__dirname, "..", "db");

const defaults = {
  users: {
    BrickFrag: {
      password: "Rosals",
      avatar: "Brickfrag.png",
      role: "founder",
      status: "Building EchoHub",
      accent: "#2dd4bf"
    },
    MglRosal: {
      password: "Rosals",
      avatar: "",
      role: "member",
      status: "Ready to talk",
      accent: "#f59e0b"
    }
  },
  channels: [
    { id: "general", name: "general", type: "text", category: "Hub" },
    { id: "announcements", name: "announcements", type: "text", category: "Hub" },
    { id: "gaming", name: "gaming", type: "text", category: "Hangouts" },
    { id: "ideas", name: "ideas", type: "text", category: "Creation" },
    { id: "voice-lounge", name: "Voice Lounge", type: "voice", category: "Live" }
  ],
  messages: [
    {
      id: "seed-1",
      channel: "general",
      user: "EchoHub",
      text: "Welcome to EchoHub. Different from Discord: the hub centers around vibes, status cards, quick channels, pins, and live rooms.",
      createdAt: new Date().toISOString(),
      reactions: { spark: ["EchoHub"] },
      pinned: true
    }
  ]
};

function getPath(name) {
  return path.join(DB_DIR, `${name}.json`);
}

function ensureDb() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  for (const key of Object.keys(defaults)) {
    if (!fs.existsSync(getPath(key))) {
      save(key, defaults[key]);
    }
  }
}

function load(name) {
  ensureDb();
  const text = fs.readFileSync(getPath(name), "utf8");
  return JSON.parse(text || "null") || defaults[name];
}

function save(name, value) {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  fs.writeFileSync(getPath(name), JSON.stringify(value, null, 2));
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(wss, payload, filter = () => true) {
  wss.clients.forEach((client) => {
    if (filter(client)) {
      send(client, payload);
    }
  });
}

function publicUser(username, user) {
  return {
    username,
    avatar: user.avatar || "",
    role: user.role || "member",
    status: user.status || "Exploring EchoHub",
    accent: user.accent || "#5865f2"
  };
}

function roomMessages(channel) {
  return load("messages")
    .filter((message) => message.channel === channel)
    .slice(-80);
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
}

module.exports = {
  broadcast,
  ensureDb,
  load,
  publicUser,
  roomMessages,
  safeParse,
  save,
  send,
  slugify
};
