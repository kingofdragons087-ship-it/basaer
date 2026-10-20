const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const PgSession = require("connect-pg-simple")(session);

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
                 (id, google_sub, email, display_name, avatar_url,
                  role, is_active, created_at, updated_at)
               VALUES (
                 (SELECT COALESCE(MAX(id), 0) + 1 FROM users),
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
        return res.redirect("/account");
      });
    });
  });

  app.get("/account", (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.redirect("/login");
    }
    return res.render("account", { user: req.user });
  });

  app.get("/owner", (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.redirect("/login");
    }

    if (req.user.role !== "owner") {
      return res.status(403).send("غير مصرح لك بالدخول إلى لوحة المالك.");
    }

    return res.render("owner", { user: req.user });
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
