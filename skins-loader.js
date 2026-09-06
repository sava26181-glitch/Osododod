let skinsCache = null;

// Загружаем базу один раз и кэшируем
export async function getSkinsDatabase() {
    if (skinsCache) return skinsCache;
    try {
        const response = await fetch('https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json');
        skinsCache = await response.json();
        return skinsCache;
    } catch (error) {
        console.error('Ошибка загрузки базы скинов:', error);
        return [];
    }
}

// Универсальный поиск скина для любого места на сайте
export async function getSkinData(skinName) {
    const skins = await getSkinsDatabase();
    return skins.find(s => s.name === skinName) || null;
}

