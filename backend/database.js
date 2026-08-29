let sqlite3;
try {
    sqlite3 = require('sqlite3').verbose();
} catch (e) {
    console.log('[DB] sqlite3 module not found or failed to load. This is fine if using Postgres.');
}
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

// Load Config
let config = { dbType: 'sqlite' };
try {
    const baseDir = process.pkg ? process.cwd() : path.join(__dirname, '..');
    const configData = fs.readFileSync(path.join(baseDir, 'config/config.json'));
    config = JSON.parse(configData);
} catch (e) { 
    console.log('Config file not found or invalid, checking environment variables...');
}

// ---- Environment Variable Overrides (Neon / Render / Docker) ----
// DATABASE_URL takes top priority (Neon standard connection string)
if (process.env.DATABASE_URL) {
    config.dbType = 'postgres';
    config.postgres = { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };
    console.log('[DB] Using DATABASE_URL (Neon/Render Postgres mode).');
} else if (process.env.DB_TYPE) {
    config.dbType = process.env.DB_TYPE;
    if (config.dbType === 'postgres' && config.postgres) {
        config.postgres.host = process.env.PGHOST || config.postgres.host;
        config.postgres.user = process.env.PGUSER || config.postgres.user;
        config.postgres.password = process.env.PGPASSWORD || config.postgres.password;
        config.postgres.database = process.env.PGDATABASE || config.postgres.database;
        config.postgres.port = process.env.PGPORT || config.postgres.port;
    }
}

let db;
const CURRENT_VERSION = 134;

