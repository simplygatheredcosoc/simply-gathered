// Vercel Serverless Function: /api/search
// Searches Google Shopping via SerpApi for product matches

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { query } = req.body;
  const SERP_KEY = process.env.SERPAPI_KEY;

  if (!SERP_KEY) return res.status(500).json({ error: 'SerpApi key not configured' });
  if (!query) return res.status(400).json({ error: 'No search query' });

  try {
    const params = new URLSearchParams({
      engine: 'google_shopping',
      q: query,
      api_key: SERP_KEY,
      num: 8,
      gl: 'us',
      hl: 'en'
    });

    const response = await fetch('https://serpapi.com/search.json?' + params.toString());
    
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: 'SerpApi error', details: err });
    }

    const data = await response.json();
    
    const results = (data.shopping_results || []).slice(0, 8).map(r => ({
      title: r.title || '',
      price: r.extracted_price || parseFloat((r.price || '0').replace(/[^0-9.]/g, '')) || 0,
      source: r.source || '',
      link: r.link || r.product_link || '',
      thumbnail: r.thumbnail || '',
      rating: r.rating || null,
      reviews: r.reviews || null
    }));

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: 'Search failed', message: err.message });
  }
}
