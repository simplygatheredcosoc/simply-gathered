export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' },
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
  const SERP_KEY = process.env.SERPAPI_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not set' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid body' });
  }

  const { room, style, colors, options, budget, notes, images, designers } = body;
  const colorNames = (colors || []).map(c => c.n).join(', ');
  const optionsList = (options || []).length ? options.join(', ') : 'all elements';
  const designerNames = (designers || []).join(', ');

  // Build Claude message with images
  const messageContent = [];

  // Add room photo if present
  if (images && images.length > 0) {
    const roomImg = images.find(i => i.type === 'room');
    if (roomImg) {
      messageContent.push({
        type: 'image',
        source: { type: 'base64', media_type: roomImg.mediaType || 'image/jpeg', data: roomImg.b64 }
      });
    }
    // Add inspo items
    const inspoImgs = images.filter(i => i.type === 'inspo');
    for (const img of inspoImgs) {
      messageContent.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.b64 }
      });
    }
  }

  // Build the inspo items description
  const inspoDescs = (images || [])
    .filter(i => i.type === 'inspo')
    .map((i, idx) => `Inspiration item ${idx + 1}${i.label ? ': ' + i.label : ''}`)
    .join('\n');

  const hasRoomPhoto = images && images.some(i => i.type === 'room');
  const hasInspo = images && images.some(i => i.type === 'inspo');

  let promptText = `You are an elite interior designer. `;
  
  if (hasRoomPhoto && hasInspo) {
    promptText += `The FIRST image is the client's current room (the "before"). The REMAINING images are items they want to INCORPORATE into the new design — wallpaper, decor, furniture, etc. 

Analyze the current room: what's there, the layout, the light, what could stay and what should change. Then look at the inspiration items they want to add. Design the rest of the room around those items.`;
  } else if (hasRoomPhoto) {
    promptText += `The image is the client's current room. Analyze what's there and design a refresh/makeover.`;
  } else if (hasInspo) {
    promptText += `The images are items the client wants to use in their room. Design the room around these pieces.`;
  } else {
    promptText += `Design a complete room from scratch.`;
  }

  promptText += `

ROOM: ${room || 'Bedroom'}
STYLE: ${style || 'Cottage'}
${colorNames ? 'COLOR PALETTE: ' + colorNames : 'COLOR PALETTE: Pick colors that complement the uploaded items'}
FOCUS ON: ${optionsList}
${budget ? 'BUDGET: $' + budget : ''}
${notes ? 'CLIENT NOTES: ' + notes : ''}
${designerNames ? 'FAVORITE DESIGNERS: ' + designerNames + '. Channel their aesthetic — use the colors, textures, patterns, and product styles they are known for. Reference specific products from their collections or stores they are associated with.' : ''}
${inspoDescs ? 'INSPIRATION ITEMS:\n' + inspoDescs : ''}

Return ONLY valid JSON:
{
  "title": "Beautiful evocative name for this design",
  "description": "2-3 sentences describing the transformed room — mood, textures, light, how it feels.",
  ${hasRoomPhoto ? '"keep_items": ["Item from current room to keep", "Another item to keep"],' : ''}
  ${hasInspo ? '"incorporated_items": ["How inspo item 1 is used", "How inspo item 2 is used"],' : ''}
  "paint_colors": [
    {"name": "Color name", "brand": "Benjamin Moore or Farrow & Ball or Sherwin-Williams", "code": "Code", "hex": "#hex", "where": "Where to use it"}
  ],
  "categories": [
    {
      "name": "Category",
      "items": [
        {
          "name": "Specific product with details",
          "product_name": "Exact searchable name",
          "store": "Retailer",
          "price": 89,
          "search_query": "Google Shopping query"
        }
      ]
    }
  ],
  "design_tips": ["Specific tip 1", "Tip 2", "Tip 3", "Tip 4"]
}

RULES:
- ${hasInspo ? 'The uploaded inspiration items MUST be central to the design. Build everything else around them.' : ''}
- ${hasRoomPhoto ? 'Note which existing items to KEEP and which to replace.' : ''}
- Use SPECIFIC products from: Anthropologie, Serena & Lily, Rejuvenation, McGee & Co, One Kings Lane, Pottery Barn, West Elm, Schoolhouse, Lulu and Georgia, Burke Decor, Terrain, Target (Hearth & Hand), Etsy artisans, Wayfair
- Prices must be realistic
- search_query should find the product on Google Shopping
- Include 2-4 paint colors with real brand names
- Return ONLY JSON`;

  messageContent.push({ type: 'text', text: promptText });

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
        max_tokens: 3500,
        messages: [{ role: 'user', content: messageContent }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Design failed: ' + response.status });
    }

    const data = await response.json();
    const text = data.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const plan = JSON.parse(text);

    // Google Shopping for each item
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
        const allItems = plan.categories.map(c => c.items.map(i => i.name).join(', ')).join(', ');
        const paintDesc = (plan.paint_colors || []).map(p => p.name + ' (' + p.where + ')').join(', ');
        const imgPrompt = `A stunning editorial photograph of a beautifully designed ${style} ${room}. ${plan.description || ''} The room features: ${allItems}. Paint colors: ${paintDesc}. Color palette: ${colorNames || 'warm and inviting tones'}. Shot from a natural standing eye-level perspective, soft natural light from large windows, warm and inviting atmosphere. The space feels lived-in yet perfectly styled, like a feature in Architectural Digest. Photorealistic, shot on Canon 5D Mark IV, wide angle lens, natural light, editorial interior photography, no text or watermarks.`;
        
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
