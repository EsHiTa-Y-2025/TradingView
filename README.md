# Reduction Tape — Deployment Guide

Two pieces:
- **`backend/`** — a small Node/Express API. Deploy this to **Render** (it needs to actually run code).
- **`frontend/`** — a single static `index.html`. Deploy this to **GitHub Pages** (it can only serve files, not run code).

They talk to each other over the network, so order matters: deploy the backend first, copy its URL, then point the frontend at it.

---

## 1. Push everything to GitHub

Create one repo (e.g. `reduction-tape`) with this structure:

```
reduction-tape/
├── backend/
│   ├── server.js
│   ├── package.json
│   └── .gitignore
└── frontend/
    └── index.html
```

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/reduction-tape.git
git push -u origin main
```

---

## 2. Deploy the backend to Render

1. Go to [render.com](https://render.com) and sign in with GitHub.
2. **New +** → **Web Service** → pick your `reduction-tape` repo.
3. Set:
   - **Root Directory:** `backend`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Click **Create Web Service**. Wait for the first deploy to finish.
5. Copy the URL Render gives you, something like:
   `https://reduction-tape-backend.onrender.com`
6. Test it by visiting `https://reduction-tape-backend.onrender.com/api/tape?symbol=AAPL` — you should see JSON with `5D`, `5W`, `5M` data.

**Free-tier note:** Render's free web services sleep after ~15 minutes of no traffic. The next request wakes it up but can take 30–50 seconds. The frontend already shows a "waking up" message for this — it's not a bug.

---

## 3. Point the frontend at your backend

Open `frontend/index.html`, find this block near the top of the `<script>`:

```js
const BACKEND_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:3000'
  : 'https://REPLACE-WITH-YOUR-RENDER-URL.onrender.com';
```

Replace `REPLACE-WITH-YOUR-RENDER-URL` with your actual Render URL from step 2, then commit and push:

```bash
git add frontend/index.html
git commit -m "Point frontend at deployed backend"
git push
```

---

## 4. Deploy the frontend to GitHub Pages

1. In your GitHub repo: **Settings → Pages**.
2. **Source:** Deploy from a branch.
3. **Branch:** `main`, folder `/frontend` (or move `index.html` to the repo root if GitHub Pages won't let you pick a subfolder on your plan — either works, just keep the path consistent).
4. Save. GitHub will give you a URL like:
   `https://YOUR-USERNAME.github.io/reduction-tape/`
5. Open it — it should load, search a company, and fill in the three tapes using your Render backend.

---

## 5. Running locally first (optional but recommended)

Before deploying, test on your machine:

```bash
cd backend
npm install
npm start
```

This starts the API on `http://localhost:3000`. Then just open `frontend/index.html` directly in your browser (double-click it) — the script auto-detects `localhost` and points at your local server.

---

## API reference

- `GET /api/search?q=apple` → list of `{ symbol, name, exchange }` matches.
- `GET /api/tape?symbol=AAPL` → `{ symbol, timeframes: { "5D": {...}, "5W": {...}, "5M": {...} } }`, each with `high5`, `low5`, `barsUsed`, `spread`, `steps`, `root`, `result`.
- `GET /health` → `{ ok: true }`, useful for checking the backend is awake.
