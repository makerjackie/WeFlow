const LATEST_DOWNLOAD = '/download/WeFlow-5.0.3-Setup.dmg'

const RELEASES = new Map([
  [LATEST_DOWNLOAD, {
    key: 'releases/5.0.3/WeFlow-5.0.3-Setup.dmg',
    filename: 'WeFlow-5.0.3-Setup.dmg',
    sha256: '7aae65235b0ae96c5f110882368d1fb9c5510e30557c722cdd7a32324ce0ddc4'
  }],
  ['/download/WeFlow-5.0.2-Setup.dmg', {
    key: 'releases/5.0.2/WeFlow-5.0.2-Setup.dmg',
    filename: 'WeFlow-5.0.2-Setup.dmg',
    sha256: 'fd898ca15d1dc23fe02b751662f1dc9fddbde9e2bfac3e0173d21c92175c9bf3'
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
