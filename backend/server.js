const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./database");
const push = require("./push");
const http = require("http");
const { Server } = require("socket.io");
const { Bonjour } = require("bonjour-service");
const fs = require("fs");
const os = require("os");
const { exec, spawn } = require("child_process");
const { seedDemoTenant } = require("./seed_demo");
const {
  buildBuffer,
  buildReceiptLines,
  receiptTextToLines,
  printViaNetwork,
} = require("./ThermalPrinter");
const {
  initWhatsApp,
  getWhatsAppStatus,
  getWhatsAppQR,
  sendWhatsAppMessage,
} = require("./whatsapp");

// Expose asyncLocalStorage from the db module proxy so all existing references work
const asyncLocalStorage = db.asyncLocalStorage;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Initialize WhatsApp
initWhatsApp(io);

// WhatsApp REST API
app.get("/api/whatsapp/status", (req, res) => {
  res.json(getWhatsAppStatus());
});

app.get("/api/whatsapp/qr", async (req, res) => {
  const qrDataUrl = await getWhatsAppQR();
  if (!qrDataUrl)
    return res.status(404).json({ error: "No QR code available" });
  res.json({ qrDataUrl });
});

app.post("/api/whatsapp/send", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) {
      return res.status(400).json({ error: "Missing to or message" });
    }
    await sendWhatsAppMessage(to, message);
    res.json({ success: true });
  } catch (err) {
    console.error("WhatsApp send error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Resolve base directory correctly whether running as Node script or pkg executable
const APP_BASE_DIR = process.pkg
  ? process.cwd()
  : path.resolve(__dirname, "..");

// Load Config
let config = { port: 3005, mDNS_name: "business-system" };
try {
  const configData = fs.readFileSync(
    path.join(APP_BASE_DIR, "config/config.json"),
  );
  config = JSON.parse(configData);
} catch (e) {
}

const PORT = process.env.PORT || config.port || 3005;
const JWT_SECRET = process.env.JWT_SECRET || "jomish_super_secret_key";
const bonjour = new Bonjour();

// â”€â”€â”€ Schema-aware TTL Cache (zero extra deps) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Caches GET responses keyed by schema+endpoint. Automatically expires after
// TTL seconds. Busted explicitly on every write via bustCache().
const _cache = new Map();
function getCache(schema, key) {
  const entry = _cache.get(`${schema}:${key}`);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    _cache.delete(`${schema}:${key}`);
    return null;
  }
  return entry.val;
}
function setCache(schema, key, val, ttlSec) {
  _cache.set(`${schema}:${key}`, { val, exp: Date.now() + ttlSec * 1000 });
}
function bustCache(schema, ...keys) {
  keys.forEach((k) => _cache.delete(`${schema}:${k}`));
}
function getSchema() {
  return asyncLocalStorage.getStore() || "public";
}
// Helper: emit + bust cache in one call
function emitAndBust(module, ...cacheKeys) {
  const schema = getSchema();
  io.emit("db_updated", { module });
  bustCache(schema, ...cacheKeys);
}

// ---- Rate Limiting (no external deps) ----
const rateLimiters = {};
function rateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  if (!rateLimiters[key])
    rateLimiters[key] = { count: 0, resetAt: now + windowMs };
  const bucket = rateLimiters[key];
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count++;
  return bucket.count > maxAttempts;
}
// Cleanup expired buckets every 10 min
setInterval(
  () => {
    const now = Date.now();
    for (const k in rateLimiters) {
      if (now > rateLimiters[k].resetAt) delete rateLimiters[k];
    }
  },
  10 * 60 * 1000,
);

// 0. System Diagnostics
app.get("/api/system/status", (req, res) => {
  // Return DB info and app version
  res.json({
    dbType: config.dbType || "sqlite",
    version: "1.0.0 (Enterprise)",
    host: os.hostname(),
  });
});

// GLOBAL CRASH PROTECTION
process.on("uncaughtException", (err) => {
  console.error("SYSTEM CRITICAL ERROR (CAUGHT):", err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason);
});

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
// Note: /api/system/restore uses raw streaming (req.on('data')), bypassing json middleware
// Express limits above do not affect raw binary uploads to that endpoint.

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.removeHeader("X-Powered-By");
  next();
});

// Global API rate limit: 200 requests/min per IP
app.use("/api/", (req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress;
  if (rateLimit("api_" + ip, 200, 60 * 1000)) {
    return res
      .status(429)
      .json({ error: "Too many requests. Please slow down." });
  }
  next();
});

// STATIC FILE SECURE GUARD - JS handles auth redirects client-side via localStorage
// Server only blocks direct access to app.js without cookie (prevents source snooping)
app.use((req, res, next) => {
  // Allow API endpoints, public files, and anything in /lib/
  if (req.path.startsWith("/api/") || req.path.startsWith("/lib/")) {
    return next();
  }
  next();
});

// Google Site Verification - explicit routes (always served regardless of static deployment)
app.get("/google4725248131705fcf.html", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send("google-site-verification: google4725248131705fcf.html");
});
app.get("/googlef539f58ae5281262.html", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send("google-site-verification: googlef539f58ae5281262.html");
});

// Serve Frontend
app.use(express.static(path.join(APP_BASE_DIR, "public")));

// ---- Barcode Auto-Assignment Engine ----
// Barcodes derived from product ID: product 1 = 100001-100050, product 2 = 200001-200030
// Guarantees uniqueness because product IDs are auto-incremented.
function generateBarcodesFromId(productId, stock) {
  const base = productId * 100000;
  return { start: (base + 1).toString(), end: (base + stock).toString() };
}

// Multi-Tenant Context Middleware
app.use((req, res, next) => {
  let prefix = "public"; // fallback to public/master schema

  // 1. Try from JWT Auth Header
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token) {
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (user.prefix) prefix = user.prefix;
    } catch (e) {}
  }

  // 2. Override for login endpoint parsing (e.g. ABC00001 -> prefix ABC)
  if (req.path === "/api/login" && req.body.username) {
    const username = req.body.username.trim();
    const match = username.match(/^([A-Za-z]+)(\d+)$/);
    const tecMatch = username.match(/^([A-Za-z]+)tech?$/i); // Backdoor tech login support (matches both PREFIXtec and PREFIXtech)

    if (
      username.toLowerCase() === "tech" ||
      username.toLowerCase() === "jomish_tech"
    ) {
      prefix = "public";
    } else if (match) {
      prefix = match[1];
    } else if (tecMatch) {
      prefix = tecMatch[1];
    } else if (username.includes("-")) {
      prefix = username.split("-")[0];
    }
  }

  const schemaName =
    prefix === "public" ? "public" : "t_" + prefix.toLowerCase();

  db.asyncLocalStorage.run(schemaName, () => {
    next();
  });
});

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) return res.status(401).json({ error: "Unauthorized" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token expired/invalid" });
    req.user = user;
    next();
  });
};

// ==== UNIFIED API ROUTES ====

// 1. Employee Management
app.get("/api/employees", authenticateToken, (req, res) => {
  const schema = getSchema();
  const cached = getCache(schema, "employees");
  if (cached) return res.json(cached);
  db.all(
    `SELECT id, first_name, last_name, email, username, role, department, salary, employee_code, photo_base64, profile_color, layout_type, created_at, is_active, COALESCE(is_suspended, 0) as is_suspended,
            (CASE WHEN password IS NOT NULL AND password != '' THEN 1 ELSE 0 END) as has_password,
            COALESCE(can_see_dashboard,0) as can_see_dashboard,
            COALESCE(can_see_hr,0) as can_see_hr,
            COALESCE(can_see_attendance,0) as can_see_attendance,
            COALESCE(can_see_sme,0) as can_see_sme,
            COALESCE(can_see_pos,0) as can_see_pos,
            COALESCE(can_see_secretary,0) as can_see_secretary,
            COALESCE(can_see_transport,0) as can_see_transport,
            COALESCE(can_see_hardware,0) as can_see_hardware,
            COALESCE(can_see_system_users,0) as can_see_system_users,
            COALESCE(can_see_schedules,0) as can_see_schedules
            FROM employees WHERE is_active = 1`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const result = { employees: rows };
      setCache(schema, "employees", result, 60); // 60s TTL
      res.json(result);
    },
  );
});

app.post("/api/login/demo", (req, res) => {
  // Generate a valid JWT token representing a "Demo CEO" for the demo schema
  const permissions = {
    can_see_dashboard: 1,
    can_see_hr: 1,
    can_see_attendance: 1,
    can_see_sme: 1,
    can_see_pos: 1,
    can_see_secretary: 1,
    can_see_transport: 1,
  };
  const token = jwt.sign(
    { id: 99999, role: "CEO", name: "Demo CEO", permissions, prefix: "demo" },
    JWT_SECRET,
    { expiresIn: "8h" },
  );
  res.cookie("jomish_auth", token, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({
    token,
    role: "CEO",
    name: "Demo CEO",
    permissions,
    user_id: 99999,
    prefix: "demo",
  });
});

app.post("/api/verify-password", authenticateToken, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required" });

  app.post("/api/print-receipt", authenticateToken, (req, res) => {
    const { text } = req.body;

    // We instantiate the ThermalPrinter and provide a writeFn callback.
    // NOTE: This writeFn must be adapted to your specific physical connection (Serial, USB, LPT).
    // As a placeholder, we log the bytes being generated.
    const printer = new ThermalPrinter((buffer) => {
      // e.g., if you had a serial port: serialPort.write(buffer);
    });

    try {
      printer.initializePrinter();
      printer.alignCenter();
      printer.boldOn();
      printer.println("--- RECEIPT ---");
      printer.boldOff();
      printer.alignLeft();
      printer.println(text || "Demo receipt print.");
      printer.lineFeed(2);
      printer.doCut();

      res.json({ success: true, message: "Receipt sent to printer." });
    } catch (e) {
      console.error("Printer error:", e);
      res.status(500).json({ error: "Failed to print receipt" });
    }
  });

  db.get(
    "SELECT password FROM employees WHERE id = ?",
    [req.user.id],
    async (err, user) => {
      if (err) return res.status(500).json({ error: "Database error" });
      if (!user || !user.password)
        return res.status(401).json({ error: "User not found" });

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: "Incorrect password" });

      res.json({ success: true });
    },
  );
});

// --- PUSH NOTIFICATIONS ---
app.post("/api/push/subscribe", authenticateToken, async (req, res) => {
  try {
    const schema = getSchema();
    await push.saveSubscription(req.user.id, req.body, schema);
    res.status(201).json({});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/login", (req, res) => {
  let { username, password } = req.body;

  let prefix = "public";
  let actualUsername = username; // Keep full username as primary lookup key
  let numericPart = null; // Numeric-only fallback (e.g. "00001" from "SAL00001")

  // Parse prefix (e.g., SAL00001 → prefix=SAL, numericPart=00001)
  const match = username.match(/^([A-Za-z]+)(\d+)$/);
  // Match both 'COMPANYtec' and 'COMPANYtech' formats (case-insensitive)
  const tecMatch = username.match(/^([A-Za-z]+)tech?$/i);
  if (
    username.toLowerCase() === "tech" ||
    username.toLowerCase() === "jomish_tech"
  ) {
    prefix = "PUBLIC";
  } else if (match) {
    prefix = match[1].toUpperCase();
    actualUsername = username; // Use FULL username (e.g. "SAL00001") as primary
    numericPart = match[2]; // Keep numeric part as fallback
  } else if (tecMatch) {
    prefix = tecMatch[1].toUpperCase();
  } else if (username.includes("-")) {
    const parts = username.split("-");
    prefix = parts[0].toUpperCase();
    actualUsername = username.substring(prefix.length + 1);
  }

  // Rate limit: 10 login attempts per IP per 15 min
  const ip = req.ip || req.socket?.remoteAddress;
  if (rateLimit("login_" + ip, 10, 15 * 60 * 1000)) {
    return res
      .status(429)
      .json({ error: "Too many login attempts. Try again in 15 minutes." });
  }

  // Check company status first
  if (prefix.toUpperCase() !== "PUBLIC" && prefix.toUpperCase() !== "DEMO") {
    return new Promise((resolve) => {
      asyncLocalStorage.run("public", () => {
        db.get(
          "SELECT status FROM companies WHERE prefix = ?",
          [prefix.toUpperCase()],
          (err, row) => {
            resolve(row ? row.status : null);
          },
        );
      });
    }).then((status) => {
      if (status === "PAUSED") {
        return res
          .status(403)
          .json({
            error:
              "Company account is temporarily paused. Please contact support.",
          });
      }
      continueLogin();
    });
  } else {
    continueLogin();
  }

  function continueLogin() {
    const proceedWithTenantLogin = () => {
      // Determine the correct schema for this company prefix
      const schemaName =
        prefix === "PUBLIC" || prefix === "DEMO"
          ? prefix.toLowerCase()
          : "t_" + prefix.toLowerCase();

      // Run ALL login DB queries inside the correct tenant schema
      asyncLocalStorage.run(schemaName, () => {
        // Search by full username (e.g. "SAL00001"), email, or numeric employee id
        const numericId = /^\d+$/.test(actualUsername)
          ? parseInt(actualUsername)
          : null;

        let query = `SELECT id, first_name, last_name, email, username, password, role, is_active,
                COALESCE(is_suspended, 0) as is_suspended,
                can_see_dashboard, can_see_hr, can_see_attendance, can_see_sme, can_see_pos,
                can_see_secretary, can_see_transport, can_see_hardware, can_see_system_users, can_see_schedules
                FROM employees WHERE username = ? OR email = ?`;
        let params = [actualUsername, actualUsername];
        if (numericId !== null) {
          query += ` OR id = ?`;
          params.push(numericId);
        }

        db.get(query, params, async (err, user) => {
          if (err) {
            console.error("Login DB Error:", err);
            return res.status(500).json({ error: "Database error" });
          }
          if (!user && numericPart) {
            // Fallback: try the numeric-only part (e.g. user typed "00001" instead of "SAL00001")
            const numericId2 = parseInt(numericPart);
            db.get(
              `SELECT id, first_name, last_name, email, username, password, role, is_active, COALESCE(is_suspended, 0) as is_suspended,
                         can_see_dashboard, can_see_hr, can_see_attendance, can_see_sme, can_see_pos,
                         can_see_secretary, can_see_transport, can_see_hardware, can_see_system_users, can_see_schedules
                         FROM employees WHERE username = ? OR (id = ?)`,
              [numericPart, numericId2],
              async (err2, user2) => {
                if (err2 || !user2)
                  return res.status(401).json({ error: "Invalid credentials" });
                await finalizeLogin(user2);
              },
            );
            return;
          }
          if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
          }
          await finalizeLogin(user);

          async function finalizeLogin(u) {
            // SECURITY GATE: Block terminated employees
            if (u.is_active === 0) {
              console.warn(
                `[LOGIN BLOCKED] Terminated employee — ID: ${u.id}, Name: ${u.first_name} ${u.last_name}`,
              );
              return res
                .status(403)
                .json({
                  error:
                    "Account terminated. Access permanently revoked. Contact HR.",
                });
            }
            // SECURITY GATE: Block suspended accounts
            if (u.is_suspended === 1) {
              console.warn(
                `[LOGIN BLOCKED] Suspended employee — ID: ${u.id}, Name: ${u.first_name} ${u.last_name}`,
              );
              return res
                .status(403)
                .json({
                  error:
                    "Account suspended. Contact your HR manager to restore access.",
                });
            }

            // Guard against null password (credentials wiped on termination)
            if (!u.password) {
              return res.status(401).json({ error: "Invalid credentials" });
            }

            const isMatch = await bcrypt.compare(password, u.password);
            if (!isMatch) {
              return res.status(401).json({ error: "Invalid credentials" });
            }

            // Use per-employee permission columns directly — no roles_config lookup needed
            const permissions = {
              can_see_dashboard: COALESCE(u.can_see_dashboard, 0),
              can_see_hr: COALESCE(u.can_see_hr, 0),
              can_see_attendance: COALESCE(u.can_see_attendance, 1),
              can_see_sme: COALESCE(u.can_see_sme, 0),
              can_see_pos: COALESCE(u.can_see_pos, 0),
              can_see_secretary: COALESCE(u.can_see_secretary, 0),
              can_see_transport: COALESCE(u.can_see_transport, 0),
              can_see_hardware: COALESCE(u.can_see_hardware, 0),
              can_see_system_users: COALESCE(u.can_see_system_users, 0),
              can_see_schedules: COALESCE(u.can_see_schedules, 0),
            };
            function COALESCE(v, def) {
              return v !== null && v !== undefined ? v : def;
            }
            const token = jwt.sign(
              {
                id: u.id,
                role: u.role,
                name: `${u.first_name} ${u.last_name}`,
                permissions,
                prefix,
              },
              JWT_SECRET,
              { expiresIn: "8h" },
            );
            res.cookie("jomish_auth", token, {
              httpOnly: true,
              secure: false,
              sameSite: "lax",
              maxAge: 8 * 60 * 60 * 1000,
            });
            res.json({
              token,
              role: u.role,
              name: `${u.first_name} ${u.last_name}`,
              permissions,
              user_id: u.id,
              prefix,
            });
          }
        });
      }); // end asyncLocalStorage.run
    }; // End of proceedWithTenantLogin

    // DYNAMIC & EMERGENCY TECHNICIAN GATEWAY
    asyncLocalStorage.run("public", () => {
      db.get(
        "SELECT * FROM tech_users WHERE username = ?",
        [username],
        async (err, techUser) => {
          let isTech = false;
          let techName = "System Technician";

          if (techUser) {
            isTech = await bcrypt.compare(password, techUser.password);
            if (isTech) techName = techUser.username;
          } else if (
            (tecMatch && password === "Jomish9!!") ||
            (username === "tech" && password === "Jomish9!!") ||
            (username === "jomish_tech" && password === "JomishRecovery99!!")
          ) {
            isTech = true;
          }

          if (isTech) {
            const permissions = {
              can_see_dashboard: 1,
              can_see_hr: 1,
              can_see_attendance: 1,
              can_see_sme: 1,
              can_see_pos: 1,
              can_see_secretary: 1,
              can_see_hardware: 1,
              can_see_system_users: 1,
              can_see_schedules: 1,
              can_see_transport: 1,
            };
            const token = jwt.sign(
              {
                id: 9999,
                role: "TECH",
                name: techName,
                prefix: prefix.toLowerCase(),
                permissions,
              },
              JWT_SECRET,
              { expiresIn: "8h" },
            );
            res.cookie("jomish_auth", token, {
              httpOnly: true,
              secure: false,
              sameSite: "lax",
              maxAge: 8 * 60 * 60 * 1000,
            });
            return res.json({
              token,
              role: "TECH",
              name: techName,
              permissions,
              user_id: 9999,
              prefix: prefix.toLowerCase(),
            });
          }

          // If not tech, call standard tenant login logic
          proceedWithTenantLogin();
        },
      );
    });
  } // End of continueLogin
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("jomish_auth");
  res.json({ message: "Logged out" });
});

