const express = require("express");
const path = require("path");
const helmet = require("helmet");
require("dotenv").config();

const app = express();

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "img-src": ["'self'", "data:", "https:"],
      "media-src": ["'self'", "https:"],
      "frame-src": ["'self'", "https://www.youtube-nocookie.com"],
    },
  },
}));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = require("./db");

require("./auth")(app, db);

app.get("/", async (req, res) => {
  let reciters = [];

  if (db.pool) {
    try {
      const result = await db.query(`
        SELECT
          r.id,
          r.name,
          r.slug,
          r.biography,
          r.image_url,
          (
            SELECT COUNT(*)::int
            FROM recordings a
            WHERE a.reciter_id = r.id
              AND a.is_published = TRUE
          ) AS recordings_count,
          (
            SELECT COUNT(*)::int
            FROM reciter_videos v
            WHERE v.reciter_id = r.id
              AND v.is_published = TRUE
          ) AS videos_count
        FROM reciters r
        WHERE r.is_published = TRUE
        ORDER BY r.sort_order ASC, r.id DESC
      `);

      reciters = result.rows;
    } catch (error) {
      console.error(
        "Homepage reciters query failed:",
        error.code || "database_error"
      );
    }
  }

  res.render("index", { reciters });
});

app.get("/reciters/:slug", async (req, res) => {
  if (!db.pool) {
    return res.status(503).send(
      "قاعدة البيانات غير متاحة حاليًا. يرجى المحاولة لاحقًا."
    );
  }

  try {
    const reciterResult = await db.query(
      `SELECT id, name, slug, biography, image_url
       FROM reciters
       WHERE slug = $1 AND is_published = TRUE
       LIMIT 1`,
      [req.params.slug]
    );

    if (reciterResult.rows.length === 0) {
      return res.status(404).send("القارئ غير موجود أو غير منشور.");
    }

    const reciter = reciterResult.rows[0];

    const [recordingsResult, videosResult] = await Promise.all([
      db.query(
        `SELECT id, surah_number, surah_name, audio_url,
                download_enabled, duration_seconds
         FROM recordings
         WHERE reciter_id = $1 AND is_published = TRUE
         ORDER BY sort_order ASC, surah_number ASC, id ASC`,
        [reciter.id]
      ),
      db.query(
        `SELECT id, title, youtube_video_id
         FROM reciter_videos
         WHERE reciter_id = $1 AND is_published = TRUE
         ORDER BY sort_order ASC, id ASC`,
        [reciter.id]
      )
    ]);

    const recordings = recordingsResult.rows.filter((item) => {
      try {
        const url = new URL(item.audio_url);
        return url.protocol === "https:";
      } catch {
        return false;
      }
    });

    const videos = videosResult.rows.filter((item) =>
      /^[A-Za-z0-9_-]{11}$/.test(item.youtube_video_id || "")
    );

    return res.render("reciter", {
      reciter,
      recordings,
      videos
    });
  } catch (error) {
    console.error(
      "Reciter page query failed:",
      error.code || "database_error"
    );
    return res.status(500).send(
      "حدث خطأ أثناء تحميل صفحة القارئ. يرجى المحاولة لاحقًا."
    );
  }
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
