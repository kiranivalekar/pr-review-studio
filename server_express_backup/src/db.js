import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "..", "data", "db.json");

const EMPTY_DB = { prs: {}, reviews: {} };

function ensureDataDir() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

export function readDB() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) {
    return structuredClone(EMPTY_DB);
  }
  const raw = fs.readFileSync(DB_PATH, "utf-8");
  if (!raw.trim()) return structuredClone(EMPTY_DB);
  const parsed = JSON.parse(raw);
  return { prs: parsed.prs ?? {}, reviews: parsed.reviews ?? {} };
}

export function writeDB(db) {
  ensureDataDir();
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
  fs.renameSync(tmpPath, DB_PATH);
}

export function prKey(repo, number) {
  return `${repo}#${number}`;
}

export function upsertPR(pr) {
  const db = readDB();
  const key = prKey(pr.repo, pr.number);
  const existing = db.prs[key];
  db.prs[key] = { ...existing, ...pr };
  writeDB(db);
  return db.prs[key];
}

export function deletePR(repo, number) {
  const db = readDB();
  const key = prKey(repo, number);
  delete db.prs[key];
  writeDB(db);
}

export function listPRs() {
  const db = readDB();
  return Object.values(db.prs);
}

export function createReview(review) {
  const db = readDB();
  db.reviews[review.id] = review;
  writeDB(db);
  return review;
}

export function listReviews({ repo, number, state } = {}) {
  const db = readDB();
  let reviews = Object.values(db.reviews);
  if (repo) reviews = reviews.filter((r) => r.repo === repo);
  if (number !== undefined) reviews = reviews.filter((r) => r.number === Number(number));
  if (state) reviews = reviews.filter((r) => r.comments.some((c) => c.state === state));
  return reviews;
}

export function getReview(id) {
  const db = readDB();
  return db.reviews[id] ?? null;
}

export function updateComment(reviewId, commentId, patch) {
  const db = readDB();
  const review = db.reviews[reviewId];
  if (!review) return null;
  const comment = review.comments.find((c) => c.id === commentId);
  if (!comment) return null;
  Object.assign(comment, patch);
  writeDB(db);
  return review;
}

export function computeStatus(repo, number, db) {
  const reviews = Object.values(db.reviews).filter(
    (r) => r.repo === repo && r.number === number
  );
  if (reviews.length === 0) return "unreviewed";
  const hasPushed = reviews.some((r) =>
    (r.comments ?? []).some((c) => c.state === "pushed")
  );
  return hasPushed ? "commented" : "reviewed";
}
