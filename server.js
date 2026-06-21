// ============================
// EchoHub - Main Server (Upgraded!)
// ============================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");
const friendsService = require("./services/friendsService");
const discordService = require("./services/discordService");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// Serve uploaded files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Make uploads folder if it doesn't exist
if (!fs.existsSync(path.join(__dirname, "uploads"))) {
  fs.mkdirSync(path.join(__dirname, "uploads"));
}

// ============================
// FILE UPLOAD (multer)
// ============================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const fileUrl = `/uploads/${req.file.filename}`;
  const isImage = req.file.mimetype.startsWith("image/");
  res.json({ url: fileUrl, name: req.file.originalname, isImage });
});

app.get("/giphy/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const limit = Math.min(Math.max(Number(req.query.limit || 12), 1), 24);
  const endpoint = q ? "search" : "trending";
  const params = new URLSearchParams({
    api_key: GIPHY_API_KEY,
    limit: String(limit),
    rating: "pg-13",
    lang: "en",
    bundle: "messaging_non_clips",
  });
  if (q) params.set("q", q);
  try {
    const response = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: payload?.message || "GIPHY request failed" });
    const gifs = (payload.data || []).map((gif) => {
      const image = gif.images?.fixed_height_small || gif.images?.fixed_height || gif.images?.downsized_medium || gif.images?.original || {};
      const preview = gif.images?.fixed_width_small_still || gif.images?.downsized_still || image;
      return {
        id: gif.id,
        title: gif.title || "GIPHY GIF",
        url: image.url || "",
        preview: preview.url || image.url || "",
        width: Number(image.width || 0),
        height: Number(image.height || 0),
        source: "giphy",
      };
    }).filter((gif) => gif.url);
    res.json({ gifs, attribution: "Powered by GIPHY" });
  } catch (error) {
    res.status(502).json({ error: "Could not reach GIPHY." });
  }
});

// ============================
// DB HELPERS
// ============================
const DB_PATH = path.join(__dirname, "db");
const AUTH_SECRET = process.env.ECHOHUB_AUTH_SECRET || "echohub-dev-secret-change-me";
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || "6E8OfROXnczP47hpbu3Wb0BQmMrbGF42";

function readDB(file) {
  try {
    const data = fs.readFileSync(path.join(DB_PATH, file), "utf8");
    const parsed = JSON.parse(data);
    if (file === "messages.json" && Array.isArray(parsed)) {
      return parsed.reduce((acc, message) => {
        const channelId = String(message.channelId || message.channel || "general");
        acc[channelId] = acc[channelId] || [];
        acc[channelId].push({
          id: String(message.id || `${Date.now()}-${acc[channelId].length}`),
          channelId,
          username: message.username || message.user || "Unknown",
          text: message.text || "",
          avatar: message.avatar || (message.username || message.user || "?").slice(0, 2).toUpperCase(),
          timestamp: message.timestamp || message.createdAt || new Date().toISOString(),
          replyTo: message.replyTo || null,
          fileUrl: message.fileUrl || null,
          fileName: message.fileName || null,
          isImage: Boolean(message.isImage),
          poll: message.poll || null,
          sticker: message.sticker || "",
          reactions: message.reactions || {},
          edited: Boolean(message.edited),
          pinned: Boolean(message.pinned),
        });
        return acc;
      }, {});
    }
    return parsed;
  } catch {
    return file === "messages.json" ? {} : [];
  }
}

