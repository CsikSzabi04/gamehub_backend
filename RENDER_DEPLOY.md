# 🚀 GameHub Backend - Render Deploy Guide

## ✅ Render Kompatibilitás

Ez a backend **100% Render-kompatibilis**:
- ✅ PORT dinamikus (`process.env.PORT`)
- ✅ Node.js ES modules (supported)
- ✅ Environment variables kezelés
- ✅ Health check endpoint (`/health`)
- ✅ Graceful shutdown

---

## 📋 Telepítés Render-re

### 1. GitHub feltöltés

```bash
# Repo inicializálása (ha még nincs)
git init
git remote add origin https://github.com/YOUR_USERNAME/gamehub_backend.git
git branch -M main
git add .
git commit -m "Initial commit - GameHub Backend v2.0"
git push -u origin main
```

**FONTOS:** Az `.env` már `.gitignore`-ban van, így nem töltődik fel! ✅

### 2. Render beállítás

#### Opció A: Web Service (egyszerű)

1. Lépj be a [Render.com](https://render.com)-ra
2. Kattints **"New +"** → **"Web Service"**
3. Válaszd ki a GitHub repót
4. Beállítás:
   - **Name**: `gamehub-backend` (vagy tetszőleges)
   - **Runtime**: Node
   - **Region**: `oregon` vagy `us-west` (alacsonyabb latency EU-ból)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free (vagy Starter haöbb szeretnél)

5. **Environment Variables** beállítása:
   - Kattints az panel jobb oldalán **"Add Environment Variable"**
   - Add hozzá ezeket:

```
NODE_ENV = production

RAWG_API_KEY = your_key_from_rawg.io
RAPIDAPI_KEY = your_key_from_rapidapi.com
NEWSAPI_KEY = your_key_from_newsapi.org
TMDB_API_TOKEN = your_token_from_themoviedb.org

CACHE_DURATION_EXTERNAL_API = 600
CACHE_DURATION_MOVIES = 1800
CACHE_DURATION_NEWS = 900

CORS_ORIGIN = *
```

6. Kattints **"Deploy"** → Ez után Render automatikusan deployolja a repót

#### Opció B: render.yaml (automatikus)

Ha szeretnéd, hogy a `render.yaml` automatikusan alkalmazza a beállításokat:

1. Az előző lépéseket követi, de a `render.yaml` már tartalmazza az alapértelmezéseket
2. Az API kulcsokat még mindig az Environment Variables-ben kell beállítani!

---

## 🔐 API Kulcsok Render-en

### Hogyan add hozzá:

1. **Render Dashboard** → Válaszd az alkalmazást
2. **Settings** tab
3. **Environment** section
4. Kattints **"Edit"**
5. Add hozzá a kulcsokat

### Szükséges kulcsok:

| Kulcs | Forrás | Ingyenes? |
|-------|--------|-----------|
| `RAWG_API_KEY` | https://rawg.io/api-access | ✅ Ingyenes regisztráció |
| `RAPIDAPI_KEY` | https://rapidapi.com | ✅ Ingyenes tier (3500 kérés/hó) |
| `NEWSAPI_KEY` | https://newsapi.org | ✅ Ingyenes (100 kérés/nap) |
| `TMDB_API_TOKEN` | https://www.themoviedb.org/settings/api | ✅ Ingyenes (kell rád link) |

---

## 📊 URL és Health Check

### Production URL:
```
https://gamehub-backend-RANDOM.onrender.com
```

Pl: `https://gamehub-backend-zekj.onrender.com` (az eddigi!)

### Health check:
```bash
curl https://gamehub-backend-RANDOM.onrender.com/health
```

### Ellenőrizd a logokat:
Render Dashboard → **Logs** tab

---

## 🔄 Deployment Folyamat

### Automatikus deployment:
- Commit → Push to main → Render automatikusan deployolja

### Manual redeploy:
1. Render Dashboard → Jobb oldal **"Manual Deploy"** → **"Deploy latest commit"**

### Environment változó módosítás után:
1. Add meg az új értéket
2. Kattints **"Save"**
3. Render automatikusan újra deployolja az app-ot

---

## ⚡ Performance Render-en

### Free tier korlátok:
- **Compute**: Shared CPU
- **RAM**: 512 MB
- **Cold start**: ~30-60 másodperc (inaktivitás után)
- **Uptime**: 99.9%

### Teljesítmény javítása:
- Upgrade Starter tier-re (2GB RAM, dedicated CPU)
- Load balancer hozzáadása
- PostgreSQL backup (adatok persistálása)

---

## 🐛 Hibaelhárítás

### "Port already in use"
❌ **Gond**: lokális PORT konfliktus  
✅ **Megoldás**: Render automatikusan kezeli → nem gond

### "Cannot find module 'dotenv'"
❌ **Gond**: npm install nem futott le  
✅ **Megoldás**: Render Dashboard → Kattints **"Clear build cache"** → redeploy

### "API requests failing"
❌ **Gond**: Environment variables nincsenek beállítva  
✅ **Megoldás**: Ellenőrizd az API kulcsokat a Render Dashboard-ban

### "Service crashed"
❌ **Gond**: Runtime error  
✅ **Megoldás**: 
1. Nézd meg a **Logs** tab-ot
2. Ellenőrizd az API kulcsokat
3. Ellenőrizd, hogy az `.env` helyesen konfigurálva van

---

## 📝 Render feautures

### Ingyenes tier + Included:
- ✅ HTTPS SSL certificat (automatikus)
- ✅ Auto-redeploy (Git integration)
- ✅ Environment variables
- ✅ Log streaming
- ✅ Health checks
- ✅ Graceful shutdown (SIGTERM kezelés)

### Paid tier (opcional):
- Database backups
- Custom domains
- Dedicated IP
- Advanced monitoring

---

## 🎯 Végösszesen

### Step-by-step:
1. `git push` a GitHub-ra
2. Render.com regisztráció → New Web Service
3. GitHub repo kiválasztás
4. Build & Start commands beállítása
5. API kulcsok hozzáadása → Environment
6. **Deploy** ✅

### Ezt követően:
- Render automatikusan deployolja minden `main` push után
- Health endpoint: `https://gamehub-backend.onrender.com/health`
- API endpoints: `https://gamehub-backend.onrender.com/api-endpoint`

---

## 📚 Hasznos linkek

- [Render Docs](https://render.com/docs)
- [Render PostgreSQL](https://render.com/docs/databases)
- [Environment Variables best practices](https://render.com/docs/environment-variables)
- [Node.js Deployment Guide](https://render.com/docs/deploy-node)

---

**Verzió**: 2.0  
**Utolsó frissítés**: February 2026  
**Status**: ✅ Ready for Render
