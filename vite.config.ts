// Single self-contained HTML file (dist-web/index.html) that works
// from file:// or any static host.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Inline the JS bundle and stylesheet into index.html. */
function singleFile(): Plugin {
  return {
    name: 'single-file',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const html = bundle['index.html']
      if (!html || html.type !== 'asset') return
      let source = String(html.source)
      const hashes: string[] = []
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === 'chunk' && file.isEntry) {
          const code = file.code.replace(/<\/script/gi, '<\\/script')
          hashes.push(`'sha256-${createHash('sha256').update(code).digest('base64')}'`)
          source = source.replace(
            new RegExp(`<script[^>]*src="[^"]*${name}"[^>]*></script>`),
            () => `<script type="module">${code}</script>`
          )
          delete bundle[name]
        } else if (file.type === 'asset' && name.endsWith('.css')) {
          source = source.replace(
            new RegExp(`<link[^>]*href="[^"]*${name}"[^>]*>`),
            () => `<style>${String(file.source)}</style>`
          )
          delete bundle[name]
        } else if (file.type === 'asset' && name.endsWith('.svg')) {
          const uri = `data:image/svg+xml,${encodeURIComponent(String(file.source))}`
          source = source.replace(new RegExp(`href="[^"]*${name}"`), () => `href="${uri}"`)
          delete bundle[name]
        }
      }
      // The inlined script is allowed by its hash: no other inline script runs.
      html.source = source.replace("script-src 'self'", () => `script-src 'self' ${hashes.join(' ')}`)
    }
  }
}

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  resolve: { alias: { '@': resolve('src/renderer/src') } },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), singleFile()],
  build: {
    outDir: resolve('dist-web'),
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    rolldownOptions: { output: { codeSplitting: false } }
  }
})
