export const config = {
  api: {
    bodyParser: { sizeLimit: '12mb' },
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

  const cleanImage = String(image).replace(/^data:image\/\w+;base64,/, '');
  const log = [];

  try {
    // ============================================================
    // STEP 0: Upload image (needed for Google Lens / SerpAPI)
    // ============================================================
    let uploadedImageUrl = null;
    if (SERP_KEY) {
      uploadedImageUrl = await uploadForLens(cleanImage, log);
    } else {
      log.push('SERPAPI_KEY missing (lens disabled)');
    }

    // ============================================================
    // STEP 1: PASS 1 — DETECTION ONLY (OpenAI Vision)
    // ============================================================
    const detectionPrompt = buildDetectionPrompt();
    const detection = await openAIJsonWithImage({
      apiKey: OPENAI_KEY,
      imageBase64: cleanImage,
      mediaType,
      prompt: detectionPrompt,
      maxTokens: 3500,
      log,
      stageName: 'detect'
    });

    const detectedItems = Array.isArray(detection?.items) ? detection.items : [];
    log.push(`detect_items:${detectedItems.length}`);

    // ============================================================
    // STEP 2: Google Lens candidates (global + per-item)
    // ============================================================
    let globalLensResults = [];
    if (SERP_KEY && uploadedImageUrl) {
      globalLensResults = await runGoogleLens(uploadedImageUrl, SERP_KEY, log);
    }

    // Search shopping per detected item to improve exact-match coverage
    const perItemCandidates = {};
    if (SERP_KEY && detectedItems.length > 0) {
      for (const item of detectedItems.slice(0, 20)) {
        const q = item.search_query || item.item_name || item.visual_description || '';
        if (!q) continue;
        const key = item.item_id || item.item_name || `item_${Object.keys(perItemCandidates).length + 1}`;
        const results = await runGoogleShopping(q, SERP_KEY, log);
        perItemCandidates[key] = results.slice(0, 10);
        await sleep(120);
      }
    }

    // ============================================================
    // STEP 3: PASS 2 — MATCHING + SIMILAR RECOMMENDATIONS
    // ============================================================
    const matchingPrompt = buildMatchingPrompt({
      detectedItems,
      globalLensResults,
      perItemCandidates
    });

    const matching = await openAIJsonWithImage({
      apiKey: OPENAI_KEY,
      imageBase64: cleanImage,
      mediaType,
      prompt: matchingPrompt,
      maxTokens: 6000,
      log,
      stageName: 'match'
    });

    // ============================================================
    // STEP 4: Normalize final response
    // ============================================================
    const normalized = normalizeOutput({
      detection,
      matching,
      globalLensResults,
      perItemCandidates
    });

    return res.status(200).json({
      ...normalized,
      lens_used: !!uploadedImageUrl,
      lens_total: globalLensResults.length,
      log: log.join(' | ')
    });

  } catch (err) {
    return res.status(500).json({
      error: err?.message || 'Unknown error',
      log: log.join(' | ')
    });
  }
}

/* ====================================================================== */
/* HELPERS */
/* ====================================================================== */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadForLens(cleanImage, log) {
  // Try freeimage.host first
  try {
    const form = new URLSearchParams();
    form.append('source', cleanImage);
    form.append('type', 'base64');
    form.append('action', 'upload');

    const r = await fetch('https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5', {
      method: 'POST',
      body: form
    });

    if (r.ok) {
      const d = await r.json();
      const url = d?.image?.url || null;
      if (url) {
        log.push('upload:freeimage');
        return url;
      }
    } else {
      log.push(`freeimage-fail:${r.status}`);
    }
  } catch (e) {
    log.push('freeimage-err');
  }

  // Fallback: imgbb
  try {
    const form = new URLSearchParams();
    form.append('image', cleanImage);
    form.append('expiration', '900');

    const r = await fetch('https://api.imgbb.com/1/upload?key=5e87bda0a1f4270c0813577d712e84e0', {
      method: 'POST',
      body: form
    });

    if (r.ok) {
      const d = await r.json();
      const url = d?.data?.url || null;
      if (url) {
        log.push('upload:imgbb');
        return url;
      }
    } else {
      log.push(`imgbb-fail:${r.status}`);
    }
  } catch (e) {
    log.push('imgbb-err');
  }

  log.push('upload:none');
  return null;
}

async function runGoogleLens(imageUrl, serpKey, log) {
  try {
    const p = new URLSearchParams({
      engine: 'google_lens',
      url: imageUrl,
      api_key: serpKey,
      hl: 'en',
      country: 'us'
    });

    const r = await fetch('https://serpapi.com/search.json?' + p.toString());
    if (!r.ok) {
      log.push(`lens-fail:${r.status}`);
      return [];
    }

    const d = await r.json();
    const out = [];

    // visual_matches
    for (const vm of (d.visual_matches || []).slice(0, 40)) {
      const link = vm.link || vm.product_link || '';
      if (!link) continue;
      out.push({
        source_type: 'google_lens_visual',
        title: vm.title || '',
        source: vm.source || '',
        link,
        thumbnail: vm.thumbnail || '',
        price: parsePrice(vm.price),
        raw: {
          position: vm.position ?? null
        }
      });
    }

    // shopping_results
    for (const sr of (d.shopping_results || []).slice(0, 20)) {
      const link = sr.product_link || sr.link || '';
      if (!link) continue;
      out.push({
        source_type: 'google_lens_shopping',
        title: sr.title || '',
        source: sr.source || '',
        link,
        thumbnail: sr.thumbnail || '',
        price: parsePrice(sr.extracted_price ?? sr.price),
        raw: {
          position: sr.position ?? null
        }
      });
    }

    log.push(`lens:${out.length}`);
    return out;
  } catch (e) {
    log.push('lens-err');
    return [];
  }
}

async function runGoogleShopping(query, serpKey, log) {
  try {
    const params = new URLSearchParams({
      engine: 'google_shopping',
      q: query,
      api_key: serpKey,
      num: '8',
      gl: 'us',
      hl: 'en'
    });

    const r = await fetch('https://serpapi.com/search.json?' + params.toString());
    if (!r.ok) {
      log.push(`shop-fail:${r.status}`);
      return [];
    }

    const d = await r.json();
    const results = (d.shopping_results || []).map((it, idx) => ({
      source_type: 'google_shopping',
      title: it.title || '',
      source: it.source || '',
      link: it.product_link || it.link || '',
      thumbnail: it.thumbnail || '',
      price: parsePrice(it.extracted_price ?? it.price),
      position: idx,
      query
    })).filter(x => x.link);

    log.push(`shop:${query.substring(0, 28)}:${results.length}`);
    return results;
  } catch (e) {
    log.push('shop-err');
    return [];
  }
}

function parsePrice(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const m = value.replace(/,/g, '').match(/(\d+(\.\d+)?)/);
    return m ? Number(m[1]) : 0;
  }
  return 0;
}

