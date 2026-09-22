// ============ API-КЛИЕНТ ============

const TOKEN_KEY = 'logistpro_token';
const USER_KEY = 'logistpro_user';

function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

function getUser() {
    try {
        const raw = localStorage.getItem(USER_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function setAuth(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
}

async function api(endpoint, options = {}) {
    const token = getToken();
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };

    if (token) {
        headers['Authorization'] = 'Bearer ' + token;
    }

    const response = await fetch(endpoint, {
        ...options,
        headers
    });

    // Если токен истёк — редирект на логин
    if (response.status === 401) {
        clearAuth();
        window.location.href = '/login.html';
        throw new Error('Unauthorized');
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || 'Ошибка сервера');
    }

    return data;
}

// ============ ХЕЛПЕРЫ ============

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatMoney(value) {
    if (!value && value !== 0) return '—';
    const num = Number(value);
    return num.toLocaleString('ru-RU') + ' ₽';
}

function formatNumber(value, decimals = 0) {
    if (!value && value !== 0) return '—';
    const num = Number(value);
    return num.toLocaleString('ru-RU', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

// ============ ЗАЩИТА СТРАНИЦ ============

function requireLogin() {
    if (!getToken()) {
        window.location.href = '/login.html';
        return false;
    }
    return true;
}

function redirectIfLoggedIn() {
    if (getToken()) {
        window.location.href = '/';
        return true;
    }
    return false;
}

// Экспорт в глобальную область для Alpine.js
window.API = {
    getToken, getUser, setAuth, clearAuth, api
};
window.HELPERS = {
    formatDate, formatMoney, formatNumber
};
window.AUTH = {
    requireLogin, redirectIfLoggedIn
};
