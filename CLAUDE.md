# Profit Pulse AI Bot

Telegram Mini App providing AI-generated binary trading signals for Pocket Option (OTC pairs).

## Project Structure

```
/
├── server.js          ← All-in-one: Express server + Telegram bot (polling) + API
├── package.json       ← Single package, run with: npm start
├── .env               ← Config (copy from .env.example and fill in values)
├── public/
│   └── index.html     ← Complete Telegram Mini App (vanilla JS, no build step)
└── data/
    └── users.json     ← Auto-created, stores verified user records
```

## How to Run

```bash
npm install
cp .env.example .env   # then fill in BOT_TOKEN and WEBAPP_URL
npm start
```

## Key Files

- **server.js** — Express + `node-telegram-bot-api` (polling). Handles:
  - `/start`, `/signals`, `/status`, `/help` bot commands
  - `GET /api/signals?timeframe=1` — returns 24 OTC signals
  - `POST /api/auth/verify` — verifies user UID, saves to data/users.json
  - `GET /affiliate` — redirects to Pocket Option affiliate link
  - Serves `public/` as static files

- **public/index.html** — Self-contained Telegram Mini App. No build step.
  - 4 screens: Welcome → How-to → Verify UID → Signal Dashboard
  - 24 OTC pairs in Pocket Option format (EUR/USD OTC, GBP/USD OTC, etc.)
  - Signal engine: seeded random + RSI/MACD/Bollinger Band simulation
  - Live countdown timers, auto-refresh every minute
  - Calls `/api/auth/verify` when user submits their UID

## Environment Variables (.env)

| Variable | Description |
|---|---|
| `BOT_TOKEN` | From @BotFather on Telegram |
| `WEBAPP_URL` | Your deployed HTTPS URL (required for Mini App button) |
| `PORT` | Server port (default: 3000) |
| `ADMIN_IDS` | Your Telegram user ID for notifications |
| `AFFILIATE_LINK` | Your Pocket Option affiliate link |

## Deployment

- **Backend**: Railway, Render, or Fly.io — all give free HTTPS
- **Local testing**: `ngrok http 3000` → copy https URL → set as WEBAPP_URL
- **BotFather setup**: `/newapp` → select bot → paste WEBAPP_URL

## Signal Engine Logic

Located in both `public/index.html` (client) and `server.js` (server).
Uses seeded deterministic random so all users see the same signal at the same time.
Indicators simulated: RSI, MACD direction, Bollinger Band position, Stochastic.
Confidence clamped to 72–95% range. Timeframes: 1m, 2m, 3m, 5m.

## User Access Flow

1. User opens bot → `/start` → sees Mini App button
2. User taps button → Welcome screen (affiliate link)
3. User registers on Pocket Option via affiliate link + deposits
4. User enters their Pocket Option UID
5. Server saves UID to `data/users.json` → signals unlocked
6. Admin receives Telegram notification of new verified user