async function openAIJsonWithImage({
  apiKey,
  imageBase64,
  mediaType,
  prompt,
  maxTokens = 3000,
  log,
  stageName = 'openai'
}) {
  // Retry once on 429
  const modelsToTry = ['gpt-4o', 'gpt-4o-mini'];

  let lastErrText = '';
  let lastStatus = null;

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You are a precise product-identification assistant. Return valid JSON only.'
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mediaType};base64,${imageBase64}`,
                    detail: 'high'
                  }
                }
              ]
            }
          ]
        })
      });

      if (r.ok) {
        const data = await r.json();
        const text = data?.choices?.[0]?.message?.content || '{}';
        try {
          const parsed = JSON.parse(stripCodeFences(text));
          log.push(`${stageName}:${model}:ok`);
          return parsed;
        } catch (e) {
          const repaired = repairJson(text);
          try {
            const parsed = JSON.parse(repaired);
            log.push(`${stageName}:${model}:repaired`);
            return parsed;
          } catch (e2) {
            lastErrText = 'Could not parse JSON from OpenAI';
            lastStatus = 500;
          }
        }
      } else {
        lastStatus = r.status;
        lastErrText = await safeText(r);
        log.push(`${stageName}:${model}:fail:${r.status}`);

        if (r.status === 429 && attempt === 1) {
          await sleep(900);
          continue;
        }
      }

      // break retry loop for non-429
      if (lastStatus !== 429) break;
    }
  }

  throw new Error(`OpenAI failed: ${lastStatus || ''} ${truncate(lastErrText, 200)}`.trim());
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

function repairJson(text) {
  let s = stripCodeFences(text);

  // remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');

  // if model added prose before/after JSON, try extract largest object
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);

  // balance braces/brackets
  const openCurly = (s.match(/{/g) || []).length;
  const closeCurly = (s.match(/}/g) || []).length;
  const openSquare = (s.match(/\[/g) || []).length;
  const closeSquare = (s.match(/\]/g) || []).length;

  for (let i = 0; i < openSquare - closeSquare; i++) s += ']';
  for (let i = 0; i < openCurly - closeCurly; i++) s += '}';

  return s;
}

async function safeText(r) {
  try { return await r.text(); } catch { return ''; }
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ====================================================================== */
/* PROMPTS */
/* ====================================================================== */

function buildDetectionPrompt() {
  return `
