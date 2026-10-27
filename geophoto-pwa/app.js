/**
 * app.js — основная логика PWA GeoPhoto.
 *
 * Экраны: главный (камера + галерея), просмотр/редактирование фото, настройки.
 * Все сетевые запросы идут через PairingManager.apiRequest().
 */

const state = {
    db: null,
    logger: null,
    pairing: null,
    photos: [],
    locationsCache: [],
    selectedId: null,
    currentPhotoId: null,
    galleryCollapsed: false,
    processingQueue: false,
    toastTimer: null
};

const els = {};
const STATUS_LABELS = {
    pending: 'В очереди',
    sent: 'Отправлено',
    error: 'Ошибка'
};

document.addEventListener('DOMContentLoaded', () => {
    init().catch((err) => {
        console.error('Ошибка инициализации', err);
        showToast('Не удалось запустить приложение');
    });
});

async function init() {
    cacheElements();

    state.db = new GeoPhotoDB();
    await state.db.open();
    state.logger = new Logger(state.db);
    state.pairing = new PairingManager(state.db, state.logger);

    bindEvents();
    if (els.appVersion) els.appVersion.textContent = Logger.APP_VERSION;
    await refreshGallery();
    await renderSettings();
    await renderLocationsDatalist();

    await state.logger.info('Приложение запущено', {
        appVersion: Logger.APP_VERSION,
        paired: state.pairing.isPaired()
    });

    registerServiceWorker();

    // Автосинхронизация и отправка очереди не должны блокировать первый рендер.
    setTimeout(async () => {
        if (state.pairing.isPaired() && navigator.onLine) {
            // При запуске сразу проверяем, не изменилась ли SQL-база на сервере.
            await syncNow({ silent: true });
        } else {
            const result = await state.pairing.autoSyncIfDue();
            if (result) {
                await renderSettings();
                await renderLocationsDatalist();
                if (result.locationsChanged) {
                    showToast(`База обновлена: ${result.locationsUpdated} локаций`);
                }
            }
        }
        await processQueue();
    }, 1000);
}

// --------------------------------------------------------------- элементы

function cacheElements() {
    const ids = [
        'screen-main', 'btn-send-selected', 'queue-badge', 'btn-settings',
        'selected-block', 'selected-img', 'selected-name', 'selected-status', 'btn-clear-selection',
        'camera-area', 'camera-input', 'btn-gallery-toggle', 'gallery-wrap', 'gallery', 'gallery-empty',
        'screen-photo', 'btn-photo-back', 'btn-photo-delete', 'photo-preview', 'photo-gps',
        'photo-city', 'photo-address', 'cities-list', 'addresses-list', 'photo-name',
        'photo-status', 'photo-level', 'btn-photo-send',
        'screen-settings', 'btn-settings-back', 'server-url', 'token-input', 'device-name',
        'btn-pair', 'btn-unpair', 'pairing-status', 'compression-level', 'compression-info',
        'autosync-enabled', 'last-sync', 'locations-count', 'btn-sync-now',
        'logs-count', 'btn-view-logs', 'btn-clear-logs', 'queue-count',
        'app-version', 'btn-check-update', 'update-status',
        'logs-modal', 'btn-logs-close', 'logs-list', 'toast'
    ];

    for (const id of ids) {
        const key = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        els[key] = document.getElementById(id);
    }
}

