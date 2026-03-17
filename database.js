const initSqlJs = require("sql.js");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "wagenbaas.db");
let db;

async function initDB() {
  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT,
      channel      TEXT NOT NULL,
      direction    TEXT NOT NULL,
      from_id      TEXT,
      from_name    TEXT,
      content      TEXT NOT NULL,
      created_at   DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT, phone TEXT, email TEXT,
      car_brand    TEXT, car_model TEXT, car_year TEXT, license TEXT,
      service      TEXT, pref_date TEXT, pref_time TEXT, notes TEXT,
      channel      TEXT DEFAULT 'webchat',
      status       TEXT DEFAULT 'nieuw',
      created_at   DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS callbacks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT, phone TEXT, reason TEXT,
      channel      TEXT DEFAULT 'webchat',
      status       TEXT DEFAULT 'te bellen',
      created_at   DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS leads (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT, phone TEXT, email TEXT,
      source       TEXT DEFAULT 'webchat', notes TEXT,
      created_at   DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stats (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event        TEXT, channel TEXT, meta TEXT,
      created_at   DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS missed_calls (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      caller       TEXT,
      call_sid     TEXT,
      status       TEXT DEFAULT 'gemist',
      duration     INTEGER DEFAULT 0,
      created_at   DATETIME DEFAULT (datetime('now'))
    );
  `);
  save();
}

function save() {
  if (db) fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function run(sql, p = {}) { db.run(sql, p); save(); }

function all(sql, p = []) {
  const s = db.prepare(sql);
  s.bind(p);
  const rows = [];
  while (s.step()) rows.push(s.getAsObject());
  s.free();
  return rows;
}

function get(sql, p = []) {
  return all(sql, p)[0] || null;
}

const db_ops = {
  // Messages
  insertMessage: (p) => run(`INSERT INTO messages (session_id,channel,direction,from_id,from_name,content) VALUES ($session_id,$channel,$direction,$from_id,$from_name,$content)`, p),
  allMessages: () => all(`SELECT * FROM messages ORDER BY id DESC LIMIT 200`),
  messagesByChannel: (ch) => all(`SELECT * FROM messages WHERE channel=$ch ORDER BY id DESC LIMIT 100`, { $ch: ch }),
  sessionMessages: (sid) => all(`SELECT * FROM messages WHERE session_id=$sid ORDER BY id ASC`, { $sid: sid }),

  // Appointments
  insertAppointment: (p) => run(`INSERT INTO appointments (name,phone,email,car_brand,car_model,car_year,license,service,pref_date,pref_time,notes,channel) VALUES ($name,$phone,$email,$car_brand,$car_model,$car_year,$license,$service,$pref_date,$pref_time,$notes,$channel)`, p),
  allAppointments: () => all(`SELECT * FROM appointments ORDER BY id DESC`),
  updateAppointmentStatus: (p) => run(`UPDATE appointments SET status=$status WHERE id=$id`, p),

  // Callbacks
  insertCallback: (p) => run(`INSERT INTO callbacks (name,phone,reason,channel) VALUES ($name,$phone,$reason,$channel)`, p),
  allCallbacks: () => all(`SELECT * FROM callbacks ORDER BY id DESC`),
  updateCallbackStatus: (p) => run(`UPDATE callbacks SET status=$status WHERE id=$id`, p),

  // Leads
  insertLead: (p) => run(`INSERT INTO leads (name,phone,email,source,notes) VALUES ($name,$phone,$email,$source,$notes)`, p),
  allLeads: () => all(`SELECT * FROM leads ORDER BY id DESC`),
  findLeadByContact: (p) => get(
    `SELECT * FROM leads
     WHERE (phone = $phone AND $phone <> '')
        OR (email = $email AND $email <> '')
     ORDER BY id DESC
     LIMIT 1`,
    p
  ),
  updateLead: (p) => run(
    `UPDATE leads SET
       name   = CASE WHEN $name   IS NOT NULL AND $name   <> '' THEN $name   ELSE name   END,
       phone  = CASE WHEN $phone  IS NOT NULL AND $phone  <> '' THEN $phone  ELSE phone  END,
       email  = CASE WHEN $email  IS NOT NULL AND $email  <> '' THEN $email  ELSE email  END,
       source = CASE WHEN $source IS NOT NULL AND $source <> '' THEN $source ELSE source END,
       notes  = CASE WHEN $notes  IS NOT NULL AND $notes  <> '' THEN $notes  ELSE notes  END
     WHERE id = $id`,
    p
  ),

  // Stats
  insertStat: (p) => run(`INSERT INTO stats (event,channel,meta) VALUES ($event,$channel,$meta)`, p),
  statsCount: () => all(`SELECT event, channel, COUNT(*) as count FROM stats GROUP BY event, channel`),
  todayStats: () => all(`SELECT event, channel, COUNT(*) as count FROM stats WHERE date(created_at)=date('now') GROUP BY event, channel`),
  channelStats: () => all(`SELECT channel, COUNT(*) as count FROM messages WHERE direction='inbound' GROUP BY channel`),

  // Missed calls
  insertMissedCall: (p) => run(`INSERT INTO missed_calls (caller,call_sid,status,duration) VALUES ($caller,$call_sid,$status,$duration)`, p),
  allMissedCalls: () => all(`SELECT * FROM missed_calls ORDER BY id DESC LIMIT 100`),
  updateMissedCallStatus: (p) => run(`UPDATE missed_calls SET status=$status WHERE id=$id`, p),
};

module.exports = { initDB, db: db_ops };