function writeDB(file, data) {
  fs.writeFileSync(path.join(DB_PATH, file), JSON.stringify(data, null, 2));
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${derived}`;
}
function verifyPassword(password, storedHash) {
  if (!storedHash || !String(storedHash).includes(":")) return false;
  const [salt, original] = String(storedHash).split(":");
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(original, "hex"));
}
function signAuthToken(username) {
  const payload = Buffer.from(JSON.stringify({ username, iat: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function readAuthToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}
function verifyAuthToken(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  if (sig !== expected) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return body && body.username ? body : null;
  } catch {
    return null;
  }
}
function requireAuth(req, res, next) {
  const token = readAuthToken(req);
  const decoded = verifyAuthToken(token);
  if (!decoded) return res.status(401).json({ error: "Unauthorized!" });
  req.authUser = decoded.username;
  next();
}
function findDMMessage(state, messageId) {
  const targetId = String(messageId || "");
  for (const [key, list] of Object.entries(state.dms || {})) {
    const message = Array.isArray(list) ? list.find((item) => String(item.id) === targetId) : null;
    if (message) return { key, message };
  }
  return null;
}
const ACCENT_PALETTE = ["#5865f2", "#f2b84b", "#fb7185", "#7aa2ff", "#23a559", "#f97316", "#14b8a6", "#a855f7"];
function pickAccentFromUsername(username) {
  const value = String(username || "");
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return ACCENT_PALETTE[hash % ACCENT_PALETTE.length];
}

function readUsersList() {
  const raw = readDB("users.json");
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([username, value]) => ({
      id: String(Date.now()) + "-" + username,
      username,
      password: value.password || "",
      passwordHash: value.passwordHash || "",
      avatar: value.avatar || username[0]?.toUpperCase?.() || "?",
      accent: value.accent || "#5865f2",
      role: value.role || "member",
      email: value.email || "",
      plan: value.plan || "free",
      title: value.title || "",
      createdAt: value.createdAt || new Date().toISOString(),
    }));
  }
  return [];
}
function findUserByUsername(username) {
  const target = String(username || "").trim().toLowerCase();
  if (!target) return null;
  return readUsersList().find((u) => String(u.username || "").trim().toLowerCase() === target) || null;
}
function renameKey(map, oldName, newName) {
  if (!map || typeof map !== "object" || !(oldName in map)) return;
  map[newName] = map[newName] ?? map[oldName];
  delete map[oldName];
}
function replaceNameInArray(list, oldName, newName) {
  return Array.isArray(list) ? [...new Set(list.map((item) => String(item) === oldName ? newName : item))] : list;
}
function renameUserEverywhere(oldName, newName) {
  const messages = readDB("messages.json");
  if (messages && typeof messages === "object") {
    Object.values(messages).forEach((list) => {
      if (!Array.isArray(list)) return;
      list.forEach((message) => {
        if (String(message.username || "") === oldName) message.username = newName;
        if (String(message.user || "") === oldName) message.user = newName;
      });
    });
    writeDB("messages.json", messages);
  }

  const communities = readCommunitiesList().map((community) => ({
    ...community,
    owner: community.owner === oldName ? newName : community.owner,
    personalOwner: community.personalOwner === oldName ? newName : community.personalOwner,
  }));
  writeDB("communities.json", communities);

  const memberships = readMembershipMap();
  Object.values(memberships).forEach((entry) => {
    entry.members = replaceNameInArray(entry.members, oldName, newName);
    entry.pending = replaceNameInArray(entry.pending, oldName, newName);
  });
  writeMembershipMap(memberships);

  const state = discordService.loadState();
  ["profiles", "friends", "friendRequests", "blocks", "notifications", "callInvites"].forEach((key) => renameKey(state[key], oldName, newName));
  Object.keys(state.friends || {}).forEach((key) => { state.friends[key] = replaceNameInArray(state.friends[key], oldName, newName); });
  Object.values(state.friendRequests || {}).forEach((row) => {
    if (row) {
      row.incoming = replaceNameInArray(row.incoming, oldName, newName);
      row.outgoing = replaceNameInArray(row.outgoing, oldName, newName);
    }
  });
  Object.values(state.communityMemberRoles || {}).forEach((roles) => renameKey(roles, oldName, newName));
  Object.values(state.bansByCommunity || {}).forEach((bans) => {
    if (Array.isArray(bans)) bans.forEach((ban) => { if (ban.username === oldName) ban.username = newName; });
  });
  Object.values(state.dms || {}).forEach((list) => {
    if (Array.isArray(list)) list.forEach((message) => {
      if (message.from === oldName) message.from = newName;
      if (message.to === oldName) message.to = newName;
    });
  });
  state.auditLog = (state.auditLog || []).map((entry) => ({
    ...entry,
    actor: entry.actor === oldName ? newName : entry.actor,
    target: entry.target === oldName ? newName : entry.target,
  }));
  discordService.saveState(state);

  const friendsPath = path.join(DB_PATH, "friends.json");
  try {
    const friendDb = JSON.parse(fs.readFileSync(friendsPath, "utf8"));
    renameKey(friendDb, oldName, newName);
    Object.keys(friendDb).forEach((key) => { friendDb[key] = replaceNameInArray(friendDb[key], oldName, newName); });
    fs.writeFileSync(friendsPath, JSON.stringify(friendDb, null, 2));
  } catch {}
}

// ============================
// AUTH ROUTES
// ============================
app.post("/register", (req, res) => {
  const { username, password, email, avatar, accent } = req.body || {};
  if (!username || !password || !email)
    return res.status(400).json({ error: "Username, email, and password required!" });

  const users = readUsersList();
  if (users.find((u) => u.username === username))
    return res.status(400).json({ error: "Username already taken!" });
  if (users.find((u) => String(u.email || "").toLowerCase() === String(email).toLowerCase()))
    return res.status(400).json({ error: "Email already used!" });

  const newUser = {
    id: String(Date.now()),
    username,
    password: "",
    passwordHash: hashPassword(password),
    avatar: String(avatar || "").trim() || username.slice(0, 2).toUpperCase(),
    accent: String(accent || "").trim() || pickAccentFromUsername(username),
    role: "member",
    email: String(email || "").trim(),
    plan: "free",
    title: "",
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  writeDB("users.json", users);
  ensurePersonalCommunityForUser(newUser.username);
  res.json({ message: "Registered!", username: newUser.username, avatar: newUser.avatar, accent: newUser.accent });
});

app.post("/login", (req, res) => {
  const { username, password, email } = req.body;
  const users = readUsersList();
  const loginEmail = String(email || "").trim().toLowerCase();
  const user = users.find((u) => {
    if (u.username !== username) return false;
    const savedEmail = String(u.email || "").trim().toLowerCase();
    if (!savedEmail) return true; // legacy account support
    if (!loginEmail) return false;
    return savedEmail === loginEmail;
  });
  if (!user) return res.status(401).json({ error: "Wrong username or password!" });
  let ok = false;
  if (user.passwordHash) {
    ok = verifyPassword(password, user.passwordHash);
  } else if (user.password) {
    ok = user.password === password;
    if (ok) {
      user.passwordHash = hashPassword(password);
      user.password = "";
      writeDB("users.json", users);
    }
  }
  if (!ok) return res.status(401).json({ error: "Wrong username or password!" });
  if (!String(user.email || "").trim() && loginEmail) {
    user.email = loginEmail;
    writeDB("users.json", users);
  }
  ensurePersonalCommunityForUser(user.username);
  res.json({
    message: "Login successful!",
    username: user.username,
    avatar: user.avatar,
    accent: user.accent || "#5865f2",
    email: user.email || "",
    plan: user.plan || "free",
    title: user.title || "",
    token: signAuthToken(user.username),
  });
});

app.get("/users", (req, res) => {
  const users = readUsersList().map((u) => ({
    username: u.username,
    avatar: u.avatar || "",
    accent: u.accent || "#5865f2",
    email: u.email || "",
    role: u.role || "member",
    plan: u.plan || "free",
    title: u.title || "",
    usernameChangedAt: u.usernameChangedAt || "",
  }));
  res.json(users);
});

app.post("/users/:username/profile", requireAuth, (req, res) => {
  const username = String(req.params.username || "").trim();
  const avatar = String(req.body?.avatar || "").trim();
  const accent = String(req.body?.accent || "").trim();
  if (!username) return res.status(400).json({ error: "Username required!" });
  if (req.authUser !== username) return res.status(403).json({ error: "Forbidden!" });
  const users = readUsersList();
  const user = users.find((u) => u.username === username);
  if (!user) return res.status(404).json({ error: "User not found!" });
  user.avatar = avatar || username.slice(0, 2).toUpperCase();
  if (accent) user.accent = accent;
  writeDB("users.json", users);
  res.json({ username: user.username, avatar: user.avatar, accent: user.accent || "#5865f2" });
});

app.post("/users/:username/username", requireAuth, (req, res) => {
  const oldName = String(req.params.username || "").trim();
  const nextName = String(req.body?.username || "").trim();
  if (!oldName || !nextName) return res.status(400).json({ error: "Username required!" });
  if (req.authUser !== oldName) return res.status(403).json({ error: "Forbidden!" });
  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(nextName)) {
    return res.status(400).json({ error: "Use 3-24 letters, numbers, dots, dashes, or underscores." });
  }
  const users = readUsersList();
  const user = users.find((u) => u.username === oldName);
  if (!user) return res.status(404).json({ error: "User not found!" });
  if (users.some((u) => u.username.toLowerCase() === nextName.toLowerCase() && u.username !== oldName)) {
    return res.status(400).json({ error: "Username already taken!" });
  }
  const lastChanged = user.usernameChangedAt ? new Date(user.usernameChangedAt).getTime() : 0;
  const cooldownMs = 30 * 24 * 60 * 60 * 1000;
  if (lastChanged && Date.now() - lastChanged < cooldownMs) {
    const remainingDays = Math.ceil((cooldownMs - (Date.now() - lastChanged)) / (24 * 60 * 60 * 1000));
    return res.status(403).json({ error: `You can change your username again in ${remainingDays} day(s).` });
  }
  user.username = nextName;
  user.usernameChangedAt = new Date().toISOString();
  writeDB("users.json", users);
  renameUserEverywhere(oldName, nextName);
  Object.values(onlineUsers).forEach((session) => {
    if (session.username === oldName) session.username = nextName;
  });
  broadcastOnlineUsers();
  res.json({
    username: nextName,
    avatar: user.avatar,
    accent: user.accent || "#5865f2",
    usernameChangedAt: user.usernameChangedAt,
    token: signAuthToken(nextName),
  });
});

app.post("/users/:username/role", requireAuth, (req, res) => {
  const username = String(req.params.username || "").trim();
  const role = String(req.body?.role || "").trim().toLowerCase();
  const communityId = String(req.body?.communityId || "").trim();
  if (!username || !role) return res.status(400).json({ error: "Username and role required!" });
  if (!["member", "admin"].includes(role)) return res.status(400).json({ error: "Invalid role!" });
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (community.owner !== req.authUser) return res.status(403).json({ error: "Only the community owner can change admin roles." });
  if (username === community.owner) return res.status(400).json({ error: "Cannot change owner global role." });
  const users = readUsersList();
  const user = users.find((u) => u.username === username);
  if (!user) return res.status(404).json({ error: "User not found!" });
  user.role = role;
  writeDB("users.json", users);
  Object.values(onlineUsers).forEach((onlineUser) => {
    if (onlineUser.username === username) onlineUser.role = role;
  });
  io.emit("online_users", Object.values(onlineUsers));
  res.json({ username: user.username, role: user.role });
});

app.get("/friends/:username", (req, res) => {
  const username = String(req.params.username || "").trim();
  if (!username) return res.status(400).json({ error: "Username required!" });
  const state = discordService.loadState();
  discordService.ensureUserCollections(state, username);
  const merged = [...new Set([...friendsService.getFriends(username), ...(state.friends[username] || [])])];
  if (merged.length !== (state.friends[username] || []).length) {
    state.friends[username] = merged;
    merged.forEach((friendUsername) => {
      discordService.ensureUserCollections(state, friendUsername);
      if (!state.friends[friendUsername].includes(username)) state.friends[friendUsername].push(username);
    });
    discordService.saveState(state);
  }
  res.json(merged);
});

app.post("/friends/:username", (req, res) => {
  const user = findUserByUsername(req.params.username);
  const friendUser = findUserByUsername(req.body?.friendUsername);
  const username = user ? user.username : String(req.params.username || "").trim();
  const friendUsername = friendUser ? friendUser.username : String(req.body?.friendUsername || "").trim();
  if (!username || !friendUsername)
    return res.status(400).json({ error: "Username and friendUsername required!" });
  if (!friendUser)
    return res.status(404).json({ error: "Friend user not found!" });
  if (username.toLowerCase() === friendUsername.toLowerCase())
    return res.status(400).json({ error: "Cannot add yourself!" });
  const updated = friendsService.addFriend(username, friendUsername);
  const state = discordService.loadState();
  discordService.ensureUserCollections(state, username);
  discordService.ensureUserCollections(state, friendUsername);
  if (!state.friends[username].includes(friendUsername)) state.friends[username].push(friendUsername);
  if (!state.friends[friendUsername].includes(username)) state.friends[friendUsername].push(username);
  discordService.saveState(state);
  res.json([...new Set([...(updated || []), ...(state.friends[username] || [])])]);
});

// ============================
// DISCORD PARITY ROUTES (Waves 1-3 backend)
// ============================
app.get("/discord/state/:username", (req, res) => {
  const username = String(req.params.username || "").trim();
  if (!username) return res.status(400).json({ error: "Username required!" });
  const state = discordService.loadState();
  discordService.ensureUserCollections(state, username);
  res.json({
    profile: state.profiles[username] || {},
    friends: state.friends[username],
    friendRequests: state.friendRequests[username],
    blocks: state.blocks[username],
    notifications: state.notifications[username],
  });
});

app.post("/discord/profile/:username", (req, res) => {
  const username = String(req.params.username || "").trim();
  const { bio, pronouns, banner, status } = req.body || {};
  if (!username) return res.status(400).json({ error: "Username required!" });
  const state = discordService.loadState();
  state.profiles[username] = {
    ...(state.profiles[username] || {}),
    bio: bio || "",
    pronouns: pronouns || "",
    banner: banner || "",
    status: status || "",
    updatedAt: new Date().toISOString(),
  };
  discordService.saveState(state);
  res.json(state.profiles[username]);
});

app.post("/discord/friend-request", (req, res) => {
  const fromUser = findUserByUsername(req.body?.from);
  const toUser = findUserByUsername(req.body?.to);
  const from = fromUser ? fromUser.username : String(req.body?.from || "").trim();
  const to = toUser ? toUser.username : String(req.body?.to || "").trim();
  if (!from || !to) return res.status(400).json({ error: "from and to required!" });
  if (!fromUser || !toUser) return res.status(404).json({ error: "User not found!" });
  if (from.toLowerCase() === to.toLowerCase()) return res.status(400).json({ error: "Cannot add yourself!" });
  const state = discordService.loadState();
  discordService.ensureUserCollections(state, from);
  discordService.ensureUserCollections(state, to);
  if (!state.friendRequests[to].incoming.includes(from)) state.friendRequests[to].incoming.push(from);
  if (!state.friendRequests[from].outgoing.includes(to)) state.friendRequests[from].outgoing.push(to);
  state.notifications[to].push({ id: `notif-${Date.now()}`, type: "friend_request", from, createdAt: new Date().toISOString() });
  discordService.addAudit(state, from, "friend_request_sent", to);
  discordService.saveState(state);
  res.json({ ok: true });
});

app.post("/discord/friend-request/respond", (req, res) => {
  const toUser = findUserByUsername(req.body?.to);
  const fromUser = findUserByUsername(req.body?.from);
  const to = toUser ? toUser.username : String(req.body?.to || "").trim();
  const from = fromUser ? fromUser.username : String(req.body?.from || "").trim();
  const accept = Boolean(req.body?.accept);
  if (!from || !to) return res.status(400).json({ error: "from and to required!" });
  if (!fromUser || !toUser) return res.status(404).json({ error: "User not found!" });
  const state = discordService.loadState();
  discordService.ensureUserCollections(state, from);
  discordService.ensureUserCollections(state, to);
  state.friendRequests[to].incoming = state.friendRequests[to].incoming.filter((u) => u !== from);
  state.friendRequests[from].outgoing = state.friendRequests[from].outgoing.filter((u) => u !== to);
  if (accept) {
    if (!state.friends[to].includes(from)) state.friends[to].push(from);
    if (!state.friends[from].includes(to)) state.friends[from].push(to);
    friendsService.addFriend(to, from);
    state.notifications[from].push({ id: `notif-${Date.now()}-${Math.floor(Math.random() * 100000)}`, type: "friend_accept", from: to, createdAt: new Date().toISOString() });
    discordService.addAudit(state, to, "friend_request_accepted", from);
  } else {
    discordService.addAudit(state, to, "friend_request_denied", from);
  }
  discordService.saveState(state);
  res.json({ ok: true, friends: state.friends[to] });
});

app.post("/discord/block", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const target = String(req.body?.target || "").trim();
  if (!username || !target) return res.status(400).json({ error: "username and target required!" });
  const state = discordService.loadState();
  discordService.ensureUserCollections(state, username);
  if (!state.blocks[username].includes(target)) state.blocks[username].push(target);
  discordService.addAudit(state, username, "block_user", target);
  discordService.saveState(state);
  res.json(state.blocks[username]);
});

app.post("/discord/dm", (req, res) => {
  const from = String(req.body?.from || "").trim();
  const to = String(req.body?.to || "").trim();
  const text = String(req.body?.text || "").trim();
  const fileUrl = String(req.body?.fileUrl || "").trim();
  const fileName = String(req.body?.fileName || "").trim();
  const isImage = Boolean(req.body?.isImage);
  if (!from || !to || (!text && !fileUrl)) return res.status(400).json({ error: "from, to, and text or file required!" });
  const state = discordService.loadState();
  discordService.ensureUserCollections(state, from);
  discordService.ensureUserCollections(state, to);
  if (state.blocks[to]?.includes(from)) return res.status(403).json({ error: "This user is not accepting DMs from you." });
  const key = discordService.dmKey(from, to);
  if (!state.dms[key]) state.dms[key] = [];
  const message = {
    id: `dm-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    from,
    to,
    text,
    fileUrl,
    fileName,
    isImage,
    reactions: {},
    createdAt: new Date().toISOString(),
  };
  state.dms[key].push(message);
  if (state.dms[key].length > 300) state.dms[key] = state.dms[key].slice(-300);
  state.notifications[to].push({ id: `notif-${Date.now()}-${Math.floor(Math.random() * 100000)}`, type: "dm", from, preview: text || fileName || "Attachment", createdAt: new Date().toISOString() });
  discordService.saveState(state);
  res.json(message);
});

