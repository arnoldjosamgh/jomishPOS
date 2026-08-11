const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./backend/database.sqlite');
db.all("SELECT * FROM order_items ORDER BY id DESC LIMIT 5", (err, rows) => {
    console.log(err ? err : rows);
});
