export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' },
    maxDuration: 120
  }
};

/**
 * BEGINNER-FRIENDLY ANALYZE V2
 *
 * What it does:
 * 1) Detects all visible shoppable items in the image (AI vision)
 * 2) Uploads image (optional) to get a public URL for Google Lens
 * 3) Pulls visual matches + shopping candidates (SerpAPI)
 * 4) Verifies exact matches item-by-item (AI verification pass)
 * 5) Generates better "near exact" recommendations (AI recommendations pass)
 * 6) Returns a structured JSON response your frontend can render
 *
 * REQUIRED ENV VARS (in Vercel Project Settings → Environment Variables):
 * - OPENAI_API_KEY   (required)
 * - SERPAPI_KEY      (recommended for Google Lens + Shopping)
 *
 * OPTIONAL ENV VARS (for image hosting so Google Lens can see the uploaded image):
 * - FREEIMAGE_KEY
 * - IMGBB_KEY
 *
 * Optional:
 * - OPENAI_MODEL (default: gpt-4.1-mini)
 */

const ALLOWED_RETAILERS = [
  'Anthropologie', 'Pottery Barn', 'Williams Sonoma', 'West Elm', 'Crate & Barrel', 'CB2',
  'Serena & Lily', 'McGee & Co', 'Rejuvenation', 'Schoolhouse', 'One Kings Lane', 'Arhaus',
  'Terrain', 'Lulu and Georgia', 'Burke Decor', 'Ballard Designs', 'Etsy', 'Chairish',
  'Target', 'Nordstrom', 'Bloomingdale\'s', 'Juliska', 'Vietri', 'MacKenzie-Childs',
  'Sur La Table', 'Food52', 'Wayfair', 'Amazon', 'World Market', 'Replacements Ltd',
  'East Fork', 'Heath Ceramics', 'Minted', 'Ruggable', 'Loloi',
  // creator-commerce marketplaces user asked for
  'LTK', 'LikeToKnowIt', 'ShopMy'
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function normalizeString(s) {
  return String(s || '').trim();
}

function tryParseJson(text) {
  if (!text || typeof text !== 'string') return null;

  let t = text.trim();

  // Remove markdown fences
  t = t.replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/,'').trim();

  // Direct parse first
  try {
    return JSON.parse(t);
  } catch (_) {}

  // Try extracting the largest JSON object block
  const firstBrace = t.indexOf('{');
  const lastBrace = t.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const sliced = t.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(sliced);
    } catch (_) {}
  }

  // Truncation repair attempt (close braces/brackets)
  try {
    let fixed = t.replace(/,\s*$/, '');
    const opensB = (fixed.match(/{/g) || []).length;
    const closesB = (fixed.match(/}/g) || []).length;
    const opensA = (fixed.match(/\[/g) || []).length;
    const closesA = (fixed.match(/\]/g) || []).length;

    for (let i = 0; i < (opensA - closesA); i++) fixed += ']';
    for (let i = 0; i < (opensB - closesB); i++) fixed += '}';

    return JSON.parse(fixed);
  } catch (_) {
    return null;
  }
}

async function readJsonBody(req, res) {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    return body || {};
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return null;
  }
}

