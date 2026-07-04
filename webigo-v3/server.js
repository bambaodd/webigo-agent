require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── DATABASE ──────────────────────────────────────────────────────
const db = new Database('webigo.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    country TEXT DEFAULT '',
    category TEXT DEFAULT '',
    description TEXT DEFAULT '',
    google_rating REAL DEFAULT 0,
    google_reviews INTEGER DEFAULT 0,
    photo_url TEXT DEFAULT '',
    owner_name TEXT DEFAULT '',
    facebook_url TEXT DEFAULT '',
    instagram_url TEXT DEFAULT '',
    twitter_url TEXT DEFAULT '',
    instagram_followers INTEGER DEFAULT 0,
    facebook_followers INTEGER DEFAULT 0,
    twitter_followers INTEGER DEFAULT 0,
    stage TEXT DEFAULT 'new',
    call_outcome TEXT DEFAULT '',
    last_contacted TEXT DEFAULT '',
    ai_analysis TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    qualifying_questions TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    direction TEXT DEFAULT 'out',
    content TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER DEFAULT NULL,
    business_name TEXT DEFAULT '',
    caller TEXT DEFAULT '',
    outcome TEXT DEFAULT '',
    price_discussed REAL DEFAULT 0,
    summary TEXT DEFAULT '',
    called_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    priority TEXT DEFAULT 'medium',
    category TEXT DEFAULT 'general',
    lead_id INTEGER DEFAULT NULL,
    completed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS revenue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER DEFAULT NULL,
    amount REAL NOT NULL,
    description TEXT DEFAULT '',
    closed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add missing columns to existing tables (safe - silently fails if exists)
const addCol = (t, c, d) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); } catch {} };
addCol('leads', 'call_outcome', "TEXT DEFAULT ''");
addCol('leads', 'last_contacted', "TEXT DEFAULT ''");
addCol('leads', 'photo_url', "TEXT DEFAULT ''");
addCol('leads', 'ai_analysis', "TEXT DEFAULT ''");
addCol('calls', 'business_name', "TEXT DEFAULT ''");
addCol('calls', 'summary', "TEXT DEFAULT ''");

// Migrate old stage names
db.exec(`
  UPDATE leads SET stage='new' WHERE stage='New Lead';
  UPDATE leads SET stage='contacted' WHERE stage='Contacted';
  UPDATE leads SET stage='responded' WHERE stage='Responded Positively';
  UPDATE leads SET stage='hot' WHERE stage='Hot Lead';
  UPDATE leads SET stage='negotiation' WHERE stage='Price Negotiation';
  UPDATE leads SET stage='demo' WHERE stage='Demo Sent';
  UPDATE leads SET stage='closed' WHERE stage='Closed';
  UPDATE leads SET stage='lost' WHERE stage='Lost';
`);

// ── MIDDLEWARE ─────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── MARKETS CONFIG ─────────────────────────────────────────────────
const MARKETS = {
  australia: { flag:'🇦🇺', name:'Australia',  tz:'Australia/Sydney',    code:'AU', cities:['Sydney','Melbourne','Brisbane','Perth','Adelaide','Gold Coast','Canberra','Newcastle','Hobart','Darwin'] },
  uk:        { flag:'🇬🇧', name:'UK',          tz:'Europe/London',       code:'GB', cities:['London','Manchester','Birmingham','Leeds','Glasgow','Liverpool','Bristol','Sheffield','Edinburgh','Leicester'] },
  us:        { flag:'🇺🇸', name:'USA',         tz:'America/New_York',    code:'US', cities:['New York','Los Angeles','Chicago','Houston','Phoenix','Dallas','San Diego','San Antonio','Philadelphia','Austin'] },
  canada:    { flag:'🇨🇦', name:'Canada',      tz:'America/Toronto',     code:'CA', cities:['Toronto','Vancouver','Montreal','Calgary','Edmonton','Ottawa','Winnipeg','Quebec City','Hamilton','Kitchener'] },
  sweden:    { flag:'🇸🇪', name:'Sweden',      tz:'Europe/Stockholm',    code:'SE', cities:['Stockholm','Gothenburg','Malmö','Uppsala','Västerås','Örebro','Linköping','Helsingborg','Jönköping','Norrköping'] },
  norway:    { flag:'🇳🇴', name:'Norway',      tz:'Europe/Oslo',         code:'NO', cities:['Oslo','Bergen','Trondheim','Stavanger','Drammen','Fredrikstad','Kristiansand','Tromsø'] },
  denmark:   { flag:'🇩🇰', name:'Denmark',     tz:'Europe/Copenhagen',   code:'DK', cities:['Copenhagen','Aarhus','Odense','Aalborg','Frederiksberg','Esbjerg','Randers','Kolding'] },
  finland:   { flag:'🇫🇮', name:'Finland',     tz:'Europe/Helsinki',     code:'FI', cities:['Helsinki','Espoo','Tampere','Vantaa','Oulu','Turku','Jyväskylä','Lahti'] },
};

