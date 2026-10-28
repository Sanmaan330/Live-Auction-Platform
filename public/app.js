/* Browser UI: REST loads authoritative snapshots; Socket.IO delivers committed updates. */
const state = {
  token: localStorage.getItem("auctionToken"),
  user: null,
  socket: null,
  auctions: [],
  selectedAuctionId: null,
  selectedAuction: null,
  bids: [],
  dashboard: null,
  clockOffsetMs: 0,
  timer: null,
  toastTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const money = (value) => `₹${Number(value || 0).toLocaleString("en-IN")}`;
const idOf = (value) => value?._id?.toString?.() ?? value?.id?.toString?.() ?? value?.toString?.() ?? "";

function updateClock(serverNow) {
  if (serverNow) state.clockOffsetMs = Date.parse(serverNow) - Date.now();
}

async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const apiBaseUrl = window.AUCTION_CONFIG?.apiUrl || "";
  const response = await fetch(`${apiBaseUrl}/api${url}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  updateClock(data.serverNow);
  if (response.status === 401 && state.token) {
    logout(false);
    throw new Error("Your session expired. Please sign in again.");
  }
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.remove("show"), 3200);
}

function setFeedback(message, kind = "") {
  const element = $("#bid-feedback");
  element.textContent = message;
  element.className = `feedback ${kind}`;
}

function connectSocket() {
  if (!window.io) {
    window.auctionSocketReady?.then(connectSocket).catch((error) => {
      console.error("Socket.IO client failed to load:", error);
      toast("Live updates are unavailable. Check the backend connection.", true);
    });
    return;
  }
  if (state.socket) state.socket.disconnect();
  const socketUrl = window.AUCTION_CONFIG?.socketUrl || undefined;
  state.socket = window.io(socketUrl, { auth: { token: state.token }, reconnection: true });
  state.socket.on("connect", async () => {
    $("#connection-status").classList.add("connected");
    $("#connection-status").innerHTML = "<i></i> Connected";
    if (state.user?.role === "owner") {
      state.socket.emit("team:join", () => refreshDashboard().catch((error) => toast(error.message, true)));
    }
    if (state.selectedAuctionId) joinSelectedAuction();
    await loadAuctions();
  });
  state.socket.on("disconnect", () => {
    $("#connection-status").classList.remove("connected");
    $("#connection-status").innerHTML = "<i></i> Reconnecting";
  });
  state.socket.on("connect_error", () => {
    $("#connection-status").classList.remove("connected");
    $("#connection-status").innerHTML = "<i></i> Connection error";
  });
  state.socket.on("auction:started", async ({ auction, serverNow }) => {
    updateClock(serverNow);
    toast(`${auction.player?.name || "A new player"} is now on the block.`);
    await loadAuctions();
    selectAuction(idOf(auction));
  });
  state.socket.on("auction:summary", async ({ serverNow }) => {
    updateClock(serverNow);
    await loadAuctions();
    if (state.user?.role === "owner") await refreshDashboard();
  });
  state.socket.on("auction:tick", ({ serverNow }) => {
    updateClock(serverNow);
    updateCountdown();
  });
  state.socket.on("auction:updated", async (payload) => {
    updateClock(payload.serverNow);
    if (idOf(payload.auction) === state.selectedAuctionId) {
      if (!state.selectedAuction || Number(payload.auction.version) >= Number(state.selectedAuction.version)) {
        state.selectedAuction = { ...state.selectedAuction, ...payload.auction };
        renderAuction();
      }
      await loadAuctionDetails(state.selectedAuctionId);
    }
    await loadAuctions();
    if (state.user?.role === "owner") await refreshDashboard();
  });
  state.socket.on("auction:closed", async (payload) => {
    updateClock(payload.serverNow);
    if (idOf(payload.auction) === state.selectedAuctionId) {
      state.selectedAuction = { ...state.selectedAuction, ...payload.auction };
      renderAuction();
    }
    toast(payload.player?.winningTeam ? `${payload.player.name} sold!` : `${payload.player?.name || "Player"} went unsold.`);
    await loadAuctions();
    if (state.user?.role === "owner") await refreshDashboard();
  });
  state.socket.on("team:purse", (team) => {
    if (state.dashboard?.team) {
      state.dashboard.team.remainingPurse = team.remainingPurse;
      renderDashboard();
    }
  });
}

async function boot() {
  if (!state.token) return showLogin();
  try {
    const { user } = await api("/me");
    state.user = user;
    showApp();
    await loadAuctions();
    if (user.role === "owner") await refreshDashboard();
  } catch (_error) {
    logout(false);
  }
}

function showLogin() {
  $("#login-view").classList.remove("hidden");
  $("#app-view").classList.add("hidden");
  $("#logout-button").classList.add("hidden");
}

function showApp() {
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#logout-button").classList.remove("hidden");
  $("#user-label").textContent = state.user.username;
  $("#admin-actions").classList.toggle("hidden", state.user.role !== "admin");
  $("#team-dashboard").classList.toggle("hidden", state.user.role !== "owner");
  connectSocket();
}

function logout(showMessage = true) {
  state.token = null;
  state.user = null;
  localStorage.removeItem("auctionToken");
  state.socket?.disconnect();
  clearInterval(state.timer);
  showLogin();
  if (showMessage) toast("You have signed out.");
}

async function loadAuctions() {
  const { auctions } = await api("/auctions");
  state.auctions = auctions;
  renderAuctionList();
  if (!state.selectedAuctionId || !auctions.some((item) => idOf(item) === state.selectedAuctionId)) {
    const active = auctions.find((item) => item.status === "active");
    if (active) selectAuction(idOf(active));
    else if (!state.selectedAuctionId && auctions.length) selectAuction(idOf(auctions[0]));
    else if (state.selectedAuctionId && !auctions.length) clearSelectedAuction();
  }
}

async function selectAuction(auctionId) {
  state.selectedAuctionId = auctionId;
  state.selectedAuction = null;
  state.bids = [];
  if (state.socket?.connected) joinSelectedAuction();
  await loadAuctionDetails(auctionId);
  renderAuctionList();
}

function joinSelectedAuction() {
  if (!state.selectedAuctionId) return;
  state.socket.emit("auction:join", state.selectedAuctionId, (response) => {
    if (response?.ok && idOf(response.auction) === state.selectedAuctionId) {
      updateClock(response.serverNow);
      state.selectedAuction = response.auction;
      renderAuction();
    }
  });
}

async function loadAuctionDetails(auctionId) {
  const { auction, bids } = await api(`/auctions/${auctionId}`);
  if (auctionId === state.selectedAuctionId
    && (!state.selectedAuction || Number(auction.version) >= Number(state.selectedAuction.version))) {
    state.selectedAuction = auction;
    state.bids = bids;
    renderAuction();
  }
}

function clearSelectedAuction() {
  state.selectedAuctionId = null;
  state.selectedAuction = null;
  state.bids = [];
  renderAuction();
  renderAuctionList();
}

function renderAuctionList() {
  const container = $("#auction-list");
  $("#auction-count").textContent = `${state.auctions.length} LOT${state.auctions.length === 1 ? "" : "S"}`;
  if (!state.auctions.length) {
    container.innerHTML = '<p class="empty-state">No auction lots yet.</p>';
    return;
  }
  container.replaceChildren(...state.auctions.map((auction) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `lot-row ${idOf(auction) === state.selectedAuctionId ? "selected" : ""}`;
    const name = document.createElement("span");
    name.className = "lot-main";
    name.textContent = auction.player?.name || "Auction lot";
    const category = document.createElement("span");
    category.className = "lot-sub";
    category.textContent = `${auction.player?.category || "Player"} · ${auction.status.toUpperCase()}`;
    const left = document.createElement("span");
    left.append(name, category);
    const price = document.createElement("span");
    price.className = "lot-price";
    price.textContent = money(auction.currentPrice || auction.basePrice);
    button.append(left, price);
    button.addEventListener("click", () => selectAuction(idOf(auction)));
    return button;
  }));
}

function renderAuction() {
  const auction = state.selectedAuction;
  clearInterval(state.timer);
  if (!auction) {
    $("#player-name").textContent = "Waiting for the next player";
    $("#player-category").textContent = "PLAYER CATEGORY";
    $("#player-meta").textContent = "Choose an active lot to follow the bidding.";
    $("#player-visual").style.backgroundImage = "";
    $("#current-price").innerHTML = "₹0 <span></span>";
    $("#leader-label").textContent = "No leading bid";
    $("#auction-state").textContent = "WAITING";
    $("#auction-state").className = "state-chip";
    $("#countdown").innerHTML = '--<span>SEC</span>';
    $("#lot-number").textContent = "";
    $("#minimum-label").textContent = "";
    $("#bid-button").disabled = true;
    $("#bid-history").innerHTML = '<p class="empty-state">Accepted bids appear here in real time.</p>';
    return;
  }

  const player = auction.player || {};
  $("#lot-number").textContent = `LOT ${String(state.auctions.findIndex((item) => idOf(item) === state.selectedAuctionId) + 1).padStart(2, "0")}`;
  $("#player-name").textContent = player.name || "Player";
  $("#player-category").textContent = (player.category || "PLAYER").toUpperCase();
  $("#player-meta").textContent = `Base price ${money(auction.basePrice)} · Minimum increment ${money(auction.minIncrement)}`;
  $("#player-visual").style.backgroundImage = player.photoUrl ? `linear-gradient(#101a3066,#101a3066),url("${player.photoUrl}")` : "";
  $("#player-visual").style.backgroundSize = "cover";
  $("#player-visual").style.backgroundPosition = "center";
  $("#current-price").innerHTML = `${money(auction.currentPrice)} <span>${auction.currentPrice ? "CURRENT BID" : "BASE PRICE"}</span>`;
  const leader = auction.highestBidder?.name || state.bids.at(-1)?.team?.name;
  $("#leader-label").textContent = leader ? `Leading: ${leader}` : "No leading bid";
  $("#auction-state").textContent = auction.status.toUpperCase();
  $("#auction-state").className = `state-chip ${auction.status === "active" ? "live" : ""}`;
  const minimum = auction.currentPrice ? auction.currentPrice + auction.minIncrement : auction.basePrice;
  $("#minimum-label").textContent = `MIN ${money(minimum)}`;
  const canBid = auction.status === "active" && state.user?.role === "owner";
  $("#bid-button").disabled = !canBid;
  $("#bid-amount").min = minimum;
  if (!$("#bid-amount").value || Number($("#bid-amount").value) < minimum) $("#bid-amount").value = minimum;

  if (auction.status === "active" && auction.endsAt) {
    updateCountdown();
    state.timer = setInterval(updateCountdown, 250);
  } else {
    $("#countdown").innerHTML = auction.status === "closed" ? 'END<span>SEC</span>' : '--<span>SEC</span>';
  }
  renderBidHistory();
}

function updateCountdown() {
  const auction = state.selectedAuction;
  if (!auction?.endsAt) return;
  const remaining = Math.max(0, Math.ceil((new Date(auction.endsAt).getTime() - (Date.now() + state.clockOffsetMs)) / 1000));
  const timer = $("#countdown");
  timer.innerHTML = `${String(remaining).padStart(2, "0")}<span>SEC</span>`;
  timer.classList.toggle("urgent", remaining <= 10 && remaining > 0);
  timer.classList.toggle("expired", remaining === 0);
  if (remaining === 0) $("#bid-button").disabled = true;
}

function renderBidHistory() {
  const container = $("#bid-history");
  if (!state.bids.length) {
    container.innerHTML = '<p class="empty-state">Accepted bids appear here in real time.</p>';
    return;
  }
  container.replaceChildren(...[...state.bids].reverse().map((bid) => {
    const row = document.createElement("div");
    row.className = "bid-row";
    const left = document.createElement("span");
    left.className = "bid-team";
    left.textContent = bid.team?.name || "Team";
    const detail = document.createElement("span");
    detail.className = "bid-detail";
    detail.textContent = new Date(bid.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    left.append(detail);
    const amount = document.createElement("span");
    amount.className = "bid-amount";
    amount.textContent = money(bid.amount);
    row.append(left, amount);
    return row;
  }));
}

async function placeBid() {
  if (!state.selectedAuctionId) return;
  const amount = Number($("#bid-amount").value);
  const idempotencyKey = crypto.randomUUID();
  $("#bid-button").disabled = true;
  setFeedback("Submitting bid…");
  try {
    const result = await api(`/auctions/${state.selectedAuctionId}/bids`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ amount }),
    });
    setFeedback(`Bid accepted at ${money(result.bid.amount)}.`, "success");
    await loadAuctionDetails(state.selectedAuctionId);
    await refreshDashboard();
    await loadAuctions();
  } catch (error) {
    setFeedback(error.message, "error");
  } finally {
    $("#bid-button").disabled = !(state.selectedAuction?.status === "active" && state.user?.role === "owner");
  }
}

