/**
 * Compagno locale del gioco: scarica l'audio del video ufficiale con yt-dlp
 * e lo passa al browser. Gira solo su 127.0.0.1 e accetta solo quel video:
 * non è un proxy generico. Richiede yt-dlp (vedi tools/ytdlp).
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5198;
const VIDEO_ID = 'usgNkiExsCM';

const candidates = [
  resolve(root, 'tools/ytdlp/Scripts/yt-dlp.exe'),
  resolve(root, 'tools/ytdlp/bin/yt-dlp'),
  'yt-dlp',
];
const ytDlp = candidates.find((candidate) => candidate === 'yt-dlp' || existsSync(candidate)) ?? null;

const setCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

const json = (res, code, body) => {
  setCors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/api/health') {
    json(res, 200, { ok: true, ytdlp: Boolean(ytDlp), video: VIDEO_ID });
    return;
  }

  if (url.pathname === '/api/download') {
    if (!ytDlp) {
      json(res, 500, { error: 'yt-dlp non trovato' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="the-final-song.webm"',
    });
    const child = spawn(
      ytDlp,
      [
        '--no-warnings',
        '--no-progress',
        '--no-playlist',
        '-f',
        'bestaudio/best',
        '-o',
        '-',
        `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.pipe(res);
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', () => {
      try {
        res.destroy();
      } catch {
        // connessione gia' chiusa
      }
    });
    child.on('close', (code) => {
      if (code !== 0) {
        try {
          res.destroy();
        } catch {
          // connessione gia' chiusa
        }
      }
    });
    req.on('close', () => {
      try {
        child.kill();
      } catch {
        // processo gia' terminato
      }
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[song-server] http://127.0.0.1:${PORT}  yt-dlp: ${ytDlp ?? 'non trovato'}`);
});
