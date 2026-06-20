const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "..", "db", "discord.json");

const DEFAULT_STATE = {
  profiles: {},
  friends: {},
  friendRequests: {},
  blocks: {},
  dms: {},
  groups: {},
  rolesByCommunity: {},
  permissionsByChannel: {},
  channelSettings: {},
  invites: {},
  threadsByChannel: {},
  welcomeByCommunity: {},
  onboardingByCommunity: {},
  onboardingSubmissionsByCommunity: {},
  communityMemberRoles: {},
  dmThreads: {},
  bansByCommunity: {},
  notifications: {},
  callInvites: {},
  auditLog: [],
};

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
}

function ensureUserCollections(state, username) {
  if (!state.friends[username]) state.friends[username] = [];
  if (!state.friendRequests[username]) state.friendRequests[username] = { incoming: [], outgoing: [] };
  if (!state.blocks[username]) state.blocks[username] = [];
  if (!state.notifications[username]) state.notifications[username] = [];
}

function dmKey(a, b) {
  return [a, b].sort().join("::");
}

function addAudit(state, actor, action, target, details = {}) {
  state.auditLog.push({
    id: `audit-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    actor,
    action,
    target,
    details,
    createdAt: new Date().toISOString(),
  });
  if (state.auditLog.length > 2000) state.auditLog = state.auditLog.slice(-2000);
}

module.exports = {
  loadState,
  saveState,
  ensureUserCollections,
  dmKey,
  addAudit,
};
