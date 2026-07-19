const LATEST_DOWNLOAD = '/download/WeFlow-5.0.6-Setup.dmg'

const RELEASES = new Map([
  [LATEST_DOWNLOAD, {
    key: 'releases/5.0.6/WeFlow-5.0.6-Setup.dmg',
    filename: 'WeFlow-5.0.6-Setup.dmg',
    sha256: '7b5b0f26f8b89433ae922b7b2b86358acf3c223b5d1859bf75b9810b62b21dd3'
  }],
  ['/download/WeFlow-5.0.5-Setup.dmg', {
    key: 'releases/5.0.5/WeFlow-5.0.5-Setup.dmg',
    filename: 'WeFlow-5.0.5-Setup.dmg',
    sha256: 'be4a4709e3a35484007f019b40ba5b99bb62111f1cd8e312228998c4014af662'
  }],
  ['/download/WeFlow-5.0.4-Setup.dmg', {
    key: 'releases/5.0.4/WeFlow-5.0.4-Setup.dmg',
    filename: 'WeFlow-5.0.4-Setup.dmg',
    sha256: '2e60dfc1e20689310d04698b363fc550160411bfc6927af817ea0bedc412abf7'
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
