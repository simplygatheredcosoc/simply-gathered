export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' },
    maxDuration: 120
  }
};

/**
 * ANALYZE V3 (single-file, beginner-friendly)
 *
 * Improvements vs prior version:
 * - Better exact-match verification structure
 * - Better fallback behavior when OpenAI/SerpAPI returns partial data
 * - "Style anchor" recommendations:
 *   If an exact/near-exact match exists, recommendations are derived from the exact match title/source first
 *   so results stay much closer to the original item (instead of generic green alternatives)
 * - Includes LTK / LikeToKnowIt / ShopMy in recommendation targets
 *
 * REQUIRED ENV VARS (Vercel Project Settings → Environment Variables):
 * - OPENAI_API_KEY   (required)
 * - SERPAPI_KEY      (recommended)
 *
 * OPTIONAL ENV VARS (image hosting so Google Lens can analyze uploaded image):
 * - FREEIMAGE_KEY
 * - IMGBB_KEY
 *
 * OPTIONAL:
 * - OPENAI_MODEL (default: gpt-4.1-mini)
 */

const ALLOWED_RETAILERS = [
  'Anthropologie', 'Pottery Barn', 'Williams Sonoma', 'West Elm', 'Crate & Barrel', 'CB2',
  'Serena & Lily', 'McGee & Co', 'Rejuvenation', 'Schoolhouse', 'One Kings Lane', 'Arhaus',
  'Terrain', 'Lulu and Georgia', 'Burke Decor', 'Ballard Designs', 'Etsy', 'Chairish',
  'Target', 'Nordstrom', "Bloomingdale's", 'Juliska', 'Vietri', 'MacKenzie-Childs',
  'Sur La Table', 'Food52', 'Wayfair', 'Amazon', 'World Market', 'Replacements Ltd',
  'East Fork', 'Heath Ceramics', 'Minted', 'Ruggable', 'Loloi',
  'LTK', 'LikeToKnowIt', 'ShopMy'
];

const PREMIUM_TABLETOP_BRANDS = [
  'Carolina Irving & Daughters', 'Carolina Irving and Daughters', 'Juliska', 'Vietri',
  'Ginori', 'Ginori 1735', 'Herend', 'Bernardaud', 'Wedgwood', 'Waterford',
  'MacKenzie-Childs', 'Lenox', 'Spode', 'Williams Sonoma', 'Anthropologie',
  'Sur La Table', 'Replacements Ltd', 'Chairish', 'Etsy'
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

function uniqueStrings(arr) {
  return [...new Set((arr || []).map(x => String(x || '').trim()).filter(Boolean))];
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function tryParseJson(text) {
  if (!text || typeof text !== 'string') return null;

  let t = text.trim();

  // Remove markdown fences
  t = t.replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/,'').trim();

  // Direct parse
  try { return JSON.parse(t); } catch (_) {}

  // Extract largest JSON object block
  const firstBrace = t.indexOf('{');
  const lastBrace = t.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const sliced = t.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(sliced); } catch (_) {}
  }

  // Truncation repair
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
  if (r.includes('vietri')) return `https://vietri.com/search?q=${q}`;
  if (r.includes('sur la table')) return `https://www.surlatable.com/search/?q=${q}`;
  if (r.includes('food52')) return `https://food52.com/shop?query=${q}`;
  if (r.includes('replacements')) return `https://www.replacements.com/search?query=${q}`;
  if (r.includes('chairish')) return `https://www.chairish.com/search?q=${q}`;
  if (r.includes('ltk') || r.includes('liketoknowit')) return `https://www.shopltk.com/search?query=${q}`;
  if (r.includes('shopmy')) return `https://shopmy.us/search?q=${q}`;
  return `https://www.google.com/search?q=${q}`;
}

