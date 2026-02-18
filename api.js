import { CONFIG } from "./config.js";

/**
 * Health check for Google Apps Script backend
 */
export async function apiHealth() {
  const start = performance.now();

  try {
    if (!CONFIG || !CONFIG.GAS_WEBAPP_URL) {
      throw new Error("Missing GAS_WEBAPP_URL in config");
    }

    const res = await fetch(
      `${CONFIG.GAS_WEBAPP_URL}?route=health`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    const latency = Math.round(performance.now() - start);

    return {
      ok: data.ok === true,
      latency
    };

  } catch (error) {
    console.error("API Health Error:", error);

    return {
      ok: false,
      latency: null
    };
  }
}


/**
 * Generic API request helper
 * route example: "slate" or "optimize"
 */
export async function apiRequest(route, payload = {}) {
  try {
    if (!CONFIG || !CONFIG.GAS_WEBAPP_URL) {
      throw new Error("Missing GAS_WEBAPP_URL in config");
    }

    const res = await fetch(
      `${CONFIG.GAS_WEBAPP_URL}?route=${route}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return await res.json();

  } catch (error) {
    console.error(`API ${route} Error:`, error);
    throw error;
  }
}
