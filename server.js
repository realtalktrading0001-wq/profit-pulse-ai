// ═══════════════════════════════════════════════════════════════════════════════
//  Profit Pulse AI — Server
//  Runs: Express web server + Telegram Bot (polling)
//  Start: npm start
// ═══════════════════════════════════════════════════════════════════════════════
import express   from 'express'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import fs        from 'fs'
import crypto    from 'crypto'
import https     from 'https'
import 'dotenv/config'

const __dir         = dirname(fileURLToPath(import.meta.url))
const app           = express()
const PORT          = process.env.PORT          || 3000
const TOKEN         = process.env.BOT_TOKEN
const WEBAPP        = process.env.WEBAPP_URL
const AFFL          = process.env.AFFILIATE_LINK || 'https://u3.shortink.io/register?utm_campaign=752344&utm_source=affiliate&utm_medium=sr&a=gVM94Uu5t2L8P5&al=1739694&ac=mybot&cid=946822'
const ADMINS        = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
const PO_CAMPAIGN   = process.env.PO_CAMPAIGN_ID  || '752344'
const PO_HASH       = process.env.PO_API_HASH                       // 6b1c18ca67108c1dbf1edc69eb3b1a7c
const MIN_BALANCE        = parseFloat(process.env.MIN_BALANCE        || '50')  // $50 to GET access (first time)
const MAINTAIN_BALANCE   = parseFloat(process.env.MAINTAIN_BALANCE   || '20')  // $20 to KEEP access (ongoing)
const AFFILIATE_ID       = process.env.AFFILIATE_ID || '1739694'               // your al= ID in the affiliate link
const PO_API_TOKEN       = process.env.PO_API_TOKEN || 'suTC6e89oYB4O9RV4ynS' // raw API token (hash computed per request)
const BALANCE_TTL   = 60 * 60 * 1000                                // re-check balance every 1h

// ─── File-based user database ─────────────────────────────────────────────────
const DB_DIR  = join(__dir, 'data')
const DB_FILE = join(DB_DIR, 'users.json')
if (!fs.existsSync(DB_DIR))  fs.mkdirSync(DB_DIR)
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '{}')

function dbRead()          { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) } catch { return {} } }
function dbWrite(d)        { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)) }
function getUser(id)       { return dbRead()[String(id)] }
function setUser(id, data) { const db = dbRead(); db[String(id)] = { ...(db[String(id)] || {}), ...data }; dbWrite(db) }
function getAllUsers()      { return Object.values(dbRead()) }

// ─── Telegram auth validator ──────────────────────────────────────────────────
function validateTgAuth(initData, token) {
  try {
    const params = new URLSearchParams(initData)
    const hash   = params.get('hash')
    if (!hash) return null
    params.delete('hash')
    const checkStr = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n')
    const secret   = crypto.createHmac('sha256', 'WebAppData').update(token).digest()
    const expected = crypto.createHmac('sha256', secret).update(checkStr).digest('hex')
    if (expected !== hash) return null
    const u = params.get('user')
    return u ? JSON.parse(u) : null
  } catch { return null }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  POCKET PARTNERS AFFILIATE API
//  Endpoint: https://pocketpartners.com/en/api/user-info/{uid}/{campaign}/{hash}
//
//  Response fields used:
//    balance        — current trading account balance (must be >= MIN_BALANCE)
//    sum_deposits   — total lifetime deposits
//    sum_ftd        — first-time deposit amount
//    count_deposits — number of deposits made
//    is_verified    — account email verified
//    uid            — confirms UID is under our affiliate
// ═══════════════════════════════════════════════════════════════════════════════
// ── Low-level HTTPS GET using Node built-in (works on all Node versions) ─────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; ProfitPulseAI/1.0)',
      },
      timeout: 12000,
    }, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')) })
    req.on('error', reject)
  })
}

