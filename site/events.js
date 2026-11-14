window.setupFireEvents = function ({ drawGlobal, fitRegion, resize, archive }) {
  const panel = element('event-playback');
  const frame = element('event-frame');
  const pause = element('event-pause');
  const globalControls = element('global-controls');
  const localControls = element('local-controls');
  let timer;
  let revision = 0;

  function exit() {
    revision++;
    clearInterval(timer);
    pause.hidden = true;
    if (panel.hidden) return;
    panel.hidden = true;
    const global = element('archive-scope').value === 'global';
    globalControls.hidden = !global;
    localControls.hidden = global;
    drawGlobal(null);
    if (global) archive.refresh();
    else void element('archive-scope').onchange();
  }

  element('event-exit').onclick = exit;

  async function open(event, playback) {
    exit();
    const request = revision;
    archive.stop();
    location.hash = 'explore';
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (request !== revision) return;
    panel.hidden = false;
    globalControls.hidden = localControls.hidden = true;
    element('map-period').textContent = event.title;
    frame.textContent = 'Loading event observations…';
    drawGlobal([]);
    resize();
    const [west, south, east, north] = event.bounds;
    fitRegion({ west, south, east, north });
    try {
      const response = await fetch('/api/events/' + event.id);
      if (!response.ok) throw Error('Event data unavailable');
      const observations = await response.json();
      if (request !== revision) return;
      const dates = Object.keys(observations).filter(date => playback ? date < event.date : date === event.date).sort();
      let index = 0;
      function tick() {
        const date = dates[index++];
        if (!date) return;
        const data = observations[date];
        const cells = [];
        for (const [sensor, values] of Object.entries(data ?? {})) {
          for (const [x, y, count] of values) {
            cells.push({ x, y, offset: 0, MODIS: sensor === 'MODIS' ? count : 0, VIIRS: sensor === 'VIIRS' ? count : 0 });
          }
        }
        drawGlobal(cells);
        const total = cells.reduce((sum, cell) => sum + cell.MODIS + cell.VIIRS, 0);
        element('map-period').textContent = event.title + ' · ' + dayName(date);
        frame.textContent = (playback ? 'Day ' + index + '/' + dates.length + ' · ' : '') +
          dayName(date) + ' UTC · ' + (data ? number.format(total) + ' regional detections (' +
            Object.keys(data).join(' + ') + ')' : 'Observation data unavailable');
        if (index >= dates.length) {
          clearInterval(timer);
          pause.hidden = true;
        }
      }
      if (playback && dates.length > 1) {
        pause.hidden = false;
        pause.textContent = 'Pause';
        timer = setInterval(tick, 650);
        pause.onclick = () => {
          if (pause.textContent === 'Pause') {
            clearInterval(timer);
            pause.textContent = 'Resume';
          } else {
            timer = setInterval(tick, 650);
            pause.textContent = 'Pause';
          }
        };
      }
      tick();
    } catch {
      if (request === revision) frame.textContent = 'Event observations could not be loaded.';
    }
  }

  fetch('/events.json').then(response => {
    if (!response.ok) throw Error('Event catalog unavailable');
    return response.json();
  }).then(events => {
    for (const event of events) {
      const card = document.createElement('article');
      card.className = 'panel event-card';
      const title = document.createElement('h2');
      title.textContent = event.title;
      const details = document.createElement('p');
      details.className = 'event-meta';
      details.textContent = event.region + ' · ' + dayName(event.date);
      const story = document.createElement('p');
      story.textContent = event.story;
      const actions = document.createElement('div');
      actions.className = 'event-actions';
      for (const [label, playback] of [['Open on map', false], ['Play previous 30 days', true]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.onclick = () => void open(event, playback);
        actions.append(button);
      }
      const source = document.createElement('a');
      source.href = event.source;
      source.textContent = 'NASA event story ↗';
      card.append(details, title, story, actions, source);
      element('event-list').append(card);
    }
  }).catch(() => { element('events-status').textContent = 'Events could not be loaded.'; });
  return exit;
};
