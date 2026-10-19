const express = require("express");
const path = require("path");
const helmet = require("helmet");
require("dotenv").config();

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.render("index");
});

app.get("/health/db", async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({
      status: "error",
      database: "not_configured"
    });
  }

  const { Client } = require("pg");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    query_timeout: 8000
  });

  try {
    await client.connect();
    await client.query("SELECT 1");
    return res.status(200).json({
      status: "ok",
      database: "connected"
    });
  } catch (error) {
    console.error("Database health check failed:", error.code || "connection_error");
    return res.status(503).json({
      status: "error",
      database: "connection_failed"
    });
  } finally {
    await client.end().catch(() => {});
  }
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "basaer-platform"
  });
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Basaer is running on port ${port}`);
});
