export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' },
    maxDuration: 120
  }
};

// -----------------------------
// Helpers
// -----------------------------
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function stripCodeFences(text = '') {
  return String(text)
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

function repairJson(text = '') {
  let fixed = stripCodeFences(text);

  // Remove trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');

  // Quick balance fix
  const openBraces = (fixed.match(/{/g) || []).length;
  const closeBraces = (fixed.match(/}/g) || []).length;
  const openBrackets = (fixed.match(/\[/g) || []).length;
  const closeBrackets = (fixed.match(/\]/g) || []).length;

  if (openBrackets > closeBrackets) {
    fixed += ']'.repeat(openBrackets - closeBrackets);
  }
  if (openBraces > closeBraces) {
    fixed += '}'.repeat(openBraces - closeBraces);
  }

  return fixed;
}

function parseOpenAIJson(text) {
  const raw = stripCodeFences(text);

  // 1) direct parse
  let parsed = safeJsonParse(raw);
  if (parsed) return parsed;

  // 2) repair parse
  parsed = safeJsonParse(repairJson(raw));
  if (parsed) return parsed;

  // 3) extract first JSON object block
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = raw.slice(firstBrace, lastBrace + 1);
    parsed = safeJsonParse(repairJson(sliced));
    if (parsed) return parsed;
  }

  throw new Error('Could not parse AI JSON response');
}

