(() => {
  const byId = id => document.getElementById(id);
  const panel = byId('assistant-panel');
  const open = byId('assistant-open');
  const input = byId('assistant-input');
  const log = byId('assistant-log');
  const form = byId('assistant-form');
  const history = [];
  let lastPlace;
  let busy = false;

  function toggle(visible) {
    panel.hidden = !visible;
    open.hidden = visible;
    open.setAttribute('aria-expanded', visible);
    (visible ? input : open).focus();
  }

  function append(text, kind) {
    const entry = document.createElement('p');
    entry.className = 'assistant-' + kind;
    entry.dir = 'auto';
    entry.textContent = text;
    log.append(entry);
    log.scrollTop = log.scrollHeight;
    return entry;
  }

  function evidenceText(data, place, arabic) {
    const counts = new Intl.NumberFormat(arabic ? 'ar-EG' : 'en-US');
    const rows = Object.entries(data.sensors);
    const lines = rows.map(([sensor, record]) => arabic
      ? sensor + ': ' + counts.format(record.detections) + ' رصد، خلال ' + counts.format(record.reported_days) + ' يوم فيه بيانات عالمية (' + record.first + ' إلى ' + record.last + ').'
      : sensor + ': ' + counts.format(record.detections) + ' detections across ' + counts.format(record.reported_days) + ' globally reported days (' + record.first + ' to ' + record.last + ').');
    const placeLabel = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
    const grid = '(' + data.south + '°, ' + data.west + '°)';
    return [
      placeLabel + ' · ' + (arabic ? 'خلية ١° × ١°' : '1° grid cell') + ' ' + grid,
      ...(lines.length ? lines : [arabic ? 'مفيش ملخصات أرشيفية متاحة للفترة المطلوبة.' : 'No archive summaries are available for that period.']),
      data.partial ? (arabic ? 'فهرسة الأرشيف لسه مش مكتملة.' : 'The global index is still partial.') : '',
      arabic ? 'الرصد مؤشر للمراجعة، وقرار موقع المصنع يحتاج تقييم مخاطر الحريق والطقس المحلي.' :
        'Use this as a screening input alongside local fire hazard and weather assessments.',
    ].filter(Boolean).join('\n');
  }

  async function ask(message) {
    if (busy || !message) return;
    busy = true;
    const submit = form.querySelector('button');
    submit.disabled = true;
    append(message, 'user');
    panel.querySelector('.assistant-suggestions').hidden = true;
    const pending = append('', 'reply');
    pending.classList.add('assistant-typing');
    pending.setAttribute('aria-label', 'Thinking');
    for (let i = 0; i < 3; i++) pending.append(document.createElement('i'));
    const arabic = /[\u0600-\u06ff]/.test(message);
    try {
      const response = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history: history.slice(-6),
          view: { ...window.emberAssistantMap?.view(), lastPlace } }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      let reply = result.reply;
      if (result.notice) reply += '\n' + result.notice;
      if (result.evidence) reply += '\n\n' + evidenceText(result.evidence, result.place, arabic);
      if (result.action) {
        let opened = false;
        try { opened = await window.emberAssistantMap?.show(result.action); } catch { /* Map did not open. */ }
        if (opened) lastPlace = result.action.place?.name;
        reply += '\n' + (opened
          ? (arabic ? 'فتحت الفترة على الخريطة.' : 'Opened on the map.')
          : (arabic ? 'الفترة دي مش متاحة في العرض الحالي أو الخريطة لسه بتحمّل.' : 'That date is unavailable in this view, or the map is still loading.'));
      }
      pending.textContent = reply;
      history.push({ role: 'user', text: message }, { role: 'model', text: reply });
      if (history.length > 6) history.splice(0, history.length - 6);
    } catch (error) {
      pending.textContent = error.message || 'Assistant unavailable.';
    } finally {
      pending.classList.remove('assistant-typing');
      pending.removeAttribute('aria-label');
      busy = false;
      submit.disabled = false;
      log.scrollTop = log.scrollHeight;
    }
  }

  open.onclick = () => {
    toggle(true);
    if (!log.children.length) append('I can open dates on the globe, explain data coverage, and check archived fire activity near a place.', 'reply');
  };
  byId('assistant-close').onclick = () => toggle(false);
  panel.onkeydown = event => { if (event.key === 'Escape') toggle(false); };
  form.onsubmit = event => {
    event.preventDefault();
    if (busy) return;
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    void ask(message);
  };
  for (const shortcut of panel.querySelectorAll('[data-question]')) {
    shortcut.onclick = () => void ask(shortcut.dataset.question);
  }
})();