You are a meticulous visual product identifier for tablescapes and interior design photos.

Your job is to identify ALL visible shoppable objects in the image BEFORE attempting any matching.

IMPORTANT DETECTION RULES:
1) Do a full visual inventory FIRST. Do not skip small, reflective, transparent, or partially occluded items.
2) Tablescapes often contain layered place settings:
   - charger / underplate
   - dinner plate
   - salad plate
   These may be stacked. Treat them as SEPARATE items when visible.
3) Glassware is often transparent and reflective. Look carefully for:
   - rims
   - stems
   - bowls of glasses
   - repeated place settings
4) If an item is visible but uncertain, still include it with lower confidence.
5) Never merge different object types into one item (e.g., plate + napkin).
6) Prioritize repeated objects (same item repeated at multiple seats).

WORK IN THIS ORDER:
STEP A: Visual inventory by category (count what appears)
STEP B: Create item list with one row per distinct shoppable item type visible
STEP C: Include a search-friendly description for each item

Return ONLY valid JSON in this exact shape:
{
  "visual_inventory": {
    "plates_chargers_bowls_count_estimate": 0,
    "glassware_count_estimate": 0,
    "flatware_count_estimate": 0,
    "linens_count_estimate": 0,
    "centerpiece_florals_count_estimate": 0,
    "candles_lighting_count_estimate": 0,
    "decorative_accents_count_estimate": 0
  },
  "items": [
    {
      "item_id": "item_01",
      "item_name": "scalloped ceramic dinner plate",
      "category": "Dinnerware",
      "object_type": "plate",
      "visible_count_estimate": 6,
      "is_layered_item": true,
      "detection_confidence": 93,
      "visual_description": "cream/off-white ceramic dinner plate with scalloped rim and glossy glaze",
      "search_query": "scalloped ceramic dinner plate cream"
    }
  ],
  "style_summary": "brief description of visual style and palette"
}

FINAL SELF-CHECK BEFORE RETURNING JSON:
- Did you identify layered plates/chargers separately if visible?
- Did you identify ALL visible glasses (including clear glasses)?
- Did you include visible items even if uncertain?
`;
}

function buildMatchingPrompt({ detectedItems, globalLensResults, perItemCandidates }) {
  const lensCompact = globalLensResults.slice(0, 80).map((r, i) => ({
    lens_index: i,
    title: r.title,
    source: r.source,
    link: r.link,
    thumbnail: r.thumbnail,
    price: r.price,
    source_type: r.source_type
  }));

  // Flatten per-item candidates into a compact structure
  const itemCandidates = {};
  for (const [itemKey, list] of Object.entries(perItemCandidates || {})) {
    itemCandidates[itemKey] = (list || []).slice(0, 10).map((r, i) => ({
      candidate_index: i,
      title: r.title,
      source: r.source,
      link: r.link,
      thumbnail: r.thumbnail,
      price: r.price,
      query: r.query
    }));
  }

  const payload = {
    detected_items: detectedItems,
    global_lens_candidates: lensCompact,
    per_item_shopping_candidates: itemCandidates
  };

  return `
You are matching detected objects in an image to shopping candidates.

You are given:
1) A DETECTED ITEM LIST from pass 1 (this is the source of truth for which items must be returned)
2) Google Lens visual/shopping candidates (global)
3) Per-item Google Shopping candidates (more exact for each item)

CRITICAL GOAL:
- Return ALL detected items, even if no exact match exists.
- Do NOT drop items.
- Transparent glassware and layered plates are especially important.

MATCHING RULES:
1) exact_match must be the SAME object type (plate != glass, napkin != plate)
2) Shape/silhouette match is required (e.g., scalloped rim, coupe stem, goblet shape)
3) Material/finish/color/pattern should be reasonably close
4) If not a true exact replacement, set exact_match to null
5) Each exact match candidate should be used only once across DIFFERENT item types unless clearly same repeated product
6) Prefer exact replacements from ANY source if visually correct
7) Similar recommendations should be visually close to the detected item

For similar_items, you may include search links from any retailer ecosystem (including LTK / ShopMy linked stores) using search URLs if exact PDP URL is not known.

