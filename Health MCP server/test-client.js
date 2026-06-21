// Quick smoke test: spins through the main tools against a running server.
// Usage: node server.js & then node test-client.js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE_URL = process.env.MCP_URL || "http://localhost:8787/mcp";

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const payload = JSON.parse(res.content[0].text);
  console.log(`\n=== ${name} ===`);
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

async function main() {
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(BASE_URL));
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("Registered tools:", tools.tools.map((t) => t.name).join(", "));

  await call(client, "set_health_profile", {
    conditions: [],
    allergies: ["shellfish"],
    dietaryRestrictions: [],
    notes: "test profile",
  });

  await call(client, "log_meal", {
    mealType: "breakfast",
    items: [
      { name: "spinach omelette", qty: 1, calories: 320, protein_g: 22, carbs_g: 6, fat_g: 22, sodium_mg: 480, sugar_g: 1, tags: ["vegetable"] },
      { name: "orange", qty: 1, calories: 60, carbs_g: 15, sugar_g: 12, tags: ["fruit"] },
    ],
  });

  await call(client, "log_meal", {
    mealType: "dinner",
    items: [
      { name: "salmon", qty: 1, calories: 350, protein_g: 34, fat_g: 20, sodium_mg: 90, tags: ["omega3"] },
      { name: "brown rice", qty: 1, calories: 220, carbs_g: 45, tags: ["whole_grain"] },
      { name: "bacon bits", qty: 1, calories: 80, sodium_mg: 600, tags: ["processed_meat"] },
    ],
  });

  await call(client, "log_workout", {
    type: "strength",
    exercises: [{ name: "squat", sets: 5, reps: 5, weight_kg: 80, rpe: 7 }],
  });

  await call(client, "log_weight", { weight_kg: 78.4 });

  await call(client, "get_diet_quality_score", { days: 1 });
  await call(client, "get_trends", { metric: "sodium", days: 7 });
  await call(client, "set_goal", { type: "workouts_per_week", target: 4, unit: "sessions" });
  await call(client, "get_goals", {});
  await call(client, "add_grocery_item", { name: "eggs", qty: "1 dozen" });
  await call(client, "get_grocery_list", {});
  await call(client, "log_coaching_insight", { insight: "Sodium ran high today, mostly from bacon bits at dinner.", category: "nutrition" });
  await call(client, "get_coaching_log", {});

  console.log("\nAll smoke-test calls completed without error.");
  await client.close();
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
