const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const Redis   = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const AT_API   = 'https://api.animethemes.moe';
const AT_AUDIO = AT_API + '/audio'; // e.g. /audio/AttackOnTitan-OP1.ogg

// ─── Redis Cache (optional) ───────────────────────────────────────────────────
let redis = null;
const CACHE_TTL = 3600;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', () => console.log('[Redis] connected'));
  redis.on('error',   e  => console.error('[Redis]', e.message));
}

async function cacheGet(key) {
  if (!redis) return null;
  try {
    const val = await redis.get('at:' + key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

async function cacheSet(key, data) {
  if (!redis) return;
  try { await redis.setex('at:' + key, CACHE_TTL, JSON.stringify(data)); } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getAnimeImage(anime) {
  if (!anime || !anime.images || !anime.images.length) return undefined;
  const preferred = anime.images.find(img =>
    img.facet === 'Large Cover' || img.facet === 'Small Cover' || img.facet === 'Poster'
  );
  return (preferred || anime.images[0]).link || undefined;
}

function getArtistImage(artist) {
  if (!artist || !artist.images || !artist.images.length) return undefined;
  return artist.images[0].link || undefined;
}

// "OP", "OP 2", "ED", "ED 3" — mirrors AnimeThemes own labeling
function themeLabel(theme) {
  const type = theme.type || 'OP';
  const seq  = theme.sequence; // null = first/only, 2+ = numbered
  return seq ? `${type} ${seq}` : type;
}

// Prefer non-NSFW, non-spoiler entries; return first available video
function getBestVideo(theme) {
  const entries = theme.animethemeentries || [];
  for (const e of entries) {
    if (!e.nsfw && !e.spoiler && e.videos && e.videos.length) return e.videos[0];
  }
  for (const e of entries) {
    if (e.videos && e.videos.length) return e.videos[0];
  }
  return null;
}

// Strip .webm → basename used as track ID and in audio URL
function basename(filename) {
  return filename ? filename.replace(/\.[^.]+$/, '') : null;
}

function buildAudioUrl(filename) {
  const base = basename(filename);
  return base ? `${AT_AUDIO}/${base}.ogg` : null;
}

function themeToTrack(theme, anime) {
  const video = getBestVideo(theme);
  if (!video || !video.filename) return null;

  const song      = theme.song || {};
  const songTitle = song.title || null;
  const label     = themeLabel(theme);
  const title     = songTitle ? `${songTitle} (${label})` : label;
  const artists   = (song.artists || []).map(a => a.name).filter(Boolean).join(', ') || 'Unknown';
  const animeName = anime ? (anime.name || '') : undefined;

  return {
    id:        basename(video.filename),   // e.g. "AttackOnTitan-OP1"
    title,
    artist:    artists,
    album:     animeName || undefined,
    artworkURL: getAnimeImage(anime),
    streamURL: buildAudioUrl(video.filename), // permanent — Eclipse won't call /stream
    format:    'ogg'
  };
}

// ─── Query string builder (preserves bracket syntax for JSON:API) ─────────────
function buildQS(params) {
  if (!params) return '';
  return '?' + Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      // Keys: preserve brackets for JSON:API (fields[], include[], page[])
      const key = encodeURIComponent(k)
        .replace(/%5B/gi, '[')
        .replace(/%5D/gi, ']');
      // Values: preserve commas (list separators) and dots (relationship paths)
      const val = encodeURIComponent(String(v))
        .replace(/%2C/gi, ',')
        .replace(/%2E/gi, '.');
      return key + '=' + val;
    })
    .join('&');
}

// ─── AnimeThemes API client ───────────────────────────────────────────────────
async function atGet(path, params) {
  const url = AT_API + path + buildQS(params);
  console.log('[atGet]', url); // helpful for debugging
  const r = await axios.get(url, {
    headers: { 'User-Agent': 'EclipseAnimeThemes/1.0.0', Accept: 'application/json' },
    timeout: 10000 // tight timeout — Vercel Hobby cap is 10s
  });
  return r.data;
}

// ─── Landing page ─────────────────────────────────────────────────────────────
function buildLandingPage(baseUrl) {
  const addonUrl = baseUrl + '/manifest.json';
  var h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>Anime Themes — Eclipse Music Addon</title>';
  h += '<style>*{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#080808;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.card{background:#111;border:1px solid #1e1e1e;border-radius:18px;padding:36px;max-width:520px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}';
  h += 'h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}';
  h += 'h2{font-size:15px;font-weight:700;margin-bottom:14px;color:#fff}';
  h += 'p.sub{font-size:14px;color:#666;margin-bottom:20px;line-height:1.6}';
  h += '.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}';
  h += '.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#181818;color:#aaa;border:1px solid #2a2a2a}';
  h += '.pill.hi{background:#1a0d20;color:#c084fc;border-color:#3b1f50}';
  h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#444;margin-bottom:8px;margin-top:16px}';
  h += '.url-box{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:14px;font-family:"SF Mono","Fira Code",monospace;font-size:13px;color:#c084fc;word-break:break-all;margin-bottom:10px;line-height:1.5}';
  h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:14px;font-weight:700;padding:12px;width:100%;margin-bottom:8px;transition:background .15s}';
  h += '.bw{background:#fff;color:#000}.bw:hover{background:#e0e0e0}';
  h += 'hr{border:none;border-top:1px solid #161616;margin:24px 0}';
  h += '.steps{display:flex;flex-direction:column;gap:12px}';
  h += '.step{display:flex;gap:12px;align-items:flex-start}';
  h += '.sn{background:#1a0d20;border:1px solid #3b1f50;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#c084fc}';
  h += '.st{font-size:13px;color:#555;line-height:1.6;padding-top:3px}.st b{color:#999}';
  h += '.features{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:4px}';
  h += '.feat{background:#0a0a0a;border:1px solid #1a1a1a;border-radius:10px;padding:12px;font-size:12px;color:#666;line-height:1.5}';
  h += '.feat b{color:#c084fc;display:block;margin-bottom:2px;font-size:13px}';
  h += 'footer{margin-top:32px;font-size:12px;color:#2a2a2a;text-align:center;line-height:1.8}';
  h += '</style></head><body>';

  // Icon — anime waveform-style SVG
  h += '<svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="margin-bottom:22px">';
  h += '<circle cx="26" cy="26" r="26" fill="#c084fc"/>';
  h += '<rect x="10" y="22" width="4" height="8"  rx="2" fill="#fff"/>';
  h += '<rect x="17" y="16" width="4" height="20" rx="2" fill="#fff"/>';
  h += '<rect x="24" y="20" width="4" height="12" rx="2" fill="#fff"/>';
  h += '<rect x="31" y="13" width="4" height="26" rx="2" fill="#fff"/>';
  h += '<rect x="38" y="18" width="4" height="16" rx="2" fill="#fff"/>';
  h += '</svg>';

  h += '<div class="card"><h1>Anime Themes for Eclipse</h1>';
  h += '<p class="sub">Stream anime opening &amp; ending themes directly in Eclipse Music. Powered by <b>AnimeThemes.moe</b> — 15,000+ themes from classic to current season.</p>';
  h += '<div class="pills">';
  h += '<span class="pill">OPs &middot; EDs</span>';
  h += '<span class="pill hi">Free &bull; No Account</span>';
  h += '<span class="pill">Search by Anime Title</span>';
  h += '</div>';

  h += '<div class="lbl">Addon URL &mdash; paste into Eclipse</div>';
  h += '<div class="url-box" id="addonUrl">' + addonUrl + '</div>';
  h += '<button class="bw" onclick="copyUrl()">Copy Addon URL</button>';

  h += '<hr><div class="steps">';
  h += '<div class="step"><div class="sn">1</div><div class="st">Copy the URL above</div></div>';
  h += '<div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> &rarr; Settings &rarr; Connections &rarr; Add Connection &rarr; Addon</div></div>';
  h += '<div class="step"><div class="sn">3</div><div class="st">Paste the URL and tap <b>Install</b></div></div>';
  h += '<div class="step"><div class="sn">4</div><div class="st">Search any anime — <b>Attack on Titan</b>, <b>Gurren Lagann</b>, etc. — and browse its themes</div></div>';
  h += '</div></div>';

  h += '<div class="card"><h2>What You Get</h2>';
  h += '<div class="features">';
  h += '<div class="feat"><b>Tracks</b>Individual OP &amp; ED themes per search result</div>';
  h += '<div class="feat"><b>Albums</b>Tap any anime to see all its themes in one place</div>';
  h += '<div class="feat"><b>Artists</b>Browse themes by the artist who performed them</div>';
  h += '<div class="feat"><b>Offline</b>Permanent URLs — save themes to your library &amp; download</div>';
  h += '</div></div>';

  h += '<footer>Anime Themes Eclipse Addon v1.0.0 &bull; AnimeThemes.moe</footer>';
  h += '<script>function copyUrl(){var u=document.getElementById("addonUrl").textContent;navigator.clipboard.writeText(u).then(function(){var b=document.querySelector("button");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy Addon URL";},1600);});}</script>';
  h += '</body></html>';
  return h;
}

function getBaseUrl(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildLandingPage(getBaseUrl(req)));
});

