import { readFileSync } from "fs";
import path from "path";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Use GET" }); return; }

  const file = readFileSync(path.join(process.cwd(), "data", "products.csv"), "utf8");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="products.csv"');
  res.status(200).send(file);
}
