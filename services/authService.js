const { broadcast, load, publicUser, safeParse, save, send } = require("./store");

function setupAuth(wss) {
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const data = safeParse(raw);
      if (!data) return;

      if (data.type === "signup") {
        const username = String(data.username || "").trim();
        const password = String(data.password || "");

        if (!username || !password) {
          send(ws, { type: "error", message: "Username and password are required." });
          return;
        }

        const users = load("users");
        if (users[username]) {
          send(ws, { type: "error", message: "That username already exists." });
          return;
        }

        users[username] = {
          password,
          avatar: String(data.avatar || ""),
          role: "member",
          status: "New to EchoHub",
          accent: data.accent || "#5865f2"
        };

        save("users", users);
        send(ws, { type: "signupSuccess", message: "Account created. Log in to enter." });
      }

      if (data.type === "login") {
        const users = load("users");
        const username = String(data.username || "").trim();
        const user = users[username];

        if (!user || user.password !== data.password) {
          send(ws, { type: "error", message: "Invalid login." });
          return;
        }

        ws.user = username;
        ws.room = ws.room || "general";
        send(ws, { type: "loginSuccess", user: publicUser(username, user) });
        broadcast(wss, { type: "userJoined", username }, (client) => client !== ws);
      }

      if (data.type === "updateStatus" && ws.user) {
        const users = load("users");
        users[ws.user].status = String(data.status || "").slice(0, 80);
        save("users", users);
      }
    });
  });
}

module.exports = { setupAuth };
