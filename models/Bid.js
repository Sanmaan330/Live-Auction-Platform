const mongoose = require("mongoose");

const bidSchema = new mongoose.Schema(
  {
    auction: { type: mongoose.Schema.Types.ObjectId, ref: "AuctionSession", required: true },
    player: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true },
    team: { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: "Bid must be a whole-number amount." },
    },
    receivedAt: { type: Date, required: true },
    sequence: { type: Number, required: true },
    idempotencyKey: { type: String, required: true },
  },
  { timestamps: true },
);

bidSchema.index({ team: 1, idempotencyKey: 1 }, { unique: true });
bidSchema.index({ auction: 1, sequence: 1 }, { unique: true });

module.exports = mongoose.model("Bid", bidSchema);
