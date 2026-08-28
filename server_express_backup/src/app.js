import express from "express";
import cors from "cors";
import { router as prsRouter } from "./routes/prs.js";
import { router as reviewsRouter } from "./routes/reviews.js";

export const app = express();

app.use(cors());
app.use(express.json());
app.use("/api", prsRouter);
app.use("/api", reviewsRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal error" });
});
