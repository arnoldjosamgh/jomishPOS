const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./data/jomish.db');
db.all("SELECT p.id as pos_id, p.payment_method, t.payment_status, t.amount, t.id as t_id FROM pos_orders p JOIN transactions t ON p.transaction_id = t.id ORDER BY p.id DESC LIMIT 3", [], (err, rows) => {
    console.log(rows);
});
setTimeout(()=>process.exit(0), 1000);
