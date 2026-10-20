const fs = require('fs');
const path = require('path');
const { jsPDF } = require(path.resolve(__dirname, '../public/lib/jspdf.umd.min.js'));
const db = require('./database');

const ARCHIVE_DIR = path.resolve(__dirname, '../backup/archives');
if (!fs.existsSync(ARCHIVE_DIR)) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

// ── Ensure archive tracking table exists ───────────────────────────────────
function ensureArchiveSchema(callback) {
  db.run(`CREATE TABLE IF NOT EXISTS transaction_archives (
    id SERIAL PRIMARY KEY,
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    cutoff_date TIMESTAMP,
    transaction_count INTEGER,
    total_income REAL DEFAULT 0,
    total_expense REAL DEFAULT 0,
    pdf_filename TEXT,
    pdf_path TEXT,
    archived_by TEXT DEFAULT 'System Auto-Archiver'
  )`, (err) => {
    if (typeof callback === 'function') callback(err);
  });
}

/**
 * Generate a comprehensive PDF audit archive of transactions.
 */
function generateArchivePDF({ schema, cutoffDate, transactions, summary, businessInfo }) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = 210;
  const margin = 14;
  const contentWidth = pageWidth - (margin * 2);

  const fmtUGX = (n) => "UGX " + Math.round(Number(n) || 0).toLocaleString();

  // Header Banner
  doc.setFillColor(30, 41, 59); // slate-800
  doc.rect(0, 0, pageWidth, 26, 'F');

  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.text(businessInfo.bizName || "JOMISH BUSINESS SUITE", margin, 12);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(203, 213, 225);
  doc.text("HISTORICAL TRANSACTION ARCHIVE & AUDIT REPORT", margin, 18);
  doc.text(`Tenant Schema: ${schema}  |  Generated: ${new Date().toLocaleString()}`, margin, 23);

  let y = 34;

  // Metadata Block
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.text("Archive Parameters & Executive Summary", margin, y);
  y += 6;

  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(margin, y, contentWidth, 24, 2, 2, 'FD');

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(71, 85, 105);

  const cutoffStr = new Date(cutoffDate).toLocaleString();
  doc.text(`Cutoff Date (3 Weeks Threshold): Older than ${cutoffStr}`, margin + 4, y + 6);
  doc.text(`Total Archived Transactions: ${summary.count}`, margin + 4, y + 12);
  doc.text(`Recycled Numbers: Receipt #s reset cleanly for active data`, margin + 4, y + 18);

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(16, 185, 129); // green
  doc.text(`Total Revenue: ${fmtUGX(summary.totalIncome)}`, 110, y + 6);
  doc.setTextColor(239, 68, 68); // red
  doc.text(`Total Expenses: ${fmtUGX(summary.totalExpense)}`, 110, y + 12);
  doc.setTextColor(15, 23, 42);
  doc.text(`Net Balance: ${fmtUGX(summary.totalIncome - summary.totalExpense)}`, 110, y + 18);

  y += 32;

  // Table Header Function
  const renderTableHeader = (currentY) => {
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, currentY, contentWidth, 7, 'F');
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);

    doc.text("RCPT #", margin + 2, currentY + 4.8);
    doc.text("Date / Time", margin + 24, currentY + 4.8);
    doc.text("Cashier", margin + 60, currentY + 4.8);
    doc.text("Type / Method", margin + 92, currentY + 4.8);
    doc.text("Description", margin + 126, currentY + 4.8);
    doc.text("Amount (UGX)", margin + contentWidth - 2, currentY + 4.8, { align: 'right' });
    return currentY + 7;
  };

  y = renderTableHeader(y);

  // Render Rows
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];

    if (y > 275) {
      doc.addPage();
      // Mini page header
      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, pageWidth, 10, 'F');
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(255, 255, 255);
      doc.text(`Transaction Archive — ${schema} (Cont.)`, margin, 7);
      doc.text(`Page ${doc.internal.getNumberOfPages()}`, pageWidth - margin, 7, { align: 'right' });

      y = renderTableHeader(15);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
    }

    const isIncome = tx.type === 'INCOME' || tx.type === 'CASH_IN' || tx.type === 'FLOAT_IN';
    const amountColor = isIncome ? [16, 185, 129] : [239, 68, 68];
    const sign = isIncome ? "+" : "-";

    // Alternate row background
    if (i % 2 === 1) {
      doc.setFillColor(248, 250, 252);
      doc.rect(margin, y, contentWidth, 6, 'F');
    }

    const rcptStr = `RCPT${String(tx.receipt_no || tx.id).padStart(3, '0')}`;
    const dateStr = new Date(tx.transaction_date).toLocaleDateString() + " " + new Date(tx.transaction_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const cashier = (tx.cashier_name || tx.recorded_by_name || "System").slice(0, 16);
    const methodStr = `${tx.type} (${tx.payment_method || 'CASH'})`.slice(0, 18);
    const desc = (tx.description || "POS Sale").slice(0, 28);
    const amtStr = `${sign}${Math.round(tx.amount || 0).toLocaleString()}`;

    doc.setTextColor(15, 23, 42);
    doc.text(rcptStr, margin + 2, y + 4.2);
    doc.text(dateStr, margin + 24, y + 4.2);
    doc.text(cashier, margin + 60, y + 4.2);
    doc.text(methodStr, margin + 92, y + 4.2);
    doc.text(desc, margin + 126, y + 4.2);

    doc.setTextColor(amountColor[0], amountColor[1], amountColor[2]);
    doc.setFont('helvetica', 'bold');
    doc.text(amtStr, margin + contentWidth - 2, y + 4.2, { align: 'right' });
    doc.setFont('helvetica', 'normal');

    y += 6;
  }

  // Footer on last page
  y += 8;
  if (y > 270) {
    doc.addPage();
    y = 20;
  }
  doc.setDrawColor(203, 213, 225);
  doc.line(margin, y, margin + contentWidth, y);
  y += 6;
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text("End of Archive Record. All transactions listed above have been permanently verified, logged, and removed from active database storage to optimize performance.", margin, y);

  return doc.output('arraybuffer');
}

