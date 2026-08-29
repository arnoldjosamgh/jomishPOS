const { Pool } = require('pg');

const pool = new Pool({ 
    connectionString: 'postgresql://neondb_owner:npg_wfOXbnA3i0JY@ep-raspy-thunder-ayuhx4hs-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    ssl: { rejectUnauthorized: false }
});

async function main() {
    const client = await pool.connect();
    try {
        // Check all schemas
        const schemas = await client.query(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't_%' OR schema_name = 'public' ORDER BY schema_name`);
        console.log('Schemas:', schemas.rows.map(r => r.schema_name).join(', '));
        
        // Check transactions count per schema
        for (const row of schemas.rows) {
            const schema = row.schema_name;
            try {
                const res = await client.query(`SELECT COUNT(*) as cnt FROM ${schema}.transactions`);
                console.log(`  ${schema}.transactions: ${res.rows[0].cnt} rows`);
                
                if (parseInt(res.rows[0].cnt) > 0) {
                    const sample = await client.query(`SELECT id, amount, type, description, transaction_date FROM ${schema}.transactions ORDER BY id DESC LIMIT 3`);
                    console.log(`  Latest in ${schema}:`, JSON.stringify(sample.rows, null, 2));
                }
            } catch(e) {
                console.log(`  ${schema}.transactions: not found (${e.message})`);
            }
        }
    } finally {
        client.release();
        pool.end();
    }
}

main().catch(console.error);
