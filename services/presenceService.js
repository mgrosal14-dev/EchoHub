const { broadcast, load, publicUser, safeParse } = require("./store");

function getOnline(wss) {
  const users = load("users");
  const seen = new Set();
  const online = [];

  wss.clients.forEach((ws) => {
    if (ws.user && users[ws.user] && !seen.has(ws.user)) {
      seen.add(ws.user);
      online.push(publicUser(ws.user, users[ws.user]));
    }
  });

  return online;
}

function setupPresence(wss) {
  function updatePresence() {
    broadcast(wss, { type: "presence", online: getOnline(wss) });
  }

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const data = safeParse(raw);
      if (!data) return;

      if (["login", "updateStatus", "message", "joinRoom"].includes(data.type)) {
        updatePresence();
      }
    });

    ws.on("close", updatePresence);
  });
}

module.exports = { setupPresence };