function makeSearchUrl(retailer, query) {
  const q = encodeURIComponent(query || '');
  const r = (retailer || '').toLowerCase();

  if (r.includes('anthropologie')) return `https://www.anthropologie.com/search?q=${q}`;
  if (r.includes('pottery')) return `https://www.potterybarn.com/search/results.html?words=${q}`;
  if (r.includes('williams')) return `https://www.williams-sonoma.com/search/results.html?words=${q}`;
  if (r.includes('west elm')) return `https://www.westelm.com/search/results.html?words=${q}`;
  if (r.includes('crate')) return `https://www.crateandbarrel.com/search?query=${q}`;
  if (r === 'cb2') return `https://www.cb2.com/search?query=${q}`;
  if (r.includes('target')) return `https://www.target.com/s?searchTerm=${q}`;
  if (r.includes('etsy')) return `https://www.etsy.com/search?q=${q}`;
  if (r.includes('amazon')) return `https://www.amazon.com/s?k=${q}`;
  if (r.includes('wayfair')) return `https://www.wayfair.com/keyword.php?keyword=${q}`;
  if (r.includes('serena')) return `https://www.serenaandlily.com/search?q=${q}`;
  if (r.includes('juliska')) return `https://www.juliska.com/search?type=product&q=${q}`;
  if (r.includes('sur la table')) return `https://www.surlatable.com/search/?q=${q}`;
  if (r.includes('food52')) return `https://food52.com/shop?query=${q}`;
  if (r.includes('ltk') || r.includes('liketoknowit')) return `https://www.shopltk.com/search?query=${q}`;
  if (r.includes('shopmy')) return `https://shopmy.us/search?q=${q}`;
  return `https://www.google.com/search?q=${q}`;
}

function scoreCandidateHeuristic(item, candidate) {
  // Light heuristic used only for fallback ordering, not exact verification.
  const itemName = (item?.name || '').toLowerCase();
  const candTitle = (candidate?.title || '').toLowerCase();
  const itemType = (item?.object_type || '').toLowerCase();

  let score = 0;

  if (itemType && candTitle.includes(itemType)) score += 25;

  // keyword overlap
  const words = itemName.split(/[^a-z0-9]+/i).filter(w => w.length > 2);
  const unique = [...new Set(words)];
  for (const w of unique) {
    if (candTitle.includes(w)) score += 5;
  }

  // shape/material/style hints
  const hints = [
    ...(item?.shape_keywords || []),
    ...(item?.material_keywords || []),
    ...(item?.color_keywords || [])
  ].map(x => String(x || '').toLowerCase());

  for (const h of hints) {
    if (h && candTitle.includes(h)) score += 4;
  }

  return score;
}

