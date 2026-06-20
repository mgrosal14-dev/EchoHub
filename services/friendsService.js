const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "db", "friends.json");

function readFriendsDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeFriendsDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getFriends(username) {
  const db = readFriendsDB();
  return Array.isArray(db[username]) ? db[username] : [];
}

function addFriend(username, friendUsername) {
  const db = readFriendsDB();
  db[username] = Array.isArray(db[username]) ? db[username] : [];
  db[friendUsername] = Array.isArray(db[friendUsername]) ? db[friendUsername] : [];
  if (!db[username].includes(friendUsername) && username !== friendUsername) {
    db[username].push(friendUsername);
  }
  if (!db[friendUsername].includes(username) && username !== friendUsername) {
    db[friendUsername].push(username);
  }
  writeFriendsDB(db);
  return db[username];
}

module.exports = {
  getFriends,
  addFriend,
};
