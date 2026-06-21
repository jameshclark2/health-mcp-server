import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { withDb, newId } from "./db.js";
import { computeDietQualityScore } from "./scoring.js";

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

function createServer() {
  const server = new McpServer({ name: "personal-health-coach", version: "1.0.0" });

  server.registerTool(
    "get_health_profile",
    { title: "Get health profile", description: "Get the user's stored health profile.", inputSchema: {} },
    async () => withDb((db) => text(db.healthProfile))
  );

  server.registerTool(
    "set_health_profile",
    {
      title: "Set health profile",
      description: "Create or update the user's health profile.",
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

  server.registerTool(
    "log_meal",
    {
      title: "Log a meal",
      description: "Log a meal or snack with its food items.",
      inputSchema: {
        date: z.string().optional(),
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
    { title: "Get meal log", description: "Get logged meals for the last N days.", inputSchema: { days: z.number().optional().default(7) } },
    async ({ days = 7 }) =>
      withDb((db) => {
        const since = daysAgo(days);
        return text(db.meals.filter((m) => inRange(m.date, since)));
      })
  );

  server.registerTool(
    "log_workout",
    {
      title: "Log a workout",
      description: "Log a workout session.",
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
    { title: "Get workout log", description: "Get logged workouts.", inputSchema: { days: z.number().optional().default(14) } },
    async ({ days = 14 }) =>
      withDb((db) => {
        const since = daysAgo(days);
        return text(db.workouts.filter((w) => inRange(w.date, since)));
      })
  );

  server.registerTool(
    "log_weight",
    {
      title: "Log weight/biometrics",
      description: "Log a weight reading.",
      inputSchema: { date: z.string().optional(), weight_kg: z.number(), body_fat_pct: z.number().optional(), notes: z.string().optional() },
    },
    async (args) =>
      withDb((db) => {
        const entry = { id: newId(), date: args.date || new Date().toISOString().slice(0, 10), weight_kg: args.weight_kg, body_fat_pct: args.body_fat_pct, notes: args.notes || "" };
        db.weights.push(entry);
        return text(entry);
      })
  );

  server.registerTool(
    "get_trends",
    {
      title: "Get trends",
      description: "Get a time series + stats for a metric.",
      inputSchema: { metric: z.enum(["weight", "calories", "protein", "sodium", "sugar", "workout_count"]), days: z.number().optional().default(30) },
    },
    async ({ metric, days = 30 }) =>
      withDb((db) => {
        const since = daysAgo(days);
        let series = [];
        if (metric === "weight") {
          series = db.weights.filter((w) => inRange(w.date, since)).map((w) => ({ date: w.date, value: w.weight_kg })).sort((a, b) => (a.date > b.date ? 1 : -1));
        } else if (metric === "workout_count") {
          const byDate = {};
          db.workouts.filter((w) => inRange(w.date, since)).forEach((w) => { byDate[w.date] = (byDate[w.date] || 0) + 1; });
          series = Object.entries(byDate).map(([date, value]) => ({ date, value })).sort((a, b) => (a.date > b.date ? 1 : -1));
        } else {
          const fieldMap = { calories: "calories", protein: "protein_g", sodium: "sodium_mg", sugar: "sugar_g" };
          const field = fieldMap[metric];
          const byDate = {};
          db.meals.filter((m) => inRange(m.date, since)).forEach((m) => {
            const dayTotal = (m.items || []).reduce((sum, i) => sum + (i[field] || 0), 0);
            byDate[m.date] = (byDate[m.date] || 0) + dayTotal;
          });
          series = Object.entries(byDate).map(([date, value]) => ({ date, value })).sort((a, b) => (a.date > b.date ? 1 : -1));
        }
        const values = series.map((p) => p.value);
        const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
        const direction = values.length >= 2 ? (values[values.length - 1] > values[0] ? "up" : values[values.length - 1] < values[0] ? "down" : "flat") : "insufficient_data";
        return text({ metric, days, series, stats: { avg: Math.round(avg * 100) / 100, min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null, direction } });
      })
  );

  server.registerTool(
    "get_diet_quality_score",
    { title: "Get diet quality score", description: "Compute an approximate diet quality score.", inputSchema: { days: z.number().optional().default(7) } },
    async ({ days = 7 }) =>
      withDb((db) => {
        const since = daysAgo(days);
        const meals = db.meals.filter((m) => inRange(m.date, since));
        return text(computeDietQualityScore(meals, days));
      })
  );

  server.registerTool(
    "set_goal",
    { title: "Set a goal", description: "Create or update a goal.", inputSchema: { type: z.string(), target: z.number(), unit: z.string().optional(), targetDate: z.string().optional() } },
    async (args) =>
      withDb((db) => {
        const existing = db.goals.find((g) => g.type === args.type && g.status === "active");
        if (existing) { Object.assign(existing, args); return text(existing); }
        const goal = { id: newId(), status: "active", createdAt: new Date().toISOString(), ...args };
        db.goals.push(goal);
        return text(goal);
      })
  );

  server.registerTool(
    "get_goals",
    { title: "Get goals", description: "Get all active goals.", inputSchema: {} },
    async () => withDb((db) => text(db.goals.filter((g) => g.status === "active")))
  );

  server.registerTool(
    "add_grocery_item",
    { title: "Add grocery item", description: "Add an item to the grocery list.", inputSchema: { name: z.string(), qty: z.string().optional(), category: z.string().optional() } },
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
    { title: "Remove grocery item", description: "Remove a grocery item by id.", inputSchema: { id: z.string() } },
    async ({ id }) =>
      withDb((db) => {
        db.grocery = db.grocery.filter((g) => g.id !== id);
        return text({ removed: id });
      })
  );

  server.registerTool(
    "add_pantry_item",
    { title: "Add pantry item", description: "Add or update a pantry item.", inputSchema: { name: z.string(), qty: z.string().optional(), unit: z.string().optional(), category: z.string().optional() } },
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

  server.registerTool(
    "log_coaching_insight",
    { title: "Log a coaching insight", description: "Record an insight given to the user.", inputSchema: { insight: z.string(), category: z.string().optional(), date: z.string().optional() } },
    async (args) =>
      withDb((db) => {
        const entry = { id: newId(), date: args.date || new Date().toISOString().slice(0, 10), insight: args.insight, category: args.category || "general", followedUp: false };
        db.coachingLog.push(entry);
        return text(entry);
      })
  );

  server.registerTool(
    "get_coaching_log",
    { title: "Get coaching log", description: "Get past coaching insights.", inputSchema: { days: z.number().optional().default(30) } },
    async ({ days = 30 }) =>
      withDb((db) => {
        const since = daysAgo(days);
        return text(db.coachingLog.filter((c) => inRange(c.date, since)));
      })
  );

  return server;
}

const transports = {}; // sessionId -> transport

async function handleMcpRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  const method = req.body && req.body.method;
  console.log(`[mcp] POST method=${method} sessionId=${sessionId || "(none)"} knownSession=${sessionId ? !!transports[sessionId] : "n/a"}`);
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        console.log(`[mcp] session initialized: ${sid}`);
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      console.log(`[mcp] session closed: ${transport.sessionId}`);
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const server = createServer();
    await server.connect(transport);
  } else {
    console.log(`[mcp] REJECTING request: sessionId=${sessionId || "(none)"} isInit=${isInitializeRequest(req.body)} knownSessions=${Object.keys(transports).join(",") || "(none)"}`);
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null });
    return;
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
}

async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  console.log(`[mcp] ${req.method} sessionId=${sessionId || "(none)"} knownSession=${sessionId ? !!transports[sessionId] : "n/a"}`);
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

const app = express();
app.use(express.json());

app.post("/mcp", handleMcpRequest);
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.get("/", (req, res) => res.send("personal-health-coach MCP server is running. POST to /mcp."));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`personal-health-coach MCP server listening on :${PORT} (POST /mcp)`);
});