// ── SCRAPER ────────────────────────────────────────────────────────
const jobs = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.post('/api/scrape/start', async (req, res) => {
  const { country, category, targetCount = 50 } = req.body;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'GOOGLE_MAPS_API_KEY not set in Railway Variables' });

  const market = MARKETS[country?.toLowerCase()];
  if (!market) return res.status(400).json({ error: 'Invalid country' });

  const jobId = `job_${Date.now()}`;
  const target = Math.min(parseInt(targetCount) || 50, 300);
  jobs[jobId] = { status: 'running', found: 0, skipped: 0, target, city: '', category: category || 'Restaurant', log: [] };
  res.json({ jobId });

  (async () => {
    const job = jobs[jobId];
    const cat = category || 'Restaurant';
    const queries = [cat, `${cat} near me`, `local ${cat}`];

    try {
      for (const city of market.cities) {
        if (job.status === 'stopped' || job.found >= target) break;
        job.city = city;
        for (const q of queries) {
          if (job.status === 'stopped' || job.found >= target) break;
          job.log.unshift({ t: 'search', m: `🔍 ${q} in ${city}...` });

          let places = [];
          try {
            const r = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
              params: { query: `${q} in ${city}`, key: apiKey, region: market.code }
            });
            places = r.data.results || [];
          } catch(e) { job.log.unshift({ t: 'err', m: `⚠️ Maps error: ${e.message}` }); continue; }

          for (const place of places.slice(0, 8)) {
            if (job.status === 'stopped' || job.found >= target) break;
            try {
              const dr = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
                params: { place_id: place.place_id, key: apiKey,
                  fields: 'name,formatted_phone_number,formatted_address,website,rating,user_ratings_total,photos,editorial_summary' }
              });
              const d = dr.data.result;
              if (!d) continue;

              if (d.website) {
                job.skipped++;
                job.log.unshift({ t: 'skip', m: `↷ Has website — skipped: ${d.name}` });
                if (job.log.length > 120) job.log.pop();
                await sleep(150); continue;
              }

              const exists = db.prepare('SELECT id FROM leads WHERE name=? AND city=?').get(d.name, city);
              if (exists) {
                job.log.unshift({ t: 'skip', m: `↷ Already saved: ${d.name}` });
                if (job.log.length > 120) job.log.pop();
                continue;
              }

              let photoUrl = '';
              if (d.photos?.[0]) photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=120&photo_reference=${d.photos[0].photo_reference}&key=${apiKey}`;

              db.prepare(`INSERT INTO leads (name,phone,address,city,country,category,description,google_rating,google_reviews,photo_url,stage) VALUES (?,?,?,?,?,?,?,?,?,?,'new')`)
                .run(d.name, d.formatted_phone_number||'', d.formatted_address||'', city,
                     country.toLowerCase(), cat, d.editorial_summary?.overview||'',
                     d.rating||0, d.user_ratings_total||0, photoUrl);

              job.found++;
              job.log.unshift({ t: 'found', m: `✓ SAVED: ${d.name} — ${city} (${job.found}/${target})` });
              if (job.log.length > 120) job.log.pop();
            } catch(e) { /* skip failed detail */ }
            await sleep(250);
          }
          await sleep(600);
        }
      }
    } catch(e) { job.log.unshift({ t: 'err', m: `Error: ${e.message}` }); }

    job.status = job.status === 'stopped' ? 'stopped' : 'done';
    job.log.unshift({ t: 'done', m: `✅ Done! ${job.found} leads saved · ${job.skipped} skipped.` });
  })();
});

app.get('/api/scrape/progress/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.post('/api/scrape/stop', (req, res) => {
  const { jobId } = req.body;
  if (jobs[jobId]) jobs[jobId].status = 'stopped';
  res.json({ success: true });
});

// ── LEADS ──────────────────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  const { country, category, stage, search, limit = 500 } = req.query;
  let q = 'SELECT * FROM leads WHERE 1=1';
  const p = [];
  if (country) { q += ' AND country=?'; p.push(country); }
  if (category) { q += ' AND category LIKE ?'; p.push(`%${category}%`); }
  if (stage) { q += ' AND stage=?'; p.push(stage); }
  if (search) { q += ' AND (name LIKE ? OR city LIKE ? OR phone LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`); }
  q += ` ORDER BY CASE stage WHEN 'hot' THEN 1 WHEN 'negotiation' THEN 2 WHEN 'responded' THEN 3 WHEN 'demo' THEN 4 WHEN 'contacted' THEN 5 WHEN 'new' THEN 6 WHEN 'closed' THEN 7 ELSE 8 END, updated_at DESC LIMIT ?`;
  p.push(parseInt(limit));
  const leads = db.prepare(q).all(...p);
  const total = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  res.json({ leads, total });
});

