const mongoose = require("mongoose");
const models = [
  require("../models/AuctionSession"),
  require("../models/Bid"),
  require("../models/Player"),
  require("../models/Team"),
  require("../models/User"),
];

async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required.");
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
  });
  const topology = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!topology.setName && topology.msg !== "isdbgrid") {
    await mongoose.disconnect();
    throw new Error("MongoDB must be a replica set or sharded cluster to support auction transactions.");
  }
  await Promise.all(models.map((model) => model.init()));
  console.log("Connected to MongoDB.");
}

module.exports = { connectDatabase };
