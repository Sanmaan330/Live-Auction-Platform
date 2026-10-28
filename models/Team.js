const mongoose = require("mongoose");

const teamSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    totalPurse: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: "Purse must be a whole-number amount." },
    },
    // Amount not currently reserved by this team's leading live bids.
    remainingPurse: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: "Purse must be a whole-number amount." },
    },
    squad: [{ type: mongoose.Schema.Types.ObjectId, ref: "Player" }],
  },
  { timestamps: true },
);

module.exports = mongoose.model("Team", teamSchema);
