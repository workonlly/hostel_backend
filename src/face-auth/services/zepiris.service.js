import { Mutex } from "../../utils/Mutex.js";

const BASE_URL = process.env.ZEPIRIS_BASE_URL;
const TENANT = process.env.ZEPIRIS_TENANT;
const zepirisMutex = new Mutex();

class ZepirisService {
    async request(endpoint, options = {}) {
        await zepirisMutex.lock();
        const controller = new AbortController();
        // Increase timeout to 30s just in case, since they are queued now
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
            const response = await fetch(`${BASE_URL}${endpoint}`, {
                ...options,
                signal: controller.signal,
            });

            let data = {};

            try {
                data = await response.json();
            } catch (_) {
                data = {};
            }

            if (!response.ok) {
                const error = new Error("ZepIris request failed");

                error.response = {
                    status: response.status,
                    data,
                };

                throw error;
            }

            return data;
        } catch (error) {
            // fetch failed / timeout / connection refused
            if (!error.response) {
                error.response = {
                    status: 503,
                    data: {
                        message:
                            "Face authentication service is currently unavailable.",
                    },
                };
            }

            throw error;
        } finally {
            clearTimeout(timeout);
            zepirisMutex.unlock();
        }
    }

    async enrollFace({ faceId, file }) {
        const formData = new FormData();

        formData.append("id", faceId);
        formData.append("tenant", TENANT);

        formData.append(
            "file",
            new Blob([file.buffer], {
                type: file.mimetype,
            }),
            file.originalname
        );

        return this.request("/v1/faces/insert", {
            method: "POST",
            body: formData,
        });
    }

    async upsertFace({ faceId, file }) {
        const formData = new FormData();

        formData.append("id", faceId);
        formData.append("tenant", TENANT);

        formData.append(
            "file",
            new Blob([file.buffer], {
                type: file.mimetype,
            }),
            file.originalname
        );

        return this.request("/v1/faces/upsert", {
            method: "POST",
            body: formData,
        });
    }

    async searchFace({ file, topK = 5 }) {
        const formData = new FormData();

        formData.append("id", `query_${Date.now()}`);
        formData.append("tenant", TENANT);

        formData.append(
            "file",
            new Blob([file.buffer], {
                type: file.mimetype,
            }),
            file.originalname
        );

        return this.request(`/v1/faces/search?top_k=${topK}`, {
            method: "POST",
            body: formData,
        });
    }

    async getFace(faceId) {
        return this.request(`/v1/faces/get/${faceId}`);
    }

    async deleteFace(faceId) {
        return this.request(`/v1/faces/delete?id=${faceId}`, {
            method: "DELETE",
        });
    }

    async healthCheck() {
        return this.request("/healthz");
    }

    async readyCheck() {
        return this.request("/readyz");
    }
}

export default new ZepirisService();