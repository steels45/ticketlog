import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.REACT_APP_SUPABASE_ANON_KEY
);

const VIEWS = { HOME: "home", CAPTURE: "capture", REVIEW: "review", ADMIN: "admin" };

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatDate(iso) {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

// ── BLUR DETECTION ────────────────────────────────────────────────────────
function measureBlur(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 400 / Math.max(img.width, img.height));
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Laplacian variance — higher = sharper
      let sum = 0, sumSq = 0, n = 0;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const idx = (y * width + x) * 4;
          const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          const top = 0.299 * data[((y-1)*width+x)*4] + 0.587 * data[((y-1)*width+x)*4+1] + 0.114 * data[((y-1)*width+x)*4+2];
          const bot = 0.299 * data[((y+1)*width+x)*4] + 0.587 * data[((y+1)*width+x)*4+1] + 0.114 * data[((y+1)*width+x)*4+2];
          const lft = 0.299 * data[(y*width+x-1)*4] + 0.587 * data[(y*width+x-1)*4+1] + 0.114 * data[(y*width+x-1)*4+2];
          const rgt = 0.299 * data[(y*width+x+1)*4] + 0.587 * data[(y*width+x+1)*4+1] + 0.114 * data[(y*width+x+1)*4+2];
          const lap = Math.abs(-top - bot - lft - rgt + 4 * gray);
          sum += lap; sumSq += lap * lap; n++;
        }
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      resolve(variance); // < 80 = blurry, > 150 = sharp
    };
    img.src = dataUrl;
  });
}


async function getGPSLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        let address = null;
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
          const d = await r.json();
          address = d.display_name || null;
        } catch {}
        resolve({ latitude, longitude, accuracy: Math.round(accuracy), address });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

// ── AI EXTRACTION WITH TICKET PROFILES ───────────────────────────────────
// eslint-disable-next-line no-unused-vars
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
- Job/PO = the job number, order number, or PO number
- For truck number: look for Vehicle#, Truck, Unit#, Hauler/Truck, Tare# (Magnolia)
- If a field is not visible or blank, return null

SIGNATURE & STAMP DETECTION (important for billing validation):
- signaturePresent: true if ANY handwritten signature is visible anywhere on the ticket (driver signature, customer signature, received signature, etc.)
- stampPresent: true if ANY rubber stamp, ink stamp, or official mark is visible (e.g. "RECEIVED", "APPROVED", date stamps, company stamps)
- If neither is present, both should be false — this will flag the ticket for review
- A printed name is NOT a signature. A weighmaster printed name is NOT a stamp. Look for actual ink marks.

Return ONLY this JSON object, no markdown, no explanation:
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


async function extractTicketData(base64Image) {
  const response = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64Image }),
  });
  if (!response.ok) throw new Error("API error");
  const data = await response.json();
  return data;
}

const FIELD_LABELS = {
  supplier: "Supplier / Pit",
  ticketNumber: "Ticket #",
  date: "Date",
  time: "Time",
  customer: "Customer",
  jobNumber: "Job / PO #",
  location: "Location / Site",
  truckNumber: "Truck #",
  material: "Material",
  grossWeight: "Gross Weight",
  tareWeight: "Tare Weight",
  netTons: "Net Tons",
  weighmaster: "Weighmaster",
  notes: "Notes",
};

function buildFlags(ticket, allTickets) {
  const flags = [];
  if (ticket.blurScore !== null && ticket.blurScore < 80) flags.push({ id: "blur", label: "Blurry image", icon: "📷", color: "#f59e0b" });
  if (ticket.data?.signaturePresent === false && ticket.data?.stampPresent === false) flags.push({ id: "nosig", label: "No signature or stamp", icon: "✍️", color: "#ef4444" });
  if (ticket.data?.ticketNumber) {
    const dup = allTickets.find(
      (t) => t.id !== ticket.id &&
        t.data?.ticketNumber === ticket.data.ticketNumber &&
        t.data?.supplier === ticket.data.supplier
    );
    if (dup) flags.push({ id: "dup", label: `Duplicate ticket # (submitted by ${dup.driverName})`, icon: "⚠️", color: "#ef4444" });
  }
  // Date mismatch — ticket date vs capture date
  if (ticket.data?.date && ticket.timestamp) {
    try {
      const captureDate = new Date(ticket.timestamp);
      const captureDateStr = captureDate.toDateString();
      // Try to parse the ticket's printed date
      const ticketDateRaw = ticket.data.date.replace(/(\d+)\/(\d+)\/(\d{2})$/, "$1/$2/20$3"); // handle 2-digit years
      const ticketDate = new Date(ticketDateRaw);
      if (!isNaN(ticketDate.getTime())) {
        const ticketDateStr = ticketDate.toDateString();
        if (ticketDateStr !== captureDateStr) {
          const diffMs = captureDate - ticketDate;
          const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
          const label = diffDays === 1
            ? "Ticket dated yesterday"
            : diffDays > 1
            ? `Ticket dated ${diffDays} days ago (${ticket.data.date})`
            : diffDays < 0
            ? `Ticket date is in the future (${ticket.data.date})`
            : `Date mismatch: ticket says ${ticket.data.date}`;
          flags.push({ id: "dateshift", label, icon: "📅", color: "#f59e0b" });
        }
      }
    } catch {}
  }
  return flags;
}

