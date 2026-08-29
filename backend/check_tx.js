const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, '../data/jomish.db'));

db.all('SELECT COUNT(*) as count FROM transactions', [], (err, rows) => {
    if (err) { console.error('ERROR:', err.message); return; }
    console.log('Total transactions:', JSON.stringify(rows));
});

db.all('SELECT * FROM transactions ORDER BY id DESC LIMIT 5', [], (err, rows) => {
    if (err) { console.error('ERROR:', err.message); return; }
    console.log('Last 5 transactions:', JSON.stringify(rows, null, 2));
    db.close();
});
