import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const snapshot = new URL('../site/fire-data.json', import.meta.url);
const sources = { MODIS: 'MODIS_NRT', VIIRS: 'VIIRS_NOAA20_NRT' };
const dayMs = 86_400_000;

export function parseFeed(csv, instrument, bounds, start, end, processing = 'NRT') {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const columns = header.split(',');
  const fields = ['latitude', 'longitude', 'acq_date', 'acq_time', 'satellite', 'confidence', 'frp'];
  if (fields.some(field => !columns.includes(field))) throw Error('Unexpected FIRMS CSV header');
  return lines.map(line => {
    const values = line.split(',');
    const row = Object.fromEntries(fields.map(field => [field, values[columns.indexOf(field)]]));
    const { latitude, longitude, acq_date, acq_time } = row;
    if (values.length !== columns.length || !latitude || !longitude ||
      !Number.isFinite(+latitude) || !Number.isFinite(+longitude) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(acq_date) || acq_date < start || acq_date > end ||
      !/^\d{1,4}$/.test(acq_time) || !row.satellite || !row.frp || !Number.isFinite(+row.frp)) {
      throw Error('Invalid FIRMS CSV row');
    }
    return { ...row, latitude: +latitude, longitude: +longitude, frp: +row.frp,
      acq_time: acq_time.padStart(4, '0'), instrument, processing };
  }).filter(row => row.latitude >= bounds.south && row.latitude <= bounds.north &&
    row.longitude >= bounds.west && row.longitude <= bounds.east);
}

export function monthlyActivity(detections, { west, south, east, north }, gridDegrees) {
  const cells = { both: new Set(), MODIS: new Set(), VIIRS: new Set() };
  for (const row of detections) {
    const x = Math.min(Math.ceil((east - west) / gridDegrees - 1e-9) - 1, Math.floor((row.longitude - west) / gridDegrees + 1e-9));
    const y = Math.min(Math.ceil((north - south) / gridDegrees - 1e-9) - 1, Math.floor((row.latitude - south) / gridDegrees + 1e-9));
    const id = [row.acq_date, x, y].join(':');
    cells.both.add(id);
    cells[row.instrument].add(id);
  }
  return Object.fromEntries(Object.entries(cells).map(([name, set]) => [name, set.size]));
}

export async function refresh({ file = snapshot, key, fetchFeed = fetch, now = new Date() } = {}) {
  if (!key) throw Error('Set FIRMS_MAP_KEY on the server');
  const data = JSON.parse(await readFile(file, 'utf8'));
  const date = timestamp => new Date(timestamp).toISOString().slice(0, 10);
  const end = date(now);
  const start = date(+now - 4 * dayMs);
  const archiveEnd = data.period.end;
  if (end <= archiveEnd) return data;
  const { west, south, east, north } = data.bounds;
  const area = [west, south, east, north].join(',');
  const feeds = await Promise.all(Object.entries(sources).map(async ([instrument, source]) => {
    try {
      const url = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' +
        encodeURIComponent(key) + '/' + source + '/' + area + '/5/' + start;
      const response = await fetchFeed(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
      if (!response.ok) throw Error('HTTP ' + response.status);
      return parseFeed(await response.text(), instrument, data.bounds, start, end);
    } catch (error) {
      const reason = /^(HTTP \d+|Unexpected FIRMS CSV header|Invalid FIRMS CSV row)$/.test(error.message)
        ? error.message : 'network request failed';
      throw Error(source + ': ' + reason);
    }
  }));
  const refreshedDays = new Set(Array.from({ length: 5 }, (_, i) => date(+now - i * dayMs))
    .filter(day => day > archiveEnd));
  const touched = new Set([...refreshedDays].map(day => day.slice(0, 7)));
  const unique = new Map();
  for (const row of feeds.flat()) {
    if (!refreshedDays.has(row.acq_date)) continue;
    const id = [row.instrument, row.satellite, row.acq_date, row.acq_time, row.latitude, row.longitude].join('|');
    unique.set(id, row);
  }
  for (const month of touched) {
    const previous = data.months[month] ?? { detections: [] };
    const detections = previous.detections.filter(row => !refreshedDays.has(row.acq_date));
    detections.push(...[...unique.values()].filter(row => row.acq_date.startsWith(month)));
    data.months[month] = { detections,
      activity: monthlyActivity(detections, data.bounds, data.gridDegrees),
      nrtDays: [...new Set([...(previous.nrtDays ?? []), ...[...refreshedDays].filter(day => day.startsWith(month))])].sort(),
    };
  }
  data.lastRefresh = now.toISOString();
  const temp = new URL(file.href + '.' + randomUUID() + '.tmp');
  try {
    await writeFile(temp, JSON.stringify(data));
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const data = await refresh({ key: process.env.FIRMS_MAP_KEY });
    console.log('FIRMS refresh complete:', data.lastRefresh ?? 'archive already covers today');
  } catch (error) {
    console.error('FIRMS refresh failed:', error.message);
    process.exitCode = 1;
  }
}
