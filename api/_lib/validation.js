function validateTrip(data, isUpdate = false) {
    const errors = [];

    if (!isUpdate || data.trip_date !== undefined) {
        if (!data.trip_date) errors.push('Дата рейса обязательна');
    }

    if (!isUpdate || data.vehicle_id !== undefined) {
        if (!data.vehicle_id) errors.push('Машина обязательна');
    }

    if (!isUpdate || data.driver_id !== undefined) {
        if (!data.driver_id) errors.push('Водитель обязателен');
    }

    if (data.plan_km !== undefined && data.plan_km !== null && data.plan_km < 0) {
        errors.push('Пробег план не может быть отрицательным');
    }

    if (data.fact_km !== undefined && data.fact_km !== null && data.fact_km < 0) {
        errors.push('Пробег факт не может быть отрицательным');
    }

    if (data.revenue !== undefined && data.revenue !== null && data.revenue < 0) {
        errors.push('Выручка не может быть отрицательной');
    }

    const validStatuses = ['forming', 'loading', 'transit', 'problem', 'done', 'cancelled'];
    if (data.status && !validStatuses.includes(data.status)) {
        errors.push('Недопустимый статус');
    }

    const validTypes = ['city', 'intercity'];
    if (data.trip_type && !validTypes.includes(data.trip_type)) {
        errors.push('Недопустимый тип рейса');
    }

    return errors;
}

module.exports = { validateTrip };
