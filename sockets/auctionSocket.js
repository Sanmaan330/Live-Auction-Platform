const AuctionSession = require("../models/AuctionSession");
const { verifyToken } = require("../middleware/auth");

function registerAuctionSocket(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string") return next(new Error("Authentication required."));
      const claims = verifyToken(token);
      socket.data.userId = claims.sub;
      socket.data.role = claims.role;
      next();
    } catch (_error) {
      next(new Error("Invalid or expired authentication token."));
    }
  });

  io.on("connection", (socket) => {
    socket.join("auction:lobby");

    socket.on("auction:join", async (auctionId, acknowledge) => {
      try {
        const auction = await AuctionSession.findById(auctionId)
          .populate("player", "name category photoUrl basePrice status")
          .populate("highestBidder", "name")
          .lean();
        if (!auction) return acknowledge?.({ ok: false, error: "Auction not found." });
        await socket.join(`auction:${auctionId}`);
        return acknowledge?.({ ok: true, auction, serverNow: new Date().toISOString() });
      } catch (error) {
        console.error("Auction room join failed:", error);
        return acknowledge?.({ ok: false, error: "Unable to join auction room." });
      }
    });

    socket.on("team:join", async (acknowledge) => {
      try {
        if (socket.data.role !== "owner") {
          return acknowledge?.({ ok: false, error: "Only team owners can join a team room." });
        }
        const User = require("../models/User");
        const user = await User.findById(socket.data.userId).select("team active role");
        if (!user || !user.active || !user.team || user.role !== "owner") {
          return acknowledge?.({ ok: false, error: "Team account is unavailable." });
        }
        await socket.join(`team:${user.team}`);
        return acknowledge?.({ ok: true });
      } catch (error) {
        console.error("Team room join failed:", error);
        return acknowledge?.({ ok: false, error: "Unable to join team room." });
      }
    });
  });
}

module.exports = { registerAuctionSocket };
