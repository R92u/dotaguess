const elements = {
  gamePanel: document.querySelector('#gamePanel'),
  loadingState: document.querySelector('#loadingState'),
  errorState: document.querySelector('#errorState'),
  errorText: document.querySelector('#errorText'),
  retryButton: document.querySelector('#retryButton'),
  gameContent: document.querySelector('#gameContent'),
  playerChip: document.querySelector('#playerChip'),
  gameMode: document.querySelector('#gameMode'),
  duration: document.querySelector('#duration'),
  allyTeam: document.querySelector('#allyTeam'),
  enemyTeam: document.querySelector('#enemyTeam'),
  cardTemplate: document.querySelector('#playerCardTemplate'),
  guessSection: document.querySelector('#guessSection'),
  guessButtons: [...document.querySelectorAll('.guess-button')],
  resultPanel: document.querySelector('#resultPanel'),
  resultSymbol: document.querySelector('#resultSymbol'),
  resultEyebrow: document.querySelector('#resultEyebrow'),
  resultTitle: document.querySelector('#resultTitle'),
  resultText: document.querySelector('#resultText'),
  openDotaLink: document.querySelector('#openDotaLink'),
  stratzLink: document.querySelector('#stratzLink'),
  countdown: document.querySelector('#countdown'),
  drawer: document.querySelector('#playerDrawer'),
  drawerContent: document.querySelector('#drawerContent'),
  drawerClose: document.querySelector('#drawerClose'),
  drawerBackdrop: document.querySelector('#drawerBackdrop')
};

let game = null;
let countdownTimer = null;

const numberFormatter = new Intl.NumberFormat('ru-RU');

