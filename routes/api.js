const bcrypt = require("bcryptjs");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const AuctionSession = require("../models/AuctionSession");
const Bid = require("../models/Bid");
const Player = require("../models/Player");
const Team = require("../models/Team");
const User = require("../models/User");
const { authenticate, authorize } = require("../middleware/auth");
const { AuctionError, closeAuction, placeBid } = require("../services/auctionService");

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });

function asPublicAuction(auction) {
  if (!auction) return null;
  const value = typeof auction.toObject === "function" ? auction.toObject() : auction;
  return {
    id: value._id,
    player: value.player,
    status: value.status,
    basePrice: value.basePrice,
    minIncrement: value.minIncrement,
    currentPrice: value.currentPrice,
    highestBidder: value.highestBidder,
    endsAt: value.endsAt,
    version: value.version,
  };
}

router.post("/auth/login", loginLimiter, async (req, res, next) => {
  try {
    const username = typeof req.body.username === "string" ? req.body.username.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const user = await User.findOne({ username }).select("+passwordHash");
    if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const token = jwt.sign(
      { sub: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "12h" },
    );
    return res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, teamId: user.team?.toString() ?? null },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", authenticate, async (req, res, next) => {
  try {
    const team = req.user.teamId
      ? await Team.findById(req.user.teamId).populate("squad", "name category currentPrice status").lean()
      : null;
    return res.json({ user: req.user, team });
  } catch (error) {
    return next(error);
  }
});

router.get("/auctions", authenticate, async (_req, res, next) => {
  try {
    const auctions = await AuctionSession.find({ status: { $in: ["scheduled", "active"] } })
      .populate("player", "name category photoUrl basePrice status")
      .populate("highestBidder", "name")
      .sort({ status: 1, createdAt: -1 })
      .lean();
    return res.json({ auctions, serverNow: new Date().toISOString() });
  } catch (error) {
    return next(error);
  }
});

router.get("/auctions/:id", authenticate, async (req, res, next) => {
  try {
    const auction = await AuctionSession.findById(req.params.id)
      .populate("player", "name category photoUrl basePrice status")
      .populate("highestBidder", "name")
      .lean();
    if (!auction) return res.status(404).json({ error: "Auction not found." });
    const bids = await Bid.find({ auction: auction._id })
      .populate("team", "name")
      .sort({ sequence: -1 })
      .limit(50)
      .lean();
    return res.json({ auction: asPublicAuction(auction), bids: bids.reverse(), serverNow: new Date().toISOString() });
  } catch (error) {
    return next(error);
  }
});

router.post("/auctions/:id/bids", authenticate, authorize("owner"), async (req, res, next) => {
  try {
    const result = await placeBid({
      auctionId: req.params.id,
      teamId: req.user.teamId,
      amount: req.body.amount,
      idempotencyKey: req.get("idempotency-key"),
    });
    const responseAuctionId = result.auction?._id ?? result.bid.auction;
    const auctionSnapshot = await AuctionSession.findById(responseAuctionId)
        .populate("player", "name category photoUrl basePrice status")
        .populate("highestBidder", "name")
        .lean();
    const payload = {
      auction: asPublicAuction(auctionSnapshot),
      bid: result.bid,
      replayed: result.replayed,
      serverNow: new Date().toISOString(),
    };
    if (!result.replayed) {
      global.auctionIo?.to(`auction:${req.params.id}`).emit("auction:updated", payload);
      global.auctionIo?.to("auction:lobby").emit("auction:summary", {
        auction: payload.auction,
        serverNow: payload.serverNow,
      });
      global.auctionIo?.to(`team:${req.user.teamId}`).emit("team:purse", result.team);
      if (result.refundedTeamPurse) {
        global.auctionIo?.to(`team:${result.refundedTeamPurse.teamId}`).emit("team:purse", {
          id: result.refundedTeamPurse.teamId,
          remainingPurse: result.refundedTeamPurse.remainingPurse,
        });
      }
    }
    return res.status(result.replayed ? 200 : 201).json(payload);
  } catch (error) {
    return next(error);
  }
});