function bindEvents() {
    // Главный экран
    els.cameraArea.addEventListener('click', () => els.cameraInput.click());
    els.cameraInput.addEventListener('change', onCameraInputChange);
    els.btnSettings.addEventListener('click', () => openSettings());
    els.btnSendSelected.addEventListener('click', () => sendSelected());
    els.btnClearSelection.addEventListener('click', clearSelection);
    els.btnGalleryToggle.addEventListener('click', toggleGallery);
    bindGalleryEvents();

    // Экран фото
    els.btnPhotoBack.addEventListener('click', closePhotoScreen);
    els.btnPhotoDelete.addEventListener('click', deleteCurrentPhoto);
    els.btnPhotoSend.addEventListener('click', sendCurrentPhoto);
    els.photoCity.addEventListener('input', () => {
        renderAddressOptions(els.photoCity.value.trim());
    });
    els.photoAddress.addEventListener('change', () => {
        saveCurrentPhotoAddress().then(() => refreshGallery()).catch((err) => {
            console.warn('Не удалось сохранить адрес', err);
        });
    });

    // Настройки
    els.btnSettingsBack.addEventListener('click', () => showScreen('screen-main'));
    els.btnPair.addEventListener('click', pairDevice);
    els.btnUnpair.addEventListener('click', unpairDevice);
    els.compressionLevel.addEventListener('change', onCompressionChange);
    els.autosyncEnabled.addEventListener('change', onAutoSyncChange);
    els.btnSyncNow.addEventListener('click', () => syncNow());
    els.btnViewLogs.addEventListener('click', openLogs);
    els.btnClearLogs.addEventListener('click', clearLogs);
    els.btnCheckUpdate.addEventListener('click', () => checkForUpdate());
    els.btnLogsClose.addEventListener('click', closeLogs);
    els.logsModal.addEventListener('click', (event) => {
        if (event.target === els.logsModal) closeLogs();
    });

    // Сеть
    window.addEventListener('online', () => {
        showToast('Соединение восстановлено');
        if (state.pairing.isPaired()) {
            // При первом же подключении к сети забираем актуальную SQL-базу.
            syncNow({ silent: true }).catch(() => {});
        }
        processQueue();
    });
    window.addEventListener('offline', () => showToast('Нет сети — фото будут отправлены позже'));

    document.addEventListener('visibilitychange', () => {
        if (document.hidden || !navigator.onLine || !state.pairing.isPaired()) return;
        syncNow({ silent: true }).catch(() => {});
    });
}

// ------------------------------------------------------------- навигация

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach((screen) => {
        screen.classList.toggle('active', screen.id === screenId);
    });
    window.scrollTo(0, 0);
}

function openSettings() {
    renderSettings()
        .then(renderLocationsDatalist)
        .catch((err) => console.warn('Ошибка настроек', err));
    showScreen('screen-settings');
}

// -------------------------------------------------------------- галерея

async function refreshGallery() {
    state.photos = await state.db.getAllPhotos();
    const gallery = els.gallery;
    gallery.textContent = '';

    for (const photo of state.photos) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'gallery-item';
        item.dataset.photoId = photo.id;
        item.title = photoLabel(photo);
        if (photo.id === state.selectedId) item.classList.add('selected');

        const img = document.createElement('img');
        img.src = photo.dataUrl;
        img.alt = photoLabel(photo);
        img.loading = 'lazy';

        const dot = document.createElement('span');
        dot.className = `status-dot ${photo.status || 'pending'}`;

        item.appendChild(img);
        item.appendChild(dot);
        gallery.appendChild(item);
    }

    els.galleryEmpty.classList.toggle('hidden', state.photos.length > 0);
    updateQueueBadge();
    renderSelected();

    if (state.currentPhotoId) {
        updatePhotoStatusView();
    }
}

function bindGalleryEvents() {
    let pressTimer = null;
    let longPressFired = false;

    const clearPress = () => {
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }
    };

    els.gallery.addEventListener('pointerdown', (event) => {
        const item = event.target.closest('.gallery-item');
        if (!item) return;
        longPressFired = false;
        clearPress();
        pressTimer = setTimeout(() => {
            longPressFired = true;
            openPhotoScreen(item.dataset.photoId);
        }, 650);
    });

    ['pointerup', 'pointerleave', 'pointercancel'].forEach((type) => {
        els.gallery.addEventListener(type, clearPress);
    });

    els.gallery.addEventListener('click', (event) => {
        const item = event.target.closest('.gallery-item');
        if (!item) return;
        if (longPressFired) {
            longPressFired = false;
            return;
        }
        selectPhoto(item.dataset.photoId).catch((err) => console.warn('Ошибка выбора фото', err));
    });
}

async function selectPhoto(photoId) {
    const photo = state.photos.find((item) => item.id === photoId) || await state.db.getPhoto(photoId);
    if (!photo) return;

    state.selectedId = photo.id;
    els.gallery.querySelectorAll('.gallery-item').forEach((item) => {
        item.classList.toggle('selected', item.dataset.photoId === photo.id);
    });
    renderSelected();
}

function clearSelection() {
    state.selectedId = null;
    els.gallery.querySelectorAll('.gallery-item').forEach((item) => item.classList.remove('selected'));
    renderSelected();
}

