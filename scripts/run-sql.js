#!/usr/bin/env node
// Apply a .sql file to the DalOS database. Reads DATABASE_URL from the environment
// or from a local .env (gitignored) — the password is never passed on the command
// line or printed. Usage: node scripts/run-sql.js path/to/file.sql
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

// load DATABASE_URL from .env if not already in the environment (no printing of it)
function loadEnv() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/run-sql.js <file.sql>"); process.exit(2); }
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Create a gitignored .env with:\n  DATABASE_URL=postgresql://postgres.sfyjvgjwvtwkrnqrvqyc:<PASSWORD>@<host>:5432/postgres");
  process.exit(2);
}

// Build the connection config. If DB_PASSWORD is set, use discrete fields so the
// password is passed literally — a password with URL-special chars (@ : / ? # %)
// would otherwise be mangled by the connection-string parser.
function connConfig() {
  const base = { ssl: { rejectUnauthorized: false } };
  if (process.env.DB_PASSWORD) {
    const u = new URL(process.env.DATABASE_URL);
    return Object.assign(base, {
      host: u.hostname, port: +u.port || 5432,
      user: decodeURIComponent(u.username),
      database: u.pathname.replace(/^\//, "") || "postgres",
      password: process.env.DB_PASSWORD,
    });
  }
  return Object.assign(base, { connectionString: process.env.DATABASE_URL });
}

(async () => {
  const sql = fs.readFileSync(file, "utf8");
  const client = new Client(connConfig());
  const t0 = Date.now();
  try {
    await client.connect();
    const res = await client.query(sql);        // multi-statement file; pg returns the last (or an array)
    const results = Array.isArray(res) ? res : [res];
    const last = results[results.length - 1];
    console.log(`OK  ${path.basename(file)}  statements=${results.length}  lastCommand=${last.command || "-"}  rowCount=${last.rowCount == null ? "-" : last.rowCount}  (${Date.now() - t0}ms)`);
  } catch (e) {
    console.error(`FAILED ${path.basename(file)}: ${e.message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
