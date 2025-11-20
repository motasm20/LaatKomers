const API_BASE = window.API_BASE || "";
const SLOT_OPTIONS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00"];
const HISTORY_WINDOW = 7;
const HISTORY_DISPLAY = 14;
const ADMIN_KEY_STORAGE = "betaben_admin_key";
const REFRESH_INTERVAL_MS = 15000;

const state = {
  history: [],
  bets: [],
  rollover: 0,
  odds: {},
  isAdmin: false,
  adminKey: null,
};

const elements = {};
let refreshTimer = null;
let isRefreshing = false;

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  prepareForms();
  initAdminControls();
  refreshState();
  startAutoRefresh();
});

function cacheElements() {
  elements.slotOptions = document.getElementById("slotOptions");
  elements.oddsBoard = document.getElementById("oddsBoard");
  elements.betForm = document.getElementById("betForm");
  elements.betsTable = document.getElementById("betsTable");
  elements.arrivalForm = document.getElementById("arrivalForm");
  elements.historyList = document.getElementById("historyList");
  elements.arrivalSlot = document.getElementById("arrivalSlot");
  elements.betDate = document.getElementById("betDate");
  elements.arrivalDate = document.getElementById("arrivalDate");
  elements.streakValue = document.getElementById("streakValue");
  elements.hotSlot = document.getElementById("hotSlot");
  elements.potValue = document.getElementById("potValue");
  elements.adminSecret = document.getElementById("adminSecret");
  elements.adminLoginButton = document.getElementById("adminLoginButton");
  elements.adminLogoutButton = document.getElementById("adminLogoutButton");
  elements.adminStatus = document.getElementById("adminStatus");
}

function prepareForms() {
  const todayISO = toISODate(new Date());
  elements.betDate.value = todayISO;
  elements.arrivalDate.value = todayISO;

  renderSlotRadioButtons();
  renderArrivalSlotOptions();

  elements.betForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(elements.betForm);
    const bettor = formData.get("bettor").trim();
    const amount = Number(formData.get("amount"));
    const date = formData.get("date");
    const slot = formData.get("slot");

    if (!bettor || !slot) return;
    await postJSON(`${API_BASE}/api/bets`, { bettor, amount, slot, date });
    elements.betForm.reset();
    elements.betDate.value = date;
    refreshState();
  });

  elements.arrivalForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(elements.arrivalForm);
    const date = formData.get("date");
    const slot = formData.get("slot");
    if (!state.isAdmin || !state.adminKey) {
      setAdminStatus("Admin login vereist om te loggen.", true);
      updateAdminUI();
      return;
    }
    try {
      await postJSON(
        `${API_BASE}/api/arrivals`,
        { date, slot },
        {
          "x-admin-key": state.adminKey,
        }
      );
      setAdminStatus("Aankomst geregistreerd ✅");
      refreshState();
    } catch (err) {
      if (err.status === 401) {
        clearAdminKey();
        setAdminStatus("Code verlopen of fout. Log opnieuw in.", true);
      } else {
        setAdminStatus("Registreren mislukt. Probeer opnieuw.", true);
      }
      updateAdminUI();
    }
  });
}

async function refreshState() {
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    const payload = await fetchJSON(`${API_BASE}/api/state`);
    state.history = payload.history ?? [];
    state.bets = payload.bets ?? [];
    state.rollover = payload.rollover ?? 0;
    state.odds = payload.odds ?? {};
    renderOddsBoard();
    renderHistory();
    renderBetsTable();
    renderHeroStats();
  } catch (err) {
    console.warn("Failed to refresh state", err);
  } finally {
    isRefreshing = false;
  }
}

function renderSlotRadioButtons() {
  elements.slotOptions.innerHTML = "";
  SLOT_OPTIONS.forEach((slot, index) => {
    const label = document.createElement("label");
    label.className = "slot-option";
    label.innerHTML = `
      <input type="radio" name="slot" value="${slot}" ${index === 2 ? "checked" : ""}/>
      <span>${slot}</span>
      <span class="multiplier">x<span data-slot="${slot}">--</span></span>
    `;
    label.addEventListener("click", () => {
      elements.slotOptions
        .querySelectorAll(".slot-option")
        .forEach((el) => el.classList.remove("active"));
      label.classList.add("active");
      label.querySelector("input").checked = true;
    });
    if (index === 2) {
      label.classList.add("active");
    }
    elements.slotOptions.appendChild(label);
  });
}

function renderArrivalSlotOptions() {
  elements.arrivalSlot.innerHTML = SLOT_OPTIONS.map(
    (slot) => `<option value="${slot}">${slot}</option>`
  ).join("");
}

