import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Slice 6: the viewer talks to the audit-trail SSE server
// (src/adapters/audit-trail/) at :4002. Proxying /events here means the
// browser sees one origin, so EventSource needs no CORS handling at all —
// docs/02-tech-stack.md §10/§11.
//
// dev-logs/015: the policy editor talks to the *merchant* API
// (src/adapters/merchant-api/) at :4001 — a genuinely different service, not
// just a different local port, since production deploys it as its own
// Railway service (docs/07-deployment.md). Proxying /policy here mirrors
// /events for local dev; in production `VITE_MERCHANT_API_URL` points at the
// deployed merchant API directly, and that server now runs `@fastify/cors`
// to allow the cross-origin call (`web/src/policyApi.ts`).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/events': {
        target: 'http://localhost:4002',
        changeOrigin: true,
      },
      '/policy': {
        target: 'http://localhost:4001',
        changeOrigin: true,
      },
    },
  },
})
