import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SLOT_OPTIONS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00"];
const HISTORY_WINDOW = 7;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

const app = express();
const db = new Database(path.join(__dirname, "data.db"));

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

initDb();

app.get("/api/state", (_req, res) => {
  const history = getHistory();
  const bets = getBets();
  res.json({
    history,
    bets,
    rollover: getRollover(),
    odds: calculateOdds(history),
  });
});

app.post("/api/bets", (req, res) => {
  const { bettor, amount, slot, date } = req.body || {};

  if (!bettor || !amount || !slot || !date || !SLOT_OPTIONS.includes(slot)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const odds = calculateOdds(getHistory())[slot] ?? 1.5;

  const stmt = db.prepare(
    `INSERT INTO bets (id, bettor, amount, slot, date, odds, status, payout, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?)`
  );
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  stmt.run(id, bettor.trim(), amount, slot, date, Number(odds.toFixed(2)), createdAt);

  return res.json({ success: true, state: composeState() });
});

app.post("/api/login", (req, res) => {
  if (!ADMIN_SECRET) {
    return res
      .status(500)
      .json({ error: "ADMIN_SECRET ontbreekt op de server." });
  }
  const { secret } = req.body || {};
  if (!secret) {
    return res.status(400).json({ error: "Secret is verplicht." });
  }
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Ongeldige admin code." });
  }
  return res.json({ success: true });
});

app.post("/api/arrivals", ensureAdmin, (req, res) => {
  const { date, slot } = req.body || {};
  if (!date || !slot || !SLOT_OPTIONS.includes(slot)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const upsert = db.prepare(
    `INSERT INTO arrivals (date, slot, createdAt)
     VALUES (:date, :slot, :createdAt)
     ON CONFLICT(date) DO UPDATE SET slot=:slot`
  );
  upsert.run({ date, slot, createdAt: new Date().toISOString() });

  settleBets(date, slot);

  return res.json({ success: true, state: composeState() });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const port = process.env.PORT || 4173;
app.listen(port, () => {
  console.log(`Bet-a-Ben server running on http://localhost:${port}`);
});

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS arrivals (
      date TEXT PRIMARY KEY,
      slot TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bets (
      id TEXT PRIMARY KEY,
      bettor TEXT NOT NULL,
      amount INTEGER NOT NULL,
      slot TEXT NOT NULL,
      date TEXT NOT NULL,
      odds REAL NOT NULL,
      status TEXT NOT NULL,
      payout REAL NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function composeState() {
  const history = getHistory();
  return {
    history,
    bets: getBets(),
    rollover: getRollover(),
    odds: calculateOdds(history),
  };
}

function getHistory(limit = 30) {
  const stmt = db.prepare(
    `SELECT date, slot FROM arrivals ORDER BY date DESC LIMIT ?`
  );
  return stmt.all(limit);
}

function getBets() {
  const stmt = db.prepare(
    `SELECT id, bettor, amount, slot, date, odds, status, payout, createdAt
     FROM bets
     ORDER BY createdAt DESC`
  );
  return stmt.all();
}

function getRollover() {
  const stmt = db.prepare(`SELECT value FROM meta WHERE key='rollover'`);
  const row = stmt.get();
  return row ? Number(row.value) : 0;
}

function setRollover(value) {
  const stmt = db.prepare(
    `INSERT INTO meta (key, value) VALUES ('rollover', :value)
     ON CONFLICT(key) DO UPDATE SET value=:value`
  );
  stmt.run({ value: String(value) });
}

function calculateOdds(history) {
  const recent = history.slice(0, HISTORY_WINDOW);
  const counts = SLOT_OPTIONS.reduce((acc, slot) => {
    acc[slot] = 0;
    return acc;
  }, {});

  recent.forEach(({ slot }) => {
    counts[slot] = (counts[slot] || 0) + 1;
  });

  const odds = {};
  SLOT_OPTIONS.forEach((slot) => {
    const count = counts[slot] || 0;
    odds[slot] = (HISTORY_WINDOW + SLOT_OPTIONS.length) / (1 + count);
  });
  return odds;
}

function settleBets(date, slot) {
  const openBetsStmt = db.prepare(
    `SELECT * FROM bets WHERE date=? AND status='open'`
  );
  const bets = openBetsStmt.all(date);
  if (!bets.length) return;

  const pot = bets.reduce((sum, bet) => sum + bet.amount, 0);
  const winners = bets.filter((bet) => bet.slot === slot);
  const losers = bets.filter((bet) => bet.slot !== slot);

  if (!winners.length) {
    setRollover(getRollover() + pot);
  } else {
    const totalWinningStake = winners.reduce(
      (sum, bet) => sum + bet.amount,
      0
    );
    winners.forEach((bet) => {
      const share = bet.amount / totalWinningStake;
      const bonusPool = pot - totalWinningStake;
      const payout = Math.round((bet.amount + bonusPool * share) * 100) / 100;
      db.prepare(
        `UPDATE bets SET status='won', payout=? WHERE id=?`
      ).run(payout, bet.id);
    });
  }

  losers.forEach((bet) => {
    db.prepare(
      `UPDATE bets SET status='lost', payout=0 WHERE id=?`
    ).run(bet.id);
  });
}

function ensureAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res
      .status(500)
      .json({ error: "ADMIN_SECRET is niet ingesteld op de server." });
  }
  const header = req.headers["x-admin-key"];
  if (!header || header !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Admin authenticatie vereist." });
  }
  return next();
}

