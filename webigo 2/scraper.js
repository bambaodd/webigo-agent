const axios = require('axios');
const { query } = require('./db');
const { v4: uuidv4 } = require('uuid');

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

const BUSINESS_CATEGORIES = [
  'restaurant', 'cafe', 'bar', 'salon', 'barbershop', 'beauty salon',
  'gym', 'fitness studio', 'yoga studio', 'plumber', 'electrician',
  'accountant', 'lawyer', 'consultant', 'retail shop', 'boutique',
  'cleaning service', 'landscaping', 'dental clinic', 'physiotherapy',
  'auto repair', 'car service', 'medical clinic', 'pharmacy'
];

const COUNTRY_CONFIG = {
  sweden:    { code: 'SE', language: 'sv', cities: ['Stockholm','Gothenburg','Malmö','Uppsala','Västerås','Örebro','Linköping','Helsingborg','Jönköping','Norrköping'], currency: 'SEK' },
  uk:        { code: 'GB', language: 'en', cities: ['London','Manchester','Birmingham','Leeds','Glasgow','Sheffield','Bradford','Liverpool','Edinburgh','Bristol'], currency: 'GBP' },
  us:        { code: 'US', language: 'en', cities: ['New York','Los Angeles','Chicago','Houston','Phoenix','Philadelphia','San Antonio','San Diego','Dallas','San Jose'], currency: 'USD' },
  australia: { code: 'AU', language: 'en', cities: ['Sydney','Melbourne','Brisbane','Perth','Adelaide','Gold Coast','Canberra','Newcastle','Wollongong','Sunshine Coast'], currency: 'AUD' },
  canada:    { code: 'CA', language: 'en', cities: ['Toronto','Vancouver','Montreal','Calgary','Edmonton','Ottawa','Winnipeg','Quebec City','Hamilton','Kitchener'], currency: 'CAD' },
  norway:    { code: 'NO', language: 'no', cities: ['Oslo','Bergen','Trondheim','Stavanger','Drammen','Fredrikstad','Kristiansand','Sandnes','Tromsø','Sarpsborg'], currency: 'NOK' },
  finland:   { code: 'FI', language: 'fi', cities: ['Helsinki','Espoo','Tampere','Vantaa','Oulu','Turku','Jyväskylä','Lahti','Kuopio','Kouvola'], currency: 'EUR' },
  denmark:   { code: 'DK', language: 'da', cities: ['Copenhagen','Aarhus','Odense','Aalborg','Esbjerg','Randers','Kolding','Horsens','Vejle','Roskilde'], currency: 'DKK' }
};

// Active scrape jobs - single declaration
const scrapeJobs = new Map();

async function searchBusinesses(query_text, location, countryCode) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json`;
    const res = await axios.get(url, {
      params: {
        query: query_text,
        location,
        radius: 10000,
        region: countryCode.toLowerCase(),
        key: MAPS_KEY
      }
    });
    return res.data.results || [];
  } catch (err) {
    console.error('Maps search error:', err.message);
    return [];
  }
}

async function getPlaceDetails(placeId) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json`;
    const res = await axios.get(url, {
      params: {
        place_id: placeId,
        fields: 'name,formatted_phone_number,formatted_address,website,rating,user_ratings_total,opening_hours,business_status,price_level,types',
        key: MAPS_KEY
      }
    });
    return res.data.result || {};
  } catch (err) {
    return {};
  }
}

