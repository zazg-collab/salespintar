import sys, hashlib

PATH = "/opt/salespintar/backend/src/routes/video-guard.routes.ts"

with open(PATH, "r", encoding="utf-8") as f:
    src = f.read()

before_hash = hashlib.sha256(src.encode()).hexdigest()
print("BEFORE_HASH", before_hash)

# --- Patch 1: sisipkan fungsi fallback baru setelah downloadUrlAsBuffer ---
anchor1 = """  return { buffer, contentType: resp.headers.get('content-type') || 'application/octet-stream' };
}

// ══════════════════════════════════════════════════════════════════════════
// POST /video-guard/meta-rejected-creatives/:adId/audit"""

assert src.count(anchor1) == 1, f"anchor1 match count = {src.count(anchor1)}"

new_function = """  return { buffer, contentType: resp.headers.get('content-type') || 'application/octet-stream' };
}

/** Fallback kalau Graph API `?fields=source` ditolak Meta (error #10 "Application does not have
 *  permission for this action") -- ditemukan 2026-08-26 lewat investigasi Bossfren: video yang
 *  GAGAL diakses langsung via field `source` TERNYATA tetap bisa di-preview/play normal di ad
 *  preview kita sendiri (endpoint `/{adId}/previews`, jalur akses BEDA dari fetch video object
 *  langsung). HTML hasil iframe preview itu (business.facebook.com/ads/api/preview_iframe.php)
 *  memuat JSON inline berisi `videoURIHD`/`videoURISD` -- URL CDN fbcdn.net yang bisa langsung
 *  didownload TANPA butuh permission video-object yang diblokir. Best-effort murni: return null
 *  kalau langkah manapun gagal, caller tetap fallback ke text+thumbnail seperti sebelumnya. */
async function resolveVideoUrlViaPreview(adId: string, token: string): Promise<string | null> {
  try {
    const prevRes = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${adId}/previews?ad_format=MOBILE_FEED_STANDARD&access_token=${token}`);
    if (!prevRes.ok) return null;
    const prevData = (await prevRes.json()) as any;
    const body: string | undefined = prevData.data?.[0]?.body;
    if (!body) return null;
    const iframeMatch = body.match(/<iframe[^>]+src="([^"]+)"/i);
    if (!iframeMatch) return null;
    const iframeSrc = iframeMatch[1].replace(/&amp;/g, '&');
    const fullUrl = iframeSrc.startsWith('http') ? iframeSrc : `https://www.facebook.com${iframeSrc}`;
    const iframeResp = await fetch(fullUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) });
    if (!iframeResp.ok) return null;
    const html = await iframeResp.text();
    const hdMatch = html.match(/"videoURIHD":"([^"]+)"/);
    const sdMatch = html.match(/"videoURISD":"([^"]+)"/);
    const raw = hdMatch?.[1] || sdMatch?.[1];
    if (!raw) return null;
    return JSON.parse(`"${raw}"`); // unescape \\/ dan unicode escape dari JSON literal Facebook
  } catch (e) {
    logger.warn(`[VideoGuard] resolveVideoUrlViaPreview gagal utk ad ${adId}: ${(e as Error).message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// POST /video-guard/meta-rejected-creatives/:adId/audit"""

src = src.replace(anchor1, new_function, 1)

# --- Patch 2: pakai fallback di block download video ---
anchor2 = """    let videoBuffer: Buffer | null = null;
    let videoContentType = 'video/mp4';
    if (metaVideoId) {
      const srcResp = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${metaVideoId}?fields=source&access_token=${token}`);
      const srcData = (await srcResp.json()) as any;
      if (srcResp.ok && srcData.source) {
        const downloaded = await downloadUrlAsBuffer(srcData.source, MAX_META_VIDEO_DOWNLOAD_MS);
        if (downloaded) { videoBuffer = downloaded.buffer; videoContentType = downloaded.contentType; }
      } else {
        logger.warn(`[VideoGuard] video_id ${metaVideoId} (ad ${adId}) tidak bisa di-resolve source-nya: ${JSON.stringify(srcData).slice(0, 300)}`);
      }
    }"""

assert src.count(anchor2) == 1, f"anchor2 match count = {src.count(anchor2)}"

new_block = """    let videoBuffer: Buffer | null = null;
    let videoContentType = 'video/mp4';
    if (metaVideoId) {
      const srcResp = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${metaVideoId}?fields=source&access_token=${token}`);
      const srcData = (await srcResp.json()) as any;
      let resolvedVideoUrl: string | null = null;
      if (srcResp.ok && srcData.source) {
        resolvedVideoUrl = srcData.source;
      } else {
        logger.warn(`[VideoGuard] video_id ${metaVideoId} (ad ${adId}) tidak bisa di-resolve source-nya langsung: ${JSON.stringify(srcData).slice(0, 300)} -- coba fallback lewat ad preview iframe.`);
        resolvedVideoUrl = await resolveVideoUrlViaPreview(adId, token);
        if (resolvedVideoUrl) {
          logger.info(`[VideoGuard] Fallback preview-iframe BERHASIL dapat video URL utk ad ${adId} (video_id ${metaVideoId}) -- Graph API ?fields=source ditolak (error #10) tapi ad-preview iframe tetap bisa diakses.`);
        } else {
          logger.warn(`[VideoGuard] Fallback preview-iframe JUGA gagal dapat video URL utk ad ${adId} (video_id ${metaVideoId}).`);
        }
      }
      if (resolvedVideoUrl) {
        const downloaded = await downloadUrlAsBuffer(resolvedVideoUrl, MAX_META_VIDEO_DOWNLOAD_MS);
        if (downloaded) { videoBuffer = downloaded.buffer; videoContentType = downloaded.contentType; }
      }
    }"""

src = src.replace(anchor2, new_block, 1)

with open("/tmp/video-guard.routes.ts.patched", "w", encoding="utf-8") as f:
    f.write(src)

after_hash = hashlib.sha256(src.encode()).hexdigest()
print("AFTER_HASH", after_hash)
print("LINES", src.count("\n") + 1)
