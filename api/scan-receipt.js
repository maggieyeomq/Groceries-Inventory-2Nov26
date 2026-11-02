// Reads a grocery receipt photo with Claude and returns the items bought,
// matched against the household inventory where possible.
// Needs the ANTHROPIC_API_KEY environment variable set in Vercel.

const LOCATIONS = ["Fridge", "Freezer", "Pantry", "Household"];
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_CHARS = 5_000_000; // base64 length, about 3.7 MB of image

const TOOL = {
  name: "record_receipt",
  description: "Record the grocery items bought on this receipt.",
  input_schema: {
    type: "object",
    properties: {
      is_receipt: {
        type: "boolean",
        description: "false if the photo is not a shop receipt or is unreadable",
      },
      store: { type: "string", description: "Shop name if visible, else empty" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short friendly product name, e.g. 'Eggs', 'Light soy sauce'" },
            qty: { type: "number", description: "How many household units were bought" },
            unit: { type: "string", description: "Unit for qty, e.g. pcs, pack, bottle, bag, can, box, kg, bunch, tray" },
            location: { type: "string", enum: LOCATIONS, description: "Where this is usually kept at home" },
            match_id: {
              type: ["string", "null"],
              description: "id of the matching inventory item if it is the same product, else null",
            },
            receipt_line: { type: "string", description: "The original receipt text for this item" },
          },
          required: ["name", "qty", "unit", "location", "match_id", "receipt_line"],
        },
      },
    },
    required: ["is_receipt", "store", "items"],
  },
};

function instructions(inventory) {
  const list = inventory.length
    ? inventory.map((i) => `- id=${i.id} | ${i.name} | counted in ${i.unit}`).join("\n")
    : "(empty)";
  return `This is a photo of a grocery receipt from a Singapore household's shopping trip.
List every grocery or household item that was bought.

Rules:
- Skip lines that are not products: subtotal, total, GST, rounding, discounts, member points, plastic bags, payment and change lines.
- If a discount line follows a product, still count the product once.
- Give each item a short, friendly name a family would use ("FP EGGS 10S" becomes "Eggs", "LKK LT SOY 500ML" becomes "Light soy sauce").
- qty is the number of household units bought, taking "x2" or "2 @" multipliers into account.
- If an item is the same product as one in the inventory below, set match_id to that id and give qty in that item's unit. For example, if Eggs is counted in pcs and the receipt shows "EGGS 10S x2", qty is 20.
- Otherwise set match_id to null and pick a sensible unit (a pack of 10 eggs is 10 pcs; a bottle of sauce is 1 bottle; a bag of rice is 1 bag).
- Pick where it is usually kept: Fridge, Freezer, Pantry or Household (for non-food like tissue or detergent).
- If you cannot read a line, leave it out rather than guess.

Current inventory:
${list}

Call record_receipt with the result.`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method", message: "Use POST." });
  }

  // Only accept requests from this app's own page.
  const origin = req.headers.origin || "";
  const host = req.headers.host || "";
  if (origin && origin.replace(/^https?:\/\//, "") !== host) {
    return res.status(403).json({ error: "origin", message: "Not allowed." });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(503).json({
      error: "missing_key",
      message: "Receipt scanning isn't switched on yet. Add ANTHROPIC_API_KEY in the Vercel project settings.",
    });
  }

  const body = req.body || {};
  const image = typeof body.image === "string" ? body.image : "";
  const mediaType = MEDIA_TYPES.includes(body.mediaType) ? body.mediaType : null;
  if (!image || !mediaType) {
    return res.status(400).json({ error: "bad_image", message: "Send a JPEG, PNG or WebP photo." });
  }
  if (image.length > MAX_IMAGE_CHARS) {
    return res.status(413).json({ error: "too_big", message: "That photo is too large. Try again." });
  }
  const inventory = (Array.isArray(body.inventory) ? body.inventory : [])
    .slice(0, 400)
    .map((i) => ({
      id: String(i.id || "").slice(0, 64),
      name: String(i.name || "").slice(0, 60).replace(/[\r\n|]/g, " "),
      unit: String(i.unit || "").slice(0, 20).replace(/[\r\n|]/g, " "),
    }))
    .filter((i) => i.id && i.name);

  let apiRes;
  try {
    apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.RECEIPT_MODEL || "claude-sonnet-5-5",
        max_tokens: 4000,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "record_receipt" },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
              { type: "text", text: instructions(inventory) },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return res.status(502).json({ error: "network", message: "Couldn't reach the receipt reader. Try again." });
  }

  const data = await apiRes.json().catch(() => null);
  if (!apiRes.ok || !data) {
    console.error("Anthropic API error", apiRes.status, data && data.error);
    const msg =
      apiRes.status === 401
        ? "The API key in Vercel isn't valid. Check ANTHROPIC_API_KEY."
        : apiRes.status === 429
        ? "Too many scans right now. Wait a minute and try again."
        : "The receipt reader had a problem. Try again.";
    return res.status(502).json({ error: "api", message: msg });
  }

  const call = (data.content || []).find((c) => c.type === "tool_use");
  const out = call && call.input ? call.input : { is_receipt: false, store: "", items: [] };
  const ids = new Set(inventory.map((i) => i.id));
  const items = (Array.isArray(out.items) ? out.items : [])
    .map((i) => ({
      name: String(i.name || "").trim().slice(0, 60),
      qty: Math.max(0, Math.round(Number(i.qty) * 100) / 100) || 1,
      unit: String(i.unit || "pcs").trim().slice(0, 20) || "pcs",
      location: LOCATIONS.includes(i.location) ? i.location : "Pantry",
      match_id: i.match_id && ids.has(String(i.match_id)) ? String(i.match_id) : null,
      receipt_line: String(i.receipt_line || "").slice(0, 120),
    }))
    .filter((i) => i.name);

  return res.status(200).json({ is_receipt: !!out.is_receipt, store: String(out.store || ""), items });
};
