const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const dir = path.join(process.cwd(), "artifacts");

const pageMeta = {
  root: {
    title: "Dashboard",
    apis: ["(missing) dashboard summary metrics endpoint"]
  },
  media: {
    title: "Media",
    apis: ["GET /v1/media", "POST /v1/media", "POST /v1/media/presign-upload"]
  },
  screens: {
    title: "Screens",
    apis: ["GET /v1/screens", "POST /v1/screens", "PATCH /v1/screens/:id", "DELETE /v1/screens/:id"]
  },
  schedule: {
    title: "Schedules",
    apis: [
      "GET /v1/schedules",
      "POST /v1/schedules",
      "PATCH /v1/schedules/:id",
      "POST /v1/schedules/:id/publish (stubbed in backend)"
    ]
  },
  requests: {
    title: "Requests",
    apis: [
      "GET /v1/requests",
      "POST /v1/requests",
      "PATCH /v1/requests/:id",
      "GET /v1/requests/:id/messages",
      "POST /v1/requests/:id/messages"
    ]
  },
  departments: {
    title: "Departments",
    apis: ["GET /v1/departments", "POST /v1/departments", "PATCH /v1/departments/:id", "DELETE /v1/departments/:id"]
  },
  operators: {
    title: "Operators (Users w/ role OPERATOR)",
    apis: [
      "GET /v1/users?role=OPERATOR",
      "POST /v1/users",
      "PATCH /v1/users/:id",
      "DELETE /v1/users/:id"
    ]
  },
  "proof-of-play": {
    title: "Proof of Play",
    apis: ["(missing) reporting endpoints; backend only ingests via POST /v1/device/proof-of-play"]
  },
  reports: {
    title: "Reports",
    apis: ["(missing) analytics/reporting endpoints"]
  },
  "api-keys": {
    title: "API Keys",
    apis: ["(missing) API key CRUD endpoints"]
  },
  webhooks: {
    title: "Webhooks",
    apis: ["(missing) webhook CRUD + test-fire endpoints"]
  },
  "sso-config": {
    title: "SSO Config",
    apis: ["(missing) SSO settings endpoints"]
  },
  settings: {
    title: "Settings",
    apis: ["(missing) org/settings endpoints (branding, timezone, etc.)"]
  },
  conversations: {
    title: "Conversations",
    apis: ["(missing) messaging/thread endpoints"]
  }
};

const files = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith("dashboard-") && f.endsWith(".png"))
  .sort();

if (files.length === 0) {
  console.error("No dashboard screenshots found under", dir);
  process.exit(1);
}

const doc = new PDFDocument({ autoFirstPage: false });
const outputPath = path.join(dir, "dashboard-preview.pdf");
const stream = fs.createWriteStream(outputPath);
doc.pipe(stream);

for (const file of files) {
  const full = path.join(dir, file);
  const key = file.replace("dashboard-", "").replace(".png", "");
  const meta = pageMeta[key] || { title: key, apis: [] };
  doc.addPage({ size: "A4", margin: 30 });
  doc.fontSize(16).text(meta.title, { align: "left" });
  doc.moveDown(0.3);
  if (meta.apis.length) {
    doc.fontSize(10).text("APIs:", { continued: false });
    meta.apis.forEach((a) => doc.fontSize(10).text("- " + a));
  } else {
    doc.fontSize(10).text("APIs: (not mapped)");
  }
  doc.moveDown(0.5);
  doc.image(full, {
    fit: [
      doc.page.width - doc.page.margins.left - doc.page.margins.right,
      doc.page.height - doc.page.margins.top - doc.page.margins.bottom - 70
    ],
    align: "center",
    valign: "top"
  });
}

doc.end();
stream.on("finish", () => console.log("PDF written to", outputPath));
