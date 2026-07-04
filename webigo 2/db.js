const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    uuid VARCHAR(36) UNIQUE NOT NULL,
    name VARCHAR(255),
    phone VARCHAR(100),
    email VARCHAR(255),
    address TEXT,
    city VARCHAR(255),
    country VARCHAR(100),
    category VARCHAR(255),
    description TEXT,
    years_operating VARCHAR(100),
    price_range VARCHAR(100),
    services TEXT,
    google_rating DECIMAL(3,1),
    google_reviews INTEGER,
    website VARCHAR(500),
    has_website BOOLEAN DEFAULT false,
    facebook_url VARCHAR(500),
    facebook_followers INTEGER,
    instagram_url VARCHAR(500),
    instagram_followers INTEGER,
    twitter_url VARCHAR(500),
    twitter_followers INTEGER,
    owner_name VARCHAR(255),
    revenue_estimate VARCHAR(255),
    is_recurring_model BOOLEAN DEFAULT false,
    business_model VARCHAR(100),
    stage VARCHAR(100) DEFAULT 'new',
    priority INTEGER DEFAULT 0,
    temperature VARCHAR(50) DEFAULT 'cold',
    assigned_to VARCHAR(100),
    last_contacted TIMESTAMP,
    last_reply TIMESTAMP,
    opened_message BOOLEAN DEFAULT false,
    notes TEXT,
    qualifying_questions TEXT,
    ai_analysis TEXT,
    price_discussed DECIMAL(10,2),
    deal_value DECIMAL(10,2),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id),
    channel VARCHAR(50),
    direction VARCHAR(10),
    content TEXT,
    status VARCHAR(50) DEFAULT 'sent',
    sent_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS calls (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id),
    caller VARCHAR(100),
    duration_seconds INTEGER,
    price_discussed DECIMAL(10,2),
    outcome VARCHAR(100),
    summary TEXT,
    transcript TEXT,
    ai_coaching TEXT,
    recording_url VARCHAR(500),
    called_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS todos (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id),
    title VARCHAR(500) NOT NULL,
    description TEXT,
    priority VARCHAR(50) DEFAULT 'medium',
    type VARCHAR(100) DEFAULT 'general',
    due_date DATE,
    completed BOOLEAN DEFAULT false,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS revenue (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id),
    amount DECIMAL(10,2),
    description VARCHAR(255),
    recorded_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS scrape_sessions (
    id SERIAL PRIMARY KEY,
    country VARCHAR(100),
    category VARCHAR(255),
    city VARCHAR(255),
    leads_found INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'running',
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
  );
`;

async function initDB() {
  try {
    await pool.query(SCHEMA);
    console.log('✓ Database ready');
  } catch (err) {
    console.error('✗ Database init error:', err.message);
  }
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query, initDB };
