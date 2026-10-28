const mongoose = require("mongoose");

const playerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ["Batsman", "Bowler", "All-Rounder", "Wicketkeeper"],
      required: true,
    },
    basePrice: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: "Base price must be a whole-number amount." },
    },
    photoUrl: { type: String, default: "" },
    ownerTeam: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
    status: {
      type: String,
      enum: ["Available", "Active", "Sold", "Unsold"],
      default: "Available",
    },
    currentPrice: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: "Current price must be a whole-number amount." },
    },
    winningTeam: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
  },
  { timestamps: true },
);

playerSchema.index({ status: 1, category: 1 });

module.exports = mongoose.model("Player", playerSchema);