async function uploadImageForLens({ cleanImageB64, log, FREEIMAGE_KEY, IMGBB_KEY }) {
  let imageUrl = null;

  // Try freeimage.host first
  if (FREEIMAGE_KEY) {
    try {
      const form = new URLSearchParams();
      form.append('source', cleanImageB64);
      form.append('type', 'base64');
      form.append('action', 'upload');

      const r = await fetch(`https://freeimage.host/api/1/upload?key=${encodeURIComponent(FREEIMAGE_KEY)}`, {
        method: 'POST',
        body: form
      });

      if (r.ok) {
        const d = await r.json();
        if (d?.image?.url) {
          imageUrl = d.image.url;
          log.push('upload:freeimage');
        } else {
          log.push('freeimage:no-url');
        }
      } else {
        log.push(`freeimage-fail:${r.status}`);
      }
    } catch (e) {
      log.push('freeimage-err');
    }
  } else {
    log.push('freeimage:no-key');
  }

  // Backup: imgbb
  if (!imageUrl && IMGBB_KEY) {
    try {
      const form = new URLSearchParams();
      form.append('image', cleanImageB64);
      form.append('expiration', '600');

      const r = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(IMGBB_KEY)}`, {
        method: 'POST',
        body: form
      });

      if (r.ok) {
        const d = await r.json();
        if (d?.data?.url) {
          imageUrl = d.data.url;
          log.push('upload:imgbb');
        } else {
          log.push('imgbb:no-url');
        }
      } else {
        log.push(`imgbb-fail:${r.status}`);
      }
    } catch (e) {
      log.push('imgbb-err');
    }
  } else if (!imageUrl) {
    log.push('imgbb:no-key');
  }

  return imageUrl;
}

async function openAIChatJSON({ OPENAI_KEY, model, messages, maxTokens = 2500, log, tag }) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages
    })
  });

  if (!r.ok) {
    const errText = await r.text();
    log.push(`${tag || 'openai'}-fail:${r.status}`);
    throw new Error(`OpenAI failed: ${r.status} ${errText}`);
  }

  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const parsed = tryParseJson(text);

  if (!parsed) {
    log.push(`${tag || 'openai'}-json-parse-fail`);
    throw new Error('OpenAI returned invalid JSON');
  }

  log.push(`${tag || 'openai'}:ok`);
  return parsed;
}

async function serpGoogleLens({ SERP_KEY, imageUrl, log }) {
  if (!SERP_KEY || !imageUrl) return [];

  try {
    const params = new URLSearchParams({
      engine: 'google_lens',
      url: imageUrl,
      api_key: SERP_KEY,
      hl: 'en',
      country: 'us'
    });

    const r = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
    if (!r.ok) {
      log.push(`lens-fail:${r.status}`);
      return [];
    }

    const d = await r.json();
    const out = [];

    for (const vm of (d.visual_matches || []).slice(0, 40)) {
      if (!vm?.link) continue;
      out.push({
        id: `lens_vm_${out.length}`,
        source_type: 'lens_visual',
        title: vm.title || '',
        source: vm.source || '',
        link: vm.link || '',
        thumbnail: vm.thumbnail || '',
        price: vm.price?.value ? safeNum(vm.price.value) : safeNum(vm.price),
        raw: vm
      });
    }

    for (const sr of (d.shopping_results || []).slice(0, 20)) {
      const link = sr.product_link || sr.link;
      if (!link) continue;
      out.push({
        id: `lens_shop_${out.length}`,
        source_type: 'lens_shopping',
        title: sr.title || '',
        source: sr.source || '',
        link,
        thumbnail: sr.thumbnail || '',
        price: safeNum(sr.extracted_price),
        raw: sr
      });
    }

    log.push(`lens:${out.length}`);
    return out;
  } catch (e) {
    log.push('lens-err');
    return [];
  }
}

async function serpShoppingSearch({ SERP_KEY, query, log }) {
  if (!SERP_KEY || !query) return [];
  try {
    const params = new URLSearchParams({
      engine: 'google_shopping',
      q: query,
      api_key: SERP_KEY,
      num: '8',
      gl: 'us',
      hl: 'en'
    });
    const r = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
    if (!r.ok) {
      log.push(`shop-fail:${r.status}`);
      return [];
    }
    const d = await r.json();

    const results = (d.shopping_results || []).map((x, i) => ({
      id: `shop_${i}_${Math.random().toString(36).slice(2, 6)}`,
      source_type: 'shopping_search',
      title: x.title || '',
      source: x.source || '',
      link: x.product_link || x.link || '',
      thumbnail: x.thumbnail || '',
      price: safeNum(x.extracted_price),
      raw: x
    })).filter(x => x.link);

    log.push(`shop:${results.length}`);
    return results;
  } catch (e) {
    log.push('shop-err');
    return [];
  }
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates || []) {
    const key = (c.link || c.title || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function buildCandidatePoolForItem(item, lensCandidates, textSearchCandidates) {
  const combined = dedupeCandidates([...(lensCandidates || []), ...(textSearchCandidates || [])]);

  // Heuristic sort as a backup for no exact-match case
  combined.sort((a, b) => scoreCandidateHeuristic(item, b) - scoreCandidateHeuristic(item, a));
  return combined.slice(0, 20);
}

async function detectItemsPass({ OPENAI_KEY, model, imageDataUri, log }) {
  const system = `You are a visual product detection assistant for interior design and tablescape shopping.
Your job is to identify all SHoppABLE visible objects (not walls/floor unless a wallpaper/rug is a clear style feature).
Be exhaustive but avoid duplicates.
Separate overlapping items (e.g., charger plate + dinner plate + salad plate + napkin + napkin ring + glassware).`;

  const user = [
    {
      type: 'text',
      text:
`Analyze this photo and detect visible shoppable items.

Return ONLY JSON with this shape:
{
  "scene_summary": "short summary",
  "detected_items": [
    {
      "item_id": "item_01",
      "name": "specific name",
      "object_type": "plate|glass|napkin|vase|chair|lamp|wallpaper|rug|etc",
      "prominence": "hero|secondary|small",
      "quantity_estimate": 1,
      "color_keywords": ["white","green"],
      "material_keywords": ["ceramic","linen","glass","wood","brass"],
      "shape_keywords": ["scalloped","ribbed","coupe","fluted","round"],
      "pattern_keywords": ["striped","gingham","floral","solid"],
      "placement": "where it appears in the image",
      "notes": "what makes it identifiable"
    }
  ]
}

Rules:
- Include ALL visible tableware layers separately when possible.
- Include all visible glasses separately by type (water goblet vs wine glass).
- If there are multiple similar items, still list the object type at least once with quantity_estimate.
- Do not invent brand names.
- Do not include people, hands, food (unless the food vessel/platter itself is notable).`
    },
    {
      type: 'image_url',
      image_url: { url: imageDataUri }
    }
  ];

  const parsed = await openAIChatJSON({
    OPENAI_KEY,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    maxTokens: 2200,
    log,
    tag: 'detect'
  });

  if (!Array.isArray(parsed.detected_items)) parsed.detected_items = [];
  return parsed;
}

async function verifyExactMatchesPass({
  OPENAI_KEY,
  model,
  detectedItems,
  perItemCandidates,
  log
}) {
  const system = `You are a strict product matcher.
Your job is to choose ONLY true exact or near-exact matches from candidates.
You must reject candidates that are the wrong object type (e.g. glass vs plate).
You must avoid reusing the same candidate for multiple items.
If uncertain, return no exact match.`;

  const userText = `You are matching detected image items to search candidates.

Return ONLY JSON:
{
  "item_matches": [
    {
      "item_id": "item_01",
      "item_name": "name",
      "match_type": "exact|near_exact|none",
      "confidence": 0,
      "exact_match": {
        "candidate_id": "id",
        "title": "candidate title",
        "source": "source",
        "link": "url",
        "thumbnail": "url",
        "price": 0
      },
      "evidence": ["reason 1","reason 2"],
      "rejected_candidates": [
        {"candidate_id":"id","reason":"wrong object type"}
      ]
    }
  ]
}

Rules:
1) Candidate locking: a candidate_id can be used as exact_match for ONLY ONE item total.
2) First verify object type match (plate, glass, napkin, etc). If wrong type, reject.
3) "exact" = same object and style details align strongly.
4) "near_exact" = very close replacement if exact is unavailable.
5) If no valid match, use match_type "none" and exact_match null.
6) Be conservative and explain evidence.
7) Prefer candidates whose title explicitly mentions key cues (shape/pattern/material).
`;

  const payload = {
    detected_items: detectedItems.map(i => ({
      item_id: i.item_id,
      name: i.name,
      object_type: i.object_type,
      color_keywords: i.color_keywords || [],
      material_keywords: i.material_keywords || [],
      shape_keywords: i.shape_keywords || [],
      pattern_keywords: i.pattern_keywords || [],
      placement: i.placement || '',
      notes: i.notes || ''
    })),
    candidates_by_item: perItemCandidates
  };

  const parsed = await openAIChatJSON({
    OPENAI_KEY,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${userText}\n\nDATA:\n${JSON.stringify(payload)}` }
    ],
    maxTokens: 3200,
    log,
    tag: 'verify'
  });

  if (!Array.isArray(parsed.item_matches)) parsed.item_matches = [];
  return parsed;
}