function normalizePrice(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function encodeQuery(q = '') {
  return encodeURIComponent(String(q).trim());
}

function buildSearchUrl(source = '', query = '') {
  const q = encodeQuery(query);
  const s = String(source || '').toLowerCase();

  if (s.includes('anthropologie')) return `https://www.anthropologie.com/search?q=${q}`;
  if (s.includes('pottery barn') || s.includes('potterybarn')) return `https://www.potterybarn.com/search/results.html?words=${q}`;
  if (s.includes('williams sonoma') || s.includes('williams-sonoma')) return `https://www.williams-sonoma.com/search/results.html?words=${q}`;
  if (s.includes('west elm') || s.includes('westelm')) return `https://www.westelm.com/search/results.html?words=${q}`;
  if (s.includes('crate') && s.includes('barrel')) return `https://www.crateandbarrel.com/search?query=${q}`;
  if (s.includes('cb2')) return `https://www.cb2.com/search?query=${q}`;
  if (s.includes('target')) return `https://www.target.com/s?searchTerm=${q}`;
  if (s.includes('etsy')) return `https://www.etsy.com/search?q=${q}`;
  if (s.includes('amazon')) return `https://www.amazon.com/s?k=${q}`;
  if (s.includes('wayfair')) return `https://www.wayfair.com/keyword.php?keyword=${q}`;
  if (s.includes('serena') || s.includes('lily')) return `https://www.serenaandlily.com/search?q=${q}`;
  if (s.includes('juliska')) return `https://www.juliska.com/search?type=product&q=${q}`;
  if (s.includes('sur la table') || s.includes('surlatable')) return `https://www.surlatable.com/search/?q=${q}`;
  if (s.includes('world market')) return `https://www.worldmarket.com/search?q=${q}`;
  if (s.includes('ltk') || s.includes('like to know it')) return `https://www.shopltk.com/search?query=${q}`;
  if (s.includes('shopmy')) return `https://shopmy.us/search?q=${q}`;

  return `https://www.google.com/search?tbm=shop&q=${q}`;
}

function allowedRecommendationSourceName(source = '') {
  const s = String(source || '').trim();
  if (!s) return 'Google Shopping';
  return s;
}

function sanitizeLensResults(lensResults = []) {
  const used = new Set();
  const out = [];

  for (const r of lensResults) {
    if (!r || !r.link) continue;
    const key = `${r.link}|${r.title || ''}`;
    if (used.has(key)) continue;
    used.add(key);
    out.push({
      title: String(r.title || '').trim(),
      link: String(r.link || '').trim(),
      source: String(r.source || '').trim(),
      thumbnail: String(r.thumbnail || '').trim(),
      price: normalizePrice(r.price)
    });
  }

  return out;
}

function lensContextString(lensResults = []) {
  if (!lensResults.length) return 'No Google Lens candidates were found.';
  return lensResults
    .map((r, i) => {
      const priceText = r.price ? ` ($${r.price})` : '';
      return `${i}. "${r.title}" from ${r.source || 'Unknown'}${priceText} - ${r.link}`;
    })
    .join('\n');
}

// A small fallback if AI misses too many items
function ensureCoverageShape(ai, lensResults) {
  const result = ai && typeof ai === 'object' ? ai : {};
  if (!Array.isArray(result.item_matches)) result.item_matches = [];
  if (!Array.isArray(result.colors)) result.colors = [];
  if (typeof result.style_summary !== 'string') result.style_summary = '';

  // If the model returned nothing but we have Lens candidates, make a minimal fallback item
  if (result.item_matches.length === 0 && lensResults.length > 0) {
    const top = lensResults[0];
    result.item_matches.push({
      item_id: 'item_01',
      item_name: top.title ? `visible decor item (possible match: ${top.title})` : 'visible decor item',
      match_type: 'close',
      confidence: 40,
      exact_match: null,
      evidence: ['AI response did not return parsed items; using fallback from Lens candidates'],
      rejected_candidates: [],
      styling_tip: 'Use this as a starting point and refine with a closer crop image for better matching.',
      recommendations: [
        {
          title: top.title || 'Similar product',
          source: top.source || 'Google Shopping',
          search_query: top.title || 'home decor item',
          search_url: buildSearchUrl(top.source || 'Google Shopping', top.title || 'home decor item'),
          estimated_price: top.price || 0,
          why: 'Closest available fallback based on Google Lens top candidate'
        }
      ]
    });
  }

  return result;
}

function mapOutput(aiResult, lensResults) {
  const items = [];
  const itemMatches = Array.isArray(aiResult.item_matches) ? aiResult.item_matches : [];

  for (let idx = 0; idx < itemMatches.length; idx++) {
    const m = itemMatches[idx] || {};
    const recs = Array.isArray(m.recommendations) ? m.recommendations : [];
    const products = [];

    // exact match first
    if (m.match_type === 'exact' && m.exact_match && typeof m.exact_match === 'object') {
      const em = m.exact_match;
      let lensResolved = null;

      if (typeof em.lens_index === 'number' && em.lens_index >= 0 && em.lens_index < lensResults.length) {
        lensResolved = lensResults[em.lens_index];
      }

      products.push({
        title: (lensResolved && lensResolved.title) || em.title || '',
        price: (lensResolved && lensResolved.price) || normalizePrice(em.price),
        source: (lensResolved && lensResolved.source) || em.source || '',
        link: (lensResolved && lensResolved.link) || em.link || '',
        thumbnail: (lensResolved && lensResolved.thumbnail) || em.thumbnail || '',
        isExact: true,
        confidence: typeof m.confidence === 'number' ? m.confidence : 0
      });
    }

    // recommendations
    for (const r of recs.slice(0, 6)) {
      const title = String(r.title || '').trim();
      const source = allowedRecommendationSourceName(r.source || '');
      const search_query = String(r.search_query || title || m.item_name || '').trim();
      const search_url = String(r.search_url || buildSearchUrl(source, search_query)).trim();

      if (!title && !search_query) continue;

      products.push({
        title: title || search_query,
        price: normalizePrice(r.estimated_price),
        source,
        link: search_url,
        thumbnail: '',
        isExact: false,
        why: String(r.why || '').trim()
      });
    }

    items.push({
      id: m.item_id || `item_${String(idx + 1).padStart(2, '0')}`,
      name: String(m.item_name || `Item ${idx + 1}`).trim(),
      order: idx + 1,
      match_type: m.match_type || 'none',
      confidence: typeof m.confidence === 'number' ? m.confidence : 0,
      evidence: Array.isArray(m.evidence) ? m.evidence : [],
      rejected_candidates: Array.isArray(m.rejected_candidates) ? m.rejected_candidates : [],
      styling_tip: String(m.styling_tip || '').trim(),
      exactCount: m.match_type === 'exact' && m.exact_match ? 1 : 0,
      products
    });
  }

  return {
    items,
    colors: Array.isArray(aiResult.colors) ? aiResult.colors : [],
    style_summary: String(aiResult.style_summary || '')
  };
}

// -----------------------------
// Main API Route
// -----------------------------
export default async function handler(req, res) {
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

  const cleanImage = String(image).replace(/^data:image\/\w+;base64,/, '');
  const log = [];

  try {
    // =========================================
    // STEP 1: Upload image somewhere public for Google Lens (SerpAPI)
    // =========================================
    let imageUrl = null;

    // freeimage.host first
    try {
      const form = new URLSearchParams();
      form.append('source', cleanImage);
      form.append('type', 'base64');
      form.append('action', 'upload');

      const upRes = await fetch(
        'https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5',
        { method: 'POST', body: form }
      );

      if (upRes.ok) {
        const upData = await upRes.json();
        if (upData && upData.image && upData.image.url) {
          imageUrl = upData.image.url;
          log.push('upload:freeimage');
        }
      } else {
        log.push(`freeimage-fail:${upRes.status}`);
      }
    } catch (e) {
      log.push('freeimage-err');
    }

    // imgbb fallback
    if (!imageUrl) {
      try {
        const form = new URLSearchParams();
        form.append('image', cleanImage);
        form.append('expiration', '600');

        const upRes = await fetch(
          'https://api.imgbb.com/1/upload?key=5e87bda0a1f4270c0813577d712e84e0',
          { method: 'POST', body: form }
        );

        if (upRes.ok) {
          const upData = await upRes.json();
          if (upData && upData.data && upData.data.url) {
            imageUrl = upData.data.url;
            log.push('upload:imgbb');
          }
        } else {
          log.push(`imgbb-fail:${upRes.status}`);
        }
      } catch (e) {
        log.push('imgbb-err');
      }
    }

    // =========================================
    // STEP 2: Google Lens candidates (SerpAPI)
    // =========================================
    let lensResults = [];

    if (SERP_KEY && imageUrl) {
      try {
        const p = new URLSearchParams({
          engine: 'google_lens',
          url: imageUrl,
          api_key: SERP_KEY,
          hl: 'en',
          country: 'us'
        });

        const lensRes = await fetch('https://serpapi.com/search.json?' + p.toString());

        if (lensRes.ok) {
          const lensData = await lensRes.json();

          // visual_matches
          for (const vm of (lensData.visual_matches || []).slice(0, 40)) {
            const link = vm.link || vm.product_link || '';
            if (!link) continue;
            lensResults.push({
              title: vm.title || '',
              link,
              source: vm.source || '',
              thumbnail: vm.thumbnail || '',
              price: normalizePrice(vm.price && (vm.price.value || vm.price))
            });
          }

          // exact-ish shopping results
          for (const sr of (lensData.shopping_results || []).slice(0, 20)) {
            const link = sr.link || sr.product_link || '';
            if (!link) continue;
            lensResults.push({
              title: sr.title || '',
              link,
              source: sr.source || '',
              thumbnail: sr.thumbnail || '',
              price: normalizePrice(sr.extracted_price || sr.price)
            });
          }

          lensResults = sanitizeLensResults(lensResults);
          log.push(`lens:${lensResults.length}`);
        } else {
          log.push(`lens-fail:${lensRes.status}`);
        }
      } catch (e) {
        log.push('lens-err');
      }
    } else {
      if (!SERP_KEY) log.push('no-serp-key');
      if (!imageUrl) log.push('no-public-image-url');
    }

    // =========================================
    // STEP 3: OpenAI analyzes image + Lens candidates
    // =========================================
    const lensContext = lensContextString(lensResults);

    const openaiPrompt = `You are a precision visual shopping matcher for tablescapes, home decor, and interior design images.

You analyze ONE uploaded image plus a list of Google Lens candidates. Your job is to identify distinct shoppable items visible in the image, choose exact matches from Lens ONLY when they are truly the same item, and recommend extremely close replacements.

========================
PRIMARY OBJECTIVE
========================
Create a highly accurate shopping breakdown that:
1) Identifies ALL distinct shoppable item TYPES visible in the image (not every duplicate place setting).
2) Assigns an exact Google Lens match only when the visual evidence strongly supports it.
3) Provides 2-4 visually close replacement recommendations for EVERY identified item.
4) Preserves the original image's style, mood, materials, and details.

========================
CONTEXT YOU WILL RECEIVE
========================
- One image (tablescape or room/interior)
- A list of Google Lens candidate products with:
  - index number
  - title
  - source
  - link
  - thumbnail (sometimes)
  - price (sometimes)

IMPORTANT:
- Google Lens candidates are often noisy.
- Some candidates may be wrong object types.
- Some candidates may be close but not exact.
- Many visible items may have NO good Lens candidate.

========================
IMAGE SCANNING METHOD (MANDATORY)
========================
Before deciding matches, inspect the image systematically:

PASS 1 — OVERVIEW
- Determine scene type: tablescape / dining setup / bedroom / living room / nursery / etc.
- Identify dominant style (e.g., cottage, coastal, traditional, modern organic, grandmillennial, French country, etc.).
- Identify visible color palette and materials.

PASS 2 — STRUCTURAL SCAN
- Scan left-to-right
- Then right-to-left
- Then foreground-to-background
- Then background-to-foreground
This prevents missing items.

PASS 3 — ITEM-TYPE INVENTORY
Identify distinct shoppable item TYPES (not repeated duplicates).
Examples for tablescapes:
- tablecloth / runner
- placemat / charger
- dinner plate / salad plate / bowl
- napkin / napkin ring / ribbon tie
- flatware
- water glass / wine glass / coupe / goblet
- candlesticks / taper candles / votives
- vase / floral arrangement
- place card / place card holder
- centerpiece bowls / serving platters
- chairs (if distinctive and visible)

Examples for interiors:
- wallpaper / paint
- rug
- bed / bedding / pillows / throw
- sofa / chair / bench
- side table / dresser / console
- lamp / sconces / chandelier
- mirror / artwork
- curtains / shades / hardware
- decor objects (vases, trays, frames)

PASS 4 — PRIORITIZATION
Prioritize items that are:
- visually distinctive
- clearly visible
- likely shoppable
- important to the style

========================
ITEM COVERAGE RULES (VERY IMPORTANT)
========================
- Do NOT stop after finding only 1-2 items.
- For a typical styled tablescape, identify at least 6-12 distinct item types if visible.
- For a room design, identify at least 5-10 distinct item types if visible.
- Use a mix of categories (not only plates, not only decor).
- If an item is visible but exact match is unavailable, still include it with exact_match = null.
- Recommendations are REQUIRED for every item.

========================
EXACT MATCH RULES (STRICT)
========================
"Exact match" means the Google Lens product appears to be the same product OR extremely likely the same listing/variant.

Match in this order:
1) OBJECT TYPE must match first
2) SILHOUETTE / SHAPE
3) MATERIAL / FINISH
4) COLOR / PATTERN / DETAIL
5) PROPORTION / SCALE (when visible)

STRICT MATCHING RULES
- Never assign an exact match across different object types.
- Never assign an exact match based on color alone.
- If uncertain, set exact_match to null.
- Do not reuse the same Lens candidate for multiple items.
- If a Lens candidate is close but not exact, reject it and explain why in rejected_candidates.

========================
MATCH TYPE
========================
Use:
- "exact"   -> strong exact match selected from Lens
- "close"   -> a close Lens candidate exists but no confident exact match (exact_match should still be null)
- "none"    -> no useful Lens candidate for this item

IMPORTANT:
- exact_match is ONLY for true exact matches.
- If match_type is "close" or "none", exact_match should be null.

========================
RECOMMENDATION RULES (CRITICAL)
========================
For EVERY item, provide 2-4 recommendations that are visually CLOSE to the target item.
Recommendation quality matters more than variety.

Recommendations MUST mirror the target item's key attributes whenever possible:
- object type
- silhouette
- edge detail (e.g., scalloped, ruffled, beaded, straight)
- material
- finish (matte/glossy)
- color family
- pattern style/scale
- traditional vs modern feel
- casual vs formal feel

You may recommend from:
Anthropologie, Pottery Barn, Williams Sonoma, West Elm, Crate & Barrel, CB2,
Serena & Lily, McGee & Co, Rejuvenation, Schoolhouse, One Kings Lane, Arhaus,
Terrain, Lulu and Georgia, Burke Decor, Ballard Designs, Etsy, Chairish,
Target, Nordstrom, Bloomingdale's, Juliska, Vietri, Sur La Table, Food52,
Wayfair, Amazon, World Market, Replacements Ltd, East Fork, Heath Ceramics,
LTK, LikeToKnowIt, ShopMy, Google Shopping

If you are not certain of a direct product URL:
- Use a strong retailer search URL with a precise query.

========================
SEARCH URL RULES
========================
- Always include search_query
- Always include search_url when possible
- URL-encode spaces as %20
- If source-specific search page is unknown, use Google Shopping:
  https://www.google.com/search?tbm=shop&q=QUERY

========================
GOOGLE LENS CANDIDATES (EXACT MATCH SOURCE ONLY)
========================
Use the following Lens candidates ONLY for exact_match decisions.
Do not invent candidates. Do not invent lens_index.
Do not use the same lens_index for multiple items.

${lensContext}

========================
OUTPUT REQUIREMENTS
========================
Return ONLY valid JSON.
No markdown fences.
No extra commentary.
No trailing commas.
No duplicate item_ids.
Every item must include all required fields.

JSON SCHEMA (RETURN EXACTLY THIS TOP-LEVEL SHAPE)
{
  "item_matches": [
    {
      "item_id": "item_01",
      "item_name": "scalloped ceramic dinner plate",
      "match_type": "exact",
      "confidence": 93,
      "exact_match": {
        "lens_index": 4,
        "title": "Scalloped Stoneware Dinner Plate",
        "source": "Anthropologie",
        "link": "https://example.com/product",
        "thumbnail": "https://example.com/image.jpg",
        "price": 22
      },
      "evidence": [
        "Object type matches dinner plate",
        "Scalloped rim shape matches",
        "Creamy glazed ceramic finish matches"
      ],
      "rejected_candidates": [
        { "lens_index": 2, "reason": "Glassware, wrong object type" }
      ],
      "styling_tip": "Layer over a woven charger to emphasize the scalloped edge.",
      "recommendations": [
        {
          "title": "Scalloped stoneware dinner plate",
          "source": "Anthropologie",
          "search_query": "ivory scalloped stoneware dinner plate",
          "search_url": "https://www.anthropologie.com/search?q=ivory%20scalloped%20stoneware%20dinner%20plate",
          "estimated_price": 22,
          "why": "Matches the scalloped rim and creamy glazed finish"
        }
      ]
    }
  ],
  "colors": [
    { "name": "Warm Ivory", "brand": "Benjamin Moore", "code": "OC-95", "hex": "#F2EDE3" }
  ],
  "style_summary": "Romantic layered tablescape with soft neutrals, artisanal ceramics, and elevated cottage details."
}

========================
FIELD RULES
========================
- item_id: unique string like item_01, item_02, item_03 ...
- item_name: specific and descriptive
- match_type: exact | close | none
- confidence: integer 0-99
- exact_match: object only if match_type = exact, otherwise null
- evidence: 2-5 concise observations
- rejected_candidates: include useful rejections when relevant
- styling_tip: one practical styling tip
- recommendations: 2-4 visually close items

========================
FINAL SELF-CHECK (DO THIS BEFORE RESPONDING)
========================
- Did I identify enough distinct item types (not just one plate)?
- Did I include items even when exact match was unavailable?
- Did I avoid reusing Lens candidates?
- Did I prevent cross-object-type exact matches?
- Are recommendations truly visually close (not generic)?
- Is exact_match null whenever uncertain?
- Is the output valid JSON only?`;

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_KEY
      },
      body: JSON.stringify({
        model: 'gpt-5', // if your account doesn’t have this, swap to 'gpt-4o'
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a meticulous visual shopping matcher. Return only valid JSON.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: openaiPrompt
              },
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
      try {
        errText = await aiRes.text();
      } catch (e) {}

      // Better error for rate limits
      if (aiRes.status === 429) {
        return res.status(429).json({
          error: 'OpenAI failed: 429 (rate limit)',
          details: errText || 'Rate limit exceeded. Try again in a minute or reduce image size/requests.',
          log: log.join(' | '),
          lens_used: !!imageUrl,
          lens_total: lensResults.length
        });
      }

      return res.status(500).json({
        error: `OpenAI failed: ${aiRes.status}`,
        details: errText || '',
        log: log.join(' | '),
        lens_used: !!imageUrl,
        lens_total: lensResults.length
      });
    }

    const aiData = await aiRes.json();

    // Support different OpenAI response shapes safely
    let aiText = '';
    if (
      aiData &&
      aiData.choices &&
      aiData.choices[0] &&
      aiData.choices[0].message &&
      typeof aiData.choices[0].message.content === 'string'
    ) {
      aiText = aiData.choices[0].message.content;
    } else if (
      aiData &&
      aiData.choices &&
      aiData.choices[0] &&
      aiData.choices[0].message &&
      Array.isArray(aiData.choices[0].message.content)
    ) {
      aiText = aiData.choices[0].message.content
        .map((c) => (typeof c === 'string' ? c : c.text || ''))
        .join('\n');
    } else {
      throw new Error('Unexpected OpenAI response shape');
    }

    let parsed = parseOpenAIJson(aiText);
    parsed = ensureCoverageShape(parsed, lensResults);

    // Fill missing/invalid search URLs in recommendations
    if (Array.isArray(parsed.item_matches)) {
      for (const m of parsed.item_matches) {
        if (!Array.isArray(m.recommendations)) m.recommendations = [];
        for (const r of m.recommendations) {
          const q = String(r.search_query || r.title || m.item_name || '').trim();
          const s = String(r.source || '').trim();
          if (!r.search_query) r.search_query = q;
          if (!r.search_url) r.search_url = buildSearchUrl(s, q);
          if (r.estimated_price == null) r.estimated_price = 0;
        }

        // exact_match must be null unless exact
        if (m.match_type !== 'exact') {
          m.exact_match = null;
        }

        // Normalize confidence
        if (typeof m.confidence !== 'number') m.confidence = 0;
        m.confidence = Math.max(0, Math.min(99, Math.round(m.confidence)));

        // arrays
        if (!Array.isArray(m.evidence)) m.evidence = [];
        if (!Array.isArray(m.rejected_candidates)) m.rejected_candidates = [];
      }
    }

    const finalMapped = mapOutput(parsed, lensResults);

    log.push(`items:${finalMapped.items.length}`);

    return res.status(200).json({
      items: finalMapped.items,
      colors: finalMapped.colors,
      style_summary: finalMapped.style_summary,
      lens_used: !!imageUrl,
      lens_total: lensResults.length,
      log: log.join(' | ')
    });
  } catch (err) {
    return res.status(500).json({
      error: err && err.message ? err.message : 'Unknown error',
      log: log.join(' | ')
    });
  }
}
