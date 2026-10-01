const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'userData.json');

function getUserDatabase() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveUserDatabase(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// User Sync API
app.get('/api/user/sync', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: "Email required" });

  const db = getUserDatabase();
  const userData = db[email] || { history: [], likedSongs: [], playlists: {} };
  res.json(userData);
});

// Playlist & Track Save API
app.post('/api/user/save-track', (req, res) => {
  const { email, track, action, playlistName } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const db = getUserDatabase();
  if (!db[email]) {
    db[email] = { history: [], likedSongs: [], playlists: {} };
  }
  if (!db[email].playlists) db[email].playlists = {};

  if (action === 'history' && track) {
    db[email].history = db[email].history.filter(t => t.id !== track.id);
    db[email].history.unshift(track);
    if (db[email].history.length > 50) db[email].history.pop();
  } else if (action === 'like' && track) {
    const exists = db[email].likedSongs.some(t => t.id === track.id);
    if (!exists) {
      db[email].likedSongs.unshift(track);
    } else {
      db[email].likedSongs = db[email].likedSongs.filter(t => t.id !== track.id);
    }
  } else if (action === 'create_playlist' && playlistName) {
    if (!db[email].playlists[playlistName]) {
      db[email].playlists[playlistName] = [];
    }
  } else if (action === 'add_to_playlist' && playlistName && track) {
    if (!db[email].playlists[playlistName]) db[email].playlists[playlistName] = [];
    const alreadyIn = db[email].playlists[playlistName].some(t => t.id === track.id);
    if (!alreadyIn) db[email].playlists[playlistName].unshift(track);
  }

  saveUserDatabase(db);
  res.json({ success: true, userData: db[email] });
});

// YouTube Auto-Suggest API
app.get('/api/suggest', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data[1] || []);
  } catch (err) {
    res.json([]);
  }
});

// YouTube Search API
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  const filter = req.query.filter || 'all';
  if (!query) return res.json([]);

  try {
    let searchTerm = query;
    if (filter === 'songs') searchTerm += ' song audio';
    else if (filter === 'artists') searchTerm += ' songs';

    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchTerm)}`;
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const html = await response.text();
    let jsonStr = '';
    if (html.includes('var ytInitialData = ')) {
      jsonStr = html.split('var ytInitialData = ')[1].split(';</script>')[0];
    } else if (html.includes('window["ytInitialData"] = ')) {
      jsonStr = html.split('window["ytInitialData"] = ')[1].split(';</script>')[0];
    }

    if (!jsonStr) return res.json([]);

    const data = JSON.parse(jsonStr);
    const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const tracks = [];
    for (const item of contents) {
      const v = item.videoRenderer;
      if (v && v.videoId) {
        tracks.push({
          id: v.videoId,
          title: v.title?.runs?.[0]?.text || 'Track',
          artist: v.ownerText?.runs?.[0]?.text || 'Artist',
          thumbnail: v.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          duration: v.lengthText?.simpleText || 'Audio'
        });
      }
      if (tracks.length >= 25) break;
    }
    res.json(tracks);
  } catch (err) {
    res.json([]);
  }
});

// Real-time Lyrics Engine with Fallback
app.get('/api/lyrics', async (req, res) => {
  let { title, artist } = req.query;
  if (!title) return res.json({ plainLyrics: "No track selected." });

  let cleanTitle = title.replace(/[\(\[\{].*?[\)\]\}]/g, '').replace(/official|audio|video|lyrics|hd|4k|remix|slowed/gi, '').trim();
  let cleanArtist = (artist || '').replace(/[\(\[\{].*?[\)\]\}]/g, '').replace(/official|channel|- topic|records/gi, '').trim();

  try {
    const lrcUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(cleanArtist)}`;
    let lrcRes = await fetch(lrcUrl, { headers: { 'User-Agent': 'KaiPlayApp/3.0' } });
    if (lrcRes.ok) {
      let data = await lrcRes.json();
      if (data.syncedLyrics || data.plainLyrics) return res.json(data);
    }

    let searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle)}`;
    let sRes = await fetch(searchUrl, { headers: { 'User-Agent': 'KaiPlayApp/3.0' } });
    if (sRes.ok) {
      let sData = await sRes.json();
      if (sData && sData.length > 0) return res.json(sData[0]);
    }

    res.json({ plainLyrics: `♪ Listening to "${cleanTitle}" ♪\n\nEnjoy the rhythm!` });
  } catch (err) {
    res.json({ plainLyrics: `♪ Playing Track ♪` });
  }
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`KaiPlay Server Live on port ${PORT}`);
});