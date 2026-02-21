export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SERP_KEY = process.env.SERPAPI_KEY;
  if (!SERP_KEY) return res.status(500).json({ error: 'SERPAPI_KEY not set' });

  try {
    const body = req.body || {};
    const query = body.query;
    if (!query) return res.status(400).json({ error: 'No query' });

    const url = 'https://serpapi.com/search.json?engine=google_shopping&q=' + encodeURIComponent(query) + '&api_key=' + SERP_KEY + '&num=8&gl=us&hl=en';

    const response = await fetch(url);
    
    if (!response.ok) {
      return res.status(500).json({ error: 'SerpApi returned ' + response.status });
    }

    const data = await response.json();
    const shopping = data.shopping_results || [];
    
    var results = shopping.slice(0, 8).map(function(r) {
      var link = '';
      if (r.product_link) link = r.product_link;
      else if (r.link) link = r.link;
      else link = 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(r.title || query);

      var price = 0;
      if (typeof r.extracted_price === 'number') price = r.extracted_price;
      else if (r.price) {
        var m = String(r.price).match(/[\d,.]+/);
        if (m) price = parseFloat(m[0].replace(',', ''));
      }

      return {
        title: r.title || '',
        price: price,
        source: r.source || '',
        link: link,
        thumbnail: r.thumbnail || ''
      };
    });

    return res.status(200).json({ results: results });
  } catch (err) {
    return res.status(500).json({ error: 'Search failed: ' + err.message });
  }
}
