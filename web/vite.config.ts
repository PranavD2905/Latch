import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Slice 6: the viewer talks to the audit-trail SSE server
// (src/adapters/audit-trail/) at :4002. Proxying /events here means the
// browser sees one origin, so EventSource needs no CORS handling at all —
// docs/02-tech-stack.md §10/§11.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/events': {
        target: 'http://localhost:4002',
        changeOrigin: true,
      },
    },
  },
})
