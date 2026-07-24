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
  matchTabs: [...document.querySelectorAll('.match-tab')],
  tabStatuses: [...document.querySelectorAll('[data-tab-status]')],
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
  drawerBackdrop: document.querySelector('#drawerBackdrop'),
  nicknameInput: document.querySelector('#nicknameInput'),
  nicknameHint: document.querySelector('#nicknameHint'),
  leaderboardBody: document.querySelector('#leaderboardBody'),
  leaderboardStatus: document.querySelector('#leaderboardStatus')
};

let game = null;
let activeGameIndex = 0;
let countdownTimer = null;
let leaderboardPollTimer = null;
let leaderboardSource = null;

const numberFormatter = new Intl.NumberFormat('ru-RU');
const PARTICIPANT_KEY = 'dota-guess-participant-id';
const NICKNAME_KEY = 'dota-guess-nickname';
const LEADERBOARD_RESET_KEY = 'dota-guess-leaderboard-reset-at';

function getParticipantId() {
  let value = localStorage.getItem(PARTICIPANT_KEY);
  if (value) return value;
  value = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 18)}`;
  localStorage.setItem(PARTICIPANT_KEY, value);
  return value;
}

const participantId = getParticipantId();
elements.nicknameInput.value = localStorage.getItem(NICKNAME_KEY) || '';

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

function currentGame() {
  return game?.games?.[activeGameIndex] || null;
}

function isValidDailyGamePayload(dailyGame) {
  const match = dailyGame?.match;
  return Boolean(
    dailyGame &&
    Number.isFinite(Number(dailyGame.slot)) &&
    typeof dailyGame.gameToken === 'string' &&
    dailyGame.player &&
    Number.isFinite(Number(dailyGame.player.accountId)) &&
    typeof dailyGame.player.name === 'string' &&
    match &&
    typeof match === 'object' &&
    typeof match.gameMode === 'string' &&
    Number.isFinite(Number(match.duration)) &&
    Array.isArray(match.team) &&
    match.team.length > 0 &&
    Array.isArray(match.opponents) &&
    match.opponents.length > 0
  );
}

function renderTeams(dailyGame) {
  elements.allyTeam.replaceChildren(
    ...dailyGame.match.team.map((player) => renderCard(player, 'ally'))
  );
  elements.enemyTeam.replaceChildren(
    ...dailyGame.match.opponents.map((player) => renderCard(player, 'enemy'))
  );
}

function itemMarkup(item, emptyLabel = 'пусто') {
  if (!item) {
    return `<div class="item-wrap"><div class="item-slot empty" aria-label="${escapeHtml(emptyLabel)}"></div><span class="item-caption">${escapeHtml(emptyLabel)}</span></div>`;
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

function resultStorageKey(dateKey, slot) {
  return `dota-guess-result:${dateKey}:${slot}`;
}

function getSavedResult(dailyGame) {
  const raw = localStorage.getItem(resultStorageKey(game.dateKey, dailyGame.slot));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    localStorage.removeItem(resultStorageKey(game.dateKey, dailyGame.slot));
    return null;
  }
}

function renderTabStates() {
  game.games.forEach((dailyGame, index) => {
    const saved = getSavedResult(dailyGame);
    const tab = elements.matchTabs[index];
    const status = elements.tabStatuses[index];
    tab.classList.toggle('active', index === activeGameIndex);
    tab.classList.toggle('correct', Boolean(saved?.correct));
    tab.classList.toggle('wrong', Boolean(saved && !saved.correct));
    status.textContent = saved ? (saved.correct ? 'угадано' : 'ошибка') : 'не сыгран';
  });
}

function renderResult(result, dailyGame, persist = true) {
  if (persist) {
    localStorage.setItem(resultStorageKey(game.dateKey, dailyGame.slot), JSON.stringify(result));
  }

  elements.guessSection.classList.add('hidden');
  elements.resultPanel.classList.remove('hidden', 'correct', 'wrong');
  elements.resultPanel.classList.add(result.correct ? 'correct' : 'wrong');
  elements.resultSymbol.textContent = result.correct ? '✓' : '×';
  elements.resultEyebrow.textContent = result.correct ? 'Точный прогноз' : 'Не угадали';
  elements.resultTitle.textContent = result.correct ? 'Верно!' : 'В этот раз мимо';
  const actualText = result.actual === 'win' ? 'победил' : 'проиграл';
  const duplicateText = result.alreadySubmitted ? ' Этот ответ уже был учтён ранее.' : '';
  elements.resultText.textContent = `${dailyGame.player.name} ${actualText}.${duplicateText} Второй матч доступен во вкладке выше.`;
  elements.openDotaLink.href = result.links.openDota;
  elements.stratzLink.href = result.links.stratz;
  renderTabStates();
}

function renderActiveGame() {
  const dailyGame = currentGame();
  if (!isValidDailyGamePayload(dailyGame)) {
    throw new Error('Сервер вернул матч в устаревшем формате. Выполните новый деплой версии 2.2.');
  }

  renderPlayerChip(dailyGame.player);
  elements.gameMode.textContent = dailyGame.match.gameMode;
  elements.duration.textContent = formatDuration(dailyGame.match.duration);
  renderTeams(dailyGame);
  elements.resultPanel.classList.add('hidden', 'correct', 'wrong');
  elements.guessSection.classList.remove('hidden');
  elements.guessButtons.forEach((button) => { button.disabled = false; });

  const saved = getSavedResult(dailyGame);
  if (saved) renderResult(saved, dailyGame, false);
  renderTabStates();
}

function validateNickname() {
  const nickname = elements.nicknameInput.value.replace(/\s+/g, ' ').trim();
  if (nickname.length < 2 || nickname.length > 24) {
    elements.nicknameFieldError = true;
    elements.nicknameInput.classList.add('invalid');
    elements.nicknameHint.textContent = 'Введите от 2 до 24 символов, чтобы ответ попал в лидерборд.';
    elements.nicknameInput.focus();
    return null;
  }
  elements.nicknameInput.classList.remove('invalid');
  elements.nicknameHint.textContent = 'Имя сохраняется в этом браузере.';
  localStorage.setItem(NICKNAME_KEY, nickname);
  return nickname;
}

async function submitGuess(guess) {
  const nickname = validateNickname();
  if (!nickname) return;

  const dailyGame = currentGame();
  elements.guessButtons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api('/api/game/guess', {
      method: 'POST',
      body: JSON.stringify({
        dateKey: game.dateKey,
        slot: dailyGame.slot,
        token: dailyGame.gameToken,
        guess,
        participantId,
        nickname
      })
    });
    renderResult(result, dailyGame);
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

function clearSavedMatchResults() {
  const keys = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith('dota-guess-result:')) keys.push(key);
  }
  keys.forEach((key) => localStorage.removeItem(key));
}

function handleLeaderboardPayload(payload) {
  const resetAt = payload?.resetAt || null;
  const knownResetAt = localStorage.getItem(LEADERBOARD_RESET_KEY);
  if (resetAt && resetAt !== knownResetAt) {
    clearSavedMatchResults();
    localStorage.setItem(LEADERBOARD_RESET_KEY, resetAt);
    if (game) renderActiveGame();
  }
  renderLeaderboard(payload?.entries || []);
}

function renderLeaderboard(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    elements.leaderboardBody.innerHTML = '<tr><td colspan="4" class="leaderboard-empty">Пока нет ответов. Станьте первым.</td></tr>';
    return;
  }

  elements.leaderboardBody.innerHTML = entries.map((entry) => `
    <tr>
      <td><span class="leaderboard-rank">${escapeHtml(entry.rank)}</span></td>
      <td><strong>${escapeHtml(entry.name)}</strong></td>
      <td class="leaderboard-wins">${escapeHtml(entry.wins)}</td>
      <td>${escapeHtml(entry.attempts)}</td>
    </tr>
  `).join('');
}

async function loadLeaderboard() {
  try {
    const data = await api('/api/leaderboard');
    handleLeaderboardPayload(data);
    elements.leaderboardStatus.textContent = 'Лидерборд обновлён';
  } catch {
    elements.leaderboardStatus.textContent = 'Не удалось обновить лидерборд';
  }
}

function connectLeaderboard() {
  loadLeaderboard();
  if (!('EventSource' in window)) {
    leaderboardPollTimer = setInterval(loadLeaderboard, 10_000);
    return;
  }

  leaderboardSource?.close();
  leaderboardSource = new EventSource('/api/leaderboard/stream');
  const source = leaderboardSource;
  source.addEventListener('open', () => {
    elements.leaderboardStatus.textContent = 'Онлайн-обновление активно';
  });
  source.addEventListener('leaderboard', (event) => {
    try {
      const data = JSON.parse(event.data);
      handleLeaderboardPayload(data);
      elements.leaderboardStatus.textContent = 'Онлайн-обновление активно';
    } catch {
      elements.leaderboardStatus.textContent = 'Получены некорректные данные';
    }
  });
  source.addEventListener('error', () => {
    elements.leaderboardStatus.textContent = 'Переподключение к лидерборду…';
  });
}

async function loadGame() {
  setState('loading');
  closeDrawer();
  try {
    game = await api('/api/game');
    if (
      game?.schemaVersion !== 4 ||
      !Array.isArray(game.games) ||
      game.games.length !== 2 ||
      !game.games.every(isValidDailyGamePayload)
    ) {
      throw new Error('Сервер вернул устаревшие данные. Выполните полный деплой версии 2.2.');
    }
    activeGameIndex = 0;
    renderActiveGame();
    startCountdown(game.nextResetAt);
    setState('content');
  } catch (error) {
    setState('error', error.message);
  }
}

elements.retryButton.addEventListener('click', loadGame);
elements.guessButtons.forEach((button) => {
  button.addEventListener('click', () => submitGuess(button.dataset.guess));
});
elements.matchTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    activeGameIndex = Number(tab.dataset.matchIndex) || 0;
    closeDrawer();
    renderActiveGame();
  });
});
elements.nicknameInput.addEventListener('input', () => {
  const value = elements.nicknameInput.value.replace(/\s+/g, ' ').trim();
  if (value.length >= 2 && value.length <= 24) {
    elements.nicknameInput.classList.remove('invalid');
    elements.nicknameHint.textContent = 'Имя сохраняется в этом браузере.';
    localStorage.setItem(NICKNAME_KEY, value);
  }
});
elements.drawerClose.addEventListener('click', closeDrawer);
elements.drawerBackdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});
window.addEventListener('beforeunload', () => {
  clearInterval(leaderboardPollTimer);
  leaderboardSource?.close();
});

loadGame();
connectLeaderboard();
