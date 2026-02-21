// Vercel Serverless Function: /api/analyze
// Sends image to Claude Vision API and returns identified items + colors

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { image, mediaType } = req.body;
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;

  if (!CLAUDE_KEY) return res.status(500).json({ error: 'Claude API key not configured' });
  if (!image) return res.status(400).json({ error: 'No image provided' });

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
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image }
            },
            {
              type: 'text',
              text: `You are a home decor and interior design expert. Analyze this image carefully.

Return ONLY valid JSON with this exact structure:
{
  "items": [
    {
      "name": "Specific product name for shopping",
      "description": "Detailed visual description",
      "search_query": "optimized Google Shopping search query to find this exact item or closest match",
      "category": "furniture|lighting|tableware|textiles|decor|plants|art|paint",
      "order": 1,
      "styling_tip": "Brief tip for recreating this element"
    }
  ],
  "colors": [
    {
      "name": "Exact paint color name",
      "brand": "Farrow & Ball|Benjamin Moore|Sherwin-Williams",
      "code": "Color code",
      "hex": "#hexvalue"
    }
  ],
  "style_summary": "Brief description of the overall aesthetic"
}

IMPORTANT RULES:
- Identify 5-10 distinct shoppable items visible in the image
- For search_query, write exactly what someone would type into Google Shopping to find this item. Be specific about material, color, style, and size. Example: "brass vintage taper candle holder pair 10 inch" not just "candle holder"
- For paint colors, identify 3-5 colors visible on walls, trim, furniture and match to the closest Farrow & Ball, Benjamin Moore, or Sherwin-Williams color
- Return ONLY the JSON object, no markdown, no explanation, no backticks`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: 'Claude API error', details: err });
    }

    const data = await response.json();
    const text = data.content[0].text;
    
    // Parse JSON (handle potential markdown wrapping)
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: 'Analysis failed', message: err.message });
  }
}
