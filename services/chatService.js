const {
  broadcast,
  load,
  publicUser,
  roomMessages,
  safeParse,
  save,
  send,
  slugify
} = require("./store");

function bootstrap(ws) {
  const users = load("users");
  send(ws, {
    type: "bootstrap",
    channels: load("channels"),
    messages: roomMessages(ws.room || "general"),
    members: Object.entries(users).map(([username, user]) => publicUser(username, user))
  });
}

function setupChat(wss) {
  wss.on("connection", (ws) => {
    ws.room = "general";
    bootstrap(ws);

    ws.on("message", (raw) => {
      const data = safeParse(raw);
      if (!data) return;

      if (data.type === "joinRoom") {
        ws.room = data.room || "general";
        send(ws, {
          type: "roomHistory",
          channel: ws.room,
          messages: roomMessages(ws.room)
        });
      }

      if (data.type === "createChannel" && ws.user) {
        const channels = load("channels");
        const name = String(data.channel || "").trim().slice(0, 28);
        const id = slugify(name);

        if (!id || channels.some((channel) => channel.id === id)) {
          return;
        }

        channels.push({
          id,
          name,
          type: data.channelType === "voice" ? "voice" : "text",
          category: String(data.category || "Custom").slice(0, 24)
        });

        save("channels", channels);
        broadcast(wss, { type: "channels", channels });
      }

      if (data.type === "message" && ws.user) {
        const text = String(data.text || "").trim();
        if (!text) return;

        const messages = load("messages");
        const message = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          channel: ws.room || data.channel || "general",
          user: ws.user,
          text: text.slice(0, 1200),
          replyTo: data.replyTo || null,
          createdAt: new Date().toISOString(),
          reactions: {},
          pinned: false
        };

        messages.push(message);
        save("messages", messages.slice(-1000));
        broadcast(wss, { type: "message", message }, (client) => client.room === message.channel);
      }

      if (data.type === "reaction" && ws.user) {
        const messages = load("messages");
        const message = messages.find((item) => item.id === data.messageId);
        if (!message) return;

        const reaction = String(data.reaction || "spark").slice(0, 20);
        message.reactions = message.reactions || {};
        message.reactions[reaction] = message.reactions[reaction] || [];

        const index = message.reactions[reaction].indexOf(ws.user);
        if (index >= 0) {
          message.reactions[reaction].splice(index, 1);
        } else {
          message.reactions[reaction].push(ws.user);
        }

        save("messages", messages);
        broadcast(wss, { type: "messageUpdate", message }, (client) => client.room === message.channel);
      }

      if (data.type === "pin" && ws.user) {
        const messages = load("messages");
        const message = messages.find((item) => item.id === data.messageId);
        if (!message) return;

        message.pinned = !message.pinned;
        save("messages", messages);
        broadcast(wss, { type: "messageUpdate", message }, (client) => client.room === message.channel);
      }

      if (data.type === "typing" && ws.user) {
        broadcast(
          wss,
          { type: "typing", username: ws.user, channel: ws.room },
          (client) => client !== ws && client.room === ws.room
        );
      }
    });
  });
}

module.exports = { setupChat };
