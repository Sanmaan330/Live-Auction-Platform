# Boundary Bid — Live Cricket Player Auction

Real-time franchise bidding built with Node.js, Express, MongoDB, Socket.IO, and a responsive HTML/CSS/JavaScript client.

## What is included

- Role-based admin and team-owner sign-in with hashed passwords and signed JWTs.
- Player catalog, live auction lots, team purse/squad dashboard, and accepted-bid feed.
- Server-authoritative deadlines and 10-second anti-sniping extensions.
- MongoDB transaction-based bid acceptance, purse reservation/refunds, idempotent retries, and auction settlement.
- Socket.IO rooms for auction updates and team purse notifications.
- Admin actions to add players and start live lots.

## Requirements

- Node.js 20+
- MongoDB 6+ configured as a **replica set**. MongoDB transactions (used to guarantee bid/purse consistency) are not supported by a standalone MongoDB server.

For a local single-node replica set, start `mongod` with `--replSet rs0`, then run `mongosh` and initialize it once:

```javascript
rs.initiate()
```

Wait for the node to become primary before starting the application.

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and set a random `JWT_SECRET` of at least 32 characters, `MONGODB_URI`, and an admin password of at least 12 characters. For a replica set, a local URI can be:

```text
MONGODB_URI=mongodb://127.0.0.1:27017/cricket_auction?replicaSet=rs0
```

Seed the admin user and optionally demo teams:

```powershell
npm run seed
```

Set `DEMO_TEAM_PASSWORD` in `.env` (at least 12 characters) before seeding to create three demo owners: `mumbai.meteors`, `chennai.chargers`, and `delhi.dynamos`. Their starting purse is ₹100 crore each. To create only the admin, leave that variable empty. Seed is safe to rerun: existing users and purse balances are not reset.

Start the app:

```powershell
npm start
```

Open `http://localhost:3000`. For development with auto-reload, use `npm run dev`. The built-in frontend is served by Express, so the default `CLIENT_ORIGIN=http://localhost:3000` is sufficient for local use.

## Deploy the frontend to Netlify

Netlify can host the **static frontend**, but this application also needs a persistent Node.js backend for Express, Socket.IO, and the auction expiry worker. Do not deploy only `server.js` as Netlify Functions: Socket.IO's long-lived connections and the background expiry worker require a persistent server. Host the backend on a Node service such as Render, Railway, or Fly.io, and use MongoDB Atlas configured as a replica set.

1. Deploy the backend service from this repository with build command `npm install` and start command `npm start`. Configure `MONGODB_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `PORT` (if required by the host), and `CLIENT_ORIGIN` in the backend environment. Set `CLIENT_ORIGIN` to your exact Netlify production origin, for example `https://your-auction-site.netlify.app`. Seed the admin account using the host's shell or a trusted local environment pointed at Atlas.
2. In Netlify, import the same repository and set build command to `npm run build:netlify` and publish directory to `dist` (these are also in `netlify.toml`).
3. Add the Netlify environment variable `AUCTION_BACKEND_URL` with the backend origin, for example `https://your-auction-api.onrender.com`. The optional `AUCTION_SOCKET_URL` defaults to that same origin; set it only if Socket.IO is hosted at another origin.
4. Trigger a Netlify deploy. The build writes the backend URLs to `dist/deploy-config.js`; they are public frontend configuration, so do not put secrets in them.
5. Test login, an auction snapshot, a bid, and the live countdown from the deployed site. The backend must allow the Netlify origin through both Express CORS and Socket.IO CORS.

The Netlify build fails clearly if `AUCTION_BACKEND_URL` is missing or is not HTTPS outside localhost. Local `npm start` continues to use same-origin API and Socket.IO URLs.

## Deploy the frontend to Vercel

Vercel can host the static frontend, but this project's Express/Socket.IO backend and expiry worker need a separate persistent Node.js host. Deploy the backend to Render, Railway, or Fly.io and use MongoDB Atlas; then import the repo into Vercel. The included `vercel.json` builds `dist` with `npm run build:netlify`. Configure `AUCTION_BACKEND_URL` in the Vercel project before deploying. Set the backend's `CLIENT_ORIGIN` to the Vercel production URL, and seed the admin on the backend host. See the Netlify steps above for the backend environment variables and MongoDB setup; they are the same for Vercel.

## Auction rules and money values

All persisted amounts are **integer rupees**, not floating-point values. The demo purse is ₹10,000,000,000 (₹100 crore). Customize the starting purse in `scripts/seed.js` before seeding new teams.