if (config.dbType === 'postgres') {
    const pool = new Pool(config.postgres);
    
    // Compatibility Wrapper for Postgres to mimic sqlite3 API
    db = {
        pool: pool,
        run: function(sql, params, callback) {
            if (typeof params === 'function') { callback = params; params = []; }
            const pgSql = translateSql(sql);
            const schema = asyncLocalStorage.getStore() || 'public';
            
            pool.connect().then(client => {
                client.query(`SET search_path TO "${schema}", public`)
                    .then(() => client.query(pgSql, params))
                    .then(res => {
                        client.release();
                        const ctx = { 
                            lastID: res.rows.length > 0 ? res.rows[0].id : null, 
                            changes: res.rowCount 
                        };
                        if (callback) callback.call(ctx, null);
                    })
                    .catch(err => {
                        client.release();
                        if (callback) callback(err);
                    });
            }).catch(err => { if (callback) callback(err); });
        },
        get: function(sql, params, callback) {
            if (typeof params === 'function') { callback = params; params = []; }
            const schema = asyncLocalStorage.getStore() || 'public';
            
            pool.connect().then(client => {
                client.query(`SET search_path TO "${schema}", public`)
                    .then(() => client.query(translateSql(sql), params))
                    .then(res => {
                        client.release();
                        if (callback) callback(null, res.rows[0]);
                    })
                    .catch(err => {
                        client.release();
                        if (callback) callback(err);
                    });
            }).catch(err => { if (callback) callback(err); });
        },
        all: function(sql, params, callback) {
            if (typeof params === 'function') { callback = params; params = []; }
            const schema = asyncLocalStorage.getStore() || 'public';
            
            pool.connect().then(client => {
                client.query(`SET search_path TO "${schema}", public`)
                    .then(() => client.query(translateSql(sql), params))
                    .then(res => {
                        client.release();
                        if (callback) callback(null, res.rows);
                    })
                    .catch(err => {
                        client.release();
                        if (callback) callback(err);
                    });
            }).catch(err => { if (callback) callback(err); });
        },
        serialize: function(fn) { fn(); }, // Postgres is pool-based, serialize is dummy
        prepare: function(sql) {
            // Basic mimic for mt.run
            return {
                run: (params) => {
                    const schema = asyncLocalStorage.getStore() || 'public';
                    return pool.connect().then(client => {
                        return client.query(`SET search_path TO "${schema}", public`)
                            .then(() => client.query(translateSql(sql), params))
                            .finally(() => client.release());
                    });
                },
                finalize: () => {}
            };
        }
    };
    
    // Add create schema helper
    db.createCompanySchema = async function(prefix) {
        if (!prefix || !/^[A-Za-z0-9]+$/.test(prefix)) throw new Error('Invalid prefix format');
        const schemaName = 't_' + prefix.toLowerCase();
        
        const client = await pool.connect();
        try {
            await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
            await client.query(`SET search_path TO "${schemaName}", public`);
            
            // Await schema creation sequentially to guarantee tables exist before returning
            for (const sql of schema) {
                await client.query(translateSql(sql));
            }

            // Run seed data / migrations in this new schema
            await new Promise((resolve) => {
                asyncLocalStorage.run(schemaName, () => {
                    initDb(); // the CREATE TABLEs will be no-ops
                    setTimeout(resolve, 1500); // Give migrations time to finish
                });
            });
        } finally {
            client.release();
        }
        return schemaName;
    };
    console.log('Using PostgreSQL database at', config.postgres.host);
} else {
    // Guard: if sqlite3 failed to load (e.g. native compile error on Linux/Railway),
    // throw a clear error instead of crashing with a confusing TypeError.
    if (!sqlite3) {
        console.error('[DB] FATAL: sqlite3 native module is not available and no DATABASE_URL is set.');
        console.error('[DB] If you are deploying to a cloud host (Railway, Render, etc.), please set the DATABASE_URL environment variable to a PostgreSQL connection string (e.g. from Neon.tech).');
        process.exit(1);
    }
    const baseDir = process.pkg ? process.cwd() : path.join(__dirname, '..');
    const dataDir = path.join(baseDir, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // ===== PER-COMPANY SQLite DATABASE FACTORY =====
    // Each company prefix gets its own isolated .db file.
    // e.g. prefix 'JOM' -> data/jomish_jom.db
    //      prefix 'public' -> data/jomish.db (legacy / default)
    const sqliteDbCache = new Map(); // prefix -> sqlite3.Database

    function openSqliteDb(prefix) {
        const safePrefix = (prefix || 'public').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (sqliteDbCache.has(safePrefix)) return sqliteDbCache.get(safePrefix);

        // Use legacy filename for 'public' so existing data is not lost
        const dbFileName = (safePrefix === 'public')
            ? (config.sqlite?.dbName || 'jomish.db')
            : `jomish_${safePrefix}.db`;
        const dbPath = path.join(dataDir, dbFileName);

        // Bulletproof restore: apply staged restore file if present
        const restorePath = dbPath + '.restore';
        if (fs.existsSync(restorePath)) {
            try {
                console.log(`[STARTUP] Applying database restore for '${safePrefix}'...`);
                fs.copyFileSync(restorePath, dbPath);
                if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
                if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
                fs.unlinkSync(restorePath);
                console.log(`[STARTUP] Restore for '${safePrefix}' successful.`);
            } catch (e) {
                console.error(`[STARTUP] Failed to apply restore for '${safePrefix}':`, e.message);
            }
        }

        const sqliteInstance = new sqlite3.Database(dbPath, (err) => {
            if (err) { console.error(`FATAL: Could not open SQLite db for '${safePrefix}':`, err.message); process.exit(1); }
            console.log(`[DB] Opened SQLite database for '${safePrefix}' at ${dbPath}`);
        });

        // Performance & reliability PRAGMAs
        sqliteInstance.serialize(() => {
            sqliteInstance.run('PRAGMA journal_mode = WAL');
            sqliteInstance.run('PRAGMA busy_timeout = 15000');
            sqliteInstance.run('PRAGMA synchronous = NORMAL');
            sqliteInstance.run('PRAGMA cache_size = -32000');
            sqliteInstance.run('PRAGMA foreign_keys = ON');
            sqliteInstance.run('PRAGMA wal_autocheckpoint = 500');
            sqliteInstance.run('PRAGMA temp_store = MEMORY');
            sqliteInstance.run('PRAGMA mmap_size = 268435456');
            sqliteInstance.run('PRAGMA wal_checkpoint(TRUNCATE)', (err) => {
                if (!err) console.log(`[DB] WAL checkpoint complete for '${safePrefix}'.`);
            });
        });

        // Periodic WAL checkpoint
        setInterval(() => { sqliteInstance.run('PRAGMA wal_checkpoint(PASSIVE)'); }, 5 * 60 * 1000);

        sqliteInstance.dbPath = dbPath;
        sqliteDbCache.set(safePrefix, sqliteInstance);
        return sqliteInstance;
    }

    // Open the public/default db immediately so initDb() runs at startup
    openSqliteDb('public');

    // ===== PROXY: routes all db calls to the correct per-prefix SQLite =====
    // The active prefix comes from asyncLocalStorage (set by the middleware in server.js)
    db = new Proxy({}, {
        get(_, method) {
            if (method === 'asyncLocalStorage') return asyncLocalStorage;
            if (method === 'dbPath') {
                const prefix = asyncLocalStorage.getStore() || 'public';
                return openSqliteDb(prefix).dbPath;
            }
            if (method === '_sqliteDbCache') return sqliteDbCache;
            if (method === '_openSqliteDb') return openSqliteDb;
            if (method === 'createCompanySchema') {
                // Return the SQLite company provisioner function
                return async function(prefix) {
                    if (!prefix || !/^[A-Za-z0-9]+$/.test(prefix)) throw new Error('Invalid prefix format');
                    const safePrefix = prefix.toLowerCase();
                    const schemaName = 't_' + safePrefix;

                    // Open (or create) the company .db file — this registers it in sqliteDbCache
                    openSqliteDb(schemaName);

                    // Run initDb() and checkMigrations() within the context of the new company db
                    await new Promise((resolve, reject) => {
                        asyncLocalStorage.run(schemaName, () => {
                            try {
                                initDb();
                                // Give SQLite a moment to finish the serialize queue before resolving
                                setTimeout(resolve, 800);
                            } catch (e) {
                                reject(e);
                            }
                        });
                    });

                    console.log('[DB] SQLite schema provisioned for company prefix ' + prefix + ' -> data/jomish_t' + safePrefix + '.db');
                    return schemaName;
                };
            }
            return (...args) => {
                const prefix = asyncLocalStorage.getStore() || 'public';
                const activeDb = openSqliteDb(prefix);
                if (typeof activeDb[method] !== 'function') return undefined;
                return activeDb[method](...args);
            };
        }
    });

    console.log(`[DB] SQLite multi-tenant mode active. Databases in: ${dataDir}/`);
}

// Convert '?' to '$1, $2' for Postgres
function translateSql(sql) {
    if (config.dbType !== 'postgres') return sql;
    let index = 1;
    let newSql = sql.replace(/\?/g, () => `$${index++}`);
    
    // Convert SQLite datetime functions to PostgreSQL equivalents
    // datetime('now') -> NOW()
    newSql = newSql.replace(/datetime\('now'\)/gi, 'NOW()');
    // datetime('now', '-N seconds/minutes/hours/days') -> NOW() - INTERVAL 'N seconds'
    newSql = newSql.replace(/datetime\('now',\s*'(-?\d+)\s+(\w+)'\)/gi, (_, n, unit) => `NOW() - INTERVAL '${Math.abs(parseInt(n))} ${unit}'`);
    // strftime('%Y-%m', col) -> TO_CHAR(col, 'YYYY-MM')
    newSql = newSql.replace(/strftime\('%Y-%m',\s*([^)]+)\)/gi, "TO_CHAR($1, 'YYYY-MM')");
    // strftime('%Y-%m-%d', col) -> TO_CHAR(col, 'YYYY-MM-DD')
    newSql = newSql.replace(/strftime\('%Y-%m-%d',\s*([^)]+)\)/gi, "TO_CHAR($1, 'YYYY-MM-DD')");
    // date('now') -> CURRENT_DATE
    newSql = newSql.replace(/date\('now'\)/gi, 'CURRENT_DATE');
    
    // Convert SQLite INSERT OR IGNORE -> Postgres INSERT ... ON CONFLICT DO NOTHING
    const hadInsertOrIgnore = /INSERT\s+OR\s+IGNORE\s+INTO/gi.test(sql);
    newSql = newSql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');

    // Convert SQLite INSERT OR REPLACE -> Postgres INSERT ... ON CONFLICT (...) DO UPDATE SET
    newSql = newSql.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*(\([^)]+\))/gi, (_, table, cols, vals) => {
        const colList = cols.split(',').map(c => c.trim());
        const pkCol = colList.find(c => c === 'id' || c === 'key') || colList[0];
        const setCols = colList.filter(c => c !== pkCol).map(c => `${c} = EXCLUDED.${c}`).join(', ');
        return `INSERT INTO ${table} (${cols}) VALUES ${vals} ON CONFLICT (${pkCol}) DO UPDATE SET ${setCols}`;
    });
    
    // Only append RETURNING id for tables that actually have a SERIAL id column
    // Tables WITHOUT id: roles_config, devices, app_settings, system_info, system_meta
    const noIdTables = ['roles_config', 'devices', 'app_settings', 'system_info', 'system_meta'];
    const isInsert = newSql.trim().toUpperCase().startsWith('INSERT');
    const hasReturning = newSql.toUpperCase().includes('RETURNING');
    const hasOnConflictNothing = hadInsertOrIgnore; // INSERT OR IGNORE -> never needs RETURNING
    const hasOnConflictUpdate = newSql.toUpperCase().includes('ON CONFLICT') && newSql.toUpperCase().includes('DO UPDATE');
    const targetsNoIdTable = noIdTables.some(t => newSql.toLowerCase().includes(t));
    
    if (isInsert && !hasReturning && !targetsNoIdTable && !hasOnConflictNothing && !hasOnConflictUpdate) {
        newSql += ' RETURNING id';
    }
    return newSql;
}

