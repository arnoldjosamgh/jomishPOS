const webpush = require('web-push');
const db = require('./database');
const { asyncLocalStorage } = require('./database'); // To handle multi-tenancy correctly

const PUBLIC_VAPID_KEY = 'BDpy4RrJ8ch4fFlX6BeLYhXzFXhOvldEnzIsAvFW_vDqAloZ87zcLynHJvy9qrk6n17MJy8dpMhfAD-gAsZ4FbY';
const PRIVATE_VAPID_KEY = process.env.VAPID_PRIVATE_KEY || 'LDM5uJIa4znYcj4bTzDGWduXcmKcvhzGc9WmHcJcRfk';

// Configure Web Push
webpush.setVapidDetails(
    'mailto:support@jomish.com',
    PUBLIC_VAPID_KEY,
    PRIVATE_VAPID_KEY
);

// Subscribe an employee
async function saveSubscription(employeeId, subscription, schema) {
    return new Promise((resolve, reject) => {
        asyncLocalStorage.run(schema, () => {
            const subStr = typeof subscription === 'string' ? subscription : JSON.stringify(subscription);
            db.run(
                'INSERT INTO push_subscriptions (employee_id, subscription) VALUES (?, ?)',
                [employeeId, subStr],
                function(err) {
                    if (err) {
                        // Might already exist for this employee on this device, ignore or update
                        console.warn('[PUSH] Subscription save note:', err.message);
                        resolve();
                    } else {
                        resolve();
                    }
                }
            );
        });
    });
}

// Send to specific employee in a specific schema
async function sendPushToEmployee(employeeId, payload, schema) {
    return new Promise((resolve, reject) => {
        asyncLocalStorage.run(schema, () => {
            db.all(
                'SELECT subscription FROM push_subscriptions WHERE employee_id = ?',
                [employeeId],
                async (err, rows) => {
                    if (err || !rows || rows.length === 0) return resolve(0);
                    
                    let sentCount = 0;
                    for (const row of rows) {
                        try {
                            const sub = JSON.parse(row.subscription);
                            await webpush.sendNotification(sub, JSON.stringify(payload));
                            sentCount++;
                        } catch (e) {
                            if (e.statusCode === 410 || e.statusCode === 404) {
                                // Subscription expired or is invalid, remove it
                                db.run('DELETE FROM push_subscriptions WHERE subscription = ?', [row.subscription]);
                            } else {
                                console.error('[PUSH] Failed to send push:', e);
                            }
                        }
                    }
                    resolve(sentCount);
                }
            );
        });
    });
}

// Send to all employees of a specific role
async function sendPushToRole(role, payload, schema) {
    return new Promise((resolve, reject) => {
        asyncLocalStorage.run(schema, () => {
            db.all(
                `SELECT p.subscription FROM push_subscriptions p
                 JOIN employees e ON p.employee_id = e.id
                 WHERE e.role = ? AND e.is_active = 1`,
                [role],
                async (err, rows) => {
                    if (err || !rows) return resolve(0);
                    for (const row of rows) {
                        try {
                            const sub = JSON.parse(row.subscription);
                            await webpush.sendNotification(sub, JSON.stringify(payload));
                        } catch (e) {
                            // cleanup on fail...
                            db.run('DELETE FROM push_subscriptions WHERE subscription = ?', [row.subscription]);
                        }
                    }
                    resolve(rows.length);
                }
            );
        });
    });
}

module.exports = {
    saveSubscription,
    sendPushToEmployee,
    sendPushToRole
};
