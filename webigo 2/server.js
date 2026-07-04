require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const { query, initDB } = require('./db');
const {
  startScrapeJob,
  stopScrapeJob,
  getScrapeJobStatus,
  getAllScrapeJobs,
  COUNTRY_CONFIG,
  BUSINESS_CATEGORIES
} = require('./scraper');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE clients for real-time scrape progress ──────────────────────────────
const sseClients = new Set();

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch (_) { sseClients.delete(client); }
  }
}

// ── HEALTH ─────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0.0' }));

// ── SSE STREAM ─────────────────────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── DASHBOARD STATS ────────────────────────────────────────────────────────
app.get('/api/stats', async (_, res) => {
  try {
    const [leadsToday, leadsWeek, leadsMonth, contacted, calls, emails, whatsapps, revDay, revWeek, revMonth, stages] = await Promise.all([
      query(`SELECT COUNT(*) FROM leads WHERE created_at >= NOW() - INTERVAL '1 day'`),
      query(`SELECT COUNT(*) FROM leads WHERE created_at >= NOW() - INTERVAL '7 days'`),
      query(`SELECT COUNT(*) FROM leads WHERE created_at >= NOW() - INTERVAL '30 days'`),
      query(`SELECT COUNT(*) FROM leads WHERE last_contacted IS NOT NULL`),
      query(`SELECT COUNT(*) FROM calls WHERE called_at >= NOW() - INTERVAL '1 day'`),
      query(`SELECT COUNT(*) FROM messages WHERE channel='email' AND sent_at >= NOW() - INTERVAL '1 day'`),
      query(`SELECT COUNT(*) FROM messages WHERE channel='whatsapp' AND sent_at >= NOW() - INTERVAL '1 day'`),
      query(`SELECT COALESCE(SUM(amount),0) AS total FROM revenue WHERE recorded_at >= NOW() - INTERVAL '1 day'`),
      query(`SELECT COALESCE(SUM(amount),0) AS total FROM revenue WHERE recorded_at >= NOW() - INTERVAL '7 days'`),
      query(`SELECT COALESCE(SUM(amount),0) AS total FROM revenue WHERE recorded_at >= NOW() - INTERVAL '30 days'`),
      query(`SELECT stage, COUNT(*) FROM leads GROUP BY stage`)
    ]);

    const stageMap = {};
    for (const row of stages.rows) stageMap[row.stage] = parseInt(row.count);

    res.json({
      leads: {
        today: parseInt(leadsToday.rows[0].count),
        week: parseInt(leadsWeek.rows[0].count),
        month: parseInt(leadsMonth.rows[0].count),
        contacted: parseInt(contacted.rows[0].count)
      },
      activity: {
        calls: parseInt(calls.rows[0].count),
        emails: parseInt(emails.rows[0].count),
        whatsapps: parseInt(whatsapps.rows[0].count)
      },
      revenue: {
        today: parseFloat(revDay.rows[0].total),
        week: parseFloat(revWeek.rows[0].total),
        month: parseFloat(revMonth.rows[0].total)
      },
      pipeline: stageMap
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LEADS ──────────────────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  try {
    const { country, category, stage, search, limit = 100, offset = 0 } = req.query;
    let where = ['1=1'];
    const params = [];
    let p = 1;

    if (country) { where.push(`LOWER(country) = LOWER($${p++})`); params.push(country); }
    if (category) { where.push(`LOWER(category) LIKE LOWER($${p++})`); params.push(`%${category}%`); }
    if (stage) { where.push(`stage = $${p++}`); params.push(stage); }
    if (search) {
      where.push(`(name ILIKE $${p} OR phone ILIKE $${p} OR city ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }

    const result = await query(`
      SELECT * FROM leads
      WHERE ${where.join(' AND ')}
      ORDER BY priority DESC, last_reply DESC NULLS LAST, last_contacted DESC NULLS LAST, created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `, [...params, limit, offset]);

    const total = await query(`SELECT COUNT(*) FROM leads WHERE ${where.join(' AND ')}`, params);

    res.json({ leads: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id', async (req, res) => {
  try {
    const lead = await query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Not found' });

    const messages = await query('SELECT * FROM messages WHERE lead_id = $1 ORDER BY sent_at ASC', [req.params.id]);
    const calls = await query('SELECT * FROM calls WHERE lead_id = $1 ORDER BY called_at DESC', [req.params.id]);
    const todos = await query('SELECT * FROM todos WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.id]);

    res.json({ ...lead.rows[0], messages: messages.rows, calls: calls.rows, todos: todos.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/leads/:id', async (req, res) => {
  try {
    const allowed = ['stage','temperature','priority','notes','assigned_to','owner_name','email','price_discussed','deal_value'];
    const updates = [];
    const params = [];
    let p = 1;

    for (const [key, val] of Object.entries(req.body)) {
      if (allowed.includes(key)) {
        updates.push(`${key} = $${p++}`);
        params.push(val);
      }
    }
    if (!updates.length) return res.json({ ok: true });

    updates.push(`updated_at = NOW()`);
    params.push(req.params.id);
    await query(`UPDATE leads SET ${updates.join(', ')} WHERE id = $${p}`, params);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    await query('DELETE FROM leads WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MESSAGES ───────────────────────────────────────────────────────────────
app.post('/api/leads/:id/message', async (req, res) => {
  try {
    const { channel, content } = req.body;
    const lead = await query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found' });

    await query(`INSERT INTO messages (lead_id, channel, direction, content) VALUES ($1,$2,'out',$3)`,
      [req.params.id, channel, content]);

    await query(`UPDATE leads SET last_contacted = NOW(), updated_at = NOW() WHERE id = $1`, [req.params.id]);

    if (lead.rows[0].stage === 'new') {
      await query(`UPDATE leads SET stage = 'contacted', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CALLS ──────────────────────────────────────────────────────────────────
app.get('/api/calls', async (_, res) => {
  try {
    const result = await query(`
      SELECT c.*, l.name as lead_name, l.category, l.city, l.country
      FROM calls c LEFT JOIN leads l ON c.lead_id = l.id
      ORDER BY c.called_at DESC LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calls', async (req, res) => {
  try {
    const { lead_id, caller, duration_seconds, price_discussed, outcome, summary } = req.body;
    const result = await query(`
      INSERT INTO calls (lead_id, caller, duration_seconds, price_discussed, outcome, summary)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
    `, [lead_id, caller, duration_seconds, price_discussed, outcome, summary]);

    if (price_discussed) {
      await query(`UPDATE leads SET price_discussed = $1, updated_at = NOW() WHERE id = $2`, [price_discussed, lead_id]);
    }

    if (outcome === 'closed') {
      await query(`UPDATE leads SET stage = 'closed', updated_at = NOW() WHERE id = $1`, [lead_id]);
      await generateClosedTodos(lead_id);
    }

    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TO-DO ──────────────────────────────────────────────────────────────────
app.get('/api/todos', async (req, res) => {
  try {
    const { completed } = req.query;
    const filter = completed === 'true' ? 'completed = true' : 'completed = false';
    const result = await query(`
      SELECT t.*, l.name as lead_name, l.stage as lead_stage
      FROM todos t LEFT JOIN leads l ON t.lead_id = l.id
      WHERE ${filter}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        due_date ASC NULLS LAST, created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/todos', async (req, res) => {
  try {
    const { lead_id, title, description, priority, type, due_date } = req.body;
    const result = await query(`
      INSERT INTO todos (lead_id, title, description, priority, type, due_date)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
    `, [lead_id, title, description, priority || 'medium', type || 'general', due_date || null]);
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/todos/:id', async (req, res) => {
  try {
    const { completed } = req.body;
    if (completed !== undefined) {
      await query(`UPDATE todos SET completed = $1, completed_at = $2 WHERE id = $3`,
        [completed, completed ? new Date() : null, req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function generateClosedTodos(leadId) {
  const items = [
    ['Send welcome email to client', 'Send the welcome email with overview of next steps', 'urgent', 'fulfillment'],
    ['Send legal documents', 'Send service agreement and terms to client email', 'urgent', 'fulfillment'],
    ['Confirm payment received', 'Verify payment has cleared before starting work', 'urgent', 'fulfillment'],
    ['Purchase domain', 'Buy the domain name for the client via Namecheap or GoDaddy', 'high', 'fulfillment'],
    ['Set up hosting', 'Deploy hosting on Vercel or Railway, configure DNS', 'high', 'fulfillment'],
    ['Build demo website', 'Create the website based on business category and requirements', 'high', 'fulfillment'],
    ['Send demo for client approval', 'Send demo link and request feedback within 48 hours', 'high', 'fulfillment'],
    ['Handle change requests', 'Implement any requested changes from the client', 'medium', 'fulfillment'],
    ['Deliver final website', 'Point domain to live site, confirm everything works', 'high', 'fulfillment'],
    ['Send domain access email', 'Email client their domain login credentials and rights doc', 'medium', 'fulfillment'],
    ['Request Google review', 'Ask client to leave a Google review once satisfied', 'low', 'followup']
  ];

  for (const [title, desc, priority, type] of items) {
    await query(`INSERT INTO todos (lead_id, title, description, priority, type) VALUES ($1,$2,$3,$4,$5)`,
      [leadId, title, desc, priority, type]);
  }
}

// ── REVENUE ────────────────────────────────────────────────────────────────
app.post('/api/revenue', async (req, res) => {
  try {
    const { lead_id, amount, description } = req.body;
    await query(`INSERT INTO revenue (lead_id, amount, description) VALUES ($1,$2,$3)`, [lead_id, amount, description]);
    if (lead_id) await query(`UPDATE leads SET deal_value = $1, stage = 'closed', updated_at = NOW() WHERE id = $2`, [amount, lead_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SCRAPER ────────────────────────────────────────────────────────────────
app.post('/api/scrape/start', async (req, res) => {
  try {
    const { country, category, targetCount = 50 } = req.body;
    if (!country || !category) return res.status(400).json({ error: 'country and category required' });

    const jobId = uuidv4();

    res.json({ jobId, status: 'started' });

    startScrapeJob(jobId, country, category, targetCount, (progress) => {
      broadcastSSE({ type: 'scrape_progress', ...progress });
    }).catch(err => {
      broadcastSSE({ type: 'scrape_error', jobId, error: err.message });
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scrape/stop', (req, res) => {
  const { jobId } = req.body;
  stopScrapeJob(jobId);
  res.json({ ok: true });
});

app.get('/api/scrape/jobs', (_, res) => {
  res.json(getAllScrapeJobs());
});

app.get('/api/scrape/config', (_, res) => {
  res.json({ countries: Object.keys(COUNTRY_CONFIG), categories: BUSINESS_CATEGORIES });
});

// ── AI CHAT ────────────────────────────────────────────────────────────────
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.json({ reply: 'Anthropic API key not configured.' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You are Webigo's AI assistant. You help a web design agency that sells websites to local businesses.
You have access to their lead data and sales system. Be concise, direct, and actionable.
${context ? `Current context: ${JSON.stringify(context)}` : ''}`;

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }]
    });

    res.json({ reply: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/analyze-lead', async (req, res) => {
  try {
    const { leadId } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.json({ analysis: 'API key not configured.' });

    const lead = await query('SELECT * FROM leads WHERE id = $1', [leadId]);
    const messages = await query('SELECT * FROM messages WHERE lead_id = $1 ORDER BY sent_at ASC', [leadId]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Analyze this sales lead for a web design agency:
Business: ${lead.rows[0].name} (${lead.rows[0].category}) in ${lead.rows[0].city}, ${lead.rows[0].country}
Stage: ${lead.rows[0].stage} | Temperature: ${lead.rows[0].temperature}
Messages: ${messages.rows.length > 0 ? messages.rows.map(m => `[${m.direction}] ${m.content}`).join('\n') : 'No messages yet'}

Give me: 1) Temperature score (cold/warm/hot/ready to close) 2) What happened so far 3) Exact next action to take 4) Best channel to use. Be brief and direct.`
      }]
    });

    const analysis = response.content[0].text;
    await query(`UPDATE leads SET ai_analysis = $1, updated_at = NOW() WHERE id = $2`, [analysis, leadId]);
    res.json({ analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/suggest-reply', async (req, res) => {
  try {
    const { leadId, channel } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.json({ suggestion: 'API key not configured.' });

    const lead = await query('SELECT * FROM leads WHERE id = $1', [leadId]);
    const messages = await query('SELECT * FROM messages WHERE lead_id = $1 ORDER BY sent_at ASC LIMIT 20', [leadId]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Not found' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Write the next ${channel || 'message'} to send to this business owner.
Business: ${lead.rows[0].name} — ${lead.rows[0].category} in ${lead.rows[0].city}
Stage: ${lead.rows[0].stage}
Previous messages: ${messages.rows.map(m => `[${m.direction}] ${m.content}`).join('\n') || 'First contact'}

Rules: Be direct, outcome-focused, personalized to their business. Get a yes. No fluff. Max 3 sentences for WhatsApp/SMS, max 5 sentences for email.`
      }]
    });

    res.json({ suggestion: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/generate-todos', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: true });

    const hotLeads = await query(`SELECT * FROM leads WHERE stage IN ('hot','responded','contacted') ORDER BY priority DESC LIMIT 10`);
    const pendingTodos = await query(`SELECT COUNT(*) FROM todos WHERE completed = false`);

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Generate today's top 5 to-do items for a web design sales agency.
Hot leads: ${hotLeads.rows.map(l => `${l.name} (${l.stage})`).join(', ') || 'None yet'}
Pending tasks: ${pendingTodos.rows[0].count}

Return JSON array: [{"title":"...","description":"...","priority":"urgent|high|medium","type":"sales|fulfillment|followup"}]
Revenue first, urgency second. No extra text, just valid JSON.`
      }]
    });

    try {
      const todos = JSON.parse(response.content[0].text);
      for (const todo of todos) {
        await query(`INSERT INTO todos (title, description, priority, type) VALUES ($1,$2,$3,$4)`,
          [todo.title, todo.description, todo.priority, todo.type]);
      }
    } catch (_) {}

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── VIDEO PROMPT GENERATOR ─────────────────────────────────────────────────
app.post('/api/video/generate-prompt', async (req, res) => {
  try {
    const { leadId } = req.body;
    const lead = await query('SELECT * FROM leads WHERE id = $1', [leadId]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Not found' });

    const l = lead.rows[0];
    const lang = COUNTRY_CONFIG[l.country?.toLowerCase()]?.language || 'en';

    const primaryPrompt = `Create a professional demo website video for ${l.name}.
Business type: ${l.category}
Location: ${l.city}, ${l.country}
Services: ${l.services || l.category}
Style: Modern, clean, professional
Language: ${lang}
Include: Business name, services offered, contact section, call to action
Tone: Professional but approachable`;

    const secondaryPrompt = `Additional context for ${l.name} demo:
- Target customer: Local residents searching online
- Key message: "Now easy to find online"
- Highlight: Professional credibility, easy contact
- No website needed from client — we create everything
- Duration: 30-60 seconds
- End frame: Contact info + website URL placeholder`;

    res.json({ primary: primaryPrompt, secondary: secondaryPrompt, openclaw_url: 'https://openclaw.unloopa.com/free-prompt' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MARKET TIMES ───────────────────────────────────────────────────────────
app.get('/api/markets/times', (_, res) => {
  const markets = {
    sweden:    { tz: 'Europe/Stockholm',  flag: '🇸🇪', currency: 'SEK' },
    uk:        { tz: 'Europe/London',     flag: '🇬🇧', currency: 'GBP' },
    us:        { tz: 'America/New_York',  flag: '🇺🇸', currency: 'USD' },
    australia: { tz: 'Australia/Sydney',  flag: '🇦🇺', currency: 'AUD' },
    canada:    { tz: 'America/Toronto',   flag: '🇨🇦', currency: 'CAD' },
    norway:    { tz: 'Europe/Oslo',       flag: '🇳🇴', currency: 'NOK' },
    finland:   { tz: 'Europe/Helsinki',   flag: '🇫🇮', currency: 'EUR' },
    denmark:   { tz: 'Europe/Copenhagen', flag: '🇩🇰', currency: 'DKK' }
  };

  const now = new Date();
  const result = {};

  for (const [market, config] of Object.entries(markets)) {
    const local = new Date(now.toLocaleString('en-US', { timeZone: config.tz }));
    const hour = local.getHours();
    const isBusinessHours = hour >= 8 && hour < 18;
    const isWeekend = [0, 6].includes(local.getDay());

    result[market] = {
      ...config,
      localTime: local.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      localDate: local.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      isBusinessHours: isBusinessHours && !isWeekend,
      isWeekend,
      hour
    };
  }

  res.json(result);
});

// ── SALES SCRIPTS ──────────────────────────────────────────────────────────
app.get('/api/scripts', (_, res) => {
  res.json({
    call: {
      title: 'Cold Call Masterclass',
      wisdom: [
        'Mention VALUE before you mention PRICE. Always.',
        'Get 3 yeses in the first 60 seconds. Ask easy questions first.',
        'Use their business name in the first sentence. People respond to their own name.',
        'Explain what they are leaving on the table — customers searching online and not finding them.',
        'Make it risk free: they don\'t pay unless they want to use the website.',
        'Use humor early. One small joke relaxes the call in the first 30 seconds.',
        'When they go quiet — let them. Silence is not your enemy.',
        'Always end with a clear next step. Never leave a call open-ended.'
      ],
      script: `Opening (0-15 sec): "Hi, is this [Name]? Great — I\'m [Your Name], calling quickly about [Business Name]. Do you have 2 minutes?"

Warm up (15-60 sec): "I came across your business on Google and I noticed you don\'t have a website yet. Quick question — are most of your customers coming through word of mouth right now?"
[Let them answer]

Yes ladder (60-120 sec): "So if a new customer searched for [category] in [city] tonight, they probably wouldn\'t find you, right? And that\'s probably costing you bookings every week without you even knowing it?"

Value reveal (120-180 sec): "What we do is build professional websites for businesses like yours — and we actually build the site first, show it to you, and you only pay if you love it. Zero risk on your end."

Handle objections: "I understand — most business owners think they\'re too busy. That\'s exactly why we handle everything. You don\'t do anything except approve the final result."

Close: "What I\'d suggest is this — I send you a quick demo video of what your website could look like. Takes 2 minutes to watch. Would that be okay?"`
    },
    whatsapp: {
      title: 'WhatsApp Sequence',
      messages: [
        'Message 1 (Day 1): "Hi [Name], I came across [Business] on Google. I noticed you don\'t have a website yet — I\'d love to show you what one could do for your business. Can I send you a quick demo? Takes 2 minutes."',
        'Message 2 (Day 3 if no reply): "Hey [Name] — quick follow up. I built a sample website for a [category] business similar to yours. Mind if I send it over so you can see what it could look like for [Business]?"',
        'Message 3 (Day 7 if no reply): "Last message from me — I have a demo ready for [Business]. You only pay if you love it. Want to take a look?"'
      ]
    },
    email: {
      title: 'Email Sequence',
      subjects: [
        'Your competitors are online. [Business] isn\'t. Yet.',
        'I built something for [Business] — want to see it?',
        'Quick question about [Business]'
      ],
      body: `Hi [Name],

I found [Business] on Google while looking for [category] in [City].

You don\'t have a website yet — which means every time someone searches for what you offer, they find your competitors instead of you.

I\'d like to change that.

Here\'s the deal: I build the website first. You review it. You only pay if you love it.

[Watch a 60-second demo here]

Worth 2 minutes?

— [Your Name]`
    }
  });
});

// ── GENERATE WARM-UP QUESTIONS ─────────────────────────────────────────────
app.post('/api/ai/warmup-questions', async (req, res) => {
  try {
    const { leadId } = req.body;
    const lead = await query('SELECT * FROM leads WHERE id = $1', [leadId]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Not found' });

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({ questions: JSON.parse(lead.rows[0].qualifying_questions || '[]') });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Generate 5 qualifying questions for a sales call with the owner of ${lead.rows[0].name}, a ${lead.rows[0].category} in ${lead.rows[0].city}.
These questions should:
1. Start very easy (high yes probability)
2. Build commitment progressively
3. Establish the pain (no website = lost customers)
4. Lead naturally toward wanting our solution
Return as JSON array of strings only. No other text.`
      }]
    });

    const questions = JSON.parse(response.content[0].text);
    await query(`UPDATE leads SET qualifying_questions = $1 WHERE id = $2`, [JSON.stringify(questions), leadId]);
    res.json({ questions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CRON: Daily to-do generation at 7am ────────────────────────────────────
cron.schedule('0 7 * * *', async () => {
  try {
    await fetch(`http://localhost:${PORT}/api/ai/generate-todos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    console.log('✓ Daily to-dos generated');
  } catch (_) {}
});

// ── CATCH ALL → frontend ───────────────────────────────────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  await initDB();
  app.listen(PORT, () => console.log(`✓ Webigo running on port ${PORT}`));
}

start();