function scoreCandidateHeuristic(item, candidate) {
  const itemName = (item?.name || '').toLowerCase();
  const candTitle = (candidate?.title || '').toLowerCase();
  const itemType = (item?.object_type || '').toLowerCase();

  let score = 0;

  if (itemType && candTitle.includes(itemType)) score += 25;

  const words = itemName.split(/[^a-z0-9]+/i).filter(w => w.length > 2);
  const unique = [...new Set(words)];
  for (const w of unique) {
    if (candTitle.includes(w)) score += 5;
  }

  const hints = [
    ...safeArray(item?.shape_keywords),
    ...safeArray(item?.material_keywords),
    ...safeArray(item?.color_keywords),
    ...safeArray(item?.pattern_keywords)
  ].map(x => String(x || '').toLowerCase());

  for (const h of hints) {
    if (h && candTitle.includes(h)) score += 4;
  }

  // Small boost if source looks more premium for detailed tabletop objects
  const source = (candidate?.source || '').toLowerCase();
  if (['juliska', 'vietri', 'anthropologie', 'williams sonoma', 'sur la table', 'replacements', 'chairish'].some(b => source.includes(b))) {
    score += 4;
  }

  return score;
}

function inferRetailerFromUrl(url = '') {
  const u = String(url).toLowerCase();
  if (u.includes('anthropologie')) return 'Anthropologie';
  if (u.includes('potterybarn')) return 'Pottery Barn';
  if (u.includes('williams-sonoma')) return 'Williams Sonoma';
  if (u.includes('westelm')) return 'West Elm';
  if (u.includes('crateandbarrel')) return 'Crate & Barrel';
  if (u.includes('cb2')) return 'CB2';
  if (u.includes('serenaandlily')) return 'Serena & Lily';
  if (u.includes('juliska')) return 'Juliska';
  if (u.includes('vietri')) return 'Vietri';
  if (u.includes('surlatable')) return 'Sur La Table';
  if (u.includes('food52')) return 'Food52';
  if (u.includes('etsy')) return 'Etsy';
  if (u.includes('chairish')) return 'Chairish';
  if (u.includes('amazon')) return 'Amazon';
  if (u.includes('wayfair')) return 'Wayfair';
  if (u.includes('target')) return 'Target';
  if (u.includes('shopltk')) return 'LTK';
  if (u.includes('shopmy')) return 'ShopMy';
  if (u.includes('replacements')) return 'Replacements Ltd';
  return '';
}

function extractStyleAnchor(item, match) {
  const exact = match?.exact_match || null;
  const title = normalizeString(exact?.title);
  const source = normalizeString(exact?.source || inferRetailerFromUrl(exact?.link || ''));
  const raw = `${title} ${source}`.toLowerCase();

  // very simple keyword extraction from exact match + item
  const tokens = uniqueStrings([
    ...safeArray(item?.shape_keywords),
    ...safeArray(item?.material_keywords),
    ...safeArray(item?.color_keywords),
    ...safeArray(item?.pattern_keywords),
  ].map(String));

  // Add title-based hints
  const titleHints = [];
  const possibleHints = [
    'scalloped', 'fluted', 'ribbed', 'coupe', 'round', 'oval',
    'stoneware', 'ceramic', 'porcelain', 'glass', 'linen', 'cotton',
    'green', 'emerald', 'sage', 'olive', 'ivory', 'white', 'gold',
    'striped', 'stripe', 'floral', 'botanical', 'clover', 'check', 'gingham'
  ];
  for (const h of possibleHints) {
    if (raw.includes(h)) titleHints.push(h);
  }

  const mergedKeywords = uniqueStrings([...tokens, ...titleHints]);

  // crude brand detection from title/source (helps Carolina Irving cases)
  let brand = source || '';
  const premiumHit = PREMIUM_TABLETOP_BRANDS.find(b => raw.includes(b.toLowerCase()));
  if (premiumHit) brand = premiumHit;

  // collection-ish hint = first few words of title if we have exact title
  let collection_hint = '';
  if (title) {
    collection_hint = title.split(' ').slice(0, 5).join(' ');
  }

  return {
    brand,
    source,
    title,
    collection_hint,
    keywords: mergedKeywords
  };
}