function enforceCandidateLocking(itemMatches) {
  const used = new Set();
  const out = [];

  for (const m of itemMatches || []) {
    const clone = { ...m };
    const cid = clone?.exact_match?.candidate_id;

    if (cid && used.has(cid)) {
      // If already used, downgrade to none
      clone.match_type = 'none';
      clone.confidence = Math.min(safeNum(clone.confidence, 0), 40);
      clone.evidence = [...(clone.evidence || []), 'Candidate lock conflict: candidate was already assigned to another item'];
      clone.rejected_candidates = [
        ...(clone.rejected_candidates || []),
        { candidate_id: cid, reason: 'Candidate already used by another item' }
      ];
      clone.exact_match = null;
    } else if (cid) {
      used.add(cid);
    }

    out.push(clone);
  }

  return out;
}

async function recommendationsPass({
  OPENAI_KEY,
  model,
  sceneSummary,
  detectedItems,
  itemMatches,
  perItemCandidates,
  log
}) {
  const system = `You are a luxury shopping stylist.
Generate recommendations that are CLOSE to the matched item (shape, material, color, vibe).
When exact match exists, recommendations should feel like sister products, not random alternatives.`;

  const userText = `Create recommendation sets for each detected item.

Return ONLY JSON:
{
  "recommendations_by_item": [
    {
      "item_id": "item_01",
      "recommended_items": [
        {
          "title": "product name",
          "source": "Retailer",
          "search_url": "https://...",
          "estimated_price": 0,
          "why": "why this is close in shape/color/material"
        }
      ]
    }
  ]
}

Rules:
- 2 to 4 recommendations per item if possible.
- Prioritize: ${ALLOWED_RETAILERS.join(', ')}.
- Include LTK / LikeToKnowIt and ShopMy when relevant.
- Stay very close to the item style, especially if an exact/near-exact match exists.
- If item is highly specific, prefer fewer but better recommendations.
- Use real retailer names and valid search URLs (site search URLs are okay).
`;

  const compact = {
    scene_summary: sceneSummary || '',
    detected_items: detectedItems.map(i => ({
      item_id: i.item_id,
      name: i.name,
      object_type: i.object_type,
      color_keywords: i.color_keywords || [],
      material_keywords: i.material_keywords || [],
      shape_keywords: i.shape_keywords || [],
      pattern_keywords: i.pattern_keywords || []
    })),
    item_matches: itemMatches.map(m => ({
      item_id: m.item_id,
      item_name: m.item_name,
      match_type: m.match_type,
      confidence: m.confidence,
      exact_match: m.exact_match
    })),
    candidate_titles_by_item: perItemCandidates.map(x => ({
      item_id: x.item_id,
      candidates: (x.candidates || []).slice(0, 8).map(c => ({
        title: c.title,
        source: c.source,
        price: c.price
      }))
    }))
  };

  const parsed = await openAIChatJSON({
    OPENAI_KEY,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${userText}\n\nDATA:\n${JSON.stringify(compact)}` }
    ],
    maxTokens: 2600,
    log,
    tag: 'recs'
  });

  if (!Array.isArray(parsed.recommendations_by_item)) parsed.recommendations_by_item = [];
  return parsed;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const SERP_KEY = process.env.SERPAPI_KEY;
  const FREEIMAGE_KEY = process.env.FREEIMAGE_KEY;
  const IMGBB_KEY = process.env.IMGBB_KEY;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

  if (!OPENAI_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  }

  const body = await readJsonBody(req, res);
  if (!body) return;

  let image = body.image;
  let mediaType = body.mediaType || 'image/jpeg';
  const log = [];

  if (!image) return res.status(400).json({ error: 'No image provided' });

  const cleanImage = String(image).replace(/^data:image\/\w+;base64,/, '').trim();
  const imageDataUri = `data:${mediaType};base64,${cleanImage}`;

  try {
    // ─────────────────────────────────────────────
    // PASS 1: DETECTION (AI Vision)
    // ─────────────────────────────────────────────
    const detection = await detectItemsPass({
      OPENAI_KEY,
      model: OPENAI_MODEL,
      imageDataUri,
      log
    });

    const scene_summary = normalizeString(detection.scene_summary || '');
    let detected_items = Array.isArray(detection.detected_items) ? detection.detected_items : [];

    // Safety cleanup + item_ids
    detected_items = detected_items
      .filter(Boolean)
      .map((it, idx) => ({
        item_id: it.item_id || `item_${String(idx + 1).padStart(2, '0')}`,
        name: normalizeString(it.name || `Item ${idx + 1}`),
        object_type: normalizeString(it.object_type || 'object'),
        prominence: normalizeString(it.prominence || 'secondary'),
        quantity_estimate: Math.max(1, safeNum(it.quantity_estimate, 1)),
        color_keywords: Array.isArray(it.color_keywords) ? it.color_keywords.map(String) : [],
        material_keywords: Array.isArray(it.material_keywords) ? it.material_keywords.map(String) : [],
        shape_keywords: Array.isArray(it.shape_keywords) ? it.shape_keywords.map(String) : [],
        pattern_keywords: Array.isArray(it.pattern_keywords) ? it.pattern_keywords.map(String) : [],
        placement: normalizeString(it.placement || ''),
        notes: normalizeString(it.notes || '')
      }));

    log.push(`detected:${detected_items.length}`);

    if (detected_items.length === 0) {
      return res.status(200).json({
        scene_summary,
        detected_items: [],
        item_matches: [],
        unmatched_items: [],
        lens_used: false,
        lens_total: 0,
        log: log.join(' | ')
      });
    }

    // ─────────────────────────────────────────────
    // STEP 2: Upload image (optional) for Google Lens
    // ─────────────────────────────────────────────
    const imageUrl = await uploadImageForLens({
      cleanImageB64: cleanImage,
      log,
      FREEIMAGE_KEY,
      IMGBB_KEY
    });

    // ─────────────────────────────────────────────
    // STEP 3: Candidate search (Google Lens + Shopping text search per item)
    // ─────────────────────────────────────────────
    const lensCandidates = await serpGoogleLens({
      SERP_KEY,
      imageUrl,
      log
    });

    const perItemCandidates = [];
    for (const item of detected_items) {
      // Build stronger search query from item attributes
      const queryParts = [
        item.name,
        ...(item.shape_keywords || []).slice(0, 2),
        ...(item.material_keywords || []).slice(0, 2),
        ...(item.color_keywords || []).slice(0, 2)
      ].filter(Boolean);

      const query = queryParts.join(' ').replace(/\s+/g, ' ').trim();

      const shoppingCandidates = SERP_KEY
        ? await serpShoppingSearch({ SERP_KEY, query, log })
        : [];

      const combined = buildCandidatePoolForItem(item, lensCandidates, shoppingCandidates);

      perItemCandidates.push({
        item_id: item.item_id,
        item_name: item.name,
        candidates: combined.map(c => ({
          candidate_id: c.id,
          title: c.title,
          source: c.source,
          link: c.link,
          thumbnail: c.thumbnail,
          price: c.price,
          source_type: c.source_type
        }))
      });

      // Small delay for SerpAPI rate friendliness
      if (SERP_KEY) await sleep(150);
    }

    // ─────────────────────────────────────────────
    // STEP 4: Exact verification pass (AI)
    // ─────────────────────────────────────────────
    let verify = await verifyExactMatchesPass({
      OPENAI_KEY,
      model: OPENAI_MODEL,
      detectedItems: detected_items,
      perItemCandidates,
      log
    });

    let item_matches = Array.isArray(verify.item_matches) ? verify.item_matches : [];

    // Normalize + enforce candidate locking server-side (extra safety)
    item_matches = item_matches.map(m => ({
      item_id: normalizeString(m.item_id),
      item_name: normalizeString(m.item_name),
      match_type: ['exact', 'near_exact', 'none'].includes(m.match_type) ? m.match_type : 'none',
      confidence: Math.max(0, Math.min(100, safeNum(m.confidence, 0))),
      exact_match: m.exact_match ? {
        candidate_id: normalizeString(m.exact_match.candidate_id),
        title: normalizeString(m.exact_match.title),
        source: normalizeString(m.exact_match.source),
        link: normalizeString(m.exact_match.link),
        thumbnail: normalizeString(m.exact_match.thumbnail),
        price: safeNum(m.exact_match.price, 0)
      } : null,
      evidence: Array.isArray(m.evidence) ? m.evidence.map(String).slice(0, 6) : [],
      rejected_candidates: Array.isArray(m.rejected_candidates) ? m.rejected_candidates.slice(0, 8) : []
    }));

    item_matches = enforceCandidateLocking(item_matches);

    // Fallback if verification omitted some items
    const matchedIds = new Set(item_matches.map(m => m.item_id));
    for (const item of detected_items) {
      if (matchedIds.has(item.item_id)) continue;

      const pool = perItemCandidates.find(x => x.item_id === item.item_id)?.candidates || [];
      const top = pool[0];

      item_matches.push({
        item_id: item.item_id,
        item_name: item.name,
        match_type: 'none',
        confidence: 0,
        exact_match: null,
        evidence: ['No verified exact/near-exact match returned from verification pass'],
        rejected_candidates: top ? [] : [{ candidate_id: '', reason: 'No candidates found' }]
      });
    }

    // ─────────────────────────────────────────────
    // STEP 5: Recommendations pass (AI)
    // ─────────────────────────────────────────────
    let recs = { recommendations_by_item: [] };
    try {
      recs = await recommendationsPass({
        OPENAI_KEY,
        model: OPENAI_MODEL,
        sceneSummary: scene_summary,
        detectedItems: detected_items,
        itemMatches: item_matches,
        perItemCandidates,
        log
      });
    } catch (e) {
      log.push('recs:fallback');
      recs = { recommendations_by_item: [] };
    }

    const recMap = new Map();
    for (const r of (recs.recommendations_by_item || [])) {
      const arr = Array.isArray(r.recommended_items) ? r.recommended_items : [];
      recMap.set(r.item_id, arr);
    }

    // Final merged result
    const finalItemMatches = item_matches.map(m => {
      const item = detected_items.find(x => x.item_id === m.item_id);
      const perItem = perItemCandidates.find(x => x.item_id === m.item_id);
      const candidatePool = perItem?.candidates || [];

      // If no exact match, provide a fallback "best candidate" preview (not exact)
      let fallback_candidate = null;
      if (!m.exact_match && candidatePool.length > 0) {
        const c = candidatePool[0];
        fallback_candidate = {
          candidate_id: c.candidate_id,
          title: c.title,
          source: c.source,
          link: c.link,
          thumbnail: c.thumbnail,
          price: c.price,
          note: 'Top search candidate (not verified exact)'
        };
      }

      const recommendationsRaw = (recMap.get(m.item_id) || []).slice(0, 4);
      const recommendations = recommendationsRaw.map((x) => {
        const source = normalizeString(x.source || 'Shop');
        const title = normalizeString(x.title || item?.name || 'Recommended item');
        const searchQuery = title;
        return {
          title,
          source,
          search_url: normalizeString(x.search_url || makeSearchUrl(source, searchQuery)),
          estimated_price: safeNum(x.estimated_price, 0),
          why: normalizeString(x.why || 'Similar overall style and proportions')
        };
      });

      return {
        ...m,
        detected_item: item || null,
        fallback_candidate,
        recommendations
      };
    });

    const unmatched_items = finalItemMatches
      .filter(m => m.match_type === 'none')
      .map(m => ({
        item_id: m.item_id,
        item_name: m.item_name,
        reason: (m.evidence && m.evidence[0]) || 'No verified match found',
        fallback_candidate: m.fallback_candidate || null
      }));

    return res.status(200).json({
      scene_summary,
      detected_items,
      item_matches: finalItemMatches,
      unmatched_items,
      lens_used: !!imageUrl,
      lens_total: lensCandidates.length,
      log: log.join(' | ')
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Analyze failed',
      log: log.join(' | ')
    });
  }
}
