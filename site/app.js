const element = id => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
const monthName = key => new Date(key + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayName = key => new Date(key + 'T00:00:00Z').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const colors = ['#202b3e', '#f9d792', '#e89542', '#bd4a2e', '#8a241a'];

function cellKey(row, bounds, step) {
  const index = (value, start, end) => Math.min(Math.ceil((end - start) / step - 1e-9) - 1, Math.floor((value - start) / step + 1e-9));
  return index(row.longitude, bounds.west, bounds.east) + ':' + index(row.latitude, bounds.south, bounds.north);
}

async function start() {
  const response = await fetch('fire-data.json');
  if (!response.ok) throw Error('Activity data could not be loaded.');
  const data = await response.json();
  const { months, bounds, gridDegrees, period: archive } = data;
  const keys = Object.keys(months).sort();
  const years = [...new Set(keys.map(key => key.slice(0, 4)))];
  function availableDays(month) {
    return [...new Set([
      ...Array.from({ length: daysIn(month) }, (_, i) => month + '-' + String(i + 1).padStart(2, '0'))
        .filter(day => day >= archive.start && day <= archive.end),
      ...(months[month].nrtDays ?? []),
    ])].sort();
  }
  const midpoint = (bounds.west + bounds.east) / 2;
  const regions = {
    'Study area': bounds,
    'Western half': { ...bounds, east: midpoint },
    'Eastern half': { ...bounds, west: midpoint, excludeWest: true },
  };
  const peak = data.lastRefresh ? keys.at(-1) :
    keys.reduce((a,b) => months[a].activity.both >= months[b].activity.both ? a : b);
  const prior = String(Number(peak.slice(0,4)) - 1) + peak.slice(4);
  for (const key of Object.keys(regions)) element('compare-region').add(new Option(key, key));
  let selectedRegionName = 'Study area';
  for (const id of ['compare-from','compare-through']) {
    for (const key of keys) element(id).add(new Option(monthName(key),key));
    element(id).value = id.startsWith('compare') && keys.includes(prior) ? prior : peak;
  }
  element('coverage').textContent = 'Northern California | Archive: ' + monthName(archive.start.slice(0, 7)) +
    ' to ' + monthName(archive.end.slice(0, 7)) +
    (data.lastRefresh ? ' | FIRMS refreshed ' + data.lastRefresh.slice(0, 10) + ' UTC' : '');
  let selectedMonth = peak;
  let selectedDay = '';
  const yearPicker = element('calendar-year');
  for (const year of years) yearPicker.add(new Option(year, year));
  yearPicker.value = selectedMonth.slice(0, 4);
  let sensor = 'both';
  let updateMap;
  let globalArchive;
  let mapPoints = [];
  let timer;
  let currentA;
  let currentB;
  let resizeMap;
  let exitEvent;
  const titles = { explore: 'Explore fire activity', trends: 'Activity trends', compare: 'Compare activity', events: 'Wildfire events' };

  function showPage() {
    const requested = location.hash.slice(1);
    const page = Object.hasOwn(titles, requested) ? requested : 'explore';
    for (const key of Object.keys(titles)) element(key + '-view').hidden = key !== page;
    for (const link of document.querySelectorAll('.site-nav a')) {
      if (link.hash === '#' + page) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    element('page-title').textContent = titles[page];
    stop();
    globalArchive?.stop();
    if (page !== 'explore') exitEvent?.();
    if (page === 'explore') requestAnimationFrame(() => resizeMap?.());
  }
  window.addEventListener('hashchange', showPage);
  showPage();

  function summarize(month, region, instrument, day = '') {
    const points = months[month].detections.filter(row =>
      (!day || row.acq_date === day) &&
      (instrument === 'both' || row.instrument === instrument) &&
      (region.excludeWest ? row.longitude > region.west : row.longitude >= region.west) &&
      row.longitude <= region.east && row.latitude >= region.south && row.latitude <= region.north);
    const days = new Set(points.map(row => row.acq_date + ':' + cellKey(row, bounds, gridDegrees)));
    return { month, points, active: days.size, raw: points.length };
  }

  function selection(prefix) {
    const name = prefix ? element(prefix + 'region').value : selectedRegionName;
    const region = regions[name];
    const from = prefix ? element(prefix + 'from').value : selectedMonth;
    const through = prefix ? element(prefix + 'through').value : selectedMonth;
    const day = prefix ? comparisonDay : selectedDay;
    const data = keys.filter(key => key >= from && key <= through).map(key => summarize(key, region, sensor, day));
    return { name, region, from, through, day, data, label: day ? dayName(day) : from === through ? monthName(from) : monthName(from) + ' – ' + monthName(through) };
  }

  function total(data, metric) {
    return data.reduce((sum, row) => sum + row[metric], 0);
  }

  function render(focus = false) {
    const a = currentA = selection('');
    const b = currentB = selection('compare-');
    const history = keys.map(key => summarize(key, a.region, sensor));
    const counts = new Map(history.map(row => [row.month, row.active]));
    drawCalendar(a, history.find(row => row.month === selectedMonth).points);
    mapPoints = a.data.flatMap(row => row.points);
    element('previous-year').disabled = !keys.includes(lastYear(a.day || a.from).slice(0, 7)) ||
      Boolean(a.day && !validDay(lastYear(a.day)));
    element('period').textContent = a.label;
    element('map-period').textContent = a.name + ' · ' + a.label +
      (months[a.from].nrtDays?.length ? ' · Near-real-time data' : '');
    element('count').textContent = number.format(total(a.data,'active'));
    element('raw').textContent = number.format(mapPoints.length);
    element('modis-count').textContent = number.format(mapPoints.filter(row => row.instrument === 'MODIS').length);
    element('viirs-count').textContent = number.format(mapPoints.filter(row => row.instrument === 'VIIRS').length);
    const comparable = history.filter(row => row.month !== a.from && row.month.slice(5) === a.from.slice(5)).map(row => row.active).sort((x,y)=>x-y);
    const middle = Math.floor(comparable.length/2);
    const median = comparable.length % 2 ? comparable[middle] : (comparable[middle-1]+comparable[middle])/2;
    element('baseline').textContent = !a.day && a.from === a.through && comparable.length
      ? monthName(a.from) + ': ' + number.format(counts.get(a.from)) + ' active cell-days · same-month median: ' + number.format(median) + ' (' + comparable.length + ' other years)'
      : 'Monthly MODIS and VIIRS series for ' + a.name.toLowerCase() + '.';
    const busiest = history.reduce((best, row) => row.active > best.active ? row : best);
    element('trend-summary').textContent = 'Peak for current sensor selection: ' + monthName(busiest.month) + ' ? ' + number.format(busiest.active) + ' active cell-days';
    configureTrendDate();
    element('compare-primary').value = selectedMonth;
    fillDayOptions('compare-day-a', selectedMonth, selectedDay);
    fillDayOptions('compare-day-b', b.from, comparisonDay);
    drawTrend(a);
    drawComparison(a,b);
    if (!element('event-playback').hidden) return;
    if (element('archive-scope').value === 'global') globalArchive?.refresh();
    else updateMap?.(mapPoints, a.region, focus);
  }

  function drawTrend(a) {
    const stats = element('trend-stats');
    stats.replaceChildren();
    for (const [label, value] of [['Selected period', a.label], ['Active cell-days', number.format(total(a.data, 'active'))], ['Satellite detections', number.format(total(a.data, 'raw'))]]) {
      const card = document.createElement('div');
      const name = document.createElement('p');
      const detail = document.createElement('strong');
      name.textContent = label;
      detail.textContent = value;
      card.append(name, detail);
      stats.append(card);
    }
    const metric = 'active';
    const day = a.day;
    const chartKeys = day ? availableDays(a.from) : keys;
    const series = ['MODIS','VIIRS'].map(instrument => chartKeys.map(key => summarize(key.slice(0, 7), a.region, instrument, day ? key : '')[metric]));
    const max = Math.max(1, ...series.flat());
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 600 125');
    svg.setAttribute('role','img');
    svg.setAttribute('aria-label', (day ? 'Daily' : 'Monthly') + ' active cell-days by sensor');
    series.forEach((values,index)=>{
      const line = document.createElementNS(svg.namespaceURI,'polyline');
      line.setAttribute('points',values.map((value,i)=>(8+i*584/Math.max(1,chartKeys.length-1))+','+(117-value/max*108)).join(' '));
      line.setAttribute('class', index ? 'viirs-line' : 'modis-line');
      svg.append(line);
    });
    element('trend').replaceChildren(svg);
    const dates = document.createElement('p');
    dates.className = 'trend-dates';
    dates.textContent = (day ? monthName(a.from) + ' | Daily activity' : monthName(keys[0]) + ' to ' + monthName(keys.at(-1))) + ' | Peak: ' + number.format(max);
    element('trend').append(dates);
  }

  function drawComparison(a,b) {
    const container = element('comparison');
    container.replaceChildren();
    const bothDays = Boolean(a.day && b.day);
    const bothMonthly = !a.day && !b.day;
    const difference = bothDays || bothMonthly
      ? total(a.data, 'active') / a.data.length - total(b.data, 'active') / b.data.length
      : null;
    element('compare-insight').textContent = difference === null ? 'Match the time scale to compare rates.' :
      'A minus B: ' + (difference > 0 ? '+' : '') + number.format(Math.round(difference)) +
      (bothDays ? ' active cells' : ' active cell-days per month');
    const rateFor = item => total(item.data, 'active') / item.data.length;
    const maximum = Math.max(1, rateFor(a), rateFor(b));
    for (const [letter,item] of [['A',a],['B',b]]) {
      const card = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = letter + ' · ' + item.name;
      const dates = document.createElement('p');
      dates.textContent = item.label;
      const count = document.createElement('strong');
      count.textContent = number.format(total(item.data,'active'));
      const rate = document.createElement('p');
      rate.textContent = item.day ? 'Active cells' : 'Active cell-days';
      const bar = document.createElement('div');
      bar.className = 'compare-bar';
      bar.style.setProperty('--activity-width', (rateFor(item) / maximum * 100) + '%');
      bar.hidden = difference === null;
      card.append(title, dates, count, rate, bar);
      container.append(card);
    }
  }

  function exportCsv(items, filename) {
    const rows = [['selection','region','period_utc','sensor','west','south','east','north','active_cell_days','detections']];
    for (const [label,item] of items) for (const row of item.data) {
      const {west,south,east,north}=item.region;
      rows.push([label,item.name,item.day || row.month,sensor,west,south,east,north,row.active,row.raw]);
    }
    const url = URL.createObjectURL(new Blob([rows.map(row=>row.join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a');
    link.href=url;
    link.download=filename;
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function lastYear(key) {
    return String(Number(key.slice(0, 4)) - 1) + key.slice(4);
  }

  function daysIn(month) {
    const [year, number] = month.split('-').map(Number);
    return new Date(Date.UTC(year, number, 0)).getUTCDate();
  }

  function validDay(day) {
    const month = day.slice(0, 7);
    return Boolean(months[month] && availableDays(month).includes(day));
  }

  function chooseDay(day, focusMap = false) {
    selectedDay = day;
    render(focusMap);
  }

  function chooseMonth(key) {
    stop();
    selectedMonth = key;
    yearPicker.value = key.slice(0, 4);
    chooseDay('', true);
  }

  function drawCalendar(a, points) {
    const monthPicker = element('month-picker');
    monthPicker.replaceChildren();
    for (const key of keys.filter(key => key.startsWith(yearPicker.value))) {
      const button = document.createElement('button');
      button.textContent = monthName(key).slice(0, 3);
      button.setAttribute('aria-pressed', key === selectedMonth);
      button.onclick = () => { chooseMonth(key); monthPicker.querySelector('[aria-pressed=true]').focus(); };
      monthPicker.append(button);
    }
    const calendar = element('calendar');
    calendar.replaceChildren();
    for (const label of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      const heading = document.createElement('span');
      heading.textContent = label;
      calendar.append(heading);
    }
    const offset = (new Date(selectedMonth + '-01T00:00:00Z').getUTCDay() + 6) % 7;
    for (let i = 0; i < offset; i++) calendar.append(document.createElement('span'));
    const daily = new Map();
    for (const row of points) {
      if (!daily.has(row.acq_date)) daily.set(row.acq_date, new Set());
      daily.get(row.acq_date).add(cellKey(row, bounds, gridDegrees));
    }
    const peakCount = Math.max(1, ...Array.from(daily.values(), cells => cells.size));
    const available = new Set(availableDays(selectedMonth));
    for (let i = 1; i <= daysIn(selectedMonth); i++) {
      const day = selectedMonth + '-' + String(i).padStart(2, '0');
      const count = daily.get(day)?.size ?? 0;
      const button = document.createElement('button');
      button.textContent = i;
      button.dataset.day = day;
      button.disabled = !available.has(day);
      button.style.setProperty('--cell', colors[Math.ceil(4 * Math.sqrt(count / peakCount))]);
      button.dataset.activity = count ? 'recorded' : 'none';
      button.title = dayName(day) + (button.disabled ? ' — No data imported' :
        count ? ' — ' + number.format(count) + ' active cells' : ' — No detections recorded');
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', day === selectedDay);
      button.onclick = () => {
        stop();
        chooseDay(day, true);
        calendar.querySelector('[data-day="' + day + '"]').focus();
      };
      calendar.append(button);
    }
    element('month-heading').textContent = monthName(selectedMonth);
    element('day-status').textContent = !a.data[0].raw ? 'No detections recorded for this selection.' :
      selectedDay ? dayName(selectedDay) + ' ? ' + number.format(a.data[0].active) + ' active cells' :
      number.format(daily.size) + ' days with detections ? UTC';
  }

  yearPicker.onchange = () => {
    const sameMonth = yearPicker.value + selectedMonth.slice(4);
    chooseMonth(keys.includes(sameMonth) ? sameMonth : keys.find(key => key.startsWith(yearPicker.value)));
  };

  let comparisonDay = '';
  for (const key of keys) element('compare-primary').add(new Option(monthName(key), key));
  function fillDayOptions(id, month, date) {
    const control = element(id);
    control.replaceChildren(new Option('Whole period', ''),
      ...availableDays(month).map(day => new Option(dayName(day), day)));
    control.value = date;
  }
  element('compare-primary').onchange = event => chooseMonth(event.target.value);
  element('compare-day-a').onchange = event => chooseDay(event.target.value);
  element('compare-day-b').onchange = event => {
    comparisonDay = event.target.value;
    if (comparisonDay) element('compare-through').value = comparisonDay.slice(0, 7);
    render();
  };
  element('previous-year').onclick = () => {
    const previous = lastYear(currentA.day || currentA.from);
    comparisonDay = currentA.day ? previous : '';
    element('compare-region').value = currentA.name;
    element('compare-from').value = element('compare-through').value = previous.slice(0, 7);
    render();
  };

  function stop() {
    clearInterval(timer);
    timer = undefined;
    element('play').textContent = 'Play days';
  }

  element('play').onclick = () => {
    if (timer !== undefined) { stop(); return; }
    element('play').textContent = 'Pause';
    let index = 0;
    const days = availableDays(selectedMonth);
    if (!days.length) { stop(); return; }
    const tick = (focus = false) => {
      chooseDay(days[index++], focus);
      if (index >= days.length) stop();
    };
    timer = setInterval(() => tick(), 650);
    tick(true);
  };
  for (const field of ['compare-from', 'compare-through', 'compare-region']) {
    element(field).onchange = () => {
      if (field !== 'compare-region') comparisonDay = '';
      const from = element('compare-from');
      const through = element('compare-through');
      if (from.value > through.value) {
        if (field === 'compare-from') through.value = from.value;
        else from.value = through.value;
      }
      render();
    };
  }
  for (const button of document.querySelectorAll('[data-sensor]')) {
    button.onclick = () => {
      stop();
      sensor = button.dataset.sensor;
      for (const control of document.querySelectorAll('[data-sensor]')) control.setAttribute('aria-pressed',control===button);
      render();
    };
  }
  for (const key of keys) element('trend-month').add(new Option(monthName(key), key));
  function configureTrendDate() {
    element('trend-month').value = selectedMonth;
    fillDayOptions('trend-day', selectedMonth, selectedDay);
  }
  element('trend-month').onchange = event => chooseMonth(event.target.value);
  element('trend-day').onchange = event => chooseDay(event.target.value);
  element('export-compare').onclick = () => exportCsv([['A',currentA],['B',currentB]], 'thermal-orbit-comparison.csv');
  render();
  setupMap(bounds, gridDegrees).then(({ update, getBounds, resize, flyToPlace, drawGlobal, fitRegion }) => {
    updateMap = update;
    setupSearch(flyToPlace);
    element('archive-scope').disabled = false;
    globalArchive = setupGlobal(cells => {
      if (element('event-playback').hidden) drawGlobal(cells);
      element('use-view').disabled = true;
      element('fit').hidden = true;
    }, () => {
      drawGlobal(null);
      element('use-view').disabled = false;
      element('fit').hidden = false;
      render();
    }, () => sensor);
    exitEvent = window.setupFireEvents({ drawGlobal, fitRegion, resize, archive: globalArchive });
    window.emberAssistantMap = {
      view: () => ({
        scope: element('archive-scope').value,
        period: element('archive-scope').value === 'global'
          ? element('global-day').value || element('global-month').value
          : selectedDay || selectedMonth,
        sensor,
      }),
      async show({ period, scope, place }) {
        exitEvent?.();
        location.hash = 'explore';
        await new Promise(resolve => requestAnimationFrame(resolve));
        resize();
        if (scope === 'global') {
          const found = await globalArchive.show(period);
          if (found && place) flyToPlace(place);
          return found;
        }
        if (!keys.includes(period.slice(0, 7)) || (period.length === 10 && !validDay(period))) return false;
        element('archive-scope').value = 'local';
        await element('archive-scope').onchange();
        chooseMonth(period.slice(0, 7));
        if (period.length === 10) chooseDay(period, true);
        return true;
      },
    };
    resizeMap = resize;
    element('play').disabled = false;
    element('use-view').disabled = false;
    element('use-view').onclick = () => {
      const view = getBounds();
      const region = {
        west: Math.max(bounds.west, view.getWest()),
        east: Math.min(bounds.east, view.getEast()),
        south: Math.max(bounds.south, view.getSouth()),
        north: Math.min(bounds.north, view.getNorth()),
      };
      if (region.west >= region.east || region.south >= region.north) {
        element('status').textContent = 'Move the map over the study area first.';
        return;
      }
      element('status').textContent = '';
      const name = 'Map view ' + (Object.keys(regions).length - 2);
      regions[name] = region;
      element('compare-region').add(new Option(name, name));
      selectedRegionName = name;
      stop();
      render();
    };
    if (element('archive-scope').value === 'local') updateMap(mapPoints,currentA.region,false);
  }).catch(error => {
    console.error(error);
    element('map-status').textContent = 'Earth map unavailable. Check your connection and browser WebGL support.';
  });
}

start().catch(error => {
  element('status').textContent = error.message;
  element('period').textContent = 'Detections unavailable';
});


async function setupMap({ west, south, east, north }, gridDegrees) {
  const { Map, NavigationControl, Popup, Marker } = await import('https://unpkg.com/maplibre-gl@6.18.0/dist/maplibre-gl.mjs');
  const center = [(west + east) / 2, (south + north) / 2];
  const overview = { center: [-110, 27], zoom: 0.95, bearing: 0, pitch: 0 };
  const collection = features => ({ type: 'FeatureCollection', features });
  const feature = (type, coordinates, properties = {}) => ({
    type: 'Feature', geometry: { type, coordinates }, properties,
  });
  const response = await fetch('https://tiles.openfreemap.org/styles/liberty', { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Basemap style unavailable');
  const style = await response.json();
  const map = new Map({
    container: 'map',
    ...overview,
    minZoom: 0,
    maxZoom: 18,
    renderWorldCopies: false,
    attributionControl: false,
    style: {
      ...style,
      projection: { type: 'globe' },
      sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
      sources: {
        ...style.sources,
        satellite: {
          type: 'raster',
          tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'],
          tileSize: 256,
          maxzoom: 13,
          attribution: '<a href="https://s2maps.eu/">Sentinel-2 cloudless by EOX</a>',
        },
      },
      layers: [
        { id: 'satellite', type: 'raster', source: 'satellite' },
        ...style.layers.filter(layer => layer.type === 'symbol' || layer['source-layer'] === 'boundary')
          .map(layer => layer.type === 'symbol' && layer.layout?.['text-field'] ? {
            ...layer,
            paint: { ...layer.paint, 'text-color': '#f5f7fb', 'text-halo-color': '#111c2f', 'text-halo-width': 1.4 },
          } : layer),
      ],
    },
  });
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  const motion = duration => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration;
  const zoomToStudy = () => map.fitBounds([[west, south], [east, north]], { padding: 42, duration: motion(1600) });
  const popup = new Popup();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('World map load timed out')), 20000);
    map.once('style.load', () => { clearTimeout(timer); resolve(); });
  }).catch(error => {
    map.remove();
    throw error;
  });

  map.addSource('study', {
    type: 'geojson',
    data: collection([
      feature('Polygon', [[[west, south], [east, south], [east, north], [west, north], [west, south]]]),
      feature('Point', center),
    ]),
  });
  map.addSource('detections', { type: 'geojson', data: collection([]) });
  map.addLayer({
    id: 'study-border', type: 'line', source: 'study', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'line-color': '#95f3de', 'line-width': 2, 'line-dasharray': [3, 2] },
  });
  map.addLayer({
    id: 'study-pin', type: 'circle', source: 'study', maxzoom: 5, filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 7, 'circle-color': '#e47631', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff1d6' },
  });
  map.addLayer({
    id: 'hotspots', type: 'heatmap', source: 'detections', minzoom: 4,
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'peakFrp'], 0, 0.15, 100, 1],
      'heatmap-intensity': 0.75,
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 13, 8, 23, 12, 38, 18, 48],
      'heatmap-opacity': 0.85,
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(255,209,97,0)', 0.14, 'rgba(255,209,97,0.35)', 0.35, '#ffc552',
        0.58, '#ed7627', 0.79, '#bb3320', 1, '#66150f'],
    },
  }, map.getStyle().layers.find(layer => layer.type === 'symbol')?.id);
  map.addLayer({
    id: 'hotspot-details', type: 'circle', source: 'detections', minzoom: 4,
    paint: { 'circle-radius': 12, 'circle-opacity': 0 },
  });

  const continents = [
    ['North America', [-105, 57]], ['South America', [-60, -18]],
    ['Europe', [17, 55]], ['Africa', [20, 5]], ['Asia', [93, 53]],
    ['Oceania', [135, -24]], ['Antarctica', [0, -78]],
  ].map(([name, location]) => {
    const label = document.createElement('span');
    label.className = 'continent-label';
    label.textContent = name;
    new Marker({ element: label }).setLngLat(location).addTo(map);
    return label;
  });
  const updateLabels = () => {
    for (const label of continents) label.hidden = map.getZoom() > 2.5;
  };
  map.on('zoom', updateLabels);
  updateLabels();

  element('map-status').hidden = true;
  element('world').disabled = false;
  element('fit').disabled = false;
  element('world').onclick = () => {
    popup.remove();
    map.flyTo({ ...overview, duration: motion(1200) });
  };
  element('fit').onclick = zoomToStudy;
  map.on('click', 'study-pin', zoomToStudy);
  for (const layer of ['study-pin', 'hotspot-details']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', 'hotspot-details', event => {
    const hit = event.features?.[0];
    if (!hit) return;
    const { peakFrp, modis, viirs } = hit.properties;
    const content = document.createElement('div');
    for (const value of [
      'Peak observed FRP: ' + number.format(peakFrp) + ' MW',
      'MODIS detections: ' + number.format(modis),
      'VIIRS detections: ' + number.format(viirs),
    ]) {
      const line = document.createElement('div');
      line.textContent = value;
      content.append(line);
    }
    popup.setLngLat(event.lngLat).setDOMContent(content).addTo(map);
  });
  function fitRegion(region) {
    map.fitBounds([[region.west, region.south], [region.east, region.north]], { padding: 45, maxZoom: 13, duration: motion(900) });
  }

  function update(points, region, focus) {
    if (focus) fitRegion(region);
    popup.remove();
    const cells = new globalThis.Map();
    for (const row of points) {
      const key = cellKey(row, { west, south, east, north }, gridDegrees);
      if (!cells.has(key)) {
        cells.set(key, feature('Point', [row.longitude, row.latitude], { peakFrp: 0, modis: 0, viirs: 0 }));
      }
      const stats = cells.get(key).properties;
      stats.peakFrp = Math.max(stats.peakFrp, Number(row.frp) || 0);
      stats[row.instrument === 'MODIS' ? 'modis' : 'viirs']++;
    }
    map.getSource('detections').setData(collection([...cells.values()]));
    map.setLayoutProperty('hotspots', 'visibility', 'visible');
  }
  map.addSource('global-activity', { type: 'geojson', data: collection([]) });
  map.addLayer({
    id: 'global-heat', type: 'heatmap', source: 'global-activity',
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'count'], 0, 0, 5, 0.2, 50, 0.65, 200, 1],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 8, 4, 19, 8, 36, 12, 48],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1.6, 5, 2.1, 10, 1.6],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(255,209,97,0)', 0.16, 'rgba(255,197,82,0.45)', 0.35, '#ffc552', 0.54, '#ed7627', 0.73, '#bd3820', 1, '#75140e'],
    },
  }, map.getStyle().layers.find(layer => layer.type === 'symbol')?.id);
  function drawGlobal(cells) {
    popup.remove();
    for (const id of ['hotspots', 'hotspot-details', 'study-border', 'study-pin']) {
      map.setLayoutProperty(id, 'visibility', cells ? 'none' : 'visible');
    }
    map.getSource('global-activity').setData(collection((cells ?? []).map(cell =>
      feature('Point', [cell.x + (cell.offset ?? 0.5), cell.y + (cell.offset ?? 0.5)], { count: cell.MODIS + cell.VIIRS })
    )));
  }
  return {
    update, drawGlobal, fitRegion, resize: () => map.resize(), getBounds: () => map.getBounds(),
    flyToPlace(place) {
      popup.remove();
      const zoom = place.feature_code === 'PCLI' ? 4 : /^ADM/.test(place.feature_code ?? '') ? 6 : 10;
      map.flyTo({ center: [place.longitude, place.latitude], zoom, duration: motion(1400) });
    },
  };
}