// ─── Manifest ─────────────────────────────────────────────────────────────────
app.get('/manifest.json', (req, res) => {
  res.json({
    id:          'com.eclipse.animethemes',
    name:        'Anime Themes',
    version:     '1.0.0',
    description: 'Anime opening & ending themes via AnimeThemes.moe. 15,000+ OPs and EDs — search any anime.',
    icon:        'https://animethemes.moe/favicon.ico',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist']
  });
});

// ─── Search ───────────────────────────────────────────────────────────────────
// Returns tracks (individual themes), albums (anime series), artists (performers)
app.get('/search', async (req, res) => {
  const q = String(req.query.q || req.query.query || '').trim();
  if (!q) return res.json({ tracks: [], albums: [], artists: [] });

  const cacheKey = 'search:' + q.toLowerCase();
  const cached   = await cacheGet(cacheKey);
  if (cached) { console.log('[search] cache hit:', q); return res.json(cached); }

  console.log('[search] q:', JSON.stringify(q));

  try {
    const data = await atGet('/search', {
      q,
      'fields[search]':  'anime,songs,artists',
      'include[anime]':  'animethemes.animethemeentries.videos,animethemes.song.artists,images',
      'include[song]':   'animethemes.anime.images,animethemes.animethemeentries.videos,artists',
      'include[artist]': 'images',
      'page[limit]':     5   // 5 of each type
    });

    const search  = data.search  || {};
    const animes  = search.anime   || [];
    const songs   = search.songs   || [];
    const artists = search.artists || [];

    const tracks   = [];
    const albums   = [];
    const trackIds = new Set();

    // ── Anime results → albums + tracks ──────────────────────────────────────
    for (const anime of animes) {
      const themes = anime.animethemes || [];

      for (const theme of themes) {
        const track = themeToTrack(theme, anime);
        if (track && !trackIds.has(track.id)) {
          trackIds.add(track.id);
          tracks.push(track);
        }
      }

      if (anime.slug) {
        albums.push({
          id:         'anime_' + anime.slug,
          title:      anime.name || anime.slug,
          artist:     'Various Artists',
          artworkURL: getAnimeImage(anime),
          trackCount: themes.length || undefined,
          year:       anime.year ? String(anime.year) : undefined
        });
      }
    }

    // ── Song results → extra tracks not already from anime results ────────────
    for (const song of songs) {
      for (const theme of (song.animethemes || [])) {
        const track = themeToTrack(theme, theme.anime);
        if (track && !trackIds.has(track.id)) {
          trackIds.add(track.id);
          tracks.push(track);
        }
      }
    }

    // ── Artist results ────────────────────────────────────────────────────────
    const artistList = artists.slice(0, 5).map(a => ({
      id:         'artist_' + (a.slug || String(a.id)),
      name:       a.name || 'Unknown',
      artworkURL: getArtistImage(a)
    }));

    console.log('[search] tracks:', tracks.length, 'albums:', albums.length, 'artists:', artistList.length);

    const result = {
      tracks:  tracks.slice(0, 20),
      albums:  albums.slice(0, 8),
      artists: artistList
    };

    await cacheSet(cacheKey, result);
    res.json(result);

  } catch (e) {
    console.error('[search] ERROR:', e.message);
    res.status(502).json({ error: 'Search failed: ' + e.message, tracks: [], albums: [], artists: [] });
  }
});