app.get("/discord/dm/:a/:b", (req, res) => {
  const a = String(req.params.a || "").trim();
  const b = String(req.params.b || "").trim();
  if (!a || !b) return res.status(400).json({ error: "Both users required!" });
  const state = discordService.loadState();
  const key = discordService.dmKey(a, b);
  res.json(state.dms[key] || []);
});

app.patch("/discord/dm/:messageId", (req, res) => {
  const messageId = String(req.params.messageId || "").trim();
  const username = String(req.body?.username || "").trim();
  const text = String(req.body?.text || "").trim();
  if (!messageId || !username || !text) return res.status(400).json({ error: "messageId, username, and text required!" });
  const state = discordService.loadState();
  const entry = findDMMessage(state, messageId);
  if (!entry) return res.status(404).json({ error: "DM not found!" });
  if (entry.message.from !== username) return res.status(403).json({ error: "You can only edit your own DMs." });
  entry.message.text = text;
  entry.message.editedAt = new Date().toISOString();
  discordService.saveState(state);
  res.json(entry.message);
});

app.delete("/discord/dm/:messageId", (req, res) => {
  const messageId = String(req.params.messageId || "").trim();
  const username = String(req.query.username || "").trim();
  if (!messageId || !username) return res.status(400).json({ error: "messageId and username required!" });
  const state = discordService.loadState();
  const entry = findDMMessage(state, messageId);
  if (!entry) return res.status(404).json({ error: "DM not found!" });
  if (entry.message.from !== username) return res.status(403).json({ error: "You can only delete your own DMs." });
  state.dms[entry.key] = state.dms[entry.key].filter((message) => message.id !== messageId);
  discordService.saveState(state);
  res.json({ ok: true });
});

app.post("/discord/dm/:messageId/react", (req, res) => {
  const messageId = String(req.params.messageId || "").trim();
  const username = String(req.body?.username || "").trim();
  const reaction = String(req.body?.reaction || "").trim();
  if (!messageId || !username || !reaction) return res.status(400).json({ error: "messageId, username, and reaction required!" });
  const state = discordService.loadState();
  const entry = findDMMessage(state, messageId);
  if (!entry) return res.status(404).json({ error: "DM not found!" });
  entry.message.reactions = entry.message.reactions || {};
  entry.message.reactions[reaction] = entry.message.reactions[reaction] || [];
  const users = entry.message.reactions[reaction];
  const idx = users.indexOf(username);
  if (idx >= 0) users.splice(idx, 1);
  else users.push(username);
  if (!users.length) delete entry.message.reactions[reaction];
  discordService.saveState(state);
  res.json(entry.message);
});

app.post("/discord/role", requireAuth, (req, res) => {
  const communityId = String(req.body?.communityId || "").trim();
  const roleName = String(req.body?.roleName || "").trim();
  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  if (!communityId || !roleName) return res.status(400).json({ error: "communityId and roleName required!" });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  if (!state.rolesByCommunity[communityId]) state.rolesByCommunity[communityId] = [];
  const role = { id: `role-${Date.now()}`, roleName, permissions, createdAt: new Date().toISOString() };
  state.rolesByCommunity[communityId].push(role);
  discordService.saveState(state);
  res.json(role);
});

app.get("/discord/role/:communityId", (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const state = discordService.loadState();
  res.json(state.rolesByCommunity[communityId] || []);
});
function isCommunityStaff(state, community, username) {
  if (!community || !username) return false;
  if (community.owner === username) return true;
  const users = readUsersList();
  const global = users.find((u) => u.username === username);
  if (global && String(global.role || "").toLowerCase() === "admin") return true;
  const roleName = String((state.communityMemberRoles?.[community.id] || {})[username] || "").toLowerCase();
  if (!roleName) return false;
  return ["admin", "moderator", "mod", "staff", "owner"].some((r) => roleName.includes(r));
}
function readCustomEmojiMap() {
  const raw = readDB("customEmojis.json");
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}
function writeCustomEmojiMap(map) {
  writeDB("customEmojis.json", map);
}
function normalizeEmojiName(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}
function getChannelCommunity(channelId) {
  const channel = readChannelsList().find((c) => String(c.id || "") === String(channelId || ""));
  if (!channel) return null;
  const community = ensureDefaultCommunity().find((c) => c.id === channel.communityId);
  return community || null;
}
app.get("/discord/custom-emoji/:communityId", (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const map = readCustomEmojiMap();
  res.json(Array.isArray(map[communityId]) ? map[communityId] : []);
});
app.post("/discord/custom-emoji", requireAuth, (req, res) => {
  const communityId = String(req.body?.communityId || "").trim();
  const name = normalizeEmojiName(req.body?.name);
  const url = String(req.body?.url || "").trim();
  if (!communityId || !name || !url) return res.status(400).json({ error: "communityId, name, and url required!" });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  const map = readCustomEmojiMap();
  map[communityId] = Array.isArray(map[communityId]) ? map[communityId] : [];
  if (map[communityId].some((emoji) => emoji.name === name)) return res.status(409).json({ error: "Emoji name already exists." });
  const emoji = { id: `emoji-${Date.now()}`, name, url, createdBy: req.authUser, createdAt: new Date().toISOString() };
  map[communityId].push(emoji);
  writeCustomEmojiMap(map);
  res.json(emoji);
});
app.delete("/discord/custom-emoji/:communityId/:emojiId", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const emojiId = String(req.params.emojiId || "").trim();
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  const map = readCustomEmojiMap();
  const list = Array.isArray(map[communityId]) ? map[communityId] : [];
  map[communityId] = list.filter((emoji) => emoji.id !== emojiId);
  writeCustomEmojiMap(map);
  res.json({ ok: true, emojis: map[communityId] });
});
app.get("/discord/mod/:communityId/bans", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  res.json(state.bansByCommunity[communityId] || []);
});
app.post("/discord/mod/:communityId/ban", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const target = String(req.body?.target || "").trim();
  const reason = String(req.body?.reason || "No reason").trim();
  if (!communityId || !target) return res.status(400).json({ error: "communityId and target required!" });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  if (target === community.owner) return res.status(400).json({ error: "Cannot ban community owner." });
  state.bansByCommunity[communityId] = state.bansByCommunity[communityId] || [];
  if (!state.bansByCommunity[communityId].find((b) => b.username === target)) {
    state.bansByCommunity[communityId].push({ username: target, reason, by: req.authUser, createdAt: new Date().toISOString() });
  }
  const map = readMembershipMap();
  const entry = ensureMembershipEntry(map, communityId);
  entry.members = entry.members.filter((u) => u !== target);
  entry.pending = entry.pending.filter((u) => u !== target);
  writeMembershipMap(map);
  discordService.saveState(state);
  res.json({ ok: true, bans: state.bansByCommunity[communityId] });
});
app.post("/discord/mod/:communityId/unban", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const target = String(req.body?.target || "").trim();
  if (!communityId || !target) return res.status(400).json({ error: "communityId and target required!" });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  state.bansByCommunity[communityId] = (state.bansByCommunity[communityId] || []).filter((b) => b.username !== target);
  discordService.saveState(state);
  res.json({ ok: true, bans: state.bansByCommunity[communityId] });
});
app.get("/discord/member-role/:communityId", (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const state = discordService.loadState();
  res.json(state.communityMemberRoles[communityId] || {});
});
app.post("/discord/member-role", requireAuth, (req, res) => {
  const communityId = String(req.body?.communityId || "").trim();
  const username = String(req.body?.username || "").trim();
  const roleName = String(req.body?.roleName || "").trim();
  if (!communityId || !username || !roleName) return res.status(400).json({ error: "communityId, username, roleName required!" });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  if (username === community.owner || roleName.toLowerCase() === "owner") return res.status(400).json({ error: "Owner role is locked to community owner." });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  if (!state.communityMemberRoles[communityId]) state.communityMemberRoles[communityId] = {};
  state.communityMemberRoles[communityId][username] = roleName;
  discordService.saveState(state);
  res.json({ ok: true, roles: state.communityMemberRoles[communityId] });
});

