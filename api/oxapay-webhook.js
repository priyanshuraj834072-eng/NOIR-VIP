import crypto from "node:crypto";
import { db } from "./_auth.js";

// Vercel: disable body parsing so we can read the raw body for HMAC.
export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const round = (n) => Math.round(n * 1e6) / 1e6;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  try {
    const merchantKey = process.env.OXAPAY_MERCHANT_API_KEY;
    if (!merchantKey) {
      console.error("OxaPay Merchant API key is missing");
      return res.status(500).send("Payment configuration error");
    }

    // 1. Raw body + HMAC verification
    const raw = await readRawBody(req);

    const receivedHmac = req.headers["hmac"];
    if (typeof receivedHmac !== "string" || !/^[a-f0-9]{128}$/i.test(receivedHmac)) {
      return res.status(401).send("Invalid signature");
    }

    const calculated = crypto.createHmac("sha512", merchantKey).update(raw).digest();