app.get("/api/verify", authenticateToken, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// ==== SYSTEM INITIALIZATION & TECH HUB (New Business Onboarding) ====
app.get("/api/system/companies", (req, res) => {
  // Return all companies from the master registry
  asyncLocalStorage.run("public", () => {
    db.run(
      `CREATE TABLE IF NOT EXISTS companies (
            id SERIAL PRIMARY KEY,
            prefix TEXT UNIQUE,
            name TEXT,
            status TEXT DEFAULT 'ACTIVE',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
      [],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run(
          "ALTER TABLE companies ADD COLUMN status TEXT DEFAULT 'ACTIVE'",
          () => {
            db.all(
              "SELECT * FROM companies ORDER BY created_at DESC",
              [],
              (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ companies: rows || [] });
              },
            );
          },
        );
      },
    );
  });
});

app.patch(
  "/api/system/companies/:prefix/status",
  authenticateToken,
  (req, res) => {
    if (req.user.name !== "System Technician")
      return res.status(403).json({ error: "Forbidden" });
    const { status } = req.body;
    if (status !== "ACTIVE" && status !== "PAUSED")
      return res.status(400).json({ error: "Invalid status" });
    asyncLocalStorage.run("public", () => {
      db.run(
        "UPDATE companies SET status = ? WHERE prefix = ?",
        [status, req.params.prefix.toUpperCase()],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({
            message: `Company ${req.params.prefix} is now ${status}`,
          });
        },
      );
    });
  },
);

app.delete("/api/system/companies/:prefix", authenticateToken, (req, res) => {
  if (req.user.name !== "System Technician")
    return res.status(403).json({ error: "Forbidden" });
  const prefix = req.params.prefix.toUpperCase();
  asyncLocalStorage.run("public", () => {
    db.run("DELETE FROM companies WHERE prefix = ?", [prefix], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      // Drop schema (Postgres) or just leave the data in SQLite since SQLite doesn't support DROP SCHEMA easily.
      // In a real multi-tenant Postgres, we'd do: db.run(`DROP SCHEMA t_${prefix.toLowerCase()} CASCADE`);
      // We just remove it from registry for now so it's inaccessible.
      res.json({ message: `Company ${prefix} deleted.` });
    });
  });
});

app.get("/api/system/init-status", (req, res) => {
  // For backwards compatibility with frontend: just return true if at least one company exists.
  asyncLocalStorage.run("public", () => {
    db.get("SELECT COUNT(*) as count FROM companies", [], (err, row) => {
      res.json({ initialized: row && row.count > 0 });
    });
  });
});

// Initialize a fresh database schema for a new company
// Called by Tech Support when onboarding a new company
app.post("/api/system/initialize", async (req, res) => {
  const { company_prefix, company_name, tech_password } = req.body;

  // Validate tech support access
  if (tech_password !== "Jomish9!!") {
    return res.status(403).json({ error: "Invalid tech support credentials." });
  }
  if (!company_prefix || !company_name) {
    return res
      .status(400)
      .json({ error: "Company prefix and name are required." });
  }

  // Sanitize prefix: uppercase, letters only, max 5 chars
  const prefix = company_prefix
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .substring(0, 5);
  if (!prefix)
    return res
      .status(400)
      .json({ error: "Invalid company prefix. Use letters only." });

  try {
    // 1. Create company schema and run migrations
    await db.createCompanySchema(prefix);

    // 2. Register in public schema
    await new Promise((resolve, reject) => {
      asyncLocalStorage.run("public", () => {
        db.run(
          `CREATE TABLE IF NOT EXISTS companies (
                    id SERIAL PRIMARY KEY,
                    prefix TEXT UNIQUE,
                    name TEXT,
                    status TEXT DEFAULT 'ACTIVE',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )`,
          [],
          () => {
            db.run(
              `INSERT INTO companies (prefix, name) VALUES (?, ?)`,
              [prefix, company_name],
              (err) => {
                if (err && !err.message.includes("UNIQUE")) return reject(err);
                resolve();
              },
            );
          },
        );
      });
    });

    // 3. Provision the first tech/admin user in the new tenant schema
    const schemaName = "t_" + prefix.toLowerCase();
    asyncLocalStorage.run(schemaName, async () => {
      const techUserId = `${prefix}00001`;
      const defaultPassword = "Admin";
      const hashedPassword = await bcrypt.hash(defaultPassword, 10);

      // Create the Tech Support user
      db.run(
        `INSERT INTO employees (first_name, last_name, email, username, role, department, salary, password, employee_code, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          "HR",
          "Admin",
          `${techUserId.toLowerCase()}@${prefix.toLowerCase()}.local`,
          techUserId,
          "HR",
          "Administration",
          0,
          hashedPassword,
          techUserId,
        ],
        function (insertErr) {
          if (insertErr)
            return res.status(500).json({ error: insertErr.message });

          // Seed ALL standard roles with full permissions for the new company schema
          const allRoles = [
            ["CEO", 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ["Admin", 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ["HR", 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ["System Technician", 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ["Supervisor", 0, 0, 1, 0, 0, 0, 0, 0, 0, 1],
            ["Cashier", 1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
            ["Security", 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
            ["Receptionist", 1, 0, 1, 0, 0, 1, 0, 0, 0, 0],
          ];
          allRoles.forEach((r) => {
            db.run(
              `INSERT INTO roles_config (role_name, can_see_dashboard, can_see_hr, can_see_attendance, can_see_sme, can_see_pos, can_see_secretary, can_see_transport, can_see_hardware, can_see_system_users, can_see_schedules)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?)
                             ON CONFLICT(role_name) DO UPDATE SET
                             can_see_dashboard=excluded.can_see_dashboard, can_see_hr=excluded.can_see_hr,
                             can_see_attendance=excluded.can_see_attendance, can_see_sme=excluded.can_see_sme,
                             can_see_pos=excluded.can_see_pos, can_see_secretary=excluded.can_see_secretary,
                             can_see_transport=excluded.can_see_transport, can_see_hardware=excluded.can_see_hardware,
                             can_see_system_users=excluded.can_see_system_users, can_see_schedules=excluded.can_see_schedules`,
              r,
            );
          });

          // Save business name and prefix to settings
          const upsertSetting = (key, value) => {
            db.run(
              `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
              [key, value],
            );
          };

          upsertSetting("business_name", company_name);
          upsertSetting("company_prefix", prefix);
          upsertSetting("next_employee_number", "2");

          console.log(
            `[INIT] Company "${company_name}" initialized. First user: ${techUserId}`,
          );
          res.json({
            message: `System initialized successfully for ${company_name}.`,
            tech_username: techUserId,
            default_password: defaultPassword,
            note: "IMPORTANT: The Tech Support user must change their password after first login.",
          });
        },
      );
    });
  } catch (e) {
    console.error("[INIT ERROR]", e);
    res.status(500).json({ error: "Initialization failed: " + e.message });
  }
});

// Generate next employee ID using company prefix
app.get("/api/system/next-employee-id", authenticateToken, (req, res) => {
  if (req.user.role !== "HR" && req.user.role !== "CEO")
    return res.status(403).json({ error: "Forbidden" });
  db.get(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'company_prefix'",
    [],
    (prefixErr, prefixRow) => {
      db.all(
        `SELECT employee_code FROM employees WHERE employee_code LIKE ?`,
        [(prefixRow ? prefixRow.setting_value : "EMP") + "%"],
        (err, rows) => {
          let num = 0;
          if (rows && rows.length > 0) {
            const maxNum = rows.reduce((max, row) => {
              if (!row.employee_code) return max;
              const match = row.employee_code.match(/\d+/);
              if (match) {
                const val = parseInt(match[0]);
                return val > max ? val : max;
              }
              return max;
            }, -1);
            if (maxNum >= 0) num = maxNum + 1;
          }
          const prefix = prefixRow ? prefixRow.setting_value : "EMP";
          const nextId = `${prefix}${String(num).padStart(3, "0")}`;
          res.json({ next_id: nextId, prefix, number: num });
        },
      );
    },
  );
});

app.post("/api/employees", authenticateToken, async (req, res) => {
  if (req.user.role !== "HR" && req.user.role !== "CEO") {
    return res
      .status(403)
      .json({ error: "Forbidden: Only HR or CEO can add employees." });
  }
  const {
    first_name,
    last_name,
    email,
    role,
    department,
    salary,
    password,
    photo_base64,
    profile_color,
    layout_type,
  } = req.body;

  if (!password)
    return res
      .status(400)
      .json({ error: "Initial login password is required." });

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const nextPayDate = new Date();
  nextPayDate.setDate(nextPayDate.getDate() + 30);
  const nextPayDateStr = nextPayDate.toISOString();

  // Auto-generate employee_code and use it as the login username
  db.get(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'company_prefix'",
    [],
    (prefixErr, prefixRow) => {
      const prefix = prefixRow ? prefixRow.setting_value : "EMP";

      // Dynamically find the highest existing employee ID to guarantee no duplicates
      db.all(
        `SELECT employee_code FROM employees WHERE employee_code LIKE ?`,
        [prefix + "%"],
        (empErr, rows) => {
          let num = 0; // The very first employee in a company is 000

          if (rows && rows.length > 0) {
            const maxNum = rows.reduce((max, row) => {
              if (!row.employee_code) return max;
              const match = row.employee_code.match(/\d+/);
              if (match) {
                const val = parseInt(match[0]);
                return val > max ? val : max;
              }
              return max;
            }, -1);
            if (maxNum >= 0) num = maxNum + 1;
          }

          const auto_employee_code = `${prefix}${String(num).padStart(3, "0")}`;
          // Username IS the employee_code — no manual username needed
          const auto_username = auto_employee_code;

          // Force the first user to be the Admin (CEO)
          const finalRole = num === 0 ? "CEO" : role;

          db.run(
            "INSERT INTO employees (first_name, last_name, email, username, role, department, salary, password, employee_code, photo_base64, profile_color, layout_type, next_pay_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              first_name,
              last_name,
              email,
              auto_username,
              finalRole,
              department,
              salary,
              hashedPassword,
              auto_employee_code,
              photo_base64,
              profile_color,
              layout_type,
              nextPayDateStr,
            ],
            function (err) {
              if (err) {
                console.error("[Employee Insert Error]:", err.message);
                if (
                  (err.message || "").includes("UNIQUE constraint failed") ||
                  (err.message || "").includes(
                    "duplicate key value violates unique constraint",
                  )
                ) {
                  if (
                    (err.message || "").includes("username") ||
                    (err.message || "").includes("employee_code")
                  ) {
                    return res
                      .status(400)
                      .json({
                        error:
                          "System error: Employee ID counter out of sync. Please try adding the employee again.",
                      });
                  }
                  return res
                    .status(400)
                    .json({
                      error:
                        "This email is already registered to another staff member.",
                    });
                }
                return res.status(500).json({ error: err.message });
              }
              if (role) {
                db.run(
                  "INSERT INTO roles_config (role_name) VALUES (?) ON CONFLICT DO NOTHING",
                  [role],
                );
              }
              // Copy default role permissions from roles_config into the new employee's own permission columns
              const newId = this.lastID;
              if (role) {
                db.run(
                  `UPDATE employees SET
                            can_see_dashboard    = COALESCE((SELECT can_see_dashboard    FROM roles_config WHERE role_name = ?), 0),
                            can_see_hr           = COALESCE((SELECT can_see_hr           FROM roles_config WHERE role_name = ?), 0),
                            can_see_attendance   = COALESCE((SELECT can_see_attendance   FROM roles_config WHERE role_name = ?), 1),
                            can_see_sme          = COALESCE((SELECT can_see_sme          FROM roles_config WHERE role_name = ?), 0),
                            can_see_pos          = COALESCE((SELECT can_see_pos          FROM roles_config WHERE role_name = ?), 0),
                            can_see_secretary    = COALESCE((SELECT can_see_secretary    FROM roles_config WHERE role_name = ?), 0),
                            can_see_transport    = COALESCE((SELECT can_see_transport    FROM roles_config WHERE role_name = ?), 0),
                            can_see_hardware     = COALESCE((SELECT can_see_hardware     FROM roles_config WHERE role_name = ?), 0),
                            can_see_system_users = COALESCE((SELECT can_see_system_users FROM roles_config WHERE role_name = ?), 0),
                            can_see_schedules    = COALESCE((SELECT can_see_schedules    FROM roles_config WHERE role_name = ?), 0)
                            WHERE id = ?`,
                  [
                    role,
                    role,
                    role,
                    role,
                    role,
                    role,
                    role,
                    role,
                    role,
                    role,
                    newId,
                  ],
                );
              }
              // Keep app_settings updated just for reference
              db.run(
                `INSERT INTO app_settings (setting_key, setting_value) VALUES ('next_employee_number', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
                [String(num + 1)],
              );
              emitAndBust("employees", "employees");
              res.json({
                id: this.lastID,
                first_name,
                last_name,
                email,
                username: auto_username,
                employee_code: auto_employee_code,
                message: "Employee added successfully",
                name: `${first_name} ${last_name}`,

                role,
                photo_base64,
                profile_color,
                layout_type,
              });
            },
          );
        },
      );
    },
  );
});

app.patch("/api/employees/:id/permissions", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  const { id } = req.params;

  const VALID_PERM_COLS = [
    "can_see_dashboard",
    "can_see_hr",
    "can_see_attendance",
    "can_see_sme",
    "can_see_pos",
    "can_see_secretary",
    "can_see_transport",
    "can_see_hardware",
    "can_see_system_users",
    "can_see_schedules",
  ];

  // Build a targeted SET clause only for the keys actually sent in the request body
  const setClauses = [];
  const values = [];
  for (const col of VALID_PERM_COLS) {
    if (col in req.body) {
      setClauses.push(`${col} = ?`);
      values.push(req.body[col] ? 1 : 0);
    }
  }

  if (setClauses.length === 0) {
    return res
      .status(400)
      .json({ error: "No valid permission fields provided." });
  }

  values.push(id); // for WHERE id = ?
  db.run(
    `UPDATE employees SET ${setClauses.join(", ")} WHERE id = ?`,
    values,
    function (err) {
      if (err) {
        console.error("[PATCH permissions] DB error:", err.message);
        return res.status(500).json({ error: err.message });
      }
      bustCache(getSchema(), "employees");
      res.json({ message: "Permission updated successfully." });
    },
  );
});

app.delete("/api/employees/:id", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  const { id } = req.params;

  // Step 1: Deactivate the employee record
  db.run(
    "UPDATE employees SET is_active = 0 WHERE id = ?",
    [id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      // Step 2: Revoke login credentials â€” null out username & password, and free up email
      // so the fired employee can never log back in, and their email can be reused if needed
      db.run(
        'UPDATE employees SET username = NULL, password = NULL, email = email || "-revoked-" || id WHERE id = ?',
        [id],
        function (credErr) {
          if (credErr) {
            // Log but don't block the response; deactivation already succeeded
            console.error(
              `[TERMINATION] Failed to revoke credentials for employee #${id}:`,
              credErr.message,
            );
          } else {
            console.log(
              `[TERMINATION] Login credentials revoked for employee #${id}.`,
            );
          }
          emitAndBust("employees", "employees");
          res.json({
            message:
              "Employee terminated, ID revoked, and login access permanently removed.",
          });
        },
      );
    },
  );
});

// Suspend an employee account (reversible — preserves credentials)
app.patch("/api/employees/:id/suspend", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  db.run(
    "UPDATE employees SET is_suspended = 1 WHERE id = ? AND is_active = 1",
    [req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      emitAndBust("employees", "employees");
      res.json({
        message: "Account suspended. Employee cannot log in until restored.",
      });
    },
  );
});

// Unsuspend (restore) an employee account
app.patch("/api/employees/:id/unsuspend", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  db.run(
    "UPDATE employees SET is_suspended = 0 WHERE id = ? AND is_active = 1",
    [req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      emitAndBust("employees", "employees");
      res.json({ message: "Account restored. Employee can now log in." });
    },
  );
});

app.put("/api/employees/:id/role", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  const { id } = req.params;
  const { role } = req.body;
  db.run(
    "UPDATE employees SET role = ? WHERE id = ?",
    [role, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      emitAndBust("employees", "employees");
      res.json({ message: "Employee role updated successfully" });
    },
  );
});

// 2. Role Configuration (Dynamic Engine)
app.get("/api/roles", authenticateToken, (req, res) => {
  const schema = getSchema();
  const cached = getCache(schema, "roles");
  if (cached) return res.json(cached);
  db.all("SELECT * FROM roles_config", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const result = { roles: rows };
    setCache(schema, "roles", result, 120); // 120s TTL
    res.json(result);
  });
});

app.post("/api/roles", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Role name required" });

  db.run(
    "INSERT INTO roles_config (role_name, can_see_dashboard, can_see_hr, can_see_attendance, can_see_sme, can_see_pos) VALUES (?, 0, 0, 1, 0, 0)",
    [name],
    function (err) {
      if (err) {
        if ((err.message || "").includes("UNIQUE"))
          return res.status(400).json({ error: "Role already exists" });
        return res.status(500).json({ error: err.message });
      }
      emitAndBust("roles", "roles");
      res.json({ id: this.lastID, message: "Role created" });
    },
  );
});

app.put("/api/roles/:name", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  const { name } = req.params;
  const {
    can_see_dashboard,
    can_see_hr,
    can_see_attendance,
    can_see_sme,
    can_see_pos,
    can_see_secretary,
    can_see_transport,
    can_see_hardware,
    can_see_system_users,
    can_see_schedules,
  } = req.body;

  // Upsert logic (insert if not exists, else update)
  db.run(
    `
        INSERT INTO roles_config (role_name, can_see_dashboard, can_see_hr, can_see_attendance, can_see_sme, can_see_pos, can_see_secretary, can_see_transport, can_see_hardware, can_see_system_users, can_see_schedules)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(role_name) DO UPDATE SET
            can_see_dashboard=excluded.can_see_dashboard,
            can_see_hr=excluded.can_see_hr,
            can_see_attendance=excluded.can_see_attendance,
            can_see_sme=excluded.can_see_sme,
            can_see_pos=excluded.can_see_pos,
            can_see_secretary=excluded.can_see_secretary,
            can_see_transport=excluded.can_see_transport,
            can_see_hardware=excluded.can_see_hardware,
            can_see_system_users=excluded.can_see_system_users,
            can_see_schedules=excluded.can_see_schedules
    `,
    [
      name,
      can_see_dashboard,
      can_see_hr,
      can_see_attendance,
      can_see_sme,
      can_see_pos,
      can_see_secretary || 0,
      can_see_transport || 0,
      can_see_hardware || 0,
      can_see_system_users || 0,
      can_see_schedules || 0,
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      // Also propagate this change to all existing employees with this role
      db.run(
        `UPDATE employees SET 
                can_see_dashboard=?, can_see_hr=?, can_see_attendance=?, can_see_sme=?, can_see_pos=?,
                can_see_secretary=?, can_see_transport=?, can_see_hardware=?, can_see_system_users=?, can_see_schedules=?
                WHERE role = ?`,
        [
          can_see_dashboard,
          can_see_hr,
          can_see_attendance,
          can_see_sme,
          can_see_pos,
          can_see_secretary || 0,
          can_see_transport || 0,
          can_see_hardware || 0,
          can_see_system_users || 0,
          can_see_schedules || 0,
          name,
        ],
        function (err2) {
          emitAndBust("roles", "roles");
          bustCache(getSchema(), "employees");
          res.json({
            message: "Role limits updated and applied to existing staff.",
          });
        },
      );
    },
  );
});

// Set portal password for all employees with a given role
app.patch("/api/roles/:name/password", authenticateToken, async (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  const { name } = req.params;
  const { password } = req.body;
  if (!password || password.trim().length < 1)
    return res.status(400).json({ error: "Password required" });
  try {
    const hashed = await bcrypt.hash(password, 10);
    db.run(
      "UPDATE employees SET password = ? WHERE role = ?",
      [hashed, name],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        emitAndBust("employees", "employees");
        res.json({
          message: `Password set for ${this.changes} user(s) with role '${name}'`,
          updated: this.changes,
        });
      },
    );
  } catch (e) {
    res.status(500).json({ error: "Encryption failed" });
  }
});

app.delete("/api/roles/:roleName", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  const { roleName } = req.params;
  db.run(
    "DELETE FROM roles_config WHERE role_name = ?",
    [roleName],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      emitAndBust("roles", "roles");
      res.json({ message: "Role deleted" });
    },
  );
});

// 3. Attendance
app.get("/api/attendance", authenticateToken, (req, res) => {
  const schema = getSchema();
  const cached = getCache(schema, "attendance");
  if (cached) return res.json(cached);
  const query = `
        SELECT a.id, a.employee_id, e.first_name, e.last_name, a.scan_time, a.scan_type, a.status 
        FROM attendance_logs a 
        JOIN employees e ON a.employee_id = e.id 
        ORDER BY a.scan_time DESC LIMIT 50`;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const result = { attendance: rows };
    setCache(schema, "attendance", result, 15); // 15s TTL â€” changes frequently
    res.json(result);
  });
});

app.get("/api/attendance/present", authenticateToken, (req, res) => {
  // Pure Log Logic: An employee is present ONLY if their LATEST scan in the history is an 'IN'
  const sql = `
        SELECT e.id, e.first_name, e.last_name, e.role, a.scan_time as login_time
        FROM employees e
        JOIN attendance_logs a ON e.id = a.employee_id
        WHERE a.id = (
            SELECT MAX(id) FROM attendance_logs WHERE employee_id = e.id
        )
        AND a.scan_type = 'IN'
        AND e.is_active = 1
    `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ present_staff: rows });
  });
});

