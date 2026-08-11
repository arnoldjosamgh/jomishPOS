const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/jomish.db');
db.all("PRAGMA table_info(pos_orders);", (err, rows) => {
    console.log("pos_orders columns:", rows.map(r=>r.name).join(', '));
});
db.all("PRAGMA table_info(transactions);", (err, rows) => {
    console.log("transactions columns:", rows.map(r=>r.name).join(', '));
});
