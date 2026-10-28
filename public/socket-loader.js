// Load the Socket.IO client from the backend that hosts the Socket.IO server.
window.auctionSocketReady = new Promise((resolve, reject) => {
  const socketUrl = window.AUCTION_CONFIG?.socketUrl || "";
  const script = document.createElement("script");
  script.src = `${socketUrl}/socket.io/socket.io.js`;
  script.onload = resolve;
  script.onerror = () => reject(new Error("Could not load the Socket.IO client."));
  document.head.append(script);
});
