import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { parseEnv } from 'node:util';
import { refresh } from './refresh-firms.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const geminiConfig = new URL('../.gemini.env', import.meta.url);

let assistantBusy = false;
async function assistant(request, response) {
  const send = (status, data) => response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  }).end(JSON.stringify(data));
  if (request.method !== 'POST' || request.headers['sec-fetch-site'] === 'cross-site' ||
      !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    return send(400, { error: 'Use the Thermal Orbit chat panel.' });
  }
  if (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) {
    return send(403, { error: 'Invalid origin.' });
  }
  if (assistantBusy) return send(429, { error: 'The assistant is busy. Try again shortly.' });
  assistantBusy = true;
  try {
    const config = parseEnv(await readFile(geminiConfig, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    }));
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 24000) return send(413, { error: 'Message is too long.' });
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(400, { error: 'Invalid message.' }); }
    if (typeof body?.message !== 'string' || !body.message.trim() || body.message.length > 2000 ||
        !Array.isArray(body.history)) return send(400, { error: 'Enter a message of 1â€“2000 characters.' });
    const script = fileURLToPath(new URL('assistant.py', import.meta.url));
    const windows = process.platform === 'win32';
    const executable = process.env.EMBERSCOPE_PYTHON || (windows ? 'py' : 'python3');
    const args = windows && !process.env.EMBERSCOPE_PYTHON ? ['-3', script] : [script];
    const output = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        windowsHide: true, timeout: 75000, stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, GEMINI_API_KEY: config.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
          GEMINI_MODEL: config.GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash',
          FIRMS_MAP_KEY: '', PYTHONIOENCODING: 'utf-8' },
      });
      let result = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { result += chunk; });
      child.stdin.on('error', reject);
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(result) : reject(Error('Assistant exited')));
      child.stdin.end(JSON.stringify(body));
    });
    const result = JSON.parse(output);
    send(result.error ? (result.status ?? 502) : 200, result);
  } catch (error) {
    console.error('Assistant worker failed:', error.code ?? error.name);
    const launchFailed = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code);
    send(502, { error: launchFailed
      ? 'Could not start Python. Check that py -3 works, or set EMBERSCOPE_PYTHON to your Python executable.'
      : 'The assistant worker did not return a response. Check the server terminal.' });
  } finally {
    assistantBusy = false;
  }
}

try {
  loadEnvFile(new URL('../.firms.env', import.meta.url));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

async function refreshDaily() {
  try {
    const data = await refresh({ key: process.env.FIRMS_MAP_KEY });
    console.log('FIRMS refresh:', data.lastRefresh ?? 'archive already covers today');
  } catch (error) {
    console.error('FIRMS refresh failed:', error.message);
  }
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 6);
  setTimeout(refreshDaily, next - +now).unref();
}

if (process.env.FIRMS_MAP_KEY && process.env.FIRMS_DISABLE_REFRESH !== '1') {
  void refreshDaily();
}

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/global.js', ['global.js', 'text/javascript; charset=utf-8']],
  ['/assistant.js', ['assistant.js', 'text/javascript; charset=utf-8']],
  ['/events.json', ['events.json', 'application/json']],
  ['/events.js', ['events.js', 'text/javascript; charset=utf-8']],
  ['/fire-data.json', ['fire-data.json', 'application/json']],
]);

const port = Number(process.env.PORT ?? 4173);
createServer(async (request, response) => {
  const path = request.url.split('?')[0];
  const eventFrame = /^\/api\/events\/(amazon|australia|siberia|canada|los-angeles)$/.exec(path);
  if (eventFrame) {
    try {
      const readFrames = suffix => readFile(new URL('../event-data/' + eventFrame[1] + suffix, import.meta.url), 'utf8')
        .then(JSON.parse).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return {};
        });
      const [primary, fallback] = await Promise.all([readFrames('.json'), readFrames('.fallback.json')]);
      const content = Object.fromEntries([...new Set([...Object.keys(fallback), ...Object.keys(primary)])].map(day =>
        [day, primary[day] || fallback[day] ? { ...fallback[day], ...primary[day] } : null]));
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(content));
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
    }
    return;
  }
  if (path === '/api/assistant') return assistant(request, response);
  const globalMonth = /^\/api\/global\/(MODIS|VIIRS)\/(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(path);
  if (path === '/api/global' || globalMonth) {
    const root = new URL('../global-data/', import.meta.url);
    try {
      if (globalMonth) {
        const content = await readFile(new URL(globalMonth[1] + '/' + globalMonth[2] + '.json.gz', root));
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' }).end(content);
      } else {
        const entries = await Promise.all(['MODIS', 'VIIRS'].map(async sensor => {
          const dir = new URL(sensor + '/', root);
          const names = await readdir(dir).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
          });
          const months = names.filter(name => /^\d{4}-\d{2}\.json\.gz$/.test(name)).map(name => name.slice(0, 7)).sort();
          const complete = names.includes('index.json.gz');
          const observed = complete
            ? JSON.parse(gunzipSync(await readFile(new URL('index.json.gz', dir)))).months
            : months;
          return [sensor, { months, complete, demoMonths: months.filter(month => !observed.includes(month)) }];
        }));
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(Object.fromEntries(entries)));
      }
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
    }
    return;
  }
  const file = files.get(path);
  if (!file) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const content = await readFile(new URL(`../site/${file[0]}`, import.meta.url));
    response.writeHead(200, {
      'Content-Type': file[1],
      ...(file[0] === 'fire-data.json' ? { 'Cache-Control': 'no-store' } : {}),
    }).end(content);
  } catch {
    response.writeHead(500).end('Site file unavailable');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${port}`);
});