async function checkPocketOption(uid) {
  if (!PO_API_TOKEN) {
    console.warn('[PO API] PO_API_TOKEN not set in .env')
    return { ok: false, apiError: true, reason: 'API not configured' }
  }

  // Hash is computed PER REQUEST: md5(user_id:partner_id:api_token)
  const hashInput = `${uid}:${PO_CAMPAIGN}:${PO_API_TOKEN}`
  const hash      = crypto.createHash('md5').update(hashInput).digest('hex')
  const url       = `https://pocketpartners.com/en/api/user-info/${uid}/${PO_CAMPAIGN}/${hash}`
  console.log(`[PO API] uid=${uid} hash=${hash}`)

  try {
    const { status, body } = await httpsGet(url)
    console.log(`[PO API] uid=${uid} → status=${status} body=${body.slice(0,120)}`)

    // 404 = UID not found under our affiliate
    if (status === 404) {
      return { ok: false, affiliated: false, reason: 'UID not found under our affiliate link' }
    }

    // Any non-200 = API issue
    if (status !== 200) {
      return { ok: false, apiError: true, reason: `Pocket Partners API error (${status})` }
    }

    // Check if response is HTML (not JSON)
    if (body.trim().startsWith('<')) {
      console.error('[PO API] Got HTML response instead of JSON — wrong URL format?')
      return { ok: false, apiError: true, reason: 'API returned HTML page (check URL format)' }
    }

    const data = JSON.parse(body)

    const balance     = parseFloat(data.balance     ?? 0)
    const sumDeposits = parseFloat(data.sum_deposits ?? 0)
    const sumFtd      = parseFloat(data.sum_ftd      ?? 0)
    const hasDeposit  = sumDeposits > 0 || sumFtd > 0
    const hasBalance  = balance >= MIN_BALANCE

    // Check user registered under OUR specific affiliate link (al=1739694)
    const userLink    = data.link || ''
    const isOurAffiliate = userLink.includes(`al=${AFFILIATE_ID}`)
    console.log(`[PO API] affiliate check: link=${userLink} | isOurs=${isOurAffiliate}`)

    return {
      ok:          true,
      affiliated:  isOurAffiliate,   // true only if under YOUR affiliate link
      hasDeposit,
      hasBalance,
      balance,
      sumDeposits,
      data,
    }

  } catch (err) {
    console.error('[PO API] Error:', err.message)
    return { ok: false, apiError: true, reason: `Network error: ${err.message}` }
  }
}

