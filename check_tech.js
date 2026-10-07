// Quick diagnostic script: check tech_users table on Neon Postgres
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    // Check tech_users table
    const res1 = await pool.query('SELECT id, username, created_at FROM public.tech_users');
    console.log('tech_users rows:', res1.rows);
    console.log('Row count:', res1.rowCount);

    // Check COUNT type
    const res2 = await pool.query('SELECT COUNT(*) as count FROM public.tech_users');
    console.log('\nCOUNT result:', res2.rows[0]);
    console.log('count type:', typeof res2.rows[0].count);
    console.log('count === 0:', res2.rows[0].count === 0);
    console.log('count == 0:', res2.rows[0].count == 0);
    console.log('parseInt(count) === 0:', parseInt(res2.rows[0].count) === 0);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await pool.end();
  }
}

main();