async function refreshDashboard() {
  if (state.user?.role !== "owner") return;
  state.dashboard = await api("/dashboard");
  renderDashboard();
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return;
  $("#team-heading").textContent = `${data.team.name} dashboard`;
  $("#remaining-purse").textContent = money(data.team.remainingPurse);
  $("#total-purse").textContent = money(data.team.totalPurse);
  $("#squad-count").textContent = data.squad.length;
  $("#active-bid-count").textContent = data.activeBids.length;
  $("#lost-count").textContent = data.lostPlayers.length;
  renderCompactList("#squad-list", data.squad, "No players won yet.", (player) => [player.name, money(player.currentPrice)]);
  renderCompactList("#lost-list", data.lostPlayers, "No lost bids yet.", (player) => [player.name, "SOLD"]);
}

function renderCompactList(selector, items, emptyMessage, rowValue) {
  const container = $(selector);
  if (!items.length) {
    container.innerHTML = `<p class="empty-state">${emptyMessage}</p>`;
    return;
  }
  container.replaceChildren(...items.map((item) => {
    const row = document.createElement("div");
    row.className = "compact-row";
    const [name, value] = rowValue(item);
    const left = document.createElement("span");
    left.textContent = name;
    const right = document.createElement("span");
    right.textContent = value;
    row.append(left, right);
    return row;
  }));
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";
  try {
    const result = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: $("#username").value, password: $("#password").value }),
    });
    state.token = result.token;
    state.user = result.user;
    localStorage.setItem("auctionToken", result.token);
    showApp();
    await loadAuctions();
    if (state.user.role === "owner") await refreshDashboard();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});