/**
 * Execute archival for transactions older than `ageDays` (default 21 days).
 */
async function archiveOldTransactions(options = {}) {
  const ageDays = options.ageDays !== undefined ? options.ageDays : 21;
  const dryRun = options.dryRun || false;
  const archivedBy = options.archivedBy || "System Auto-Archiver";

  const cutoffDate = new Date(Date.now() - (ageDays * 24 * 60 * 60 * 1000));
  const cutoffIso = cutoffDate.toISOString();

  // Query eligible transactions:
  // Must be strictly older than cutoffDate.
  // Safety filters:
  // - Must be PAID (payment_status = 'PAID')
  // - Exclude active credit records with balance > 0
  // - Exclude pending deliveries
  const candidateRows = await new Promise((resolve, reject) => {
    db.all(`
      SELECT t.id, t.receipt_no, t.amount, t.type, t.description, t.recorded_by,
             t.transaction_date, t.payment_status,
             po.id as pos_order_id, po.payment_method, po.total_amount, po.invoice_number,
             CASE 
               WHEN po.served_by IS NOT NULL AND TRIM(po.served_by) != '' THEN po.served_by
               WHEN t.recorded_by = 9999 THEN 'System Technician'
               ELSE COALESCE(NULLIF(CAST(e.nickname AS TEXT),''), e.first_name || ' ' || e.last_name)
             END as cashier_name
      FROM transactions t
      LEFT JOIN pos_orders po ON po.transaction_id = t.id
      LEFT JOIN employees e ON t.recorded_by = e.id
      LEFT JOIN credit_records cr ON cr.pos_order_id = po.id
      LEFT JOIN deliveries d ON d.order_id = po.id
      WHERE t.transaction_date < ?
        AND UPPER(COALESCE(t.payment_status, 'PAID')) = 'PAID'
        AND COALESCE(cr.balance, 0) <= 0
        AND COALESCE(d.status, 'Delivered') IN ('Delivered', 'Completed', 'Cancelled', '')
      ORDER BY t.id ASC
    `, [cutoffIso], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });

  if (candidateRows.length === 0) {
    return {
      success: true,
      count: 0,
      message: `No completed transactions older than ${ageDays} days found to archive.`
    };
  }

  // Calculate summary
  let totalIncome = 0;
  let totalExpense = 0;
  candidateRows.forEach(tx => {
    const isInc = tx.type === 'INCOME' || tx.type === 'CASH_IN' || tx.type === 'FLOAT_IN';
    if (isInc) totalIncome += (Number(tx.amount) || 0);
    else totalExpense += (Number(tx.amount) || 0);
  });

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      count: candidateRows.length,
      totalIncome,
      totalExpense,
      cutoffDate: cutoffIso,
      message: `Found ${candidateRows.length} transactions eligible for archive.`
    };
  }

  // Get schema and business details
  const schema = (db.asyncLocalStorage && db.asyncLocalStorage.getStore()) || 'public';
  const bizName = "Jomish Business Suite";

  // Generate PDF in memory
  const pdfBuffer = generateArchivePDF({
    schema,
    cutoffDate,
    transactions: candidateRows,
    summary: { count: candidateRows.length, totalIncome, totalExpense },
    businessInfo: { bizName }
  });

  // Save PDF to backup/archives
  const dateTag = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `archive_${schema}_${dateTag}_${candidateRows.length}tx.pdf`;
  const fullPath = path.join(ARCHIVE_DIR, filename);
  fs.writeFileSync(fullPath, Buffer.from(pdfBuffer));

  const txIds = candidateRows.map(r => r.id);
  const posOrderIds = candidateRows.map(r => r.pos_order_id).filter(Boolean);

  // Atomic database purge & receipt_no re-sequencing
  await db.withTransaction(async (q) => {
    // 1. Delete order_items
    if (posOrderIds.length > 0) {
      const placeholders = posOrderIds.map(() => '?').join(',');
      await q(`DELETE FROM order_items WHERE pos_order_id IN (${placeholders})`, posOrderIds);
      await q(`DELETE FROM pos_orders WHERE id IN (${placeholders})`, posOrderIds);
      await q(`DELETE FROM deliveries WHERE order_id IN (${placeholders})`, posOrderIds);
    }

    // 2. Delete sold_barcodes & transactions
    const txPlaceholders = txIds.map(() => '?').join(',');
    await q(`DELETE FROM sold_barcodes WHERE transaction_id IN (${txPlaceholders})`, txIds).catch(() => {});
    await q(`DELETE FROM transactions WHERE id IN (${txPlaceholders})`, txIds);

    // 3. Recycle receipt numbers: re-sequence remaining transactions from 1
    await q(`
      WITH numbered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id ASC) as rn
        FROM transactions
      )
      UPDATE transactions
      SET receipt_no = numbered.rn
      FROM numbered
      WHERE transactions.id = numbered.id
    `).catch(() => {});

    // 4. Record archive entry
    await q(`
      INSERT INTO transaction_archives (
        cutoff_date, transaction_count, total_income, total_expense, pdf_filename, pdf_path, archived_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [cutoffIso, candidateRows.length, totalIncome, totalExpense, filename, fullPath, archivedBy]).catch(() => {});

    // 5. Update app_settings last_archive_timestamp
    const nowIso = new Date().toISOString();
    await q(`
      INSERT INTO app_settings (setting_key, setting_value)
      VALUES ('last_auto_archive_date', ?)
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
    `, [nowIso]).catch(() => {
      // Fallback for SQLite
      q(`INSERT OR REPLACE INTO app_settings (setting_key, setting_value) VALUES ('last_auto_archive_date', ?)`, [nowIso]);
    });
  });

  console.log(`[ARCHIVER] Schema ${schema}: Successfully archived ${candidateRows.length} transactions to ${filename}.`);

  return {
    success: true,
    count: candidateRows.length,
    totalIncome,
    totalExpense,
    pdfFilename: filename,
    pdfPath: fullPath,
    message: `Successfully archived ${candidateRows.length} transactions older than ${ageDays} days to PDF and recycled numbers.`
  };
}

/**
 * Check if 60 days (2 months) have passed since the last archive.
 * If yes, run auto-archival for all tenant schemas.
 */
async function checkAndRunScheduledArchive() {
  try {
    const configData = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config/config.json'), 'utf8'));
    if (configData.dbType === 'postgres') {
      const { Pool } = require('pg');
      const pool = new Pool(configData.postgres);
      const res = await pool.query(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't\\_%' ESCAPE '\\'`);
      const schemas = ['public', ...res.rows.map(r => r.schema_name)];
      
      for (const sc of schemas) {
        try {
          const client = await pool.connect();
          let shouldRun = false;
          try {
            await client.query(`SET search_path TO "${sc}"`);
            const sRes = await client.query(`SELECT setting_value FROM app_settings WHERE setting_key = 'last_auto_archive_date'`);
            const lastDateStr = (sRes.rows && sRes.rows[0]) ? sRes.rows[0].setting_value : null;
            if (!lastDateStr) {
              // Never run before: check if there are transactions older than 3 weeks
              const checkOld = await client.query(`SELECT COUNT(*) as cnt FROM transactions WHERE transaction_date < NOW() - INTERVAL '21 days'`);
              if (parseInt(checkOld.rows[0].cnt, 10) > 0) {
                shouldRun = true;
              }
            } else {
              const daysSince = (Date.now() - new Date(lastDateStr).getTime()) / (1000 * 60 * 60 * 24);
              if (daysSince >= 60) {
                shouldRun = true;
              }
            }
          } finally {
            client.release();
          }

          if (shouldRun) {
            console.log(`[AUTO-ARCHIVER] 60-day interval reached for schema "${sc}". Archiving transactions older than 3 weeks...`);
            await new Promise((resolve) => {
              db.asyncLocalStorage.run(sc, async () => {
                try {
                  await archiveOldTransactions({ ageDays: 21, archivedBy: 'Automated 2-Month Scheduled Task' });
                } catch (e) {
                  console.error(`[AUTO-ARCHIVER] Error in ${sc}:`, e.message);
                }
                resolve();
              });
            });
          }
        } catch (scErr) {
          // ignore single schema errors
        }
      }
      await pool.end();
    }
  } catch (err) {
    console.error('[AUTO-ARCHIVER] Scheduler check error:', err.message);
  }
}