function renderSelected() {
    const photo = state.photos.find((item) => item.id === state.selectedId);
    if (!photo) {
        els.selectedBlock.classList.add('hidden');
        return;
    }

    els.selectedBlock.classList.remove('hidden');
    els.selectedImg.src = photo.dataUrl;
    els.selectedName.textContent = photoLabel(photo);
    applyStatus(els.selectedStatus, photo.status);
}

function updateQueueBadge() {
    const queueLength = state.photos.filter((photo) => photo.status !== 'sent').length;
    els.queueBadge.textContent = String(queueLength);
    els.queueBadge.classList.toggle('hidden', queueLength === 0);
    els.queueCount.textContent = `Фото в очереди: ${queueLength}`;
}

function toggleGallery() {
    state.galleryCollapsed = !state.galleryCollapsed;
    els.galleryWrap.classList.toggle('collapsed', state.galleryCollapsed);
    els.btnGalleryToggle.textContent = state.galleryCollapsed ? 'Развернуть' : 'Свернуть';
}

// ---------------------------------------------------------------- камера

async function onCameraInputChange(event) {
    const file = event.target.files && event.target.files[0];
    // Сбрасываем input, чтобы можно было выбрать тот же файл ещё раз.
    event.target.value = '';
    if (!file) return;

    try {
        await handleNewPhoto(file);
    } catch (err) {
        console.error('Ошибка обработки фото', err);
        await state.logger.error('Ошибка обработки фото', { message: err.message });
        showToast('Не удалось обработать фото');
    }
}

async function handleNewPhoto(file) {
    showToast('Обрабатываем фото…');

    const { gps, exifBinary } = await ExifReader.readFromFile(file);
    const originalDataUrl = await fileToDataUrl(file);
    const dataUrl = await PhotoCompressor.compress(originalDataUrl, exifBinary);

    // HEIC/PNG в режиме "original" перекодируются в JPEG — фиксируем фактический уровень.
    const requestedLevel = PhotoCompressor.getLevel();
    const compressionLevel = (requestedLevel === 'original' && !originalDataUrl.startsWith('data:image/jpeg'))
        ? 'high'
        : requestedLevel;

    let city = '';
    let address = '';
    let name = '';
    let match = null;
    if (gps) {
        match = await state.db.findNearestLocation(gps.lat, gps.lon);
        if (match) {
            city = match.location.city || '';
            address = formatAddressSide(match.location);
            name = match.location.name || '';
        }
    }

    const photo = {
        id: `photo_${Date.now()}`,
        dataUrl,
        gps,
        name,
        city,
        address,
        status: 'pending',
        timestamp: Date.now(),
        compressionLevel
    };

    await state.db.putPhoto(photo);

    await state.logger.info('Фото добавлено', {
        photoId: photo.id,
        hasGps: Boolean(gps),
        name,
        city,
        address,
        distance: match ? Math.round(match.distance) : null,
        size: PhotoCompressor.dataUrlBytes(dataUrl),
        compressionLevel
    });

    await refreshGallery();
    await selectPhoto(photo.id);

    if (!gps) {
        showToast('GPS не найден — выберите город и адрес вручную');
    } else if (!address) {
        showToast('Адрес не найден — выберите вручную');
    } else {
        showToast(`Найдено: ${[city, address].filter(Boolean).join(', ')}`);
    }
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
        reader.readAsDataURL(file);
    });
}

// -------------------------------------------------------------- отправка

async function sendSelected() {
    const photo = state.photos.find((item) => item.id === state.selectedId);
    if (!photo) {
        showToast('Сначала выберите фото');
        return;
    }

    if (!photo.address) {
        openPhotoScreen(photo.id);
        showToast('Введите адрес перед отправкой');
        return;
    }

    await uploadOne(photo);
}

async function uploadOne(photo, options = {}) {
    const silent = Boolean(options.silent);

    if (!state.pairing.isPaired()) {
        if (!silent) {
            showToast('Сначала сопрягите устройство в настройках');
            openSettings();
        }
        return false;
    }

    if (!photo.address) {
        if (!silent) {
            showToast('Выберите адрес и сторону перед отправкой');
            openPhotoScreen(photo.id);
        }
        return false;
    }

    if (!navigator.onLine) {
        if (!silent) showToast('Нет сети — фото останется в очереди');
        return false;
    }

    try {
        const result = await state.pairing.uploadPhoto(photo);
        await state.db.updatePhoto(photo.id, {
            status: 'sent',
            sentAt: Date.now(),
            serverChecksum: result && result.checksum,
            name: (result && result.name) || photo.name || ''
        });
        await state.logger.info('Фото отправлено', {
            photoId: photo.id,
            name: (result && result.name) || photo.name || '',
            city: photo.city || '',
            address: photo.address,
            size: result && result.size
        });
        if (!silent) showToast('Фото отправлено');
        return true;
    } catch (err) {
        await state.db.updatePhoto(photo.id, {
            status: 'error',
            lastError: err.code || err.message
        });
        await state.logger.error('Ошибка отправки фото', {
            photoId: photo.id,
            code: err.code,
            message: err.message
        });
        if (!silent) {
            showToast(errorText(err));
            handleAuthError(err);
        }
        return false;
    } finally {
        await refreshGallery();
    }
}

