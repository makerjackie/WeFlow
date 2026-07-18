const LATEST_DOWNLOAD = '/download/WeFlow-5.0.1-Setup.dmg'

const RELEASES = new Map([
  [LATEST_DOWNLOAD, {
    key: 'releases/5.0.1/WeFlow-5.0.1-Setup.dmg',
    filename: 'WeFlow-5.0.1-Setup.dmg',
    sha256: 'dacb3263316a268a463d94992bf6d2b0528a11032357f53cf261cf457c74957a'
  }]
])

function releaseHeaders(object, release) {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('content-type', 'application/x-apple-diskimage')
  headers.set('content-disposition', `attachment; filename="${release.filename}"`)
  headers.set('content-length', String(object.size))
  headers.set('etag', object.httpEtag)
  headers.set('cache-control', 'public, max-age=86400')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('x-weflow-sha256', release.sha256)
  return headers
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/download/latest') {
      return Response.redirect(new URL(LATEST_DOWNLOAD, url.origin), 302)
    }

    const release = RELEASES.get(url.pathname)
    if (!release) {
      return new Response('Not found', { status: 404 })
    }

    if (request.method === 'HEAD') {
      const object = await env.DOWNLOADS.head(release.key)
      if (!object) return new Response('Not found', { status: 404 })
      return new Response(null, { headers: releaseHeaders(object, release) })
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD' }
      })
    }

    const object = await env.DOWNLOADS.get(release.key)
    if (!object) return new Response('Not found', { status: 404 })

    return new Response(object.body, {
      headers: releaseHeaders(object, release)
    })
  }
}