$("#logout-button").addEventListener("click", () => logout());
$("#bid-button").addEventListener("click", placeBid);
$("#bid-amount").addEventListener("keydown", (event) => {
  if (event.key === "Enter") placeBid();
});
document.querySelectorAll("[data-increment]").forEach((button) => {
  button.addEventListener("click", () => {
    const current = Number($("#bid-amount").value || $("#bid-amount").min || 0);
    $("#bid-amount").value = current + Number(button.dataset.increment);
  });
});

$("#add-player-button").addEventListener("click", () => {
  $("#player-dialog").showModal();
  loadAdminTeams().catch((error) => toast(error.message, true));
});
$("#close-player-dialog").addEventListener("click", () => $("#player-dialog").close());
$("#player-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/admin/players", {
      method: "POST",
      body: JSON.stringify({
        name: $("#new-player-name").value,
        category: $("#new-player-category").value,
        basePrice: Number($("#new-player-price").value),
        photoUrl: $("#new-player-photo").value,
        ownerTeamId: $("#new-player-owner").value || null,
      }),
    });
    $("#player-dialog").close();
    $("#player-form").reset();
    toast("Player created. Start the next lot to put them on the block.");
    await loadAvailablePlayerQueue();
  } catch (error) {
    toast(error.message, true);
  }
});