// ── CSV EXPORT ────────────────────────────────────────────────────────────
function exportCSV(tickets) {
  const headers = [
    "Load #", "Driver", "Captured Date", "Captured Time",
    "Supplier", "Ticket #", "Ticket Date", "Ticket Time",
    "Customer", "Job / PO #", "Location", "Truck #",
    "Material", "Gross Weight", "Tare Weight", "Net Tons",
    "Weighmaster", "GPS Lat", "GPS Lng", "GPS Address",
    "Signature", "Stamp", "Flags", "Notes"
  ];
  const rows = tickets.map((t) => [
    t.loadNumber,
    t.driverName,
    formatDate(t.timestamp),
    formatTime(t.timestamp),
    t.data?.supplier || "",
    t.data?.ticketNumber || "",
    t.data?.date || "",
    t.data?.time || "",
    t.data?.customer || "",
    t.data?.jobNumber || "",
    t.data?.location || "",
    t.data?.truckNumber || "",
    t.data?.material || "",
    t.data?.grossWeight || "",
    t.data?.tareWeight || "",
    t.data?.netTons || "",
    t.data?.weighmaster || "",
    t.gps?.latitude || "",
    t.gps?.longitude || "",
    t.gps?.address ? t.gps.address.split(",").slice(0, 3).join(",") : "",
    t.data?.signaturePresent ? "Yes" : "No",
    t.data?.stampPresent ? "Yes" : "No",
    (t.flags || []).map((f) => f.label).join("; "),
    t.data?.notes || "",
  ]);
  const csv = [headers, ...rows]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tickets-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── PDF EXPORT ────────────────────────────────────────────────────────────
function exportPDF(tickets, dateLabel) {
  // Group by driver then sort by load number
  const byDriver = {};
  tickets.forEach((t) => {
    if (!byDriver[t.driverName]) byDriver[t.driverName] = [];
    byDriver[t.driverName].push(t);
  });
  Object.values(byDriver).forEach((arr) => arr.sort((a, b) => a.loadNumber - b.loadNumber));

  const totalTons = tickets.reduce((s, t) => s + (parseFloat(t.data?.netTons) || 0), 0);

  const flagColor = (f) => f.id === "dup" || f.id === "nosig" ? "#dc2626" : "#d97706";

  const ticketPages = Object.entries(byDriver).flatMap(([driver, driverTickets]) =>
    driverTickets.map((t) => `
      <div class="page">
        <div class="page-header">
          <div class="page-driver">${driver}</div>
          <div class="page-load">${ordinal(t.loadNumber)} Load</div>
          <div class="page-time">Captured: ${formatDate(t.timestamp)} ${formatTime(t.timestamp)}</div>
        </div>
        <div class="page-body">
          <div class="img-col">
            <img src="${t.image}" class="ticket-img" />
            ${(t.flags || []).map((f) => `<div class="flag-pill" style="background:${flagColor(f)}20;border:1px solid ${flagColor(f)}60;color:${flagColor(f)}">${f.icon} ${f.label}</div>`).join("")}
          </div>
          <div class="data-col">
            ${t.data?.netTons ? `<div class="tons-box"><span class="tons-num">${t.data.netTons}</span><span class="tons-label">NET TONS</span></div>` : ""}
            <table class="data-table">
              ${[
                ["Supplier", t.data?.supplier],
                ["Ticket #", t.data?.ticketNumber],
                ["Ticket Date", t.data?.date],
                ["Customer", t.data?.customer],
                ["Job / PO #", t.data?.jobNumber],
                ["Location", t.data?.location],
                ["Truck #", t.data?.truckNumber],
                ["Material", t.data?.material],
                ["Gross", t.data?.grossWeight],
                ["Tare", t.data?.tareWeight],
                ["Weighmaster", t.data?.weighmaster],
                ["GPS", t.gps ? `${t.gps.latitude.toFixed(5)}, ${t.gps.longitude.toFixed(5)}` : null],
                ["Notes", t.data?.notes],
              ].filter(([, v]) => v).map(([k, v]) => `
                <tr><td class="dt-key">${k}</td><td class="dt-val">${v}</td></tr>
              `).join("")}
            </table>
          </div>
        </div>
      </div>
    `)
  ).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Ticket Report — ${dateLabel}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, Arial, sans-serif; background: #f8f9fa; color: #111; }
    .cover { padding: 60px 48px; background: #0f1117; color: #fff; min-height: 200px; }
    .cover-title { font-size: 32px; font-weight: 800; color: #f5a623; font-family: monospace; }
    .cover-sub { font-size: 15px; color: #9ca3af; margin-top: 6px; }
    .cover-stats { display: flex; gap: 48px; margin-top: 32px; }
    .cover-stat-num { font-size: 40px; font-weight: 800; color: #f5a623; font-family: monospace; }
    .cover-stat-label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }
    .driver-divider { background: #1a1d27; color: #f5a623; padding: 14px 48px; font-size: 14px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; border-top: 3px solid #f5a623; }
    .page { background: #fff; margin: 0; padding: 24px 32px; border-bottom: 2px solid #e5e7eb; page-break-inside: avoid; }
    .page-header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #e5e7eb; }
    .page-driver { font-size: 15px; font-weight: 700; color: #111; }
    .page-load { font-size: 13px; font-weight: 700; color: #f5a623; background: #fff8ed; padding: 3px 10px; border-radius: 20px; border: 1px solid #f5a62340; }
    .page-time { font-size: 12px; color: #9ca3af; margin-left: auto; }
    .page-body { display: flex; gap: 24px; }
    .img-col { flex: 0 0 220px; display: flex; flex-direction: column; gap: 8px; }
    .ticket-img { width: 220px; height: 280px; object-fit: contain; border: 1px solid #e5e7eb; border-radius: 8px; background: #f9fafb; }
    .flag-pill { font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 20px; }
    .data-col { flex: 1; }
    .tons-box { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; padding: 12px 16px; background: #fff8ed; border: 1px solid #f5a62340; border-radius: 8px; }
    .tons-num { font-size: 36px; font-weight: 800; color: #f5a623; font-family: monospace; }
    .tons-label { font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
    .data-table { width: 100%; border-collapse: collapse; }
    .data-table tr { border-bottom: 1px solid #f3f4f6; }
    .dt-key { font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.06em; padding: 6px 0; width: 110px; font-weight: 600; }
    .dt-val { font-size: 13px; color: #111; font-weight: 500; padding: 6px 0; }
    .summary { background: #0f1117; color: #fff; padding: 32px 48px; margin-top: 0; }
    .summary-title { font-size: 16px; font-weight: 700; color: #f5a623; margin-bottom: 16px; }
    .summary-table { width: 100%; border-collapse: collapse; }
    .summary-table th { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; padding: 8px 0; text-align: left; border-bottom: 1px solid #2a2f45; }
    .summary-table td { font-size: 13px; color: #e8eaf2; padding: 8px 0; border-bottom: 1px solid #1e2235; }
    .summary-table .tons-cell { color: #f5a623; font-weight: 700; font-family: monospace; }
    @media print { body { background: white; } .page { border: none; } }
  </style></head><body>
  <div class="cover">
    <div class="cover-title">🚛 TicketLog</div>
    <div class="cover-sub">Daily Ticket Report — ${dateLabel} · Generated ${formatDate(new Date().toISOString())} ${formatTime(new Date().toISOString())}</div>
    <div class="cover-stats">
      <div><div class="cover-stat-num">${tickets.length}</div><div class="cover-stat-label">Total Tickets</div></div>
      <div><div class="cover-stat-num">${totalTons.toFixed(1)}</div><div class="cover-stat-label">Net Tons</div></div>
      <div><div class="cover-stat-num">${Object.keys(byDriver).length}</div><div class="cover-stat-label">Drivers</div></div>
      <div><div class="cover-stat-num">${tickets.filter(t => t.flagged).length}</div><div class="cover-stat-label">Flagged</div></div>
    </div>
  </div>
  ${Object.entries(byDriver).map(([driver, driverTickets]) => `
    <div class="driver-divider">📋 ${driver} — ${driverTickets.length} loads · ${driverTickets.reduce((s,t) => s+(parseFloat(t.data?.netTons)||0),0).toFixed(1)} tons</div>
    ${driverTickets.map(t => ticketPages[tickets.indexOf(t)] || "").join("")}
  `).join("")}
  <div class="summary">
    <div class="summary-title">Summary by Driver</div>
    <table class="summary-table">
      <tr><th>Driver</th><th>Loads</th><th>Net Tons</th><th>Flags</th></tr>
      ${Object.entries(byDriver).map(([driver, dt]) => `
        <tr>
          <td>${driver}</td>
          <td>${dt.length}</td>
          <td class="tons-cell">${dt.reduce((s,t)=>s+(parseFloat(t.data?.netTons)||0),0).toFixed(1)}</td>
          <td>${dt.filter(t=>t.flagged).length > 0 ? `⚠️ ${dt.filter(t=>t.flagged).length}` : "✓"}</td>
        </tr>
      `).join("")}
      <tr style="border-top:2px solid #2a2f45">
        <td style="font-weight:700;color:#f5a623">TOTAL</td>
        <td style="font-weight:700;color:#f5a623">${tickets.length}</td>
        <td style="font-weight:700;color:#f5a623" class="tons-cell">${totalTons.toFixed(1)}</td>
        <td style="font-weight:700;color:#f5a623">${tickets.filter(t=>t.flagged).length > 0 ? `⚠️ ${tickets.filter(t=>t.flagged).length}` : "✓"}</td>
      </tr>
    </table>
  </div>
  </body></html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ticket-report-${new Date().toISOString().slice(0,10)}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── PUSH NOTIFICATION STUB (wire in when hosted) ──────────────────────────
// When hosted, replace this with Firebase Cloud Messaging or Web Push API.
// Required setup: service worker, VAPID keys, FCM project.
// Trigger points:
//   1. Driver inactive > X hours: check lastTicketTime per driver in Supabase
//   2. New job assignment: admin writes to notifications table, FCM fans out
//   3. Flagged ticket submitted: trigger on ticket save if flags.length > 0

// ── DEFAULT ROSTER (used first time, then stored in shared storage) ────────
const DEFAULT_DRIVERS = [
  { name: "Sam",   pin: "11111" },
  { name: "Mike",  pin: "22222" },
  { name: "Jake",  pin: "33333" },
];
const ADMIN_PIN = "99999"; // Default admin PIN — change after first login

export default function App() {
  const [view, setView]           = useState(VIEWS.HOME);
  // Auth
  const [authState, setAuthState] = useState("splash"); // splash|driver-login|admin-login|driver|admin
  const [driverName, setDriverName] = useState("");
  const [roster, setRoster]       = useState(DEFAULT_DRIVERS);
  const [loginName, setLoginName] = useState("");
  const [loginPin, setLoginPin]   = useState("");
  const [adminPin, setAdminPin]   = useState(ADMIN_PIN);
  const [loginError, setLoginError] = useState("");
  // Roster management
  const [newDriverName, setNewDriverName] = useState("");
  const [newDriverPin, setNewDriverPin]   = useState("");
  const [rosterMsg, setRosterMsg] = useState("");
  // Tickets
  const [tickets, setTickets]     = useState([]);
  const [previewImg, setPreviewImg] = useState(null);
  const [editData, setEditData]   = useState({});
  const [gpsData, setGpsData]     = useState(null);
  const [gpsStatus, setGpsStatus] = useState("idle");
  const [blurScore, setBlurScore] = useState(null);
  const [blurWarning, setBlurWarning] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [adminView, setAdminView] = useState("all");
  const [exporting, setExporting] = useState(null);
  const fileRef = useRef();
  const today = new Date().toDateString();

  // Load roster + session on mount
  useEffect(() => {
    async function init() {
      try {
        // Load roster from Supabase
        const { data: drivers } = await supabase.from("drivers").select("*").order("name");
        if (drivers) setRoster(drivers.map(d => ({ name: d.name, pin: d.pin })));
        // Load admin PIN from localStorage
        const ap = localStorage.getItem("adminPin");
        if (ap) setAdminPin(ap);
        // Restore session from localStorage
        const sess = localStorage.getItem("session");
        if (sess) {
          const { name, role } = JSON.parse(sess);
          if (role === "driver") { setDriverName(name); setAuthState("driver"); loadTickets(); }
          else if (role === "admin") { setAuthState("admin"); loadTickets(); }
          else setAuthState("driver-login");
        } else {
          setAuthState("driver-login");
        }
      } catch { setAuthState("driver-login"); }
    }
    init();
  }, []);

  async function saveRoster(newRoster) {
    setRoster(newRoster);
    try {
      // Sync to Supabase — delete all and reinsert
      await supabase.from("drivers").delete().neq("name", "");
      if (newRoster.length > 0) {
        await supabase.from("drivers").insert(newRoster.map(d => ({ name: d.name, pin: d.pin })));
      }
    } catch {}
  }

  async function handleDriverLogin() {
    setLoginError("");
    const driver = roster.find(d => d.name.toLowerCase() === loginName.trim().toLowerCase() && d.pin === loginPin.trim());
    if (!driver) { setLoginError("Name or PIN is incorrect."); setLoginPin(""); return; }
    setDriverName(driver.name);
    setAuthState("driver");
    try { localStorage.setItem("session", JSON.stringify({ name: driver.name, role: "driver" })); } catch {}
    loadTickets();
  }

  async function handleAdminLogin() {
    setLoginError("");
    if (loginPin.trim() !== adminPin) { setLoginError("Incorrect admin PIN."); setLoginPin(""); return; }
    setAuthState("admin");
    try { localStorage.setItem("session", JSON.stringify({ name: "admin", role: "admin" })); } catch {}
    loadTickets();
  }

  async function handleLogout() {
    try { localStorage.removeItem("session"); } catch {}
    setDriverName(""); setLoginName(""); setLoginPin(""); setLoginError("");
    setAuthState("driver-login"); setView(VIEWS.HOME); resetCapture();
  }

  async function handleAddDriver() {
    setRosterMsg("");
    if (!newDriverName.trim()) { setRosterMsg("Enter a name."); return; }
    if (newDriverPin.length !== 5 || !/^\d+$/.test(newDriverPin)) { setRosterMsg("PIN must be exactly 5 digits."); return; }
    if (roster.find(d => d.name.toLowerCase() === newDriverName.trim().toLowerCase())) { setRosterMsg("Driver already exists."); return; }
    const updated = [...roster, { name: newDriverName.trim(), pin: newDriverPin }];
    await saveRoster(updated);
    setNewDriverName(""); setNewDriverPin(""); setRosterMsg(`✓ ${newDriverName.trim()} added.`);
  }

  async function handleRemoveDriver(name) {
    const updated = roster.filter(d => d.name !== name);
    await saveRoster(updated);
    setRosterMsg(`✓ ${name} removed.`);
  }

  async function handleResetPin(name, newPin) {
    if (newPin.length !== 5 || !/^\d+$/.test(newPin)) return;
    const updated = roster.map(d => d.name === name ? { ...d, pin: newPin } : d);
    await saveRoster(updated);
    setRosterMsg(`✓ PIN updated for ${name}.`);
  }

  async function loadTickets() {
    try {
      const { data } = await supabase
        .from("tickets")
        .select("*")
        .order("timestamp", { ascending: false });
      if (data) setTickets(data.map(t => ({
        ...t,
        driverName: t.driver_name,
        loadNumber: t.load_number,
        blurScore: t.blur_score,
      })));
    } catch {}
  }

  function myTicketsToday() {
    return tickets.filter((t) => t.driverName === driverName && new Date(t.timestamp).toDateString() === today);
  }

  async function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    setGpsStatus("fetching");
    setBlurScore(null);
    setBlurWarning(false);
    const gpsPromise = getGPSLocation();
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target.result;
      setPreviewImg(dataUrl);
      setView(VIEWS.CAPTURE);
      const [coords, blur] = await Promise.all([gpsPromise, measureBlur(dataUrl)]);
      setBlurScore(blur);
      setBlurWarning(blur < 80);
      if (coords) { setGpsData(coords); setGpsStatus("ok"); }
      else { setGpsStatus("failed"); }
    };
    reader.readAsDataURL(file);
  }

  async function handleAnalyze() {
    setLoading(true);
    setLoadError(null);
    setDuplicateWarning(null);
    try {
      const base64 = previewImg.split(",")[1];
      const data = await extractTicketData(base64);
      setEditData(data);
      // Check for duplicate ticket number immediately after extraction
      if (data.ticketNumber && data.supplier) {
        const dup = tickets.find(
          (t) => t.data?.ticketNumber === data.ticketNumber && t.data?.supplier === data.supplier
        );
        if (dup) setDuplicateWarning({ ticketNumber: data.ticketNumber, supplier: data.supplier, submittedBy: dup.driverName, submittedAt: dup.timestamp });
      }
      setView(VIEWS.REVIEW);
    } catch {
      setLoadError("Failed to analyze image. Check connection and try again.");
    }
    setLoading(false);
  }

  async function handleSave(forceDuplicate = false) {
    if (duplicateWarning && !forceDuplicate) return; // Block save unless overridden
    const myToday = myTicketsToday();
    const tempTicket = { id: "temp", data: editData, blurScore };
    const flags = buildFlags(tempTicket, tickets);
    const ticket = {
      id: `ticket:${driverName}-${Date.now()}`,
      driverName,
      loadNumber: myToday.length + 1,
      timestamp: new Date().toISOString(),
      image: previewImg,
      data: editData,
      gps: gpsData || null,
      blurScore,
      flags,
      flagged: flags.length > 0,
    };
    try {
      const { error } = await supabase.from("tickets").insert({
        id: ticket.id,
        driver_name: ticket.driverName,
        load_number: ticket.loadNumber,
        timestamp: ticket.timestamp,
        image: ticket.image,
        data: ticket.data,
        gps: ticket.gps,
        blur_score: ticket.blurScore,
        flags: ticket.flags,
        flagged: ticket.flagged,
      });
      if (error) throw error;
      setTickets((prev) => [ticket, ...prev]);
      resetCapture();
      setView(VIEWS.HOME);
    } catch {
      setLoadError("Failed to save ticket. Try again.");
    }
  }

  function resetCapture() {
    setPreviewImg(null);
    setEditData({});
    setGpsData(null);
    setGpsStatus("idle");
    setBlurScore(null);
    setBlurWarning(false);
    setDuplicateWarning(null);
    setLoadError(null);
  }

  // ── SPLASH ───────────────────────────────────────────────────────────────
  if (authState === "splash") {
    return (
      <div style={S.loginWrap}>
        <div style={S.loginCard}>
          <div style={S.logoMark}>🚛</div>
          <h1 style={S.loginTitle}>TicketLog</h1>
          <div style={{ color: C.textMuted, fontSize: 13 }}>Loading…</div>
        </div>
      </div>
    );
  }

  // ── DRIVER LOGIN ─────────────────────────────────────────────────────────
  if (authState === "driver-login") {
    return (
      <div style={S.loginWrap}>
        <div style={S.loginCard}>
          <div style={S.logoMark}>🚛</div>
          <h1 style={S.loginTitle}>TicketLog</h1>
          <p style={S.loginSub}>Driver Sign In</p>
          <input style={S.loginInput} placeholder="Your name" value={loginName}
            onChange={(e) => { setLoginName(e.target.value); setLoginError(""); }} />
          <input style={S.loginInput} placeholder="5-digit PIN" type="password"
            inputMode="numeric" maxLength={5} value={loginPin}
            onChange={(e) => { setLoginPin(e.target.value.replace(/\D/g,"")); setLoginError(""); }}
            onKeyDown={(e) => e.key === "Enter" && handleDriverLogin()} />
          {loginError && <div style={S.loginError}>{loginError}</div>}
          <button style={S.loginBtn} onClick={handleDriverLogin}>Sign In →</button>
          <button style={S.loginGhost} onClick={() => { setLoginName(""); setLoginPin(""); setLoginError(""); setAuthState("admin-login"); }}>
            Admin Login
          </button>
        </div>
      </div>
    );
  }

  // ── ADMIN LOGIN ──────────────────────────────────────────────────────────
  if (authState === "admin-login") {
    return (
      <div style={S.loginWrap}>
        <div style={S.loginCard}>
          <div style={S.logoMark}>🔐</div>
          <h1 style={S.loginTitle}>Admin</h1>
          <p style={S.loginSub}>Authorized Access Only</p>
          <input style={S.loginInput} placeholder="5-digit Admin PIN" type="password"
            inputMode="numeric" maxLength={5} value={loginPin}
            onChange={(e) => { setLoginPin(e.target.value.replace(/\D/g,"")); setLoginError(""); }}
            onKeyDown={(e) => e.key === "Enter" && handleAdminLogin()} />
          {loginError && <div style={S.loginError}>{loginError}</div>}
          <button style={{ ...S.loginBtn, background: "#7c3aed" }} onClick={handleAdminLogin}>
            Admin Sign In →
          </button>
          <button style={S.loginGhost} onClick={() => { setLoginPin(""); setLoginError(""); setAuthState("driver-login"); }}>
            ← Back to Driver Login
          </button>
        </div>
      </div>
    );
  }

  // ── CAPTURE ─────────────────────────────────────────────────────────────
  if (view === VIEWS.CAPTURE) {
    const isBlurry = blurWarning;
    return (
      <div style={S.wrap}>
        <Header title="Review Photo" sub={driverName} onBack={() => { resetCapture(); setView(VIEWS.HOME); }} />
        <div style={S.captureBody}>
          <div style={{ position: "relative" }}>
            {previewImg && <img src={previewImg} alt="ticket" style={S.previewImg} />}
            {isBlurry && (
              <div style={S.blurOverlay}>
                <div style={S.blurIcon}>⚠️</div>
                <div style={S.blurOverlayText}>Image appears blurry</div>
              </div>
            )}
          </div>

          {blurScore !== null && (
            <div style={{ ...S.statusCard, borderColor: isBlurry ? C.danger + "60" : C.green + "60", background: isBlurry ? "rgba(239,68,68,0.07)" : "rgba(34,197,94,0.07)" }}>
              <span style={{ fontSize: 16 }}>{isBlurry ? "⚠️" : "✅"}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: isBlurry ? C.danger : C.green }}>
                  {isBlurry ? "Blurry image detected" : "Image looks sharp"}
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {isBlurry ? "Retake for best extraction accuracy" : "Good quality — ready to extract"}
                </div>
              </div>
            </div>
          )}

          <GPSBanner status={gpsStatus} gps={gpsData} />
          {loadError && <div style={S.error}>{loadError}</div>}

          {isBlurry ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button style={S.primaryBtn} onClick={() => { resetCapture(); setView(VIEWS.HOME); setTimeout(() => fileRef.current?.click(), 100); }}>
                📷 Retake Photo
              </button>
              <button style={S.ghostBtn} onClick={handleAnalyze} disabled={loading}>
                {loading ? "Analyzing…" : "Use Anyway →"}
              </button>
            </div>
          ) : (
            <button style={S.primaryBtn} onClick={handleAnalyze} disabled={loading}>
              {loading ? "Analyzing ticket…" : "✦ Extract Ticket Data"}
            </button>
          )}
          <button style={S.ghostBtn} onClick={() => { resetCapture(); setView(VIEWS.HOME); }}>Cancel</button>
        </div>
      </div>
    );
  }

  // ── REVIEW ──────────────────────────────────────────────────────────────
  if (view === VIEWS.REVIEW) {
    const loadNum = myTicketsToday().length + 1;
    return (
      <div style={S.wrap}>
        <Header title={`${ordinal(loadNum)} Load — Review & Save`} sub={driverName} onBack={() => setView(VIEWS.CAPTURE)} />
        <div style={S.reviewBody}>
          <div style={S.reviewImgRow}>
            <img src={previewImg} alt="ticket" style={S.thumbImg} />
            <div style={S.reviewMeta}>
              {editData.supplier && <div style={S.supplierBadge}>{editData.supplier}</div>}
              {editData.ticketNumber && <div style={S.ticketNumBig}>#{editData.ticketNumber}</div>}
              {blurWarning && <div style={S.blurFlagSmall}>⚠️ Blurry</div>}
            </div>
          </div>

          {/* Net Tons highlight */}
          {editData.netTons && (
            <div style={S.tonnageHighlight}>
              <span style={S.tonnageNum}>{editData.netTons}</span>
              <span style={S.tonnageLabel}>Net Tons</span>
            </div>
          )}

          <GPSCard gps={gpsData} status={gpsStatus} />

          {/* Duplicate ticket warning — blocks save */}
          {duplicateWarning && (
            <div style={S.dupWarning}>
              <div style={S.dupWarningTitle}>⚠️ Duplicate Ticket Detected</div>
              <div style={S.dupWarningText}>
                Ticket <strong>#{duplicateWarning.ticketNumber}</strong> from <strong>{duplicateWarning.supplier}</strong> was already submitted by <strong>{duplicateWarning.submittedBy}</strong> at {formatTime(duplicateWarning.submittedAt)}.
              </div>
              <div style={S.dupWarningText}>Verify this is a different load before saving.</div>
            </div>
          )}

          {/* Signature/stamp warning — allows save but flags */}
          {editData.signaturePresent === false && editData.stampPresent === false && (
            <div style={S.sigWarning}>
              <span style={{ fontSize: 16 }}>✍️</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#f59e0b" }}>No signature or stamp detected</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>Ticket will be flagged for review. You can still save.</div>
              </div>
            </div>
          )}

          <div style={S.fieldsGrid}>
            {Object.entries(FIELD_LABELS).filter(([k]) => k !== "signaturePresent" && k !== "stampPresent").map(([key, label]) => (
              <div key={key} style={key === "notes" || key === "location" || key === "customer" ? { ...S.fieldWrap, gridColumn: "span 2" } : S.fieldWrap}>
                <label style={S.fieldLabel}>{label}</label>
                <input style={S.fieldInput} value={editData[key] || ""}
                  onChange={(e) => setEditData((p) => ({ ...p, [key]: e.target.value }))}
                  placeholder="—" />
              </div>
            ))}
          </div>

          {loadError && <div style={S.error}>{loadError}</div>}

          {duplicateWarning ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button style={{ ...S.primaryBtn, background: C.danger }} onClick={() => handleSave(true)}>
                Save Anyway (Override Duplicate)
              </button>
              <button style={S.ghostBtn} onClick={() => { resetCapture(); setView(VIEWS.HOME); }}>Discard Ticket</button>
            </div>
          ) : (
            <>
              <button style={S.primaryBtn} onClick={() => handleSave(false)}>✓ Save Ticket</button>
              <button style={S.ghostBtn} onClick={() => { resetCapture(); setView(VIEWS.HOME); }}>Discard</button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── ADMIN ────────────────────────────────────────────────────────────────
  if (authState === "admin") {
    const allDrivers = [...new Set(tickets.map((t) => t.driverName))];
    const todayTickets = tickets.filter((t) => new Date(t.timestamp).toDateString() === today);
    const totalTonnage = todayTickets.reduce((sum, t) => {
      const v = parseFloat(t.data?.netTons);
      return sum + (isNaN(v) ? 0 : v);
    }, 0);
    const flagged = todayTickets.filter((t) => t.flagged);
    const dupCount = flagged.filter((t) => t.flags?.some((f) => f.id === "dup")).length;
    const noSigCount = flagged.filter((t) => t.flags?.some((f) => f.id === "nosig")).length;
    const blurCount = flagged.filter((t) => t.flags?.some((f) => f.id === "blur")).length;
    const dateCount = flagged.filter((t) => t.flags?.some((f) => f.id === "dateshift")).length;

    return (
      <div style={S.wrap}>
        {/* Admin header */}
        <div style={S.adminHeader}>
          <div>
            <div style={S.adminHeaderTitle}>🔐 Admin Dashboard</div>
            <div style={S.adminHeaderSub}>{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
          </div>
          <button style={S.logoutBtn} onClick={handleLogout}>Sign Out</button>
        </div>

        <div style={S.adminBody}>
          <div style={S.statsRow}>
            <Stat label="Tickets" value={todayTickets.length} />
            <Stat label="Net Tons" value={totalTonnage > 0 ? totalTonnage.toFixed(1) : "—"} />
            <Stat label="Drivers" value={[...new Set(todayTickets.map((t) => t.driverName))].length} />
          </div>

          {flagged.length > 0 && (
            <div style={S.flagBannerWrap}>
              <div style={S.flagBannerTitle}>⚠️ {flagged.length} ticket{flagged.length > 1 ? "s" : ""} need review</div>
              <div style={S.flagBannerItems}>
                {dupCount > 0 && <span style={S.flagChip("#ef4444")}>⚠️ {dupCount} duplicate{dupCount > 1 ? "s" : ""}</span>}
                {noSigCount > 0 && <span style={S.flagChip("#ef4444")}>✍️ {noSigCount} no sig/stamp</span>}
                {dateCount > 0 && <span style={S.flagChip("#f59e0b")}>📅 {dateCount} date mismatch{dateCount > 1 ? "es" : ""}</span>}
                {blurCount > 0 && <span style={S.flagChip("#f59e0b")}>📷 {blurCount} blurry</span>}
              </div>
            </div>
          )}

          <div style={S.segmented}>
            <button style={{ ...S.seg, ...(adminView === "all" ? S.segActive : {}) }} onClick={() => setAdminView("all")}>Tickets</button>
            <button style={{ ...S.seg, ...(adminView === "by-driver" ? S.segActive : {}) }} onClick={() => setAdminView("by-driver")}>By Driver</button>
            <button style={{ ...S.seg, ...(adminView === "export" ? S.segActive : {}) }} onClick={() => setAdminView("export")}>Export</button>
            <button style={{ ...S.seg, ...(adminView === "roster" ? S.segActive : {}) }} onClick={() => { setAdminView("roster"); setRosterMsg(""); }}>Roster</button>
          </div>

          {adminView === "export" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* PDF Export */}
              <div style={S.exportCard}>
                <div style={S.exportCardHeader}>
                  <span style={S.exportIcon}>📄</span>
                  <div>
                    <div style={S.exportTitle}>PDF Report</div>
                    <div style={S.exportSub}>All tickets sorted by driver · load number. Includes photos, extracted data, flags, and tonnage summary.</div>
                  </div>
                </div>
                <button style={{ ...S.primaryBtn, marginTop: 8 }}
                  disabled={exporting === "pdf" || todayTickets.length === 0}
                  onClick={async () => {
                    setExporting("pdf");
                    const dateLabel = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
                    exportPDF(todayTickets, dateLabel);
                    setTimeout(() => setExporting(null), 1500);
                  }}>
                  {exporting === "pdf" ? "Generating…" : `📄 Export PDF (${todayTickets.length} tickets)`}
                </button>
                <div style={S.exportNote}>Downloads as an HTML file — open in any browser and print to PDF, or share directly.</div>
              </div>

              {/* CSV Export */}
              <div style={S.exportCard}>
                <div style={S.exportCardHeader}>
                  <span style={S.exportIcon}>📊</span>
                  <div>
                    <div style={S.exportTitle}>CSV / Spreadsheet</div>
                    <div style={S.exportSub}>One row per ticket with all fields — driver, truck, tonnage, job#, GPS, flags. Opens directly in Excel or Google Sheets for invoicing.</div>
                  </div>
                </div>
                <button style={{ ...S.primaryBtn, background: "#16a34a", marginTop: 8 }}
                  disabled={exporting === "csv" || todayTickets.length === 0}
                  onClick={() => {
                    setExporting("csv");
                    exportCSV(todayTickets);
                    setTimeout(() => setExporting(null), 800);
                  }}>
                  {exporting === "csv" ? "Exporting…" : `📊 Export CSV (${todayTickets.length} tickets)`}
                </button>
                <div style={S.exportNote}>All {todayTickets.length} tickets · {totalTonnage.toFixed(1)} net tons · exported as of {formatTime(new Date().toISOString())}</div>
              </div>

              {/* Push Notification Stub */}
              <div style={{ ...S.exportCard, border: `1px dashed ${C.border}`, opacity: 0.75 }}>
                <div style={S.exportCardHeader}>
                  <span style={S.exportIcon}>🔔</span>
                  <div>
                    <div style={S.exportTitle}>Push Notifications <span style={{ fontSize: 11, color: C.accent, background: C.accentDim, padding: "2px 8px", borderRadius: 20, marginLeft: 6 }}>Coming when hosted</span></div>
                    <div style={S.exportSub}>Alert inactive drivers · send job assignments · notify admin of flagged tickets in real time.</div>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                  {[
                    { icon: "⏰", label: "Alert drivers inactive 2+ hours", ready: false },
                    { icon: "📋", label: "Broadcast new job assignment", ready: false },
                    { icon: "⚠️", label: "Notify admin on flagged ticket", ready: false },
                  ].map((item) => (
                    <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: C.bg, borderRadius: 10 }}>
                      <span>{item.icon}</span>
                      <span style={{ flex: 1, fontSize: 13, color: C.textDim }}>{item.label}</span>
                      <span style={{ fontSize: 11, color: C.textMuted }}>Needs hosting</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {adminView === "all" && (
            <div style={S.ticketList}>
              {todayTickets.length === 0 && <p style={S.empty}>No tickets today.</p>}
              {todayTickets.map((t) => <TicketCard key={t.id} ticket={t} onClick={() => setSelectedTicket(t)} />)}
            </div>
          )}
          {adminView === "by-driver" && allDrivers.map((driver) => {
            const dt = todayTickets.filter((t) => t.driverName === driver);
            if (!dt.length) return null;
            const driverTons = dt.reduce((s, t) => s + (parseFloat(t.data?.netTons) || 0), 0);
            return (
              <div key={driver} style={S.driverGroup}>
                <div style={S.driverGroupHeader}>
                  <span style={S.driverGroupName}>{driver}</span>
                  <span style={S.driverGroupCount}>{dt.length} loads · {driverTons.toFixed(1)}t</span>
                </div>
                {dt.map((t) => <TicketCard key={t.id} ticket={t} onClick={() => setSelectedTicket(t)} compact />)}
              </div>
            );
          })}
          {adminView === "roster" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Add driver */}
              <div style={S.exportCard}>
                <div style={S.exportTitle}>➕ Add Driver</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                  <input style={S.fieldInput} placeholder="Driver name" value={newDriverName}
                    onChange={(e) => { setNewDriverName(e.target.value); setRosterMsg(""); }} />
                  <input style={S.fieldInput} placeholder="5-digit PIN" type="password"
                    inputMode="numeric" maxLength={5} value={newDriverPin}
                    onChange={(e) => { setNewDriverPin(e.target.value.replace(/\D/g,"")); setRosterMsg(""); }} />
                  <button style={S.primaryBtn} onClick={handleAddDriver}>Add Driver</button>
                  {rosterMsg && <div style={{ fontSize: 13, color: rosterMsg.startsWith("✓") ? C.green : C.danger, textAlign: "center" }}>{rosterMsg}</div>}
                </div>
              </div>

              {/* Driver roster */}
              <div style={S.exportCard}>
                <div style={S.exportTitle}>👥 Driver Roster ({roster.length})</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                  {roster.map((d) => (
                    <RosterRow key={d.name} driver={d} onRemove={handleRemoveDriver} onResetPin={handleResetPin} />
                  ))}
                  {roster.length === 0 && <div style={{ fontSize: 13, color: C.textMuted, textAlign: "center", padding: "16px 0" }}>No drivers added yet.</div>}
                </div>
              </div>

              {/* Admin PIN change */}
              <AdminPinChanger currentPin={adminPin} onSave={async (p) => {
                setAdminPin(p);
                try { localStorage.setItem("adminPin", p); } catch {}
                setRosterMsg("✓ Admin PIN updated.");
              }} />
            </div>
          )}

        </div>
        {selectedTicket && <TicketModal ticket={selectedTicket} onClose={() => setSelectedTicket(null)} />}
      </div>
    );
  }

  // ── HOME (DRIVER) ────────────────────────────────────────────────────────
  const myLoads = myTicketsToday();
  const myTons = myLoads.reduce((s, t) => s + (parseFloat(t.data?.netTons) || 0), 0);

  return (
    <div style={S.wrap}>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handleFileSelect} />

      <div style={S.homeHeader}>
        <div>
          <div style={S.homeGreeting}>Hey, {driverName.split(" ")[0]} 👋</div>
          <div style={S.homeDate}>{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
        </div>
        <button style={S.logoutBtn} onClick={handleLogout}>Sign Out</button>
      </div>















      <div style={S.statsHomeRow}>
        <div style={S.statHome}>
          <span style={S.statHomeNum}>{myLoads.length}</span>
          <span style={S.statHomeLabel}>{myLoads.length === 1 ? "Load" : "Loads"}</span>
        </div>
        <div style={S.statHomeDivider} />
        <div style={S.statHome}>
          <span style={S.statHomeNum}>{myTons > 0 ? myTons.toFixed(1) : "—"}</span>
          <span style={S.statHomeLabel}>Net Tons</span>
        </div>
      </div>

      <button style={S.captureBtn} onClick={() => fileRef.current.click()}>
        <span style={S.captureBtnIcon}>📷</span>
        <span>
          <div style={S.captureBtnTitle}>Capture Ticket</div>
          <div style={S.captureBtnSub}>This will be your {ordinal(myLoads.length + 1)} load</div>
        </span>
      </button>

      {myLoads.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>Today's Loads</div>
          <div style={S.ticketList}>
            {[...myLoads].reverse().map((t) => <TicketCard key={t.id} ticket={t} onClick={() => setSelectedTicket(t)} />)}
          </div>
        </div>
      )}
      {selectedTicket && <TicketModal ticket={selectedTicket} onClose={() => setSelectedTicket(null)} />}
    </div>
  );
}

// ── GPS COMPONENTS ────────────────────────────────────────────────────────
function GPSBanner({ status, gps }) {
  if (status === "idle") return null;
  const configs = {
    fetching: { color: C.textMuted, dot: C.textMuted, text: "Acquiring GPS…" },
    failed: { color: C.danger, dot: C.danger, text: "GPS unavailable" },
    ok: { color: C.green, dot: C.green, text: `GPS locked · ±${gps?.accuracy}m` },
  };
  const cfg = configs[status];
  return (
    <div style={{ ...S.statusCard, borderColor: cfg.dot + "50" }}>
      <span style={{ color: cfg.dot, fontSize: 10 }}>●</span>
      <span style={{ fontSize: 13, color: cfg.color }}>{cfg.text}</span>
    </div>
  );
}

function GPSCard({ gps, status }) {
  if (!gps) return null;
  const shortAddr = gps.address ? gps.address.split(",").slice(0, 3).join(", ") : `${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)}`;
  const mapsUrl = `https://maps.google.com/?q=${gps.latitude},${gps.longitude}`;
  return (
    <div style={{ ...S.statusCard, borderColor: C.green + "50", background: "rgba(34,197,94,0.05)", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
        <span>📍</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.text, flex: 1 }}>GPS Location</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.green, background: "rgba(34,197,94,0.15)", padding: "2px 8px", borderRadius: 20 }}>±{gps.accuracy}m</span>
      </div>
      <div style={{ fontSize: 13, color: C.textDim }}>{shortAddr}</div>
      <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>{gps.latitude.toFixed(6)}, {gps.longitude.toFixed(6)}</div>
      <a href={mapsUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.accent, textDecoration: "none", fontWeight: 600 }}>Open in Maps ↗</a>
    </div>
  );
}

// ── SHARED COMPONENTS ─────────────────────────────────────────────────────
function RosterRow({ driver, onRemove, onResetPin }) {
  const [editing, setEditing] = useState(false);
  const [newPin, setNewPin] = useState("");
  return (
    <div style={{ background: C.bg, borderRadius: 10, padding: "10px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 18 }}>👤</span>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: C.text }}>{driver.name}</span>
        <button style={{ fontSize: 12, color: C.accent, background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
          onClick={() => setEditing(!editing)}>
          {editing ? "Cancel" : "Reset PIN"}
        </button>
        <button style={{ fontSize: 12, color: C.danger, background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
          onClick={() => onRemove(driver.name)}>Remove</button>
      </div>
      {editing && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input style={{ ...S.fieldInput, flex: 1 }} placeholder="New 5-digit PIN" type="password"
            inputMode="numeric" maxLength={5} value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g,""))} />
          <button style={{ ...S.primaryBtn, width: "auto", padding: "9px 16px", fontSize: 13 }}
            onClick={() => { onResetPin(driver.name, newPin); setEditing(false); setNewPin(""); }}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function AdminPinChanger({ currentPin, onSave }) {
  const [editing, setEditing] = useState(false);
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");
  return (
    <div style={S.exportCard}>
      <div style={S.exportTitle}>🔐 Change Admin PIN</div>
      {!editing ? (
        <button style={{ ...S.ghostBtn, marginTop: 10 }} onClick={() => setEditing(true)}>Change Admin PIN</button>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          <input style={S.fieldInput} placeholder="New 5-digit PIN" type="password"
            inputMode="numeric" maxLength={5} value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g,""))} />
          <button style={S.primaryBtn} onClick={() => {
            if (pin.length !== 5) { setMsg("Must be 5 digits."); return; }
            onSave(pin); setEditing(false); setPin(""); setMsg("✓ Admin PIN updated.");
          }}>Save New PIN</button>
          <button style={S.ghostBtn} onClick={() => { setEditing(false); setPin(""); }}>Cancel</button>
          {msg && <div style={{ fontSize: 13, color: C.green, textAlign: "center" }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

function Header({ title, sub, onBack }) {
  return (
    <div style={S.header}>
      <button style={S.backBtn} onClick={onBack}>← Back</button>
      <div><div style={S.headerTitle}>{title}</div><div style={S.headerSub}>{sub}</div></div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={S.stat}>
      <div style={S.statVal}>{value}</div>
      <div style={S.statLabel}>{label}</div>
    </div>
  );
}

function TicketCard({ ticket, onClick, compact }) {
  return (
    <div style={{ ...S.ticketCard, borderColor: ticket.flagged ? C.danger + "50" : C.border }} onClick={onClick}>
      <div style={S.ticketThumbWrap}>
        <img src={ticket.image} alt="" style={S.ticketThumb} />
        <div style={S.loadBadgeSmall}>{ordinal(ticket.loadNumber)}</div>
        {ticket.flags?.some((f) => f.id === "dup") && <div style={{ ...S.blurBadge, bottom: -6, right: -6 }}>🔴</div>}
        {!ticket.flags?.some((f) => f.id === "dup") && ticket.flagged && <div style={S.blurBadge}>⚠️</div>}
      </div>
      <div style={S.ticketInfo}>
        {!compact && <div style={S.ticketDriver}>{ticket.driverName}</div>}
        <div style={S.ticketSupplier}>{ticket.data?.supplier || "Unknown Supplier"}</div>
        <div style={S.ticketLocation}>{ticket.data?.location || ticket.data?.customer || "—"}</div>
        <div style={S.ticketMeta}>
          {ticket.data?.truckNumber && <span>🚛 {ticket.data.truckNumber}</span>}
          {ticket.data?.netTons && <span style={{ color: C.accent }}>⚖ {ticket.data.netTons}t</span>}
          {ticket.data?.material && <span>📦 {ticket.data.material}</span>}
          {ticket.gps && <span style={{ color: C.green }}>📍</span>}
        </div>
        <div style={S.ticketTime}>{formatTime(ticket.timestamp)}</div>
      </div>
    </div>
  );
}

function TicketModal({ ticket, onClose }) {
  const gps = ticket.gps;
  const mapsUrl = gps ? `https://maps.google.com/?q=${gps.latitude},${gps.longitude}` : null;

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <div>
            <div style={S.modalTitle}>{ordinal(ticket.loadNumber)} Load</div>
            <div style={S.modalSub}>{ticket.driverName} · {formatDate(ticket.timestamp)} {formatTime(ticket.timestamp)}</div>
          </div>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>

        {ticket.flags?.length > 0 && (
          <div style={{ margin: "0 16px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
            {ticket.flags.map((f) => (
              <div key={f.id} style={{ padding: "8px 12px", background: f.color + "18", border: `1px solid ${f.color}50`, borderRadius: 10, fontSize: 13, color: f.color, fontWeight: 600 }}>
                {f.icon} {f.label}
              </div>
            ))}
          </div>
        )}

        <img src={ticket.image} alt="ticket" style={S.modalImg} />

        {/* Date comparison row */}
        <div style={{ margin: "8px 16px", display: "flex", gap: 8 }}>
          <div style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>Ticket Date</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{ticket.data?.date || "—"}</div>
          </div>
          <div style={{ flex: 1, background: C.surface, border: `1px solid ${ticket.flags?.some(f => f.id === "dateshift") ? "#f59e0b60" : C.border}`, borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>Captured On</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: ticket.flags?.some(f => f.id === "dateshift") ? "#f59e0b" : C.text }}>{formatDate(ticket.timestamp)}</div>
          </div>
        </div>
        {ticket.data?.netTons && (
          <div style={{ margin: "12px 16px", background: C.accentDim, border: `1px solid ${C.accent}40`, borderRadius: 12, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 600 }}>NET TONS</span>
            <span style={{ fontSize: 28, fontWeight: 800, color: C.accent, fontFamily: "monospace" }}>{ticket.data.netTons}</span>
          </div>
        )}

        {gps && (
          <div style={{ margin: "0 16px 8px", padding: "12px", background: "rgba(34,197,94,0.06)", border: `1px solid ${C.green}30`, borderRadius: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.green, marginBottom: 4 }}>📍 CAPTURED LOCATION ±{gps.accuracy}m</div>
            {gps.address && <div style={{ fontSize: 13, color: C.text, marginBottom: 4 }}>{gps.address.split(",").slice(0, 3).join(", ")}</div>}
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace", marginBottom: 4 }}>{gps.latitude.toFixed(6)}, {gps.longitude.toFixed(6)}</div>
            <a href={mapsUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.accent, textDecoration: "none", fontWeight: 600 }}>Open in Maps ↗</a>
          </div>
        )}

        <div style={S.modalFields}>
          {Object.entries(FIELD_LABELS).map(([key, label]) =>
            ticket.data?.[key] ? (
              <div key={key} style={S.modalField}>
                <span style={S.modalFieldLabel}>{label}</span>
                <span style={S.modalFieldVal}>{ticket.data[key]}</span>
              </div>
            ) : null
          )}
        </div>
      </div>
    </div>
  );
}

// ── STYLES ────────────────────────────────────────────────────────────────
const C = {
  bg: "#0f1117", surface: "#1a1d27", border: "#2a2f45",
  accent: "#f5a623", accentDim: "rgba(245,166,35,0.15)",
  text: "#e8eaf2", textMuted: "#6b7280", textDim: "#9ca3af",
  danger: "#ef4444", green: "#22c55e",
};

const S = {
  exportCard: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: "16px" },
  exportCardHeader: { display: "flex", alignItems: "flex-start", gap: 12 },
  exportIcon: { fontSize: 28, flexShrink: 0 },
  exportTitle: { fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4, display: "flex", alignItems: "center" },
  exportSub: { fontSize: 13, color: C.textMuted, lineHeight: 1.5 },
  exportNote: { fontSize: 11, color: C.textMuted, marginTop: 8, textAlign: "center" },
  loginError: { color: C.danger, fontSize: 13, textAlign: "center", marginBottom: 4 },
  loginGhost: { width: "100%", padding: "12px", borderRadius: 12, border: `1px solid ${C.border}`, background: "transparent", color: C.textMuted, fontWeight: 600, fontSize: 14, cursor: "pointer", marginTop: 4 },
  logoutBtn: { background: "rgba(239,68,68,0.12)", color: C.danger, border: `1px solid ${C.danger}30`, borderRadius: 8, padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  adminHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 20px 4px" },
  adminHeaderTitle: { fontSize: 20, fontWeight: 800, color: C.text },
  adminHeaderSub: { fontSize: 12, color: C.textMuted, marginTop: 2 },
  testBanner: { background: "#7c3aed", color: "#fff", fontSize: 12, fontWeight: 700, textAlign: "center", padding: "6px", letterSpacing: "0.03em" },
  loginWrap: { minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
  loginCard: { background: C.surface, borderRadius: 24, padding: "48px 36px", width: "100%", maxWidth: 360, textAlign: "center", border: `1px solid ${C.border}` },
  logoMark: { fontSize: 48, marginBottom: 12 },
  loginTitle: { fontFamily: "monospace", fontSize: 32, fontWeight: 700, color: C.accent, margin: "0 0 4px" },
  loginSub: { color: C.textMuted, fontSize: 13, marginBottom: 32, letterSpacing: "0.05em", textTransform: "uppercase" },
  loginInput: { width: "100%", padding: "14px 16px", borderRadius: 12, border: `1.5px solid ${C.border}`, background: C.bg, color: C.text, fontSize: 16, outline: "none", boxSizing: "border-box", marginBottom: 12 },
  loginBtn: { width: "100%", padding: "14px", borderRadius: 12, border: "none", background: C.accent, color: "#000", fontWeight: 700, fontSize: 16, cursor: "pointer" },
  wrap: { minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", paddingBottom: 48 },
  homeHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "24px 20px 16px" },
  homeGreeting: { fontSize: 22, fontWeight: 700, color: C.text },
  homeDate: { fontSize: 13, color: C.textMuted, marginTop: 2 },
  adminLink: { background: C.accentDim, color: C.accent, border: `1px solid ${C.accent}40`, borderRadius: 8, padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  statsHomeRow: { margin: "0 20px 20px", background: C.surface, borderRadius: 20, padding: "20px 24px", display: "flex", alignItems: "center", gap: 0, border: `1px solid ${C.border}` },
  statHome: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  statHomeNum: { fontSize: 44, fontWeight: 800, color: C.accent, lineHeight: 1, fontFamily: "monospace" },
  statHomeLabel: { fontSize: 13, color: C.textDim, fontWeight: 500 },
  statHomeDivider: { width: 1, height: 48, background: C.border },
  captureBtn: { margin: "0 20px 24px", width: "calc(100% - 40px)", background: "linear-gradient(135deg, #f5a623, #f07f00)", border: "none", borderRadius: 18, padding: "20px 24px", display: "flex", alignItems: "center", gap: 18, cursor: "pointer", boxSizing: "border-box" },
  captureBtnIcon: { fontSize: 36 },
  captureBtnTitle: { fontSize: 18, fontWeight: 700, color: "#000", textAlign: "left" },
  captureBtnSub: { fontSize: 13, color: "rgba(0,0,0,0.6)", textAlign: "left", marginTop: 2 },
  section: { padding: "0 20px" },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 },
  header: { display: "flex", alignItems: "center", gap: 16, padding: "16px 20px", borderBottom: `1px solid ${C.border}`, background: C.surface },
  backBtn: { background: "none", border: "none", color: C.accent, fontSize: 15, cursor: "pointer", padding: "4px 0", fontWeight: 600 },
  headerTitle: { fontSize: 16, fontWeight: 700, color: C.text },
  headerSub: { fontSize: 12, color: C.textMuted },
  captureBody: { padding: 20, display: "flex", flexDirection: "column", gap: 12 },
  reviewBody: { padding: 20, display: "flex", flexDirection: "column", gap: 12 },
  previewImg: { width: "100%", borderRadius: 16, border: `1px solid ${C.border}`, maxHeight: 300, objectFit: "contain", background: "#000", display: "block" },
  blurOverlay: { position: "absolute", inset: 0, background: "rgba(239,68,68,0.15)", borderRadius: 16, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" },
  blurIcon: { fontSize: 32 },
  blurOverlayText: { fontSize: 14, fontWeight: 700, color: C.danger, marginTop: 4 },
  statusCard: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 12, border: "1px solid", borderColor: C.border, background: C.surface },
  reviewImgRow: { display: "flex", gap: 12, alignItems: "flex-start" },
  thumbImg: { width: 100, height: 100, borderRadius: 12, objectFit: "cover", background: "#000", border: `1px solid ${C.border}`, flexShrink: 0 },
  reviewMeta: { flex: 1, display: "flex", flexDirection: "column", gap: 6 },
  supplierBadge: { fontSize: 13, fontWeight: 700, color: C.text, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "4px 10px", display: "inline-block" },
  ticketNumBig: { fontSize: 20, fontWeight: 800, color: C.accent, fontFamily: "monospace" },
  blurFlagSmall: { fontSize: 12, color: C.danger, fontWeight: 600 },
  tonnageHighlight: { background: C.accentDim, border: `1px solid ${C.accent}40`, borderRadius: 14, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" },
  tonnageNum: { fontSize: 32, fontWeight: 800, color: C.accent, fontFamily: "monospace" },
  tonnageLabel: { fontSize: 13, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" },
  fieldsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  fieldWrap: { display: "flex", flexDirection: "column", gap: 4 },
  fieldLabel: { fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" },
  fieldInput: { background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "9px 12px", color: C.text, fontSize: 14, outline: "none" },
  primaryBtn: { width: "100%", padding: "15px", borderRadius: 14, border: "none", background: C.accent, color: "#000", fontWeight: 700, fontSize: 16, cursor: "pointer" },
  ghostBtn: { width: "100%", padding: "13px", borderRadius: 14, border: `1.5px solid ${C.border}`, background: "transparent", color: C.textDim, fontWeight: 600, fontSize: 15, cursor: "pointer" },
  error: { background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 10, padding: "10px 14px", color: C.danger, fontSize: 14 },
  flagBanner: { background: "rgba(239,68,68,0.1)", border: `1px solid ${C.danger}30`, borderRadius: 12, padding: "10px 14px", color: C.danger, fontSize: 13, fontWeight: 600, marginBottom: 16 },
  flagBannerWrap: { background: "rgba(239,68,68,0.07)", border: `1px solid ${C.danger}30`, borderRadius: 12, padding: "12px 14px", marginBottom: 16 },
  flagBannerTitle: { fontSize: 13, fontWeight: 700, color: C.danger, marginBottom: 8 },
  flagBannerItems: { display: "flex", gap: 8, flexWrap: "wrap" },
  flagChip: (color) => ({ fontSize: 11, fontWeight: 700, color, background: color + "18", border: `1px solid ${color}40`, borderRadius: 20, padding: "3px 10px" }),
  dupWarning: { background: "rgba(239,68,68,0.08)", border: `1.5px solid ${C.danger}60`, borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 },
  dupWarningTitle: { fontSize: 14, fontWeight: 800, color: C.danger },
  dupWarningText: { fontSize: 13, color: C.textDim, lineHeight: 1.5 },
  sigWarning: { background: "rgba(245,158,11,0.08)", border: `1px solid #f59e0b50`, borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "flex-start", gap: 10 },
  ticketList: { display: "flex", flexDirection: "column", gap: 10 },
  ticketCard: { background: C.surface, borderRadius: 16, padding: 14, display: "flex", gap: 14, border: `1px solid`, cursor: "pointer" },
  ticketThumbWrap: { position: "relative", flexShrink: 0 },
  ticketThumb: { width: 72, height: 72, borderRadius: 10, objectFit: "cover", background: "#000" },
  loadBadgeSmall: { position: "absolute", top: -6, left: -6, background: C.accent, color: "#000", fontSize: 10, fontWeight: 800, borderRadius: 8, padding: "2px 6px", fontFamily: "monospace" },
  blurBadge: { position: "absolute", bottom: -6, right: -6, fontSize: 14 },
  ticketInfo: { flex: 1, minWidth: 0 },
  ticketDriver: { fontSize: 12, fontWeight: 700, color: C.accent, marginBottom: 2 },
  ticketSupplier: { fontSize: 12, color: C.textMuted, marginBottom: 2 },
  ticketLocation: { fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  ticketMeta: { display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12, color: C.textDim },
  ticketTime: { fontSize: 11, color: C.textMuted, marginTop: 4 },
  adminBody: { padding: 20 },
  statsRow: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 },
  stat: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: "14px 10px", textAlign: "center" },
  statVal: { fontSize: 24, fontWeight: 800, color: C.accent, fontFamily: "monospace" },
  statLabel: { fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 2 },
  segmented: { display: "flex", background: C.surface, borderRadius: 12, border: `1px solid ${C.border}`, padding: 4, marginBottom: 16 },
  seg: { flex: 1, padding: "8px", borderRadius: 9, border: "none", background: "transparent", color: C.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  segActive: { background: C.accentDim, color: C.accent },
  driverGroup: { marginBottom: 20 },
  driverGroupHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  driverGroupName: { fontSize: 15, fontWeight: 700, color: C.text },
  driverGroupCount: { fontSize: 12, color: C.textMuted, background: C.surface, padding: "3px 10px", borderRadius: 20, border: `1px solid ${C.border}` },
  empty: { color: C.textMuted, textAlign: "center", padding: "40px 0", fontSize: 15 },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center", padding: 16 },
  modal: { background: C.surface, borderRadius: 24, width: "100%", maxWidth: 480, maxHeight: "88vh", overflowY: "auto", border: `1px solid ${C.border}` },
  modalHeader: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "20px 20px 12px" },
  modalTitle: { fontSize: 20, fontWeight: 800, color: C.text },
  modalSub: { fontSize: 12, color: C.textMuted, marginTop: 2 },
  closeBtn: { background: "none", border: "none", color: C.textMuted, fontSize: 20, cursor: "pointer", padding: 4 },
  modalImg: { width: "100%", maxHeight: 220, objectFit: "contain", background: "#000" },
  modalFields: { padding: "8px 16px 20px", display: "flex", flexDirection: "column", gap: 0 },
  modalField: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` },
  modalFieldLabel: { fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" },
  modalFieldVal: { fontSize: 13, fontWeight: 600, color: C.text, textAlign: "right", maxWidth: "65%" },
};
