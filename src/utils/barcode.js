import crypto from "crypto";
import bwipjs from "bwip-js";

const TOKEN_BYTES = 24;
const PAYLOAD_PREFIX = "OUTPASS:";

export function generateBarcodeToken() {
    return crypto
        .randomBytes(TOKEN_BYTES)
        .toString("base64url");
}

export async function generateBarcodeImage(token) {
    const payload = `${PAYLOAD_PREFIX}${token}`;

    const pngBuffer = await bwipjs.toBuffer({
        bcid: "code128",
        text: payload,
        scale: 3,
        height: 15,
        includetext: true,
        textxalign: "center",
        paddingwidth: 10,
        paddingheight: 10,
    });

    return `data:image/png;base64,${pngBuffer.toString("base64")}`;
}

export function parseBarcodePayload(raw) {
    if (!raw) return null;

    const trimmed = String(raw).trim();

    if (trimmed.startsWith(PAYLOAD_PREFIX)) {
        return trimmed.slice(PAYLOAD_PREFIX.length);
    }

    return trimmed; // Fallback
}