app.post("/discord/role/delete", requireAuth, (req, res) => {
  const communityId = String(req.body?.communityId || "").trim();
  const roleId = String(req.body?.roleId || "").trim();
  const roleName = String(req.body?.roleName || "").trim();
  if (!communityId || (!roleId && !roleName)) return res.status(400).json({ error: "communityId and roleId or roleName required!" });
  const state = discordService.loadState();
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  const list = state.rolesByCommunity[communityId] || [];
  const before = list.length;
  state.rolesByCommunity[communityId] = list.filter((r) => {
    if (roleId && r.id === roleId) return false;
    if (!roleId && roleName && String(r.roleName || "").trim().toLowerCase() === roleName.toLowerCase()) return false;
    return true;
  });
  discordService.saveState(state);
  res.json({ ok: true, removed: Math.max(0, before - state.rolesByCommunity[communityId].length) });
});

app.delete("/discord/role/:communityId/:roleId", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const roleId = String(req.params.roleId || "").trim();
  if (!communityId || !roleId) return res.status(400).json({ error: "communityId and roleId required!" });
  const state = discordService.loadState();
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  const list = state.rolesByCommunity[communityId] || [];
  const before = list.length;
  state.rolesByCommunity[communityId] = list.filter((r) => String(r.id || "") !== roleId);
  discordService.saveState(state);
  res.json({ ok: true, removed: Math.max(0, before - state.rolesByCommunity[communityId].length) });
});

app.delete("/discord/role/:communityId/by-name/:roleName", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const roleName = String(req.params.roleName || "").trim().toLowerCase();
  if (!communityId || !roleName) return res.status(400).json({ error: "communityId and roleName required!" });
  const state = discordService.loadState();
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  const list = state.rolesByCommunity[communityId] || [];
  const before = list.length;
  state.rolesByCommunity[communityId] = list.filter((r) => String(r.roleName || "").trim().toLowerCase() !== roleName);
  discordService.saveState(state);
  res.json({ ok: true, removed: Math.max(0, before - state.rolesByCommunity[communityId].length) });
});

app.post("/discord/channel-settings/:channelId", requireAuth, (req, res) => {
  const channelId = String(req.params.channelId || "").trim();
  if (!channelId) return res.status(400).json({ error: "channelId required!" });
  const { topic, slowmode, nsfw, isPrivate } = req.body || {};
  const state = discordService.loadState();
  const community = getChannelCommunity(channelId);
  if (!community) return res.status(404).json({ error: "Channel community not found!" });
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  state.channelSettings[channelId] = {
    ...(state.channelSettings[channelId] || {}),
    topic: topic || "",
    slowmode: Number(slowmode || 0),
    nsfw: Boolean(nsfw),
    isPrivate: Boolean(isPrivate),
    updatedAt: new Date().toISOString(),
  };
  discordService.saveState(state);
  res.json(state.channelSettings[channelId]);
});

app.get("/discord/channel-settings/:channelId", (req, res) => {
  const channelId = String(req.params.channelId || "").trim();
  if (!channelId) return res.status(400).json({ error: "channelId required!" });
  const state = discordService.loadState();
  res.json(state.channelSettings[channelId] || { topic: "", slowmode: 0, nsfw: false, isPrivate: false });
});

app.post("/discord/invite", requireAuth, (req, res) => {
  const communityId = String(req.body?.communityId || "").trim();
  const createdBy = req.authUser;
  const expiresInMinutes = Number(req.body?.expiresInMinutes || 60);
  if (!communityId || !createdBy) return res.status(400).json({ error: "communityId and createdBy required!" });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const invite = {
    code,
    communityId,
    createdBy,
    expiresAt: new Date(Date.now() + expiresInMinutes * 60000).toISOString(),
    createdAt: new Date().toISOString(),
  };
  state.invites[code] = invite;
  discordService.addAudit(state, createdBy, "invite_created", communityId, { code });
  discordService.saveState(state);
  res.json(invite);
});

app.get("/discord/invite/:communityId", (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const state = discordService.loadState();
  const invites = Object.values(state.invites || {})
    .filter((i) => i.communityId === communityId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50);
  res.json(invites);
});

app.post("/discord/invite/join", (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const username = String(req.body?.username || "").trim();
  if (!code || !username) return res.status(400).json({ error: "code and username required!" });
  const state = discordService.loadState();
  const invite = state.invites[code];
  if (!invite) return res.status(404).json({ error: "Invite not found!" });
  if (new Date(invite.expiresAt).getTime() < Date.now())
    return res.status(410).json({ error: "Invite expired!" });
  const banned = (state.bansByCommunity[invite.communityId] || []).some((b) => b.username === username);
  if (banned) return res.status(403).json({ error: "You are banned from this community." });
  discordService.addAudit(state, username, "invite_joined", invite.communityId, { code });
  discordService.saveState(state);
  res.json({ ok: true, communityId: invite.communityId });
});

app.delete("/discord/invite/:code", requireAuth, (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Invite code required!" });
  const state = discordService.loadState();
  const invite = state.invites[code];
  if (!invite) return res.status(404).json({ error: "Invite not found!" });
  const community = ensureDefaultCommunity().find((c) => c.id === invite.communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  delete state.invites[code];
  discordService.saveState(state);
  res.json({ ok: true });
});

app.post("/discord/invite/delete", requireAuth, (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Invite code required!" });
  const state = discordService.loadState();
  const invite = state.invites[code];
  if (!invite) return res.status(404).json({ error: "Invite not found!" });
  const community = ensureDefaultCommunity().find((c) => c.id === invite.communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  delete state.invites[code];
  discordService.saveState(state);
  res.json({ ok: true });
});

app.post("/discord/thread", (req, res) => {
  const channelId = String(req.body?.channelId || "").trim();
  const title = String(req.body?.title || "").trim();
  const createdBy = String(req.body?.createdBy || "").trim();
  if (!channelId || !title || !createdBy) return res.status(400).json({ error: "channelId, title, createdBy required!" });
  const state = discordService.loadState();
  if (!state.threadsByChannel[channelId]) state.threadsByChannel[channelId] = [];
  const thread = {
    id: `thread-${Date.now()}`,
    channelId,
    title,
    createdBy,
    createdAt: new Date().toISOString(),
    archived: false,
  };
  state.threadsByChannel[channelId].push(thread);
  discordService.saveState(state);
  res.json(thread);
});

app.get("/discord/thread/:channelId", (req, res) => {
  const channelId = String(req.params.channelId || "").trim();
  const state = discordService.loadState();
  res.json(state.threadsByChannel[channelId] || []);
});

app.get("/discord/onboarding/:communityId", (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const state = discordService.loadState();
  const config = state.onboardingByCommunity[communityId] || {
    rules: "Be respectful, no spam, follow community rules.",
    questions: ["Why do you want to join?", "What are your interests?"],
    autoRole: "member",
  };
  res.json(config);
});

app.get("/discord/welcome/:communityId", (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const state = discordService.loadState();
  res.json(state.welcomeByCommunity[communityId] || {
    title: "Welcome!",
    message: "Introduce yourself, read the rules, and enjoy the community.",
    image: "",
    enabled: true,
  });
});

app.post("/discord/welcome/:communityId", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const title = String(req.body?.title || "").trim();
  const message = String(req.body?.message || "").trim();
  const image = String(req.body?.image || "").trim();
  const enabled = req.body?.enabled !== false;
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const state = discordService.loadState();
  const community = ensureDefaultCommunity().find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  state.welcomeByCommunity[communityId] = {
    title: title || "Welcome!",
    message: message || "Introduce yourself, read the rules, and enjoy the community.",
    image,
    enabled,
    updatedAt: new Date().toISOString(),
  };
  discordService.saveState(state);
  res.json(state.welcomeByCommunity[communityId]);
});

app.post("/discord/welcome/:communityId/send", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const requestedChannelIds = Array.isArray(req.body?.channelIds) ? req.body.channelIds.map((id) => String(id || "")) : [];
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  if (!requestedChannelIds.length) return res.status(400).json({ error: "Pick at least one channel." });
  const state = discordService.loadState();
  const community = ensureDefaultCommunity().find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });

  const welcome = state.welcomeByCommunity[communityId] || {
    title: "Welcome!",
    message: "Introduce yourself, read the rules, and enjoy the community.",
    image: "",
  };
  const allowedIds = new Set(requestedChannelIds);
  const targetChannels = readChannelsList().filter((channel) => (
    channel.communityId === communityId &&
    allowedIds.has(String(channel.id)) &&
    channel.type !== "voice"
  ));
  if (!targetChannels.length) return res.status(400).json({ error: "No text channels selected." });

  const messages = readDB("messages.json");
  const sentMessages = [];
  const text = `${welcome.title || "Welcome!"}\n${welcome.message || ""}`.trim();
  targetChannels.forEach((channel, index) => {
    const message = {
      id: `welcome-${Date.now()}-${index}`,
      channelId: channel.id,
      username: req.authUser,
      text,
      avatar: req.authUser[0]?.toUpperCase() || "E",
      timestamp: new Date().toISOString(),
      replyTo: null,
      fileUrl: welcome.image || null,
      fileName: welcome.image ? "welcome-image" : null,
      isImage: Boolean(welcome.image),
      poll: null,
      sticker: "",
      reactions: {},
      edited: false,
      pinned: false,
    };
    messages[channel.id] = Array.isArray(messages[channel.id]) ? messages[channel.id] : [];
    messages[channel.id].push(message);
    if (messages[channel.id].length > 200) messages[channel.id] = messages[channel.id].slice(-200);
    sentMessages.push(message);
  });
  writeDB("messages.json", messages);
  sentMessages.forEach((message) => io.to(message.channelId).emit("new_message", message));
  res.json({ ok: true, count: sentMessages.length, messages: sentMessages });
});

