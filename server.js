require("dotenv").config();

const http = require("http");
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const { Server } = require("socket.io");
const { connectDatabase } = require("./config/database");
const api = require("./routes/api");
const { closeExpiredAuctions } = require("./services/auctionService");
const { registerAuctionSocket } = require("./sockets/auctionSocket");

const app = express();
const server = http.createServer(app);
const allowedOrigins = [...new Set([
  ...(process.env.CLIENT_ORIGIN || "http://localhost:3000").split(","),
  "https://live-auction-platform-h7d2.onrender.com",
].map((origin) => origin.trim()))];
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});
global.auctionIo = io;

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "https:", "data:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
}));
app.use(express.json({ limit: "32kb" }));
app.use("/api", api);

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use(express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));
app.use("/public", express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));

app.use((error, _req, res, _next) => {
  if (error.name === "AuctionError") {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error.name === "ValidationError" || error.name === "CastError") {
    return res.status(400).json({ error: error.message });
  }
  if (error.code === 11000) {
    return res.status(409).json({ error: "A record with that value already exists." });
  }
  console.error("Request failed:", error);
  return res.status(500).json({ error: "An unexpected server error occurred." });
});

registerAuctionSocket(io);

let expiryTimer;
async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be configured with at least 32 characters.");
  }
  await connectDatabase();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`Auction server listening on port ${port}.`));
  expiryTimer = setInterval(() => {
    global.auctionIo.to("auction:lobby").emit("auction:tick", {
      serverNow: new Date().toISOString(),
    });
    closeExpiredAuctions().catch((error) => console.error("Auction expiry scan failed:", error));
  }, 1000);
  expiryTimer.unref();
}

async function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  clearInterval(expiryTimer);
  io.close();
  server.close(async () => {
    const mongoose = require("mongoose");
    await mongoose.disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

if (require.main === module) {
  start().catch((error) => {
    console.error("Server startup failed:", error);
    process.exit(1);
  });
}

module.exports = { app, server, start };