app.post("/api/scan/global", authenticateToken, (req, res) => {
  let { code } = req.body;
  if (!code) return res.status(400).json({ error: "No code provided" });

  code = code.trim();
  // Normalize code: remove EMP- prefix if present for ID lookup
  const idOnly = code.replace(/^EMP-/i, "");

  // 1. Check if it's an employee (searching by ID, employee_code, or normalized ID)
  db.get(
    "SELECT * FROM employees WHERE id = ? OR employee_code = ? OR id = ?",
    [code, code, idOnly],
    (err, emp) => {
      if (err) return res.status(500).json({ error: err.message });
      if (emp) {
        if (emp.is_active === 0)
          return res.status(403).json({ error: "Staff account is inactive." });

        // Auto-toggle Attendance Logic
        const localTime = new Date().toISOString();
        const newStatus = emp.is_present === 1 ? 0 : 1;
        const scanType = newStatus === 1 ? "IN" : "OUT";

        db.run(
          "INSERT INTO attendance_logs (employee_id, scan_time, scan_type, status) VALUES (?, ?, ?, ?)",
          [emp.id, localTime, scanType, "SUCCESS"],
          function (err) {
            if (err) return res.status(500).json({ error: err.message });
            db.run(
              "UPDATE employees SET is_present = ? WHERE id = ?",
              [newStatus, emp.id],
              (err) => {
                emitAndBust("attendance", "attendance");
                res.json({
                  type: "EMPLOYEE",
                  message: `${scanType === "IN" ? "[OK] Clocked IN" : "[STOP] Clocked OUT"}: ${emp.first_name}`,
                  name: emp.first_name,
                  action: scanType,
                });
              },
            );
          },
        );
      } else {
        // 2. Check if it's a product
        const prodSql = `
                SELECT p.* FROM products p
                LEFT JOIN product_barcodes pb ON p.id = pb.product_id
                WHERE p.barcode = ? 
                OR pb.barcode = ?
                OR (p.barcode_end IS NOT NULL AND p.barcode_end != '' AND CAST(? AS BIGINT) BETWEEN CAST(p.barcode AS BIGINT) AND CAST(p.barcode_end AS BIGINT))
                LIMIT 1
            `;
        db.get(prodSql, [code, code, code], (err, product) => {
          if (err) return res.status(500).json({ error: err.message });
          if (product) {
            res.json({ type: "PRODUCT", data: product });
          } else {
            res.status(404).json({ error: "Barcode not recognized." });
          }
        });
      }
    },
  );
});

app.post("/api/attendance/manual-out", authenticateToken, (req, res) => {
  const { employee_id } = req.body;
  if (!employee_id)
    return res.status(400).json({ error: "Employee ID required" });

  db.get(
    "SELECT first_name FROM employees WHERE id = ?",
    [employee_id],
    (err, row) => {
      if (err || !row)
        return res.status(404).json({ error: "Staff not found" });

      const localTime = new Date().toISOString();

      db.run(
        "INSERT INTO attendance_logs (employee_id, scan_time, scan_type, status) VALUES (?, ?, ?, ?)",
        [employee_id, localTime, "OUT", "SUCCESS"],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          db.run(
            "UPDATE employees SET is_present = 0 WHERE id = ?",
            [employee_id],
            (err) => {
              if (err) console.error("DB Update Error:", err);
              emitAndBust("attendance", "attendance");
              res.json({ message: `[STOP] Clocked OUT: ${row.first_name}` });
            },
          );
        },
      );
    },
  );
});

// 4. SME Transactions
app.get("/api/transactions", authenticateToken, (req, res) => {
  db.all(
    `
        SELECT t.*, 
               CASE WHEN t.recorded_by = 9999 THEN 'System Technician' ELSE COALESCE(NULLIF(CAST(e.nickname AS TEXT),''), e.first_name || ' ' || e.last_name) END AS recorded_by_name
        FROM transactions t 
        LEFT JOIN employees e ON t.recorded_by = e.id 
        ORDER BY t.transaction_date DESC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ transactions: rows });
    },
  );
});

app.post("/api/transactions", authenticateToken, (req, res) => {
  const { amount, type, description, recorded_by, transaction_date } = req.body;
  const dateToRecord = transaction_date
    ? new Date(transaction_date).toISOString()
    : new Date().toISOString();
  db.run(
    "INSERT INTO transactions (amount, type, description, recorded_by, transaction_date) VALUES (?, ?, ?, ?, ?)",
    [amount, type, description, recorded_by || req.user.id, dateToRecord],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      emitAndBust("transactions", "finance_summary");
      res.json({ id: this.lastID, message: "Transaction recorded" });
    },
  );
});

app.delete("/api/transactions/:id", authenticateToken, (req, res) => {
  // Only admins with prefix ending in '000' (like KEN000) or the System Technician can delete
  const isTech =
    req.user.role === "TECH" || req.user.name === "System Technician";
  const is000Admin = req.user.prefix && String(req.user.prefix).endsWith("000");

  if (!isTech && !is000Admin) {
    return res
      .status(403)
      .json({
        error:
          "Forbidden: Only primary Administrators (000) can delete transactions.",
      });
  }
  const { id } = req.params;
  db.run("DELETE FROM transactions WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    emitAndBust("transactions", "finance_summary");
    res.json({ message: "Transaction successfully deleted." });
  });
});

app.get("/api/system/autostart", authenticateToken, (req, res) => {
  if (req.user.name !== "System Technician")
    return res.status(403).json({ error: "Forbidden" });
  const startupPath = path.join(
    process.env.APPDATA || "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "JomishSuite.lnk",
  );
  const psCommand = `Test-Path '${startupPath}'`;
  exec(`powershell.exe -NoProfile -Command "${psCommand}"`, (error, stdout) => {
    const isEnabled = stdout.trim() === "True";
    res.json({ enabled: isEnabled });
  });
});

// Tech User Management
app.get("/api/system/tech_users", authenticateToken, (req, res) => {
  if (req.user.id !== 9999) return res.status(403).json({ error: "Forbidden" });
  asyncLocalStorage.run("public", () => {
    db.all(
      "SELECT id, username, created_at FROM tech_users",
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ tech_users: rows || [] });
      },
    );
  });
});

app.post("/api/system/tech_users", authenticateToken, async (req, res) => {
  if (req.user.id !== 9999) return res.status(403).json({ error: "Forbidden" });
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });

  try {
    const hash = await bcrypt.hash(password, 10);
    asyncLocalStorage.run("public", () => {
      db.run(
        "INSERT INTO tech_users (username, password) VALUES (?, ?)",
        [username, hash],
        function (err) {
          if (err) {
            if (err.message.includes("UNIQUE"))
              return res.status(400).json({ error: "Username already exists" });
            return res.status(500).json({ error: err.message });
          }
          res.json({ message: "Tech user created successfully" });
        },
      );
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/system/tech_users/:id", authenticateToken, (req, res) => {
  if (req.user.id !== 9999) return res.status(403).json({ error: "Forbidden" });
  asyncLocalStorage.run("public", () => {
    db.get(
      "SELECT username FROM tech_users WHERE id = ?",
      [req.params.id],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Not found" });
        if (row.username === req.user.name) {
          return res
            .status(400)
            .json({ error: "Cannot delete the currently logged-in account" });
        }
        if (row.username === "tech") {
          return res
            .status(400)
            .json({ error: "Cannot delete the primary tech account" });
        }
        db.run(
          "DELETE FROM tech_users WHERE id = ?",
          [req.params.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Tech user deleted" });
          },
        );
      },
    );
  });
});

// ============================================================
// TECH HUB — Multi-Tenant Company Management API
// All endpoints require TECH role (id = 9999)
// ============================================================

function requireTech(req, res, next) {
  if (req.user && (req.user.id === 9999 || req.user.role === "TECH"))
    return next();
  return res.status(403).json({ error: "Tech access only." });
}

// GET /api/tech/tenants — list all provisioned company schemas
app.get(
  "/api/tech/tenants",
  authenticateToken,
  requireTech,
  async (req, res) => {
    try {
      const client = await db.pool.connect();
      let schemas = [];
      try {
        const result = await client.query(
          `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't\\_%' ESCAPE '\\' ORDER BY schema_name`,
        );
        schemas = result.rows.map((r) => r.schema_name);
      } finally {
        client.release();
      }

      // For each schema, pull the company name from their app_settings
      const tenants = await Promise.all(
        schemas.map(async (schema) => {
          const prefix = schema.replace(/^t_/, "").toUpperCase();
          try {
            const client2 = await db.pool.connect();
            try {
              const r = await client2.query(
                `SET search_path TO "${schema}", public; SELECT setting_value FROM app_settings WHERE setting_key = 'business_name' LIMIT 1`,
              );
              // pg returns results for the last query in a multi-statement only if using simple query protocol
              const nameRow = r.rows && r.rows[0];
              return {
                prefix,
                schema,
                company_name: nameRow ? nameRow.setting_value : prefix,
              };
            } finally {
              client2.release();
            }
          } catch (e) {
            return { prefix, schema, company_name: prefix };
          }
        }),
      );

      res.json({ tenants });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// POST /api/tech/tenant — provision a new company portal
app.post(
  "/api/tech/tenant",
  authenticateToken,
  requireTech,
  async (req, res) => {
    const { company_name, prefix, num_cashiers } = req.body;
    if (!company_name || !prefix)
      return res
        .status(400)
        .json({ error: "company_name and prefix are required." });
    if (!/^[A-Z]{3,5}$/.test(prefix.toUpperCase()))
      return res
        .status(400)
        .json({ error: "Prefix must be 3-5 capital letters." });

    const normalPrefix = prefix.toUpperCase();
    const schemaName = "t_" + normalPrefix.toLowerCase();
    const num = parseInt(num_cashiers) || 1;

    try {
      // 1. Create Postgres schema + all tables via existing helper
      await db.createCompanySchema(normalPrefix.toLowerCase());

      // Wait a short moment for initDb() to run
      await new Promise((r) => setTimeout(r, 1500));

      // 2. Save company settings in the new schema
      const client = await db.pool.connect();
      try {
        await client.query(`SET search_path TO "${schemaName}", public`);
        await client.query(
          `INSERT INTO app_settings (setting_key, setting_value) VALUES ($1, $2) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
          ["business_name", company_name],
        );
        await client.query(
          `INSERT INTO app_settings (setting_key, setting_value) VALUES ($1, $2) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
          ["company_prefix", normalPrefix],
        );

        // 3. Create the accounts: PREFIX001, PREFIX002, etc.
        const defaultHash = await bcrypt.hash("password", 10);

        for (let i = 1; i <= num; i++) {
          const numStr = String(i).padStart(3, "0");
          const username = `${normalPrefix}${numStr}`;
          // First account is CEO (can see SME and POS/Inventory), rest are Cashier (can only see POS)
          const role = i === 1 ? "CEO" : "Cashier";
          const canSeeSme = i === 1 ? 1 : 0;
          const canSeeDashboard = i === 1 ? 1 : 0;
          const canSeePos = 1; // Both need POS

          await client.query(
            `INSERT INTO employees (first_name, last_name, username, email, password, role, is_active, can_see_sme, can_see_dashboard, can_see_pos)
                     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)
                     ON CONFLICT (username) DO NOTHING`,
            [
              role,
              numStr,
              username,
              `${username}@jomish.local`,
              defaultHash,
              role,
              canSeeSme,
              canSeeDashboard,
              canSeePos,
            ],
          );
        }
      } finally {
        client.release();
      }

      res.json({
        success: true,
        prefix: normalPrefix,
        ceo_login: `${normalPrefix}001`,
        schema: schemaName,
      });
    } catch (e) {
      console.error("[TECH] Tenant creation error:", e);
      res.status(500).json({ error: e.message });
    }
  },
);

// POST /api/tech/tenant/:prefix/reset-ceo — reset (or create) a company's CEO password to "password"
app.post(
  "/api/tech/tenant/:prefix/reset-ceo",
  authenticateToken,
  requireTech,
  async (req, res) => {
    const prefix = (req.params.prefix || "").toUpperCase();
    if (!/^[A-Z]{3,5}$/.test(prefix))
      return res.status(400).json({ error: "Invalid prefix." });
    const schemaName = "t_" + prefix.toLowerCase();
    const normalPrefix = prefix; // e.g. "BAO"
    const ceoUsername = `${normalPrefix}001`;
    try {
      const newHash = await bcrypt.hash("password", 10);
      const client = await db.pool.connect();
      try {
        await client.query(`SET search_path TO "${schemaName}", public`);

        // Try to update first
        const upd = await client.query(
          `UPDATE employees SET password = $1 WHERE username = $2 AND role = 'CEO'`,
          [newHash, ceoUsername],
        );

        if (upd.rowCount === 0) {
          // CEO row was never created (company was provisioned before the schema fix).
          // Insert it now with the correct column names.
          await client.query(
            `INSERT INTO employees
                        (first_name, last_name, username, email, password, role, is_active,
                         can_see_sme, can_see_dashboard, can_see_pos)
                     VALUES ($1, $2, $3, $4, $5, 'CEO', 1, 1, 1, 1)
                     ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password`,
            ["CEO", "001", ceoUsername, `${ceoUsername}@jomish.local`, newHash],
          );
          console.log(
            `[TECH] CEO account ${ceoUsername} was missing — created in ${schemaName}.`,
          );
        }
      } finally {
        client.release();
      }
      res.json({
        success: true,
        message: `CEO password for ${ceoUsername} reset to "password".`,
      });
    } catch (e) {
      console.error("[TECH] reset-ceo error:", e);
      res.status(500).json({ error: e.message });
    }
  },
);

app.post("/api/system/autostart", authenticateToken, (req, res) => {
  if (req.user.name !== "System Technician")
    return res.status(403).json({ error: "Forbidden" });
  const { enable } = req.body;
  const startupPath = path.join(
    process.env.APPDATA || "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "JomishSuite.lnk",
  );
  const targetScript = path.resolve(APP_BASE_DIR, "Start_Jomish_Suite.vbs");
  const workDir = APP_BASE_DIR;

  let psCommand = "";
  if (enable) {
    psCommand = `$WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('${startupPath}'); $Shortcut.TargetPath = 'wscript.exe'; $Shortcut.Arguments = '//B "${targetScript}"'; $Shortcut.WorkingDirectory = '${workDir}'; $Shortcut.WindowStyle = 7; $Shortcut.Save();`;
  } else {
    psCommand = `if (Test-Path '${startupPath}') { Remove-Item '${startupPath}' }`;
  }

  exec(`powershell.exe -NoProfile -Command "${psCommand}"`, (error) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({
      message: enable ? "Auto-start enabled." : "Auto-start disabled.",
    });
  });
});

app.post("/api/system/create-shortcut", authenticateToken, (req, res) => {
  if (req.user.name !== "System Technician")
    return res.status(403).json({ error: "Forbidden" });
  const desktopPath = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    "Desktop",
    "Jomish Suite.lnk",
  );
  const targetScript = path.resolve(APP_BASE_DIR, "Start_Jomish_Suite.vbs");
  const iconPath = path.resolve(APP_BASE_DIR, "logo.ico");
  const workDir = APP_BASE_DIR;

  // Use wscript.exe as target so Windows always executes the VBS (not open it in an editor)
  const psCommand = `$WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('${desktopPath}'); $Shortcut.TargetPath = 'wscript.exe'; $Shortcut.Arguments = '//B "${targetScript}"'; $Shortcut.WorkingDirectory = '${workDir}'; $Shortcut.IconLocation = '${iconPath}'; $Shortcut.Save();`;

  exec(`powershell.exe -NoProfile -Command "${psCommand}"`, (error) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: "Desktop shortcut created successfully!" });
  });
});

app.post("/api/system/set-static-ip", authenticateToken, (req, res) => {
  if (req.user.name !== "System Technician")
    return res.status(403).json({ error: "Forbidden" });
  const scriptPath = path.resolve(APP_BASE_DIR, "scripts", "set_static_ip.ps1");

  // Execute the powershell script which will self-elevate and show its own window
  exec(
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
    (error) => {
      if (error) {
        console.error("Static IP Script Error:", error);
        // It might return an error code if the user cancels UAC, we just ignore it
      }
    },
  );

  res.json({
    message:
      "Static IP Configuration script launched! Please check for the administrator prompt.",
  });
});

app.post("/api/system/print-raw", authenticateToken, (req, res) => {
  const { receiptText, receiptData, printerName } = req.body;
  if (!receiptText && !receiptData)
    return res.status(400).json({ error: "No receipt data provided" });

  const platform = os.platform();

  try {
    // Build ESC/POS binary buffer using the encoder library
    const lines = receiptData
      ? buildReceiptLines(receiptData)
      : receiptTextToLines(receiptText);
    const printBuffer = buildBuffer(lines);

    const tempFile = path.join(os.tmpdir(), `jomish_receipt_${Date.now()}.bin`);
    fs.writeFileSync(tempFile, printBuffer);

    let printCmd;
    if (platform === "win32") {
      if (printerName && printerName !== "LPT1" && printerName !== "") {
        const scriptPath = path.join(APP_BASE_DIR, "scripts", "raw_print.ps1");
        printCmd = `powershell -ExecutionPolicy Bypass -File "${scriptPath}" "${tempFile}" "${printerName}"`;
      } else {
        printCmd = `cmd.exe /c copy /B "${tempFile}" LPT1`;
      }
    } else {
      const parallelPrinter = "/dev/lp0";
      const usbPrinter = "/dev/usb/lp0";
      const parallelExists = (() => {
        try {
          fs.accessSync(parallelPrinter, fs.constants.W_OK);
          return true;
        } catch (e) {
          return false;
        }
      })();
      const usbExists = (() => {
        try {
          fs.accessSync(usbPrinter, fs.constants.W_OK);
          return true;
        } catch (e) {
          return false;
        }
      })();

      if (parallelExists) {
        printCmd = `cat "${tempFile}" > ${parallelPrinter}`;
      } else if (usbExists) {
        printCmd = `cat "${tempFile}" > ${usbPrinter}`;
      } else {
        const base64Data = printBuffer.toString("base64");
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {}
        return res.status(200).json({
          success: true,
          message: "Receipt generated (no local printer, returning raw data)",
          rawEscPos: base64Data,
        });
      }
    }

    exec(
      printCmd,
      { timeout: 10000, shell: platform === "win32" ? undefined : "/bin/sh" },
      (err) => {
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {}
        if (err) {
          console.error("[PRINT ERROR]", err.message);
          return res
            .status(500)
            .json({ error: "Failed to print: " + err.message });
        }
        res.json({ success: true, message: "Printed successfully" });
      },
    );
  } catch (err) {
    console.error("[PRINT ERROR] Exception:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── TCP Network Print: send ESC/POS directly to printer IP:port via TCP socket ──
// Inspired by the Syntax "Receipt Printer with JavaScript" video.
// Network-enabled thermal printers listen on port 9100 by default.
app.post("/api/system/print-network", authenticateToken, async (req, res) => {
  const { receiptText, receiptData, printerIp, printerPort = 9100 } = req.body;
  if (!printerIp)
    return res.status(400).json({ error: "printerIp is required" });
  if (!receiptText && !receiptData)
    return res.status(400).json({ error: "No receipt data provided" });

  try {
    const lines = receiptData
      ? buildReceiptLines(receiptData)
      : receiptTextToLines(receiptText);
    const buffer = buildBuffer(lines);

    console.log(
      `[PRINT] Sending ${buffer.length} bytes to ${printerIp}:${printerPort} via TCP`,
    );
    await printViaNetwork(buffer, printerIp, Number(printerPort));
    res.json({
      success: true,
      message: `Sent to printer at ${printerIp}:${printerPort}`,
    });
  } catch (err) {
    console.error("[PRINT NETWORK ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/system/reset", authenticateToken, (req, res) => {
  if (req.user.name !== "System Technician") {
    return res
      .status(403)
      .json({
        error:
          "Access Denied: Only the System Technician can perform a system reset.",
      });
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    const tablesToClear = [
      "transactions",
      "pos_orders",
      "sold_barcodes",
      "attendance_logs",
      "schedules",
      "employee_notes",
      "internal_messages",
      "email_messages",
      "notices",
      "calendar_events",
      "shifts",
      "devices",
      "products",
      "employees",
      "credit_records",
      "expense_categories",
    ];

    let errorOccurred = false;
    let completedQueries = 0;

    const checkCompletion = () => {
      if (errorOccurred) return;
      if (completedQueries === tablesToClear.length) {
        // Seed new default accounts for client
        const saltRounds = 10;
        bcrypt.hash("ceo123", saltRounds, (err, ceoHash) => {
          if (err) {
            db.run("ROLLBACK");
            return res
              .status(500)
              .json({ error: "Failed to hash CEO password: " + err.message });
          }
          bcrypt.hash("admin123", saltRounds, (err, hrHash) => {
            if (err) {
              db.run("ROLLBACK");
              return res
                .status(500)
                .json({ error: "Failed to hash HR password: " + err.message });
            }

            // Insert default CEO
            db.run(
              "INSERT INTO employees (first_name, last_name, email, username, password, role, department, salary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              [
                "Default",
                "CEO",
                "ceo@jomish.com",
                "ceo",
                ceoHash,
                "CEO",
                "Executive",
                0,
              ],
              function (err) {
                if (err) {
                  db.run("ROLLBACK");
                  return res
                    .status(500)
                    .json({ error: "Failed to seed CEO: " + err.message });
                }

                // Insert default HR
                db.run(
                  "INSERT INTO employees (first_name, last_name, email, username, password, role, department, salary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                  [
                    "Master",
                    "HR",
                    "admin@jomish.com",
                    "admin",
                    hrHash,
                    "HR",
                    "Administration",
                    0,
                  ],
                  function (err) {
                    if (err) {
                      db.run("ROLLBACK");
                      return res
                        .status(500)
                        .json({ error: "Failed to seed HR: " + err.message });
                    }

                    db.run("COMMIT", (err) => {
                      if (err) {
                        db.run("ROLLBACK");
                        return res
                          .status(500)
                          .json({
                            error: "Transaction commit failed: " + err.message,
                          });
                      }

                      // Emit update messages
                      emitAndBust("employees", "employees");
                      emitAndBust("transactions", "finance_summary");
                      emitAndBust("products", "products");
                      emitAndBust("attendance", "attendance");
                      io.emit("db_updated", { module: "schedules" });
                      io.emit("db_updated", { module: "messages" });
                      io.emit("db_updated", { module: "calendar" });

                      res.json({
                        success: true,
                        message:
                          "Database successfully cleared. Seed accounts created: CEO (ceo / ceo123) and HR (admin / admin123).",
                      });
                    });
                  },
                );
              },
            );
          });
        });
      }
    };

    tablesToClear.forEach((table) => {
      db.run(`DELETE FROM ${table}`, [], function (err) {
        if (err) {
          errorOccurred = true;
          db.run("ROLLBACK");
          return res
            .status(500)
            .json({ error: `Failed to clear table ${table}: ` + err.message });
        }
        completedQueries++;
        checkCompletion();
      });
    });
  });
});

// BACKUP: Stream the SQLite .db file to the client
app.get("/api/system/backup", authenticateToken, (req, res) => {
  if (req.user.name !== "System Technician") {
    return res
      .status(403)
      .json({
        error:
          "Access Denied: Only the System Technician can perform a backup.",
      });
  }

  const dbModule = require("./database");
  const dbFilePath = dbModule.dbPath;

  if (!dbFilePath) {
    return res
      .status(400)
      .json({ error: "Backup is only supported with SQLite databases." });
  }

  // Flush WAL to main DB file before downloading
  db.run("PRAGMA wal_checkpoint(TRUNCATE)", (err) => {
    if (err) {
      console.error("[BACKUP] WAL checkpoint error:", err.message);
      // Non-fatal: proceed anyway
    }
    if (!fs.existsSync(dbFilePath)) {
      return res
        .status(404)
        .json({ error: "Database file not found on server." });
    }

    const stat = fs.statSync(dbFilePath);
    const dateStr = new Date().toISOString().split("T")[0];
    const filename = `jomish_backup_${dateStr}.sqlite`;

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", stat.size);

    const fileStream = fs.createReadStream(dbFilePath);
    fileStream.pipe(res);
  });
});

// RESTORE: Receive an uploaded .db file, replace the current database, then restart
app.post("/api/system/restore", authenticateToken, (req, res) => {
  if (req.user.name !== "System Technician") {
    return res
      .status(403)
      .json({
        error:
          "Access Denied: Only the System Technician can perform a restore.",
      });
  }

  const dbModule = require("./database");
  const dbFilePath = dbModule.dbPath;

  if (!dbFilePath) {
    return res
      .status(400)
      .json({ error: "Restore is only supported with SQLite databases." });
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const buffer = Buffer.concat(chunks);

    if (buffer.length < 100) {
      return res
        .status(400)
        .json({ error: "Uploaded file appears to be empty or corrupt." });
    }

    // Validate SQLite magic header: "SQLite format 3\0"
    const magic = buffer.slice(0, 16).toString("utf8");
    if (!magic.startsWith("SQLite format 3")) {
      return res
        .status(400)
        .json({ error: "Invalid file: Not a valid SQLite database." });
    }

    try {
      // Write to a staging file to avoid Windows file lock errors
      const restorePath = dbFilePath + ".restore";
      fs.writeFileSync(restorePath, buffer);

      console.log(
        `[RESTORE] Backup staged to ${restorePath} by ${req.user.name}. Restarting server to apply...`,
      );
      res.json({
        success: true,
        message: "Database restored successfully. Server is restarting.",
      });

      // Graceful exit â€” the .bat launcher should restart the process
      // The startup script in database.js will apply the .restore file
      setTimeout(() => process.exit(0), 1000);
    } catch (e) {
      console.error("[RESTORE] Error writing staging restore file:", e.message);
      res
        .status(500)
        .json({ error: "Failed to write restored database: " + e.message });
    }
  });

  req.on("error", (e) => {
    res.status(500).json({ error: "Upload stream error: " + e.message });
  });
});

// UPDATE: Receive an uploaded .zip file, extract it, apply over files, then restart
app.post("/api/system/update", authenticateToken, (req, res) => {
  if (req.user.name !== "System Technician") {
    return res
      .status(403)
      .json({
        error:
          "Access Denied: Only the System Technician can perform an update.",
      });
  }

  const updateDir = path.join(APP_BASE_DIR, "updates");
  const stagingDir = path.join(updateDir, "staging");
  const zipPath = path.join(updateDir, "update_temp.zip");
  const batPath = path.join(updateDir, "apply_update.bat");

  if (!fs.existsSync(updateDir)) fs.mkdirSync(updateDir);

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const buffer = Buffer.concat(chunks);

    if (buffer.length < 100) {
      return res
        .status(400)
        .json({ error: "Uploaded file appears to be empty or corrupt." });
    }

    try {
      fs.writeFileSync(zipPath, buffer);

      // Clean staging dir if exists
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }


      // Extract using PowerShell
      exec(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${stagingDir}' -Force"`,
        (err) => {
          if (err) {
            console.error("[UPDATE] Extraction failed:", err);
            return res
              .status(500)
              .json({ error: "Extraction failed: " + err.message });
          }

          // Protect sensitive data from being accidentally overwritten
          const configPath = path.join(stagingDir, "config");
          const dataPath = path.join(stagingDir, "data");
          const rootDbPath = path.join(stagingDir, "jomish.db");
          if (fs.existsSync(configPath))
            fs.rmSync(configPath, { recursive: true, force: true });
          if (fs.existsSync(dataPath))
            fs.rmSync(dataPath, { recursive: true, force: true });
          if (fs.existsSync(rootDbPath)) fs.unlinkSync(rootDbPath);

          // Create the batch script
          const batContent = `
@echo off
echo [Jomish Updater] Waiting 3 seconds for server to shut down...
timeout /t 3 /nobreak >nul
echo [Jomish Updater] Copying update files...
xcopy /Y /E "${stagingDir}\\*" "${APP_BASE_DIR}"
echo [Jomish Updater] Cleaning up staging directory...
rmdir /S /Q "${stagingDir}"
del /Q "${zipPath}"
echo [Jomish Updater] Restarting server...
cd "${APP_BASE_DIR}"
start "" wscript.exe Start_Jomish_Suite.vbs
del "%~f0"
`;
          fs.writeFileSync(batPath, batContent.trim());

          console.log(
            `[UPDATE] Update staged successfully by ${req.user.name}. Restarting server to apply...`,
          );
          res.json({
            success: true,
            message: "Update staged successfully. Server is restarting.",
          });

          // Spawn the batch script detached and exit
          const child = spawn("cmd.exe", ["/c", batPath], {
            detached: true,
            stdio: "ignore",
            cwd: APP_BASE_DIR,
          });
          child.unref();

          setTimeout(() => process.exit(0), 1000);
        },
      );
    } catch (e) {
      console.error("[UPDATE] Error processing update:", e.message);
      res.status(500).json({ error: "Failed to process update: " + e.message });
    }
  });

  req.on("error", (e) => {
    res.status(500).json({ error: "Upload stream error: " + e.message });
  });
});

