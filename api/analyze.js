export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not set' });

  let image, mediaType;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    image = body.image;
    mediaType = body.mediaType || 'image/jpeg';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!image) return res.status(400).json({ error: 'No image' });
  const cleanImage = image.replace(/^data:image\/\w+;base64,/, '');

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
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: cleanImage }
            },
            {
              type: 'text',
              text: `You are an elite interior designer and luxury personal shopper. You know every product at every high-end home store.

Analyze this image. For each item you see, tell me EXACTLY where to buy it or the closest luxury match.

Return ONLY valid JSON:
{
  "items": [
    {
      "name": "Descriptive item name",
      "order": 1,
      "styling_tip": "One sentence styling tip",
      "retailers": [
        {
          "store": "Store Name",
          "product_name": "Actual product name at this store",
          "search_term": "search term for their website",
          "price_estimate": 89
        }
      ]
    }
  ],
  "colors": [
    {"name": "Paint Name", "brand": "Brand", "code": "Code", "hex": "#hex"}
  ],
  "style_summary": "Brief style description"
}

REQUIREMENTS:
- Identify 5-8 shoppable items
- For EACH item, list 5-7 retailers with SPECIFIC product recommendations
- You MUST use real product names that actually exist at these stores. Think about what you've seen in their catalogs.
- Prioritize these stores (in order of preference):
  TIER 1 (always try to include 2-3): Anthropologie, Serena & Lily, McGee & Co, One Kings Lane, Rejuvenation, Arhaus, RH (Restoration Hardware)
  TIER 2 (include 2-3): Pottery Barn, West Elm, Williams Sonoma, Ballard Designs, Terrain, Lulu and Georgia, Burke Decor, Schoolhouse, Food52, The Citizenry
  TIER 3 (include 1-2 for price range): Target (Threshold/Studio McGee line, Hearth & Hand), Etsy (artisan shops), Amazon (specific brands like Creative Co-Op, Bloomingville, Mud Pie)
  LUXURY (include 1 if applicable): Chairish, 1stDibs, Perigold, Over The Moon, Liberty London
- search_term should be 2-5 words that would find this product on their site
- price_estimate must be realistic for that store
- For paint colors, use real Farrow & Ball, Benjamin Moore, or Sherwin-Williams colors
- Return ONLY JSON`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Claude error ' + response.status, details: errText.substring(0, 500) });
    }

    const data = await response.json();
    const text = data.content[0].text;
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: 'Failed: ' + err.message });
  }
}