async function processQueue() {
    if (state.processingQueue) return;
    if (!state.pairing.isPaired() || !navigator.onLine) return;

    state.processingQueue = true;
    try {
        const photos = await state.db.getAllPhotos();
        const queue = photos
            .filter((photo) => photo.status !== 'sent' && photo.address)
            .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        for (const photo of queue) {
            if (!navigator.onLine) break;
            const uploaded = await uploadOne(photo, { silent: true });
            if (!uploaded) break;
        }
    } catch (err) {
        console.warn('Очередь отправки остановлена', err);
    } finally {
        state.processingQueue = false;
        await refreshGallery();
    }
}

// ------------------------------------------------------- экран фото

async function openPhotoScreen(photoId) {
    const photo = await state.db.getPhoto(photoId);
    if (!photo) {
        showToast('Фото не найдено');
        return;
    }

    state.currentPhotoId = photo.id;
    els.photoPreview.src = photo.dataUrl;
    els.photoGps.textContent = photo.gps
        ? `${Number(photo.gps.lat).toFixed(5)}, ${Number(photo.gps.lon).toFixed(5)}`
        : 'GPS нет';
    els.photoCity.value = photo.city || '';
    els.photoAddress.value = photo.address || '';
    els.photoName.textContent = `Наименование: ${photo.name || '—'}`;

    if (state.locationsCache.length === 0) {
        state.locationsCache = await state.db.getAllLocations();
    }
    renderAddressOptions(photo.city || '');

    els.photoLevel.textContent = PhotoCompressor.getLevelConfig(photo.compressionLevel).label;
    applyStatus(els.photoStatus, photo.status);

    showScreen('screen-photo');
}

function updatePhotoStatusView() {
    const photo = state.photos.find((item) => item.id === state.currentPhotoId);
    if (!photo) return;
    applyStatus(els.photoStatus, photo.status);
    els.photoLevel.textContent = PhotoCompressor.getLevelConfig(photo.compressionLevel).label;
    if (els.photoName) els.photoName.textContent = `Наименование: ${photo.name || '—'}`;
}

async function saveCurrentPhotoAddress() {
    if (!state.currentPhotoId) return null;

    const photo = await state.db.getPhoto(state.currentPhotoId);
    if (!photo) return null;

    const city = els.photoCity.value.trim();
    const address = els.photoAddress.value.trim();

    // Имя берём из базы — колонка «Наименование» найденной локации.
    const match = findLocationByCityAddress(city, address);
    const name = match ? match.name : '';

    const changes = {};
    if (city !== (photo.city || '')) changes.city = city;
    if (address !== (photo.address || '')) changes.address = address;
    if (name !== (photo.name || '')) changes.name = name;
    if (Object.keys(changes).length === 0) return photo;

    const updated = await state.db.updatePhoto(photo.id, changes);
    await state.logger.info('Город/адрес изменены', {
        photoId: photo.id,
        city,
        address,
        name
    });
    if (els.photoName) els.photoName.textContent = `Наименование: ${name || '—'}`;
    return updated;
}

async function closePhotoScreen() {
    try {
        await saveCurrentPhotoAddress();
    } catch (err) {
        console.warn('Не удалось сохранить адрес', err);
    }
    state.currentPhotoId = null;
    await refreshGallery();
    showScreen('screen-main');
}

async function sendCurrentPhoto() {
    const photo = await saveCurrentPhotoAddress();
    if (!photo) return;

    const uploaded = await uploadOne(photo);
    await refreshGallery();

    if (uploaded) {
        state.selectedId = photo.id;
        state.currentPhotoId = null;
        showScreen('screen-main');
        await selectPhoto(photo.id);
    }
}

