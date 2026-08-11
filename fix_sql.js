const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./data/jomish.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pos_order_id INTEGER NOT NULL,
        product_id INTEGER,
        product_name TEXT,
        qty INTEGER,
        price REAL,
        total REAL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_order_items_pos_order ON order_items(pos_order_id)');
    db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', ['version', '134'], () => {
        console.log('Force migration to v134 complete: Added order_items table for receipt drill-down.');
    });
});
setTimeout(() => process.exit(0), 1500);