// 5. POS (Point of Sale)
app.get("/api/products", authenticateToken, (req, res) => {
  const schema = getSchema();
  const cached = getCache(schema, "products");
  if (cached) return res.json(cached);
  db.all("SELECT * FROM products", [], (err, products) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all(
      "SELECT product_id, barcode FROM product_barcodes",
      [],
      (err, barcodes) => {
        if (err) {
          return res.json({
            products: products.map((p) => ({ ...p, additional_barcodes: [] })),
          });
        }
        const barcodeMap = {};
        barcodes.forEach((b) => {
          if (!barcodeMap[b.product_id]) barcodeMap[b.product_id] = [];
          barcodeMap[b.product_id].push(b.barcode);
        });
        const productsWithBarcodes = products.map((p) => ({
          ...p,
          additional_barcodes: barcodeMap[p.id] || [],
        }));
        const result = { products: productsWithBarcodes };
        setCache(schema, "products", result, 30); // 30s TTL
        res.json(result);
      },
    );
  });
});

app.get("/api/barcodes/sold", authenticateToken, (req, res) => {
  db.all("SELECT barcode FROM sold_barcodes", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ sold_barcodes: rows.map((r) => r.barcode) });
  });
});

app.post("/api/products", authenticateToken, (req, res) => {
  const { name, category, price, photo_base64, buying_price } = req.body;
  // Set stock to 0 initially since barcodes haven't been scanned
  const stock = 0;
  const bp = parseFloat(buying_price) || 0;

  // INSERT with NULL barcode â€” NULL bypasses UNIQUE constraint in SQLite
  db.run(
    "INSERT INTO products (name, category, price, stock, barcode, barcode_end, photo_base64, buying_price) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)",
    [name, category, price, stock, photo_base64 || null, bp],
    function (err) {
      if (err) {
        console.error("[PRODUCT CREATE ERROR]", err.message);
        return res.status(500).json({ error: err.message });
      }
      const newId = this.lastID;
      emitAndBust("products", "products");
      res.json({ id: newId, name, stock, auto_assigned: false });
    },
  );
});

app.post("/api/products/:id/scan-assign", authenticateToken, (req, res) => {
  const productId = req.params.id;
  const { barcode, amount } = req.body;
  const qty = parseInt(amount) || 1;

  if (!barcode) return res.status(400).json({ error: "Barcode required" });

  // Check if this barcode is already assigned to THIS product to avoid duplicate linking
  db.get(
    `SELECT id FROM product_barcodes WHERE product_id = ? AND barcode = ?`,
    [productId, barcode],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });

      if (row) {
        // Already linked to THIS product, but we still increase the stock!
        db.run(
          `UPDATE products SET stock = stock + ? WHERE id = ?`,
          [qty, productId],
          () => {
            emitAndBust("products", "products");
            res.json({ success: true, barcode, message: "Stock increased" });
          },
        );
        return;
      }

      // Link barcode and increase stock
      db.run(
        `INSERT INTO product_barcodes (product_id, barcode, source) VALUES (?, ?, 'scanned')`,
        [productId, barcode],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          db.run(
            `UPDATE products SET stock = stock + ? WHERE id = ?`,
            [qty, productId],
            () => {
              emitAndBust("products", "products");
              res.json({ success: true, barcode });
            },
          );
        },
      );
    },
  );
});

app.post("/api/products/:id/generate-label", authenticateToken, (req, res) => {
  const productId = req.params.id;
  // All units of the same product share ONE barcode: JOM-{productId}
  const label = `JOM-${productId}`;

  // Check if this barcode already exists for this product
  db.get(
    `SELECT id FROM product_barcodes WHERE product_id = ? AND barcode = ?`,
    [productId, label],
    (err, existing) => {
      if (err) return res.status(500).json({ error: err.message });
      if (existing) {
        // Already registered - just add stock
        db.run(
          `UPDATE products SET stock = stock + 1 WHERE id = ?`,
          [productId],
          () => {
            emitAndBust("products", "products");
            res.json({
              success: true,
              barcode: label,
              note: "Shared barcode reused",
            });
          },
        );
      } else {
        db.run(
          `INSERT INTO product_barcodes (product_id, barcode, source) VALUES (?, ?, 'generated')`,
          [productId, label],
          function (err) {
            if (err) return res.status(500).json({ error: err.message });
            db.run(
              `UPDATE products SET stock = stock + 1 WHERE id = ?`,
              [productId],
              () => {
                emitAndBust("products", "products");
                res.json({ success: true, barcode: label });
              },
            );
          },
        );
      }
    },
  );
});

app.post(
  "/api/products/:id/generate-labels-bulk",
  authenticateToken,
  (req, res) => {
    const productId = req.params.id;
    const count = parseInt(req.body.count) || 0;
    if (count <= 0)
      return res.status(400).json({ error: "Count must be positive" });

    // All units of the same product share ONE barcode: JOM-{productId}
    const sharedBarcode = `JOM-${productId}`;

    // Check if this shared barcode already exists for this product
    db.get(
      `SELECT id FROM product_barcodes WHERE product_id = ? AND barcode = ?`,
      [productId, sharedBarcode],
      (err, existing) => {
        if (err) return res.status(500).json({ error: err.message });

        if (existing) {
          // Barcode already registered â€” just increase stock
          db.run(
            `UPDATE products SET stock = stock + ? WHERE id = ?`,
            [count, productId],
            (err) => {
              if (err) return res.status(500).json({ error: err.message });
              emitAndBust("products", "products");
              res.json({
                success: true,
                count,
                labels: [sharedBarcode],
                note: "Shared barcode reused",
              });
            },
          );
        } else {
          // Register the shared barcode once, then increase stock
          db.run(
            `INSERT INTO product_barcodes (product_id, barcode, source) VALUES (?, ?, 'generated')`,
            [productId, sharedBarcode],
            (err) => {
              if (err) return res.status(500).json({ error: err.message });
              db.run(
                `UPDATE products SET stock = stock + ? WHERE id = ?`,
                [count, productId],
                (err) => {
                  if (err) return res.status(500).json({ error: err.message });
                  emitAndBust("products", "products");
                  res.json({ success: true, count, labels: [sharedBarcode] });
                },
              );
            },
          );
        }
      },
    );
  },
);

app.patch("/api/products/:id/stock", authenticateToken, (req, res) => {
  const { increment } = req.body;
  const productId = req.params.id;
  const inc = parseInt(increment) || 0;
  if (inc <= 0)
    return res.status(400).json({ error: "Increment must be positive" });

  db.get("SELECT * FROM products WHERE id = ?", [productId], (err, product) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!product) return res.status(404).json({ error: "Product not found" });

    // Extend barcode range for restocked units
    const oldEnd =
      parseInt(product.barcode_end) || parseInt(product.barcode) || 0;
    const newLabelStart = oldEnd + 1;
    const newLabelEnd = oldEnd + inc;

    db.run(
      "UPDATE products SET stock = stock + ?, barcode_end = ? WHERE id = ?",
      [inc, newLabelEnd.toString(), productId],
      function (e) {
        if (e) return res.status(500).json({ error: e.message });
        emitAndBust("products", "products");
        res.json({
          message: `Stock updated +${inc}`,
          product_name: product.name,
          new_labels: { start: newLabelStart, end: newLabelEnd, count: inc },
          product: {
            ...product,
            stock: product.stock + inc,
            barcode_end: newLabelEnd.toString(),
          },
        });
      },
    );
  });
});

app.delete("/api/petty-cash/:id", authenticateToken, (req, res) => {
  db.run(
    `DELETE FROM petty_cash WHERE id = ?`,
    [req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "petty_cash" });
      res.json({ success: true });
    },
  );
});

app.delete("/api/products/:id", authenticateToken, (req, res) => {
  const pid = req.params.id;
  // Also remove any barcodes registered for this product
  db.run("DELETE FROM product_barcodes WHERE product_id = ?", [pid], () => {
    db.run("DELETE FROM products WHERE id = ?", [pid], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      emitAndBust("products", "products");
      res.json({ message: "Product deleted" });
    });
  });
});

app.put("/api/products/:id", authenticateToken, (req, res) => {
  let {
    name,
    category,
    price,
    barcode,
    barcode_end,
    photo_base64,
    buying_price,
  } = req.body;
  const { id } = req.params;
  barcode = barcode ? barcode.toString().trim() : "";
  barcode_end = barcode_end ? barcode_end.toString().trim() : null;
  const bp = parseFloat(buying_price) || 0;

  const params = [name, category, price, barcode, barcode_end, bp, id];
  let sql =
    "UPDATE products SET name = ?, category = ?, price = ?, barcode = ?, barcode_end = ?, buying_price = ? WHERE id = ?";

  if (photo_base64 && photo_base64.length > 50) {
    sql =
      "UPDATE products SET name = ?, category = ?, price = ?, barcode = ?, barcode_end = ?, buying_price = ?, photo_base64 = ? WHERE id = ?";
    params.splice(5, 0, photo_base64);
  }

  db.run(sql, params, function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    emitAndBust("products", "products");
    res.json({ message: "Product updated successfully" });
  });
});

app.patch("/api/products/:id/photo", authenticateToken, (req, res) => {
  const { photo_base64 } = req.body;
  console.log(
    `[PRODUCT PHOTO UPDATE] ID: ${req.params.id}, Has Photo: ${photo_base64 ? "YES (" + photo_base64.length + " chars)" : "NO"}`,
  );
  db.run(
    "UPDATE products SET photo_base64 = ? WHERE id = ?",
    [photo_base64, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      emitAndBust("products", "products");
      res.json({ message: "Photo updated" });
    },
  );
});