async function geocodeCity(city, countryCode) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json`;
    const res = await axios.get(url, {
      params: { address: `${city}, ${countryCode}`, key: MAPS_KEY }
    });
    const loc = res.data.results[0]?.geometry?.location;
    return loc ? `${loc.lat},${loc.lng}` : null;
  } catch (err) {
    return null;
  }
}

function hasNoWebsite(place) {
  return !place.website || place.website === '' || place.website === undefined;
}

function estimateYearsFromRatings(ratingCount) {
  if (!ratingCount) return 'Unknown';
  if (ratingCount > 500) return '5+ years';
  if (ratingCount > 200) return '3-5 years';
  if (ratingCount > 50) return '1-3 years';
  return 'Under 1 year';
}

function generateQualifyingQuestions(category, name) {
  const base = [
    `Do you currently get customers asking if ${name} has a website?`,
    `Would it help if new customers could find you easily on Google?`,
    `Are most of your new customers coming through word of mouth right now?`,
    `Have you thought about what a professional online presence could do for your bookings?`,
    `If a customer searched for ${category} in your city tonight, would they find you?`
  ];
  return base;
}

async function saveLead(placeData, details, country, category, city) {
  const existing = await query('SELECT id FROM leads WHERE phone = $1 OR name = $2 LIMIT 1',
    [details.formatted_phone_number || null, placeData.name]);

  if (existing.rows.length > 0) return null;

  const questions = generateQualifyingQuestions(category, placeData.name);

  const result = await query(`
    INSERT INTO leads (
      uuid, name, phone, address, city, country, category,
      google_rating, google_reviews, has_website, website,
      years_operating, stage, temperature, priority,
      qualifying_questions, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new','cold',0,$13,NOW(),NOW())
    ON CONFLICT (uuid) DO NOTHING
    RETURNING id
  `, [
    uuidv4(),
    placeData.name,
    details.formatted_phone_number || null,
    details.formatted_address || placeData.formatted_address || null,
    city,
    country,
    category,
    placeData.rating || null,
    placeData.user_ratings_total || 0,
    !!placeData.website,
    placeData.website || null,
    estimateYearsFromRatings(placeData.user_ratings_total),
    JSON.stringify(questions)
  ]);

  return result.rows[0]?.id || null;
}

async function startScrapeJob(jobId, country, category, targetCount, onProgress) {
  const config = COUNTRY_CONFIG[country.toLowerCase()];
  if (!config) throw new Error(`Unknown country: ${country}`);

  scrapeJobs.set(jobId, { status: 'running', found: 0, target: targetCount, country, category });

  let totalFound = 0;

  for (const city of config.cities) {
    if (totalFound >= targetCount) break;

    const job = scrapeJobs.get(jobId);
    if (!job || job.status === 'stopped') break;

    onProgress({ jobId, city, category, found: totalFound, target: targetCount, status: 'searching' });

    const location = await geocodeCity(city, config.code);
    if (!location) continue;

    const searchQuery = `${category} in ${city}`;
    const places = await searchBusinesses(searchQuery, location, config.code);

    for (const place of places) {
      if (totalFound >= targetCount) break;
      if (!hasNoWebsite(place)) continue;

      const details = await getPlaceDetails(place.place_id);
      const savedId = await saveLead(place, details, country, category, city);

      if (savedId) {
        totalFound++;
        scrapeJobs.set(jobId, { ...scrapeJobs.get(jobId), found: totalFound });
        onProgress({ jobId, city, category, found: totalFound, target: targetCount, status: 'found', leadName: place.name });
      }
    }
  }

  scrapeJobs.set(jobId, { ...scrapeJobs.get(jobId), status: 'completed', found: totalFound });
  onProgress({ jobId, found: totalFound, target: targetCount, status: 'completed' });

  return totalFound;
}

function stopScrapeJob(jobId) {
  const job = scrapeJobs.get(jobId);
  if (job) scrapeJobs.set(jobId, { ...job, status: 'stopped' });
}

function getScrapeJobStatus(jobId) {
  return scrapeJobs.get(jobId) || null;
}

function getAllScrapeJobs() {
  return Array.from(scrapeJobs.entries()).map(([id, job]) => ({ id, ...job }));
}

module.exports = {
  startScrapeJob,
  stopScrapeJob,
  getScrapeJobStatus,
  getAllScrapeJobs,
  COUNTRY_CONFIG,
  BUSINESS_CATEGORIES
};
