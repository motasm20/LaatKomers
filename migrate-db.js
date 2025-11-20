import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// Simple, safe migration for bets.amount INTEGER -> REAL
// Usage: node migrate-db.js

const dbPath = path.join(process.cwd(), 'data.db');
if (!fs.existsSync(dbPath)) {
  console.error('No data.db found in current directory. Aborting.');
  process.exit(1);
}

const backupPath = `${dbPath}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
console.log(`Creating backup: ${backupPath}`);
fs.copyFileSync(dbPath, backupPath);
console.log('Backup created. Starting migration...');

const db = new Database(dbPath);
try {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN TRANSACTION;');

  // Create new bets table with amount REAL
  db.exec(`
    CREATE TABLE IF NOT EXISTS bets_new (
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
  `);

  // Copy data, casting amount to REAL and rounding to 2 decimals
  const copyStmt = db.prepare(`
    INSERT OR REPLACE INTO bets_new (id, bettor, amount, slot, date, odds, status, payout, createdAt)
    SELECT id, bettor, ROUND(CAST(amount AS REAL) * 100) / 100.0, slot, date, odds, status, payout, createdAt
    FROM bets;
  `);

  // Only run copy if old bets table exists
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bets';").get();
  if (tableCheck) {
    copyStmt.run();

    // Drop old and rename
    db.exec('DROP TABLE bets;');
    db.exec('ALTER TABLE bets_new RENAME TO bets;');

    console.log('Migration applied: bets.amount converted to REAL.');
  } else {
    console.log('No existing bets table found — nothing to migrate.');
    db.exec('DROP TABLE IF EXISTS bets_new;');
  }

  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');
  console.log('Migration finished successfully.');
  console.log(`Original DB backed up to ${backupPath}`);
} catch (err) {
  console.error('Migration failed, rolling back.', err);
  try {
    db.exec('ROLLBACK;');
  } catch (e) {
    console.error('Rollback failed', e);
  }
  console.error(`You can restore from backup: ${backupPath}`);
  process.exit(2);
} finally {
  db.close();
}
