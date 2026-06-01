# BetaKE – Sports Betting Platform

A full betting platform inspired by Betika, built for Kenya.

## Tech Stack
- **Backend:** Node.js + Express
- **Database:** MongoDB Atlas
- **Auth:** JWT + bcryptjs
- **Odds:** The Odds API (the-odds-api.com)
- **Hosting:** Render.com

## Project Structure
```
betika-clone/
├── server/
│   ├── index.js           # Main Express server
│   ├── models/
│   │   └── User.js        # User model
│   ├── routes/
│   │   ├── auth.js        # Register, login, /me
│   │   └── odds.js        # Sports & matches
│   └── middleware/
│       └── auth.js        # JWT middleware
├── public/
│   ├── index.html         # Home page (matches + betslip)
│   └── pages/
│       ├── login.html     # Login page
│       └── register.html  # Register page
├── .env.example           # Environment variables template
├── render.yaml            # Render deployment config
└── package.json
```

## Setup Steps

### 1. MongoDB Atlas (free)
1. Go to https://cloud.mongodb.com
2. Create a free cluster
3. Create database user (username + password)
4. Get connection string → put in MONGO_URI

### 2. The Odds API (free tier = 500 requests/month)
1. Go to https://the-odds-api.com
2. Sign up → get free API key
3. Put in ODDS_API_KEY

### 3. Local Development
```bash
cp .env.example .env
# Fill in your values in .env
npm install
npm run dev
# Visit http://localhost:3000
```

### 4. Deploy to Render
1. Push this folder to GitHub
2. Go to https://render.com → New Web Service
3. Connect your GitHub repo
4. Add environment variables (MONGO_URI, JWT_SECRET, ODDS_API_KEY)
5. Deploy!

## Features Built (Phase 1)
- [x] User registration (phone + username + password)
- [x] User login with JWT
- [x] Live odds from The Odds API
- [x] Sports tabs (EPL, La Liga, Champions League, etc.)
- [x] Bet slip with multi-selections
- [x] Potential winnings calculator
- [x] Mobile-first responsive UI

## Coming Next (Phase 2)
- [ ] M-Pesa deposit & withdraw (Daraja API)
- [ ] Place bets (deduct balance, save to DB)
- [ ] My Bets page
- [ ] Live scores
- [ ] Admin panel
- [ ] Jackpot feature
