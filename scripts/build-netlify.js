const fs = require("fs");
const path = require("path");

const backendUrl = process.env.AUCTION_BACKEND_URL?.trim().replace(/\/+$/, "");
if (!backendUrl) {
  throw new Error("Set AUCTION_BACKEND_URL to the deployed Express backend URL in Netlify environment variables.");
}

let parsedUrl;
try {
  parsedUrl = new URL(backendUrl);
} catch {
  throw new Error("AUCTION_BACKEND_URL must be an absolute URL.");
}

if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
  throw new Error("AUCTION_BACKEND_URL must use HTTPS outside local development.");
}

const socketUrl = (process.env.AUCTION_SOCKET_URL || backendUrl).trim().replace(/\/+$/, "");
let parsedSocketUrl;
try {
  parsedSocketUrl = new URL(socketUrl);
} catch {
  throw new Error("AUCTION_SOCKET_URL must be an absolute URL.");
}
if (parsedSocketUrl.protocol !== "https:" && parsedSocketUrl.hostname !== "localhost" && parsedSocketUrl.hostname !== "127.0.0.1") {
  throw new Error("AUCTION_SOCKET_URL must use HTTPS outside local development.");
}

const outputDirectory = path.join(__dirname, "..", "dist");
fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.cpSync(path.join(__dirname, "..", "public"), outputDirectory, { recursive: true });
fs.writeFileSync(
  path.join(outputDirectory, "deploy-config.js"),
  `window.AUCTION_CONFIG = ${JSON.stringify({ apiUrl: backendUrl, socketUrl })};\n`,
);
console.log(`Built Netlify frontend in ${outputDirectory}.`);
