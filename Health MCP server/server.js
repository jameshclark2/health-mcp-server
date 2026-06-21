import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { withDb, newId } from "./db.js";
import { computeDietQualityScore } from "./scoring.js";

const server = new McpServer({ name: "personal-health-coach", version: "1.0.0" });

function text(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function inRange(dateStr, sinceStr) {
  return dateStr >= sinceStr;
}

const foodItemSchema = z.object({
  name: z.string(),
  qty: z.number().optional().default(1),
  unit: z.string().optional(),
  calories: z.number().optional(),
  protein_g: z.number().optional(),
  carbs_g: z.number().optional(),
  fat_g: z.number().optional(),
  fiber_g: z.number().optional(),
  sodium_mg: z.number().optional(),
  sugar_g: z.number().optional(),
  tags: z.array(z.string()).optional(),
});

const exerciseSchema = z.object({
  name: z.string(),
  sets: z.number().optional(),
  reps: z.number().optional(),
  weight_kg: z.number().optional(),
  duration_min: z.number().optional(),
  distance_km: z.number().optional(),
  rpe: z.number().min(1).max(10).optional(),
});

// ---------- Health profile ----------

server.registerTool(
  "get_health_profile",
  {
    title: "Get health profile",
    description: "Get the user's stored health profile: conditions, medications, allergies, dietary restrictions. Always check this before giving nutrition/exercise advice.",
    inputSchema: {},
  },
  async () => withDb((db) => text(db.healthProfile))
);

server.registerTool(
  "set_health_profile",
  {
    title: "Set health profile",
    description: "Create or update the user's health profile. Pass only the fields you want to change; omitted fields are left as-is.",
    inputSchema: {
      conditions: z.array(z.string()).optional(),
      medications: z.array(z.string()).optional(),
      allergies: z.array(z.string()).optional(),
      dietaryRestrictions: z.array(z.string()).optional(),
      notes: z.string().optional(),
    },
  },
  async (args) =>
    withDb((db) => {
      db.healthProfile = { ...db.healthProfile, ...args };
      return text(db.healthProfile);
    })
);

// ---------- Meals ----------

server.registerTool(
  "log_meal",
  {
    title: "Log a meal",
    description: "Log a meal or snack with its food items. Returns the saved entry with computed totals.",
    inputSchema: {
      date: z.string().describe("YYYY-MM-DD, defaults to today if omitted").optional(),
      mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
      items: z.array(foodItemSchema),
      notes: z.string().optional(),
    },
  },
  async (args) =>
    withDb((db) => {
      const entry = {
        id: newId(),
        date: args.date || new Date().toISOString().slice(0, 10),
        mealType: args.mealType || "snack",
        items: args.items,
        notes: args.notes || "",
        loggedAt: new Date().toISOString(),
      };
      db.meals.push(entry);
      const totals = entry.items.reduce(
        (acc, i) => ({
          calories: acc.calories + (i.calories || 0),
          protein_g: acc.protein_g + (i.protein_g || 0),
          carbs_g: acc.carbs_g + (i.carbs_g || 0),
          fat_g: acc.fat_g + (i.fat_g || 0),
          sodium_mg: acc.sodium_mg + (i.sodium_mg || 0),
          sugar_g: acc.sugar_g + (i.sugar_g || 0),
        }),
        { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, sodium_mg: 0, sugar_g: 0 }
      );
      return text({ entry, totals });
    })
);

server.registerTool(
  "get_meals",
  {
    title: "Get meal log",
    description: "Get logged meals for the last N days (default 7).",
    inputSchema: { days: z.number().optional().default(7) },
  },
  async ({ days = 7 }) =>
    withDb((db) => {
      const since = daysAgo(days);
      return text(db.meals.filter((m) => inRange(m.date, since)));
    })
);

// ---------- Workouts ----------

server.registerTool(
  "log_workout",
  {
    title: "Log a workout",
    description: "Log a workout session (strength, cardio, etc.) with its exercises.",
    inputSchema: {
      date: z.string().optional(),
      type: z.enum(["strength", "cardio", "mobility", "sport", "other"]).optional(),
      exercises: z.array(exerciseSchema),
      notes: z.string().optional(),
    },
  },
  async (args) =>
    withDb((db) => {
      const entry = {
        id: newId(),
        date: args.date || new Date().toISOString().slice(0, 10),
        type: args.type || "other",
        exercises: args.exercises,
        notes: args.notes || "",
        loggedAt: new Date().toISOString(),
      };
      db.workouts.push(entry);
      return text(entry);
    })
);

server.registerTool(
  "get_workouts",
  {
    title: "Get workout log",
    description: "Get logged workouts for the last N days (default 14).",
    inputSchema: { days: z.number().optional().default(14) },
  },
  async ({ days = 14 }) =>
    withDb((db) => {
      const since = daysAgo(days);
      return text(db.workouts.filter((w) => inRange(w.date, since)));
    })
);

// ---------- Weight / biometrics ----------

server.registerTool(
  "log_weight",
  {
    title: "Log weight/biometrics",
    description: "Log a weight (and optionally body fat %) reading for a given date.",
    inputSchema: {
      date: z.string().optional(),
      weight_kg: z.number(),
      body_fat_pct: z.number().optional(),
      notes: z.string().optional(),
    },
  },
  async (args) =>
    withDb((db) => {
      const entry = {
        id: newId(),
        date: args.date || new Date().toISOString().slice(0, 10),
        weight_kg: args.weight_kg,
        body_fat_pct: args.body_fat_pct,
        notes: args.notes || "",
      };
      db.weights.push(entry);
      return text(entry);
    })
);

// ---------- Trends ----------

server.registerTool(
  "get_trends",
  {
    title: "Get trends",
    description: "Get a time series + basic stats (avg/min/max/direction) for a metric over the last N days. Metrics: weight, calories, protein, sodium, sugar, workout_count.",
    inputSchema: {
      metric: z.enum(["weight", "calories", "protein", "sodium", "sugar", "workout_count"]),
      days: z.number().optional().default(30),
    },
  },
  async ({ metric, days = 30 }) =>
    withDb((db) => {
      const since = daysAgo(days);
      let series = [];

      if (metric === "weight") {
        series = db.weights
          .filter((w) => inRange(w.date, since))
          .map((w) => ({ date: w.date, value: w.weight_kg }))
          .sort((a, b) => (a.date > b.date ? 1 : -1));
      } else if (metric === "workout_count") {
        const byDate = {};
        db.workouts.filter((w) => inRange(w.date, since)).forEach((w) => {
          byDate[w.date] = (byDate[w.date] || 0) + 1;
        });
        series = Object.entries(byDate)
          .map(([date, value]) => ({ date, value }))
          .sort((a, b) => (a.date > b.date ? 1 : -1));
      } else {
        const fieldMap = { calories: "calories", protein: "protein_g", sodium: "sodium_mg", sugar: "sugar_g" };
        const field = fieldMap[metric];
        const byDate = {};
        db.meals.filter((m) => inRange(m.date, since)).forEach((m) => {
          const dayTotal = (m.items || []).reduce((sum, i) => sum + (i[field] || 0), 0);
          byDate[m.date] = (byDate[m.date] || 0) + dayTotal;
        });
        series = Object.entries(byDate)
          .map(([date, value]) => ({ date, value }))
          .sort((a, b) => (a.date > b.date ? 1 : -1));
      }

      const values = series.map((p) => p.value);
      const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      const direction =
        values.length >= 2 ? (values[values.length - 1] > values[0] ? "up" : values[values.length - 1] < values[0] ? "down" : "flat") : "insufficient_data";

      return text({
        metric,
        days,
        series,
        stats: {
          avg: Math.round(avg * 100) / 100,
          min: values.length ? Math.min(...values) : null,
          max: values.length ? Math.max(...values) : null,
          direction,
        },
      });
    })
);

// ---------- Diet quality score ----------

server.registerTool(
  "get_diet_quality_score",
  {
    title: "Get diet quality score",
    description: "Compute an approximate 0-100 diet quality score across 10 categories (vegetables, fruit, whole grains, nuts/legumes, omega-3, healthy fats, processed meat, added sugar, sodium, alcohol) from logged meals over the last N days. This is a heuristic, not a clinical index — present it to the user with that caveat.",
    inputSchema: { days: z.number().optional().default(7) },
  },
  async ({ days = 7 }) =>
    withDb((db) => {
      const since = daysAgo(days);
      const meals = db.meals.filter((m) => inRange(m.date, since));
      return text(computeDietQualityScore(meals, days));
    })
);

// ---------- Goals ----------

server.registerTool(
  "set_goal",
  {
    title: "Set a goal",
    description: "Create or update a goal (e.g. weight target, macro target, weekly activity target).",
    inputSchema: {
      type: z.string().describe("e.g. 'weight', 'protein_g_per_day', 'sodium_mg_per_day', 'workouts_per_week'"),
      target: z.number(),
      unit: z.string().optional(),
      targetDate: z.string().optional(),
    },
  },
  async (args) =>
    withDb((db) => {
      const existing = db.goals.find((g) => g.type === args.type && g.status === "active");
      if (existing) {
        Object.assign(existing, args);
        return text(existing);
      }
      const goal = { id: newId(), status: "active", createdAt: new Date().toISOString(), ...args };
      db.goals.push(goal);
      return text(goal);
    })
);

server.registerTool(
  "get_goals",
  {
    title: "Get goals",
    description: "Get all active goals.",
    inputSchema: {},
  },
  async () => withDb((db) => text(db.goals.filter((g) => g.status === "active")))
);

// ---------- Grocery & pantry ----------

server.registerTool(
  "add_grocery_item",
  {
    title: "Add grocery item",
    description: "Add an item to the grocery list.",
    inputSchema: { name: z.string(), qty: z.string().optional(), category: z.string().optional() },
  },
  async (args) =>
    withDb((db) => {
      const item = { id: newId(), checked: false, ...args };
      db.grocery.push(item);
      return text(item);
    })
);

server.registerTool(
  "get_grocery_list",
  { title: "Get grocery list", description: "Get the current grocery list.", inputSchema: {} },
  async () => withDb((db) => text(db.grocery))
);

server.registerTool(
  "remove_grocery_item",
  {
    title: "Remove grocery item",
    description: "Remove (or check off) a grocery item by id.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) =>
    withDb((db) => {
      db.grocery = db.grocery.filter((g) => g.id !== id);
      return text({ removed: id });
    })
);

server.registerTool(
  "add_pantry_item",
  {
    title: "Add pantry item",
    description: "Add or update an item in the pantry inventory.",
    inputSchema: { name: z.string(), qty: z.string().optional(), unit: z.string().optional(), category: z.string().optional() },
  },
  async (args) =>
    withDb((db) => {
      const item = { id: newId(), ...args };
      db.pantry.push(item);
      return text(item);
    })
);

server.registerTool(
  "get_pantry_items",
  { title: "Get pantry items", description: "Get current pantry inventory.", inputSchema: {} },
  async () => withDb((db) => text(db.pantry))
);

// ---------- Coaching memory ----------

server.registerTool(
  "log_coaching_insight",
  {
    title: "Log a coaching insight",
    description: "Record an insight or recommendation given to the user, so future check-ins can follow up on whether it stuck instead of repeating it.",
    inputSchema: {
      insight: z.string(),
      category: z.string().optional(),
      date: z.string().optional(),
    },
  },
  async (args) =>
    withDb((db) => {
      const entry = {
        id: newId(),
        date: args.date || new Date().toISOString().slice(0, 10),
        insight: args.insight,
        category: args.category || "general",
        followedUp: false,
      };
      db.coachingLog.push(entry);
      return text(entry);
    })
);

server.registerTool(
  "get_coaching_log",
  {
    title: "Get coaching log",
    description: "Get past coaching insights/recommendations for the last N days (default 30), so you don't repeat yourself and can follow up.",
    inputSchema: { days: z.number().optional().default(30) },
  },
  async ({ days = 30 }) =>
    withDb((db) => {
      const since = daysAgo(days);
      return text(db.coachingLog.filter((c) => inRange(c.date, since)));
    })
);

// ---------- HTTP transport ----------
// Single long-lived transport (stateful mode: the SDK issues a session ID on
// initialize and tracks it via the mcp-session-id header on every later request).
// This is the standard pattern for the StreamableHTTPServerTransport and is plenty
// for a single-user personal server.

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});
await server.connect(transport);

const app = express();
app.use(express.json());

async function handle(req, res) {
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
}

app.post("/mcp", handle);
app.get("/mcp", handle);
app.delete("/mcp", handle);

app.get("/", (req, res) => res.send("personal-health-coach MCP server is running. POST to /mcp."));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`personal-health-coach MCP server listening on :${PORT} (POST /mcp)`);
});