app.post("/discord/onboarding/:communityId", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const rules = String(req.body?.rules || "").trim();
  const questions = Array.isArray(req.body?.questions) ? req.body.questions.map((q) => String(q || "").trim()).filter(Boolean).slice(0, 5) : [];
  const autoRole = String(req.body?.autoRole || "member").trim();
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const state = discordService.loadState();
  const community = ensureDefaultCommunity().find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  state.onboardingByCommunity[communityId] = {
    rules: rules || "Be respectful, no spam, follow community rules.",
    questions: questions.length ? questions : ["Why do you want to join?", "What are your interests?"],
    autoRole: autoRole || "member",
  };
  discordService.saveState(state);
  res.json(state.onboardingByCommunity[communityId]);
});

app.post("/discord/onboarding/:communityId/submit", (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const username = String(req.body?.username || "").trim();
  const acceptedRules = Boolean(req.body?.acceptedRules);
  const answers = Array.isArray(req.body?.answers) ? req.body.answers.map((a) => String(a || "").trim()) : [];
  if (!communityId || !username) return res.status(400).json({ error: "communityId and username required!" });
  if (!acceptedRules) return res.status(400).json({ error: "Rules must be accepted." });
  const state = discordService.loadState();
  if (!state.onboardingSubmissionsByCommunity[communityId]) state.onboardingSubmissionsByCommunity[communityId] = {};
  state.onboardingSubmissionsByCommunity[communityId][username] = {
    acceptedRules: true,
    answers: answers.slice(0, 5),
    submittedAt: new Date().toISOString(),
  };
  discordService.saveState(state);
  res.json({ ok: true });
});

app.post("/discord/poll/vote", (req, res) => {
  const channelId = String(req.body?.channelId || "").trim();
  const messageId = String(req.body?.messageId || "").trim();
  const optionId = String(req.body?.optionId || "").trim();
  const username = String(req.body?.username || "").trim();
  if (!channelId || !messageId || !optionId || !username) return res.status(400).json({ error: "channelId, messageId, optionId, username required!" });
  const messages = readDB("messages.json");
  const row = (messages[channelId] || []).find((m) => String(m.id) === messageId);
  if (!row || !row.poll) return res.status(404).json({ error: "Poll not found!" });
  if (!row.poll.votes) row.poll.votes = {};
  row.poll.votes[username] = optionId;
  writeDB("messages.json", messages);
  io.to(channelId).emit("message_poll_updated", { messageId, poll: row.poll });
  res.json({ ok: true, poll: row.poll });
});

app.get("/discord/dm-thread/:a/:b", (req, res) => {
  const a = String(req.params.a || "").trim();
  const b = String(req.params.b || "").trim();
  if (!a || !b) return res.status(400).json({ error: "Both users required!" });
  const state = discordService.loadState();
  const key = discordService.dmKey(a, b);
  res.json(state.dmThreads[key] || []);
});

app.post("/discord/dm-thread", (req, res) => {
  const a = String(req.body?.a || "").trim();
  const b = String(req.body?.b || "").trim();
  const title = String(req.body?.title || "").trim();
  const createdBy = String(req.body?.createdBy || "").trim();
  if (!a || !b || !title || !createdBy) return res.status(400).json({ error: "a, b, title, createdBy required!" });
  const state = discordService.loadState();
  const key = discordService.dmKey(a, b);
  if (!state.dmThreads[key]) state.dmThreads[key] = [];
  const thread = {
    id: `dmthread-${Date.now()}`,
    title,
    createdBy,
    createdAt: new Date().toISOString(),
  };
  state.dmThreads[key].push(thread);
  discordService.saveState(state);
  res.json(thread);
});

app.get("/discord/notifications/:username", (req, res) => {
  const username = String(req.params.username || "").trim();
  if (!username) return res.status(400).json({ error: "Username required!" });
  const state = discordService.loadState();
  discordService.ensureUserCollections(state, username);
  res.json(state.notifications[username]);
});

app.post("/discord/notifications/clear/:username", (req, res) => {
  const username = String(req.params.username || "").trim();
  if (!username) return res.status(400).json({ error: "Username required!" });
  const state = discordService.loadState();
  state.notifications[username] = [];
  discordService.saveState(state);
  res.json({ ok: true });
});

app.post("/discord/notifications/:username/:notificationId/read", (req, res) => {
  const username = String(req.params.username || "").trim();
  const notificationId = String(req.params.notificationId || "").trim();
  if (!username || !notificationId) return res.status(400).json({ error: "Username and notificationId required!" });
  const state = discordService.loadState();
  discordService.ensureUserCollections(state, username);
  const notification = state.notifications[username].find((item) => String(item.id) === notificationId);
  if (!notification) return res.status(404).json({ error: "Notification not found!" });
  notification.readAt = new Date().toISOString();
  discordService.saveState(state);
  res.json(notification);
});

app.delete("/discord/notifications/:username/:notificationId", (req, res) => {
  const username = String(req.params.username || "").trim();
  const notificationId = String(req.params.notificationId || "").trim();
  if (!username || !notificationId) return res.status(400).json({ error: "Username and notificationId required!" });
  const state = discordService.loadState();
  discordService.ensureUserCollections(state, username);
  state.notifications[username] = state.notifications[username].filter((item) => String(item.id) !== notificationId);
  discordService.saveState(state);
  res.json({ ok: true });
});

app.post("/discord/call-invite", (req, res) => {
  const from = String(req.body?.from || "").trim();
  const to = String(req.body?.to || "").trim();
  const channelId = String(req.body?.channelId || "").trim();
  if (!from || !to || !channelId) return res.status(400).json({ error: "from, to, channelId required!" });
  const state = discordService.loadState();
  if (!state.callInvites[to]) state.callInvites[to] = [];
  const invite = {
    id: `call-${Date.now()}`,
    from,
    to,
    channelId,
    createdAt: new Date().toISOString(),
  };
  state.callInvites[to].push(invite);
  state.notifications[to] = state.notifications[to] || [];
  state.notifications[to].push({ id: `notif-${Date.now()}`, type: "call_invite", from, channelId, createdAt: new Date().toISOString() });
  discordService.saveState(state);
  res.json(invite);
});

app.get("/discord/call-invite/:username", (req, res) => {
  const username = String(req.params.username || "").trim();
  if (!username) return res.status(400).json({ error: "Username required!" });
  const state = discordService.loadState();
  res.json(state.callInvites[username] || []);
});

app.get("/discord/audit-log", (req, res) => {
  const state = discordService.loadState();
  res.json(state.auditLog.slice(-300).reverse());
});

// ============================
// CHANNEL ROUTES
// ============================
function readCommunitiesList() {
  const raw = readDB("communities.json");
  if (Array.isArray(raw)) return raw;
  return [];
}
function readMembershipMap() {
  const raw = readDB("community_memberships.json");
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  return {};
}
function writeMembershipMap(map) {
  writeDB("community_memberships.json", map);
}
function ensureMembershipEntry(map, communityId) {
  if (!map[communityId]) map[communityId] = { members: [], pending: [] };
  if (!Array.isArray(map[communityId].members)) map[communityId].members = [];
  if (!Array.isArray(map[communityId].pending)) map[communityId].pending = [];
  return map[communityId];
}
const UPGRADE_TIERS = [
  { id: "supporter", label: "Supporter", title: "Supporter", limit: 15, oneTimePrice: 40, color: "yellow" },
  { id: "echoplus", label: "EchoHub+", title: "EchoHub+", limit: 20, oneTimePrice: 50, color: "black" },
  { id: "echokingplus", label: "EchoKing+", title: "EchoKing+", limit: 25, oneTimePrice: 60, color: "gold" },
];
function getCommunityLimitForPlan(plan) {
  const key = String(plan || "free").toLowerCase();
  if (key === "free") return 10;
  const tier = UPGRADE_TIERS.find((t) => t.id === key);
  if (tier) return tier.limit;
  return 10;
}

function ensureDefaultCommunity() {
  let communities = readCommunitiesList();
  if (!communities.length) {
    communities = [{ id: "echohub", name: "EchoHub", icon: "", owner: "system", createdAt: new Date().toISOString() }];
    writeDB("communities.json", communities);
  }
  return communities;
}
function ensurePersonalCommunityForUser(username) {
  const user = String(username || "").trim();
  if (!user) return null;
  const communities = ensureDefaultCommunity();
  let personal = communities.find((c) => c.personalOwner === user);
  if (!personal) return null;
  const map = readMembershipMap();
  const entry = ensureMembershipEntry(map, personal.id);
  if (!entry.members.includes(user)) {
    entry.members.push(user);
    writeMembershipMap(map);
  }
  ensureSections(personal.id);
  return personal;
}

function readChannelsList() {
  const channels = readDB("channels.json");
  if (!Array.isArray(channels)) return [];
  return channels.map((c) => ({ ...c, communityId: c.communityId || "echohub" }));
}

function ensureGeneralChannel(communityId) {
  const channels = readChannelsList();
  const scoped = channels.filter((c) => c.communityId === communityId);
  if (scoped.length === 0) {
    const general = {
      id: `general-${communityId}`,
      name: "general",
      type: "text",
      category: "Hub",
      communityId,
      description: "Main chat room",
      createdAt: new Date().toISOString(),
    };
    channels.push(general);
    writeDB("channels.json", channels);
    return [general];
  }
  return scoped;
}

function readSectionsMap() {
  const raw = readDB("sections.json");
  if (Array.isArray(raw)) return { echohub: raw };
  if (raw && typeof raw === "object") return raw;
  return {};
}

function ensureSections(communityId) {
  const channels = readChannelsList().filter((c) => c.communityId === communityId);
  const map = readSectionsMap();
  let sections = Array.isArray(map[communityId]) ? map[communityId] : [];
  if (sections.length === 0) {
    const names = [...new Set(channels.map((c) => c.category).filter(Boolean))];
    sections = names.length ? names : ["Hub"];
    map[communityId] = sections;
    writeDB("sections.json", map);
  }
  return sections;
}

