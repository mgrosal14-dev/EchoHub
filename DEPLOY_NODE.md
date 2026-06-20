# Deploy EchoHub To A Node Host

GitHub Pages can only host static files. EchoHub's full app needs `server.js` running for login, chat, uploads, friends, calls, Socket.IO, and saved JSON data.

## Quick Deploy

1. Push this repo to GitHub.
2. Create a new Node/Web service on a Node host such as Render, Railway, Fly.io, or Heroku-style hosts.
3. Use these commands:

```bash
npm install
npm start
```

4. Make sure the host sets a `PORT` environment variable. EchoHub already reads `process.env.PORT`.
5. Open the live Node service URL, not the GitHub Pages URL.

## Render

This repo includes `render.yaml`, so Render can detect the app as a Node web service.

Settings if you create it manually:

```text
Build Command: npm install
Start Command: npm start
Environment: Node
```

## Important

Uploads and JSON files are stored on the server filesystem right now. On many free hosts, files can reset after redeploys or restarts unless you add persistent storage.

For a real public EchoHub later, move these to a database/storage service:

```text
db/*.json
uploads/
```

Good next upgrades:

```text
Database: MongoDB Atlas, PostgreSQL, or Supabase
Uploads: Cloudinary, S3-compatible storage, or persistent host disk
```