router.get("/dashboard", authenticate, authorize("owner"), async (req, res, next) => {
  try {
    const team = await Team.findById(req.user.teamId)
      .populate("squad", "name category currentPrice photoUrl status")
      .lean();
    if (!team) return res.status(404).json({ error: "Team not found." });

    const acceptedBids = await Bid.find({ team: team._id })
      .populate({ path: "player", select: "name category status currentPrice winningTeam" })
      .sort({ receivedAt: -1 })
      .lean();
    const lostByPlayer = new Map();
    for (const bid of acceptedBids) {
      if (bid.player?.status === "Sold" && bid.player.winningTeam?.toString() !== team._id.toString()) {
        if (!lostByPlayer.has(bid.player._id.toString())) lostByPlayer.set(bid.player._id.toString(), bid.player);
      }
    }
    const activeBids = await AuctionSession.find({
      status: "active",
      highestBidder: team._id,
    }).populate("player", "name category currentPrice").lean();
    return res.json({
      team: { id: team._id, name: team.name, totalPurse: team.totalPurse, remainingPurse: team.remainingPurse },
      squad: team.squad,
      activeBids,
      lostPlayers: [...lostByPlayer.values()],
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/players", authenticate, authorize("admin"), async (req, res, next) => {
  try {
    const { name, category, basePrice, photoUrl = "", ownerTeamId = null } = req.body;
    if (!name || !Number.isSafeInteger(basePrice) || basePrice < 1) {
      return res.status(400).json({ error: "Player name and positive whole-number basePrice are required." });
    }
    if (ownerTeamId && !mongoose.isValidObjectId(ownerTeamId)) {
      return res.status(400).json({ error: "Owner team ID is invalid." });
    }
    if (ownerTeamId && !(await Team.exists({ _id: ownerTeamId }))) {
      return res.status(404).json({ error: "Owner team was not found." });
    }
    const player = await Player.create({ name, category, basePrice, photoUrl, ownerTeam: ownerTeamId });
    return res.status(201).json({ player });
  } catch (error) {
    return next(error);
  }
});

router.get("/admin/players", authenticate, authorize("admin"), async (_req, res, next) => {
  try {
    const players = await Player.find({ status: "Available" }).sort({ createdAt: 1 }).lean();
    return res.json({ players });
  } catch (error) {
    return next(error);
  }
});

router.get("/admin/teams", authenticate, authorize("admin"), async (_req, res, next) => {
  try {
    const teams = await Team.find().select("name").sort({ name: 1 }).lean();
    return res.json({ teams });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/auctions", authenticate, authorize("admin"), async (req, res, next) => {
  try {
    const { playerId, minIncrement, durationSeconds = 60 } = req.body;
    if (!Number.isSafeInteger(minIncrement) || minIncrement < 1
      || !Number.isSafeInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 3600) {
      return res.status(400).json({ error: "Use a positive whole-number increment and duration between 10 and 3600 seconds." });
    }

    const session = await mongoose.startSession();
    let auction;
    try {
      await session.withTransaction(async () => {
        const player = await Player.findOneAndUpdate(
          { _id: playerId, status: "Available" },
          { $set: { status: "Active", currentPrice: 0, winningTeam: null } },
          { new: true, session },
        );
        if (!player) throw new AuctionError("PLAYER_UNAVAILABLE", "Player is missing or already in an auction.", 409);
        auction = await AuctionSession.create([{
          player: player._id,
          status: "active",
          basePrice: player.basePrice,
          minIncrement,
          currentPrice: 0,
          endsAt: new Date(Date.now() + durationSeconds * 1000),
        }], { session });
        auction = auction[0];
      });
    } finally {
      await session.endSession();
    }
    const populated = await AuctionSession.findById(auction._id)
      .populate("player", "name category photoUrl basePrice status")
      .lean();
    global.auctionIo?.emit("auction:started", {
      auction: asPublicAuction(populated),
      serverNow: new Date().toISOString(),
    });
    return res.status(201).json({ auction: populated, serverNow: new Date().toISOString() });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/auctions/:id/close", authenticate, authorize("admin"), async (req, res, next) => {
  try {
    const result = await closeAuction(req.params.id);
    if (!result) return res.status(409).json({ error: "Auction is not expired or is already closed." });
    global.auctionIo?.to(`auction:${req.params.id}`).emit("auction:closed", result);
    global.auctionIo?.to("auction:lobby").emit("auction:summary", {
      auction: result.auction,
      serverNow: result.serverNow,
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