function removeCommunityData(communityId) {
  const channels = readChannelsList();
  const removedChannelIds = channels.filter((c) => c.communityId === communityId).map((c) => c.id);
  writeDB("channels.json", channels.filter((c) => c.communityId !== communityId));

  const messages = readDB("messages.json");
  if (messages && typeof messages === "object" && !Array.isArray(messages)) {
    removedChannelIds.forEach((id) => delete messages[id]);
    writeDB("messages.json", messages);
  }

  const sections = readSectionsMap();
  delete sections[communityId];
  writeDB("sections.json", sections);

  const memberships = readMembershipMap();
  delete memberships[communityId];
  writeMembershipMap(memberships);

  const emojis = readCustomEmojiMap();
  delete emojis[communityId];
  writeCustomEmojiMap(emojis);

  const state = discordService.loadState();
  [
    "rolesByCommunity",
    "welcomeByCommunity",
    "onboardingByCommunity",
    "onboardingSubmissionsByCommunity",
    "communityMemberRoles",
    "bansByCommunity",
  ].forEach((key) => {
    if (state[key]) delete state[key][communityId];
  });
  if (state.invites) {
    Object.keys(state.invites).forEach((code) => {
      if (state.invites[code]?.communityId === communityId) delete state.invites[code];
    });
  }
  if (state.permissionsByChannel) removedChannelIds.forEach((id) => delete state.permissionsByChannel[id]);
  if (state.channelSettings) removedChannelIds.forEach((id) => delete state.channelSettings[id]);
  if (state.threadsByChannel) removedChannelIds.forEach((id) => delete state.threadsByChannel[id]);
  discordService.saveState(state);
  return removedChannelIds;
}

app.get("/communities", (req, res) => {
  const username = String(req.query.username || "").trim();
  if (username) ensurePersonalCommunityForUser(username);
  const communities = ensureDefaultCommunity();
  if (!username) return res.json(communities);
  const map = readMembershipMap();
  const visible = communities.filter((community) => {
    if (community.id === "echohub") return true;
    const entry = ensureMembershipEntry(map, community.id);
    return entry.members.includes(username) || community.owner === username;
  });
  res.json(visible);
});

app.get("/communities/discover", (req, res) => {
  const username = String(req.query.username || "").trim();
  if (username) ensurePersonalCommunityForUser(username);
  const communities = ensureDefaultCommunity();
  if (!username) return res.json(communities);
  const map = readMembershipMap();
  const rows = communities.filter((community) => {
    if (community.id === "echohub") return false;
    const entry = ensureMembershipEntry(map, community.id);
    return !entry.members.includes(username) && community.owner !== username;
  }).map((community) => {
    const entry = ensureMembershipEntry(map, community.id);
    return {
      ...community,
      isPending: entry.pending.includes(username),
      memberCount: entry.members.length,
    };
  });
  res.json(rows);
});

app.post("/communities", requireAuth, (req, res) => {
  const name = String(req.body?.name || "").trim();
  const icon = String(req.body?.icon || "").trim();
  if (!name) return res.status(400).json({ error: "Community name required!" });
  const users = readUsersList();
  const me = users.find((u) => u.username === req.authUser);
  if (!me) return res.status(401).json({ error: "User not found!" });
  const planKey = String(me.plan || "free").toLowerCase();
  ensurePersonalCommunityForUser(me.username);
  const createdCount = ensureDefaultCommunity().filter((c) => c.owner === me.username && c.personalOwner !== me.username).length;
  const maxCommunities = getCommunityLimitForPlan(planKey);
  if (createdCount >= maxCommunities) {
    return res.status(403).json({ error: `Plan limit reached (${maxCommunities} communities).` });
  }
  const communities = ensureDefaultCommunity();
  if (communities.find((c) => c.name.toLowerCase() === name.toLowerCase()))
    return res.status(400).json({ error: "Community already exists!" });
  const community = {
    id: `c-${Date.now()}`,
    name,
    icon,
    owner: me.username,
    createdAt: new Date().toISOString(),
  };
  communities.push(community);
  writeDB("communities.json", communities);
  const map = readMembershipMap();
  const entry = ensureMembershipEntry(map, community.id);
  if (!entry.members.includes(me.username)) entry.members.push(me.username);
  writeMembershipMap(map);
  ensureGeneralChannel(community.id);
  ensureSections(community.id);
  io.emit("new_community", community);
  res.json(community);
});

app.post("/communities/:communityId/icon", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const icon = String(req.body?.icon || "").trim();
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  community.icon = icon;
  writeDB("communities.json", communities);
  io.emit("new_community", community);
  res.json(community);
});

app.delete("/communities/:communityId", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  if (communityId === "echohub") return res.status(403).json({ error: "EchoHub Community cannot be deleted." });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const users = readUsersList();
  const global = users.find((u) => u.username === req.authUser);
  const canDelete = community.owner === req.authUser || String(global?.role || "").toLowerCase() === "admin";
  if (!canDelete) return res.status(403).json({ error: "Only the community owner can delete this community." });

  writeDB("communities.json", communities.filter((c) => c.id !== communityId));
  const removedChannelIds = removeCommunityData(communityId);
  io.emit("community_deleted", communityId);
  removedChannelIds.forEach((id) => io.emit("channel_deleted", id));
  res.json({ ok: true, removedChannels: removedChannelIds.length });
});

app.post("/communities/:communityId/apply", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  if (!communityId) return res.status(400).json({ error: "communityId required!" });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const username = req.authUser;
  const state = discordService.loadState();
  const banned = (state.bansByCommunity[communityId] || []).some((b) => b.username === username);
  if (banned) return res.status(403).json({ error: "You are banned from this community." });
  const map = readMembershipMap();
  const entry = ensureMembershipEntry(map, communityId);
  if (entry.members.includes(username)) return res.json({ ok: true, status: "member" });
  if (!entry.pending.includes(username)) entry.pending.push(username);
  writeMembershipMap(map);
  res.json({ ok: true, status: "pending" });
});

app.post("/communities/:communityId/approve", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const username = String(req.body?.username || "").trim();
  if (!communityId || !username) return res.status(400).json({ error: "communityId and username required!" });
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  const map = readMembershipMap();
  const entry = ensureMembershipEntry(map, communityId);
  entry.pending = entry.pending.filter((u) => u !== username);
  if (!entry.members.includes(username)) entry.members.push(username);
  writeMembershipMap(map);
  const onboarding = state.onboardingByCommunity[communityId];
  const autoRole = String(onboarding?.autoRole || "member").trim();
  if (!state.communityMemberRoles[communityId]) state.communityMemberRoles[communityId] = {};
  state.communityMemberRoles[communityId][username] = autoRole || "member";
  discordService.saveState(state);
  res.json({ ok: true });
});

app.get("/communities/:communityId/applications", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  const map = readMembershipMap();
  const entry = ensureMembershipEntry(map, communityId);
  res.json(entry.pending);
});

app.get("/titles", (req, res) => res.json(UPGRADE_TIERS.map((t) => t.title)));
app.get("/upgrade-tiers", (req, res) => {
  const users = readUsersList();
  res.json(UPGRADE_TIERS.map((t) => ({
    id: t.id,
    label: t.label,
    title: t.title,
    communityLimit: t.limit,
    oneTimePrice: t.oneTimePrice,
    purchaseCount: users.filter((u) => String(u.plan || "free").toLowerCase() === t.id).length,
    color: t.color,
  })));
});

app.get("/me/plan", requireAuth, (req, res) => {
  const users = readUsersList();
  const me = users.find((u) => u.username === req.authUser);
  if (!me) return res.status(404).json({ error: "User not found!" });
  ensurePersonalCommunityForUser(me.username);
  res.json({
    plan: me.plan || "free",
    title: me.title || "",
    createdCommunities: ensureDefaultCommunity().filter((c) => c.owner === me.username && c.personalOwner !== me.username).length,
    communityLimit: getCommunityLimitForPlan(me.plan),
  });
});

app.post("/me/upgrade", requireAuth, (req, res) => {
  const paymentMethod = String(req.body?.paymentMethod || "").trim();
  const cardNumber = String(req.body?.cardNumber || "").replace(/\s+/g, "");
  const tierId = String(req.body?.tierId || "").trim().toLowerCase();
  if (!paymentMethod) return res.status(400).json({ error: "Payment method required!" });
  if (!cardNumber || !/^\d{12,19}$/.test(cardNumber)) return res.status(400).json({ error: "Valid card number required (12-19 digits)." });
  const users = readUsersList();
  const me = users.find((u) => u.username === req.authUser);
  if (!me) return res.status(404).json({ error: "User not found!" });
  const tier = UPGRADE_TIERS.find((t) => t.id === tierId);
  if (!tier) return res.status(400).json({ error: "Invalid upgrade option!" });
  const amount = tier.oneTimePrice;
  me.plan = tier.id;
  me.title = tier.title;
  me.planUpdatedAt = new Date().toISOString();
  me.lastPaymentMethod = paymentMethod;
  me.billingCycle = "lifetime";
  me.lastAmount = amount;
  me.lastCardLast4 = cardNumber.slice(-4);
  writeDB("users.json", users);
  res.json({ ok: true, plan: me.plan, title: me.title || "", paymentMethod, tier: tier.label, billingCycle: "lifetime", amount });
});
app.post("/me/cancel-plan", requireAuth, (req, res) => {
  res.status(400).json({ error: "Lifetime upgrades stay with your account forever." });
});
app.post("/me/title", requireAuth, (req, res) => {
  const title = String(req.body?.title || "").trim();
  const users = readUsersList();
  const me = users.find((u) => u.username === req.authUser);
  if (!me) return res.status(404).json({ error: "User not found!" });
  const communities = ensureDefaultCommunity();
  const ownsEchoHub = communities.some((c) => c.id === "echohub" && c.owner === me.username);
  const planKey = String(me.plan || "free").toLowerCase();
  const unlockedTier = UPGRADE_TIERS.find((t) => t.id === planKey);
  const allowed = new Set(["", ...(unlockedTier ? [unlockedTier.title] : []), ...(ownsEchoHub ? ["Creator of EchoHub"] : [])]);
  if (!allowed.has(title)) return res.status(400).json({ error: "Title not allowed." });
  me.title = title;
  writeDB("users.json", users);
  res.json({ ok: true, title: me.title || "" });
});