let availablePlayers = [];
async function loadAdminTeams() {
  const { teams } = await api("/admin/teams");
  const ownerSelect = $("#new-player-owner");
  ownerSelect.replaceChildren(new Option("Auctioneer / neutral listing", ""));
  for (const team of teams) ownerSelect.add(new Option(team.name, idOf(team)));
}

async function loadAvailablePlayerQueue() {
  // The admin lot action fetches the available catalog through this endpoint.
  const result = await api("/admin/players");
  availablePlayers = result.players;
}

$("#start-auction-button").addEventListener("click", async () => {
  try {
    if (!availablePlayers.length) await loadAvailablePlayerQueue();
    if (!availablePlayers.length) return toast("Add a player before starting a lot.", true);
    const player = availablePlayers[0];
    const incrementInput = prompt("Minimum bid increment in rupees:", "5000000");
    if (incrementInput === null) return;
    const durationInput = prompt("Lot duration in seconds (10–3600):", "60");
    if (durationInput === null) return;
    const result = await api("/admin/auctions", {
      method: "POST",
      body: JSON.stringify({
        playerId: idOf(player),
        minIncrement: Number(incrementInput),
        durationSeconds: Number(durationInput),
      }),
    });
    toast(`${player.name} is on the block.`);
    availablePlayers = [];
    await loadAuctions();
    selectAuction(idOf(result.auction));
  } catch (error) {
    toast(error.message, true);
    availablePlayers = [];
  }
});

boot();