// Unified Table Initialization
const schema = [
    `CREATE TABLE IF NOT EXISTS system_info (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        first_name TEXT, last_name TEXT, email TEXT UNIQUE, password TEXT,
        role TEXT, department TEXT, salary REAL, qr_hash TEXT,
        is_active INTEGER DEFAULT 1, employee_code TEXT, username TEXT UNIQUE,
        photo_base64 TEXT, profile_color TEXT DEFAULT '#4F46E5',
        layout_type TEXT DEFAULT 'LANDSCAPE', next_pay_date TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS attendance_logs (
        id SERIAL PRIMARY KEY, employee_id INTEGER, 
        scan_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP, scan_type TEXT,
        latitude REAL, longitude REAL, status TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY, transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        amount REAL, type TEXT, description TEXT, recorded_by INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY, name TEXT, category TEXT, 
        price REAL, stock INTEGER, barcode TEXT,
        barcode_end TEXT, photo_base64 TEXT, buying_price REAL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS pos_orders (
        id SERIAL PRIMARY KEY, cashier_id INTEGER, total_amount REAL,
        order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, transaction_id INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS schedules (
        id SERIAL PRIMARY KEY, employee_id INTEGER, shift_date TEXT,
        start_time TEXT, end_time TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS roles_config (
        role_name TEXT PRIMARY KEY, can_see_dashboard INTEGER DEFAULT 0,
        can_see_hr INTEGER DEFAULT 0, can_see_attendance INTEGER DEFAULT 0,
        can_see_sme INTEGER DEFAULT 0, can_see_pos INTEGER DEFAULT 0,
        can_see_secretary INTEGER DEFAULT 0, can_see_transport INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS shifts (
        id SERIAL PRIMARY KEY, opened_by INTEGER, open_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        closed_by INTEGER, close_time TIMESTAMP, status TEXT DEFAULT 'OPEN'
    )`,
    `CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY, device_name TEXT, device_type TEXT,
        ip_address TEXT, last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'ONLINE',
        company_schema TEXT DEFAULT 'public'
    )`,
    `CREATE TABLE IF NOT EXISTS app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT)`,
    `CREATE TABLE IF NOT EXISTS employee_notes (
        id SERIAL PRIMARY KEY, employee_id INTEGER, note_text TEXT,
        note_type TEXT DEFAULT 'GENERAL', created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS expense_categories (
        id SERIAL PRIMARY KEY, name TEXT UNIQUE, budget_limit REAL DEFAULT 0,
        color TEXT DEFAULT '#6366F1'
    )`,
    `CREATE TABLE IF NOT EXISTS notices (
        id SERIAL PRIMARY KEY, title TEXT, content TEXT, 
        author_role TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS calendar_events (
        id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        event_date TEXT NOT NULL, start_time TEXT, end_time TEXT,
        event_type TEXT DEFAULT 'Meeting', color TEXT DEFAULT '#4F46E5',
        minutes TEXT,
        created_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS email_messages (
        id SERIAL PRIMARY KEY, message_uid TEXT UNIQUE,
        from_address TEXT, from_name TEXT, subject TEXT,
        body_preview TEXT, received_at TIMESTAMP,
        is_read INTEGER DEFAULT 0, fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS internal_messages (
        id SERIAL PRIMARY KEY, from_id INTEGER, to_id INTEGER,
        subject TEXT, content TEXT, is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sold_barcodes (
        barcode TEXT PRIMARY KEY, product_id INTEGER, 
        transaction_id INTEGER, sold_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS credit_records (
        id SERIAL PRIMARY KEY, buyer_name TEXT, buyer_phone TEXT, pos_order_id INTEGER,
        total_amount REAL, amount_paid REAL, balance REAL, promised_date TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS deliveries (
        id SERIAL PRIMARY KEY,
        order_id INTEGER,
        client_name TEXT,
        client_phone TEXT,
        client_location TEXT,
        status TEXT DEFAULT 'PENDING',
        payment_type TEXT DEFAULT 'CASH',
        total_amount REAL DEFAULT 0,
        pos_order_id INTEGER,
        driver_id INTEGER,
        driver_name TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS shift_assignments (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL,
        shift_date   TEXT NOT NULL,
        slot         TEXT NOT NULL,
        start_time   TEXT NOT NULL,
        end_time     TEXT NOT NULL,
        assigned_by  INTEGER,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS payroll_records (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER,
        month_year TEXT,
        amount REAL,
        transaction_id INTEGER,
        paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS system_meta (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS petty_cash (
        id SERIAL PRIMARY KEY,
        shift_id INTEGER,
        purpose TEXT,
        amount REAL,
        recorded_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS product_barcodes (
        id SERIAL PRIMARY KEY,
        product_id INTEGER,
        barcode TEXT,
        source TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER,
        subscription TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        pos_order_id INTEGER NOT NULL,
        product_id INTEGER,
        product_name TEXT,
        qty INTEGER,
        price REAL,
        total REAL
    )`
];