- The first bid must be at least the player's base price.
- Every later bid must be at least the current high bid plus that lot's minimum increment.
- A bid received after the persisted deadline is rejected. A valid bid received with 10 seconds or less remaining extends the deadline to 10 seconds after server receipt.
- Only an authenticated team owner can bid. The team ID is taken from the verified account, never the request body.
- An owner cannot bid on a player whose listing has that same `ownerTeam`.
- The current leader's bid is reserved from the purse. Raising one's own high bid reserves only the difference; being outbid refunds the prior leader in the same transaction.
- A lot closes once. A leader's player is added to their squad; a player with no accepted bid is marked unsold.

When two bids compete, MongoDB's conditional update of the auction `version`/price is the serialization point. The first valid transaction to commit owns the next `bidSequence`. Other requests are retried by the transaction driver when MongoDB reports a transient conflict, then validated against the new price/deadline. Same-price ties are not accepted. The server timestamp and sequence record the accepted ordering; client clocks are never trusted.

## Admin workflow

1. Sign in with the seeded admin credentials.
2. Select **Add player**. Enter a base price and bid increment; optionally select a franchise as the listing owner to prevent that franchise from bidding.
3. Select **Start next lot**, then choose the lot duration. The oldest available player is started.
4. Monitor the live lot and bid feed. The server closes expired auctions automatically; closing is also idempotent if multiple app instances observe the same expiry.

Create team accounts by inserting a `Team` and an associated `User` with `role: "owner"` and a bcrypt password hash, or extend the seed script to fit your onboarding workflow. Never expose admin credentials in browser code.

## HTTP API

All routes below are prefixed with `/api`. Protected routes require `Authorization: Bearer <JWT>`.

| Method | Route | Access | Purpose |
|---|---|---|---|
| POST | `/auth/login` | Public | Sign in with `username` and `password` |
| GET | `/me` | Signed in | Current user and team snapshot |
| GET | `/auctions` | Signed in | Scheduled and active lots |
| GET | `/auctions/:id` | Signed in | Auction snapshot and last 50 bids |
| POST | `/auctions/:id/bids` | Owner | Place a bid; send `Idempotency-Key` header and `{ "amount": 50000000 }` |
| GET | `/dashboard` | Owner | Purse, squad, active bids, and lost players |
| GET | `/admin/teams` | Admin | Listing-owner options |
| GET | `/admin/players` | Admin | Available players |
| POST | `/admin/players` | Admin | Create player |
| POST | `/admin/auctions` | Admin | Start a lot using `{ "playerId", "minIncrement", "durationSeconds" }` |
| POST | `/admin/auctions/:id/close` | Admin | Settle a lot only after its deadline has passed |
| GET | `/health` | Public | Process health check |

Example create-player body:

```json
{
  "name": "Sample Player",
  "category": "All-Rounder",
  "basePrice": 50000000,
  "photoUrl": "",
  "ownerTeamId": null
}
```

## Socket.IO events

Connect using the JWT in the Socket.IO auth payload:

```js
const socket = io({ auth: { token } });
socket.emit("auction:join", auctionId, (snapshot) => console.log(snapshot));
```

| Direction | Event | Data |
|---|---|---|
| Client → server | `auction:join` | Auction ID; acknowledgement includes current snapshot |
| Client → server | `team:join` | No payload; owner joins their private purse room |
| Server → room | `auction:started` | New auction snapshot |
| Server → room | `auction:updated` | Committed auction and bid |
| Server → room | `auction:closed` | Settled auction and player |
| Server → lobby | `auction:summary` | Lot status/price changed; clients refresh their list and dashboard |
| Server → lobby | `auction:tick` | Server clock sync pulse for countdown displays |
| Server → team room | `team:purse` | Updated remaining purse |

Socket events carry committed changes; REST snapshots are the recovery path after reconnects. All client countdowns are calculated from the server-provided `endsAt`. For horizontal scaling, configure the Socket.IO Redis adapter and sticky sessions at the load balancer; MongoDB remains the source of truth.

## Project layout

```text
.
├── config/database.js
├── middleware/auth.js
├── models/
│   ├── AuctionSession.js
│   ├── Bid.js
│   ├── Player.js
│   ├── Team.js
│   └── User.js
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── routes/api.js
├── scripts/seed.js
├── services/auctionService.js
├── sockets/auctionSocket.js
├── server.js
├── .env.example
└── package.json
```

## Production checklist

- Use TLS, a strong secret manager-provided JWT secret, and a restricted `CLIENT_ORIGIN`.
- Use a MongoDB replica set with authentication, backups, and monitoring.
- Configure the Socket.IO adapter/sticky sessions before running multiple web instances.
- Use a shared rate-limit store and add per-account/socket bid throttling for a multi-instance deployment.
- Monitor expiry-worker failures and transaction retries; back up audit-grade bid history.
- Add integration tests against a replica set for simultaneous bids, concurrent purse use across lots, duplicate idempotency keys, deadline boundaries, anti-sniping, and repeated settlement.
