export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    maxDuration: 120
  }
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const SERP_KEY = process.env.SERPAPI_KEY;

  if (!OPENAI_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  }

  let image, mediaType;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    image = body.image;
    mediaType = body.mediaType || 'image/jpeg';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!image) return res.status(400).json({ error: 'No image provided' });

  const cleanImage = image.replace(/^data:image\/\w+;base64,/, '');
  const log = [];

  try {
    // ============================================================
    // STEP 1: Upload image so Google Lens (SerpAPI) can analyze it
    // ============================================================
    let imageUrl = null;

    // Try freeimage.host first
    try {
      const form = new URLSearchParams();
      form.append('source', cleanImage);
      form.append('type', 'base64');
      form.append('action', 'upload');

      const uploadRes = await fetch(
        'https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5',
        { method: 'POST', body: form }
      );

      if (uploadRes.ok) {
        const data = await uploadRes.json();
        if (data?.image?.url) {
          imageUrl = data.image.url;
          log.push('upload:freeimage');
        } else {
          log.push('freeimage:no-url');
        }
      } else {
        log.push('freeimage-fail:' + uploadRes.status);
      }
    } catch (e) {
      log.push('freeimage-err');
    }

    // Backup: imgbb
    if (!imageUrl) {
      try {
        const form = new URLSearchParams();
        form.append('image', cleanImage);
        form.append('expiration', '600');

        const uploadRes = await fetch(
          'https://api.imgbb.com/1/upload?key=5e87bda0a1f4270c0813577d712e84e0',
          { method: 'POST', body: form }
        );

        if (uploadRes.ok) {
          const data = await uploadRes.json();
          if (data?.data?.url) {
            imageUrl = data.data.url;
            log.push('upload:imgbb');
          } else {
            log.push('imgbb:no-url');
          }
        } else {
          log.push('imgbb-fail:' + uploadRes.status);
        }
      } catch (e) {
        log.push('imgbb-err');
      }
    }

    // ============================================================
    // STEP 2: Google Lens candidates (via SerpAPI)
    // ============================================================
    let lensResults = [];

    if (SERP_KEY && imageUrl) {
      try {
        const params = new URLSearchParams({
          engine: 'google_lens',
          url: imageUrl,
          api_key: SERP_KEY,
          hl: 'en',
          country: 'us'
        });

        const lensRes = await fetch('https://serpapi.com/search.json?' + params.toString());

        if (lensRes.ok) {
          const lensData = await lensRes.json();

          for (const vm of (lensData.visual_matches || []).slice(0, 40)) {
            if (!vm.link) continue;
            lensResults.push({
              title: vm.title || '',
              link: vm.link || '',
              source: vm.source || '',
              thumbnail: vm.thumbnail || '',
              price: parseMaybePrice(vm.price),
              kind: 'visual_match'
            });
          }

          for (const sr of (lensData.shopping_results || []).slice(0, 20)) {
            if (!(sr.link || sr.product_link)) continue;
            lensResults.push({
              title: sr.title || '',
              link: sr.product_link || sr.link || '',
              source: sr.source || '',
              thumbnail: sr.thumbnail || '',
              price: parseMaybePrice(sr.extracted_price || sr.price),
              kind: 'shopping_result'
            });
          }

          log.push('lens:' + lensResults.length);
        } else {
          log.push('lens-fail:' + lensRes.status);
        }
      } catch (e) {
        log.push('lens-err');
      }
    } else {
      if (!SERP_KEY) log.push('lens-skip:no-serp-key');
      if (!imageUrl) log.push('lens-skip:no-image-url');
    }

    // ============================================================
    // STEP 3: OpenAI identifies items + chooses exact lens matches +
    //         recommends very close alternatives / replacements
    // ============================================================
    const lensContext = lensResults.length
      ? `Google Lens candidates (use these for exact matches only when truly correct):\n` +
        lensResults
          .map((r, i) => {
            const p = r.price ? ` ($${r.price})` : '';
            return `${i}. [${r.kind}] "${r.title}" from ${r.source}${p} - ${r.link}`;
          })
          .join('\n')
      : `Google Lens candidates: none available`;

    const openaiPrompt = `
You are a meticulous visual shopping matcher for home decor, tablescapes, and interiors.

TASK
1) Identify ALL distinct shoppable items visible in the image (not duplicates unless different item types).
2) For each item, choose the BEST exact replacement from Google Lens candidates ONLY if it is truly the same item.
3) Then suggest 2-4 "close replacement" products that are visually very similar (shape, material, finish, pattern, color family).
4) Prioritize realistic, specific product names and useful retailer search URLs.

IMPORTANT QUALITY RULES
- Do NOT force matches.
- exact_match must be null if no Lens candidate is clearly the same item.
- A Lens result can be used for ONLY ONE item.
- Object type must match (plate ≠ glassware ≠ napkin ≠ vase).
- Prefer exact silhouette/edge detail/material over generic style similarity.
- If there are multiple identical copies in the image (e.g., same plate repeated), identify the item once and include quantity_estimate.

FOCUS
The user wants exact replacements first, then very close alternatives.
The alternatives must be MUCH closer visually than generic "same vibe" suggestions.

RETAILER COVERAGE FOR ALTERNATIVES
You may suggest products discoverable through:
- LiketoKnow.it / LTK creators and linked shops
- ShopMy creator storefronts and linked shops
- Anthropologie, Pottery Barn, Williams Sonoma, West Elm, CB2, Crate & Barrel
- Serena & Lily, McGee & Co, Rejuvenation, Schoolhouse, Lulu and Georgia
- Terrain, Etsy, Chairish, Target, World Market, Amazon, Wayfair, Juliska, Vietri, Sur La Table, Food52

SEARCH URL RULES
Use retailer search URLs (not made-up product pages if unsure). Examples:
- Anthropologie: https://www.anthropologie.com/search?q=QUERY
- Pottery Barn: https://www.potterybarn.com/search/results.html?words=QUERY
- Williams Sonoma: https://www.williams-sonoma.com/search/results.html?words=QUERY
- West Elm: https://www.westelm.com/search/results.html?words=QUERY
- Crate & Barrel: https://www.crateandbarrel.com/search?query=QUERY
- CB2: https://www.cb2.com/search?query=QUERY
- Target: https://www.target.com/s?searchTerm=QUERY
- Etsy: https://www.etsy.com/search?q=QUERY
- Amazon: https://www.amazon.com/s?k=QUERY
- Wayfair: https://www.wayfair.com/keyword.php?keyword=QUERY
- Serena & Lily: https://www.serenaandlily.com/search?q=QUERY
- Juliska: https://www.juliska.com/search?type=product&q=QUERY
- Sur La Table: https://www.surlatable.com/search/?q=QUERY
- Food52: https://food52.com/shop?utf8=%E2%9C%93&q=QUERY
- LTK (generic search): https://www.google.com/search?q=site%3Ashopltk.com+QUERY
- ShopMy (generic search): https://www.google.com/search?q=site%3Ashopmy.us+QUERY

RETURN ONLY VALID JSON (no markdown)

{
  "style_summary": "brief style summary",
  "colors": [
    {"name": "Soft Cream", "hex": "#F4EFE6"}
  ],
  "item_matches": [
    {
      "item_id": "item_01",
      "item_name": "specific item name",
      "category": "dinnerware|glassware|flatware|linens|florals|candles|furniture|lighting|decor|wallpaper|rug|other",
      "quantity_estimate": 1,
      "match_type": "exact|close|none",
      "confidence": 0,
      "exact_match": {
        "lens_index": 0,
        "title": "Lens title",
        "source": "Retailer/source",
        "link": "https://...",
        "thumbnail": "https://...",
        "price": 0
      },
      "evidence": [
        "why exact/close match is selected"
      ],
      "rejected_candidates": [
        { "lens_index": 2, "reason": "wrong object type" }
      ],
      "close_replacements": [
        {
          "title": "specific close replacement product name",
          "source": "Retailer",
          "search_url": "https://...",
          "estimated_price": 0,
          "similarity_notes": "what makes this visually close"
        }
      ],
      "styling_tip": "brief practical styling tip"
    }
  ]
}

${lensContext}
`.trim();

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'You are a meticulous visual shopping matcher. Return only valid JSON.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: openaiPrompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mediaType};base64,${cleanImage}`
                }
              }
            ]
          }
        ]
      })
    });

    if (!aiRes.ok) {
      let errText = '';
      let errJson = null;
      try {
        errText = await aiRes.text();
        try { errJson = JSON.parse(errText); } catch (e) {}
      } catch (e) {}

      return res.status(aiRes.status).json({
        error: `OpenAI failed: ${aiRes.status}`,
        details: errJson || errText || '',
        log: log.join(' | '),
        lens_used: !!imageUrl,
        lens_total: lensResults.length
      });
    }

    const aiData = await aiRes.json();
    const rawText = aiData?.choices?.[0]?.message?.content || '';

    const parsed = safeParseJson(rawText);
    if (!parsed) {
      return res.status(500).json({
        error: 'Could not parse AI JSON output',
        raw_preview: String(rawText).slice(0, 2000),
        log: log.join(' | ')
      });
    }

    const itemMatches = Array.isArray(parsed.item_matches) ? parsed.item_matches : [];

    // ============================================================
    // STEP 4: Build final response shape for frontend
    // ============================================================
    const normalizedItems = itemMatches.map((item, idx) => {
      const products = [];

      // exact match first
      if (item?.exact_match && item.exact_match.link) {
        const em = item.exact_match;
        let lensBackfill = null;
        if (
          Number.isInteger(em.lens_index) &&
          em.lens_index >= 0 &&
          em.lens_index < lensResults.length
        ) {
          lensBackfill = lensResults[em.lens_index];
        }

        products.push({
          title: lensBackfill?.title || em.title || '',
          price: lensBackfill?.price || em.price || 0,
          source: lensBackfill?.source || em.source || '',
          link: lensBackfill?.link || em.link || '',
          thumbnail: lensBackfill?.thumbnail || em.thumbnail || '',
          isExact: true,
          similarity_notes: 'Exact replacement from Google Lens candidate'
        });
      }

      // close replacements
      for (const sim of (item.close_replacements || []).slice(0, 6)) {
        products.push({
          title: sim.title || '',
          price: sim.estimated_price || 0,
          source: sim.source || '',
          link: sim.search_url || '',
          thumbnail: '',
          isExact: false,
          similarity_notes: sim.similarity_notes || ''
        });
      }

      return {
        id: item.item_id || `item_${String(idx + 1).padStart(2, '0')}`,
        name: item.item_name || `Item ${idx + 1}`,
        category: item.category || 'other',
        quantity_estimate: item.quantity_estimate || 1,
        match_type: item.match_type || (products.find(p => p.isExact) ? 'exact' : 'close'),
        confidence: typeof item.confidence === 'number' ? item.confidence : 0,
        evidence: Array.isArray(item.evidence) ? item.evidence : [],
        rejected_candidates: Array.isArray(item.rejected_candidates) ? item.rejected_candidates : [],
        styling_tip: item.styling_tip || '',
        products
      };
    });

    log.push('items:' + normalizedItems.length);

    return res.status(200).json({
      items: normalizedItems,
      colors: Array.isArray(parsed.colors) ? parsed.colors : [],
      style_summary: parsed.style_summary || '',
      lens_used: !!imageUrl,
      lens_total: lensResults.length,
      log: log.join(' | ')
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Unknown error',
      log: log.join(' | ')
    });
  }
}

