import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SLOT_OPTIONS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00"];
const HISTORY_WINDOW = 7;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const HOUSE_MARGIN = Number(process.env.HOUSE_MARGIN ?? 0.12);

const app = express();
const db = new Database(path.join(__dirname, "data.db"));

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

initDb();
seedDefaultTopic();
ensureBetTopicColumn();

app.get("/api/state", (_req, res) => {
  const history = getHistory();
  const bets = getBets();
  res.json({
    history,
    bets,
    rollover: getRollover(),
    odds: calculateOdds(history),
    topics: getTopics(),
    activeTopic: getActiveTopic(),
  });
});

app.post("/api/bets", (req, res) => {
  const { bettor, amount, slot, date } = req.body || {};

  const numericAmount = Number(amount);
  if (
    !bettor ||
    !slot ||
    !date ||
    !SLOT_OPTIONS.includes(slot) ||
    !isFinite(numericAmount) ||
    numericAmount <= 0
  ) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Store amounts rounded to cents
  const storedAmount = Math.round(numericAmount * 100) / 100;

  const odds = calculateOdds(getHistory())[slot] ?? 1.5;
  const activeTopic = getActiveTopic();
  const topicId = activeTopic?.id || null;

  const stmt = db.prepare(
    `INSERT INTO bets (id, bettor, amount, slot, date, odds, status, payout, createdAt, topicId)
     VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`
  );
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  stmt.run(
    id,
    bettor.trim(),
    storedAmount,
    slot,
    date,
    Number(odds.toFixed(2)),
    createdAt,
    topicId
  );

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

app.post("/api/topics", ensureAdmin, (req, res) => {
  const { title, description } = req.body || {};
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "Titel is verplicht" });
  }
  const topic = createTopic(title.trim(), (description || "").trim());
  return res.json({ success: true, topic, state: composeState() });
});

app.post("/api/topics/:id/activate", ensureAdmin, (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "Topic id ontbreekt" });
  const exists = db.prepare(`SELECT id FROM topics WHERE id=?`).get(id);
  if (!exists) return res.status(404).json({ error: "Topic niet gevonden" });
  setActiveTopic(id);
  return res.json({ success: true, state: composeState() });
});

app.delete("/api/bets/:id", ensureAdmin, (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "Bet id ontbreekt" });

  const stmt = db.prepare(`DELETE FROM bets WHERE id = ?`);
  const info = stmt.run(id);
  if (!info.changes) {
    return res.status(404).json({ error: "Bet niet gevonden" });
  }

  return res.json({ success: true, state: composeState() });
});

app.delete("/api/arrivals/:date", ensureAdmin, (req, res) => {
  const { date } = req.params;
  if (!date) return res.status(400).json({ error: "Datum ontbreekt" });

  const existing = db.prepare(`SELECT * FROM arrivals WHERE date=?`).get(date);
  if (!existing) {
    return res.status(404).json({ error: "Deze dag heeft geen log." });
  }

  unsolveBets(date);
  db.prepare(`DELETE FROM arrivals WHERE date=?`).run(date);

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
      amount REAL NOT NULL,
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
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      isActive INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
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
    `SELECT b.id, b.bettor, b.amount, b.slot, b.date, b.odds, b.status, b.payout, b.createdAt,
            t.title AS topicTitle
     FROM bets b
     LEFT JOIN topics t ON t.id = b.topicId
     ORDER BY b.createdAt DESC`
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

function adjustRollover(delta) {
  if (!delta) return;
  const current = getRollover();
  const next = Math.max(0, current + delta);
  setRollover(next);
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
    adjustRollover(pot);
  } else {
    let totalPaid = 0;
    winners.forEach((bet) => {
      const gross = bet.amount * (bet.odds || 1);
      const marginCut = gross * HOUSE_MARGIN;
      const payout = Math.max(
        0,
        Math.round((gross - marginCut) * 100) / 100
      );
      totalPaid += payout;
      db.prepare(
        `UPDATE bets SET status='won', payout=? WHERE id=?`
      ).run(payout, bet.id);
    });

    const houseDelta = pot - totalPaid;
    if (houseDelta !== 0) {
      adjustRollover(houseDelta);
    }
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

function unsolveBets(date) {
  const bets = db
    .prepare(`SELECT * FROM bets WHERE date=? AND status!='open'`)
    .all(date);
  if (!bets.length) return;

  const winners = bets.filter((bet) => bet.status === "won");
  const pot = bets.reduce((sum, bet) => sum + bet.amount, 0);
  const totalPaid = winners.reduce((sum, bet) => sum + (bet.payout || 0), 0);
  const houseDelta = pot - totalPaid;
  if (houseDelta !== 0) {
    adjustRollover(-houseDelta);
  }
  db.prepare(`UPDATE bets SET status='open', payout=0 WHERE date=?`).run(date);
}

function ensureBetTopicColumn() {
  const columns = db.prepare(`PRAGMA table_info(bets)`).all();
  if (!columns.some((col) => col.name === "topicId")) {
    db.exec(`ALTER TABLE bets ADD COLUMN topicId TEXT`);
  }
  const activeTopic = getActiveTopic();
  if (activeTopic) {
    db.prepare(`UPDATE bets SET topicId = ? WHERE topicId IS NULL`).run(activeTopic.id);
  }
}

function seedDefaultTopic() {
  const total = db.prepare(`SELECT COUNT(*) as total FROM topics`).get().total;
  if (total === 0) {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO topics (id, title, description, isActive, createdAt)
       VALUES (?, ?, ?, 1, ?)`
    ).run(
      id,
      "Laatkomer",
      "Voorspel hoe laat de stagiair binnenwandelt.",
      new Date().toISOString()
    );
    setActiveTopic(id);
  } else if (!getActiveTopic()) {
    const first = db
      .prepare(`SELECT id FROM topics ORDER BY createdAt ASC LIMIT 1`)
      .get();
    if (first) {
      setActiveTopic(first.id);
    }
  }
}

function getTopics() {
  return db
    .prepare(
      `SELECT id, title, description, isActive, createdAt
       FROM topics
       ORDER BY createdAt DESC`
    )
    .all();
}

function getActiveTopic() {
  const meta = db.prepare(`SELECT value FROM meta WHERE key='active_topic_id'`).get();
  if (meta?.value) {
    const topic = db
      .prepare(`SELECT id, title, description FROM topics WHERE id=?`)
      .get(meta.value);
    if (topic) {
      return topic;
    }
  }
  const fallback = db
    .prepare(
      `SELECT id, title, description FROM topics WHERE isActive=1 ORDER BY createdAt ASC LIMIT 1`
    )
    .get();
  if (fallback) {
    setActiveTopic(fallback.id);
    return fallback;
  }
  return null;
}

function setActiveTopic(id) {
  db.prepare(`UPDATE topics SET isActive = CASE WHEN id=? THEN 1 ELSE 0 END`).run(id);
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('active_topic_id', :value)
     ON CONFLICT(key) DO UPDATE SET value=:value`
  ).run({ value: id });
}

function createTopic(title, description) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO topics (id, title, description, isActive, createdAt)
     VALUES (?, ?, ?, 0, ?)`
  ).run(id, title, description, new Date().toISOString());
  if (!getActiveTopic()) {
    setActiveTopic(id);
  }
  return { id, title, description };
}

