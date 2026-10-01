// Allowlisted domains — only proxy images from known trusted sources
const ALLOWED_HOSTS = [
  'cdn.higgsfield.ai',
  'media.higgsfield.ai',
  'storage.higgsfield.ai',
  'files.higgsfield.ai',
  'oaidalleapiprodscus.blob.core.windows.net',
  'oaidallexprodscus.blob.core.windows.net',
]

function isSafeUrl(raw) {
  try {
    const u = new URL(decodeURIComponent(raw))
    if (u.protocol !== 'https:') return false
    return ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))
  } catch { return false }
}

function safeFilename(name) {
  return (name || 'image.jpg')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 128)
}

import { rateLimit, clientIp } from '../lib/rateLimit.js'
import sharp from 'sharp'

// TikTok's Content Posting API rejects an image whose pixel count (width *
// height) exceeds this, regardless of aspect ratio — confirmed live via
// Buffer's createPost: "Image pixel count (4,276,224) exceeds the 2,073,600
// maximum for TikTok" for a 1856x2304 (4:5, 2k) Higgsfield render. The daily
// pipeline reuses its Instagram feed image for the TikTok draft, so that
// image needs downscaling just for the TikTok channel — done here, on the
// fly, rather than generating a second Higgsfield render (saves a credit)
// or standing up separate image storage (there is none in this project;
// Buffer's API only accepts a fetchable URL, never raw bytes).
const TIKTOK_MAX_PIXELS = 2_073_600

async function fitUnderPixelCap(buf, maxPixels) {
  const img = sharp(buf)
  const { width, height } = await img.metadata()
  if (!width || !height || width * height <= maxPixels) return null
  const scale = Math.sqrt(maxPixels / (width * height))
  return img
    .resize(Math.floor(width * scale), Math.floor(height * scale))
    .jpeg({ quality: 90 })
    .toBuffer()
}

export default async function handler(req, res) {
  const rl = rateLimit(clientIp(req.headers))
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    res.status(429).send('Too many requests — slow down a moment and try again.'); return
  }

  const { url, name, fit } = req.query
  if (!url) { res.status(400).send('Missing url'); return }
  if (!isSafeUrl(url)) { res.status(403).send('URL not allowed'); return }

  try {
    const upstream = await fetch(decodeURIComponent(url))
    if (!upstream.ok) { res.status(upstream.status).send('Upstream error'); return }

    let ct = upstream.headers.get('content-type') || 'image/jpeg'
    if (!ct.startsWith('image/') && !ct.startsWith('video/')) {
      res.status(400).send('Not an image or video'); return
    }

    let buf = Buffer.from(await upstream.arrayBuffer())
    if (fit === 'tiktok' && ct.startsWith('image/')) {
      try {
        const resized = await fitUnderPixelCap(buf, TIKTOK_MAX_PIXELS)
        if (resized) { buf = resized; ct = 'image/jpeg' }
      } catch (e) {
        console.error('Warning: TikTok resize failed, serving original:', e.message)
      }
    }

    res.setHeader('Content-Type', ct)
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(name)}"`)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.end(buf)
  } catch (e) {
    res.status(500).send('Proxy error')
  }
}
