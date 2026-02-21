export const config = {
  api: {
    maxDuration: 90
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  const SERP_KEY = process.env.SERPAPI_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not set' });

  let budget, guests, eventType, style;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    budget = body.budget;
    guests = body.guests;
    eventType = body.eventType || 'dinner party';
    style = body.style || 'elegant';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!budget || !guests) return res.status(400).json({ error: 'Budget and guests required' });

  try {
    // Step 1: Claude creates a detailed shopping plan
    const planResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `You are a luxury event planner and personal shopper. Create a detailed, shoppable plan for:

Event: ${eventType}
Budget: $${budget}
Guests: ${guests}
Style: ${style}, high-end

Create a complete shopping list organized by category. For each item, recommend a SPECIFIC product from a high-end retailer with a realistic price that fits the budget.

Return ONLY valid JSON:
{
  "categories": [
    {
      "name": "Category Name",
      "percentage": 30,
      "color": "navy|green|blush|brass|rose",
      "items": [
        {
          "name": "Specific item (quantity if needed)",
          "product_name": "Exact product to search for",
          "store": "Retailer name",
          "price": 45,
          "search_query": "search query for Google Shopping",
          "priority": "essential|recommended|splurge"
        }
      ]
    }
  ],
  "tips": ["Pro tip 1", "Pro tip 2", "Pro tip 3"],
  "total_estimated": 480
}

RULES:
- Categories should be: Tableware, Linens, Florals & Candles, Ambiance & Decor, and Buffer/Extras
- Percentages must add to 100
- Prices must be realistic and total should stay within budget
- Quantities should match guest count (${guests} guests)
- Prioritize these stores: Anthropologie, Serena & Lily, McGee & Co, Pottery Barn, West Elm, Williams Sonoma, Target (Hearth & Hand / Threshold), Etsy, H&M Home, World Market, Terrain, Amazon (specific brands)
- Each category should have 2-5 items
- Include specific product names, not generic descriptions
- Return ONLY JSON`
        }]
      })
    });

    if (!planResponse.ok) {
      const err = await planResponse.text();
      return res.status(500).json({ error: 'Plan failed: ' + planResponse.status });
    }

    const planData = await planResponse.json();
    const planText = planData.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const plan = JSON.parse(planText);

    // Step 2: Search Google Shopping for top items to get real links and thumbnails
    if (SERP_KEY) {
      for (const cat of plan.categories) {
        for (const item of cat.items) {
          if (!item.search_query) continue;
          try {
            const params = new URLSearchParams({
              engine: 'google_shopping',
              q: item.search_query,
              api_key: SERP_KEY,
              num: 3,
              gl: 'us',
              hl: 'en'
            });
            const searchRes = await fetch('https://serpapi.com/search.json?' + params.toString());
            if (searchRes.ok) {
              const searchData = await searchRes.json();
              const results = searchData.shopping_results || [];
              if (results.length > 0) {
                const best = results[0];
                item.real_link = best.product_link || best.link || '';
                item.thumbnail = best.thumbnail || '';
                item.real_price = best.extracted_price || item.price;
                item.real_title = best.title || '';
              }
            }
          } catch (e) {
            // Skip, use fallback
          }
          // Small delay
          await new Promise(r => setTimeout(r, 150));
        }
      }
    }

    return res.status(200).json(plan);
  } catch (err) {
    return res.status(500).json({ error: 'Failed: ' + err.message });
  }
}
