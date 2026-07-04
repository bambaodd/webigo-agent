# WEBIGO — Setup Guide

## Step 1 — GitHub
1. Go to github.com → New repository → name it `webigo-agent`
2. Upload all these files (drag and drop works)
3. Make sure `public/index.html` is inside a `public` folder

## Step 2 — Railway
1. Go to railway.app → New Project → Deploy from GitHub
2. Select your `webigo-agent` repo
3. Railway auto-detects Node.js and runs `npm start`

## Step 3 — Add PostgreSQL Database
1. In Railway → your project → click `+ New` → Database → PostgreSQL
2. Railway automatically adds `DATABASE_URL` to your environment — done

## Step 4 — Add Environment Variables
In Railway → your project → Variables tab, add each of these:

```
ANTHROPIC_API_KEY      = sk-ant-api03-...
GOOGLE_MAPS_API_KEY    = AIzaSy...
TWILIO_ACCOUNT_SID     = ACxxx...
TWILIO_AUTH_TOKEN      = your_token
TWILIO_PHONE_NUMBER    = +1234567890
TWILIO_WHATSAPP_NUMBER = whatsapp:+14155238886
SENDGRID_API_KEY       = SG.xxx...
FROM_EMAIL             = you@yourdomain.com
NODE_ENV               = production
PORT                   = 3000
```

## Step 5 — Deploy
1. Railway auto-deploys when you push to GitHub
2. Check Deployments tab → click the latest deploy → view logs
3. You should see: `✓ Database ready` and `✓ Webigo running on port 3000`

## Step 6 — Open Dashboard
Railway gives you a URL like `webigo-agent.up.railway.app`
Open it — you should see the full dashboard.

## Updating Code
1. Edit files on your computer
2. Push to GitHub (`git push`)
3. Railway auto-deploys in ~2 minutes
4. Check logs for any errors

## Google Maps API Setup
1. Go to console.cloud.google.com
2. Enable: Places API, Maps JavaScript API, Geocoding API
3. Copy your API key → add to Railway variables

## WhatsApp Business API
1. Go to business.facebook.com
2. Create a Meta Business account
3. Apply for WhatsApp Business API (takes 1-3 days for approval)
4. Connect your Twilio number to WhatsApp

## Troubleshooting
- **Blank dashboard**: Check browser console (F12) for JS errors
- **Server crash**: Check Railway deployment logs
- **Scraper returns USA**: Confirm GOOGLE_MAPS_API_KEY is correct
- **AI not responding**: Confirm ANTHROPIC_API_KEY is in Railway variables
- **Database errors**: Check DATABASE_URL is present (added by PostgreSQL add-on)