function initDb() {
    db.serialize(() => {
        schema.forEach(sql => {
            // Convert SERIAL to INTEGER PRIMARY KEY AUTOINCREMENT for SQLite
            let execSql = sql;
            if (config.dbType !== 'postgres') {
                execSql = execSql.replace(/SERIAL PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT');
                execSql = execSql.replace(/TIMESTAMP/g, 'DATETIME');
            }
            db.run(execSql);
        });
        checkMigrations();
    });
}

function checkMigrations() {
    db.get(`SELECT value FROM system_info WHERE key = 'version'`, (err, row) => {
        const v = row ? parseInt(row.value) : 0;
        if (v < CURRENT_VERSION) {
            console.log(`Migrating database from ${v} to ${CURRENT_VERSION}...`);
            runMigrations(v);
        }
    });
}

function runMigrations(fromVersion) {
    if (fromVersion < 100) {
        const seedRoles = [
            ['CEO', 1, 1, 1, 1, 1], ['HR', 1, 1, 1, 1, 1],
            ['Supervisor', 0, 0, 1, 0, 0], ['Cashier', 1, 0, 0, 0, 1], ['Security', 0, 0, 1, 0, 0]
        ];
        seedRoles.forEach(r => db.run('INSERT INTO roles_config (role_name, can_see_dashboard, can_see_hr, can_see_attendance, can_see_sme, can_see_pos) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING', r));
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "100"]);
    }
    if (fromVersion < 101) {
        db.run("ALTER TABLE employees ADD COLUMN is_sick INTEGER DEFAULT 0");
        db.run("ALTER TABLE employees ADD COLUMN is_present INTEGER DEFAULT 0");
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "101"], () => {
            console.log("Migration to v101 complete: Added sickness and presence tracking.");
        });
    }
    if (fromVersion < 102) {
        // Dashboard access: CEO, HR, Cashier only. Supervisor and Security cannot see it.
        db.run('UPDATE roles_config SET can_see_dashboard = 1 WHERE role_name IN ("CEO", "HR", "Cashier")');
        db.run('UPDATE roles_config SET can_see_dashboard = 0 WHERE role_name NOT IN ("CEO", "HR", "Cashier")');
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "102"], () => {
            console.log("Migration to v102 complete: Dashboard restricted to CEO, HR, Cashier.");
        });
    }
    if (fromVersion < 103) {
        db.run("ALTER TABLE products ADD COLUMN photo_base64 TEXT");
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "103"], () => {
            console.log("Migration to v103 complete: Added photo_base64 to products.");
        });
    }
    if (fromVersion < 104) {
        db.run("ALTER TABLE products ADD COLUMN barcode_end TEXT");
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "104"], () => {
            console.log("Migration to v104 complete: Added barcode_end to products.");
        });
    }
    if (fromVersion < 105) {
        // Seed auto-barcode counter — start above any existing barcodes
        db.get('SELECT MAX(CAST(barcode_end AS INTEGER)) as mx FROM products WHERE barcode_end IS NOT NULL', (err, row) => {
            let startAt = 1000;
            if (row && row.mx && !isNaN(row.mx)) startAt = Math.max(startAt, row.mx + 1);
            db.run(`INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('next_barcode', ?)`, [startAt.toString()]);
        });
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "105"], () => {
            console.log("Migration to v105 complete: Auto-barcode counter seeded.");
        });
    }
    if (fromVersion < 106) {
        // Remove UNIQUE constraint from products.barcode — rebuild table
        // Clean up any leftover temp table from a previously failed attempt
        db.run(`DROP TABLE IF EXISTS products_rebuild`, () => {
            db.run(`CREATE TABLE products_rebuild (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, category TEXT,
                price REAL, stock INTEGER, barcode TEXT,
                barcode_end TEXT, photo_base64 TEXT
            )`, () => {
                db.run(`INSERT INTO products_rebuild SELECT id, name, category, price, stock, barcode, barcode_end, photo_base64 FROM products`, (err) => {
                    if (err) { console.error('Migration v106 copy error:', err.message); return; }
                    db.run(`DROP TABLE IF EXISTS products`, () => {
                        db.run(`ALTER TABLE products_rebuild RENAME TO products`, () => {
                            // Also clean up the old products_new if it exists from earlier attempts
                            db.run(`DROP TABLE IF EXISTS products_new`, () => {
                                db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "106"], () => {
                                    console.log("Migration to v106 complete: Removed UNIQUE constraint from products.barcode.");
                                });
                            });
                        });
                    });
                });
            });
        });
    }
    if (fromVersion < 107) {
        db.run("ALTER TABLE roles_config ADD COLUMN can_see_secretary INTEGER DEFAULT 0", () => {});
        db.run(`INSERT INTO roles_config (role_name, can_see_dashboard, can_see_hr, can_see_attendance, can_see_sme, can_see_pos, can_see_secretary) VALUES ('Receptionist', 1, 0, 1, 0, 0, 1) ON CONFLICT DO NOTHING`);
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "107"], () => {
            console.log("Migration to v107 complete: Added Secretary Hub (Calendar + Email).");
        });
    }
    if (fromVersion < 108) {
        // Secretary Hub is EXCLUSIVE to Receptionist — remove from CEO/HR
        db.run('UPDATE roles_config SET can_see_secretary = 0 WHERE role_name != "Receptionist"');
        db.run(`UPDATE roles_config SET can_see_secretary = 1 WHERE role_name = 'Receptionist'`);
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "108"], () => {
            console.log("Migration to v108 complete: Secretary Hub locked to Receptionist + Internal Messaging.");
        });
    }
    if (fromVersion < 109) {
        // === PERFORMANCE INDEXES for 50K+ users ===
        // Employee lookups
        db.run('CREATE INDEX IF NOT EXISTS idx_emp_email ON employees(email)');
        db.run('CREATE INDEX IF NOT EXISTS idx_emp_username ON employees(username)');
        db.run('CREATE INDEX IF NOT EXISTS idx_emp_role ON employees(role)');
        db.run('CREATE INDEX IF NOT EXISTS idx_emp_active ON employees(is_active)');
        db.run('CREATE INDEX IF NOT EXISTS idx_emp_code ON employees(employee_code)');
        // Attendance — most queried table at scale
        db.run('CREATE INDEX IF NOT EXISTS idx_att_empid ON attendance_logs(employee_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_att_time ON attendance_logs(scan_time)');
        db.run('CREATE INDEX IF NOT EXISTS idx_att_type ON attendance_logs(scan_type)');
        db.run('CREATE INDEX IF NOT EXISTS idx_att_emp_time ON attendance_logs(employee_id, scan_time)');
        // Transactions
        db.run('CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(transaction_date)');
        db.run('CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(type)');
        db.run('CREATE INDEX IF NOT EXISTS idx_txn_by ON transactions(recorded_by)');
        // Products
        db.run('CREATE INDEX IF NOT EXISTS idx_prod_barcode ON products(barcode)');
        db.run('CREATE INDEX IF NOT EXISTS idx_prod_category ON products(category)');
        db.run('CREATE INDEX IF NOT EXISTS idx_prod_name ON products(name)');
        // POS Orders
        db.run('CREATE INDEX IF NOT EXISTS idx_orders_date ON pos_orders(order_date)');
        db.run('CREATE INDEX IF NOT EXISTS idx_orders_cashier ON pos_orders(cashier_id)');
        // Schedules
        db.run('CREATE INDEX IF NOT EXISTS idx_sched_empid ON schedules(employee_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_sched_date ON schedules(shift_date)');
        // Messages
        db.run('CREATE INDEX IF NOT EXISTS idx_msg_from ON internal_messages(from_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_msg_to ON internal_messages(to_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_msg_read ON internal_messages(is_read)');
        db.run('CREATE INDEX IF NOT EXISTS idx_msg_created ON internal_messages(created_at)');
        // Calendar
        db.run('CREATE INDEX IF NOT EXISTS idx_cal_date ON calendar_events(event_date)');
        db.run('CREATE INDEX IF NOT EXISTS idx_cal_creator ON calendar_events(created_by)');
        // Emails
        db.run('CREATE INDEX IF NOT EXISTS idx_email_uid ON email_messages(message_uid)');
        db.run('CREATE INDEX IF NOT EXISTS idx_email_read ON email_messages(is_read)');
        db.run('CREATE INDEX IF NOT EXISTS idx_email_date ON email_messages(received_at)');
        // Notes
        db.run('CREATE INDEX IF NOT EXISTS idx_notes_emp ON employee_notes(employee_id)');

        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "109"], () => {
            console.log("Migration to v109 complete: Added 30+ performance indexes for 50K+ user scale.");
        });
    }
    if (fromVersion < 110) {
        db.run(`CREATE TABLE IF NOT EXISTS sold_barcodes (
            barcode TEXT PRIMARY KEY, product_id INTEGER, 
            transaction_id INTEGER, sold_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            db.run('CREATE INDEX IF NOT EXISTS idx_sold_product ON sold_barcodes(product_id)');
            db.run('CREATE INDEX IF NOT EXISTS idx_sold_txn ON sold_barcodes(transaction_id)');
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "110"], () => {
                console.log("Migration to v110 complete: Unique barcode tracking enabled.");
            });
        });
    }
    if (fromVersion < 111) {
        db.run("ALTER TABLE products ADD COLUMN buying_price REAL DEFAULT 0", (err) => {
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "111"], () => {
                console.log("Migration to v111 complete: Added buying_price to products.");
            });
        });
    }
    if (fromVersion < 112) {
        db.run("ALTER TABLE pos_orders ADD COLUMN payment_method TEXT DEFAULT 'CASH'");
        db.run("ALTER TABLE pos_orders ADD COLUMN amount_paid REAL DEFAULT 0", () => {
            db.run('CREATE INDEX IF NOT EXISTS idx_credit_buyer ON credit_records(buyer_name)');
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "112"], () => {
                console.log("Migration to v112 complete: Added payment methods and credit_records.");
            });
        });
    }
    if (fromVersion < 113) {
        db.run("ALTER TABLE credit_records ADD COLUMN buyer_phone TEXT", (err) => {
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "113"], () => {
                console.log("Migration to v113 complete: Added buyer_phone to credit_records.");
            });
        });
    }
    if (fromVersion < 114) {
        db.run("ALTER TABLE credit_records ADD COLUMN promised_date TEXT", (err) => {
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "114"], () => {
                console.log("Migration to v114 complete: Added promised_date to credit_records.");
            });
        });
    }
    if (fromVersion < 115) {
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "115"], () => {
            console.log("Migration to v115 skipped (Transport module removed).");
        });
    }
    if (fromVersion < 116) {
        db.run("ALTER TABLE transactions ADD COLUMN payment_status TEXT DEFAULT 'PAID'", () => {
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "116"], () => {
                console.log("Migration to v116 complete: payment_status added.");
            });
        });
    }
    if (fromVersion < 117) {
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "117"], () => {
            console.log("Migration to v117 skipped (Transport role removed).");
        });
    }
    if (fromVersion < 118) {
        db.run("ALTER TABLE calendar_events ADD COLUMN minutes TEXT", (err) => {
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "118"], () => {
                console.log("Migration to v118 complete: Added meeting minutes to calendar.");
            });
        });
    }
    if (fromVersion < 119) {
        db.run(`CREATE TABLE IF NOT EXISTS shift_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,
            shift_date   TEXT NOT NULL,
            slot         TEXT NOT NULL,
            start_time   TEXT NOT NULL,
            end_time     TEXT NOT NULL,
            assigned_by  INTEGER,
            created_at   DATETIME DEFAULT (datetime('now'))
        )`, (err) => {
            if (err && !err.message.includes('already exists')) {
                console.error('[Migration v119] shift_assignments error:', err.message); return;
            }
            db.run('CREATE INDEX IF NOT EXISTS idx_sa_date ON shift_assignments(shift_date)');
            db.run('CREATE INDEX IF NOT EXISTS idx_sa_emp ON shift_assignments(employee_id)');
            db.run('CREATE INDEX IF NOT EXISTS idx_sa_emp_date ON shift_assignments(employee_id, shift_date)');
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "119"], () => {
                console.log("Migration to v119 complete: shift_assignments table with fairness tracking.");
            });
        });
    }
    if (fromVersion < 120) {
        db.run(`CREATE TABLE IF NOT EXISTS payroll_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER,
            month_year TEXT,
            amount REAL,
            transaction_id INTEGER,
            paid_at DATETIME DEFAULT (datetime('now'))
        )`, (err) => {
            if (err) console.error('[Migration v120] payroll_records error:', err.message);
            db.run('CREATE INDEX IF NOT EXISTS idx_payroll_emp_month ON payroll_records(employee_id, month_year)');
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "120"], () => {
                console.log("Migration to v120 complete: Added payroll_records table.");
            });
        });
    }
    if (fromVersion < 121) {
        db.run("ALTER TABLE roles_config ADD COLUMN can_see_transport INTEGER DEFAULT 0", () => {});
        db.run("ALTER TABLE roles_config ADD COLUMN can_see_hardware INTEGER DEFAULT 0", () => {});
        db.run("ALTER TABLE roles_config ADD COLUMN can_see_system_users INTEGER DEFAULT 0", () => {});
        db.run("ALTER TABLE roles_config ADD COLUMN can_see_schedules INTEGER DEFAULT 0", () => {
            // Ensure core admin roles exist and have full access to prevent lockouts
            const adminRoles = ['CEO', 'Admin', 'HR'];
            adminRoles.forEach(role => {
                db.run(`INSERT INTO roles_config (role_name, can_see_dashboard, can_see_hr, can_see_attendance, can_see_sme, can_see_pos, can_see_secretary, can_see_transport, can_see_hardware, can_see_system_users, can_see_schedules) 
                        VALUES (?, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1) 
                        ON CONFLICT(role_name) DO UPDATE SET 
                        can_see_dashboard=1, can_see_hr=1, can_see_attendance=1, can_see_sme=1, can_see_pos=1, 
                        can_see_secretary=1, can_see_transport=1, can_see_hardware=1, can_see_system_users=1, can_see_schedules=1`, [role]);
            });
            
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "121"], () => {
                console.log("Migration to v121 complete: Added expanded role permissions and ensured admin access.");
            });
        });
    }
    if (fromVersion < 122) {
        db.run(`INSERT INTO roles_config (role_name)
                SELECT DISTINCT role FROM employees 
                WHERE role IS NOT NULL 
                AND role NOT IN (SELECT role_name FROM roles_config)`, (err) => {
            if (err) console.error('[Migration v122] Sync roles error:', err.message);
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "122"], () => {
                console.log("Migration to v122 complete: Synced all unique employee roles into roles_config.");
            });
        });
    }
    if (fromVersion < 123) {
        db.run("ALTER TABLE employees ADD COLUMN next_pay_date TIMESTAMP", (err) => {
            if (err) console.error('[Migration v123] next_pay_date error:', err.message);
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "123"], () => {
                console.log("Migration to v123 complete: Added next_pay_date to employees.");
            });
        });
    }

    if (fromVersion < 124) {
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "124"], () => {
            console.log("Migration to v124 complete.");
        });
    }
    if (fromVersion < 125) {
        if (config.dbType === 'postgres') {
            db.run('ALTER TABLE product_barcodes DROP CONSTRAINT product_barcodes_barcode_key', (err) => {
                if (err) console.error('[Migration v125] Error dropping constraint:', err.message);
                db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "125"], () => {
                    console.log("Migration to v125 complete: Removed UNIQUE constraint on product_barcodes in Postgres.");
                });
            });
        } else {
            // SQLite migration
            db.run('CREATE TABLE product_barcodes_new (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, barcode TEXT, source TEXT)', (err) => {
                if (err) return console.error('[Migration v125] SQLite create error:', err.message);
                db.run('INSERT INTO product_barcodes_new SELECT id, product_id, barcode, source FROM product_barcodes', (err) => {
                    if (err) return console.error('[Migration v125] SQLite insert error:', err.message);
                    db.run('DROP TABLE product_barcodes', (err) => {
                        if (err) return console.error('[Migration v125] SQLite drop error:', err.message);
                        db.run('ALTER TABLE product_barcodes_new RENAME TO product_barcodes', (err) => {
                            if (err) return console.error('[Migration v125] SQLite rename error:', err.message);
                            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "125"], () => {
                                console.log("Migration to v125 complete: Removed UNIQUE constraint on product_barcodes in SQLite.");
                            });
                        });
                    });
                });
            });
        }
    }
    if (fromVersion < 126) {
        // Add company_schema column to devices table for multi-company device isolation
        db.run("ALTER TABLE devices ADD COLUMN company_schema TEXT DEFAULT 'public'", (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('[Migration v126] Error adding company_schema to devices:', err.message);
            }
        });
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ["version", "126"], () => {
            console.log("Migration to v126 complete: Added company_schema to devices table.");
        });
    }
    if (fromVersion < 127) {
        // Seed ALL standard roles into roles_config with correct permissions.
        // This fixes existing company schemas where System Technician had no entry,
        // causing new company logins to only see the Dashboard.
        const fullRoles = [
            ['CEO',                1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ['Admin',              1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ['HR',                 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ['System Technician',  1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ['Supervisor',         0, 0, 1, 0, 0, 0, 0, 0, 0, 1],
            ['Cashier',            1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
            ['Security',           0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
            ['Receptionist',       1, 0, 1, 0, 0, 1, 0, 0, 0, 0]
        ];
        let pending = fullRoles.length;
        fullRoles.forEach(r => {
            db.run(
                `INSERT INTO roles_config
                    (role_name, can_see_dashboard, can_see_hr, can_see_attendance, can_see_sme, can_see_pos,
                     can_see_secretary, can_see_transport, can_see_hardware, can_see_system_users, can_see_schedules)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(role_name) DO UPDATE SET
                     can_see_dashboard       = CASE WHEN roles_config.can_see_dashboard = 1       THEN 1 ELSE excluded.can_see_dashboard END,
                     can_see_hr              = CASE WHEN roles_config.can_see_hr = 1              THEN 1 ELSE excluded.can_see_hr END,
                     can_see_attendance      = CASE WHEN roles_config.can_see_attendance = 1      THEN 1 ELSE excluded.can_see_attendance END,
                     can_see_sme             = CASE WHEN roles_config.can_see_sme = 1             THEN 1 ELSE excluded.can_see_sme END,
                     can_see_pos             = CASE WHEN roles_config.can_see_pos = 1             THEN 1 ELSE excluded.can_see_pos END,
                     can_see_secretary       = CASE WHEN roles_config.can_see_secretary = 1       THEN 1 ELSE excluded.can_see_secretary END,
                     can_see_transport       = CASE WHEN roles_config.can_see_transport = 1       THEN 1 ELSE excluded.can_see_transport END,
                     can_see_hardware        = CASE WHEN roles_config.can_see_hardware = 1        THEN 1 ELSE excluded.can_see_hardware END,
                     can_see_system_users    = CASE WHEN roles_config.can_see_system_users = 1    THEN 1 ELSE excluded.can_see_system_users END,
                     can_see_schedules       = CASE WHEN roles_config.can_see_schedules = 1       THEN 1 ELSE excluded.can_see_schedules END`,
                r,
                () => {
                    pending--;
                    if (pending === 0) {
                        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ['version', '127'], () => {
                            console.log('Migration to v127 complete: Seeded all standard roles with correct permissions.');
                        });
                    }
                }
            );
        });
    }
    if (fromVersion < 128) {
        // === COMPOSITE / COVERING INDEXES for common filter+sort patterns ===
        // Employees filtered by active status AND role (used in shift modal, login)
        db.run('CREATE INDEX IF NOT EXISTS idx_emp_active_role ON employees(is_active, role)');
        // Transactions filtered by date AND type (finance summary, SME tab)
        db.run('CREATE INDEX IF NOT EXISTS idx_txn_date_type ON transactions(transaction_date, type)');
        // POS orders by date and status (delivery queries, COD filter)
        db.run('CREATE INDEX IF NOT EXISTS idx_orders_date_status ON pos_orders(order_date, status)');
        // Attendance recent-first ordering (the UI shows last 50 scans ordered DESC)
        db.run('CREATE INDEX IF NOT EXISTS idx_att_scan_desc ON attendance_logs(scan_time DESC)');
        // Credit records sorted by buyer and date
        db.run('CREATE INDEX IF NOT EXISTS idx_credit_buyer_date ON credit_records(buyer_name, created_at)');
        // Shift assignments covering lookup (slot+date used together in timetable grid)
        db.run('CREATE INDEX IF NOT EXISTS idx_sa_slot_date ON shift_assignments(slot, shift_date)');
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ['version', '128'], () => {
            console.log('Migration to v128 complete: Added 6 composite/covering indexes for scale.');
        });
    }
    if (fromVersion < 129) {
        // Add is_suspended column so HR can pause an account without full termination
        db.run("ALTER TABLE employees ADD COLUMN is_suspended INTEGER DEFAULT 0", (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('[Migration v129]', err.message);
            }
            db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ['version', '129'], () => {
                console.log('Migration to v129 complete: Added is_suspended column to employees.');
            });
        });
    }
    if (fromVersion < 130) {
        // Add per-employee permission columns so each user can have granular access
        const permCols = [
            'can_see_dashboard', 'can_see_hr', 'can_see_attendance', 'can_see_sme',
            'can_see_pos', 'can_see_secretary', 'can_see_transport',
            'can_see_hardware', 'can_see_system_users', 'can_see_schedules', 'nickname'
        ];
        // For postgres, we must run these synchronously to avoid race conditions.
        let i = 0;
        function runNextMigration() {
            if (i >= permCols.length) {
                // Done adding columns, now run the back-fill
                db.run(`
                    UPDATE employees SET
                        can_see_dashboard    = COALESCE(can_see_dashboard,    (SELECT rc.can_see_dashboard    FROM roles_config rc WHERE rc.role_name = employees.role)),
                        can_see_hr           = COALESCE(can_see_hr,           (SELECT rc.can_see_hr           FROM roles_config rc WHERE rc.role_name = employees.role)),
                        can_see_attendance   = COALESCE(can_see_attendance,   (SELECT rc.can_see_attendance   FROM roles_config rc WHERE rc.role_name = employees.role)),
                        can_see_sme          = COALESCE(can_see_sme,          (SELECT rc.can_see_sme          FROM roles_config rc WHERE rc.role_name = employees.role)),
                        can_see_pos          = COALESCE(can_see_pos,          (SELECT rc.can_see_pos          FROM roles_config rc WHERE rc.role_name = employees.role)),
                        can_see_secretary    = COALESCE(can_see_secretary,    (SELECT rc.can_see_secretary    FROM roles_config rc WHERE rc.role_name = employees.role)),
                        can_see_transport    = COALESCE(can_see_transport,    (SELECT rc.can_see_transport    FROM roles_config rc WHERE rc.role_name = employees.role)),
                        can_see_hardware     = COALESCE(can_see_hardware,     (SELECT rc.can_see_hardware     FROM roles_config rc WHERE rc.role_name = employees.role)),
                        can_see_system_users = COALESCE(can_see_system_users, (SELECT rc.can_see_system_users FROM roles_config rc WHERE rc.role_name = employees.role)),
                        can_see_schedules    = COALESCE(can_see_schedules,    (SELECT rc.can_see_schedules    FROM roles_config rc WHERE rc.role_name = employees.role))
                `, (err) => {
                    if (err) console.error('[Migration v130] Error updating backfill:', err.message);
                    else console.log('[Migration v130] Backfill complete.');
                    // Always mark version complete even if backfill had issues; v131 will re-run it
                    db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ['version', '130'], () => {
                        console.log('Migration to v130 complete: Added per-employee permission matrix.');
                    });
                });
                return;
            }
            const col = permCols[i++];
            db.run(`ALTER TABLE employees ADD COLUMN ${col} INTEGER DEFAULT NULL`, (err) => {
                if (err && !err.message.includes('duplicate column') && !err.message.includes('already exists')) {
                    console.error(`[Migration v130] Error adding ${col}:`, err.message);
                }
                runNextMigration();
            });
        }
        runNextMigration();
    }

    if (fromVersion < 131) {
        // v131: Safe re-run of the backfill in case v130 had a race condition on Postgres.
        db.run(`
            UPDATE employees SET
                can_see_dashboard    = COALESCE(can_see_dashboard,    (SELECT rc.can_see_dashboard    FROM roles_config rc WHERE rc.role_name = employees.role)),
                can_see_hr           = COALESCE(can_see_hr,           (SELECT rc.can_see_hr           FROM roles_config rc WHERE rc.role_name = employees.role)),
                can_see_attendance   = COALESCE(can_see_attendance,   (SELECT rc.can_see_attendance   FROM roles_config rc WHERE rc.role_name = employees.role)),
                can_see_sme          = COALESCE(can_see_sme,          (SELECT rc.can_see_sme          FROM roles_config rc WHERE rc.role_name = employees.role)),
                can_see_pos          = COALESCE(can_see_pos,          (SELECT rc.can_see_pos          FROM roles_config rc WHERE rc.role_name = employees.role)),
                can_see_secretary    = COALESCE(can_see_secretary,    (SELECT rc.can_see_secretary    FROM roles_config rc WHERE rc.role_name = employees.role)),
                can_see_transport    = COALESCE(can_see_transport,    (SELECT rc.can_see_transport    FROM roles_config rc WHERE rc.role_name = employees.role)),
                can_see_hardware     = COALESCE(can_see_hardware,     (SELECT rc.can_see_hardware     FROM roles_config rc WHERE rc.role_name = employees.role)),
                can_see_system_users = COALESCE(can_see_system_users, (SELECT rc.can_see_system_users FROM roles_config rc WHERE rc.role_name = employees.role)),
                can_see_schedules    = COALESCE(can_see_schedules,    (SELECT rc.can_see_schedules    FROM roles_config rc WHERE rc.role_name = employees.role))
        `, (err) => {
            if (err) console.error('[Migration v131] Error updating backfill:', err.message);
            else {
                db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ['version', '131'], () => {
                    console.log('Migration to v131 complete: Re-ran backfill to fix missing employee permissions.');
                });
            }
        });
    }

    if (fromVersion < 132) {
        // v132: Add driver_id and driver_name to deliveries table (missing from original schema)
        const deliveryCols = [
            'driver_id INTEGER',
            'driver_name TEXT'
        ];
        deliveryCols.forEach(colDef => {
            const colName = colDef.split(' ')[0];
            db.run(`ALTER TABLE deliveries ADD COLUMN ${colDef}`, (err) => {
                if (err && !err.message.includes('duplicate column') && !err.message.includes('already exists')) {
                    console.error(`[Migration v132] Error adding deliveries.${colName}:`, err.message);
                }
            });
        });
        db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ['version', '132'], () => {
            console.log('Migration to v132 complete: Added driver_id and driver_name to deliveries.');
        });
    }

    if (fromVersion < 133) {
        // v133: Ensure email_messages table exists for Secretary Portal (missing in older databases)
        db.run(`CREATE TABLE IF NOT EXISTS email_messages (
            id SERIAL PRIMARY KEY, message_uid TEXT UNIQUE,
            from_address TEXT, from_name TEXT, subject TEXT,
            body_preview TEXT, received_at TIMESTAMP,
            is_read INTEGER DEFAULT 0, fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                if (!err.message.includes('already exists')) {
                    console.error('[Migration v133] Error creating email_messages:', err.message);
                }
            } else {
                db.run('CREATE INDEX IF NOT EXISTS idx_email_uid ON email_messages(message_uid)');
                db.run('CREATE INDEX IF NOT EXISTS idx_email_read ON email_messages(is_read)');
                db.run('CREATE INDEX IF NOT EXISTS idx_email_date ON email_messages(received_at)');
                db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ['version', '133'], () => {
                    console.log('Migration to v133 complete: Ensured email_messages table exists.');
                });
            }
        });
    }

    if (fromVersion < 134) {
        const sql = config.dbType === 'postgres'
            ? `CREATE TABLE IF NOT EXISTS order_items (
                id SERIAL PRIMARY KEY,
                pos_order_id INTEGER NOT NULL,
                product_id INTEGER,
                product_name TEXT,
                qty INTEGER,
                price REAL,
                total REAL
            )`
            : `CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pos_order_id INTEGER NOT NULL,
                product_id INTEGER,
                product_name TEXT,
                qty INTEGER,
                price REAL,
                total REAL
            )`;
        db.run(sql, (err) => {
            if (err) {
                if (!err.message.includes('already exists')) {
                    console.error('[Migration v134] Error creating order_items:', err.message);
                }
            } else {
                db.run('CREATE INDEX IF NOT EXISTS idx_order_items_pos_order ON order_items(pos_order_id)');
                db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ['version', '134'], () => {
                    console.log('Migration to v134 complete: Added order_items table for receipt drill-down.');
                });
            }
        });
    }
}

