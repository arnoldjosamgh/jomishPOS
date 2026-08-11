const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/jomish.db');
db.run('INSERT INTO order_items (pos_order_id, product_id, product_name, qty, price, total) VALUES (1, 1, "Test", 1, 100, 100)', (err) => {
    console.log(err ? err.message : 'Success');
});
