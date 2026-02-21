export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let query;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    query = body.query;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const SERP_KEY = process.env.SERPAPI_KEY;
  if (!SERP_KEY) return res.status(500).json({ error: 'SERPAPI_KEY not set' });
  if (!query) return res.status(400).json({ error: 'No search query' });

  try {
    const params = new URLSearchParams({
      engine: 'google_shopping',
      q: query,
      api_key: SERP_KEY,
      num: 10,
      gl: 'us',
      hl: 'en'
    });

    const response = await fetch('https://serpapi.com/search.json?' + params.toString());
    
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: 'SerpApi error ' + response.status, details: err.substring(0, 300) });
    }

    const data = await response.json();
    const shopping = data.shopping_results || [];
    
    const results = shopping.slice(0, 8).map(r => {
      // Try to get the best direct link to the product
      // SerpApi provides several link fields:
      // - product_link: usually the direct retailer URL (best)
      // - link: sometimes a Google redirect
      // - source_link: another option
      
      let bestLink = '';
      
      // Prefer product_link as it's usually the direct retailer URL
      if (r.product_link && !r.product_link.includes('google.com/aclk')) {
        bestLink = r.product_link;
      } else if (r.link && !r.link.includes('google.com/aclk')) {
        bestLink = r.link;
      } else if (r.source_link) {
        bestLink = r.source_link;
      } else {
        // Fall back to a Google Shopping search for this specific product
        bestLink = 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(r.title || query);
      }

      // Extract price - try multiple fields
      let price = 0;
      if (r.extracted_price && typeof r.extracted_price === 'number') {
        price = r.extracted_price;
      } else if (r.price) {
        const match = String(r.price).match(/[\d,.]+/);
        if (match) price = parseFloat(match[0].replace(',', ''));
      }

      return {
        title: r.title || '',
        price: price,
        source: r.source || '',
        link: bestLink,
        thumbnail: r.thumbnail || '',
        rating: r.rating || null,
        reviews: r.reviews || null
      };
    });

    // Filter out results with no usable link
    const filtered = results.filter(r => r.link && r.title);

    return res.status(200).json({ results: filtered });
  } catch (err) {
    return res.status(500).json({ error: 'Search failed: ' + err.message });
  }
}
