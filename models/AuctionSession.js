const mongoose = require("mongoose");

const auctionSessionSchema = new mongoose.Schema(
  {
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Player",
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ["scheduled", "active", "closed", "cancelled"],
      default: "scheduled",
    },
    basePrice: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: "Base price must be a whole-number amount." },
    },
    minIncrement: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: "Minimum increment must be a whole-number amount." },
    },
    currentPrice: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: "Current price must be a whole-number amount." },
    },
    highestBidder: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
    endsAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
    bidSequence: { type: Number, default: 0 },
  },
  { timestamps: true },
);

auctionSessionSchema.index({ status: 1, endsAt: 1 });

module.exports = mongoose.model("AuctionSession", auctionSessionSchema);
