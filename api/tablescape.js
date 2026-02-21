export const config = {
  api: { maxDuration: 120 }
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

  let event, style, colors, guests, budget, notes, setting, meal;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    event = body.event || 'Dinner Party';
    style = body.style || 'Elegant';
    colors = body.colors || [];
    guests = body.guests || 8;
    budget = body.budget || 0;
    notes = body.notes || '';
    var setting = body.setting || 'Indoor';
    var meal = body.meal || 'Dinner';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid body' });
  }

  const colorNames = colors.map(function(c) { return c.n; }).join(', ');
  const colorHexes = colors.map(function(c) { return c.h; }).join(', ');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
          content: `You are an elite event designer and luxury personal shopper. Design a complete, shoppable tablescape.

EVENT: ${event}
SETTING: ${setting}
MEAL TYPE: ${meal}
STYLE: ${style}
COLOR PALETTE: ${colorNames} (${colorHexes})
GUESTS: ${guests}
${budget ? 'BUDGET: $' + budget : 'BUDGET: Flexible'}
${notes ? 'SPECIAL NOTES: ' + notes : ''}

Create a COMPLETE tablescape shopping list with SPECIFIC products from HIGH-END retailers. Every single item should be a real product you'd find at these stores.

Return ONLY valid JSON:
{
  "title": "Evocative name for this tablescape",
  "description": "2-3 sentences painting a beautiful picture of this tablescape — mood, light, textures, how guests will feel when they sit down.",
  "categories": [
    {
      "name": "Category Name",
      "items": [
        {
          "name": "Specific product (with quantity for ${guests} guests)",
          "product_name": "Exact product to search for",
          "store": "Retailer name",
          "price": 68,
          "search_query": "Google Shopping search query"
        }
      ]
    }
  ],
  "styling_tips": [
    "Start by: specific first step",
    "Layer: specific layering instruction",  
    "Add: specific detail",
    "Finish with: final touch"
  ]
}

RULES:
- Categories MUST include: Dinnerware, Flatware & Glassware, Linens, Florals & Greenery, Candles & Lighting, Place Settings & Details
- Every item must match the color palette: ${colorNames}
- Use SPECIFIC product names from: Anthropologie, Serena & Lily, Terrain, Williams Sonoma, Pottery Barn, West Elm, McGee & Co, One Kings Lane, Etsy artisans, H&M Home, Target (Hearth & Hand), World Market, Burke Decor
- Quantities must match ${guests} guests
- search_query should find this exact product on Google Shopping
- Prices must be realistic
${budget ? '- Total must stay within $' + budget : ''}
- Return ONLY JSON`
        }]
      })
    });

    if (!response.ok) {
      return res.status(500).json({ error: 'Design failed' });
    }

    const data = await response.json();
    const text = data.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const plan = JSON.parse(text);

    // Search Google Shopping for each item
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
            const sr = await fetch('https://serpapi.com/search.json?' + params.toString());
            if (sr.ok) {
              const sd = await sr.json();
              const results = sd.shopping_results || [];
              const junk = ['temu','shein','aliexpress','wish.com','dhgate','efavormart','posh setting','over the top','glam party','michaels','joann','hobby lobby','kohls','partycity','dollar','orientaltrading','cvlinens','tableclothsfactory','balsacircle','fruugo','ubuy','vevor','costway','rental'];
              const filtered = results.filter(r => { const s = (r.source||'').toLowerCase(); return !junk.some(j => s.includes(j)); });
              if (filtered.length > 0) {
                item.real_link = filtered[0].product_link || results[0].link || '';
                item.thumbnail = filtered[0].thumbnail || '';
                item.real_price = filtered[0].extracted_price || item.price;
              }
            }
          } catch (e) {}
          await new Promise(r => setTimeout(r, 150));
        }
      }
    }


    // Generate image with DALL-E 3
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (OPENAI_KEY) {
      try {
        const imgPrompt = `A stunning editorial photograph of a ${style} ${event.toLowerCase()} tablescape set ${setting === 'Outdoor' ? 'outdoors on a beautiful patio with natural greenery and warm sunlight' : 'indoors in an elegant dining room with warm ambient lighting'}. This is a ${meal.toLowerCase()} setting for ${guests} guests. Color palette: ${colorNames}. The table features: ${plan.categories.map(c => c.items.map(i => i.name).join(', ')).join(', ')}. ${plan.styling_tips ? plan.styling_tips.join('. ') : ''} Shot from slightly above at a 30-degree angle, soft natural window light streaming in from the left, shallow depth of field. The setting is warm and inviting. Photorealistic, shot on Canon 5D Mark IV, f/2.8, natural light, editorial interior photography, Architectural Digest style, no text or watermarks.`;
        
        const dalleRes = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + OPENAI_KEY
          },
          body: JSON.stringify({
            model: 'dall-e-3',
            prompt: imgPrompt,
            n: 1,
            size: '1792x1024',
            quality: 'standard',
            style: 'natural'
          })
        });

        if (dalleRes.ok) {
          const dalleData = await dalleRes.json();
          if (dalleData.data && dalleData.data[0]) {
            plan.generated_image = dalleData.data[0].url;
          }
        }
      } catch (e) {
        console.log('DALL-E failed:', e.message);
      }
    }

    return res.status(200).json(plan);
  } catch (err) {
    return res.status(500).json({ error: 'Failed: ' + err.message });
  }
}