app.get("/channels", (req, res) => {
  const communityId = req.query.communityId || ensureDefaultCommunity()[0].id;
  res.json(readChannelsList().filter((channel) => channel.communityId === communityId));
});
app.get("/sections", (req, res) => {
  const communityId = req.query.communityId || ensureDefaultCommunity()[0].id;
  res.json(ensureSections(communityId));
});

app.post("/communities/:communityId/apply-discord-template", requireAuth, (req, res) => {
  const communityId = String(req.params.communityId || "").trim();
  const communities = ensureDefaultCommunity();
  const community = communities.find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });

  const templateSections = ["START HERE", "COMMUNITY", "MEDIA", "VOICE CHANNELS", "STAFF"];
  const map = readSectionsMap();
  const existingSections = ensureSections(communityId);
  map[communityId] = [...new Set([...existingSections, ...templateSections])];
  writeDB("sections.json", map);

  const channelTemplates = [
    { name: "welcome", category: "START HERE", description: "Start here and learn what this community is about.", type: "text" },
    { name: "rules", category: "START HERE", description: "Community rules and expectations.", type: "text" },
    { name: "announcements", category: "START HERE", description: "Important updates from staff.", type: "text" },
    { name: "general", category: "COMMUNITY", description: "Main chat.", type: "text" },
    { name: "introductions", category: "COMMUNITY", description: "Introduce yourself.", type: "text" },
    { name: "self-roles", category: "COMMUNITY", description: "Choose your roles.", type: "text" },
    { name: "bot-commands", category: "COMMUNITY", description: "Bot and command testing.", type: "text" },
    { name: "clips-and-images", category: "MEDIA", description: "Share images, clips, and memes.", type: "text" },
    { name: "creations", category: "MEDIA", description: "Show off your work.", type: "text" },
    { name: "Lobby", category: "VOICE CHANNELS", description: "Voice lobby.", type: "voice" },
    { name: "Gaming", category: "VOICE CHANNELS", description: "Gaming voice room.", type: "voice" },
    { name: "Study / Chill", category: "VOICE CHANNELS", description: "Chill voice room.", type: "voice" },
    { name: "staff-chat", category: "STAFF", description: "Staff-only discussion.", type: "text" },
    { name: "mod-log", category: "STAFF", description: "Moderation notes and audit log.", type: "text" },
  ];

  const allChannels = readChannelsList();
  const messages = readDB("messages.json");
  const createdChannels = [];
  channelTemplates.forEach((tpl, index) => {
    const displayName = String(tpl.name || "").trim();
    const normalizedName = displayName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const exists = allChannels.some((c) => c.communityId === communityId && c.name === normalizedName);
    if (exists) return;
    const channel = {
      id: `tmpl-${Date.now()}-${index}`,
      name: normalizedName,
      displayName,
      type: tpl.type === "voice" ? "voice" : "text",
      category: tpl.category,
      communityId,
      description: tpl.description,
      createdAt: new Date().toISOString(),
    };
    allChannels.push(channel);
    messages[channel.id] = messages[channel.id] || [];
    createdChannels.push(channel);
  });
  writeDB("channels.json", allChannels);
  writeDB("messages.json", messages);

  state.rolesByCommunity[communityId] = Array.isArray(state.rolesByCommunity[communityId]) ? state.rolesByCommunity[communityId] : [];
  const roleTemplates = [
    { roleName: "Owner", permissions: ["ban", "kick", "timeout", "manage_roles", "manage_channels", "manage_messages", "view_audit_log"] },
    { roleName: "Admin", permissions: ["ban", "kick", "timeout", "manage_roles", "manage_channels", "manage_messages"] },
    { roleName: "Moderator", permissions: ["ban", "kick", "timeout", "manage_messages", "view_audit_log"] },
    { roleName: "Member", permissions: [] },
    { roleName: "Muted", permissions: [] },
  ];
  roleTemplates.forEach((role, index) => {
    const exists = state.rolesByCommunity[communityId].some((r) => String(r.roleName || "").toLowerCase() === role.roleName.toLowerCase());
    if (!exists) state.rolesByCommunity[communityId].push({ id: `role-template-${Date.now()}-${index}`, ...role, createdAt: new Date().toISOString() });
  });
  state.onboardingByCommunity[communityId] = {
    rules: "Be respectful. No spam, harassment, scams, or NSFW content. Follow staff directions and keep channels on topic.",
    questions: ["Why do you want to join?", "What should people call you?"],
    autoRole: "Member",
  };
  discordService.saveState(state);

  map[communityId].forEach((name) => io.emit("new_section", { name, communityId }));
  createdChannels.forEach((channel) => io.emit("new_channel", channel));
  res.json({ ok: true, sections: map[communityId], createdChannels, roles: state.rolesByCommunity[communityId] });
});

app.post("/sections", (req, res) => {
  const { name, communityId } = req.body;
  const targetCommunityId = communityId || ensureDefaultCommunity()[0].id;
  const section = String(name || "").trim();
  if (!section) return res.status(400).json({ error: "Section name required!" });

  const sections = ensureSections(targetCommunityId);
  if (sections.find((s) => s.toLowerCase() === section.toLowerCase()))
    return res.status(400).json({ error: "Section already exists!" });

  const map = readSectionsMap();
  sections.push(section);
  map[targetCommunityId] = sections;
  writeDB("sections.json", map);
  io.emit("new_section", { name: section, communityId: targetCommunityId });
  res.json({ name: section, communityId: targetCommunityId });
});

app.post("/sections/reorder", requireAuth, (req, res) => {
  const communityId = String(req.body?.communityId || "").trim();
  const order = Array.isArray(req.body?.sections) ? req.body.sections.map((s) => String(s || "").trim()).filter(Boolean) : [];
  if (!communityId || !order.length) return res.status(400).json({ error: "communityId and sections required!" });
  const community = ensureDefaultCommunity().find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  const current = ensureSections(communityId);
  const known = new Set(current.map((s) => s.toLowerCase()));
  const cleaned = [];
  order.forEach((section) => {
    if (known.has(section.toLowerCase()) && !cleaned.some((s) => s.toLowerCase() === section.toLowerCase())) cleaned.push(section);
  });
  current.forEach((section) => {
    if (!cleaned.some((s) => s.toLowerCase() === section.toLowerCase())) cleaned.push(section);
  });
  const map = readSectionsMap();
  map[communityId] = cleaned;
  writeDB("sections.json", map);
  res.json(cleaned);
});

app.delete("/sections", requireAuth, (req, res) => {
  const communityId = String(req.body?.communityId || "").trim();
  const section = String(req.body?.section || "").trim();
  if (!communityId || !section) return res.status(400).json({ error: "communityId and section required!" });
  const community = ensureDefaultCommunity().find((c) => c.id === communityId);
  if (!community) return res.status(404).json({ error: "Community not found!" });
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });

  const map = readSectionsMap();
  const current = Array.isArray(map[communityId]) ? map[communityId] : [];
  const next = current.filter((s) => s.toLowerCase() !== section.toLowerCase());
  const fallback = next[0] || "Hub";
  map[communityId] = next.length ? next : [fallback];
  writeDB("sections.json", map);

  const channels = readChannelsList();
  let movedChannels = 0;
  channels.forEach((channel) => {
    if (channel.communityId === communityId && String(channel.category || "").toLowerCase() === section.toLowerCase()) {
      channel.category = fallback;
      movedChannels += 1;
    }
  });
  writeDB("channels.json", channels);
  io.emit("section_deleted", { communityId, section, fallback });
  res.json({ ok: true, sections: map[communityId], movedChannels });
});

app.post("/channels", (req, res) => {
  const { name, description, category, type, communityId } = req.body;
  const targetCommunityId = communityId || ensureDefaultCommunity()[0].id;
  if (!name) return res.status(400).json({ error: "Channel name required!" });

  const allChannels = readChannelsList();
  const channels = allChannels.filter((channel) => channel.communityId === targetCommunityId);
  const displayName = String(name || "").trim();
  const normalizedName = displayName.toLowerCase().trim().replace(/\s+/g, "-");
  if (channels.find((c) => c.name === normalizedName))
    return res.status(400).json({ error: "Channel already exists!" });

  const newChannel = {
    id: String(Date.now()),
    name: normalizedName,
    displayName,
    type: type === "voice" ? "voice" : "text",
    category: (category || "Custom").trim() || "Custom",
    communityId: targetCommunityId,
    description: description || "",
    createdAt: new Date().toISOString(),
  };
  allChannels.push(newChannel);
  writeDB("channels.json", allChannels);
  const sections = ensureSections(targetCommunityId);
  if (!sections.includes(newChannel.category)) {
    const map = readSectionsMap();
    sections.push(newChannel.category);
    map[targetCommunityId] = sections;
    writeDB("sections.json", map);
    io.emit("new_section", { name: newChannel.category, communityId: targetCommunityId });
  }

  const messages = readDB("messages.json");
  messages[newChannel.id] = [];
  writeDB("messages.json", messages);

  io.emit("new_channel", newChannel);
  res.json(newChannel);
});

app.patch("/channels/:id/rename", requireAuth, (req, res) => {
  const channelId = String(req.params.id || "");
  const displayName = String(req.body?.name || "").trim();
  if (!displayName) return res.status(400).json({ error: "Channel name required!" });
  const channels = readChannelsList();
  const channel = channels.find((c) => String(c.id) === channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found!" });
  const community = ensureDefaultCommunity().find((c) => c.id === channel.communityId);
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });
  const normalizedName = displayName.toLowerCase().trim().replace(/\s+/g, "-");
  const duplicate = channels.some((c) => c.communityId === channel.communityId && String(c.id) !== channelId && c.name === normalizedName);
  if (duplicate) return res.status(400).json({ error: "Channel already exists!" });
  channel.displayName = displayName;
  channel.name = normalizedName;
  writeDB("channels.json", channels);
  io.emit("channel_renamed", channel);
  res.json(channel);
});

