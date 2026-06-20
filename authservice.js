const fs = require("fs");

const USERS_FILE = "./db/users.json";

function loadUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE));
}

function saveUsers(users) {
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify(users, null, 2)
  );
}

function setupAuth(wss) {

  wss.on("connection", (ws) => {

    ws.on("message", (raw) => {

      const data = JSON.parse(raw);
      const users = loadUsers();

      // SIGNUP
      if (data.type === "signup") {

        if (users[data.username]) {
          ws.send(JSON.stringify({
            type: "error",
            message: "Username exists"
          }));
          return;
        }

        users[data.username] = {
          password: data.password,
          avatar: data.avatar
        };

        saveUsers(users);

        ws.send(JSON.stringify({
          type: "signupSuccess"
        }));
      }

      // LOGIN
      if (data.type === "login") {

        const user = users[data.username];

        if (
          !user ||
          user.password !== data.password
        ) {
          ws.send(JSON.stringify({
            type: "error",
            message: "Invalid login"
          }));
          return;
        }

        ws.user = data.username;

        ws.send(JSON.stringify({
          type: "loginSuccess",
          user: {
            username: data.username,
            avatar: user.avatar,
            role: "member"
          }
        }));
      }

    });

  });

}

module.exports = { setupAuth };