function formatDuration(seconds) {
  const total = Number(seconds) || 0;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatNumber(value) {
  return numberFormatter.format(Number(value) || 0);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setState(name, message = '') {
  elements.loadingState.classList.toggle('hidden', name !== 'loading');
  elements.errorState.classList.toggle('hidden', name !== 'error');
  elements.gameContent.classList.toggle('hidden', name !== 'content');
  elements.gamePanel.setAttribute('aria-busy', String(name === 'loading'));
  if (message) elements.errorText.textContent = message;
}

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options?.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function renderPlayerChip(player) {
  elements.playerChip.classList.remove('loading-skeleton');
  elements.playerChip.innerHTML = `
    <div class="player-avatar" ${player.avatar ? `style="background-image:url('${escapeHtml(player.avatar)}')"` : ''}></div>
    <div>
      <span class="muted">Выбранный игрок · ID ${escapeHtml(player.accountId)}</span>
      <strong>${escapeHtml(player.name)}</strong>
    </div>
  `;
}

function renderCard(player, side) {
  const fragment = elements.cardTemplate.content.cloneNode(true);
  const card = fragment.querySelector('.player-card');
  card.classList.add(side === 'ally' ? 'ally-card' : 'enemy-card');
  if (player.isTarget) card.classList.add('target-card');

  const heroImage = fragment.querySelector('.hero-art');
  heroImage.src = player.hero.image || player.hero.icon || '';
  heroImage.alt = player.hero.name;
  heroImage.addEventListener('error', () => {
    heroImage.removeAttribute('src');
    heroImage.alt = `Изображение ${player.hero.name} недоступно`;
  });

  fragment.querySelector('.hero-name').textContent = player.hero.name;
  fragment.querySelector('.player-name').textContent = player.name;
  fragment.querySelector('.kills').textContent = player.kills;
  fragment.querySelector('.deaths').textContent = player.deaths;
  fragment.querySelector('.assists').textContent = player.assists;
  fragment.querySelector('.net-worth').textContent = `◉ ${formatNumber(player.netWorth)}`;
  fragment.querySelector('.rank').textContent = player.rank;
  fragment.querySelector('.level-badge').textContent = `LVL ${player.level}`;
  fragment.querySelector('.target-badge').classList.toggle('hidden', !player.isTarget);

  card.setAttribute('aria-label', `Открыть предметы: ${player.hero.name}, ${player.name}`);
  card.addEventListener('click', () => openDrawer(player));
  return fragment;
}

function renderTeams() {
  elements.allyTeam.replaceChildren(...game.match.team.map((player) => renderCard(player, 'ally')));
  elements.enemyTeam.replaceChildren(...game.match.opponents.map((player) => renderCard(player, 'enemy')));
}

function itemMarkup(item, emptyLabel = 'пусто') {
  if (!item) {
    return `<div class="item-wrap"><div class="item-slot empty" aria-label="${emptyLabel}"></div><span class="item-caption">${emptyLabel}</span></div>`;
  }
  return `
    <div class="item-wrap" title="${escapeHtml(item.name)}">
      <div class="item-slot">${item.image ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" loading="lazy">` : ''}</div>
      <span class="item-caption">${escapeHtml(item.name)}</span>
    </div>`;
}

function statBox(label, value) {
  return `<div class="stat-box"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function openDrawer(player) {
  const mainItems = [...player.items];
  while (mainItems.length < 6) mainItems.push(null);
  const backpack = [...player.backpack];
  while (backpack.length < 3) backpack.push(null);

  elements.drawerContent.innerHTML = `
    <div class="drawer-hero">
      ${player.hero.image ? `<img src="${escapeHtml(player.hero.image)}" alt="${escapeHtml(player.hero.name)}">` : ''}
    </div>
    <div class="drawer-title">
      <span class="meta-label">${player.isTarget ? '<span class="drawer-target">Игрок дня</span>' : escapeHtml(player.rank)}</span>
      <h2>${escapeHtml(player.hero.name)}</h2>
      <p>${escapeHtml(player.name)} · ${escapeHtml(player.lane)}</p>
    </div>
    <div class="stat-grid">
      ${statBox('У / С / П', `${player.kills} / ${player.deaths} / ${player.assists}`)}
      ${statBox('Ценность', formatNumber(player.netWorth))}
      ${statBox('Уровень', player.level)}
      ${statBox('GPM / XPM', `${player.gpm} / ${player.xpm}`)}
      ${statBox('Доб. / Отр.', `${player.lastHits} / ${player.denies}`)}
      ${statBox('Урон героям', formatNumber(player.heroDamage))}
      ${statBox('Урон строениям', formatNumber(player.towerDamage))}
      ${statBox('Лечение', formatNumber(player.heroHealing))}
      ${statBox('Ранг', player.rank)}
    </div>
    <div class="drawer-section">
      <h3>Основные предметы</h3>
      <div class="items-grid">${mainItems.map((item) => itemMarkup(item)).join('')}</div>
    </div>
    <div class="drawer-section">
      <h3>Рюкзак</h3>
      <div class="items-grid">${backpack.map((item) => itemMarkup(item)).join('')}</div>
    </div>
    <div class="drawer-section">
      <h3>Нейтральный предмет</h3>
      <div class="neutral-row">
        ${itemMarkup(player.neutral, 'нет предмета')}
        <div class="neutral-copy">Предметы показаны в состоянии на момент окончания матча.</div>
      </div>
    </div>
  `;

  elements.drawer.classList.add('open');
  elements.drawer.setAttribute('aria-hidden', 'false');
  elements.drawerBackdrop.classList.remove('hidden');
  document.body.classList.add('drawer-open');
  elements.drawerClose.focus();
}

function closeDrawer() {
  elements.drawer.classList.remove('open');
  elements.drawer.setAttribute('aria-hidden', 'true');
  elements.drawerBackdrop.classList.add('hidden');
  document.body.classList.remove('drawer-open');
}

function resultStorageKey(dateKey) {
  return `dota-guess-result:${dateKey}`;
}

function renderResult(result, persist = true) {
  if (persist) localStorage.setItem(resultStorageKey(game.dateKey), JSON.stringify(result));

  elements.guessSection.classList.add('hidden');
  elements.resultPanel.classList.remove('hidden', 'correct', 'wrong');
  elements.resultPanel.classList.add(result.correct ? 'correct' : 'wrong');
  elements.resultSymbol.textContent = result.correct ? '✓' : '×';
  elements.resultEyebrow.textContent = result.correct ? 'Точный прогноз' : 'Не угадали';
  elements.resultTitle.textContent = result.correct ? 'Верно!' : 'В этот раз мимо';
  const actualText = result.actual === 'win' ? 'победил' : 'проиграл';
  elements.resultText.textContent = `Выбранный игрок ${actualText}. Завтра в 00:00 МСК появится новый матч.`;
  elements.openDotaLink.href = result.links.openDota;
  elements.stratzLink.href = result.links.stratz;
}

async function submitGuess(guess) {
  elements.guessButtons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api('/api/game/guess', {
      method: 'POST',
      body: JSON.stringify({ dateKey: game.dateKey, token: game.gameToken, guess })
    });
    renderResult(result);
  } catch (error) {
    alert(error.message);
    elements.guessButtons.forEach((button) => { button.disabled = false; });
  }
}

function startCountdown(nextResetAt) {
  clearInterval(countdownTimer);
  const target = new Date(nextResetAt).getTime();
  const update = () => {
    const remaining = Math.max(0, target - Date.now());
    const hours = Math.floor(remaining / 3_600_000);
    const minutes = Math.floor((remaining % 3_600_000) / 60_000);
    const seconds = Math.floor((remaining % 60_000) / 1000);
    elements.countdown.textContent = [hours, minutes, seconds]
      .map((value) => String(value).padStart(2, '0'))
      .join(':');
    if (remaining <= 0) location.reload();
  };
  update();
  countdownTimer = setInterval(update, 1000);
}

async function loadGame() {
  setState('loading');
  closeDrawer();
  try {
    game = await api('/api/game');
    renderPlayerChip(game.player);
    elements.gameMode.textContent = game.match.gameMode;
    elements.duration.textContent = formatDuration(game.match.duration);
    renderTeams();
    startCountdown(game.nextResetAt);

    elements.resultPanel.classList.add('hidden');
    elements.guessSection.classList.remove('hidden');
    elements.guessButtons.forEach((button) => { button.disabled = false; });
    const saved = localStorage.getItem(resultStorageKey(game.dateKey));
    if (saved) {
      try { renderResult(JSON.parse(saved), false); } catch { localStorage.removeItem(resultStorageKey(game.dateKey)); }
    }

    setState('content');
  } catch (error) {
    setState('error', error.message);
  }
}

elements.retryButton.addEventListener('click', loadGame);
elements.guessButtons.forEach((button) => {
  button.addEventListener('click', () => submitGuess(button.dataset.guess));
});
elements.drawerClose.addEventListener('click', closeDrawer);
elements.drawerBackdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});

loadGame();