app.delete("/channels/:id", requireAuth, (req, res) => {
  const channelId = String(req.params.id || "");
  const channels = readChannelsList();
  const channel = channels.find((c) => String(c.id) === channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found!" });
  const community = ensureDefaultCommunity().find((c) => c.id === channel.communityId);
  const state = discordService.loadState();
  if (!isCommunityStaff(state, community, req.authUser)) return res.status(403).json({ error: "Staff only." });

  writeDB("channels.json", channels.filter((c) => String(c.id) !== channelId));
  const messages = readDB("messages.json");
  if (messages && typeof messages === "object" && !Array.isArray(messages)) {
    delete messages[channelId];
    writeDB("messages.json", messages);
  }
  if (state.permissionsByChannel) delete state.permissionsByChannel[channelId];
  if (state.channelSettings) delete state.channelSettings[channelId];
  if (state.threadsByChannel) delete state.threadsByChannel[channelId];
  discordService.saveState(state);
  io.emit("channel_deleted", channelId);
  res.json({ message: "Channel deleted!" });
});

// ============================
// MESSAGE ROUTES
// ============================
app.get("/messages/:channelId", (req, res) => {
  const messages = readDB("messages.json");
  res.json(messages[req.params.channelId] || []);
});

app.delete("/messages/:channelId/:messageId", requireAuth, (req, res) => {
  const channelId = String(req.params.channelId || "").trim();
  const messageId = String(req.params.messageId || "").trim();
  if (!channelId || !messageId) return res.status(400).json({ error: "channelId and messageId required!" });
  const messages = readDB("messages.json");
  const channelMessages = Array.isArray(messages[channelId]) ? messages[channelId] : [];
  const target = channelMessages.find((message) => String(message.id) === messageId);
  if (!target) return res.status(404).json({ error: "Message not found!" });
  const channels = readChannelsList();
  const channel = channels.find((item) => String(item.id) === channelId) || {};
  const community = ensureDefaultCommunity().find((item) => item.id === channel.communityId) || {};
  const state = discordService.loadState();
  const isAuthor = String(target.username || "").toLowerCase() === String(req.authUser || "").toLowerCase();
  const isStaff = isCommunityStaff(state, community, req.authUser);
  if (!isAuthor && !isStaff) return res.status(403).json({ error: "You can only delete your own messages." });
  messages[channelId] = channelMessages.filter((message) => String(message.id) !== messageId);
  writeDB("messages.json", messages);
  io.emit("message_deleted", { channelId, messageId });
  res.json({ ok: true, channelId, messageId });
});

// Search messages
app.get("/search/:channelId", (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const messages = readDB("messages.json");
  const channelMsgs = messages[req.params.channelId] || [];
  const results = channelMsgs.filter((m) =>
    m.text && m.text.toLowerCase().includes(q.toLowerCase())
  );
  res.json(results);
});

// ============================
// ONLINE USERS
// ============================
let onlineUsers = {};
function getOnlineUserList() {
  const byName = new Map();
  Object.values(onlineUsers).forEach((session) => {
    if (!session?.username) return;
    const existing = byName.get(session.username);
    const existingScore = existing?.presence === "online" ? 2 : existing?.presence === "idle" ? 1 : 0;
    const nextScore = session.presence === "online" ? 2 : session.presence === "idle" ? 1 : 0;
    if (!existing || nextScore > existingScore || Number(session.lastActiveAt || 0) > Number(existing.lastActiveAt || 0)) {
      byName.set(session.username, { ...session, socketId: undefined, sessions: 1 });
    } else {
      existing.sessions = Number(existing.sessions || 1) + 1;
    }
  });
  return [...byName.values()];
}
function broadcastOnlineUsers() {
  io.emit("online_users", getOnlineUserList());
}
app.get("/online", (req, res) => res.json(getOnlineUserList()));

// ============================
// WEBSOCKETS
// ============================
io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);
  socket.emit("online_users", getOnlineUserList());

  socket.on("user_join", (payload) => {
    const username = typeof payload === "string" ? payload : String(payload?.username || "").trim();
    if (!username) return;
    const users = readUsersList();
    const found = users.find((u) => u.username === username);
    const avatar = (typeof payload === "object" && payload?.avatar) || found?.avatar || username.slice(0, 2).toUpperCase();
    const accent = (typeof payload === "object" && payload?.accent) || found?.accent || "#5865f2";
    const role = (typeof payload === "object" && payload?.role) || found?.role || "member";
    const wasOffline = !Object.values(onlineUsers).some((user) => user.username === username);
    onlineUsers[socket.id] = { username, socketId: socket.id, avatar, accent, role, presence: "online", lastActiveAt: Date.now() };
    broadcastOnlineUsers();
    if (wasOffline) io.emit("user_joined", { username, message: `${username} joined EchoHub!` });
  });
  socket.on("presence_update", (payload) => {
    const next = String(payload?.status || "").trim().toLowerCase();
    if (!onlineUsers[socket.id]) return;
    if (next !== "online" && next !== "idle") return;
    onlineUsers[socket.id].presence = next;
    onlineUsers[socket.id].lastActiveAt = Date.now();
    broadcastOnlineUsers();
  });

  socket.on("join_channel", (channelId) => {
    Object.keys(socket.rooms).forEach((room) => {
      if (room !== socket.id) socket.leave(room);
    });
    socket.join(channelId);
  });

  // Send a message
  socket.on("send_message", (data) => {
    const { channelId, username, text, replyTo, fileUrl, fileName, isImage, poll, sticker } = data;
    if (!channelId || !username) return;
    if (!text && !fileUrl) return;

    const newMessage = {
      id: String(Date.now()),
      channelId,
      username,
      text: text || "",
      avatar: username[0].toUpperCase(),
      timestamp: new Date().toISOString(),
      replyTo: replyTo || null,
      fileUrl: fileUrl || null,
      fileName: fileName || null,
      isImage: isImage || false,
      poll: poll && typeof poll === "object" ? poll : null,
      sticker: sticker ? String(sticker) : "",
      reactions: {},
      edited: false,
      pinned: false,
    };

    const messages = readDB("messages.json");
    if (!messages[channelId]) messages[channelId] = [];
    messages[channelId].push(newMessage);
    if (messages[channelId].length > 200)
      messages[channelId] = messages[channelId].slice(-200);
    writeDB("messages.json", messages);

    io.to(channelId).emit("new_message", newMessage);
  });

  // Pin or unpin a message
  socket.on("pin_message", ({ channelId, messageId, pinned }) => {
    const messages = readDB("messages.json");
    if (!messages[channelId]) return;
    const msg = messages[channelId].find((m) => m.id === messageId);
    if (!msg) return;
    msg.pinned = Boolean(pinned);
    writeDB("messages.json", messages);
    io.to(channelId).emit("pin_updated", { messageId, pinned: msg.pinned });
  });

  // Edit a message
  socket.on("edit_message", ({ channelId, messageId, newText }) => {
    const messages = readDB("messages.json");
    if (!messages[channelId]) return;
    const msg = messages[channelId].find((m) => m.id === messageId);
    if (!msg) return;
    msg.text = newText;
    msg.edited = true;
    writeDB("messages.json", messages);
    io.to(channelId).emit("message_edited", { messageId, newText });
  });

  // Delete a message
  socket.on("delete_message", ({ channelId, messageId, username }) => {
    const messages = readDB("messages.json");
    if (!messages[channelId]) return;
    const targetId = String(messageId || "");
    const actor = String((onlineUsers[socket.id] && onlineUsers[socket.id].username) || username || "");
    const target = messages[channelId].find((m) => String(m.id) === targetId);
    if (!target) return;
    if (actor && String(target.username || "").toLowerCase() !== actor.toLowerCase()) return;
    messages[channelId] = messages[channelId].filter((m) => String(m.id) !== targetId);
    writeDB("messages.json", messages);
    io.emit("message_deleted", { channelId, messageId: targetId });
  });

  // React to a message
  socket.on("add_reaction", ({ channelId, messageId, emoji, username }) => {
    const messages = readDB("messages.json");
    if (!messages[channelId]) return;
    const msg = messages[channelId].find((m) => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

    const idx = msg.reactions[emoji].indexOf(username);
    if (idx === -1) {
      msg.reactions[emoji].push(username); // Add reaction
    } else {
      msg.reactions[emoji].splice(idx, 1); // Toggle off
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    }

    writeDB("messages.json", messages);
    io.to(channelId).emit("reaction_updated", { messageId, reactions: msg.reactions });
  });

  // Typing
  socket.on("typing", ({ channelId, username }) => {
    socket.to(channelId).emit("user_typing", { username });
  });

  socket.on("stop_typing", ({ channelId, username }) => {
    socket.to(channelId).emit("user_stop_typing", { username });
  });

  // Disconnect
  socket.on("disconnect", () => {
    const user = onlineUsers[socket.id];
    if (user) {
      delete onlineUsers[socket.id];
      const stillOnline = Object.values(onlineUsers).some((session) => session.username === user.username);
      broadcastOnlineUsers();
      if (!stillOnline) io.emit("user_left", { username: user.username });
    }
  });
});

// ============================
// START SERVER
// ============================
const preferredPort = Number(process.env.PORT) || 3001;
server.listen(preferredPort, () => {
  console.log(`EchoHub running at http://localhost:${preferredPort}`);
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE" && preferredPort === 3001) {
    const fallbackPort = 3002;
    server.listen(fallbackPort, () => {
      console.log(`Port 3001 busy, EchoHub moved to http://localhost:${fallbackPort}`);
    });
    return;
  }
  throw error;
});
