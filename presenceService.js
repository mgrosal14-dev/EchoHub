function setupPresence(wss) {

  function updatePresence() {

    const online = [];

    wss.clients.forEach(ws => {
      if (ws.user) {
        online.push(ws.user);
      }
    });

    wss.clients.forEach(ws => {

      ws.send(JSON.stringify({
        type: "presence",
        online
      }));

    });

  }

  wss.on("connection", (ws) => {

    ws.on("message", () => {
      updatePresence();
    });

    ws.on("close", () => {
      updatePresence();
    });

  });

}

module.exports = { setupPresence };