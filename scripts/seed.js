require("dotenv").config();

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { connectDatabase } = require("../config/database");
const Team = require("../models/Team");
const User = require("../models/User");

const STARTING_PURSE = 10_000_000_000; // 100 crore, in rupees.
const demoTeams = ["Mumbai Meteors", "Chennai Chargers", "Delhi Dynamos"];

async function seed() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("Set JWT_SECRET to at least 32 characters before seeding.");
  }
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
    throw new Error("Set ADMIN_USERNAME and an ADMIN_PASSWORD of at least 12 characters.");
  }

  await connectDatabase();
  const adminHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  await User.updateOne(
    { username: process.env.ADMIN_USERNAME.trim().toLowerCase() },
    {
      $setOnInsert: {
        username: process.env.ADMIN_USERNAME.trim().toLowerCase(),
        passwordHash: adminHash,
        role: "admin",
        team: null,
        active: true,
      },
    },
    { upsert: true },
  );
  console.log(`Admin account ready: ${process.env.ADMIN_USERNAME}`);

  if (process.env.DEMO_TEAM_PASSWORD) {
    if (process.env.DEMO_TEAM_PASSWORD.length < 12) {
      throw new Error("DEMO_TEAM_PASSWORD must contain at least 12 characters.");
    }
    const passwordHash = await bcrypt.hash(process.env.DEMO_TEAM_PASSWORD, 12);
    for (const name of demoTeams) {
      const team = await Team.findOneAndUpdate(
        { name },
        { $setOnInsert: { name, totalPurse: STARTING_PURSE, remainingPurse: STARTING_PURSE, squad: [] } },
        { upsert: true, new: true },
      );
      const username = name.toLowerCase().replace(/[^a-z0-9]+/g, ".");
      await User.updateOne(
        { username },
        {
          $setOnInsert: {
            username,
            passwordHash,
            role: "owner",
            team: team._id,
            active: true,
          },
        },
        { upsert: true },
      );
      console.log(`Demo team ready: ${username}`);
    }
  } else {
    console.log("Skipping demo teams (DEMO_TEAM_PASSWORD is not set).");
  }

  await mongoose.disconnect();
}

seed().catch(async (error) => {
  console.error("Seeding failed:", error);
  await mongoose.disconnect();
  process.exitCode = 1;
});
