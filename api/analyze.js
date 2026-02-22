export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
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

  let image, mediaType;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    image = body.image;
    mediaType = body.mediaType || 'image/jpeg';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (!image) return res.status(400).json({ error: 'No image' });

  const cleanImage = image.replace(/^data:image\/\w+;base64,/, '');
  const log = [];

  try {
    // ═══════════════════════════════════════════════
    // STEP 1: Upload image for Google Lens
    // ═══════════════════════════════════════════════
    let imageUrl = null;

    // Try freeimage first (imgbb has been failing)
    try {
      const form = new URLSearchParams();
      form.append('source', cleanImage);
      form.append('type', 'base64');
      form.append('action', 'upload');
      const r = await fetch('https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5', {
        method: 'POST', body: form
      });
      if (r.ok) {
        const d = await r.json();
        if (d.image && d.image.url) { imageUrl = d.image.url; log.push('upload:freeimage'); }
      } else { log.push('freeimage-fail:' + r.status); }
    } catch (e) { log.push('freeimage-err'); }

    // Backup: imgbb
    if (!imageUrl) {
      try {
        const form = new URLSearchParams();
        form.append('image', cleanImage);
        form.append('expiration', '600');
        const r = await fetch('https://api.imgbb.com/1/upload?key=5e87bda0a1f4270c0813577d712e84e0', {
          method: 'POST', body: form
        });
        if (r.ok) {
          const d = await r.json();
          if (d.data && d.data.url) { imageUrl = d.data.url; log.push('upload:imgbb'); }
        } else { log.push('imgbb-fail:' + r.status); }
      } catch (e) { log.push('imgbb-err'); }
    }

    // ═══════════════════════════════════════════════
    // STEP 2: Google Lens - find ALL visual matches
    // ═══════════════════════════════════════════════
    let lensResults = [];

    if (SERP_KEY && imageUrl) {
      try {
        const p = new URLSearchParams({
          engine: 'google_lens', url: imageUrl,
          api_key: SERP_KEY, hl: 'en', country: 'us'
        });
        const r = await fetch('https://serpapi.com/search.json?' + p.toString());
        if (r.ok) {
          const d = await r.json();
          for (const vm of (d.visual_matches || []).slice(0, 30)) {
            if (!vm.link) continue;
            lensResults.push({
              title: vm.title || '', link: vm.link,
              source: vm.source || '', thumbnail: vm.thumbnail || '',
              price: vm.price ? parseFloat(String(vm.price.value || vm.price).replace(/[^0-9.]/g, '')) : 0
            });
          }
          for (const sr of (d.shopping_results || []).slice(0, 10)) {
            if (!sr.link) continue;
            lensResults.push({
              title: sr.title || '', link: sr.link || sr.product_link || '',
              source: sr.source || '', thumbnail: sr.thumbnail || '',
              price: sr.extracted_price || 0
            });
          }
          log.push('lens:' + lensResults.length + ' matches');
        }
      } catch (e) { log.push('lens-err'); }
    }

    // ═══════════════════════════════════════════════
    // STEP 3: Claude identifies items + Lens gives exact match
    //         Then Claude recommends similar from approved stores
    // ═══════════════════════════════════════════════
    const lensContext = lensResults.length > 0
      ? '\n\nGoogle Lens found these products matching this image:\n' +
        lensResults.map((r, i) =>
          i + '. "' + r.title + '" from ' + r.source + (r.price ? ' ($' + r.price + ')' : '') + ' - ' + r.link
        ).join('\n')
      : '';

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: cleanImage } },
            { type: 'text', text: `You are a luxury home and lifestyle product expert and personal shopper.

STEP 1: Identify every shoppable item in this image.
STEP 2: For each item, find the BEST exact match from the Google Lens results below.
STEP 3: For each item, recommend 2-3 SIMILAR products from these APPROVED RETAILERS ONLY:
  Anthropologie, Pottery Barn, Williams Sonoma, West Elm, Crate & Barrel, CB2,
  Serena & Lily, McGee & Co, Rejuvenation, Schoolhouse, One Kings Lane, Arhaus,
  Terrain, Lulu and Georgia, Burke Decor, Ballard Designs, Etsy, Chairish,
  Target (Hearth & Hand / Threshold), Nordstrom, Bloomingdale's, Juliska, Vietri,
  MacKenzie-Childs, Sur La Table, Food52, Wayfair, Amazon, World Market,
  Replacements Ltd, East Fork, Heath Ceramics, Minted, Ruggable, Loloi
${lensContext}

Return ONLY valid JSON:
{
  "items": [
    {
      "name": "Very specific product name with brand if known",
      "order": 1,
      "styling_tip": "brief styling tip",
      "exact_match": {
        "title": "Best matching product title from Google Lens",
        "source": "Source website name",
        "link": "Full URL from lens results",
        "thumbnail": "Thumbnail URL if available",
        "price": 0,
        "lens_index": 0
      },
      "similar_items": [
        {"title": "Product name", "source": "Anthropologie", "search_url": "https://www.anthropologie.com/search?q=QUERY", "estimated_price": 48, "why": "Similar style"}
      ]
    }
  ],
  "colors": [{"name": "Paint Name", "brand": "Benjamin Moore", "code": "HC-172", "hex": "#hex"}],
  "style_summary": "Brief style description"
}

CRITICAL RULES:
1. exact_match MUST use the actual link and title from the Google Lens results above
2. For similar_items, recommend REAL products you know exist at approved retailers
3. Build search URLs for each retailer like:
   - Anthropologie: https://www.anthropologie.com/search?q=QUERY
   - Pottery Barn: https://www.potterybarn.com/search/results.html?words=QUERY
   - Williams Sonoma: https://www.williams-sonoma.com/search/results.html?words=QUERY
   - West Elm: https://www.westelm.com/search/results.html?words=QUERY
   - Crate & Barrel: https://www.crateandbarrel.com/search?query=QUERY
   - Target: https://www.target.com/s?searchTerm=QUERY
   - Etsy: https://www.etsy.com/search?q=QUERY
   - Amazon: https://www.amazon.com/s?k=QUERY
   - Wayfair: https://www.wayfair.com/keyword.php?keyword=QUERY
   - Serena & Lily: https://www.serenaandlily.com/search?q=QUERY
   - Juliska: https://www.juliska.com/search?type=product&q=QUERY
   - Sur La Table: https://www.surlatable.com/search/?q=QUERY
4. Each similar item should match the STYLE, COLOR, and FEEL of the original
5. Include a brief "why" for each recommendation explaining the similarity
6. Return ONLY JSON` }
          ]
        }]
      })
    });

    if (!claudeRes.ok) {
      return res.status(500).json({ error: 'Claude failed: ' + claudeRes.status, log: log.join(' | ') });
    }

    const claudeData = await claudeRes.json();
    let claudeText = claudeData.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    // Fix truncated JSON - try to close any open brackets
    let identified;
    try {
      identified = JSON.parse(claudeText);
    } catch (e) {
      // Try to fix truncated JSON
      let fixed = claudeText;
      // Count open/close brackets
      const openBraces = (fixed.match(/{/g) || []).length;
      const closeBraces = (fixed.match(/}/g) || []).length;
      const openBrackets = (fixed.match(/\[/g) || []).length;
      const closeBrackets = (fixed.match(/\]/g) || []).length;
      
      // Remove any trailing comma
      fixed = fixed.replace(/,\s*$/, '');
      
      // Close arrays then objects
      for (let i = 0; i < openBrackets - closeBrackets; i++) fixed += ']';
      for (let i = 0; i < openBraces - closeBraces; i++) fixed += '}';
      
      try {
        identified = JSON.parse(fixed);
      } catch (e2) {
        // Last resort: extract just the items array
        const itemsMatch = claudeText.match(/"items"\s*:\s*\[/);
        if (itemsMatch) {
          const start = itemsMatch.index + itemsMatch[0].length;
          // Find complete item objects
          const items = [];
          let depth = 1;
          let objStart = start;
          for (let i = start; i < claudeText.length && depth > 0; i++) {
            if (claudeText[i] === '{') { if (depth === 1) objStart = i; depth++; }
            else if (claudeText[i] === '}') { depth--; if (depth === 1) { try { items.push(JSON.parse(claudeText.substring(objStart, i + 1))); } catch(e3){} } }
            else if (claudeText[i] === ']') { depth--; }
          }
          identified = { items: items, colors: [], style_summary: '' };
        } else {
          throw new Error('Could not parse Claude response');
        }
      }
    }
    log.push('items:' + (identified.items || []).length);

    // ═══════════════════════════════════════════════
    // STEP 4: Build final results
    // ═══════════════════════════════════════════════
    const items = (identified.items || []).map(item => {
      const products = [];

      // First: the exact match from Google Lens
      if (item.exact_match && item.exact_match.link) {
        const em = item.exact_match;
        // Try to get the real lens result data
        if (typeof em.lens_index === 'number' && em.lens_index >= 0 && em.lens_index < lensResults.length) {
          const lr = lensResults[em.lens_index];
          products.push({
            title: lr.title || em.title,
            price: lr.price || em.price || 0,
            source: lr.source || em.source,
            link: lr.link || em.link,
            thumbnail: lr.thumbnail || em.thumbnail || '',
            isExact: true
          });
        } else {
          products.push({
            title: em.title || '',
            price: em.price || 0,
            source: em.source || '',
            link: em.link || '',
            thumbnail: em.thumbnail || '',
            isExact: true
          });
        }
      }

      // Then: AI-recommended similar items from approved retailers
      for (const sim of (item.similar_items || []).slice(0, 5)) {
        products.push({
          title: sim.title || '',
          price: sim.estimated_price || 0,
          source: sim.source || '',
          link: sim.search_url || '',
          thumbnail: '',
          isExact: false,
          why: sim.why || ''
        });
      }

      return {
        name: item.name,
        order: item.order || 1,
        styling_tip: item.styling_tip || '',
        search_query: item.name,
        exactCount: item.exact_match && item.exact_match.link ? 1 : 0,
        products
      };
    });

    return res.status(200).json({
      items,
      colors: identified.colors || [],
      style_summary: identified.style_summary || '',
      lens_used: !!imageUrl,
      lens_total: lensResults.length,
      log: log.join(' | ')
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, log: log.join(' | ') });
  }
}
