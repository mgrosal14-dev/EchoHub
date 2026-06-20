const channels = ["general", "gaming"];

function setupChat(wss) {

  wss.on("connection", (ws) => {

    ws.room = "general";

    ws.send(JSON.stringify({
      type: "channels",
      channels
    }));

    ws.on("message", (raw) => {

      const data = JSON.parse(raw);

      // JOIN ROOM
      if (data.type === "joinRoom") {
        ws.room = data.room;
      }

      // CREATE CHANNEL
      if (data.type === "createChannel") {

        if (!channels.includes(data.channel)) {

          channels.push(data.channel);

          wss.clients.forEach(client => {

            client.send(JSON.stringify({
              type: "channels",
              channels
            }));

          });

        }

      }

      // MESSAGE
      if (data.type === "message") {

        wss.clients.forEach(client => {

          if (client.room === ws.room) {

            client.send(JSON.stringify({
              type: "message",
              message: {
                user: ws.user,
                text: data.text,
                channel: ws.room
              }
            }));

          }

        });

      }

    });

  });

}

module.exports = { setupChat };