/* ----------------------------- Helpers ----------------------------- */

function parseMaybePrice(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;

  // SerpAPI can return strings or objects
  if (typeof value === 'object') {
    if (typeof value.value === 'number') return value.value;
    if (typeof value.extracted_value === 'number') return value.extracted_value;
    value = JSON.stringify(value);
  }

  const n = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function safeParseJson(text) {
  if (!text) return null;

  let s = String(text).trim();

  // Remove markdown fences if present
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '');
  s = s.replace(/\s*```$/i, '').trim();

  // First try direct parse
  try {
    return JSON.parse(s);
  } catch (e) {}

  // Try extracting first JSON object block
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = s.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {}
  }

  // Try balancing braces/brackets for truncated JSON
  try {
    let fixed = s;
    fixed = fixed.replace(/,\s*$/, '');

    const opensCurly = (fixed.match(/{/g) || []).length;
    const closesCurly = (fixed.match(/}/g) || []).length;
    const opensSquare = (fixed.match(/\[/g) || []).length;
    const closesSquare = (fixed.match(/\]/g) || []).length;

    for (let i = 0; i < (opensSquare - closesSquare); i++) fixed += ']';
    for (let i = 0; i < (opensCurly - closesCurly); i++) fixed += '}';

    return JSON.parse(fixed);
  } catch (e) {
    return null;
  }
}
