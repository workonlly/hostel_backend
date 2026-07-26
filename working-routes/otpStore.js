const otpStore = new Map();

export function storeOtp(email, otp, payload, ttlMs = 5 * 60 * 1000) {
    otpStore.set(email, {
        otp,
        payload,
        expiresAt: Date.now() + ttlMs,
    });
}

export function getOtp(email) {
    const entry = otpStore.get(email);

    if (!entry) {
        return null;
    }

    if (Date.now() > entry.expiresAt) {
        otpStore.delete(email);
        return null;
    }

    return entry;
}

export function verifyOtp(email, otp) {
    const entry = getOtp(email);

    if (!entry) {
        return null;
    }

    if (entry.otp !== otp) {
        return { valid: false };
    }

    otpStore.delete(email);

    return {
        valid: true,
        payload: entry.payload,
    };
}

export function deleteOtp(email) {
    otpStore.delete(email);
}