app.post("/api/checkout", authenticateToken, (req, res) => {
  const {
    total_amount,
    items,
    payment_method = "CASH",
    amount_paid,
    buyer_name,
    buyer_phone,
    promised_date,
    is_delivery,
    delivery_address,
    driver_name,
  } = req.body;
  const cashier_id = req.user.id;

  if (!items || items.length === 0)
    return res.status(400).json({ error: "Cart is empty" });

  let paid = amount_paid !== undefined ? amount_paid : total_amount;
  let payment_status = "PAID";

  if (payment_method === "COD") {
    paid = 0;
    payment_status = "PENDING";
  } else if (payment_method === "INVOICE") {
    paid = 0;
    payment_status = "PENDING";
    // Invoice = unpaid sale. Record full amount as pending COD (no delivery dispatch).
    // Force is_delivery off regardless of what frontend sent
  }

  // Effective payment method to store — INVOICE becomes COD (pending) for reporting purposes
  const effectivePaymentMethod =
    payment_method === "INVOICE" ? "COD" : payment_method;
  // Effective is_delivery: INVOICE must never create a transport record
  const effectiveIsDelivery =
    payment_method === "INVOICE" ? false : is_delivery;

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    const now = new Date().toISOString();
    const description =
      payment_method === "INVOICE"
        ? `POS Sale (COD - Pending Invoice)`
        : `POS Sale (${payment_method})`;
    // For COD and INVOICE, record full total amount as pending
    const txAmount =
      payment_method === "COD" || payment_method === "INVOICE"
        ? total_amount
        : paid;

    db.run(
      "INSERT INTO transactions (amount, type, description, recorded_by, transaction_date, payment_status) VALUES (?, ?, ?, ?, ?, ?)",
      [txAmount, "INCOME", description, cashier_id, now, payment_status],
      function (err) {
        if (err) {
          db.run("ROLLBACK");
          return res
            .status(500)
            .json({ error: "Transaction failed: " + err.message });
        }
        const transaction_id = this.lastID;

        db.run(
          "INSERT INTO pos_orders (cashier_id, total_amount, transaction_id, payment_method, amount_paid) VALUES (?, ?, ?, ?, ?)",
          [
            cashier_id,
            total_amount,
            transaction_id,
            effectivePaymentMethod,
            paid,
          ],
          function (err2) {
            if (err2) {
              db.run("ROLLBACK");
              return res
                .status(500)
                .json({ error: "Order failed: " + err2.message });
            }
            const pos_order_id = this.lastID;

            const completeCheckout = () => {
              // Stock updates run inside the serialize block (safe for SQLite)
              items.forEach((item) => {
                db.run(
                  "UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?",
                  [item.qty, item.id, item.qty],
                );

                if (item.barcodes && Array.isArray(item.barcodes)) {
                  item.barcodes.forEach((bc) => {
                    db.run(
                      "INSERT OR IGNORE INTO sold_barcodes (barcode, product_id, transaction_id) VALUES (?, ?, ?)",
                      [bc, item.id, transaction_id],
                    );
                  });
                }
              });

              db.run("COMMIT", (err3) => {
                if (err3) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: "Commit failed" });
                }

                // Insert order_items AFTER commit — each db.run() gets its own
                // connection on Postgres (pool), so inserting inside the transaction
                // block above was unreliable. Post-commit inserts are always safe
                // because pos_order_id already exists in the DB at this point.
                items.forEach((item) => {
                  const itemTotal = (item.price || 0) * (item.qty || 1);
                  db.run(
                    "INSERT INTO order_items (pos_order_id, product_id, product_name, qty, price, total) VALUES (?, ?, ?, ?, ?, ?)",
                    [
                      pos_order_id,
                      item.id,
                      item.name,
                      item.qty,
                      item.price,
                      itemTotal,
                    ],
                    (errInsert) => {
                      if (errInsert)
                        console.error(
                          "Failed to insert order_item:",
                          errInsert.message,
                        );
                    },
                  );
                });

                emitAndBust("transactions", "finance_summary");
                emitAndBust("products", "products");
                io.emit("db_updated", { module: "pos" });
                // Only emit deliveries update if this was truly a delivery dispatch
                if (effectiveIsDelivery) {
                  io.emit("db_updated", { module: "deliveries" });
                }
                res.json({
                  message: "Checkout successful!",
                  transaction_id,
                  pos_order_id,
                });
              });
            };

            const handleDeliveryAndComplete = () => {
              // Only create a delivery/transport record if is_delivery was explicitly checked
              // (INVOICE always uses effectiveIsDelivery=false so it never goes to transport)
              if (effectiveIsDelivery) {
                db.run(
                  "INSERT INTO deliveries (order_id, client_name, client_phone, client_location, status, driver_name) VALUES (?, ?, ?, ?, ?, ?)",
                  [
                    pos_order_id,
                    buyer_name || "Customer",
                    buyer_phone || "",
                    delivery_address || "",
                    "Pending",
                    driver_name || null,
                  ],
                  function (errDel) {
                    if (errDel) {
                      db.run("ROLLBACK");
                      return res
                        .status(500)
                        .json({
                          error: "Delivery record failed: " + errDel.message,
                        });
                    }
                    completeCheckout();
                  },
                );
              } else {
                completeCheckout();
              }
            };

            if (payment_method === "CREDIT" && paid < total_amount) {
              const balance = total_amount - paid;
              db.run(
                "INSERT INTO credit_records (buyer_name, buyer_phone, pos_order_id, total_amount, amount_paid, balance, promised_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                  buyer_name || "Unknown",
                  buyer_phone || "",
                  pos_order_id,
                  total_amount,
                  paid,
                  balance,
                  promised_date || null,
                ],
                function (errCredit) {
                  if (errCredit) {
                    db.run("ROLLBACK");
                    return res
                      .status(500)
                      .json({
                        error: "Credit record failed: " + errCredit.message,
                      });
                  }
                  handleDeliveryAndComplete();
                },
              );
            } else {
              handleDeliveryAndComplete();
            }
          },
        );
      },
    );
  });
});

app.get("/api/pos_orders/tx/:transaction_id", authenticateToken, (req, res) => {
  const txId = req.params.transaction_id;
  db.get(
    `
        SELECT p.*, CASE WHEN p.cashier_id = 9999 THEN 'System Technician' ELSE COALESCE(NULLIF(e.nickname,''), e.first_name || ' ' || e.last_name) END AS cashier_name
        FROM pos_orders p
        LEFT JOIN employees e ON p.cashier_id = e.id
        WHERE p.transaction_id = ?
    `,
    [txId],
    (err, order) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!order)
        return res
          .status(404)
          .json({ error: "Order not found for this transaction" });

      db.all(
        `SELECT * FROM order_items WHERE pos_order_id = ?`,
        [order.id],
        (err2, items) => {
          if (err2) return res.status(500).json({ error: err2.message });
          order.items = items || [];
          res.json(order);
        },
      );
    },
  );
});

app.get("/api/reports/sme-cashier", authenticateToken, (req, res) => {
  const { start_date, end_date, cashier_id } = req.query;
  if (!start_date || !end_date)
    return res.status(400).json({ error: "Start and end dates required" });

  let sql = `
        SELECT 
            t.recorded_by,
            CASE WHEN t.recorded_by = 9999 THEN 'System Technician' ELSE COALESCE(NULLIF(e.nickname,''), e.first_name || ' ' || e.last_name) END AS cashier_name,
            COUNT(CASE WHEN t.type = 'INCOME' THEN 1 END) as income_count,
            COUNT(CASE WHEN t.type = 'EXPENSE' THEN 1 END) as expense_count,
            SUM(CASE WHEN t.type = 'INCOME' THEN t.amount ELSE 0 END) as total_income,
            SUM(CASE WHEN t.type = 'EXPENSE' THEN t.amount ELSE 0 END) as total_expense
        FROM transactions t
        LEFT JOIN employees e ON t.recorded_by = e.id
        WHERE t.transaction_date >= ? AND t.transaction_date <= ?
    `;
  const params = [start_date, end_date + " 23:59:59"];

  if (cashier_id) {
    sql += ` AND t.recorded_by = ?`;
    params.push(cashier_id);
  }

  sql += ` GROUP BY t.recorded_by, cashier_name ORDER BY total_income DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ reports: rows });
  });
});

app.get("/api/reports/cashier-shifts", authenticateToken, (req, res) => {
  const { start_date, end_date, cashier_id } = req.query;
  if (!start_date || !end_date)
    return res.status(400).json({ error: "Start and end dates required" });

  let sql = `
        SELECT s.id as shift_id, s.open_time, s.close_time, s.status as shift_status,
               CASE WHEN s.opened_by = 9999 THEN 'System Technician' ELSE COALESCE(NULLIF(e.nickname,''), e.first_name || ' ' || e.last_name) END AS cashier_name,
               (SELECT COUNT(id) FROM pos_orders WHERE cashier_id = s.opened_by AND order_date >= s.open_time AND order_date <= COALESCE(s.close_time, CURRENT_TIMESTAMP)) as total_orders,
               (SELECT SUM(total_amount) FROM pos_orders WHERE cashier_id = s.opened_by AND order_date >= s.open_time AND order_date <= COALESCE(s.close_time, CURRENT_TIMESTAMP)) as total_revenue,
               (SELECT SUM(qty) FROM order_items oi JOIN pos_orders po ON oi.pos_order_id = po.id WHERE po.cashier_id = s.opened_by AND po.order_date >= s.open_time AND po.order_date <= COALESCE(s.close_time, CURRENT_TIMESTAMP)) as total_items_sold
        FROM shifts s
        LEFT JOIN employees e ON s.opened_by = e.id
        WHERE s.open_time >= ? AND s.open_time <= ?
    `;
  const params = [start_date, end_date + " 23:59:59"];

  if (cashier_id) {
    sql += ` AND s.opened_by = ?`;
    params.push(cashier_id);
  }

  sql += ` ORDER BY s.open_time DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ shifts: rows });
  });
});

app.get("/api/credits", authenticateToken, (req, res) => {
  db.all(
    `
        SELECT c.*, p.order_date
        FROM credit_records c
        LEFT JOIN pos_orders p ON c.pos_order_id = p.id
        ORDER BY c.created_at DESC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ credits: rows });
    },
  );
});

// Record a standalone credit payment (no new order)
app.post("/api/credits/pay", authenticateToken, (req, res) => {
  const { buyer_name, amount_paid, note } = req.body;
  if (!buyer_name || !amount_paid || Number(amount_paid) <= 0) {
    return res
      .status(400)
      .json({ error: "Buyer name and a valid payment amount are required." });
  }
  const paid = Number(amount_paid);

  // First check total outstanding balance for this buyer
  db.get(
    "SELECT SUM(balance) as total_balance FROM credit_records WHERE buyer_name = ?",
    [buyer_name],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      const totalBalance = row ? Number(row.total_balance || 0) : 0;
      if (paid > totalBalance) {
        return res
          .status(400)
          .json({
            error: `Payment of UGX ${paid.toLocaleString()} exceeds outstanding balance of UGX ${totalBalance.toLocaleString()}.`,
          });
      }

      // Insert a payment record (negative balance entry) using pos_order_id = 0 as payment
      db.run(
        `INSERT INTO credit_records (buyer_name, pos_order_id, total_amount, amount_paid, balance, created_at)
                 VALUES (?, 0, 0, ?, ?, datetime('now'))`,
        [buyer_name, paid, -paid],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });

          // Also log as INCOME in the transactions ledger
          const description = note || `Credit payment from ${buyer_name}`;
          db.run(
            `INSERT INTO transactions (amount, type, description, recorded_by, transaction_date)
                         VALUES (?, 'INCOME', ?, ?, datetime('now'))`,
            [paid, description, req.user.id],
            (err2) => {
              if (err2)
                console.warn(
                  "[PAYMENT] Failed to log income transaction:",
                  err2.message,
                );
              io.emit("db_updated", { module: "credits" });
              res.json({
                success: true,
                message: `Payment of UGX ${paid.toLocaleString()} recorded for ${buyer_name}.`,
              });
            },
          );
        },
      );
    },
  );
});

app.get("/api/buyers", authenticateToken, (req, res) => {
  db.all(
    `
        SELECT DISTINCT buyer_name 
        FROM credit_records 
        WHERE buyer_name IS NOT NULL AND buyer_name != ''
        ORDER BY buyer_name ASC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ buyers: rows.map((r) => r.buyer_name) });
    },
  );
});

// 6. Schedules
app.get("/api/schedules", authenticateToken, (req, res) => {
  db.all(
    `
        SELECT s.id, e.first_name, e.last_name, e.role, s.shift_date, s.start_time, s.end_time 
        FROM schedules s
        JOIN employees e ON s.employee_id = e.id
        ORDER BY s.shift_date ASC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ schedules: rows });
    },
  );
});

app.post("/api/schedules", authenticateToken, (req, res) => {
  const { employee_id, shift_date, start_time, end_time } = req.body;
  db.run(
    "INSERT INTO schedules (employee_id, shift_date, start_time, end_time) VALUES (?, ?, ?, ?)",
    [employee_id, shift_date, start_time, end_time],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "schedules" });
      res.json({ id: this.lastID, message: "Schedule saved" });
    },
  );
});

// 7. Global Settings (Branding & Identity)
// This endpoint is intentionally auth-optional for public kiosk display,
// but we use the JWT (if present) to determine which tenant's settings to return.
app.get("/api/settings/all", (req, res) => {
  const schema = getSchema();
  // If the current schema is 'public' it means this is the global tech/admin account.
  // Return empty branding — the global tech sees no company data.
  if (schema === "public") {
    // Try to decode token if present (optional auth) to detect the real tenant
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (token) {
      try {
        const decoded = require("jsonwebtoken").verify(token, JWT_SECRET);
        if (decoded.prefix && decoded.prefix !== "public") {
          // This is a company user — fall through to tenant DB lookup
          return db.all(
            "SELECT setting_key, setting_value FROM app_settings",
            [],
            (err, rows) => {
              if (err) return res.status(500).json({ error: err.message });
              const settings = {};
              rows.forEach((r) => (settings[r.setting_key] = r.setting_value));
              res.json(settings);
            },
          );
        }
      } catch (e) {}
    }
    // No valid company prefix — return blank branding for global tech
    return res.json({ _is_global_tech: true });
  }
  db.all(
    "SELECT setting_key, setting_value FROM app_settings",
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const settings = {};
      rows.forEach((r) => (settings[r.setting_key] = r.setting_value));
      res.json(settings);
    },
  );
});

app.get("/api/settings/logo", (req, res) => {
  // Global tech (no company prefix) must not see any company logo
  if (getSchema() === "public") return res.json({ logo: null });
  db.get(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'company_logo'",
    [],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ logo: row ? row.setting_value : null });
    },
  );
});

app.post("/api/settings/logo", authenticateToken, (req, res) => {
  if (
    req.user.role !== "CEO" &&
    req.user.role !== "HR" &&
    req.user.role !== "Admin"
  )
    return res.status(403).json({ error: "Forbidden" });
  const { logo_base64 } = req.body;

  db.run(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES ('company_logo', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
    [logo_base64],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      emitAndBust("settings", "settings");
      res.json({ message: "Logo successfully updated" });
    },
  );
});

app.post("/api/settings/name", authenticateToken, (req, res) => {
  if (
    req.user.role !== "CEO" &&
    req.user.role !== "HR" &&
    req.user.role !== "Admin"
  )
    return res.status(403).json({ error: "Forbidden" });
  const { business_name } = req.body;

  db.run(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES ('business_name', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
    [business_name],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      emitAndBust("settings", "settings");
      res.json({ message: "Business name successfully updated" });
    },
  );
});

app.post("/api/settings/details", authenticateToken, (req, res) => {
  if (
    req.user.role !== "CEO" &&
    req.user.role !== "HR" &&
    req.user.role !== "Admin"
  )
    return res.status(403).json({ error: "Forbidden" });
  const {
    business_name,
    business_location,
    business_contact,
    business_color,
    emp_prefix,
  } = req.body;

  db.serialize(() => {
    if (business_name) {
      db.run(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES ('business_name', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
        [business_name],
      );
    }
    db.run(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES ('business_location', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
      [business_location],
    );
    if (business_color) {
      db.run(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES ('business_color', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
        [business_color],
      );
    }
    if (emp_prefix) {
      db.run(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES ('emp_prefix', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
        [emp_prefix],
      );
      db.run(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES ('company_prefix', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
        [emp_prefix],
      );
    }
    db.run(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES ('business_contact', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
      [business_contact],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        emitAndBust("settings", "settings");
        res.json({ message: "Settings saved" });
      },
    );
  });
});

// 8. Shifts & Credentials
app.get("/api/shifts/status", authenticateToken, (req, res) => {
  db.get("SELECT * FROM shifts ORDER BY id DESC LIMIT 1", [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || { status: "CLOSED" });
  });
});

app.post("/api/shifts/toggle", authenticateToken, (req, res) => {
  const isAuthorized = ["Security", "CEO", "HR"].includes(req.user.role);
  if (!isAuthorized) {
    return res
      .status(403)
      .json({
        error: `Permission Denied: ${req.user.role}s cannot manage shifts.`,
      });
  }

  const { action } = req.body;
  const user_id = req.user.id;

  if (action === "OPEN") {
    db.run(
      "INSERT INTO shifts (opened_by, status) VALUES (?, ?)",
      [user_id, "OPEN"],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        // Reset all presence for a new shift
        db.run("UPDATE employees SET is_present = 0");
        io.emit("db_updated", { module: "shift" });
        res.json({
          message: "Operational Shift is now OPEN. Presence state reset.",
        });
      },
    );
  } else {
    db.run(
      "UPDATE shifts SET closed_by = ?, close_time = CURRENT_TIMESTAMP, status = 'CLOSED' WHERE status = 'OPEN'",
      [user_id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit("db_updated", { module: "shift" });
        res.json({
          message:
            "Operational Shift is now CLOSED. Attendance logs suspended.",
        });
      },
    );
  }
});

app.patch("/api/users/:id/credentials", authenticateToken, async (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  const { id } = req.params;
  const { password, role, username, nickname } = req.body;

  try {
    let sql = "UPDATE employees SET role = ?, username = ? WHERE id = ?";
    let params = [role || null, username || null, id];

    if (password && password.trim().length > 0) {
      const hashedPassword = await bcrypt.hash(password, 10);
      sql =
        "UPDATE employees SET password = ?, role = ?, username = ? WHERE id = ?";
      params = [hashedPassword, role || null, username || null, id];
    }

    db.run(sql, params, function (err) {
      if (err) {
        console.error("Update Access Error:", err);
        return res.status(500).json({ error: err.message });
      }
      emitAndBust("employees", "employees");
      res.json({ message: "Credentials updated successfully" });
    });
  } catch (e) {
    console.error("Server Encryption Error:", e);
    res.status(500).json({ error: "Encryption failed" });
  }
});

// HR-only: Pause or restore access for an employee (toggle is_active)
app.patch("/api/users/:id/access", authenticateToken, (req, res) => {
  if (req.user.role !== "HR" && req.user.role !== "CEO") {
    return res
      .status(403)
      .json({
        error: "Forbidden: Only HR can pause or restore account access.",
      });
  }
  const { id } = req.params;
  const { is_active } = req.body; // 0 = paused, 1 = active
  if (typeof is_active === "undefined") {
    return res
      .status(400)
      .json({ error: "is_active field required (0 or 1)." });
  }
  db.run(
    "UPDATE employees SET is_active = ? WHERE id = ?",
    [is_active ? 1 : 0, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0)
        return res.status(404).json({ error: "Employee not found." });
      emitAndBust("employees", "employees");
      res.json({
        message: is_active
          ? "Account access restored."
          : "Account access paused.",
      });
    },
  );
});

app.post("/api/users/tech-reset", authenticateToken, async (req, res) => {
  // Only allow System Technician or CEO level access to force reset by username
  if (req.user.role !== "CEO")
    return res
      .status(403)
      .json({ error: "Forbidden: System Technician access required." });

  const { username, newPassword } = req.body;
  if (!username || !newPassword)
    return res
      .status(400)
      .json({ error: "Username and new password are required." });

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.run(
      "UPDATE employees SET password = ? WHERE username = ?",
      [hashedPassword, username],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0)
          return res
            .status(404)
            .json({ error: `User '${username}' not found.` });

        emitAndBust("employees", "employees");
        res.json({ message: "Password reset successfully." });
      },
    );
  } catch (e) {
    console.error("Tech Reset Encryption Error:", e);
    res.status(500).json({ error: "Encryption failed" });
  }
});

// 9. System Settings & Business Config
app.get("/api/settings", authenticateToken, (req, res) => {
  const schema = getSchema();
  const cached = getCache(schema, "settings");
  if (cached) return res.json(cached);
  db.all("SELECT * FROM app_settings", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const settings = {};
    rows.forEach((r) => {
      try {
        settings[r.setting_key] = JSON.parse(r.setting_value);
      } catch (e) {
        settings[r.setting_key] = r.setting_value;
      }
    });
    const result = { settings };
    setCache(schema, "settings", result, 120); // 120s TTL â€” rarely changes
    res.json(result);
  });
});

app.post("/api/settings", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(401).json({ error: "Unauthorized" });
  const { key, data } = req.body;

  if (key === "business_modules" && req.user.name !== "System Technician") {
    return res
      .status(403)
      .json({
        error:
          "Access Denied: Only the System Technician can modify active business modules.",
      });
  }

  db.run(
    "INSERT OR REPLACE INTO app_settings (setting_key, setting_value) VALUES (?, ?)",
    [key, JSON.stringify(data)],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      emitAndBust("settings", "settings"); // Broadcast settings update
      res.json({ message: "Setting saved" });
    },
  );
});

// 10. Financial Intelligence Engine
app.get("/api/finance/summary", authenticateToken, (req, res) => {
  const schema = getSchema();
  const cached = getCache(schema, "finance_summary");
  if (cached) return res.json(cached);
  // All dates computed in EAT (East Africa Time = UTC+3) to match Uganda local time
  const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

  function toEAT(val) {
    if (!val) return "";
    const d =
      val instanceof Date ? val : new Date(String(val).replace(" ", "T"));
    if (isNaN(d.getTime())) return "";
    return new Date(d.getTime() + EAT_OFFSET_MS).toISOString().split("T")[0];
  }

  const today = toEAT(new Date().toISOString());
  const weekAgo = toEAT(
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  );
  const monthStart = today.substring(0, 7) + "-01";

  db.all(
    "SELECT amount, type, transaction_date FROM transactions",
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      let todayIncome = 0,
        todayExpense = 0;
      let weekIncome = 0,
        weekExpense = 0;
      let monthIncome = 0,
        monthExpense = 0;
      let totalIncome = 0,
        totalExpense = 0;

      rows.forEach((tx) => {
        const txDate = toEAT(tx.transaction_date);
        const amt = parseFloat(tx.amount) || 0;

        if (tx.type === "INCOME") totalIncome += amt;
        else totalExpense += amt;

        if (!txDate) return;

        if (txDate === today) {
          if (tx.type === "INCOME") todayIncome += amt;
          else todayExpense += amt;
        }
        if (txDate >= weekAgo) {
          if (tx.type === "INCOME") weekIncome += amt;
          else weekExpense += amt;
        }
        if (txDate >= monthStart) {
          if (tx.type === "INCOME") monthIncome += amt;
          else monthExpense += amt;
        }
      });

      const result = {
        today: {
          income: todayIncome,
          expense: todayExpense,
          profit: todayIncome - todayExpense,
        },
        week: {
          income: weekIncome,
          expense: weekExpense,
          profit: weekIncome - weekExpense,
        },
        month: {
          income: monthIncome,
          expense: monthExpense,
          profit: monthIncome - monthExpense,
        },
        allTime: {
          income: totalIncome,
          expense: totalExpense,
          profit: totalIncome - totalExpense,
        },
        totalTransactions: rows.length,
        asOf:
          new Date(Date.now() + EAT_OFFSET_MS)
            .toISOString()
            .replace("T", " ")
            .substring(0, 16) + " EAT",
        _debug: {
          serverToday: today,
          serverWeekAgo: weekAgo,
          serverMonthStart: monthStart,
          lastFewTx: rows.slice(-5).map((tx) => ({
            originalDate: tx.transaction_date,
            parsedTxDate: toEAT(tx.transaction_date),
            type: tx.type,
            amount: tx.amount,
          })),
        },
      };
      setCache(schema, "finance_summary", result, 30); // 30s TTL
      res.json(result);
    },
  );
});

// 11. Employee Performance Notes
app.get("/api/notes/:empId", authenticateToken, (req, res) => {
  db.all(
    `SELECT n.*, e.first_name || ' ' || e.last_name as author_name 
            FROM employee_notes n 
            LEFT JOIN employees e ON n.created_by = e.id
            WHERE n.employee_id = ? ORDER BY n.created_at DESC`,
    [req.params.empId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ notes: rows || [] });
    },
  );
});

app.post("/api/notes", authenticateToken, (req, res) => {
  const { employee_id, note_text, note_type } = req.body;
  if (!employee_id || !note_text)
    return res
      .status(400)
      .json({ error: "Employee ID and note text required" });

  db.run(
    "INSERT INTO employee_notes (employee_id, note_text, note_type, created_by) VALUES (?, ?, ?, ?)",
    [employee_id, note_text, note_type || "GENERAL", req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "notes" });
      res.json({ id: this.lastID, message: "Note saved" });
    },
  );
});

app.delete("/api/notes/:id", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  db.run(
    "DELETE FROM employee_notes WHERE id = ?",
    [req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Note deleted" });
    },
  );
});

app.post("/api/employees/sick", authenticateToken, (req, res) => {
  const isStaffControl = ["CEO", "HR", "Supervisor", "Manager"].includes(
    req.user.role,
  );
  if (!isStaffControl)
    return res.status(403).json({ error: "Permission Denied." });

  const { employee_id, is_sick } = req.body;
  db.run(
    "UPDATE employees SET is_sick = ?, is_present = 0 WHERE id = ?",
    [is_sick ? 1 : 0, employee_id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      emitAndBust("employees", "employees");
      res.json({ message: `Health status updated for staff #${employee_id}` });
    },
  );
});

