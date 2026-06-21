// Diet quality scoring — an MVP heuristic modeled loosely on the Alma Score concept
// (10 categories, 0-100 total) and on the 2025-2030 Dietary Guidelines for Americans /
// WHO guidance. This is intentionally approximate: it is meant to give directional
// feedback ("your sodium category is dragging the score down"), not a clinically
// validated diet quality index. Always surface it to the user with that caveat.

// Keyword fallback so scoring still works even if the coach doesn't tag every item.
// Explicit `tags` on a food item always take priority over this.
const KEYWORD_TAGS = [
  { tag: "vegetable", words: ["broccoli", "spinach", "carrot", "lettuce", "kale", "pepper", "zucchini", "cucumber", "tomato", "onion", "salad", "greens", "cauliflower", "asparagus", "mushroom"] },
  { tag: "fruit", words: ["apple", "banana", "berry", "berries", "orange", "grape", "melon", "mango", "pear", "peach", "pineapple", "kiwi"] },
  { tag: "whole_grain", words: ["oats", "oatmeal", "quinoa", "brown rice", "whole wheat", "whole grain", "barley", "farro"] },
  { tag: "nuts_legumes", words: ["almond", "walnut", "peanut", "cashew", "lentil", "chickpea", "bean", "tofu", "edamame"] },
  { tag: "omega3", words: ["salmon", "sardine", "mackerel", "trout", "flaxseed", "chia", "walnut"] },
  { tag: "healthy_fat", words: ["olive oil", "avocado", "almond butter", "nuts"] },
  { tag: "processed_meat", words: ["bacon", "sausage", "ham", "salami", "hot dog", "deli meat", "pepperoni"] },
  { tag: "alcohol", words: ["beer", "wine", "cocktail", "liquor", "spirits"] },
];

function inferTags(name) {
  const lower = (name || "").toLowerCase();
  return KEYWORD_TAGS.filter((k) => k.words.some((w) => lower.includes(w))).map((k) => k.tag);
}

// Category config. direction "positive" = more is better (score scales up to target).
// direction "negative" = less is better (score starts at 10, degrades past target).
const CATEGORIES = [
  { key: "vegetable", label: "Vegetables", direction: "positive", targetPerDay: 3 },
  { key: "fruit", label: "Fruit", direction: "positive", targetPerDay: 2 },
  { key: "whole_grain", label: "Whole grains", direction: "positive", targetPerDay: 3 },
  { key: "nuts_legumes", label: "Nuts / legumes", direction: "positive", targetPerDay: 1 },
  { key: "omega3", label: "Omega-3 sources", direction: "positive", targetPerDay: 2 / 7 },
  { key: "healthy_fat", label: "Healthy fats", direction: "positive", targetPerDay: 2 },
  { key: "processed_meat", label: "Processed meat", direction: "negative", targetPerDay: 1 / 7 },
  { key: "added_sugar", label: "Added sugar", direction: "negative", targetPerDay: 25, metric: "sugar_g" },
  { key: "sodium", label: "Sodium", direction: "negative", targetPerDay: 2300, metric: "sodium_mg" },
  { key: "alcohol", label: "Alcohol", direction: "negative", targetPerDay: 1 },
];

function scoreComponent(actualPerDay, targetPerDay, direction) {
  if (direction === "positive") {
    return Math.max(0, Math.min(10, (actualPerDay / targetPerDay) * 10));
  }
  // negative: full marks at/under target, linearly degrades to 0 at 2x target
  const ratio = targetPerDay === 0 ? 0 : actualPerDay / targetPerDay;
  return Math.max(0, Math.min(10, 10 - Math.max(0, ratio - 1) * 10));
}

export function computeDietQualityScore(meals, days) {
  const tagCounts = {}; // tag -> total servings across period
  let totalSugar = 0;
  let totalSodium = 0;

  for (const meal of meals) {
    for (const item of meal.items || []) {
      const tags = item.tags && item.tags.length ? item.tags : inferTags(item.name);
      const servings = item.qty && Number.isFinite(item.qty) ? item.qty : 1;
      for (const tag of tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + servings;
      }
      totalSugar += item.sugar_g || 0;
      totalSodium += item.sodium_mg || 0;
    }
  }

  const components = CATEGORIES.map((cat) => {
    let actualPerDay;
    if (cat.metric === "sugar_g") actualPerDay = totalSugar / days;
    else if (cat.metric === "sodium_mg") actualPerDay = totalSodium / days;
    else actualPerDay = (tagCounts[cat.key] || 0) / days;

    const score = scoreComponent(actualPerDay, cat.targetPerDay, cat.direction);
    return {
      category: cat.key,
      label: cat.label,
      direction: cat.direction,
      actualPerDay: Math.round(actualPerDay * 100) / 100,
      targetPerDay: Math.round(cat.targetPerDay * 100) / 100,
      score: Math.round(score * 10) / 10,
    };
  });

  const total = Math.round(components.reduce((sum, c) => sum + c.score, 0) * 10) / 10;

  return {
    score: total,
    maxScore: 100,
    days,
    components,
    note: "Approximate MVP heuristic modeled on the Dietary Guidelines for Americans 2025-2030 and WHO guidance, not a clinically validated index. Tag food items (e.g. tags: ['vegetable']) for more accurate scoring; otherwise common foods are guessed by keyword.",
  };
}