// ─── Stream ───────────────────────────────────────────────────────────────────
// Fallback only — streamURL is included directly in track objects so Eclipse
// should never need to call this unless the track was saved without streamURL.
app.get('/stream/:id', (req, res) => {
  const id  = req.params.id; // basename, e.g. "AttackOnTitan-OP1"
  const url = `${AT_AUDIO}/${id}.ogg`;
  console.log('[stream]', id, '→', url);
  res.json({ url, format: 'ogg', quality: 'lossy' });
});

// ─── Album = Anime detail (all themes) ───────────────────────────────────────
app.get('/album/:id', async (req, res) => {
  const rawId    = req.params.id;
  const slug     = rawId.startsWith('anime_') ? rawId.slice(6) : rawId;
  const cacheKey = 'album:' + slug;
  const cached   = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  console.log('[album] slug:', slug);

  try {
    const data  = await atGet('/anime/' + encodeURIComponent(slug), {
      include: 'animethemes.animethemeentries.videos,animethemes.song.artists,images'
    });
    const anime = data.anime;
    if (!anime) return res.status(404).json({ error: 'Anime not found' });

    // Sort themes: OPs first, then EDs, then by sequence
    const sortedThemes = (anime.animethemes || []).sort((a, b) => {
      const typeOrder = { OP: 0, ED: 1 };
      const ta = typeOrder[a.type] ?? 2, tb = typeOrder[b.type] ?? 2;
      if (ta !== tb) return ta - tb;
      return (a.sequence || 1) - (b.sequence || 1);
    });

    const tracks = sortedThemes.map(t => themeToTrack(t, anime)).filter(Boolean);

    const result = {
      id:         rawId,
      title:      anime.name || slug,
      artist:     'Various Artists',
      artworkURL: getAnimeImage(anime),
      year:       anime.year ? String(anime.year) : undefined,
      trackCount: tracks.length,
      tracks
    };

    await cacheSet(cacheKey, result);
    res.json(result);

  } catch (e) {
    console.error('[album] ERROR:', e.message);
    res.status(502).json({ error: 'Anime fetch failed: ' + e.message });
  }
});