function renderOddsBoard() {
  elements.oddsBoard.innerHTML = "";
  SLOT_OPTIONS.forEach((slot) => {
    const value = state.odds[slot] ?? 1;
    const pill = document.createElement("div");
    pill.className = "odds-pill";
    pill.innerHTML = `
      <strong>${slot}</strong>
      <span>x${value.toFixed(2)}</span>
    `;
    elements.oddsBoard.appendChild(pill);

    const multiplierSpan = elements.slotOptions.querySelector(
      `[data-slot="${slot}"]`
    );
    if (multiplierSpan) {
      multiplierSpan.textContent = value.toFixed(2);
    }
  });
}

function renderHistory() {
  const sorted = state.history
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, HISTORY_DISPLAY);

  if (!sorted.length) {
    elements.historyList.innerHTML = "<li>Nog geen geschiedenis.</li>";
    return;
  }

  elements.historyList.innerHTML = sorted
    .map(
      ({ date, slot }) => `
        <li>
          <span>${formatDate(date)}</span>
          <strong>${slot}</strong>
        </li>
      `
    )
    .join("");
}

function renderBetsTable() {
  if (!state.bets.length) {
    elements.betsTable.innerHTML = `<tr><td colspan="6">Geen inzetten... nog 😉</td></tr>`;
    return;
  }

  const rows = state.bets
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((bet) => {
      const chipClass =
        bet.status === "won"
          ? "won"
          : bet.status === "lost"
          ? "lost"
          : "open";
      const payout =
        bet.status === "won"
          ? `+${bet.payout}`
          : bet.status === "lost"
          ? `- ${bet.amount}`
          : "-";
      return `
        <tr>
          <td>${formatDate(bet.date)}</td>
          <td>${bet.bettor}</td>
          <td>${bet.slot}</td>
          <td>${bet.amount}</td>
          <td><span class="status-chip ${chipClass}">${bet.status}</span></td>
          <td>${payout}</td>
        </tr>
      `;
    })
    .join("");

  elements.betsTable.innerHTML = rows;
}

function renderHeroStats() {
  const elevenStreak = getStreakForSlot("11:00");
  const hotSlot = getHotSlot();
  const pot = state.bets
    .filter((bet) => bet.status === "open")
    .reduce((sum, bet) => sum + bet.amount, 0);

  elements.streakValue.textContent = elevenStreak;
  elements.hotSlot.textContent = hotSlot || "n/a";
  elements.potValue.textContent = pot + state.rollover;
}

function getStreakForSlot(slot) {
  const sorted = state.history.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  let streak = 0;
  for (const entry of sorted) {
    if (entry.slot === slot) streak += 1;
    else break;
  }
  return streak;
}

function getHotSlot() {
  const entries = Object.entries(state.odds);
  if (!entries.length) return null;
  return entries.sort((a, b) => a[1] - b[1])[0][0];
}

function initAdminControls() {
  loadAdminKey();
  elements.adminLoginButton.addEventListener("click", async () => {
    const secret = elements.adminSecret.value.trim();
    if (!secret) {
      setAdminStatus("Vul een code in.", true);
      return;
    }
    try {
      await postJSON(`${API_BASE}/api/login`, { secret });
      state.adminKey = secret;
      state.isAdmin = true;
      sessionStorage.setItem(ADMIN_KEY_STORAGE, secret);
      elements.adminSecret.value = "";
      setAdminStatus("Admin modus actief ✅");
    } catch (err) {
      setAdminStatus("Code ongeldig.", true);
      return;
    }
    updateAdminUI();
  });

  elements.adminLogoutButton.addEventListener("click", () => {
    clearAdminKey();
    setAdminStatus("Uitgelogd.");
    updateAdminUI();
  });

  updateAdminUI();
}

function loadAdminKey() {
  const stored = sessionStorage.getItem(ADMIN_KEY_STORAGE);
  if (stored) {
    state.adminKey = stored;
    state.isAdmin = true;
    setAdminStatus("Admin modus actief ✅");
  } else {
    clearAdminKey();
  }
}

function clearAdminKey() {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  state.adminKey = null;
  state.isAdmin = false;
}

function updateAdminUI() {
  if (!elements.arrivalForm) return;
  const lockable = elements.arrivalForm.querySelectorAll("[data-lockable='true']");
  lockable.forEach((el) => {
    el.disabled = !state.isAdmin;
  });
  elements.adminLogoutButton.hidden = !state.isAdmin;
  elements.adminLoginButton.disabled = state.isAdmin;
  elements.adminSecret.disabled = state.isAdmin;
  elements.adminSecret.placeholder = state.isAdmin ? "Admin actief" : "Geheime code";
  elements.adminStatus.classList.toggle("active", state.isAdmin);
  elements.adminStatus.classList.toggle("error", false);
}

function setAdminStatus(message, isError = false) {
  if (!elements.adminStatus) return;
  elements.adminStatus.textContent = message;
  elements.adminStatus.classList.toggle("active", state.isAdmin && !isError);
  elements.adminStatus.classList.toggle("error", isError);
}

function startAutoRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    refreshState();
  }, REFRESH_INTERVAL_MS);
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function formatDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${day}-${month}-${year}`;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

async function postJSON(url, payload, extraHeaders = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = new Error(`Request failed: ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

