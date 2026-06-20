function setupVoice(wss) {

  wss.on("connection", (ws) => {

    ws.voiceRoom = null;

    ws.on("message", (raw) => {

      const data = JSON.parse(raw);

      // JOIN VOICE ROOM
      if (data.type === "joinVoice") {
        ws.voiceRoom = data.room;
      }

      // SIGNALING
      if (
        data.type === "offer" ||
        data.type === "answer" ||
        data.type === "candidate"
      ) {

        wss.clients.forEach(client => {

          if (
            client !== ws &&
            client.voiceRoom === ws.voiceRoom
          ) {

            client.send(JSON.stringify(data));

          }

        });

      }

    });

  });

}

module.exports = { setupVoice };