initDb();

// On Postgres: automatically run migrations in every existing tenant schema (t_*) at startup.
// This ensures role seeding and schema updates propagate to all companies, not just new ones.
if (config.dbType === 'postgres') {
    setTimeout(async () => {
        try {
            const pool = new Pool(config.postgres);
            const client = await pool.connect();
            const result = await client.query(
                `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't\\_%' ESCAPE '\\'`
            );
            client.release();
            pool.end();

            const tenantSchemas = result.rows.map(r => r.schema_name);
            console.log(`[STARTUP] Found ${tenantSchemas.length} tenant schema(s) — running migrations...`);

            for (const schema of tenantSchemas) {
                await new Promise((resolve) => {
                    asyncLocalStorage.run(schema, () => {
                        initDb();
                        // Give migrations a moment to run before next schema
                        setTimeout(resolve, 500);
                    });
                });
                console.log(`[STARTUP] Migrations complete for schema: ${schema}`);
            }
        } catch (e) {
            console.error('[STARTUP] Failed to run tenant migrations:', e.message);
        }
    }, 3000); // Delay 3s so public schema migrations finish first
}

// Startup safety: always ensure barcode UNIQUE constraint is gone
// This runs every startup regardless of migration state
setTimeout(() => {
    db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'", (err, row) => {
        if (err || !row) return;
        if (row.sql && row.sql.includes('UNIQUE')) {
            console.log('[STARTUP FIX] products table still has UNIQUE constraint — rebuilding...');
            db.run(`DROP TABLE IF EXISTS products_fix`, () => {
                db.run(`CREATE TABLE products_fix (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, category TEXT,
                    price REAL, stock INTEGER, barcode TEXT,
                    barcode_end TEXT, photo_base64 TEXT, buying_price REAL DEFAULT 0
                )`, () => {
                    db.run(`INSERT INTO products_fix SELECT id, name, category, price, stock, barcode, barcode_end, photo_base64, buying_price FROM products`, (err) => {
                        if (err) { console.error('[STARTUP FIX] Copy error:', err.message); return; }
                        db.run(`DROP TABLE products`, () => {
                            db.run(`ALTER TABLE products_fix RENAME TO products`, () => {
                                console.log('[STARTUP FIX] UNIQUE constraint removed successfully.');
                            });
                        });
                    });
                });
            });
        } else {
            console.log('[STARTUP CHECK] products.barcode constraint OK — no UNIQUE.');
        }
    });
}, 2000); // Delay to let migrations finish first

module.exports = db;
module.exports.asyncLocalStorage = asyncLocalStorage;
// Note: db.dbPath is set above (SQLite only) and accessible as require('./database').dbPath
