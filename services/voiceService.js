const { broadcast, safeParse, send } = require("./store");

function voiceUsers(wss, room) {
  const users = [];
  wss.clients.forEach((client) => {
    if (client.voiceRoom === room && client.user) {
      users.push(client.user);
    }
  });
  return users;
}

function setupVoice(wss) {
  wss.on("connection", (ws) => {
    ws.voiceRoom = null;

    ws.on("message", (raw) => {
      const data = safeParse(raw);
      if (!data) return;

      if (data.type === "joinVoice" && ws.user) {
        ws.voiceRoom = data.room || "voice-lounge";
        broadcast(wss, {
          type: "voicePresence",
          room: ws.voiceRoom,
          users: voiceUsers(wss, ws.voiceRoom)
        });
      }

      if (data.type === "leaveVoice" && ws.user) {
        const oldRoom = ws.voiceRoom;
        ws.voiceRoom = null;
        if (oldRoom) {
          broadcast(wss, { type: "voicePresence", room: oldRoom, users: voiceUsers(wss, oldRoom) });
        }
      }

      if (["offer", "answer", "candidate"].includes(data.type)) {
        wss.clients.forEach((client) => {
          if (client !== ws && client.voiceRoom && client.voiceRoom === ws.voiceRoom) {
            send(client, { ...data, from: ws.user });
          }
        });
      }
    });

    ws.on("close", () => {
      if (ws.voiceRoom) {
        broadcast(wss, { type: "voicePresence", room: ws.voiceRoom, users: voiceUsers(wss, ws.voiceRoom) });
      }
    });
  });
}

module.exports = { setupVoice };