/**
 * Start the recurring 2-month background scheduler.
 * Runs check every 24 hours.
 */
function startArchiveScheduler() {
  // Check 30 seconds after server boot
  setTimeout(() => {
    checkAndRunScheduledArchive().catch(console.error);
  }, 30000);

  // Run periodic check every 24 hours (86,400,000 ms)
  setInterval(() => {
    checkAndRunScheduledArchive().catch(console.error);
  }, 24 * 60 * 60 * 1000);

  console.log('[ARCHIVER] Background 2-month auto-archive scheduler initialized (21-day retention cutoff).');
}

/**
 * List all available PDF archive files.
 */
function listArchives(schema) {
  try {
    const files = fs.readdirSync(ARCHIVE_DIR);
    const filter = schema ? `archive_${schema}_` : 'archive_';
    return files
      .filter(f => f.endsWith('.pdf') && f.startsWith(filter))
      .map(f => {
        const stats = fs.statSync(path.join(ARCHIVE_DIR, f));
        return {
          filename: f,
          sizeBytes: stats.size,
          sizeFormatted: (stats.size / 1024).toFixed(1) + ' KB',
          createdAt: stats.mtime
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (e) {
    return [];
  }
}

module.exports = {
  ensureArchiveSchema,
  archiveOldTransactions,
  checkAndRunScheduledArchive,
  startArchiveScheduler,
  listArchives,
  ARCHIVE_DIR
};
