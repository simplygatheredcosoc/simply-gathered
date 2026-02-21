export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    },
    maxDuration: 120
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
    // Step 1: Have Claude identify items in the image
    const identifyResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: cleanImage }
            },
            {
              type: 'text',
              text: `Identify every shoppable item in this image. Be EXTREMELY specific about brands, patterns, materials, and distinguishing features. If you recognize a specific brand or designer, name it.

Return ONLY valid JSON:
{
  "items": [
    {
      "name": "Very specific item description",
      "identifying_details": "unique features like pattern, brand markings, specific design elements",
      "search_queries": ["exact product search query 1", "broader search query 2", "brand + category query 3"],
      "order": 1,
      "styling_tip": "tip"
    }
  ],
  "colors": [
    {"name": "Paint Name", "brand": "Farrow & Ball or Benjamin Moore or Sherwin-Williams", "code": "Code", "hex": "#hex"}
  ],
  "style_summary": "Brief style"
}

Be as specific as possible. If you see a clover on a plate, don't just say "green plate" — say "porcelain plate with four leaf clover and ladybug motif, gold rim". Include 3 search queries per item: one very specific, one moderate, one broad.
Return ONLY JSON.`
            }
          ]
        }]
      })
    });

    if (!identifyResponse.ok) {
      const err = await identifyResponse.text();
      return res.status(500).json({ error: 'Identify failed: ' + identifyResponse.status, details: err.substring(0, 300) });
    }

    const identifyData = await identifyResponse.json();
    const identifyText = identifyData.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const identified = JSON.parse(identifyText);

    // Step 2: For each item, use Claude with web search to find exact products
    const itemsWithRetailers = [];
    
    for (const item of identified.items) {
      try {
        const searchResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': CLAUDE_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 2048,
            tools: [
              {
                type: 'web_search_20250305',
                name: 'web_search'
              }
            ],
            messages: [{
              role: 'user',
              content: `Find where to buy this exact item: "${item.name}"
Details: ${item.identifying_details || ''}
Search queries to try: ${(item.search_queries || []).join(', ')}

Search the web and find 5-7 places to buy this exact item or the closest luxury match. Prioritize high-end retailers like Anthropologie, Serena & Lily, One Kings Lane, Rejuvenation, McGee & Co, Williams Sonoma, Pottery Barn, West Elm, Chairish, 1stDibs, Etsy artisans.

After searching, return ONLY valid JSON:
{
  "retailers": [
    {
      "store": "Store Name",
      "product_name": "Exact product name found",
      "search_term": "search term for their site",
      "price_estimate": 89,
      "url": "direct URL if found, or empty string"
    }
  ]
}
Return ONLY JSON, no other text.`
            }]
          })
        });

        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          // Extract text from response (may have multiple content blocks from tool use)
          let responseText = '';
          for (const block of searchData.content) {
            if (block.type === 'text') {
              responseText += block.text;
            }
          }
          
          const cleanResponse = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          
          // Try to extract JSON from the response
          let retailers = [];
          try {
            const parsed = JSON.parse(cleanResponse);
            retailers = parsed.retailers || [];
          } catch (e) {
            // Try to find JSON in the response
            const jsonMatch = cleanResponse.match(/\{[\s\S]*"retailers"[\s\S]*\}/);
            if (jsonMatch) {
              try {
                retailers = JSON.parse(jsonMatch[0]).retailers || [];
              } catch (e2) {}
            }
          }
          
          itemsWithRetailers.push({
            ...item,
            retailers: retailers
          });
        } else {
          // Fallback: no web search results, use item as-is
          itemsWithRetailers.push({
            ...item,
            retailers: []
          });
        }
      } catch (searchErr) {
        itemsWithRetailers.push({
          ...item,
          retailers: []
        });
      }
    }

    return res.status(200).json({
      items: itemsWithRetailers,
      colors: identified.colors || [],
      style_summary: identified.style_summary || ''
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed: ' + err.message });
  }
}