app.get('/api/leads/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  lead.messages = db.prepare('SELECT * FROM messages WHERE lead_id=? ORDER BY sent_at ASC').all(req.params.id);
  lead.calls = db.prepare('SELECT * FROM calls WHERE lead_id=? ORDER BY called_at DESC').all(req.params.id);
  res.json(lead);
});

app.patch('/api/leads/:id', (req, res) => {
  const allowed = ['stage','call_outcome','last_contacted','email','phone','notes','ai_analysis','owner_name'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.json({ success: true });
  const sql = updates.map(([k]) => `${k}=?`).join(',');
  const vals = updates.map(([,v]) => v);
  db.prepare(`UPDATE leads SET ${sql}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...vals, req.params.id);
  res.json({ success: true });
});

app.delete('/api/leads/:id', (req, res) => {
  db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── MESSAGES ──────────────────────────────────────────────────────
app.post('/api/leads/:id/message', (req, res) => {
  const { channel, content } = req.body;
  db.prepare('INSERT INTO messages (lead_id,channel,direction,content) VALUES (?,?,?,?)').run(req.params.id, channel||'whatsapp', 'out', content);
  db.prepare('UPDATE leads SET last_contacted=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── CALLS ──────────────────────────────────────────────────────────
app.get('/api/calls', (req, res) => {
  const calls = db.prepare(`SELECT c.*, l.name as lead_name FROM calls c LEFT JOIN leads l ON c.lead_id=l.id ORDER BY c.called_at DESC LIMIT 60`).all();
  res.json(calls);
});

app.post('/api/calls', (req, res) => {
  const { caller, business_name, outcome, price_discussed, summary, lead_id } = req.body;
  let lid = lead_id || null;
  if (!lid && business_name) {
    const lead = db.prepare('SELECT id FROM leads WHERE name LIKE ? LIMIT 1').get(`%${business_name}%`);
    if (lead) lid = lead.id;
  }
  db.prepare('INSERT INTO calls (lead_id,business_name,caller,outcome,price_discussed,summary) VALUES (?,?,?,?,?,?)')
    .run(lid, business_name||'', caller||'Bamba', outcome||'called', price_discussed||0, summary||'');
  if (lid) {
    const stageMap = { interested:'hot', closed:'closed', notinterested:'lost', noanswer:'contacted', called:'contacted', callback:'contacted' };
    const s = stageMap[outcome];
    if (s) db.prepare('UPDATE leads SET stage=?,call_outcome=?,last_contacted=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(s, outcome, lid);
  }
  res.json({ success: true });
});

// ── STATS ──────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const g = (sql, ...p) => db.prepare(sql).get(...p);
  const pipeline = {};
  for (const s of ['new','contacted','responded','hot','negotiation','demo','closed','lost'])
    pipeline[s] = g('SELECT COUNT(*) as c FROM leads WHERE stage=?', s).c;

  res.json({
    leads: {
      today:     g("SELECT COUNT(*) as c FROM leads WHERE date(created_at)=date('now')").c,
      week:      g("SELECT COUNT(*) as c FROM leads WHERE created_at>=datetime('now','-7 days')").c,
      contacted: g("SELECT COUNT(*) as c FROM leads WHERE stage!='new'").c,
      total:     g('SELECT COUNT(*) as c FROM leads').c
    },
    revenue: {
      today: g("SELECT COALESCE(SUM(amount),0) as t FROM revenue WHERE date(closed_at)=date('now')").t,
      week:  g("SELECT COALESCE(SUM(amount),0) as t FROM revenue WHERE closed_at>=datetime('now','-7 days')").t,
      month: g("SELECT COALESCE(SUM(amount),0) as t FROM revenue WHERE strftime('%Y-%m',closed_at)=strftime('%Y-%m','now')").t,
    },
    activity: {
      calls:    g("SELECT COUNT(*) as c FROM calls WHERE date(called_at)=date('now')").c,
      emails:   g("SELECT COUNT(*) as c FROM messages WHERE channel='email' AND date(sent_at)=date('now')").c,
      whatsapps:g("SELECT COUNT(*) as c FROM messages WHERE channel='whatsapp' AND date(sent_at)=date('now')").c,
    },
    pipeline
  });
});

// ── MARKETS ────────────────────────────────────────────────────────
app.get('/api/markets/times', (req, res) => {
  const out = {};
  Object.entries(MARKETS).forEach(([k, m]) => {
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: m.tz }));
    const h = local.getHours(), day = local.getDay();
    const isWeekend = day===0||day===6;
    const isBusinessHours = h>=8&&h<18;
    out[k] = {
      flag: m.flag, name: m.name,
      localTime: local.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}),
      localDate: local.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}),
      hour: h, isWeekend, isBusinessHours
    };
  });
  res.json(out);
});

// ── AI ─────────────────────────────────────────────────────────────
app.post('/api/ai/chat', async (req, res) => {
  const { messages, context } = req.body;
  try {
    const r = await ai.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 800,
      system: context || 'You are Webigo — a sharp, direct AI sales assistant for a web design agency targeting local businesses with no website. Be tactical, motivating, and practical. Help close deals today.',
      messages
    });
    res.json({ reply: r.content[0].text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/suggest-reply', async (req, res) => {
  const { leadId, channel } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ai.messages.create({ model:'claude-sonnet-4-6', max_tokens:300, messages:[{ role:'user', content:`Write a short ${channel||'WhatsApp'} follow-up message for ${lead.name} (${lead.category} in ${lead.city}). Stage: ${lead.stage}. Goal: book a free website demo. 2-3 sentences max. Natural, not salesy.` }] });
    res.json({ suggestion: r.content[0].text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/analyze-lead', async (req, res) => {
  const { leadId } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ai.messages.create({ model:'claude-sonnet-4-6', max_tokens:500, messages:[{ role:'user', content:`Analyze this lead: ${lead.name} (${lead.category}, ${lead.city} ${lead.country}). Reviews: ${lead.google_reviews} × ${lead.google_rating}★. Stage: ${lead.stage}. Last contact: ${lead.last_contacted||'never'}.\n\nGive: 1) temperature (cold/warm/hot/ready), 2) key insight about this type of business, 3) single best next action, 4) one-line message to open with. Be direct and tactical.` }] });
    const analysis = r.content[0].text;
    db.prepare('UPDATE leads SET ai_analysis=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(analysis, leadId);
    res.json({ analysis });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/warmup-questions', async (req, res) => {
  const { leadId } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ai.messages.create({ model:'claude-sonnet-4-6', max_tokens:400, messages:[{ role:'user', content:`Give 5 short qualifying questions to ask ${lead.name} (${lead.category} in ${lead.city}) that naturally lead to realizing they need a website. Numbered list only.` }] });
    const qs = r.content[0].text.split('\n').filter(l=>/^\d/.test(l.trim())).map(l=>l.replace(/^\d+\.\s*/,''));
    res.json({ questions: qs.length ? qs : [r.content[0].text] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/video/generate-prompt', async (req, res) => {
  const { leadId, businessName } = req.body;
  const lead = leadId ? db.prepare('SELECT * FROM leads WHERE id=?').get(leadId) : null;
  const name = lead?.name || businessName || 'Local Business';
  const cat = lead?.category || 'Business';
  const city = lead?.city || '';
  try {
    const r = await ai.messages.create({ model:'claude-sonnet-4-6', max_tokens:300, messages:[{ role:'user', content:`Write a short openclaw video prompt for a professional demo website video for: ${name} (${cat}${city?' in '+city:''}). 2-3 sentences. Focus on professionalism, local trust, and a clear CTA.` }] });
    res.json({ primary: r.content[0].text, secondary: `Clean modern ${cat} website for ${name}. Mobile-first, trust-building, with contact form and map.`, openclaw_url: 'https://openclaw.unloopa.com' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TODOS ──────────────────────────────────────────────────────────
app.get('/api/todos', (req, res) => {
  res.json(db.prepare(`SELECT t.*,l.name as lead_name FROM todos t LEFT JOIN leads l ON t.lead_id=l.id WHERE t.completed=0 ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.created_at ASC`).all());
});

app.post('/api/todos', (req, res) => {
  const { title, priority, lead_id } = req.body;
  db.prepare('INSERT INTO todos (title,priority,lead_id) VALUES (?,?,?)').run(title, priority||'medium', lead_id||null);
  res.json({ success: true });
});

app.patch('/api/todos/:id', (req, res) => {
  db.prepare('UPDATE todos SET completed=? WHERE id=?').run(req.body.completed?1:0, req.params.id);
  res.json({ success: true });
});

app.post('/api/todos/generate', async (req, res) => {
  const hot = db.prepare("SELECT name FROM leads WHERE stage IN ('hot','negotiation') LIMIT 5").all().map(l=>l.name);
  const noContact = db.prepare("SELECT name FROM leads WHERE stage='contacted' AND (last_contacted IS NULL OR datetime(last_contacted)<datetime('now','-3 days')) LIMIT 5").all().map(l=>l.name);
  try {
    const r = await ai.messages.create({ model:'claude-sonnet-4-6', max_tokens:400, messages:[{ role:'user', content:`Daily to-do list for a web design sales rep.\nHot leads: ${hot.join(', ')||'none'}\nNeeds follow-up: ${noContact.join(', ')||'none'}\n\nReturn exactly 6 todos as JSON array: [{title,priority:"urgent"|"high"|"medium"}]. JSON only, no markdown.` }] });
    let todos;
    try { todos = JSON.parse(r.content[0].text.replace(/```json|```/g,'').trim()); } catch { todos = [{title:'Call hot leads now',priority:'urgent'},{title:'Follow up no-answers',priority:'high'},{title:'Run scraper — 50 new leads',priority:'high'},{title:'Send demo videos',priority:'medium'},{title:'Update pipeline stages',priority:'medium'},{title:'Reply to messages',priority:'medium'}]; }
    db.prepare('DELETE FROM todos WHERE completed=0').run();
    for (const t of todos) db.prepare('INSERT INTO todos (title,priority) VALUES (?,?)').run(t.title, t.priority||'medium');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SERVE ──────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Webigo v3 running on port ${PORT}`));