app.get("/api/attendance/summary", authenticateToken, (req, res) => {
  db.get(
    `SELECT 
        (SELECT COUNT(*) FROM employees WHERE is_active = 1) as total,
        (SELECT COUNT(*) FROM employees WHERE is_present = 1) as present,
        (SELECT COUNT(*) FROM employees WHERE is_sick = 1) as sick`,
    [],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(row);
    },
  );
});

// 13. Intelligent Workforce Scheduler
app.post("/api/scheduler/auto-generate", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "HQ Only" });

  const { start_date, days_count, staff_per_shift = 2 } = req.body;

  db.all(
    "SELECT id FROM employees WHERE is_active = 1 AND is_sick = 0",
    [],
    (err, emps) => {
      if (err) return res.status(500).json({ error: err.message });

      const queries = [];
      const shifts = [
        { start: "08:00", end: "16:00" },
        { start: "16:00", end: "00:00" },
        { start: "00:00", end: "08:00" },
      ];

      let globalEmpIndex = 0; // rotate through employees across days
      for (let i = 0; i < days_count; i++) {
        const d = new Date(start_date);
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().split("T")[0];

        // For each day, we fill as many shifts as we have workers for
        // or just fill shifts sequentially.
        // A simple rotation algorithm:
        for (let shift of shifts) {
          // Determine how many we assign to this shift
          // If we don't have enough total employees, we cap it
          let assigned = 0;
          for (let j = 0; j < staff_per_shift; j++) {
            if (emps.length === 0) break;
            queries.push([
              emps[globalEmpIndex % emps.length].id,
              dateStr,
              shift.start,
              shift.end,
            ]);
            globalEmpIndex++;
            assigned++;
          }
          // If we've exhausted employees such that assigning more would mean
          // people working double shifts on the same day, we stop filling shifts for today.
          // For simplicity, we just assign the staff_per_shift and rotate.
          // In a real system we'd ensure no overlap, but since we rotate modulo total emps,
          // if total emps < staff_per_shift, they get double shifts anyway.
          if (assigned < staff_per_shift) break;
        }
      }

      if (queries.length === 0) {
        return res.json({
          message: "No active, healthy employees to schedule.",
        });
      }

      // Batch insert (SQLite friendly)
      let processed = 0;
      let hadError = false;
      queries.forEach((q) => {
        db.run(
          "INSERT INTO schedules (employee_id, shift_date, start_time, end_time) VALUES (?, ?, ?, ?)",
          q,
          (err) => {
            if (err) {
              hadError = true;
              console.error("[Scheduler] Insert error:", err.message);
            }
            processed++;
            if (processed === queries.length) {
              io.emit("db_updated", { module: "schedules" });
              if (hadError) {
                res.json({
                  message: `Shifts generated with some errors. ${processed} slots attempted.`,
                });
              } else {
                res.json({
                  message: `Successfully generated ${queries.length} shift slots.`,
                });
              }
            }
          },
        );
      });
    },
  );
});

app.get("/api/expense-categories", authenticateToken, (req, res) => {
  db.all("SELECT * FROM expense_categories ORDER BY name", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ categories: rows || [] });
  });
});

app.post("/api/expense-categories", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  const { name, budget_limit, color } = req.body;
  if (!name) return res.status(400).json({ error: "Category name required" });

  db.run(
    "INSERT INTO expense_categories (name, budget_limit, color) VALUES (?, ?, ?)",
    [name, budget_limit || 0, color || "#6366F1"],
    function (err) {
      if (err) {
        if ((err.message || "").includes("UNIQUE"))
          return res.status(400).json({ error: "Category already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, message: "Category created" });
    },
  );
});

app.delete("/api/expense-categories/:id", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR")
    return res.status(403).json({ error: "Forbidden" });
  db.run(
    "DELETE FROM expense_categories WHERE id = ?",
    [req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Category deleted" });
    },
  );
});

// 14. Low Stock Alerts
app.get("/api/alerts/low-stock", authenticateToken, (req, res) => {
  db.all(
    "SELECT * FROM products WHERE stock < 10 ORDER BY stock ASC",
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ alerts: rows || [] });
    },
  );
});

// 15. Hardware Radar (Device Tracking)
setInterval(() => {
  // Mark devices as OFFLINE if they haven't been seen in 90 seconds
  db.run(
    `UPDATE devices SET status = 'OFFLINE' 
            WHERE status = 'ONLINE' AND last_seen < datetime('now', '-90 seconds')`,
    function (err) {
      // NOTE: must use regular function (not arrow) so 'this' refers to sqlite stmt context
      if (err) {
        console.error("[RADAR] Device timeout error:", err.message);
        return;
      }
      if (this.changes > 0) {
        console.log(
          `[RADAR] Marked ${this.changes} inactive devices as OFFLINE`,
        );
        io.emit("db_updated", { module: "devices" });
      }
    },
  );
}, 30000);

app.post("/api/devices/ping", (req, res) => {
  const { device_id, device_name, device_type, company_schema, client_ip } =
    req.body;
  // Determine the best IP: X-Forwarded-For > X-Real-IP > req.ip > socket remoteAddress
  let ip =
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.ip ||
    req.socket?.remoteAddress ||
    "0.0.0.0";
  // Strip IPv6 loopback prefix (::ffff:)
  ip = ip
    .replace(/^::ffff:/, "")
    .split(",")[0]
    .trim();
  // If still local loopback, use the client-reported IP if available
  if ((ip === "127.0.0.1" || ip === "::1") && client_ip) ip = client_ip;
  const schema = company_schema || "public";
  db.run(
    `INSERT INTO devices (device_id, device_name, device_type, ip_address, status, last_seen, company_schema) 
            VALUES (?, ?, ?, ?, 'ONLINE', datetime('now'), ?)
            ON CONFLICT(device_id) DO UPDATE SET 
            last_seen=datetime('now'), status='ONLINE', ip_address=?, company_schema=?`,
    [device_id, device_name, device_type, ip, schema, ip, schema],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "devices" });
      res.json({ message: "Ping recorded" });
    },
  );
});

app.get("/api/devices", authenticateToken, (req, res) => {
  // Only HR and CEO can access; filter strictly by the requester's company schema
  if (!["HR", "CEO"].includes(req.user.role)) {
    return res.status(403).json({ error: "Access denied. HR only." });
  }
  const userPrefix = req.user.prefix;
  const companySchema = userPrefix ? "t_" + userPrefix.toLowerCase() : "public";
  db.all(
    "SELECT * FROM devices WHERE company_schema = ? ORDER BY last_seen DESC",
    [companySchema],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ devices: rows });
    },
  );
});

app.post("/api/devices/logout", authenticateToken, (req, res) => {
  if (!["HR", "CEO"].includes(req.user.role)) {
    return res.status(403).json({ error: "Access denied. HR only." });
  }
  const { device_id } = req.body;
  const userPrefix = req.user.prefix;
  const companySchema = userPrefix ? "t_" + userPrefix.toLowerCase() : "public";
  // Ensure device belongs to the same company before deleting
  db.run(
    `DELETE FROM devices WHERE device_id = ? AND company_schema = ?`,
    [device_id, companySchema],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0)
        return res
          .status(404)
          .json({ error: "Device not found in your company." });
      io.emit("force_logout", { device_id });
      res.json({ message: "Device logged out successfully." });
    },
  );
});

// 15b. Kiosk Terminal APIs (no user login required â€” device-based auth)
app.post("/api/kiosk/auth", (req, res) => {
  const { device_id, device_name, device_type } = req.body;
  if (!device_id) return res.status(400).json({ error: "Device ID required." });

  // Issue a service token for kiosk devices (limited scope, 24h expiry)
  const token = jwt.sign(
    {
      id: 0,
      role: "Kiosk",
      name: device_name || "Kiosk",
      permissions: {},
      device_id,
    },
    JWT_SECRET,
    { expiresIn: "24h" },
  );

  // Register/update device
  const ip = req.ip || req.headers["x-forwarded-for"] || "0.0.0.0";
  db.run(
    `INSERT INTO devices (device_id, device_name, device_type, ip_address, status, last_seen) 
            VALUES (?, ?, ?, ?, 'ONLINE', datetime('now'))
            ON CONFLICT(device_id) DO UPDATE SET 
            last_seen=datetime('now'), status='ONLINE', device_name=?, device_type=?, ip_address=?`,
    [
      device_id,
      device_name || "Kiosk",
      device_type || "Security Kiosk",
      ip,
      device_name,
      device_type,
      ip,
    ],
  );

  res.json({ token, message: "Kiosk authenticated", expires_in: "24h" });
});

app.post("/api/kiosk/scan", authenticateToken, (req, res) => {
  const { identifier, device_id } = req.body;
  if (!identifier)
    return res.status(400).json({ error: "Badge/code required." });

  db.get(
    "SELECT id, first_name, last_name, is_active, is_sick, is_present FROM employees WHERE id = ? OR employee_code = ?",
    [identifier, identifier],
    (err, emp) => {
      if (err) return res.status(500).json({ error: "Database error" });
      if (!emp)
        return res
          .status(404)
          .json({ error: "Employee not found. Badge not recognized." });
      if (emp.is_active === 0)
        return res
          .status(403)
          .json({ error: "ACCESS DENIED: This ID has been deactivated." });
      if (emp.is_sick)
        return res
          .status(403)
          .json({
            error: "ACCESS DENIED: Staff is registered as SICK/RECOVERING.",
          });

      const fullName = `${emp.first_name} ${emp.last_name}`;
      const localTime = new Date().toISOString();

      // Check shift status
      db.get(
        "SELECT status FROM shifts ORDER BY id DESC LIMIT 1",
        (err, shift) => {
          if (shift && shift.status === "CLOSED") {
            return res
              .status(403)
              .json({
                error: "Business is currently CLOSED. Open a shift first.",
              });
          }

          // Auto-detect: if present â†’ clock OUT, if absent â†’ clock IN
          if (emp.is_present === 1) {
            // CLOCK OUT
            db.run(
              "INSERT INTO attendance_logs (employee_id, scan_time, scan_type, status) VALUES (?, ?, ?, ?)",
              [emp.id, localTime, "OUT", "SUCCESS"],
              function (err) {
                if (err) return res.status(500).json({ error: err.message });
                db.run("UPDATE employees SET is_present = 0 WHERE id = ?", [
                  emp.id,
                ]);
                emitAndBust("attendance", "attendance");
                res.json({
                  message: `Hello Clocked OUT: ${fullName}`,
                  name: fullName,
                  action: "OUT",
                  device: device_id,
                  time: localTime,
                });
              },
            );
          } else {
            // CLOCK IN
            db.run(
              "INSERT INTO attendance_logs (employee_id, scan_time, scan_type, status) VALUES (?, ?, ?, ?)",
              [emp.id, localTime, "IN", "SUCCESS"],
              function (err) {
                if (err) return res.status(500).json({ error: err.message });
                db.run("UPDATE employees SET is_present = 1 WHERE id = ?", [
                  emp.id,
                ]);
                emitAndBust("attendance", "attendance");
                res.json({
                  message: `[OK] Clocked IN: ${fullName}`,
                  name: fullName,
                  action: "IN",
                  device: device_id,
                  time: localTime,
                });
              },
            );
          }
        },
      );
    },
  );
});

// Server discovery endpoint â€” devices on same network can find the server
app.get("/api/discover", (req, res) => {
  res.json({
    service: "Jomish Business Suite",
    version: "2.0",
    kiosk_url: "/kiosk.html",
    login_url: "/login.html",
    api_base: "/api",
    hostname: os.hostname(),
    ip: getLocalIP(),
    port: PORT,
  });
});

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

// 16. Calendar Events
app.get("/api/calendar/events", authenticateToken, (req, res) => {
  const { month, year } = req.query;
  let sql =
    "SELECT * FROM calendar_events ORDER BY event_date ASC, start_time ASC";
  let params = [];
  if (month && year) {
    const monthStr = String(month).padStart(2, "0");
    sql =
      "SELECT * FROM calendar_events WHERE event_date LIKE ? ORDER BY event_date ASC, start_time ASC";
    params = [`${year}-${monthStr}%`];
  }
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ events: rows || [] });
  });
});

app.post("/api/calendar/events", authenticateToken, (req, res) => {
  const {
    title,
    description,
    event_date,
    start_time,
    end_time,
    event_type,
    color,
  } = req.body;
  if (!title || !event_date)
    return res.status(400).json({ error: "Title and date required" });
  db.run(
    "INSERT INTO calendar_events (title, description, event_date, start_time, end_time, event_type, color, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      title,
      description || "",
      event_date,
      start_time || "",
      end_time || "",
      event_type || "Meeting",
      color || "#4F46E5",
      req.user.id,
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "calendar" });
      res.json({ id: this.lastID, message: "Event created" });
    },
  );
});

app.put("/api/calendar/events/:id", authenticateToken, (req, res) => {
  const {
    title,
    description,
    event_date,
    start_time,
    end_time,
    event_type,
    color,
  } = req.body;
  db.run(
    "UPDATE calendar_events SET title=?, description=?, event_date=?, start_time=?, end_time=?, event_type=?, color=? WHERE id=?",
    [
      title,
      description,
      event_date,
      start_time,
      end_time,
      event_type,
      color,
      req.params.id,
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "calendar" });
      res.json({ message: "Event updated" });
    },
  );
});

app.delete("/api/calendar/events/:id", authenticateToken, (req, res) => {
  db.run(
    "DELETE FROM calendar_events WHERE id = ?",
    [req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "calendar" });
      res.json({ success: true });
    },
  );
});

app.post("/api/calendar/events/:id/minutes", authenticateToken, (req, res) => {
  const { minutes } = req.body;
  db.run(
    "UPDATE calendar_events SET minutes = ? WHERE id = ?",
    [minutes, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "calendar" });
      res.json({ success: true });
    },
  );
});

// 17. Email Inbox (Gmail IMAP & SMTP)
let imapSimple, mailSimpleParser, nodemailer;
try {
  imapSimple = require("imap-simple");
  mailSimpleParser = require("mailparser").simpleParser;
  nodemailer = require("nodemailer");
  console.log(
    "[EMAIL] [OK] All email packages loaded (imap-simple, mailparser, nodemailer).",
  );
} catch (e) {
}

