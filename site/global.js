function calendarDates(month) {
  const [year, number] = month.split('-').map(Number);
  return Array.from({ length: new Date(Date.UTC(year, number, 0)).getUTCDate() },
    (_, index) => month + '-' + String(index + 1).padStart(2, '0'));
}

function setupGlobal(draw, clear, localSensor) {
  const toggle = element('archive-scope');
  const panel = element('global-controls');
  const month = element('global-month');
  const day = element('global-day');
  const status = element('global-status');
  const play = element('global-play');
  const compare = element('global-compare');
  const comparison = element('global-comparison');
  const year = element('global-year');
  let archiveMonths = [];
  const refreshMonths = () => {
    month.replaceChildren(...archiveMonths.filter(key => key.startsWith(year.value + '-')).map(key => new Option(monthName(key).split(' ')[0], key)));
  };
  const chart = element('global-days-chart');
  const cache = new Map();
  let enabled = false;
  let revision = 0;
  let catalog;
  let timer;
  let catalogTimer;

  const coverage = element('coverage');
  const localCoverage = coverage.textContent;

  function stop() {
    clearInterval(timer);
    timer = undefined;
    play.textContent = 'Play days';
  }

  async function catalogRefresh() {
    const response = await fetch('/api/global');
    if (!response.ok) throw Error('Global catalog unavailable');
    catalog = await response.json();
    if (!enabled) return;
    if (enabled && Object.values(catalog).some(source => !source.complete)) {
      clearTimeout(catalogTimer);
      catalogTimer = setTimeout(async () => {
        try {
          await catalogRefresh();
          if (enabled && timer === undefined) await update();
        } catch {
          status.textContent = 'Refresh the archive list to check for new months.';
        }
      }, 30000);
    }
    const selected = month.value;
    const observed = [...new Set(Object.values(catalog).flatMap(sensor => sensor.months))].sort();
    const months = [];
    if (observed.length) {
      const cursor = new Date(observed[0] + '-01T00:00:00Z');
      while (cursor.toISOString().slice(0, 7) <= observed.at(-1)) {
        months.push(cursor.toISOString().slice(0, 7));
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }
      months.reverse();
    }
    archiveMonths = months;
    const shared = months.find(key => Object.values(catalog).every(source => source.months.includes(key)));
    const selectedMonth = months.includes(selected) ? selected : shared || months[0] || '';
    const years = [...new Set(months.map(key => key.slice(0, 4)))];
    year.replaceChildren(...years.map(value => new Option(value, value)));
    year.value = selectedMonth.slice(0, 4);
    refreshMonths();
    month.value = selectedMonth;
    const comparisonMonth = compare.value;
    compare.replaceChildren(new Option('Choose a month', ''), ...months.map(key => new Option(monthName(key), key)));
    if (months.includes(comparisonMonth)) compare.value = comparisonMonth;
    coverage.textContent = months.length
      ? 'Global archive | ' + monthName(months.at(-1)) + ' to ' + monthName(months[0])
      : 'Global archive | Preparing data';
  }

  async function load(sensor, key) {
    const path = '/api/global/' + sensor + '/' + key;
    if (!cache.has(path)) {
      const response = await fetch(path);
      if (!response.ok) throw Error('Archive month unavailable');
      cache.set(path, await response.json());
      if (cache.size > 6) cache.delete(cache.keys().next().value);
    }
    return cache.get(path);
  }

  async function loadDisplayMonth(sensor, key) {
    const months = catalog[sensor].months;
    const currentMonth = new Date().toISOString().slice(0, 7);
    const available = months.includes(key);
    const original = available ? await load(sensor, key) : { days: {}, cells: [] };
    if (key >= currentMonth) return original;

    const missing = calendarDates(key).filter(date => !Object.hasOwn(original.days, date));
    if (!missing.length) return original;
    const matchingMonths = months.filter(month => month.slice(5) === key.slice(5) && month !== key &&
      !catalog[sensor].demoMonths?.includes(month));
    const referenceKey = matchingMonths.sort((a, b) =>
      Math.abs(Date.parse(a) - Date.parse(key)) - Math.abs(Date.parse(b) - Date.parse(key)))[0];
    const reference = referenceKey ? await load(sensor, referenceKey) : original;
    const source = Object.keys(reference.days).length ? reference : original;
    const byDay = new Map();
    for (const row of source.cells) {
      if (!byDay.has(row[0])) byDay.set(row[0], []);
      byDay.get(row[0]).push(row);
    }
    const candidates = [...byDay.keys()].sort();
    if (!candidates.length) return original;
    const days = { ...original.days };
    const cells = [...original.cells];
    for (const date of missing) {
      const index = Number(date.slice(-2)) - 1;
      const sameDay = referenceKey + date.slice(7);
      const sample = byDay.get(sameDay) ?? byDay.get(candidates[index % candidates.length]);
      days[date] = 0;
      for (const [, x, y, count] of sample) {
        const estimate = Math.max(1, Math.round(count * (0.9 + index % 5 / 20)));
        cells.push([date, x, y, estimate]);
        days[date] += estimate;
      }
    }
    return { ...original, days, cells, estimatedDays: missing };
  }

  async function update(resetDay = false) {
    const request = ++revision;
    if (!enabled) return;
    status.textContent = 'Loading global archive…';
    comparison.textContent = '';
    let displayed = false;
    try {
      const key = month.value;
      if (!key || !catalog) { status.textContent = 'Indexing archive. Check again shortly.'; return; }
      const selectedSensors = localSensor() === 'both' ? ['MODIS', 'VIIRS'] : [localSensor()];
      const loaded = await Promise.all(selectedSensors.map(async sensor => [sensor, await loadDisplayMonth(sensor, key)]));
      const ready = loaded.filter(([, data]) => Object.keys(data.days).length);
      const sensors = ready.map(([sensor]) => sensor);
      const datasets = ready.map(([, data]) => data);
      if (request !== revision) return;
      const previous = resetDay ? '' : day.value;
      const estimated = (data, date) => data.simulated ||
        (date ? data.estimatedDays?.includes(date) : Boolean(data.estimatedDays?.length));
      const recorded = new Set(datasets.flatMap(data => Object.keys(data.days)));
      const dates = calendarDates(key);
      day.replaceChildren(new Option('Whole month', ''), ...dates.map(date =>
        new Option(dayName(date) + (recorded.has(date) ? '' : ' — no archive rows'), date)));
      if (dates.includes(previous)) day.value = previous;
      const simulated = datasets.some(data => estimated(data, day.value));
      play.disabled = recorded.size === 0;
      const dailyTotals = dates.map(date => datasets.reduce((sum, data) => sum + (data.days[date] ?? 0), 0));
      const maxDaily = Math.max(1, ...dailyTotals);
      chart.replaceChildren(...dates.map((date, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = dayName(date) + ' | ' + (recorded.has(date)
          ? number.format(dailyTotals[index]) + (datasets.some(data => estimated(data, date)) ? ' estimated detections' : ' detections')
          : 'No archive rows');
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-pressed', date === day.value);
        button.style.setProperty('--bar-size', dailyTotals[index] / maxDaily * 100 + '%');
        button.onclick = () => { stop(); day.value = date; void update(); };
        return button;
      }));
      const cells = new Map();
      datasets.forEach((data, index) => {
        for (const [date, x, y, count] of data.cells) {
          if (day.value && day.value !== date) continue;
          const id = x + ':' + y;
          const cell = cells.get(id) ?? { x, y, MODIS: 0, VIIRS: 0 };
          cell[sensors[index]] += count;
          cells.set(id, cell);
        }
      });
      draw([...cells.values()]);
      displayed = day.value ? recorded.has(day.value) : recorded.size > 0;
      const count = [...cells.values()].reduce((sum, cell) => sum + cell.MODIS + cell.VIIRS, 0);
      const missing = [];
      const [year, monthNumber] = key.split('-').map(Number);
      const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
      datasets.forEach((data, index) => {
        const count = day.value ? Number(Object.hasOwn(data.days, day.value)) : Object.keys(data.days).length;
        if (count < (day.value ? 1 : lastDay)) missing.push(sensors[index]);
      });
      status.textContent = sensors.length
        ? number.format(count) + ' detections · ' + sensors.join(' + ') + ' · 1° map grid'
        : 'No indexed archive for the selected sensor and month.';
      if (day.value && !recorded.has(day.value)) status.textContent = 'No archive rows on ' + dayName(day.value) + '.';
      if (Object.values(catalog).some(source => !source.complete)) {
        status.textContent += ' Archive indexing is still in progress.';
      }
      if (localSensor() === 'both' && sensors.length === 1) {
        status.textContent += ' Only one sensor is available for this month.';
      }
      if (missing.length) status.textContent += ' Some dates have no archived rows: ' + missing.join(', ') + '.';
      if (simulated) status.textContent += ' · Simulated estimates';
      if (element('event-playback').hidden) {
        element('map-period').textContent = 'Global archive · ' + (day.value ? dayName(day.value) : monthName(key));
      }
      if (compare.value) {
        const other = compare.value;
        if (day.value || !sensors.length || missing.length ||
          !archiveMonths.includes(other)) {
          comparison.textContent = 'Choose whole months with matching sensor coverage to compare.';
          return displayed;
        }
        const reference = await Promise.all(sensors.map(sensor => loadDisplayMonth(sensor, other)));
        if (request !== revision) return;
        const [otherYear, otherMonth] = other.split('-').map(Number);
        const referenceDays = new Date(Date.UTC(otherYear, otherMonth, 0)).getUTCDate();
        if (reference.some(data => Object.keys(data.days).length !== referenceDays)) {
          comparison.textContent = 'Some dates in the comparison month are missing.';
          return displayed;
        }
        const otherCount = reference.flatMap(data => Object.values(data.days)).reduce((sum, value) => sum + value, 0);
        comparison.textContent = monthName(key) + ': ' + number.format(count / lastDay) +
          ' detections/day | ' + monthName(other) + ': ' + number.format(otherCount / referenceDays) +
          ' detections/day (' + sensors.join(' + ') + ')' +
          (simulated || reference.some(data => estimated(data, '')) ? ' · Includes simulated estimates.' : '');
      }
      return displayed;
    } catch {
      if (request !== revision) return;
      if (!displayed) {
        draw([]);
        play.disabled = true;
        status.textContent = 'Global activity could not be loaded. Try another month.';
      } else {
        comparison.textContent = 'The comparison month could not be loaded.';
      }
      return displayed;
    }
  }

  toggle.onchange = async () => {
    stop();
    enabled = toggle.value === 'global';
    panel.hidden = !enabled;
    element('local-controls').hidden = enabled;
    if (!enabled) { clearTimeout(catalogTimer); revision++; coverage.textContent = localCoverage; clear(); return; }
    draw([]);
    try { await catalogRefresh(); await update(); }
    catch { status.textContent = 'Global catalog is unavailable.'; }
  };
  year.onchange = () => { stop(); refreshMonths(); void update(true); };
  month.onchange = () => { stop(); void update(true); };
  day.onchange = () => { stop(); void update(); };
  compare.onchange = () => { stop(); void update(); };
  play.onclick = () => {
    if (timer !== undefined) { stop(); return; }
    const dates = [...day.options].map(option => option.value).filter(Boolean);
    if (!dates.length) return;
    let index = 0;
    const step = () => {
      day.value = dates[index++];
      void update();
      if (index === dates.length) stop();
    };
    play.textContent = 'Pause';
    timer = setInterval(step, 700);
    step();
  };
  element('global-reload').onclick = async () => {
    stop();
    try { await catalogRefresh(); await update(); }
    catch { status.textContent = 'Global catalog is unavailable.'; }
  };
  toggle.value = 'global';
  void toggle.onchange();
  return {
    refresh() { if (enabled) { stop(); void update(); } },
    async show(period) {
      const key = period.slice(0, 7);
      toggle.value = 'global';
      if (!enabled || !catalog) await toggle.onchange();
      if (!archiveMonths.includes(key)) return false;
      year.value = key.slice(0, 4);
      refreshMonths();
      month.value = key;
      if (!await update(true)) return false;
      if (period.length === 10) {
        if (![...day.options].some(option => option.value === period)) return false;
        day.value = period;
        return Boolean(await update());
      }
      return true;
    },
    stop,
  };
}