async function deleteCurrentPhoto() {
    if (!state.currentPhotoId) return;
    if (!window.confirm('Удалить это фото?')) return;

    const photoId = state.currentPhotoId;
    await state.db.deletePhoto(photoId);
    await state.logger.warn('Фото удалено', { photoId });

    if (state.selectedId === photoId) state.selectedId = null;
    state.currentPhotoId = null;

    await refreshGallery();
    showScreen('screen-main');
    showToast('Фото удалено');
}

// -------------------------------------------------------------- настройки

async function renderSettings() {
    const pairing = state.pairing;

    els.serverUrl.value = localStorage.getItem(PairingManager.SERVER_URL_KEY) || '';
    els.tokenInput.value = pairing.token;
    els.deviceName.value = pairing.getDeviceName();
    els.compressionLevel.value = PhotoCompressor.getLevel();
    els.autosyncEnabled.checked = pairing.isAutoSyncEnabled();

    updateCompressionInfo();

    els.pairingStatus.textContent = pairing.isPaired()
        ? `Сопряжено с ${pairing.serverUrl}`
        : 'Не сопряжено';

    const lastSync = pairing.getLastSync();
    els.lastSync.textContent = lastSync
        ? `Последняя синхронизация: ${new Date(lastSync).toLocaleString('ru-RU')}`
        : 'Последняя синхронизация: —';

    const [locationsCount, logsCount] = await Promise.all([
        state.db.countLocations(),
        state.logger.count()
    ]);

    els.locationsCount.textContent = `Локаций в базе: ${locationsCount}`;
    els.logsCount.textContent = `Записей: ${logsCount}`;

    updateQueueBadge();
}

function updateCompressionInfo() {
    const config = PhotoCompressor.getLevelConfig();
    els.compressionInfo.textContent = `Текущий режим: ${config.label}. EXIF (включая GPS) сохраняется в JPG.`;
}

async function onCompressionChange() {
    try {
        PhotoCompressor.setLevel(els.compressionLevel.value);
        updateCompressionInfo();
        await state.logger.info('Изменён уровень сжатия', { level: els.compressionLevel.value });
    } catch (err) {
        showToast('Не удалось изменить уровень сжатия');
    }
}

async function onAutoSyncChange() {
    const enabled = els.autosyncEnabled.checked;
    state.pairing.setAutoSyncEnabled(enabled);
    await state.logger.info('Автосинхронизация переключена', { enabled });
}

async function pairDevice() {
    const serverUrl = els.serverUrl.value.trim();

    if (serverUrl) {
        try {
            const parsed = new URL(serverUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new Error('protocol');
            }
            state.pairing.setServerUrl(parsed.href);
        } catch (err) {
            showToast('Некорректный адрес сервера');
            return;
        }
    } else {
        state.pairing.setServerUrl('');
    }

    const token = els.tokenInput.value.trim();
    const deviceName = els.deviceName.value.trim() || state.pairing.getDeviceName();

    els.btnPair.disabled = true;
    try {
        await state.pairing.pair(token, deviceName);
        showToast('Сопряжение выполнено');
        await renderSettings();
        await syncNow({ silent: true });
        await processQueue();
    } catch (err) {
        await state.logger.error('Ошибка сопряжения', { code: err.code, message: err.message });
        showToast(errorText(err));
    } finally {
        els.btnPair.disabled = false;
    }
}

async function unpairDevice() {
    if (!state.pairing.isPaired()) {
        showToast('Устройство уже отвязано');
        return;
    }
    if (!window.confirm('Отвязать устройство от сервера?')) return;

    await state.pairing.unpair();
    await renderSettings();
    showToast('Устройство отвязано');
}

async function syncNow(options = {}) {
    const silent = Boolean(options.silent);

    if (!state.pairing.isPaired()) {
        if (!silent) {
            showToast('Устройство не сопряжено');
            openSettings();
        }
        return null;
    }

    if (!navigator.onLine) {
        if (!silent) showToast('Нет сети');
        return null;
    }

    els.btnSyncNow.disabled = true;
    try {
        // Кнопка «Синхронизировать» просит сервер сразу проверить XLSX.
        const result = await state.pairing.syncLocations({ force: !silent });
        if (!silent) {
            showToast(result.locationsChanged
                ? `База обновлена: ${result.locationsUpdated} локаций`
                : 'База актуальна');
        }
        await renderSettings();
        await renderLocationsDatalist();
        return result;
    } catch (err) {
        await state.logger.error('Ошибка синхронизации', { code: err.code, message: err.message });
        if (!silent) {
            showToast(errorText(err));
            handleAuthError(err);
        }
        return null;
    } finally {
        els.btnSyncNow.disabled = false;
    }
}

