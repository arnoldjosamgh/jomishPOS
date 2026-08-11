const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./data/jomish.db');
db.get('SELECT * FROM system_info WHERE key = "version"', [], (err, row) => {
    console.log('Version:', row);
});
db.all('SELECT * FROM order_items LIMIT 1', [], (err, rows) => {
    console.log('Order items error:', err ? err.message : 'none', 'rows:', rows);
});
setTimeout(() => process.exit(0), 1000);
