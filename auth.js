const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const PgSession = require("connect-pg-simple")(session);
const multer = require("multer");

function setupAuth(app, db) {
  const production = process.env.NODE_ENV === "production";
  const callbackURL =
    process.env.GOOGLE_CALLBACK_URL ||
    "https://basaer-0eju.onrender.com/auth/google/callback";

  app.set("trust proxy", 1);

  app.use(session({
    store: db.pool ? new PgSession({
      pool: db.pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }) : undefined,
    name: "basaer.sid",
    secret: process.env.SESSION_SECRET || require("crypto").randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: production,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  }));

  app.use(passport.initialize());
  app.use(passport.session());

  app.use((req, res, next) => {
    res.locals.currentUser = req.user || null;
    next();
  });

  const configured = Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.SESSION_SECRET &&
    db.pool
  );

  if (configured) {
    passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL
    }, async (_accessToken, _refreshToken, profile, done) => {
      try {
        const emailRecord = profile.emails && profile.emails[0];
        const email = emailRecord && emailRecord.value
          ? emailRecord.value.trim().toLowerCase()
          : null;

        if (!profile.id || !email || emailRecord.verified !== true) {
          return done(null, false, {
            message: "يلزم حساب Google ببريد إلكتروني موثّق."
          });
        }

        const ownerEmails = (
          process.env.OWNER_EMAILS ||
          process.env.OWNER_EMAIL ||
          ""
        )
          .split(",")
          .map(email => email.trim().toLowerCase())
          .filter(Boolean);

        const client = await db.pool.connect();

        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock($1)", [7483921]);

          let result = await client.query(
            `SELECT id, google_sub, email, display_name, avatar_url,
                    role, is_active
             FROM users
             WHERE google_sub = $1
             LIMIT 1
             FOR UPDATE`,
            [profile.id]
          );

          if (result.rows.length === 0 && email) {
            result = await client.query(
              `SELECT id, google_sub, email, display_name, avatar_url,
                      role, is_active
               FROM users
               WHERE lower(email) = $1
               LIMIT 1
               FOR UPDATE`,
              [email]
            );
          }

          let user = result.rows[0];

          if (user && user.is_active === false) {
            await client.query("ROLLBACK");
            return done(null, false, {
              message: "هذا الحساب غير مفعّل."
            });
          }

          if (user) {
            const role = ownerEmails.includes(email)
              ? "owner"
              : user.role;

            const updated = await client.query(
              `UPDATE users
               SET google_sub = $1,
                   email = $2,
                   display_name = $3,
                   avatar_url = $4,
                   role = $5,
                   updated_at = NOW()
               WHERE id = $6
               RETURNING id, google_sub, email, display_name,
                         avatar_url, role, is_active`,
              [
                profile.id,
                email,
                profile.displayName || "",
                profile.photos && profile.photos[0]
                  ? profile.photos[0].value
                  : null,
                role,
                user.id
              ]
            );

            user = updated.rows[0];
          } else {
            const role = ownerEmails.includes(email)
              ? "owner"
              : "user";

            const inserted = await client.query(
              `INSERT INTO users
                 (google_sub, email, display_name, avatar_url,
                  role, is_active, created_at, updated_at)
               VALUES (
                 $1, $2, $3, $4, $5, TRUE, NOW(), NOW()
               )
               RETURNING id, google_sub, email, display_name,
                         avatar_url, role, is_active`,
              [
                profile.id,
                email,
                profile.displayName || "",
                profile.photos && profile.photos[0]
                  ? profile.photos[0].value
                  : null,
                role
              ]
            );

            user = inserted.rows[0];
          }

          await client.query("COMMIT");
          return done(null, user);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        console.error("Google OAuth failed:", error.code || "oauth_error");
        return done(error);
      }
    }));

    passport.serializeUser((user, done) => done(null, String(user.id)));

    passport.deserializeUser(async (id, done) => {
      try {
        const result = await db.query(
          `SELECT id, email, display_name, avatar_url, role, is_active
           FROM users WHERE id = $1 LIMIT 1`,
          [id]
        );
        const user = result.rows[0];

        if (!user || !user.is_active) return done(null, false);
        return done(null, user);
      } catch (error) {
        return done(error);
      }
    });
  }

  app.get("/login", (req, res) => {
    res.render("login", {
      configured,
      message: req.query.error === "google"
        ? "تعذّر تسجيل الدخول. حاول مرة أخرى."
        : ""
    });
  });

  app.get("/auth/google", (req, res, next) => {
    if (!configured) {
      return res.status(503).render("login", {
        configured: false,
        message: "تسجيل Google غير مكتمل الإعداد على الخادم."
      });
    }
    return passport.authenticate("google", {
      scope: ["profile", "email"],
      session: true
    })(req, res, next);
  });

  app.get("/auth/google/callback", (req, res, next) => {
    if (!configured) return res.redirect("/login");

    passport.authenticate("google", {
      failureRedirect: "/login?error=google"
    })(req, res, (error) => {
      if (error) return res.redirect("/login?error=google");

      req.session.save((saveError) => {
        if (saveError) return res.redirect("/login?error=google");
        return res.redirect("/");
      });
    });
  });

  app.get("/account", (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.redirect("/login");
    }
    return res.render("account", { user: req.user });
  });

  app.get("/owner", async (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.redirect("/login");
    }

    if (req.user.role !== "owner") {
      return res.status(403).send("غير مصرح لك بالدخول إلى لوحة المالك.");
    }

    const stats = {
      users: null,
      owners: null,
      reciters: null,
      publishedReciters: null,
      recordings: null,
      publishedRecordings: null,
      videos: null,
      reports: null,
      unresolvedReports: null
    };
    let statsError = false;

    try {
      const result = await db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS users,
          (SELECT COUNT(*)::int FROM users WHERE role = 'owner') AS owners,
          (SELECT COUNT(*)::int FROM reciters) AS reciters,
          (SELECT COUNT(*)::int FROM reciters WHERE is_published = TRUE) AS published_reciters,
          (SELECT COUNT(*)::int FROM recordings) AS recordings,
          (SELECT COUNT(*)::int FROM recordings WHERE is_published = TRUE) AS published_recordings,
          (SELECT COUNT(*)::int FROM reciter_videos) AS videos,
          (SELECT COUNT(*)::int FROM reports) AS reports,
          (SELECT COUNT(*)::int FROM reports WHERE status IS DISTINCT FROM 'resolved') AS unresolved_reports
      `);

      const row = result.rows[0];
      stats.users = row.users;
      stats.owners = row.owners;
      stats.reciters = row.reciters;
      stats.publishedReciters = row.published_reciters;
      stats.recordings = row.recordings;
      stats.publishedRecordings = row.published_recordings;
      stats.videos = row.videos;
      stats.reports = row.reports;
      stats.unresolvedReports = row.unresolved_reports;
    } catch (error) {
      statsError = true;
      console.error("Owner dashboard statistics query failed:", error.code || "DATABASE_ERROR");
    }

    return res.render("owner", {
      user: req.user,
      stats,
      statsError
    });
  });


  // BASAER_CONTENT_ADMIN_V1
  const contentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 2 },
    fileFilter: (req, file, cb) => {
      const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
      cb(allowed.has(file.mimetype) ? null : new Error("INVALID_IMAGE_TYPE"),
         allowed.has(file.mimetype));
    }
  });

  const ownerOnly = (req, res, next) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.redirect("/login");
    }
    if (!req.user || req.user.role !== "owner") {
      return res.status(403).send("غير مصرح لك.");
    }
    next();
  };

  const cleanText = (value, max = 500) =>
    typeof value === "string" ? value.trim().slice(0, max) : "";

  const safeId = (value) =>
    /^\d+$/.test(String(value || "")) ? Number(value) : null;

  async function uploadImageToPostFile(file) {
    if (!file) return null;

    const key = process.env.POSTFILE_API_KEY;
    if (!key) throw new Error("POSTFILE_API_KEY_MISSING");

    const form = new FormData();
    form.append(
      "file",
      new Blob([file.buffer], { type: file.mimetype }),
      file.originalname.replace(/[^\w.\-\u0600-\u06FF]/g, "_").slice(0, 120)
    );

    const response = await fetch("https://postfile.net/v1/upload", {
      method: "POST",
      headers: { "X-API-Key": key },
      body: form,
      signal: AbortSignal.timeout(30000)
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || typeof result.url !== "string") {
      console.error("PostFile upload failed:", response.status);
      throw new Error("POSTFILE_UPLOAD_FAILED");
    }

    const url = new URL(result.url);
    if (url.protocol !== "https:") throw new Error("INVALID_UPLOAD_URL");
    return url.href;
  }

  app.get("/owner/content", ownerOnly, async (req, res) => {
    try {
      const [reciters, recordings, videos] = await Promise.all([
        db.query("SELECT id, name, slug, image_url, is_published FROM reciters ORDER BY sort_order, id DESC"),
        db.query(`
          SELECT a.id, a.reciter_id, a.surah_number, a.surah_name,
                 a.audio_url, a.download_enabled, a.is_published, r.name AS reciter_name
          FROM recordings a JOIN reciters r ON r.id = a.reciter_id
          ORDER BY a.sort_order, a.surah_number, a.id DESC
        `),
        db.query(`
          SELECT v.id, v.reciter_id, v.title, v.youtube_video_id,
                 v.is_published, r.name AS reciter_name
          FROM reciter_videos v JOIN reciters r ON r.id = v.reciter_id
          ORDER BY v.sort_order, v.id DESC
        `)
      ]);
      res.render("owner-content", {
        user: req.user,
        reciters: reciters.rows,
        recordings: recordings.rows,
        videos: videos.rows,
        message: cleanText(req.query.message, 180),
        error: cleanText(req.query.error, 180)
      });
    } catch (error) {
      console.error("Owner content page failed:", error.code || "DATABASE_ERROR");
      res.status(500).send("تعذر تحميل إدارة المحتوى. تحقق من مخطط قاعدة البيانات.");
    }
  });

  app.post("/owner/content/reciters", ownerOnly,
    contentUpload.fields([{ name: "image", maxCount: 1 }, { name: "background", maxCount: 1 }]),
    async (req, res) => {
      try {
        const name = cleanText(req.body.name, 180);
        const slugInput = cleanText(req.body.slug, 180).toLowerCase();
        const slug = slugInput.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
        const biography = cleanText(req.body.biography, 3000);
        if (!name || !slug) {
          return res.redirect("/owner/content?error=" + encodeURIComponent("أدخل اسم القارئ ومعرّفًا إنجليزيًا للرابط."));
        }

        await db.query(
          "ALTER TABLE reciters ADD COLUMN IF NOT EXISTS background_url TEXT"
        );

        const image = req.files?.image?.[0];
        const background = req.files?.background?.[0];
        const imageUrl = await uploadImageToPostFile(image);
        const backgroundUrl = await uploadImageToPostFile(background);

        await db.query(
          `INSERT INTO reciters
             (name, slug, biography, image_url, background_url, is_published, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [name, slug, biography || '', imageUrl, backgroundUrl,
           req.body.is_published === "on", Number(req.body.sort_order) || 0]
        );
        res.redirect("/owner/content?message=" + encodeURIComponent("تمت إضافة القارئ."));
      } catch (error) {
        console.error("Create reciter failed:", {
          code: error.code,
          message: error.message,
          table: error.table,
          column: error.column,
          constraint: error.constraint
        });
        const message = error.code === "23505"
          ? "معرّف الرابط مستخدم بالفعل."
          : error.message === "POSTFILE_API_KEY_MISSING"
            ? "مفتاح PostFile غير مضبوط على الخادم."
            : error.message === "POSTFILE_UPLOAD_FAILED"
              ? "فشل رفع الصورة إلى PostFile."
              : "تعذرت إضافة القارئ. تحقق من الأعمدة المطلوبة في قاعدة البيانات.";
        res.redirect("/owner/content?error=" + encodeURIComponent(message));
      }
    }
  );

  app.post("/owner/content/recordings", ownerOnly, async (req, res) => {
    try {
      const reciterId = safeId(req.body.reciter_id);
      const surahNumber = Number(req.body.surah_number);
      const surahName = cleanText(req.body.surah_name, 120);
      const audioUrl = cleanText(req.body.audio_url, 2000);
      const parsed = new URL(audioUrl);
      if (!reciterId || !Number.isInteger(surahNumber) ||
          surahNumber < 1 || surahNumber > 114 ||
          !surahName || parsed.protocol !== "https:") {
        return res.redirect("/owner/content?error=" + encodeURIComponent("تحقق من القارئ ورقم السورة واسمها ورابط HTTPS."));
      }

      await db.query(
        `INSERT INTO recordings
           (reciter_id, surah_number, surah_name, audio_url,
            download_enabled, is_published, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [reciterId, surahNumber, surahName, parsed.href,
         req.body.download_enabled === "on",
         req.body.is_published === "on",
         Number(req.body.sort_order) || surahNumber]
      );
      res.redirect("/owner/content?message=" + encodeURIComponent("تمت إضافة التلاوة."));
    } catch (error) {
      console.error("Create recording failed:", error.code || "ERROR");
      res.redirect("/owner/content?error=" + encodeURIComponent("تعذرت إضافة التلاوة. تحقق من الرابط والبيانات."));
    }
  });

  app.post("/owner/content/videos", ownerOnly, async (req, res) => {
    try {
      const reciterId = safeId(req.body.reciter_id);
      const youtubeUrl = new URL(cleanText(req.body.youtube_url, 2000));
      const hosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"]);
      if (!reciterId || !hosts.has(youtubeUrl.hostname)) throw new Error("INVALID_YOUTUBE_URL");

      let videoId = "";
      if (youtubeUrl.hostname === "youtu.be") {
        videoId = youtubeUrl.pathname.split("/").filter(Boolean)[0] || "";
      } else if (youtubeUrl.pathname === "/watch") {
        videoId = youtubeUrl.searchParams.get("v") || "";
      } else {
        const parts = youtubeUrl.pathname.split("/").filter(Boolean);
        if (["embed", "shorts", "live"].includes(parts[0])) videoId = parts[1] || "";
      }

      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("INVALID_YOUTUBE_URL");

      let title = cleanText(req.body.title, 250);

      // جلب عنوان الفيديو تلقائيًا إذا ترك المالك خانة العنوان فارغة.
      if (!title) {
        try {
          const oembedUrl =
            "https://www.youtube.com/oembed?format=json&url=" +
            encodeURIComponent("https://www.youtube.com/watch?v=" + videoId);

          const response = await fetch(oembedUrl, {
            signal: AbortSignal.timeout(7000)
          });

          if (response.ok) {
            const metadata = await response.json();
            title = cleanText(metadata.title, 250);
          }
        } catch (error) {
          console.warn("YouTube title lookup failed:", error.message);
        }
      }

      await db.query(
        `INSERT INTO reciter_videos
           (reciter_id, title, youtube_video_id, is_published, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [reciterId, title || "فيديو YouTube", videoId,
         req.body.is_published === "on",
         Number(req.body.sort_order) || 0]
      );
      res.redirect("/owner/content?message=" + encodeURIComponent("تمت إضافة الفيديو ومعاينته عبر YouTube."));
    } catch (error) {
      console.error("Create video failed:", error.code || "ERROR");
      const message = error.message === "INVALID_YOUTUBE_URL"
        ? "رابط YouTube غير صالح."
        : "تعذرت إضافة الفيديو. تحقق من البيانات.";
      res.redirect("/owner/content?error=" + encodeURIComponent(message));
    }
  });

  app.post("/owner/content/:kind/:id/delete", ownerOnly, async (req, res) => {
    const id = safeId(req.params.id);
    const tables = {
      reciters: "reciters",
      recordings: "recordings",
      videos: "reciter_videos"
    };
    const table = tables[req.params.kind];
    if (!id || !table) return res.status(400).send("طلب غير صالح.");

    try {
      await db.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      res.redirect("/owner/content?message=" + encodeURIComponent("تم الحذف."));
    } catch (error) {
      console.error("Delete content failed:", error.code || "DATABASE_ERROR");
      res.redirect("/owner/content?error=" + encodeURIComponent("تعذر الحذف؛ قد يكون العنصر مرتبطًا ببيانات أخرى."));
    }
  });


  app.post("/logout", (req, res, next) => {
    if (!req.logout) return res.redirect("/");
    req.logout((error) => {
      if (error) return next(error);
      req.session.destroy(() => res.redirect("/"));
    });
  });
}

module.exports = setupAuth;
