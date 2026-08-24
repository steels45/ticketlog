// api/extract.js  —  Vercel serverless function
// Place this file at: ticketlog/api/extract.js
// This keeps your Anthropic API key server-side and out of the browser.

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { image } = req.body;
  if (!image) {
    return res.status(400).json({ error: "No image provided" });
  }

  const EXTRACTION_PROMPT = `You are an expert at reading trucking and hauling weight tickets from multiple suppliers.

You will see a ticket image. First identify which supplier issued it by looking for logos, company names, or distinctive layouts. Then extract the data using that supplier's field names.

KNOWN TICKET TYPES AND THEIR FIELD NAMES:
1. APAC (A CRH Company) - Fields: "Location", "Customer", "Order", "Product", "Vehicle", "Ticket No.", net weight shown as "XX.XX Ton"
2. ScaleHouse (Rigid Constructors) - Fields: "Truck", "Product", net weight under "Net" in tons, "Ticket #", "Cust ID" for customer
3. Amrize - Fields: "TRUCK", "PRODUCT", "CUSTOMER", "LOCATION", "Ticket No", net weight under "NET TON"
4. Terral Dray Receipt - Fields: "HAULER/TRUCK", "TONS" column for net, "JOB#", material listed in body text (e.g. "Sand")
5. Magnolia Sand & Gravel - Handwritten fields: "NAME" for customer, "ADDRESS" for job#, material handwritten in body, "Tare#" is truck ID, weights in LBS (convert Net LBS to tons by dividing by 2000)
6. Superior Sand And Gravel - Fields: "Truck", "Bill to" for customer, "Job #", "Material", net shown as "X LBS = XX.XX Tons"
7. G&W Sand & Gravel - Fields: "Truck", "Job", "Location", "Material", "Net Tons"

RULES:
- Always extract NET tonnage (not gross, not tare)
- If weight is only in LBS, convert: tons = lbs / 2000, round to 2 decimals
- Ticket number is the unique identifier printed on the ticket
- Supplier = the company whose name/logo is on the ticket (the pit or quarry)
- Customer = who ordered/purchased the material
- For truck number: look for Vehicle#, Truck, Unit#, Hauler/Truck, Tare# (Magnolia)
- If a field is not visible or blank, return null

SIGNATURE & STAMP DETECTION:
- signaturePresent: true if ANY handwritten signature is visible anywhere on the ticket
- stampPresent: true if ANY rubber stamp or ink stamp is visible (e.g. "RECEIVED", "APPROVED")
- A printed name is NOT a signature. Look for actual ink marks.

Return ONLY valid JSON, no markdown, no explanation:
{
  "supplier": "company name on the ticket",
  "ticketNumber": "ticket/receipt number",
  "date": "date from ticket",
  "time": "time from ticket",
  "customer": "customer or bill-to name",
  "jobNumber": "job#, order#, or PO number",
  "location": "job site, delivery location, or pit address",
  "truckNumber": "truck, vehicle, or unit number",
  "material": "material type",
  "grossWeight": "gross weight with unit",
  "tareWeight": "tare weight with unit",
  "netTons": "net weight in tons as decimal number only",
  "weighmaster": "weighmaster name if present",
  "signaturePresent": true or false,
  "stampPresent": true or false,
  "notes": "any other relevant info"
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: image },
              },
              { type: "text", text: EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Anthropic error:", err);
      return res.status(500).json({ error: "Anthropic API error" });
    }

    const data = await response.json();
    const text = data.content?.map((c) => c.text || "").join("") || "{}";

    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      return res.status(200).json(parsed);
    } catch {
      console.error("JSON parse error:", text);
      return res.status(500).json({ error: "Failed to parse AI response" });
    }
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
