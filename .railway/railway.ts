import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

// Slice 7 topology (docs/07-deployment.md): three small services sharing one
// managed Postgres, rather than one combined process. Secrets (Razorpay
// keys, the merchant/audit tokens) are declared with preserve() — their
// real values are set out-of-band via `railway variable set`, never written
// here, per this file's own README on how imported secrets are handled.

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "ams" });
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "ams",
    sizeMB: 500,
  });

  const source = github("PranavD2905/Latch", { branch: "main" });

  const sharedEnv = {
    DATABASE_URL: Postgres.env.DATABASE_URL,
    PAYMENT_PROVIDER: "razorpay",
    RAZORPAY_KEY_ID: preserve(),
    RAZORPAY_KEY_SECRET: preserve(),
  };

  const mcp = service("latch-mcp", {
    source,
    build: "npm run build",
    start: "npm run start:mcp",
    healthcheck: "/healthz",
    env: {
      ...sharedEnv,
      // Payment-link feature (dev-logs/029/030): the public origin
      // confirm_with_deposit builds its pay links against — latch-viewer's
      // own URL, since that service serves GET /pay/:bookingId. Declared
      // here rather than only set via `railway variable set`, because
      // `railway config plan` treats anything absent from this file as
      // drift to destroy: with it missing, the next `railway config apply`
      // would delete it, and confirm_with_deposit would silently start
      // handing out http://localhost:4002 links that nobody can open. Not a
      // secret, so it is a literal here rather than preserve().
      PAY_PAGE_BASE_URL: "https://latch-viewer-production.up.railway.app",
    },
  });

  const merchantApi = service("latch-merchant-api", {
    source,
    build: "npm run build",
    start: "npm run start:merchant-api",
    healthcheck: "/healthz",
    env: {
      ...sharedEnv,
      // Migration 0011: no MERCHANT_API_TOKEN env var anymore — merchant
      // credentials are per-merchant and DB-issued. Run
      // `railway run --service latch-merchant-api npm run db:seed` (or
      // db:create-merchant) once after the first deploy to mint one.
      // dev-logs/014, item 2: the secret Razorpay signs POST /webhooks/razorpay
      // deliveries with — registered against this exact service's public URL
      // via the Webhooks API (see dev-logs/014 for how), not the Dashboard.
      RAZORPAY_WEBHOOK_SECRET: preserve(),
    },
  });

  const viewer = service("latch-viewer", {
    source,
    build: "npm run build:viewer",
    start: "npm run start:viewer",
    healthcheck: "/healthz",
    env: {
      ...sharedEnv,
      // Migration 0011: no AUDIT_TRAIL_TOKEN env var anymore either — the
      // viewer's SSE feed is authenticated per-merchant now. VITE_AUDIT_TRAIL_TOKEN
      // (below) is the one place a merchant's audit-trail token still needs
      // to be set, since Vite bakes it into the static bundle at build time.
      VITE_AUDIT_TRAIL_TOKEN: preserve(),
    },
  });

  return project("latch", {
    resources: [Postgres, postgresVolume, mcp, merchantApi, viewer],
  });
});