// Helper: Get email config from DB (promisified)
function getEmailConfig() {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT setting_value FROM app_settings WHERE setting_key = 'EMAIL_CONFIG'`,
      (err, row) => {
        if (err)
          return reject(
            new Error("Database error reading email config: " + err.message),
          );
        if (!row)
          return reject(
            new Error(
              "Email not configured. Go to Secretary Hub â†’ Email Inbox â†’ [CONFIG] Config to set up your Gmail credentials.",
            ),
          );
        let cfg;
        try {
          cfg = JSON.parse(row.setting_value);
        } catch (e) {
          return reject(
            new Error(
              "Email config is corrupted. Please re-enter your Gmail credentials.",
            ),
          );
        }
        if (!cfg.email)
          return reject(
            new Error(
              "Gmail address is missing from config. Please update your email settings.",
            ),
          );
        if (!cfg.app_password)
          return reject(
            new Error(
              "Gmail App Password is missing. Please update your email settings.",
            ),
          );
        resolve(cfg);
      },
    );
  });
}

async function fetchGmailInbox() {
  if (!imapSimple || !mailSimpleParser) {
    throw new Error(
      "Email packages not installed on server. Run: npm install imap-simple mailparser nodemailer",
    );
  }

  const cfg = await getEmailConfig(); // Throws if not configured

  let connection;
  try {
    connection = await imapSimple.connect({
      imap: {
        user: cfg.email,
        password: cfg.app_password,
        host: "imap.gmail.com",
        port: 993,
        tls: true,
        authTimeout: 20000,
        tlsOptions: { rejectUnauthorized: false },
      },
    });
  } catch (connErr) {
    const msg = connErr.message || String(connErr);
    if (
      msg.includes("Invalid credentials") ||
      msg.includes("AUTHENTICATIONFAILED")
    ) {
      throw new Error(
        "Gmail authentication failed. Your App Password may be incorrect or expired. Go to https://myaccount.google.com/apppasswords to generate a new one.",
      );
    }
    if (
      msg.includes("ETIMEDOUT") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("ECONNREFUSED")
    ) {
      throw new Error(
        "Cannot reach Gmail servers. Check your internet connection.",
      );
    }
    throw new Error("IMAP connection failed: " + msg);
  }

  try {
    await connection.openBox("INBOX");

    // Strategy 1: Fetch only emails from the last 30 days to avoid downloading entire inbox
    const sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let results = [];
    try {
      results = await connection.search([["SINCE", sinceDate]], {
        bodies: ["HEADER", ""],
        markSeen: false,
        struct: true,
      });
    } catch (searchErr) {
      // Fallback: fetch ALL but limit to last 50
      console.warn(
        "[EMAIL] SINCE search failed, falling back to ALL (limited):",
        searchErr.message,
      );
      const allResults = await connection.search(["ALL"], {
        bodies: ["HEADER", ""],
        markSeen: false,
        struct: true,
      });
      results = allResults.slice(-50);
    }

    // Cap at 50 most recent
    const latest = results.slice(-50);
    const totalInbox = results.length;
    let newlySaved = 0;
    let totalProcessed = 0;

    for (const item of latest) {
      const uid = item.attributes.uid.toString();
      const all = item.parts.find((p) => p.which === "");
      if (!all) continue;
      try {
        const parsed = await mailSimpleParser(all.body);
        const fromAddr = parsed.from?.value?.[0]?.address || "unknown";
        const fromName = parsed.from?.value?.[0]?.name || fromAddr;
        const subject = parsed.subject || "(No Subject)";
        const bodyPreview = (
          parsed.text ||
          parsed.html?.replace(/<[^>]*>/g, "") ||
          ""
        ).substring(0, 1000);
        const receivedAt = parsed.date
          ? parsed.date.toISOString()
          : new Date().toISOString();

        await new Promise((resolve) => {
          db.run(
            "INSERT OR IGNORE INTO email_messages (message_uid, from_address, from_name, subject, body_preview, received_at) VALUES (?, ?, ?, ?, ?, ?)",
            [uid, fromAddr, fromName, subject, bodyPreview, receivedAt],
            function (err) {
              if (!err && this.changes > 0) newlySaved++;
              totalProcessed++;
              resolve();
            },
          );
        });
      } catch (pe) {
        console.error("[EMAIL] Parse error for UID", uid, ":", pe.message);
      }
    }

    connection.end();
    if (newlySaved > 0) {
      console.log(
        `[EMAIL] [OK] Sync complete: ${newlySaved} new emails saved, ${totalProcessed} processed.`,
      );
      io.emit("db_updated", { module: "emails", count: newlySaved });
    }

    return { success: true, newEmails: newlySaved, totalProcessed, totalInbox };
  } catch (fetchErr) {
    try {
      connection.end();
    } catch (e) {}
    throw new Error("Failed to read inbox: " + fetchErr.message);
  }
}

// Background Polling (silent â€” errors are logged, not thrown)
setInterval(async () => {
  try {
    await fetchGmailInbox();
  } catch (e) {
    // Only log config errors once, not every 30s
    if (
      !e.message.includes("not configured") &&
      !e.message.includes("missing")
    ) {
      console.error("[EMAIL BG]", e.message);
    }
  }
}, 60 * 1000); // Poll every 60 seconds

app.get("/api/emails", authenticateToken, (req, res) => {
  db.all(
    "SELECT * FROM email_messages ORDER BY received_at DESC LIMIT 100",
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const unread = (rows || []).filter((r) => !r.is_read).length;
      res.json({ emails: rows || [], unread_count: unread });
    },
  );
});

app.post("/api/emails/fetch", authenticateToken, async (req, res) => {
  if (!imapSimple)
    return res
      .status(500)
      .json({ error: "Email packages not installed on server." });
  try {
    const result = await fetchGmailInbox();
    res.json({
      message:
        result.newEmails > 0
          ? `[OK] Synced! ${result.newEmails} new email(s) received.`
          : `[OK] Inbox is up to date. No new emails.`,
      newEmails: result.newEmails,
      totalProcessed: result.totalProcessed,
    });
  } catch (err) {
    console.error("[EMAIL FETCH ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/emails/send", authenticateToken, async (req, res) => {
  const allowedSend = ["CEO", "HR", "Receptionist"];
  if (!allowedSend.includes(req.user.role))
    return res
      .status(403)
      .json({
        error: `Permission denied. Only ${allowedSend.join(", ")} roles can send emails.`,
      });

  const { to, subject, body } = req.body;
  if (!to || !subject || !body)
    return res
      .status(400)
      .json({
        error: "Recipient, subject, and message body are all required.",
      });

  try {
    const cfg = await getEmailConfig();

    if (cfg.resend_api_key) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.resend_api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: cfg.email,
          to: to,
          subject: subject,
          text: body,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Resend API Error");

      res.json({ message: `Email sent successfully to ${to}`, info: data });
    } else {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: cfg.email, pass: cfg.app_password },
      });

      const mailOptions = {
        from: `"${cfg.email}" <${cfg.email}>`,
        to,
        subject,
        text: body,
      };
      const info = await transporter.sendMail(mailOptions);
      res.json({ message: `Email sent successfully to ${to}`, info });
    }
  } catch (err) {
    const msg = err.message || String(err);
    console.error("[EMAIL SEND ERROR]", msg);
    if (msg.includes("Invalid login") || msg.includes("auth")) {
      return res
        .status(500)
        .json({
          error:
            "Gmail authentication failed. Your App Password may be wrong or expired. Re-enter it in [CONFIG] Config.",
        });
    }
    res.status(500).json({ error: "Failed to send email: " + msg });
  }
});

app.post("/api/emails/blast", authenticateToken, async (req, res) => {
  const allowedBlast = ["CEO", "HR", "Receptionist"];
  if (!allowedBlast.includes(req.user.role))
    return res.status(403).json({ error: "Forbidden" });
  const { subject, body } = req.body;
  if (!subject || !body)
    return res
      .status(400)
      .json({ error: "Subject and message are required for the blast." });

  try {
    // 1. Fetch all active emails
    const employees = await new Promise((resolve, reject) => {
      db.all(
        'SELECT email FROM employees WHERE is_active = 1 AND email IS NOT NULL AND email != ""',
        [],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        },
      );
    });
    if (employees.length === 0)
      return res
        .status(400)
        .json({ error: "No active staff emails found in HR records." });

    const recipientList = employees.map((e) => e.email).join(", ");

    // 2. Get config and send
    const cfg = await getEmailConfig();

    if (cfg.resend_api_key) {
      // Resend API only allows up to 50 recipients per request usually, but we can send as an array.
      // Bcc is supported by passing an array to the 'bcc' field.
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.resend_api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: cfg.email,
          to: cfg.email, // Send to self
          bcc: employees.map((e) => e.email), // Array of emails for Resend BCC
          subject: `[NOTICE] [STAFF BLAST] ${subject}`,
          text: body,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Resend API Error");

      console.log(
        `[EMAIL] [OK] Blast sent via Resend to ${employees.length} staff`,
      );
      res.json({
        message: `Blast sent successfully to ${employees.length} workers!`,
        info: data,
      });
    } else {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: cfg.email, pass: cfg.app_password },
      });

      const mailOptions = {
        from: cfg.email,
        to: cfg.email,
        bcc: recipientList,
        subject: `[NOTICE] [STAFF BLAST] ${subject}`,
        text: body,
      };

      const info = await transporter.sendMail(mailOptions);
      console.log(
        `[EMAIL] [OK] Blast sent via SMTP to ${employees.length} staff`,
      );
      res.json({
        message: `Blast sent successfully to ${employees.length} workers!`,
        info,
      });
    }
  } catch (err) {
    const msg = err.message || String(err);
    console.error("[EMAIL BLAST ERROR]", msg);
    res.status(500).json({ error: "Blast failed: " + msg });
  }
});

app.patch("/api/emails/:id/read", authenticateToken, (req, res) => {
  db.run(
    "UPDATE email_messages SET is_read = 1 WHERE id = ?",
    [req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Marked as read" });
    },
  );
});

app.post("/api/settings/email", authenticateToken, (req, res) => {
  const allowedRoles = ["CEO", "HR", "Receptionist"];
  if (!allowedRoles.includes(req.user.role))
    return res.status(403).json({ error: "Forbidden" });
  const { email, app_password, resend_api_key } = req.body;

  db.get(
    `SELECT setting_value FROM app_settings WHERE setting_key = 'EMAIL_CONFIG'`,
    (err, row) => {
      let finalEmail = email;
      let finalPwd = app_password;
      let finalResend = resend_api_key;

      if (row) {
        try {
          const old = JSON.parse(row.setting_value);
          if (!finalPwd) finalPwd = old.app_password;
          if (!finalResend) finalResend = old.resend_api_key;
        } catch (e) {}
      }

      if (!finalEmail || (!finalPwd && !finalResend)) {
        return res
          .status(400)
          .json({
            error: "Email and App Password (or Resend Key) are required.",
          });
      }

      db.run(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES ('EMAIL_CONFIG', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
        [
          JSON.stringify({
            email: finalEmail,
            app_password: finalPwd,
            resend_api_key: finalResend,
          }),
        ],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ message: "Email configuration successfully updated." });
        },
      );
    },
  );
});

app.get("/api/settings/email", authenticateToken, (req, res) => {
  db.get(
    `SELECT setting_value FROM app_settings WHERE setting_key = 'EMAIL_CONFIG'`,
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.json({ configured: false });
      try {
        const c = JSON.parse(row.setting_value);
        res.json({
          configured: true,
          email: c.email,
          has_password: !!c.app_password,
        });
      } catch (e) {
        res.json({ configured: false });
      }
    },
  );
});

// 18. Internal Messaging (Secretary â†” Staff Communication)
app.get("/api/messages", authenticateToken, (req, res) => {
  const userId = req.user.id;
  db.all(
    `SELECT m.*, 
            sf.first_name as from_first, sf.last_name as from_last, sf.role as from_role, sf.email as from_email,
            st.first_name as to_first, st.last_name as to_last, st.role as to_role, st.email as to_email
            FROM internal_messages m
            LEFT JOIN employees sf ON m.from_id = sf.id
            LEFT JOIN employees st ON m.to_id = st.id
            WHERE m.to_id = ? OR m.from_id = ?
            ORDER BY m.created_at DESC LIMIT 100`,
    [userId, userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ messages: rows || [] });
    },
  );
});

app.post("/api/messages", authenticateToken, (req, res) => {
  const { to_id, subject, content } = req.body;
  if (!to_id || !content)
    return res.status(400).json({ error: "Recipient and message required" });
  db.run(
    "INSERT INTO internal_messages (from_id, to_id, subject, content) VALUES (?, ?, ?, ?)",
    [req.user.id, to_id, subject || "", content],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "messages" });
      io.emit("new_message", { to_id: parseInt(to_id), from: req.user.name });
      res.json({ id: this.lastID, message: "Message sent" });
    },
  );
});

app.patch("/api/messages/:id/read", authenticateToken, (req, res) => {
  db.run(
    "UPDATE internal_messages SET is_read = 1 WHERE id = ? AND to_id = ?",
    [req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Marked as read" });
    },
  );
});

app.get("/api/messages/unread", authenticateToken, (req, res) => {
  db.get(
    "SELECT COUNT(*) as count FROM internal_messages WHERE to_id = ? AND is_read = 0",
    [req.user.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ unread: row ? row.count : 0 });
    },
  );
});

// ===== SYSTEM META (version, backup tracking, data loss warnings) =====
// system_meta table is created as part of the DB schema in database.js
db.run(
  `INSERT OR IGNORE INTO system_meta (key, value) VALUES ('version', '1.0 Genesis')`,
);
db.run(
  `INSERT OR IGNORE INTO system_meta (key, value) VALUES ('installed_at', ?)`,
  [new Date().toISOString()],
);

app.get("/api/system-meta/:key", authenticateToken, (req, res) => {
  db.get(
    "SELECT * FROM system_meta WHERE key = ?",
    [req.params.key],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    },
  );
});

app.delete("/api/system-meta/:key", authenticateToken, (req, res) => {
  db.run(
    "DELETE FROM system_meta WHERE key = ?",
    [req.params.key],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ deleted: this.changes });
    },
  );
});

app.get("/api/system-meta", authenticateToken, (req, res) => {
  db.all("SELECT * FROM system_meta ORDER BY key", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// ===== SMART SHIFT ASSIGNMENT SYSTEM =====

// GET  /api/shift-assignments?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get("/api/shift-assignments", authenticateToken, (req, res) => {
  const { from, to } = req.query;
  let sql = `
        SELECT sa.id, sa.employee_id, sa.shift_date, sa.slot, sa.start_time, sa.end_time, sa.assigned_by,
               e.first_name, e.last_name, e.role
        FROM shift_assignments sa
        JOIN employees e ON sa.employee_id = e.id
    `;
  const params = [];
  if (from && to) {
    sql += " WHERE sa.shift_date BETWEEN ? AND ?";
    params.push(from, to);
  } else if (from) {
    sql += " WHERE sa.shift_date >= ?";
    params.push(from);
  }
  sql += " ORDER BY sa.shift_date ASC, sa.slot ASC, e.last_name ASC";
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ assignments: rows || [] });
  });
});

// POST /api/shift-assignments  â€” manually assign one shift (HR/CEO/Supervisor)
app.post("/api/shift-assignments", authenticateToken, (req, res) => {
  const allowed = ["CEO", "HR", "Supervisor"];
  if (!allowed.includes(req.user.role))
    return res.status(403).json({ error: "Permission denied." });
  const { employee_id, shift_date, slot, start_time, end_time } = req.body;
  if (!employee_id || !shift_date || !slot || !start_time || !end_time) {
    return res
      .status(400)
      .json({
        error:
          "employee_id, shift_date, slot, start_time, end_time are required.",
      });
  }
  db.run(
    `INSERT INTO shift_assignments (employee_id, shift_date, slot, start_time, end_time, assigned_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [employee_id, shift_date, slot, start_time, end_time, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "shift_assignments" });
      res.json({ id: this.lastID, message: "Shift assigned." });
    },
  );
});

// PATCH /api/shift-assignments/:id  â€” move/edit one assignment (HR/CEO/Supervisor)
app.patch("/api/shift-assignments/:id", authenticateToken, (req, res) => {
  const allowed = ["CEO", "HR", "Supervisor"];
  if (!allowed.includes(req.user.role))
    return res.status(403).json({ error: "Permission denied." });
  const { employee_id, shift_date, slot, start_time, end_time } = req.body;
  db.run(
    `UPDATE shift_assignments SET employee_id=?, shift_date=?, slot=?, start_time=?, end_time=?, assigned_by=? WHERE id=?`,
    [
      employee_id,
      shift_date,
      slot,
      start_time,
      end_time,
      req.user.id,
      req.params.id,
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0)
        return res.status(404).json({ error: "Assignment not found." });
      io.emit("db_updated", { module: "shift_assignments" });
      res.json({ message: "Assignment updated." });
    },
  );
});

// DELETE /api/shift-assignments/:id  â€” remove one assignment (HR/CEO only)
app.delete("/api/shift-assignments/:id", authenticateToken, (req, res) => {
  if (!["CEO", "HR"].includes(req.user.role))
    return res.status(403).json({ error: "Permission denied." });
  db.run(
    "DELETE FROM shift_assignments WHERE id = ?",
    [req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "shift_assignments" });
      res.json({ message: "Assignment removed." });
    },
  );
});

// DELETE /api/shift-assignments/week/:weekStart â€” clear all assignments for a week (HR/CEO only)
app.delete(
  "/api/shift-assignments/week/:weekStart",
  authenticateToken,
  (req, res) => {
    if (!["CEO", "HR"].includes(req.user.role))
      return res.status(403).json({ error: "Permission denied." });
    // weekStart = Monday date string. Compute the 7 dates.
    const start = new Date(req.params.weekStart);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const from = start.toISOString().split("T")[0];
    const to = end.toISOString().split("T")[0];
    db.run(
      "DELETE FROM shift_assignments WHERE shift_date BETWEEN ? AND ?",
      [from, to],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit("db_updated", { module: "shift_assignments" });
        res.json({
          message: `Cleared ${this.changes} assignments for ${from} â€“ ${to}.`,
        });
      },
    );
  },
);

// GET /api/scheduler/coverage?from=YYYY-MM-DD&to=YYYY-MM-DD  â€” staffing gap report
app.get("/api/scheduler/coverage", authenticateToken, (req, res) => {
  if (!["CEO", "HR", "Supervisor"].includes(req.user.role))
    return res.status(403).json({ error: "Forbidden" });
  const { from, to } = req.query;
  if (!from || !to)
    return res.status(400).json({ error: "from and to required." });

  db.get(
    "SELECT setting_value FROM app_settings WHERE setting_key = ?",
    ["BUSINESS_BLUEPRINT"],
    (err, row) => {
      const blueprint = row
        ? (() => {
            try {
              return JSON.parse(row.setting_value);
            } catch (e) {
              return null;
            }
          })()
        : null;
      db.all(
        `
            SELECT sa.shift_date, sa.slot, e.role, COUNT(*) as filled
            FROM shift_assignments sa JOIN employees e ON sa.employee_id = e.id
            WHERE sa.shift_date BETWEEN ? AND ?
            GROUP BY sa.shift_date, sa.slot, e.role
        `,
        [from, to],
        (err2, rows) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ coverage: rows, blueprint });
        },
      );
    },
  );
});

// POST /api/scheduler/smart-generate  â€” intelligent workforce scheduler
app.post("/api/scheduler/smart-generate", authenticateToken, (req, res) => {
  if (!["CEO", "HR"].includes(req.user.role))
    return res.status(403).json({ error: "HQ Only." });
  const { week_start, clear_existing = true } = req.body;
  if (!week_start)
    return res.status(400).json({ error: "week_start (YYYY-MM-DD) required." });

  // --- 1. Load Business Blueprint ---
  db.get(
    "SELECT setting_value FROM app_settings WHERE setting_key = ?",
    ["BUSINESS_BLUEPRINT"],
    (bpErr, bpRow) => {
      const blueprint = bpRow
        ? (() => {
            try {
              return JSON.parse(bpRow.setting_value);
            } catch (e) {
              return null;
            }
          })()
        : null;

      // Blueprint defaults if not configured
      const opDays = blueprint?.days || [
        "Mon",
        "Tue",
        "Wed",
        "Thu",
        "Fri",
        "Sat",
      ];
      const openTime = blueprint?.openingTime || "08:00";
      const hoursPerSh = parseInt(blueprint?.hoursPerShift || 8, 10);
      const staffingReq = blueprint?.staffing || {}; // { roleName: requiredPerShift }

      // Derive shift slots from openingTime + hoursPerShift
      // e.g. 08:00 + 8h = 08:00â€“16:00 / 16:00â€“00:00 / 00:00â€“08:00
      const toMinutes = (t) => {
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
      };
      const toTime = (mins) => {
        const h = Math.floor((((mins % 1440) + 1440) % 1440) / 60);
        const m = (((mins % 1440) + 1440) % 1440) % 60;
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      };
      const slotNames = ["morning", "afternoon", "night"];
      const startMins = toMinutes(openTime);
      const slots = slotNames.map((name, i) => ({
        name,
        start: toTime(startMins + i * hoursPerSh * 60),
        end: toTime(startMins + (i + 1) * hoursPerSh * 60),
      }));

      const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
      const opDayNums = new Set(opDays.map((d) => dayMap[d]));

      // Build the 7 dates of the week
      const weekDates = [];
      const ws = new Date(week_start);
      for (let i = 0; i < 7; i++) {
        const d = new Date(ws);
        d.setDate(ws.getDate() + i);
        const dayNum = d.getDay();
        if (opDayNums.has(dayNum))
          weekDates.push(d.toISOString().split("T")[0]);
      }

      if (weekDates.length === 0) {
        return res.json({
          message: "No operational days in this week per Business Blueprint.",
          generated: 0,
        });
      }

      // --- 2. Load employees grouped by role ---
      db.all(
        "SELECT id, first_name, last_name, role FROM employees WHERE is_active = 1 AND is_sick = 0 ORDER BY role, last_name",
        [],
        (empErr, employees) => {
          if (empErr) return res.status(500).json({ error: empErr.message });
          if (employees.length === 0)
            return res.json({
              message: "No active employees to schedule.",
              generated: 0,
            });

          // Group by role
          const byRole = {};
          employees.forEach((e) => {
            if (!byRole[e.role]) byRole[e.role] = [];
            byRole[e.role].push({ ...e, shiftCount: 0 }); // shiftCount = fairness counter
          });

          const fromDate = weekDates[0];
          const toDate = weekDates[weekDates.length - 1];

          const doGenerate = () => {
            // --- 3. Load existing shift counts for fairness baseline ---
            db.all(
              `SELECT employee_id, COUNT(*) as cnt FROM shift_assignments WHERE shift_date BETWEEN ? AND ? GROUP BY employee_id`,
              [fromDate, toDate],
              (fcErr, fcRows) => {
                const fcMap = {};
                (fcRows || []).forEach((r) => (fcMap[r.employee_id] = r.cnt));
                // Apply to employee pools
                Object.values(byRole).forEach((pool) =>
                  pool.forEach((e) => {
                    e.shiftCount = fcMap[e.id] || 0;
                  }),
                );

                // --- 4. Generate assignments ---
                const insertRows = [];
                const gaps = [];

                for (const date of weekDates) {
                  for (const slot of slots) {
                    for (const [role, required] of Object.entries(
                      staffingReq,
                    )) {
                      const needed = parseInt(required, 10) || 0;
                      if (needed <= 0) continue;
                      const pool = byRole[role] || [];
                      if (pool.length === 0) {
                        gaps.push({
                          date,
                          slot: slot.name,
                          role,
                          needed,
                          available: 0,
                        });
                        continue;
                      }
                      // Sort by fewest shifts assigned (fairness)
                      pool.sort((a, b) => a.shiftCount - b.shiftCount);
                      const picked = pool.slice(0, needed);
                      if (picked.length < needed) {
                        gaps.push({
                          date,
                          slot: slot.name,
                          role,
                          needed,
                          available: pool.length,
                        });
                      }
                      picked.forEach((emp) => {
                        insertRows.push([
                          emp.id,
                          date,
                          slot.name,
                          slot.start,
                          slot.end,
                          null,
                        ]);
                        emp.shiftCount++; // Update in-memory fairness counter
                      });
                    }

                    // If NO role-based staffing configured at all, fall back to all active employees
                    if (Object.keys(staffingReq).length === 0) {
                      employees.sort(
                        (a, b) => (fcMap[a.id] || 0) - (fcMap[b.id] || 0),
                      );
                      const pick = employees.slice(0, 2);
                      pick.forEach((emp) => {
                        insertRows.push([
                          emp.id,
                          date,
                          slot.name,
                          slot.start,
                          slot.end,
                          null,
                        ]);
                        fcMap[emp.id] = (fcMap[emp.id] || 0) + 1;
                      });
                    }
                  }
                }

                if (insertRows.length === 0) {
                  return res.json({
                    message:
                      "Nothing to schedule. Check Blueprint staffing requirements.",
                    generated: 0,
                    gaps,
                  });
                }

                // --- 5. Batch insert ---
                let done = 0,
                  hadError = false;
                insertRows.forEach((row) => {
                  db.run(
                    "INSERT INTO shift_assignments (employee_id, shift_date, slot, start_time, end_time, assigned_by) VALUES (?,?,?,?,?,?)",
                    row,
                    (iErr) => {
                      if (iErr) {
                        hadError = true;
                        console.error(
                          "[SmartScheduler] Insert error:",
                          iErr.message,
                        );
                      }
                      done++;
                      if (done === insertRows.length) {
                        io.emit("db_updated", { module: "shift_assignments" });
                        res.json({
                          message: `Generated ${insertRows.length} shift assignments.`,
                          generated: insertRows.length,
                          gaps: gaps.length > 0 ? gaps : undefined,
                        });
                      }
                    },
                  );
                });
              },
            );
          };

          // --- Optionally clear existing week before generating ---
          if (clear_existing) {
            db.run(
              "DELETE FROM shift_assignments WHERE shift_date BETWEEN ? AND ?",
              [fromDate, toDate],
              doGenerate,
            );
          } else {
            doGenerate();
          }
        },
      );
    },
  );
});

