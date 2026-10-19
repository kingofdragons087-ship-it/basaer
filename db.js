const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      allowExitOnIdle: true
    })
  : null;

if (pool) {
  pool.on("error", (error) => {
    console.error(
      "Unexpected database pool error:",
      error.code || "database_error"
    );
  });
}

async function query(text, params = []) {
  if (!pool) {
    const error = new Error("Database is not configured");
    error.code = "DATABASE_NOT_CONFIGURED";
    throw error;
  }

  return pool.query(text, params);
}

module.exports = {
  pool,
  query
};
