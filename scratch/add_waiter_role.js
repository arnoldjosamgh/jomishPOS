const path = require('path');
// Load env from project root
const envPath = path.join(__dirname, '..', '.env');
const fs = require('fs');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const r = await pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't_%'");
  const schemas = r.rows.map(x => x.schema_name);
  console.log('Tenant schemas found:', schemas);

  for (const schema of schemas) {
    try {
      const client = await pool.connect();
      await client.query(`SET search_path TO "${schema}"`);
      const result = await client.query(
        `INSERT INTO roles_config (role_name, can_see_dashboard, can_see_hr, can_see_attendance, can_see_sme, can_see_pos, can_see_secretary, can_see_transport)
         VALUES ('Waiter', 0, 0, 0, 0, 1, 0, 0) ON CONFLICT (role_name) DO NOTHING`
      );
      console.log(`[${schema}] Waiter inserted: ${result.rowCount} row(s) affected.`);
      client.release();
    } catch (e) {
      console.error(`[${schema}] Error:`, e.message);
    }
  }
  await pool.end();
  console.log('Done.');
}

main();