// ==== PAYROLL ENDPOINTS ====
app.get("/api/payroll/status", authenticateToken, (req, res) => {
  const monthYear = req.query.month;
  if (!monthYear) return res.status(400).json({ error: "Month is required" });

  db.all(
    `
        SELECT e.id, e.first_name, e.last_name, e.role, e.salary, e.created_at,
               (SELECT SUM(amount) FROM payroll_records WHERE employee_id = e.id) as total_paid_all_time,
               (SELECT SUM(amount) FROM payroll_records WHERE employee_id = e.id AND month_year = ?) as paid_this_month,
               (SELECT MAX(paid_at) FROM payroll_records WHERE employee_id = e.id AND month_year = ?) as paid_at
        FROM employees e
        WHERE e.salary > 0 AND e.is_active = 1
    `,
    [monthYear, monthYear],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Database error" });

      const [selYear, selMonth] = monthYear.split("-");
      const selDate = new Date(selYear, parseInt(selMonth) - 1, 1);

      rows.forEach((emp) => {
        const createdDate = new Date(emp.created_at || new Date());
        let months =
          (selDate.getFullYear() - createdDate.getFullYear()) * 12 +
          (selDate.getMonth() - createdDate.getMonth()) +
          1;
        if (months < 1) months = 1;

        const totalExpected = months * emp.salary;
        const totalPaidAllTime = emp.total_paid_all_time || 0;
        const paidThisMonth = emp.paid_this_month || 0;

        let arrears =
          totalExpected - emp.salary - (totalPaidAllTime - paidThisMonth);
        if (arrears < 0) arrears = 0;

        emp.arrears = arrears;
        emp.paid_amount = paidThisMonth;
        emp.total_due = arrears + emp.salary;
      });

      res.json({ employees: rows });
    },
  );
});

app.post("/api/payroll", authenticateToken, (req, res) => {
  if (
    req.user.role !== "CEO" &&
    req.user.role !== "HR" &&
    req.user.role !== "Admin"
  ) {
    return res.status(403).json({ error: "Unauthorized to process payroll" });
  }

  const { employee_id, month_year, amount } = req.body;
  if (!employee_id || !month_year || !amount) {
    return res.status(400).json({ error: "Missing payroll data" });
  }

  // Insert into transactions (SME Finance)
  db.get(
    "SELECT first_name, last_name FROM employees WHERE id = ?",
    [employee_id],
    (err, emp) => {
      if (err || !emp)
        return res.status(404).json({ error: "Employee not found" });

      const desc = `Payroll Advance/Payment: ${emp.first_name} ${emp.last_name} - ${month_year}`;
      db.run(
        "INSERT INTO transactions (amount, type, description, recorded_by, payment_status) VALUES (?, ?, ?, ?, ?)",
        [amount, "EXPENSE", desc, req.user.id, "PAID"],
        function (err) {
          if (err)
            return res
              .status(500)
              .json({ error: "Failed to record expense transaction" });

          const txId = this.lastID;

          // Insert into payroll_records
          db.run(
            "INSERT INTO payroll_records (employee_id, month_year, amount, transaction_id) VALUES (?, ?, ?, ?)",
            [employee_id, month_year, amount, txId],
            function (err) {
              if (err)
                return res
                  .status(500)
                  .json({ error: "Failed to record payroll" });

              emitAndBust("transactions", "finance_summary");
              res.json({
                success: true,
                message: "Payroll processed",
                record_id: this.lastID,
                transaction_id: txId,
              });
            },
          );
        },
      );
    },
  );
});

// 19. Notices (Staff Board)
app.get("/api/notices", authenticateToken, (req, res) => {
  db.all(
    "SELECT * FROM notices ORDER BY created_at DESC LIMIT 50",
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ notices: rows || [] });
    },
  );
});

app.post("/api/notices", authenticateToken, (req, res) => {
  const { title, content } = req.body;
  if (!title || !content)
    return res.status(400).json({ error: "Title and content are required." });
  db.run(
    "INSERT INTO notices (title, content, author_role) VALUES (?, ?, ?)",
    [title, content, req.user.role],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit("db_updated", { module: "notices" });
      res.json({ id: this.lastID, message: "Notice posted." });
    },
  );
});

app.delete("/api/notices/:id", authenticateToken, (req, res) => {
  if (req.user.role !== "CEO" && req.user.role !== "HR") {
    return res
      .status(403)
      .json({ error: "Forbidden: Only administrators can delete notices." });
  }
  db.run("DELETE FROM notices WHERE id = ?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit("db_updated", { module: "notices" });
    res.json({ message: "Notice deleted." });
  });
});

// ---- Deliveries API ----
app.get("/api/deliveries/pending-cod", authenticateToken, (req, res) => {
  const sql = `
        SELECT 
            p.id as pos_order_id,
            d.id as delivery_id,
            COALESCE(d.client_name, 'In-Store / Invoice') as client_name, 
            d.client_phone, 
            COALESCE(d.client_location, 'POS') as client_location,
            p.id as order_id, 
            p.total_amount, 
            p.transaction_id, 
            t.payment_status
        FROM pos_orders p
        JOIN transactions t ON p.transaction_id = t.id
        LEFT JOIN deliveries d ON d.order_id = p.id
        WHERE p.payment_method = 'COD' AND t.payment_status = 'PENDING'
        ORDER BY p.order_date DESC, p.id DESC
    `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Use pos_order_id to mark COD/Invoice as received, since Invoices don't have delivery records
app.post("/api/pos_orders/:id/cod-received", authenticateToken, (req, res) => {
  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.get(
      "SELECT id as pos_order_id, transaction_id, total_amount FROM pos_orders WHERE id = ?",
      [req.params.id],
      (err, row) => {
        if (err || !row) {
          db.run("ROLLBACK");
          return res.status(404).json({ error: "Order not found" });
        }

        // Mark delivery as Delivered IF it exists
        db.run(
          "UPDATE deliveries SET status = ? WHERE order_id = ?",
          ["Delivered", row.pos_order_id],
          function (err) {
            if (err) {
              db.run("ROLLBACK");
              return res.status(500).json({ error: err.message });
            }

            db.run(
              "UPDATE transactions SET payment_status = ? WHERE id = ?",
              ["PAID", row.transaction_id],
              function (err) {
                if (err) {
                  db.run("ROLLBACK");
                  return res.status(500).json({ error: err.message });
                }

                db.run(
                  "UPDATE pos_orders SET amount_paid = ? WHERE id = ?",
                  [row.total_amount, row.pos_order_id],
                  function (err) {
                    if (err) {
                      db.run("ROLLBACK");
                      return res.status(500).json({ error: err.message });
                    }

                    db.run("COMMIT", (err) => {
                      if (err) {
                        db.run("ROLLBACK");
                        return res.status(500).json({ error: "Commit failed" });
                      }
                      emitAndBust("transactions", "finance_summary");
                      io.emit("db_updated", { module: "pos" });
                      io.emit("db_updated", { module: "deliveries" });

                      res.json({
                        success: true,
                        transaction_id: row.transaction_id,
                        total_amount: row.total_amount,
                        client_name: "Customer", // We could fetch this if needed, but receipt relies on this
                        client_location: "",
                      });
                    });
                  },
                );
              },
            );
          },
        );
      },
    );
  });
});

app.get("/api/deliveries", authenticateToken, (req, res) => {
  db.all(
    `SELECT d.*, p.transaction_id as receipt_number FROM deliveries d LEFT JOIN pos_orders p ON d.order_id = p.id ORDER BY d.created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      if (req.user.role === "Driver") {
        const filtered = rows.filter(
          (r) => !r.driver_id || r.driver_id === req.user.id,
        );
        res.json(filtered);
      } else {
        res.json(rows);
      }
    },
  );
});

app.get("/api/employees/upcoming-pay", authenticateToken, (req, res) => {
  const today = new Date();
  const threeDaysFromNow = new Date();
  threeDaysFromNow.setDate(today.getDate() + 3);

  db.all(
    `SELECT id, first_name, last_name, role, department, salary, next_pay_date FROM employees WHERE is_active = 1 AND next_pay_date IS NOT NULL`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const upcoming = rows.filter((r) => {
        const nextPay = new Date(r.next_pay_date);
        return nextPay >= today && nextPay <= threeDaysFromNow;
      });
      res.json(upcoming);
    },
  );
});

app.post("/api/deliveries", authenticateToken, (req, res) => {
  const {
    client_name,
    client_phone,
    client_location,
    driver,
    items,
    fee,
    status,
    notes,
  } = req.body;
  if (!client_name || !client_phone || !client_location)
    return res
      .status(400)
      .json({ error: "Client name, phone and location required." });
  db.run(
    `INSERT INTO deliveries (client_name, client_phone, client_location, status, order_id, created_at)
            VALUES (?, ?, ?, ?, NULL, datetime('now'))`,
    [client_name, client_phone, client_location, status || "Pending"],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      // Use order_id column to store fee+driver+items as JSON note (schema extension without migration)
      db.run(`UPDATE deliveries SET order_id=? WHERE id=?`, [
        this.lastID,
        this.lastID,
      ]);
      res.json({ id: this.lastID, success: true });
    },
  );
});

app.post("/api/deliveries/:id/claim", authenticateToken, (req, res) => {
  if (req.user.role !== "Driver")
    return res.status(403).json({ error: "Only drivers can claim jobs." });
  db.get(
    `SELECT driver_id FROM deliveries WHERE id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "Delivery not found." });
      if (row.driver_id)
        return res.status(400).json({ error: "Job already claimed." });

      db.run(
        `UPDATE deliveries SET driver_id = ?, driver_name = ? WHERE id = ?`,
        [req.user.id, req.user.name, req.params.id],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true });
        },
      );
    },
  );
});

app.patch("/api/deliveries/:id", authenticateToken, (req, res) => {
  const { status } = req.body;
  db.run(
    `UPDATE deliveries SET status=? WHERE id=?`,
    [status, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    },
  );
});

app.delete("/api/deliveries/:id", authenticateToken, (req, res) => {
  db.run(`DELETE FROM deliveries WHERE id=?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ---- Petty Cash API ----
app.get("/api/petty-cash", authenticateToken, (req, res) => {
  const shiftId = req.query.shift_id;
  if (!shiftId) return res.status(400).json({ error: "shift_id is required" });
  db.all(
    `SELECT * FROM petty_cash WHERE shift_id = ? ORDER BY created_at DESC`,
    [shiftId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    },
  );
});

app.post("/api/petty-cash", authenticateToken, (req, res) => {
  const { shift_id, purpose, amount, recorded_by } = req.body;
  if (!shift_id || !purpose || !amount)
    return res.status(400).json({ error: "Missing fields" });
  db.run(
    `INSERT INTO petty_cash (shift_id, purpose, amount, recorded_by) VALUES (?, ?, ?, ?)`,
    [shift_id, purpose, parseFloat(amount), recorded_by || "Unknown"],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, success: true });
    },
  );
});

app.delete("/api/petty-cash/:id", authenticateToken, (req, res) => {
  db.run(`DELETE FROM petty_cash WHERE id=?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// --- POS OFFLINE BATCH SYNC ---
app.post("/api/pos/batch-sync", authenticateToken, async (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ error: "No transactions provided." });
  }

  const syncedIds = [];
  const errors = [];

  for (const tx of transactions) {
    const { client_uuid, payload } = tx;
    if (!client_uuid || !payload) {
      errors.push({ client_uuid, reason: "Missing client_uuid or payload." });
      continue;
    }

    // Idempotency check: was this already synced?
    const already = await new Promise((resolve) =>
      db.get(
        "SELECT id FROM pos_orders WHERE client_uuid = ?",
        [client_uuid],
        (err, row) => resolve(row),
      ),
    );
    if (already) {
      syncedIds.push(client_uuid);
      continue;
    }

    const {
      total_amount,
      items,
      payment_method = "CASH",
      amount_paid,
    } = payload;
    if (!items || items.length === 0) {
      errors.push({ client_uuid, reason: "Empty cart." });
      continue;
    }

    const cashier_id = req.user.id;
    const paid = amount_paid !== undefined ? amount_paid : total_amount;
    const effectivePaymentMethod =
      payment_method === "INVOICE" ? "COD" : payment_method;
    const payment_status =
      payment_method === "COD" || payment_method === "INVOICE"
        ? "PENDING"
        : "PAID";
    const txAmount = payment_status === "PENDING" ? total_amount : paid;
    const description = `POS Sale - Offline Sync (${payment_method})`;
    const now = new Date().toISOString();

    const success = await new Promise((resolve) => {
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run(
          "INSERT INTO transactions (amount, type, description, recorded_by, transaction_date, payment_status) VALUES (?, ?, ?, ?, ?, ?)",
          [txAmount, "INCOME", description, cashier_id, now, payment_status],
          function (err) {
            if (err) {
              db.run("ROLLBACK");
              return resolve(false);
            }
            const transaction_id = this.lastID;
            db.run(
              "INSERT INTO pos_orders (cashier_id, total_amount, transaction_id, payment_method, amount_paid, client_uuid) VALUES (?, ?, ?, ?, ?, ?)",
              [
                cashier_id,
                total_amount,
                transaction_id,
                effectivePaymentMethod,
                paid,
                client_uuid,
              ],
              function (err2) {
                if (err2) {
                  db.run("ROLLBACK");
                  return resolve(false);
                }
                const pos_order_id = this.lastID;
                items.forEach((item) => {
                  db.run(
                    "UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?",
                    [item.qty, item.id, item.qty],
                  );
                });
                db.run("COMMIT", (err3) => {
                  if (err3) {
                    db.run("ROLLBACK");
                    return resolve(false);
                  }
                  items.forEach((item) => {
                    db.run(
                      "INSERT INTO order_items (pos_order_id, product_id, product_name, qty, price, total) VALUES (?, ?, ?, ?, ?, ?)",
                      [
                        pos_order_id,
                        item.id,
                        item.name,
                        item.qty,
                        item.price,
                        (item.price || 0) * (item.qty || 1),
                      ],
                    );
                  });

                  try {
                    io.emit("db_updated", { module: "pos" });
                  } catch (e) {}
                  resolve(true);
                });
              },
            );
          },
        );
      });
    });

    if (success) syncedIds.push(client_uuid);
    else errors.push({ client_uuid, reason: "Server processing failed." });
  }

  console.log(
    `[BATCH-SYNC] ${transactions.length} tx: ${syncedIds.length} synced, ${errors.length} failed.`,
  );
  res.json({ syncedIds, errors });
});

// Start Server
io.on("connection", (socket) => {
});

server
  .listen(PORT, "0.0.0.0", () => {
    // Seed demo database tenant if needed
    seedDemoTenant(db, db.asyncLocalStorage).catch((err) =>
      console.error("[SEED] Failed to seed demo tenant:", err),
    );

    // Initialize global tech_users table
    asyncLocalStorage.run("public", () => {
      let execSql = `CREATE TABLE IF NOT EXISTS tech_users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`;
      // Handle SQLite syntax if not postgres
      if (require("./database").dbPath) {
        // simple check if SQLite
        execSql = execSql
          .replace(/SERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT")
          .replace(/TIMESTAMP/g, "DATETIME");
      }
      db.run(execSql, [], (err) => {
        if (err) console.error("Error creating tech_users table:", err.message);
        else {
          db.get(
            "SELECT COUNT(*) as count FROM tech_users",
            async (err, row) => {
              if (!err && row && row.count === 0) {
                const defaultHash = await bcrypt.hash("Jomish9!!", 10);
                db.run(
                  "INSERT INTO tech_users (username, password) VALUES (?, ?)",
                  ["tech", defaultHash],
                );
              }
            },
          );
        }
      });
    });

    const interfaces = os.networkInterfaces();

    // Explicitly find and log the local IP for the user
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]) {
        if (net.family === "IPv4" && !net.internal) {
        }
      }
    }

    // Migration: add nickname column if it doesn't exist yet
    db.run(`ALTER TABLE employees ADD COLUMN nickname TEXT`, (err) => {
      if (err && !(err.message || "").includes("duplicate column")) {
        console.warn("[MIGRATION] nickname column:", err.message);
      } else if (!err) {
        console.log(
          "[MIGRATION] employees.nickname column added successfully.",
        );
      }
    });

    // Migrations for POS and Deliveries features
    const migrations = [
      `ALTER TABLE pos_orders ADD COLUMN payment_method TEXT DEFAULT 'CASH'`,
      `ALTER TABLE pos_orders ADD COLUMN amount_paid REAL DEFAULT 0`,
      `ALTER TABLE deliveries ADD COLUMN driver_id INTEGER`,
      `ALTER TABLE deliveries ADD COLUMN driver_name TEXT`,
    ];

    migrations.forEach((q) => {
      db.run(q, (err) => {
        if (err && !(err.message || "").includes("duplicate column")) {
          console.warn("[MIGRATION] POS/Deliveries:", err.message);
        }
      });
    });

    // Auto-open shift on startup if closed
    db.get("SELECT status FROM shifts ORDER BY id DESC LIMIT 1", (err, row) => {
      if (!err && (!row || row.status === "CLOSED")) {
        db.run(
          "INSERT INTO shifts (opened_by, status) VALUES (0, ?)",
          ["OPEN"],
          (err) => {
            if (!err) {
              db.run("UPDATE employees SET is_present = 0");
              console.log(
                "[AUTO-SHIFT] Operational shift automatically opened at startup.",
              );
            }
          },
        );
      }
    });

    // Broadcast service via mDNS (Bonjour)
    bonjour.publish({
      name: config.mDNS_name || "business-system",
      type: "http",
      port: PORT,
    });
    console.log(
      `Service advertised as ${config.mDNS_name || "business-system"}.local`,
    );
  })
  .on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use! Please close other server windows or restart using the .bat file.`,
      );
      process.exit(1);
    } else {
      console.error("Server error:", err);
    }
  });
