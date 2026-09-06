// Глобальный массив для каталога скинов
let CATALOG_ITEMS = [];

// 1. Автоматическая загрузка базы скинов из вашего API
async function initSkinsDatabase() {
    try {
        console.log('Загружаем каталог скинов из сети...');
        const response = await fetch('https://spacerulerwill.github.io/CS2-API/api/skins.json');
        
        if (!response.ok) throw new Error('Не удалось загрузить JSON-файл');
        
        const data = await response.json();
        
        // Превращаем данные из API в нужный формат для вашего приложения
        CATALOG_ITEMS = data.map(skin => ({
            id: skin.id || skin.name,
            name: skin.name,
            category: 'skins', // Все предметы идут в категорию скинов
            value: skin.price || Math.floor(Math.random() * 500) + 50, // Цена
            image: skin.image // Реальная ссылка на картинку скина
        }));

        console.log(`Успешно загружено скинов: ${CATALOG_ITEMS.length}`);
        
        // Сразу обновляем сетку на экране, если функция уже доступна
        if (typeof renderGrid === 'function') {
            renderGrid();
        }
        
    } catch (error) {
        console.error('Ошибка при загрузке базы скинов:', error);
    }
}

// 2. Функция создания карточки товара с изображением
function createCard(item, isSelected, onClick) {
    const card = document.createElement('div');
    card.className = `item-card ${isSelected ? 'selected' : ''}`;
    
    card.innerHTML = `
        <div class="item-img-container">
            <img src="${item.image || ''}" alt="${item.name}" loading="lazy">
        </div>
        <div class="item-info">
            <div class="item-price">${item.value} ₽</div>
            <div class="item-name">${item.name}</div>
        </div>
    `;
    
    card.onclick = onClick;
    return card;
}

// 3. Безопасная отрисовка сетки (защита от падений при фильтрации)
function renderGrid() {
    const grid = document.getElementById('itemsGrid');
    if (!grid) return;
    grid.innerHTML = '';

    // Проверяем текущую вкладку (инвентарь или скины)
    const activeTab = typeof currentTab !== 'undefined' ? currentTab : 'skins';

    if (activeTab === 'inventory') {
        const filterBox = document.getElementById('priceFilterBox');
        if (filterBox) filterBox.classList.remove('active');
        
        if (typeof currentUser !== 'undefined' && currentUser.inventory) {
            currentUser.inventory.forEach((item, index) => {
                const card = createCard(item, selectedItemIndex === index, () => {
                    if (typeof isSpinning !== 'undefined' && isSpinning) return;
                    selectedItemIndex = selectedItemIndex === index ? null : index;
                    if (typeof activeQuickChance !== 'undefined') activeQuickChance = null;
                    if (typeof renderQuickChances === 'function') renderQuickChances();
                    renderGrid();
                    if (typeof updateUI === 'function') updateUI();
                });
                grid.appendChild(card);
            });
        }
    } else {
        const filterBox = document.getElementById('priceFilterBox');
        if (filterBox) filterBox.classList.add('active');
        
        const minInputVal = document.getElementById('minPriceInput')?.value;
        const maxInputVal = document.getElementById('maxPriceInput')?.value;
        const minP = (minInputVal === '' || !minInputVal) ? 0 : parseFloat(minInputVal);
        const maxP = (maxInputVal === '' || !maxInputVal) ? Infinity : parseFloat(maxInputVal);

        CATALOG_ITEMS.filter(i => i.category === activeTab && i.value >= minP && i.value <= maxP).forEach(item => {
            const isSelected = (typeof targetWeapon !== 'undefined' && targetWeapon && targetWeapon.id === item.id);
            const card = createCard(item, isSelected, () => {
                if (typeof isSpinning !== 'undefined' && isSpinning) return;
                targetWeapon = (targetWeapon && targetWeapon.id === item.id) ? null : item;
                if (typeof activeQuickChance !== 'undefined') activeQuickChance = null;
                if (typeof renderQuickChances === 'function') renderQuickChances();
                renderGrid();
                if (typeof updateUI === 'function') updateUI();
            });
            grid.appendChild(card);
        });
    }
}

// Запускаем загрузку базы при старте скрипта
initSkinsDatabase();