async function uploadImageForLens({ cleanImageB64, log, FREEIMAGE_KEY, IMGBB_KEY }) {
  let imageUrl = null;

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
    } catch (_) {
      log.push('freeimage-err');
    }
  } else {
    log.push('freeimage:no-key');
  }

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
    } catch (_) {
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

    for (const vm of safeArray(d.visual_matches).slice(0, 50)) {
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

    for (const sr of safeArray(d.shopping_results).slice(0, 25)) {
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
  } catch (_) {
    log.push('lens-err');
    return [];
  }
}

async function serpShoppingSearch({ SERP_KEY, query, log, num = 8 }) {
  if (!SERP_KEY || !query) return [];
  try {
    const params = new URLSearchParams({
      engine: 'google_shopping',
      q: query,
      api_key: SERP_KEY,
      num: String(num),
      gl: 'us',
      hl: 'en'
    });
    const r = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
    if (!r.ok) {
      log.push(`shop-fail:${r.status}`);
      return [];
    }
    const d = await r.json();

    const results = safeArray(d.shopping_results)
      .map((x, i) => ({
        id: `shop_${i}_${Math.random().toString(36).slice(2, 6)}`,
        source_type: 'shopping_search',
        title: x.title || '',
        source: x.source || '',
        link: x.product_link || x.link || '',
        thumbnail: x.thumbnail || '',
        price: safeNum(x.extracted_price),
        raw: x
      }))
      .filter(x => x.link);

    log.push(`shop:${results.length}`);
    return results;
  } catch (_) {
    log.push('shop-err');
    return [];
  }
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates || []) {
    if (!c) continue;
    const key = (c.link || c.title || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function buildCandidatePoolForItem(item, lensCandidates, textSearchCandidates) {
  const combined = dedupeCandidates([...(lensCandidates || []), ...(textSearchCandidates || [])]);
  combined.sort((a, b) => scoreCandidateHeuristic(item, b) - scoreCandidateHeuristic(item, a));
  return combined.slice(0, 24);
}

async function detectItemsPass({ OPENAI_KEY, model, imageDataUri, log }) {
  const system = `You are a visual product detection assistant for interior design and tablescape shopping.
Your job is to identify all SHoppable visible objects (not walls/floor unless wallpaper/rug is a clear style feature).
Be exhaustive but avoid duplicates.
Separate overlapping items (e.g., charger plate + dinner plate + salad plate + napkin + napkin ring + glassware).
For tablescapes, pay special attention to:
- charger, dinner plate, salad plate, bowl
- placemat or charger mat
- napkin and napkin ring
- water goblet / wine glass / coupe / flute
- flatware
- candles / candleholders
- centerpiece vessels`;

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
      "object_type": "plate|charger|placemat|glass|napkin|vase|chair|lamp|wallpaper|rug|flatware|candleholder|etc",
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
- Include all visible glasses separately by type (water goblet vs wine glass) if identifiable, otherwise one glass item with quantity.
- If there are multiple similar items, list it at least once and set quantity_estimate.
- Do not invent brand names.
- Do not include people, hands, food (unless the serving vessel/platter itself is notable).`
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
    maxTokens: 2600,
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
Choose ONLY true exact or near-exact matches from candidates.
Reject wrong object types (e.g., glass vs plate).
Do not reuse the same candidate for multiple items.
If uncertain, return no exact match.
Be conservative.`;

  const userText = `Match detected image items to search candidates.

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
2) First verify object type match (plate, glass, napkin, placemat, flatware, etc).
3) "exact" = same object and style details align strongly.
4) "near_exact" = very close replacement if exact is unavailable.
5) If no valid match, use match_type "none" and exact_match null.
6) Prefer candidates with title cues matching shape/material/pattern.
7) For tableware layers, do NOT assign the same plate result to multiple item types.
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
    maxTokens: 3800,
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
      clone.match_type = 'none';
      clone.confidence = Math.min(safeNum(clone.confidence, 0), 40);
      clone.evidence = [...safeArray(clone.evidence), 'Candidate lock conflict: candidate already assigned to another item'];
      clone.rejected_candidates = [
        ...safeArray(clone.rejected_candidates),
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
  styleAnchorsByItem,
  log
}) {
  const system = `You are a luxury shopping stylist and product sourcer.
Your job is to recommend products that stay VERY CLOSE to the original image item.

Critical behavior:
- If an exact_match or near_exact match exists, use it as a STYLE ANCHOR.
- Derive recommendations from the exact match title/source/brand/keywords first.
- Preserve object type, proportions, shape, material, motif/pattern, and finish.
- Do NOT drift to generic items based only on color.
- Prefer premium lookalikes when the exact match is from a premium designer brand.`;

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
          "search_url": "https://... (site search URL is okay)",
          "estimated_price": 0,
          "why": "specific reason tied to shape/material/pattern and exact style anchor"
        }
      ]
    }
  ]
}

Rules:
- 2 to 4 recommendations per item if possible.
- Prioritize: ${ALLOWED_RETAILERS.join(', ')}.
- Include LTK / LikeToKnowIt and ShopMy when relevant.
- If style_anchor.brand is a premium designer brand (e.g., Carolina Irving & Daughters), recommendations must feel like true lookalikes (not generic substitutes).
- Prefer tabletop-specific brands for plates/glassware/linens: Juliska, Vietri, Williams Sonoma, Sur La Table, Anthropologie, Replacements Ltd, Chairish, Etsy artisans.
- Use valid search URLs.
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
    style_anchors_by_item: styleAnchorsByItem,
    candidate_titles_by_item: perItemCandidates.map(x => ({
      item_id: x.item_id,
      candidates: safeArray(x.candidates).slice(0, 10).map(c => ({
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
    maxTokens: 3400,
    log,
    tag: 'recs'
  });

  if (!Array.isArray(parsed.recommendations_by_item)) parsed.recommendations_by_item = [];
  return parsed;
}

function buildRecommendationFallback(item, match, styleAnchor) {
  const objectType = item?.object_type || 'item';
  const itemName = item?.name || objectType;
  const keywords = uniqueStrings([
    ...(styleAnchor?.keywords || []),
    ...safeArray(item?.shape_keywords),
    ...safeArray(item?.pattern_keywords),
    ...safeArray(item?.material_keywords),
    ...safeArray(item?.color_keywords)
  ]).slice(0, 6);

  const base = (styleAnchor?.title || itemName).trim();
  const brand = (styleAnchor?.brand || '').trim();

  const premiumTablewareStores = ['Juliska', 'Vietri', 'Williams Sonoma', 'Anthropologie', 'Sur La Table', 'Replacements Ltd', 'Chairish', 'Etsy'];
  const generalStores = ['Anthropologie', 'West Elm', 'Pottery Barn', 'Target', 'Wayfair', 'LTK', 'ShopMy'];

  const chosenStores = ['plate', 'charger', 'placemat', 'glass', 'napkin', 'flatware', 'bowl'].includes(String(objectType).toLowerCase())
    ? premiumTablewareStores
    : generalStores;

  const queryPieces = uniqueStrings([
    brand,
    ...keywords,
    objectType,
    itemName
  ]).slice(0, 8);

  const query = queryPieces.join(' ').trim() || itemName;

  return chosenStores.slice(0, 3).map((store) => ({
    title: `${base} style ${objectType}`.trim(),
    source: store,
    search_url: makeSearchUrl(store, query),
    estimated_price: 0,
    why: brand
      ? `Uses the exact-match style anchor (${brand}) plus close shape/material/pattern keywords`
      : `Uses the detected item’s shape/material/pattern keywords to stay close in style`
  }));
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

  const image = body.image;
  const mediaType = body.mediaType || 'image/jpeg';
  const log = [];

  if (!image) return res.status(400).json({ error: 'No image provided' });

  const cleanImage = String(image).replace(/^data:image\/\w+;base64,/, '').trim();
  const imageDataUri = `data:${mediaType};base64,${cleanImage}`;

  try {
    // PASS 1: Detection (AI vision)
    const detection = await detectItemsPass({
      OPENAI_KEY,
      model: OPENAI_MODEL,
      imageDataUri,
      log
    });

    const scene_summary = normalizeString(detection?.scene_summary || '');
    let detected_items = safeArray(detection?.detected_items);

    detected_items = detected_items
      .filter(Boolean)
      .map((it, idx) => ({
        item_id: normalizeString(it.item_id || `item_${String(idx + 1).padStart(2, '0')}`),
        name: normalizeString(it.name || `Item ${idx + 1}`),
        object_type: normalizeString(it.object_type || 'object'),
        prominence: normalizeString(it.prominence || 'secondary'),
        quantity_estimate: Math.max(1, safeNum(it.quantity_estimate, 1)),
        color_keywords: safeArray(it.color_keywords).map(String),
        material_keywords: safeArray(it.material_keywords).map(String),
        shape_keywords: safeArray(it.shape_keywords).map(String),
        pattern_keywords: safeArray(it.pattern_keywords).map(String),
        placement: normalizeString(it.placement || ''),
        notes: normalizeString(it.notes || '')
      }));

    // De-dupe by item_id if model repeats
    const seenItems = new Set();
    detected_items = detected_items.filter((it) => {
      if (!it.item_id || seenItems.has(it.item_id)) return false;
      seenItems.add(it.item_id);
      return true;
    });

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

    // STEP 2: Upload image for Lens (optional but recommended)
    const imageUrl = await uploadImageForLens({
      cleanImageB64: cleanImage,
      log,
      FREEIMAGE_KEY,
      IMGBB_KEY
    });

    // STEP 3: Candidate search (Lens + Shopping text search per item)
    const lensCandidates = await serpGoogleLens({
      SERP_KEY,
      imageUrl,
      log
    });

    const perItemCandidates = [];
    for (const item of detected_items) {
      const queryParts = uniqueStrings([
        item.name,
        ...safeArray(item.shape_keywords).slice(0, 2),
        ...safeArray(item.pattern_keywords).slice(0, 2),
        ...safeArray(item.material_keywords).slice(0, 2),
        ...safeArray(item.color_keywords).slice(0, 2)
      ]);

      const query = queryParts.join(' ').replace(/\s+/g, ' ').trim();

      const shoppingCandidates = SERP_KEY
        ? await serpShoppingSearch({ SERP_KEY, query, log, num: 10 })
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

      if (SERP_KEY) await sleep(120);
    }

    // STEP 4: Exact verification pass
    let verify = { item_matches: [] };
    try {
      verify = await verifyExactMatchesPass({
        OPENAI_KEY,
        model: OPENAI_MODEL,
        detectedItems: detected_items,
        perItemCandidates,
        log
      });
    } catch (e) {
      log.push('verify:fallback');
      verify = { item_matches: [] };
    }

    let item_matches = safeArray(verify?.item_matches).map(m => ({
      item_id: normalizeString(m?.item_id),
      item_name: normalizeString(m?.item_name),
      match_type: ['exact', 'near_exact', 'none'].includes(m?.match_type) ? m.match_type : 'none',
      confidence: Math.max(0, Math.min(100, safeNum(m?.confidence, 0))),
      exact_match: m?.exact_match ? {
        candidate_id: normalizeString(m.exact_match.candidate_id),
        title: normalizeString(m.exact_match.title),
        source: normalizeString(m.exact_match.source || inferRetailerFromUrl(m.exact_match.link || '')),
        link: normalizeString(m.exact_match.link),
        thumbnail: normalizeString(m.exact_match.thumbnail),
        price: safeNum(m.exact_match.price, 0)
      } : null,
      evidence: safeArray(m?.evidence).map(String).slice(0, 8),
      rejected_candidates: safeArray(m?.rejected_candidates).slice(0, 10)
    }));

    item_matches = enforceCandidateLocking(item_matches);

    // Fallback for omitted items: create "none" rows so every detected item appears
    const matchedIds = new Set(item_matches.map(m => m.item_id).filter(Boolean));
    for (const item of detected_items) {
      if (matchedIds.has(item.item_id)) continue;

      const pool = safeArray(perItemCandidates.find(x => x.item_id === item.item_id)?.candidates);
      const top = pool[0] || null;

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

    // Style anchors (NEW: exact-match anchored recommendations)
    const styleAnchorsByItem = detected_items.map((item) => {
      const match = item_matches.find(m => m.item_id === item.item_id) || null;
      const anchor = extractStyleAnchor(item, match);
      return {
        item_id: item.item_id,
        ...anchor
      };
    });

    // STEP 5: Recommendation pass (AI), using style anchors
    let recs = { recommendations_by_item: [] };
    try {
      recs = await recommendationsPass({
        OPENAI_KEY,
        model: OPENAI_MODEL,
        sceneSummary: scene_summary,
        detectedItems: detected_items,
        itemMatches: item_matches,
        perItemCandidates,
        styleAnchorsByItem,
        log
      });
    } catch (_) {
      log.push('recs:fallback');
      recs = { recommendations_by_item: [] };
    }

    const recMap = new Map();
    for (const r of safeArray(recs?.recommendations_by_item)) {
      const arr = safeArray(r?.recommended_items);
      if (r?.item_id) recMap.set(r.item_id, arr);
    }

    // Final merged response
    const finalItemMatches = item_matches.map(m => {
      const item = detected_items.find(x => x.item_id === m.item_id) || null;
      const perItem = perItemCandidates.find(x => x.item_id === m.item_id) || null;
      const candidatePool = safeArray(perItem?.candidates);
      const styleAnchor = styleAnchorsByItem.find(x => x.item_id === m.item_id) || null;

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

      let recommendationsRaw = safeArray(recMap.get(m.item_id)).slice(0, 4);

      // Fallback recommendations if AI returns none
      if (recommendationsRaw.length === 0 && item) {
        recommendationsRaw = buildRecommendationFallback(item, m, styleAnchor);
      }

      const recommendations = recommendationsRaw.map((x) => {
        const source = normalizeString(x.source || inferRetailerFromUrl(x.search_url || '') || 'Shop');
        const title = normalizeString(x.title || item?.name || 'Recommended item');
        const estimated_price = safeNum(x.estimated_price, 0);

        // Keep user-provided/AI search URL if valid-ish, otherwise generate one
        let search_url = normalizeString(x.search_url);
        if (!search_url || !/^https?:\/\//i.test(search_url)) {
          // Use style anchor first if we have exact match
          const anchorQueryParts = uniqueStrings([
            styleAnchor?.brand,
            styleAnchor?.collection_hint,
            ...safeArray(styleAnchor?.keywords).slice(0, 4),
            item?.object_type,
            title
          ]).slice(0, 8);
          const anchorQuery = anchorQueryParts.join(' ').trim() || title;
          search_url = makeSearchUrl(source, anchorQuery);
        }

        return {
          title,
          source,
          search_url,
          estimated_price,
          why: normalizeString(x.why || 'Close match in shape/material/color and overall styling')
        };
      });

      return {
        ...m,
        detected_item: item,
        style_anchor: styleAnchor,
        fallback_candidate,
        recommendations
      };
    });

    const unmatched_items = finalItemMatches
      .filter(m => m.match_type === 'none')
      .map(m => ({
        item_id: m.item_id,
        item_name: m.item_name,
        reason: (safeArray(m.evidence)[0]) || 'No verified match found',
        fallback_candidate: m.fallback_candidate || null
      }));

    return res.status(200).json({
      scene_summary,
      detected_items,
      item_matches: finalItemMatches,
      unmatched_items,
      lens_used: !!imageUrl,
      lens_total: safeArray(lensCandidates).length,
      log: log.join(' | ')
    });

  } catch (err) {
    return res.status(500).json({
      error: err?.message || 'Analyze failed',
      log: log.join(' | ')
    });
  }
}