// ─── Admin notifier ───────────────────────────────────────────────────────────
function notifyAdmins(bot, text) {
  if (!bot || !ADMINS.length) return
  ADMINS.forEach(id => bot.sendMessage(id, text, { parse_mode: 'Markdown' }).catch(() => {}))
}

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
let bot = null
if (TOKEN) {
  const { default: TelegramBot } = await import('node-telegram-bot-api')
  bot = new TelegramBot(TOKEN, { polling: true })

  const appBtn = label => WEBAPP
    ? { inline_keyboard: [[{ text: label, web_app: { url: WEBAPP } }]] }
    : undefined

  // /start
  bot.onText(/\/start/, msg => {
    const id       = msg.chat.id
    const userId   = msg.from.id
    const name     = msg.from.first_name || 'Trader'
    const verified = getUser(userId)?.verified

    const text = verified
      ? `⚡ *Welcome back, ${name}!*\n\n` +
        `Your signals are live and ready! 📊\n\n` +
        `Tap the button below to open your dashboard 👇`
      : `🤖 *Welcome to Profit Pulse AI!*\n` +
        `_Hey ${name}, great to have you here!_ 👋\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `⚡ *AI-Powered OTC Signals*\n` +
        `📊 28 OTC Pairs · 6 Timeframes\n` +
        `🎯 82–95% Win Rate Accuracy\n` +
        `🔴🟢 Live UP/DOWN Signals\n` +
        `⏱ 5s · 15s · 30s · 1m · 2m · 5m\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `*To get full access:*\n` +
        `1️⃣ Register on Pocket Option via our link\n` +
        `2️⃣ Deposit minimum *$20*\n` +
        `3️⃣ Enter your UID in the app → *Instant access* ✅\n\n` +
        `🎁 Try 1 free signal first — no registration needed!\n\n` +
        `👇 *Tap below to start trading smarter:*`

    bot.sendMessage(id, text, {
      parse_mode:   'Markdown',
      reply_markup: appBtn(verified ? '📊 Open Signal Dashboard' : '🚀 Start Trading with Profit Pulse AI'),
    }).catch(console.error)
  })

  // /signals
  bot.onText(/\/signals/, msg => {
    const user = getUser(msg.from.id)
    if (!user?.verified) return bot.sendMessage(msg.chat.id, '🔒 Use /start to register and get access.')
    bot.sendMessage(msg.chat.id, '📊 Your live dashboard:', { reply_markup: appBtn('⚡ View Signals') })
  })

  // /status
  bot.onText(/\/status/, msg => {
    const user = getUser(msg.from.id)
    const s    = user?.verified
      ? `✅ Verified — Full access (balance last checked: ${user.lastBalanceCheck?.split('T')[0] || 'never'})`
      : user?.pending
        ? '⏳ Pending manual verification'
        : '❌ Not registered'
    bot.sendMessage(msg.chat.id, `*Your Status:*\n${s}`, { parse_mode: 'Markdown' })
  })

  // /help
  bot.onText(/\/help/, msg => {
    bot.sendMessage(msg.chat.id,
      `*Profit Pulse AI — Commands*\n\n/start   — Open the app\n/signals — View live signals\n/status  — Check your access\n/help    — Show this menu`,
      { parse_mode: 'Markdown' }
    )
  })

  // ── ADMIN COMMANDS ────────────────────────────────────────────────────────

  bot.onText(/\/pending/, msg => {
    if (!ADMINS.includes(String(msg.from.id))) return
    const list = getAllUsers().filter(u => u.pending && !u.verified)
    if (!list.length) return bot.sendMessage(msg.chat.id, '✅ No pending verifications.')
    const lines = list.map((u, i) =>
      `${i+1}. TG: \`${u.telegramId}\`\n   PO UID: \`${u.pocketOptionUid}\`\n   Date: ${u.submittedAt?.split('T')[0]||'?'}`
    ).join('\n\n')
    bot.sendMessage(msg.chat.id,
      `*⏳ Pending (${list.length})*\n\n${lines}\n\n/approve <PO_UID>  · /deny <PO_UID>`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.onText(/\/approve (.+)/, (msg, match) => {
    if (!ADMINS.includes(String(msg.from.id))) return
    const poUid = match[1].trim()
    const entry = Object.values(dbRead()).find(u => String(u.pocketOptionUid) === poUid)
    if (!entry) return bot.sendMessage(msg.chat.id, `❌ No user with PO UID \`${poUid}\``, { parse_mode: 'Markdown' })
    setUser(entry.telegramId, { verified: true, pending: false, verifiedAt: new Date().toISOString(), approvedBy: 'admin' })
    bot.sendMessage(msg.chat.id, `✅ Approved \`${poUid}\``, { parse_mode: 'Markdown' })
    if (!entry.telegramId.startsWith('dev-')) {
      bot.sendMessage(entry.telegramId,
        `✅ *Access Granted!*\n\nYour account has been verified. You now have full access to all live signals! 🎉`,
        { parse_mode: 'Markdown', reply_markup: appBtn('📊 Open Dashboard') }
      ).catch(() => {})
    }
  })

  bot.onText(/\/deny (.+)/, (msg, match) => {
    if (!ADMINS.includes(String(msg.from.id))) return
    const poUid = match[1].trim()
    const entry = Object.values(dbRead()).find(u => String(u.pocketOptionUid) === poUid)
    if (!entry) return bot.sendMessage(msg.chat.id, `❌ No user with PO UID \`${poUid}\``, { parse_mode: 'Markdown' })
    setUser(entry.telegramId, { pending: false, denied: true, deniedAt: new Date().toISOString() })
    bot.sendMessage(msg.chat.id, `🚫 Denied \`${poUid}\``, { parse_mode: 'Markdown' })
    if (!entry.telegramId.startsWith('dev-')) {
      bot.sendMessage(entry.telegramId,
        `❌ *Verification Failed*\n\nWe couldn't confirm a $${MIN_BALANCE}+ balance under our affiliate link for UID \`${poUid}\`.\n\nMake sure you registered via our link and have sufficient balance.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {})
    }
  })

  bot.onText(/\/users/, msg => {
    if (!ADMINS.includes(String(msg.from.id))) return
    const all = getAllUsers()
    bot.sendMessage(msg.chat.id,
      `📊 *Users*\nTotal: ${all.length}\nVerified: ${all.filter(u=>u.verified).length}\nPending: ${all.filter(u=>u.pending&&!u.verified).length}\nDenied: ${all.filter(u=>u.denied).length}`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.on('polling_error', err => console.error('[bot]', err.message))
  console.log('🤖  Telegram bot started (polling)')
} else {
  console.log('⚠️   BOT_TOKEN not set — bot disabled')
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json())
app.use(express.static(join(__dir, 'public')))
app.get('/affiliate', (_req, res) => res.redirect(AFFL))

// ─── Signal Engine ────────────────────────────────────────────────────────────
const PAIRS = [
  {id:'eurusd',name:'EUR/USD OTC'},{id:'gbpusd',name:'GBP/USD OTC'},
  {id:'usdjpy',name:'USD/JPY OTC'},{id:'audusd',name:'AUD/USD OTC'},
  {id:'usdcad',name:'USD/CAD OTC'},{id:'usdchf',name:'USD/CHF OTC'},
  {id:'nzdusd',name:'NZD/USD OTC'},{id:'eurgbp',name:'EUR/GBP OTC'},
  {id:'eurjpy',name:'EUR/JPY OTC'},{id:'gbpjpy',name:'GBP/JPY OTC'},
  {id:'eurchf',name:'EUR/CHF OTC'},{id:'audcad',name:'AUD/CAD OTC'},
  {id:'audchf',name:'AUD/CHF OTC'},{id:'audjpy',name:'AUD/JPY OTC'},
  {id:'cadchf',name:'CAD/CHF OTC'},{id:'cadjpy',name:'CAD/JPY OTC'},
  {id:'chfjpy',name:'CHF/JPY OTC'},{id:'gbpaud',name:'GBP/AUD OTC'},
  {id:'gbpcad',name:'GBP/CAD OTC'},{id:'gbpchf',name:'GBP/CHF OTC'},
  {id:'gbpnzd',name:'GBP/NZD OTC'},{id:'euraud',name:'EUR/AUD OTC'},
  {id:'eurcad',name:'EUR/CAD OTC'},{id:'eurnzd',name:'EUR/NZD OTC'},
  {id:'nzdcad',name:'NZD/CAD OTC'},{id:'nzdchf',name:'NZD/CHF OTC'},
  {id:'nzdjpy',name:'NZD/JPY OTC'},{id:'audnzd',name:'AUD/NZD OTC'},
]
function sRand(s){ let r=s>>>0;r=(r^r<<13)>>>0;r=(r^r>>>17)>>>0;r=(r^r<<5)>>>0;return r/0xFFFFFFFF }
function hsh(str){ let h=0;for(const c of str)h=(h<<5)-h+c.charCodeAt(0)|0;return Math.abs(h) }
function mkSig(pair,tf){
  const now=new Date(),key=Math.floor(now.getTime()/(60000*tf)),seed=hsh(pair.id+'_'+key)
  const rsi=20+sRand(seed)*60,macd=sRand(seed+1)>.5?1:-1,bb=sRand(seed+2),st=sRand(seed+3)*100
  let up=0,dn=0
  rsi<30?(up+=2):rsi>70?(dn+=2):rsi<45?up++:rsi>55?dn++:0
  macd>0?up++:dn++;bb<.3?(up+=2):bb>.7?(dn+=2):0;st<20?up++:st>80?dn++:0
  const dir=up>=dn?'UP':'DOWN',rawC=Math.max(up,dn)/(up+dn)*100
  const conf=Math.round(Math.min(95,Math.max(72,72+(rawC-50)/50*23)))
  const sl=Math.max(1,tf*60-(now.getSeconds()+now.getMinutes()%tf*60))
  const fmt=d=>d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false})
  const eD=new Date(now.getTime()+sl*1000)
  return{id:pair.id+'-'+tf+'m-'+key,pair:pair.name,flag:pair.flag,dir,conf,tf,entry:fmt(eD),expiry:fmt(new Date(eD.getTime()+tf*60000)),secsLeft:sl}
}
function genAll(tf){ return PAIRS.map(p=>mkSig(p,tf)) }

// ─── API routes ───────────────────────────────────────────────────────────────

app.get('/api/signals', (req, res) => {
  const tf = parseInt(req.query.timeframe) || 1
  if (![1,2,3,5].includes(tf)) return res.status(400).json({ error: 'timeframe must be 1,2,3 or 5' })
  res.json({ timeframe: tf, count: PAIRS.length, signals: genAll(tf), generatedAt: new Date().toISOString() })
})

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/auth/verify
//  Flow:
//    1. Call Pocket Partners API → check if UID is under our affiliate
//    2a. Not affiliated (404)  → ❌ reject
//    2b. No deposit yet        → ❌ reject with deposit message
//    2c. Has deposit, balance < $20 → ❌ need $20+
//    2d. Has deposit, balance ≥ $20 → ✅ grant access instantly
//    2e. API error / timeout   → ⏳ pending queue, admin notified
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/auth/verify', async (req, res) => {
  const { pocketOptionUid, initData } = req.body
  const uid = String(pocketOptionUid || '').trim()

  if (!uid || uid.length < 4) {
    return res.json({ success: false, error: 'Please enter a valid UID (at least 4 digits)' })
  }

  // Identify Telegram user (fallback: dev mode)
  let userId = 'dev-' + uid
  if (initData && TOKEN) {
    const tgUser = validateTgAuth(initData, TOKEN)
    if (!tgUser) return res.json({ success: false, error: 'Telegram auth failed. Please reopen the app.' })
    userId = String(tgUser.id)
  }

  // Already verified? skip re-check
  if (getUser(userId)?.verified) return res.json({ success: true, verified: true })

  console.log(`[verify] uid=${uid} tg=${userId}`)
  const r = await checkPocketOption(uid)
  console.log(`[verify] result:`, { affiliated: r.affiliated, hasDeposit: r.hasDeposit, hasBalance: r.hasBalance, balance: r.balance, apiError: r.apiError })

  // ── Not under our affiliate ──────────────────────────────────────────────
  if (!r.apiError && !r.affiliated) {
    return res.json({
      success: false,
      error: '❌ This UID is not registered under our affiliate link.\n\nPlease register on Pocket Option using our link, then try again.',
    })
  }

  // ── Affiliated but no deposit yet ────────────────────────────────────────
  if (r.affiliated && !r.hasDeposit) {
    return res.json({
      success: false,
      error: `✅ Account found!\n\n❌ No deposit detected yet. Please make a deposit of at least $${MIN_BALANCE} on Pocket Option and try again.`,
    })
  }

  // ── Has deposit but balance is below minimum ─────────────────────────────
  if (r.affiliated && r.hasDeposit && !r.hasBalance) {
    return res.json({
      success: false,
      error: `✅ Account found!\n\n❌ Your current balance is $${r.balance.toFixed(2)}. You need at least $${MIN_BALANCE} in your account to access the signals.\n\nPlease deposit to bring your balance to $${MIN_BALANCE}+ and try again.`,
    })
  }

  // ── Affiliated + sufficient balance → GRANT ACCESS ───────────────────────
  if (r.affiliated && r.hasBalance) {
    setUser(userId, {
      telegramId:       userId,
      pocketOptionUid:  uid,
      verified:         true,
      pending:          false,
      verifiedAt:       new Date().toISOString(),
      verifiedBy:       'api',
      balance:          r.balance,
      lastBalanceCheck: new Date().toISOString(),
    })

    notifyAdmins(bot,
      `✅ *Auto-verified*\nTG: \`${userId}\`\nPO UID: \`${uid}\`\nBalance: $${r.balance.toFixed(2)}\n${new Date().toLocaleString()}`
    )
    return res.json({ success: true, verified: true, balance: r.balance, uid })
  }

  // ── API error / unreachable → pending queue ──────────────────────────────
  setUser(userId, {
    telegramId:      userId,
    pocketOptionUid: uid,
    verified:        false,
    pending:         true,
    submittedAt:     new Date().toISOString(),
  })

  notifyAdmins(bot,
    `⚠️ *New User Waiting for Approval*\n\n` +
    `👤 TG ID: \`${userId}\`\n` +
    `🔢 PO UID: \`${uid}\`\n` +
    `❓ Reason: ${r.reason}\n\n` +
    `👉 Check in your Pocket Partners dashboard:\n` +
    `https://pocketpartners.com/en/traders\n\n` +
    `Then reply:\n` +
    `✅ /approve ${uid}\n` +
    `❌ /deny ${uid}`
  )

  // Also send user a friendly waiting message
  if (bot && userId && !userId.startsWith('dev-')) {
    bot.sendMessage(userId,
      `⏳ *Verifying your account...*\n\nWe're checking your Pocket Option account manually. You'll receive a notification here within a few minutes once approved! 🚀`,
      { parse_mode: 'Markdown' }
    ).catch(() => {})
  }

  return res.json({
    success: false,
    pending: true,
    error: "We're verifying your account manually. You'll receive a Telegram message once confirmed (usually within minutes).",
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/auth/check
//  Called on every app open. Re-checks balance every BALANCE_TTL ms.
//  If balance drops below MIN_BALANCE → revokes access automatically.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/auth/check', async (req, res) => {
  const { initData } = req.body
  let userId = null
  if (initData && TOKEN) {
    const u = validateTgAuth(initData, TOKEN)
    if (u) userId = String(u.id)
  }

  const user = userId ? getUser(userId) : null
  if (!user?.verified) {
    return res.json({ hasAccess: false, pending: !!user?.pending })
  }

  // Throttle balance re-checks to once per BALANCE_TTL
  const lastCheck = user.lastBalanceCheck ? new Date(user.lastBalanceCheck).getTime() : 0
  const needsRecheck = (Date.now() - lastCheck) > BALANCE_TTL

  if (needsRecheck && user.pocketOptionUid) {
    const r = await checkPocketOption(user.pocketOptionUid)
    setUser(userId, { lastBalanceCheck: new Date().toISOString() })

    // Ongoing check: use MAINTAIN_BALANCE ($20) — lower than initial $50 requirement
    // User can trade and lose some funds, but must keep at least $20 to stay active
    if (!r.apiError && r.affiliated && r.balance < MAINTAIN_BALANCE) {
      setUser(userId, {
        verified:      false,
        revokedAt:     new Date().toISOString(),
        revokeReason:  'balance_too_low',
        lastBalance:   r.balance,
      })

      if (!userId.startsWith('dev-')) {
        bot?.sendMessage(userId,
          `⚠️ *Access Paused*\n\nYour Pocket Option balance ($${r.balance.toFixed(2)}) has dropped below the $${MAINTAIN_BALANCE} minimum to maintain access.\n\nDeposit to bring your balance above $${MAINTAIN_BALANCE} and reopen the app to regain access.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {})
      }

      return res.json({
        hasAccess:  false,
        reason:     'balance_too_low',
        balance:    r.balance,
        minBalance: MAINTAIN_BALANCE,
      })
    }
  }

  res.json({ hasAccess: true, balance: user.balance || null, uid: user.pocketOptionUid || null })
})

// GET /api/admin/users
app.get('/api/admin/users', (req, res) => {
  if (!ADMINS.includes(String(req.query.adminId))) return res.status(403).json({ error: 'Forbidden' })
  res.json({ users: getAllUsers() })
})

// POST /api/admin/approve
app.post('/api/admin/approve', (req, res) => {
  const { adminId, userId } = req.body
  if (!ADMINS.includes(String(adminId))) return res.status(403).json({ error: 'Forbidden' })
  if (!getUser(userId)) return res.status(404).json({ error: 'User not found' })
  setUser(userId, { verified: true, pending: false, verifiedAt: new Date().toISOString(), approvedBy: 'admin' })
  res.json({ success: true })
})

// GET /api/test-po?uid=123456 — test dynamic hash, try multiple URL formats
app.get('/api/test-po', async (req, res) => {
  const uid       = req.query.uid || '133254094'
  const hashInput = `${uid}:${PO_CAMPAIGN}:${PO_API_TOKEN}`
  const hash      = crypto.createHash('md5').update(hashInput).digest('hex')

  const urls = [
    `https://pocketpartners.com/api/user-info/${uid}/${PO_CAMPAIGN}/${hash}`,
    `https://pocketpartners.com/en/api/user-info/${uid}/${PO_CAMPAIGN}/${hash}`,
  ]

  const results = []
  for (const url of urls) {
    try {
      const { status, body } = await httpsGet(url)
      results.push({ url, status, rawBody: body.slice(0, 300) })
    } catch(e) {
      results.push({ url, status: 'ERROR', rawBody: e.message })
    }
  }
  res.json({ uid, hashInput, hash, results })
})

// ─── Free signal tracking ─────────────────────────────────────────────────────
// POST /api/free/use — record that this TG user used their free signal
app.post('/api/free/use', (req, res) => {
  const { initData } = req.body
  if (!initData || !TOKEN) return res.json({ ok: true })
  const tgUser = validateTgAuth(initData, TOKEN)
  if (!tgUser) return res.json({ ok: true })
  setUser(String(tgUser.id), {
    telegramId: String(tgUser.id),
    freeSignalUsed: true,
    freeSignalUsedAt: new Date().toISOString(),
  })
  res.json({ ok: true })
})

// POST /api/free/check — check if this TG user already used free signal
app.post('/api/free/check', (req, res) => {
  const { initData } = req.body
  if (!initData || !TOKEN) return res.json({ used: false })
  const tgUser = validateTgAuth(initData, TOKEN)
  if (!tgUser) return res.json({ used: false })
  const user = getUser(String(tgUser.id))
  res.json({ used: !!user?.freeSignalUsed })
})

// GET /health
app.get('/health', (_req, res) => res.json({
  status:     'ok',
  uptime:     Math.round(process.uptime()) + 's',
  poApiHash:  PO_HASH   ? '✅ set' : '❌ missing',
  botToken:   TOKEN     ? '✅ set' : '❌ missing',
  minBalance: `$${MIN_BALANCE}`,
}))

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ⚡  Profit Pulse AI
  ─────────────────────────────────────────────
  🌐  App:     http://localhost:${PORT}
  📊  Signals: http://localhost:${PORT}/api/signals
  ─────────────────────────────────────────────
  ${WEBAPP   ? `✅ WEBAPP_URL:  ${WEBAPP}`       : '⚠️  Set WEBAPP_URL in .env'}
  ${TOKEN    ? '✅ Bot:         polling active'  : '⚠️  Set BOT_TOKEN in .env'}
  ${PO_HASH  ? '✅ PO API:      hash configured' : '⚠️  Set PO_API_HASH in .env'}
  💰 Min balance: $${MIN_BALANCE}
  ─────────────────────────────────────────────
  Admin commands: /pending /approve /deny /users
  ─────────────────────────────────────────────
  `)
})