Return ONLY valid JSON in this exact shape:
{
  "item_matches": [
    {
      "item_id": "item_01",
      "item_name": "scalloped ceramic dinner plate",
      "category": "Dinnerware",
      "object_type": "plate",
      "visible_count_estimate": 6,
      "match_type": "exact|near|none",
      "detection_confidence": 93,
      "match_confidence": 88,
      "exact_match": {
        "source_group": "global_lens|per_item_shopping",
        "lens_index": 4,
        "candidate_index": null,
        "title": "Scalloped Stoneware Dinner Plate",
        "source": "Anthropologie",
        "link": "https://example.com",
        "thumbnail": "https://example.com/image.jpg",
        "price": 24
      },
      "evidence": [
        "Object type matches dinner plate",
        "Scalloped rim shape matches",
        "Color and finish are visually consistent"
      ],
      "why_no_exact_match": "",
      "rejected_candidates": [
        { "candidate_ref": "global_lens:2", "reason": "Glassware, wrong object type" }
      ],
      "styling_tip": "brief styling tip",
      "similar_items": [
        {
          "title": "Scalloped dinner plate search",
          "source": "Anthropologie",
          "search_url": "https://www.anthropologie.com/search?q=scalloped%20dinner%20plate",
          "estimated_price": 24,
          "why": "Similar scalloped silhouette and glazed finish"
        },
        {
          "title": "Scalloped dinner plate search",
          "source": "Pottery Barn",
          "search_url": "https://www.potterybarn.com/search/results.html?words=scalloped%20dinner%20plate",
          "estimated_price": 28,
          "why": "Comparable shape and classic tablescape feel"
        }
      ]
    }
  ],
  "colors": [
    { "name": "Warm Ivory", "brand": "", "code": "", "hex": "#F4EDE1" }
  ],
  "style_summary": "brief style description"
}

IMPORTANT:
- Return one object in item_matches for EVERY detected item.
- If you cannot exactly match an item, exact_match must be null and match_type = "none" or "near".
- Do not invent exact-match URLs if not in the provided candidates.

DATA:
${JSON.stringify(payload)}
`;
}

/* ====================================================================== */
/* NORMALIZATION */
/* ====================================================================== */

function normalizeOutput({ detection, matching, globalLensResults, perItemCandidates }) {
  const detected = Array.isArray(detection?.items) ? detection.items : [];
  const matches = Array.isArray(matching?.item_matches) ? matching.item_matches : [];

  const matchById = new Map(matches.map(m => [m.item_id, m]));

  const items = detected.map((d, idx) => {
    const m = matchById.get(d.item_id) || null;
    const products = [];

    // Exact match first
    if (m?.exact_match && m.exact_match.link) {
      products.push({
        title: m.exact_match.title || '',
        source: m.exact_match.source || '',
        link: m.exact_match.link || '',
        thumbnail: m.exact_match.thumbnail || '',
        price: Number(m.exact_match.price || 0),
        isExact: true
      });
    }

    // Similar items
    for (const s of (m?.similar_items || []).slice(0, 6)) {
      products.push({
        title: s.title || '',
        source: s.source || '',
        link: s.search_url || '',
        thumbnail: '',
        price: Number(s.estimated_price || 0),
        isExact: false,
        why: s.why || ''
      });
    }

    return {
      item_id: d.item_id || `item_${String(idx + 1).padStart(2, '0')}`,
      name: d.item_name || 'Item',
      category: d.category || '',
      object_type: d.object_type || '',
      order: idx + 1,
      visible_count_estimate: Number(d.visible_count_estimate || 1),
      is_layered_item: !!d.is_layered_item,
      detection_confidence: Number(d.detection_confidence || 0),
      match_type: m?.match_type || 'none',
      match_confidence: Number(m?.match_confidence || 0),
      styling_tip: m?.styling_tip || '',
      visual_description: d.visual_description || '',
      exactCount: m?.exact_match?.link ? 1 : 0,
      exact_match: m?.exact_match || null,
      evidence: Array.isArray(m?.evidence) ? m.evidence : [],
      why_no_exact_match: m?.why_no_exact_match || '',
      rejected_candidates: Array.isArray(m?.rejected_candidates) ? m.rejected_candidates : [],
      products
    };
  });

  // If matching dropped items, keep them anyway (already handled by using detection list as source of truth)
  return {
    items,
    colors: Array.isArray(matching?.colors) ? matching.colors : [],
    style_summary: matching?.style_summary || detection?.style_summary || '',
    visual_inventory: detection?.visual_inventory || {},
    debug: {
      detected_items: detected.length,
      matched_items: matches.length,
      global_lens_candidates: Array.isArray(globalLensResults) ? globalLensResults.length : 0,
      per_item_candidate_groups: Object.keys(perItemCandidates || {}).length
    }
  };
}
