# JomishPOS

A standalone, full-screen Point of Sale system extracted from the Jomish Business Suite.

## Features
- Full-screen POS register with product search, cart, checkout, and receipt printing
- Inventory management
- Expense tracking
- Credit accounts
- SME Financial Portal (accessible via Finance Hub button)
- Cashier reports

## Deployment

### Prerequisites
- Node.js 18+
- A Neon Postgres database (https://neon.tech)

### Local Development
```bash
npm install
node backend/server.js
```
Access at `http://localhost:3005`

### Deploy to Render
1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo (`jomishPOS`)
4. Render will auto-detect `render.yaml`
5. In the Render dashboard → Environment tab, set:
   - `DATABASE_URL` = your Neon Postgres connection string (e.g. `postgresql://user:password@ep-xxx.neon.tech/neondb?sslmode=require`)
6. Deploy!

### Neon Database Setup
1. Create a free account at [neon.tech](https://neon.tech)
2. Create a new project → Copy the connection string
3. Paste it as `DATABASE_URL` in your Render environment variables
4. The app will auto-create all tables on first boot

## Login
Default tech login: `tech` / `Jomish9!!`
