const jwt = require("jsonwebtoken");
const User = require("../models/User");

function getTokenFromRequest(req) {
  const header = req.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

function verifyToken(token) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be configured with at least 32 characters.");
  }
  return jwt.verify(token, process.env.JWT_SECRET);
}

async function authenticate(req, res, next) {
  try {
    const token = getTokenFromRequest(req);
    if (!token) return res.status(401).json({ error: "Authentication required." });
    const claims = verifyToken(token);
    const user = await User.findById(claims.sub).select("username role team active");
    if (!user || !user.active) return res.status(401).json({ error: "Account is unavailable." });
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      teamId: user.team?.toString() ?? null,
    };
    return next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Invalid or expired authentication token." });
    }
    return next(error);
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You are not allowed to perform this action." });
    }
    return next();
  };
}

module.exports = { authenticate, authorize, verifyToken };
