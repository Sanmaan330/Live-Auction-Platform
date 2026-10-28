const mongoose = require("mongoose");
const AuctionSession = require("../models/AuctionSession");
const Bid = require("../models/Bid");
const Player = require("../models/Player");
const Team = require("../models/Team");

const SNIPE_WINDOW_MS = 10_000;
const EXTENSION_MS = 10_000;

class AuctionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AuctionError";
    this.code = code;
    this.status = status;
  }
}

async function placeBid({ auctionId, teamId, amount, idempotencyKey }) {
  if (!mongoose.isValidObjectId(auctionId) || !mongoose.isValidObjectId(teamId)) {
    throw new AuctionError("INVALID_ID", "Auction or team ID is invalid.");
  }
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new AuctionError("INVALID_AMOUNT", "Bid must be a positive whole number of currency units.");
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 100) {
    throw new AuctionError("INVALID_IDEMPOTENCY_KEY", "A valid idempotency key is required.");
  }

  const previousRequest = await Bid.findOne({ team: teamId, idempotencyKey })
    .populate("team", "name")
    .lean();
  if (previousRequest) {
    if (previousRequest.auction.toString() !== auctionId) {
      throw new AuctionError("IDEMPOTENCY_KEY_REUSED", "This request key was already used for another auction.");
    }
    return { bid: previousRequest, replayed: true };
  }

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = undefined;
      const now = new Date();
      const auction = await AuctionSession.findById(auctionId).session(session);
      if (!auction || auction.status !== "active") {
        throw new AuctionError("AUCTION_NOT_ACTIVE", "This auction is not accepting bids.", 409);
      }
      if (!auction.endsAt || auction.endsAt <= now) {
        throw new AuctionError("AUCTION_ENDED", "The bidding deadline has passed.", 409);
      }

      const minimum = auction.currentPrice === 0
        ? auction.basePrice
        : auction.currentPrice + auction.minIncrement;
      if (amount < minimum) {
        throw new AuctionError("BID_TOO_LOW", `The minimum valid bid is ${minimum}.`, 409);
      }

      const team = await Team.findById(teamId).session(session);
      if (!team) throw new AuctionError("TEAM_NOT_FOUND", "Your team could not be found.", 404);

      const player = await Player.findById(auction.player).select("ownerTeam status").session(session);
      if (!player || player.status !== "Active") {
        throw new AuctionError("PLAYER_UNAVAILABLE", "This player is no longer available.", 409);
      }
      if (player.ownerTeam?.equals(team._id)) {
        throw new AuctionError("OWN_LISTING", "A team cannot bid on its own player.", 403);
      }

      const previousLeader = auction.highestBidder?.toString() ?? null;
      const sameLeader = previousLeader === team.id;
      const reserveAmount = sameLeader ? amount - auction.currentPrice : amount;
      let refundedTeamPurse = null;

      const updatedTeam = await Team.findOneAndUpdate(
        { _id: team._id, remainingPurse: { $gte: reserveAmount } },
        { $inc: { remainingPurse: -reserveAmount } },
        { new: true, session },
      );
      if (!updatedTeam) {
        throw new AuctionError("PURSE_EXCEEDED", "Insufficient available purse.", 409);
      }

      if (previousLeader && !sameLeader) {
        const refund = await Team.updateOne(
          { _id: previousLeader },
          { $inc: { remainingPurse: auction.currentPrice } },
          { session },
        );
        if (refund.matchedCount !== 1) {
          throw new AuctionError("LEADER_TEAM_MISSING", "Previous leading team could not be found.", 500);
        }
        const refundedTeam = await Team.findById(previousLeader).select("remainingPurse").session(session);
        refundedTeamPurse = { teamId: previousLeader, remainingPurse: refundedTeam.remainingPurse };
      }

      const newDeadline = auction.endsAt.getTime() - now.getTime() <= SNIPE_WINDOW_MS
        ? new Date(now.getTime() + EXTENSION_MS)
        : auction.endsAt;
      const sequence = auction.bidSequence + 1;
      const updatedAuction = await AuctionSession.findOneAndUpdate(
        {
          _id: auction._id,
          status: "active",
          version: auction.version,
          currentPrice: auction.currentPrice,
          bidSequence: auction.bidSequence,
          endsAt: { $gt: now },
        },
        {
          $set: {
            currentPrice: amount,
            highestBidder: team._id,
            endsAt: newDeadline,
            bidSequence: sequence,
          },
          $inc: { version: 1 },
        },
        { new: true, session },
      );
      if (!updatedAuction) {
        throw new AuctionError("BID_CONFLICT", "Auction state changed. Please retry against the latest price.", 409);
      }

      const [bid] = await Bid.create(
        [{
          auction: auction._id,
          player: auction.player,
          team: team._id,
          amount,
          receivedAt: now,
          sequence,
          idempotencyKey,
        }],
        { session },
      );
      result = {
        bid: { ...bid.toObject(), team: { _id: team._id, name: team.name } },
        auction: updatedAuction.toObject(),
        team: { id: updatedTeam.id, remainingPurse: updatedTeam.remainingPurse },
        refundedTeamPurse,
        replayed: false,
      };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    return result;
  } catch (error) {
    if (error.code === 11000) {
      const duplicate = await Bid.findOne({ team: teamId, idempotencyKey })
        .populate("team", "name")
        .lean();
      if (duplicate) {
        if (duplicate.auction.toString() !== auctionId) {
          throw new AuctionError("IDEMPOTENCY_KEY_REUSED", "This request key was already used for another auction.", 409);
        }
        return { bid: duplicate, replayed: true };
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function closeAuction(auctionId) {
  const session = await mongoose.startSession();
  let closed;
  try {
    await session.withTransaction(async () => {
      closed = null;
      const now = new Date();
      const auction = await AuctionSession.findOne({
        _id: auctionId,
        status: "active",
        endsAt: { $lte: now },
      }).session(session);

      // Conditional state transition makes duplicate worker runs harmless.
      if (!auction) return;

      const transitioned = await AuctionSession.findOneAndUpdate(
        { _id: auction._id, status: "active", version: auction.version, endsAt: { $lte: now } },
        { $set: { status: "closed", closedAt: now }, $inc: { version: 1 } },
        { new: true, session },
      );
      if (!transitioned) return;

      const playerUpdate = auction.highestBidder
        ? {
            status: "Sold",
            currentPrice: auction.currentPrice,
            winningTeam: auction.highestBidder,
          }
        : { status: "Unsold", currentPrice: 0, winningTeam: null };
      const player = await Player.findOneAndUpdate(
        { _id: auction.player, status: "Active" },
        { $set: playerUpdate },
        { new: true, session },
      );
      if (!player) {
        throw new AuctionError("PLAYER_STATE_CONFLICT", "Player state could not be settled.", 409);
      }

      if (auction.highestBidder) {
        const teamUpdate = await Team.updateOne(
          { _id: auction.highestBidder, squad: { $ne: auction.player } },
          { $addToSet: { squad: auction.player } },
          { session },
        );
        if (teamUpdate.matchedCount !== 1) {
          throw new AuctionError("WINNER_TEAM_MISSING", "Winning team could not be found.", 500);
        }
      }
      closed = {
        auction: transitioned.toObject(),
        player: player.toObject(),
        serverNow: new Date().toISOString(),
      };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    return closed;
  } finally {
    await session.endSession();
  }
}

async function closeExpiredAuctions() {
  const expired = await AuctionSession.find({
    status: "active",
    endsAt: { $lte: new Date() },
  }).select("_id").lean();

  for (const auction of expired) {
    try {
      const result = await closeAuction(auction._id);
      if (result) {
        global.auctionIo?.to(`auction:${auction._id}`).emit("auction:closed", result);
        global.auctionIo?.to("auction:lobby").emit("auction:summary", {
          auction: result.auction,
          serverNow: result.serverNow,
        });
      }
    } catch (error) {
      console.error(`Failed to close expired auction ${auction._id}:`, error);
    }
  }
}

module.exports = { AuctionError, closeAuction, closeExpiredAuctions, placeBid };
