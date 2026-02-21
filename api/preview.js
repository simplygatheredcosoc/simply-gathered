export const config = {
  api: { maxDuration: 90 }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not set' });

  let items, style;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    items = body.items || [];
    style = body.style || 'elegant';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid body' });
  }

  if (items.length < 1) return res.status(400).json({ error: 'Select at least 1 item' });

  try {
    const itemList = items.map(function(i) { return i.item + ' from ' + i.source + ' ($' + Math.round(i.price || 0) + ')'; }).join('\n- ');

    // Step 1: Claude creates styling guide + image prompt
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `You are an elite interior stylist. A client selected these items for a ${style} tablescape or room:\n\n- ${itemList}\n\nCreate a vivid styling guide. Return ONLY valid JSON:\n{\n  "title": "A beautiful evocative name for this look",\n  "description": "2-3 sentences painting a vivid picture of how this all looks together. Use sensory language - describe the mood, light, textures, how guests would feel.",\n  "layout_tips": [\n    "Start with: [specific placement instruction]",\n    "Layer the: [specific layering tip]",\n    "Add dimension by: [specific styling tip]",\n    "Finish with: [final touch]"\n  ],\n  "color_palette": [\n    {"name": "Color name", "hex": "#hexvalue"},\n    {"name": "Color name", "hex": "#hexvalue"},\n    {"name": "Color name", "hex": "#hexvalue"},\n    {"name": "Color name", "hex": "#hexvalue"}\n  ],\n  "image_prompt": "A highly detailed, photorealistic interior design photograph for an upscale shelter magazine. Describe EXACTLY what is in the scene: every item, its color, material, and placement. Describe the lighting (soft natural window light), camera angle (slightly elevated, looking down at 30 degrees), background details, and mood. Style: editorial, aspirational, warm. DO NOT mention any brand names. Be VERY specific about each item's placement and relationship to other items. End with: Photorealistic, shot on Canon 5D, natural light, editorial interior photography, Architectural Digest style."\n}\n\nReturn ONLY JSON.`
        }]
      })
    });

    if (!response.ok) {
      return res.status(500).json({ error: 'Preview failed' });
    }

    const data = await response.json();
    const text = data.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(text);

    // Step 2: Generate image with DALL-E 3
    if (OPENAI_KEY && parsed.image_prompt) {
      try {
        const dalleRes = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + OPENAI_KEY
          },
          body: JSON.stringify({
            model: 'dall-e-3',
            prompt: parsed.image_prompt,
            n: 1,
            size: '1792x1024',
            quality: 'standard',
            style: 'natural'
          })
        });

        if (dalleRes.ok) {
          const dalleData = await dalleRes.json();
          if (dalleData.data && dalleData.data[0]) {
            parsed.generated_image = dalleData.data[0].url;
            parsed.revised_prompt = dalleData.data[0].revised_prompt || '';
          }
        }
      } catch (e) {
        console.log('DALL-E generation failed:', e.message);
      }
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: 'Failed: ' + err.message });
  }
}