function fillDatalist(node, values) {
    if (!node) return;
    node.textContent = '';
    for (const value of values) {
        const option = document.createElement('option');
        option.value = value;
        node.appendChild(option);
    }
}

/** «Город» — уникальные значения из SQL-колонки city. */
async function renderLocationsDatalist() {
    const locations = await state.db.getAllLocations();
    state.locationsCache = locations;

    const cities = [...new Set(
        locations.map((location) => String(location.city || '').trim()).filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, 'ru'));

    fillDatalist(els.citiesList, cities);
    renderAddressOptions(els.photoCity ? els.photoCity.value.trim() : '');
}

/** «Адрес и сторона» — уникальные значения, при выбранном городе — только его. */
function renderAddressOptions(city) {
    if (!els.addressesList) return;

    const cityKey = normalizeKey(city);
    const locations = state.locationsCache || [];
    const filtered = cityKey
        ? locations.filter((location) => normalizeKey(location.city) === cityKey)
        : [];
    const pool = filtered.length > 0 ? filtered : locations;

    const values = [...new Set(pool.map(formatAddressSide).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'ru'));

    fillDatalist(els.addressesList, values);
}

// ------------------------------------------------------------------ логи

async function openLogs() {
    const logs = await state.logger.getAll();
    const list = els.logsList;
    list.textContent = '';

    if (logs.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Логов пока нет';
        list.appendChild(empty);
    } else {
        // Новые записи сверху.
        for (const entry of logs.slice().reverse()) {
            const item = document.createElement('div');
            item.className = 'log-entry';

            const head = document.createElement('div');
            head.className = 'log-head';

            const level = document.createElement('span');
            level.className = `log-level ${entry.level}`;
            level.textContent = entry.level;

            const time = document.createElement('span');
            time.textContent = new Date(entry.timestamp).toLocaleString('ru-RU');

            head.appendChild(level);
            head.appendChild(time);

            const message = document.createElement('div');
            message.className = 'log-message';
            message.textContent = entry.message;

            item.appendChild(head);
            item.appendChild(message);

            if (entry.context && Object.keys(entry.context).length > 0) {
                const context = document.createElement('div');
                context.className = 'log-head';
                context.textContent = JSON.stringify(entry.context);
                item.appendChild(context);
            }

            list.appendChild(item);
        }
    }

    els.logsModal.classList.remove('hidden');
}

function closeLogs() {
    els.logsModal.classList.add('hidden');
}

async function clearLogs() {
    if (!window.confirm('Очистить локальный лог? Неотправленные записи будут потеряны.')) return;
    await state.logger.clear();
    await renderSettings();
    showToast('Лог очищен');
}

// ---------------------------------------------------------------- helpers

function normalizeKey(value) {
    return String(value || '').normalize('NFC').trim().toLowerCase();
}

/** Второе поле: «Адрес (сторона)». */
function formatAddressSide(location) {
    const address = String((location && location.address) || '').trim();
    const side = String((location && location.side) || '').trim();
    if (address && side) return `${address} (${side})`;
    return address || (side ? `(${side})` : '');
}

/** Подпись фото: имя из «Наименования», иначе город и адрес. */
function photoLabel(photo) {
    const name = String((photo && photo.name) || '').trim();
    if (name) return name;
    const parts = [photo && photo.city, photo && photo.address]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    return parts.length ? parts.join(', ') : 'Без адреса';
}

/** Поиск локации по городу и «Адрес + сторона». */
function findLocationByCityAddress(city, addressSide) {
    const addressKey = normalizeKey(addressSide);
    if (!addressKey) return null;

    const cityKey = normalizeKey(city);
    const locations = state.locationsCache || [];

    return locations.find((location) => {
        if (normalizeKey(formatAddressSide(location)) !== addressKey) return false;
        return !cityKey || normalizeKey(location.city) === cityKey;
    }) || null;
}

function applyStatus(element, status) {
    const normalized = STATUS_LABELS[status] ? status : 'pending';
    element.className = `status ${normalized}`;
    element.textContent = STATUS_LABELS[normalized];
}