function setupSearch(flyToPlace) {
  const form = element('place-search');
  const input = element('place-query');
  const status = element('search-status');
  const results = element('search-results');
  let pending;
  let debounce;

  async function search() {
    clearTimeout(debounce);
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const query = input.value.trim();
    results.replaceChildren();
    if (query.length < 2) { status.textContent = ''; return; }
    status.textContent = 'Searching places…';
    try {
      const params = new URLSearchParams({ name: query, count: '8', language: /[\u0600-\u06ff]/.test(query) ? 'ar' : 'en' });
      const response = await fetch('https://geocoding-api.open-meteo.com/v1/search?' + params,
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw Error('Place search unavailable');
      const data = await response.json();
      if (controller.signal.aborted) return;
      for (const place of data.results ?? []) {
        if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = [...new Set([place.name, place.admin1, place.country].filter(Boolean))].join(', ');
        button.onclick = () => {
          input.value = place.name;
          results.replaceChildren();
          flyToPlace(place);
          status.textContent = 'Showing ' + button.textContent + '.';
        };
        item.append(button);
        results.append(item);
      }
      status.textContent = results.children.length ? '' : 'No matching places. Try a nearby city or another spelling.';
    } catch {
      if (!controller.signal.aborted) status.textContent = 'Place search unavailable. Try again shortly.';
    }
  }

  form.onsubmit = event => { event.preventDefault(); search(); };
  function clearSearch() {
    clearTimeout(debounce);
    pending?.abort();
    results.replaceChildren();
    status.textContent = '';
  }

  input.oninput = () => {
    clearSearch();
    if (input.value.trim().length >= 3) debounce = setTimeout(search, 320);
  };
  form.addEventListener('focusout', event => {
    if (!form.contains(event.relatedTarget)) clearSearch();
  });
  input.onkeydown = event => {
    if (event.key === 'Escape') clearSearch();
    if (event.key === 'ArrowDown' && results.firstElementChild) {
      event.preventDefault();
      results.firstElementChild.querySelector('button').focus();
    }
  };
}
