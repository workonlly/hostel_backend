const BASE_URL = process.env.ZEPIRIS_BASE_URL;
const TENANT = process.env.ZEPIRIS_TENANT;

class ZepirisService {
    async enrollFace({ faceId, file }) {
        const formData = new FormData();

        formData.append("id", faceId);
        formData.append("tenant", TENANT);

        formData.append(
            "file",
            new Blob([file.buffer], { type: file.mimetype }),
            file.originalname
        );

        const response = await fetch(`${BASE_URL}/v1/faces/insert`, {
            method: "POST",
            body: formData,
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "Failed to enroll face");
        }

        return data;
    }

    async searchFace({ file, topK = 5 }) {
        const formData = new FormData();

        formData.append("id", `query_${Date.now()}`);
        formData.append("tenant", TENANT);

        formData.append(
            "file",
            new Blob([file.buffer], { type: file.mimetype }),
            file.originalname
        );

        const response = await fetch(
            `${BASE_URL}/v1/faces/search?top_k=${topK}`,
            {
                method: "POST",
                body: formData,
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "Face search failed");
        }

        return data;
    }

    async deleteFace(faceId) {
        const response = await fetch(
            `${BASE_URL}/v1/faces/delete?id=${faceId}`,
            {
                method: "DELETE",
            }
        );

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.message || "Failed to delete face");
        }

        return true;
    }

    async healthCheck() {
        const response = await fetch(`${BASE_URL}/healthz`);

        if (!response.ok) {
            throw new Error("ZepIris service unavailable");
        }

        return response.json();
    }
}

export default new ZepirisService();