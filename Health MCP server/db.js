// Minimal JSON-file storage. Fine for single-user, low-volume personal use.
// Swap this module out for a real DB later without touching server.js's tool logic much.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), "data.json");

const EMPTY_DB = {
  healthProfile: {
    conditions: [],
    medications: [],
    allergies: [],
    dietaryRestrictions: [],
    notes: "",
  },
  meals: [],
  workouts: [],
  weights: [],
  goals: [],
  grocery: [],
  pantry: [],
  coachingLog: [],
};

function load() {
  if (!existsSync(DB_PATH)) {
    save(EMPTY_DB);
    return structuredClone(EMPTY_DB);
  }
  const raw = readFileSync(DB_PATH, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return structuredClone(EMPTY_DB);
  }
}

function save(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export function withDb(fn) {
  const db = load();
  const result = fn(db);
  save(db);
  return result;
}

export function newId() {
  return randomUUID();
}