// ─── Artist detail ────────────────────────────────────────────────────────────
app.get('/artist/:id', async (req, res) => {
  const rawId    = req.params.id;
  const slug     = rawId.startsWith('artist_') ? rawId.slice(7) : rawId;
  const cacheKey = 'artist:' + slug;
  const cached   = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  console.log('[artist] slug:', slug);

  try {
    const data   = await atGet('/artist/' + encodeURIComponent(slug), {
      include: 'songs.animethemes.animethemeentries.videos,songs.animethemes.anime.images,images'
    });
    const artist = data.artist;
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    const topTracks = [];
    const albumMap  = {};
    const trackIds  = new Set();

    for (const song of (artist.songs || [])) {
      for (const theme of (song.animethemes || [])) {
        const anime = theme.anime;
        const track = themeToTrack(theme, anime);
        if (track && !trackIds.has(track.id)) {
          trackIds.add(track.id);
          topTracks.push(track);
        }
        if (anime && anime.slug && !albumMap[anime.slug]) {
          albumMap[anime.slug] = {
            id:         'anime_' + anime.slug,
            title:      anime.name || anime.slug,
            artist:     artist.name || 'Unknown',
            artworkURL: getAnimeImage(anime),
            year:       anime.year ? String(anime.year) : undefined
          };
        }
      }
    }

    const result = {
      id:        rawId,
      name:      artist.name || slug,
      artworkURL: getArtistImage(artist),
      topTracks:  topTracks.slice(0, 10),
      albums:     Object.values(albumMap).slice(0, 10)
    };

    await cacheSet(cacheKey, result);
    res.json(result);

  } catch (e) {
    console.error('[artist] ERROR:', e.message);
    res.status(502).json({ error: 'Artist fetch failed: ' + e.message });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    version:   '1.0.0',
    source:    'AnimeThemes.moe',
    redis:     !!(redis && redis.status === 'ready'),
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => console.log(`[AnimeThemes] addon running on port ${PORT}`));