function handleAuthError(err) {
    if (!err || !err.code) return;
    if (['TOKEN_INVALID', 'TOKEN_REVOKED', 'TOKEN_EXPIRED', 'TOKEN_FORBIDDEN', 'NOT_PAIRED'].includes(err.code)) {
        renderSettings().catch(() => {});
        showScreen('screen-settings');
    }
}

function errorText(err) {
    const messages = {
        NETWORK_ERROR: 'Нет связи с сервером',
        NOT_PAIRED: 'Устройство не сопряжено',
        TOKEN_INVALID: 'Токен недействителен',
        TOKEN_REVOKED: 'Токен отозван администратором',
        TOKEN_EXPIRED: 'Срок действия токена истёк',
        TOKEN_FORBIDDEN: 'Токен просрочен или не имеет нужных прав',
        TOKEN_FORMAT: 'Токен должен состоять из 8 кириллических букв',
        FOLDER_NOT_BOUND: 'Токен не привязан к папке бригады',
        UPLOAD_NOT_ALLOWED: 'Токену не разрешена загрузка файлов',
        STORAGE_UNAVAILABLE: 'Файлохранилище недоступно',
        STORAGE_UPLOAD_FAILED: 'Не удалось сохранить фото в файлохранилище',
        STORAGE_FORBIDDEN: 'Файлохранилище отклонило запрос',
        STORAGE_FILE_TOO_LARGE: 'Фото слишком большое для файлохранилища',
        STORAGE_RATE_LIMITED: 'Слишком много загрузок, попробуйте позже',
        STORAGE_DB_DISABLED: 'Папка «база данных» не настроена',
        TOKENS_MANAGED_BY_STORAGE: 'Токены выдаются в файлохранилище',
        CHECKSUM_MISMATCH: 'Фото повреждено при передаче',
        SYNC_IN_PROGRESS: 'Синхронизация уже выполняется',
        CRYPTO_UNAVAILABLE: 'Для проверки целостности нужен HTTPS',
        PHOTO_INVALID: 'Некорректные данные фото',
        INVALID_PHOTO_ID: 'Некорректный идентификатор фото',
        INVALID_IMAGE: 'Некорректный формат изображения',
        PHOTO_TOO_LARGE: 'Фото слишком большое для сервера',
        PAYLOAD_TOO_LARGE: 'Слишком большой объём данных',
        PHOTO_ID_TAKEN: 'Фото с таким id уже принадлежит другому устройству',
        INVALID_DEVICE_NAME: 'Некорректное имя устройства',
        TOO_MANY_REQUESTS: 'Слишком много запросов, попробуйте позже'
    };
    if (err && err.code && messages[err.code]) return messages[err.code];
    return (err && err.message) || 'Неизвестная ошибка';
}

function showToast(message) {
    if (state.toastTimer) clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.classList.remove('hidden');
    state.toastTimer = setTimeout(() => {
        els.toast.classList.add('hidden');
        state.toastTimer = null;
    }, 3200);
}

async function checkForUpdate() {
    if (!('serviceWorker' in navigator)) {
        showToast('Обновления недоступны в этом браузере');
        return;
    }

    els.btnCheckUpdate.disabled = true;
    els.updateStatus.textContent = 'Проверяем обновление…';
    try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) {
            els.updateStatus.textContent = 'Service Worker ещё не зарегистрирован. Перезапустите приложение.';
            return;
        }
        await registration.update();
        els.updateStatus.textContent = 'Проверка выполнена. Если вышло обновление, приложение перезапустится.';
    } catch (err) {
        els.updateStatus.textContent = 'Не удалось проверить обновление. Проверьте интернет.';
    } finally {
        els.btnCheckUpdate.disabled = false;
    }
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(window.location.protocol)) return;

    // Новый Service Worker активируется (skipWaiting в sw.js) и перезагружает
    // страницу один раз — так обновление применяется без ручной очистки кэша.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
            .then((registration) => {
                registration.update().catch(() => {});
                registration.addEventListener('updatefound', () => {
                    const worker = registration.installing;
                    if (!worker) return;
                    worker.addEventListener('statechange', () => {
                        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                            showToast('Обновление загружено, применяем…');
                        }
                    });
                });
            })
            .catch((err) => {
                console.warn('Service Worker не зарегистрирован', err);
            });
    });
}
