import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { hashIP, getClientIP } from "../../lib/hash";
import { setupAnalytics } from "../../../../src/analytics";
import { env } from "cloudflare:workers";
import {
  getCachedVersionRows,
  getCachedText,
  loadVersionRows,
  putCachedVersionRows,
  putCachedText,
  versionsToToml,
} from "../../lib/version-files";

export const GET: APIRoute = async ({ request, params, locals }) => {
  const { tool } = params;

  if (!tool) {
    return new Response("Tool name required", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Validate tool name (alphanumeric, hyphens, underscores, slashes for namespaced tools)
  if (!/^[\w\-\/]+$/.test(tool)) {
    return new Response("Invalid tool name", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    const db = drizzle(env.ANALYTICS_DB);

    let toml = await getCachedText(request, ":toml");
    if (toml === null) {
      let versions = await getCachedVersionRows(env.DOWNLOAD_DEDUPE, tool);
      if (versions === null) {
        versions = await loadVersionRows(db, tool);
        if (versions !== null) {
          locals.cfContext.waitUntil(
            putCachedVersionRows(env.DOWNLOAD_DEDUPE, tool, {}, versions),
          );
        }
      }
      if (versions === null) {
        return new Response(`Tool "${tool}" not found`, {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        });
      }
      toml = versionsToToml(versions);
      locals.cfContext.waitUntil(
        putCachedText(request, ":toml", toml, "text/plain; charset=utf-8"),
      );
    }

    // Track version request for DAU/MAU using waitUntil to ensure it completes.
    // Skip database storage for CI requests (excludes from MAU calculations).
    const isCI = request.headers.get("x-mise-ci") === "true";
    if (!isCI) {
      const clientIP = getClientIP(request);
      locals.cfContext.waitUntil(
        hashIP(clientIP, env.API_SECRET).then(async (ipHash) => {
          try {
            const analytics = setupAnalytics(db, {
              trackingCache: env.DOWNLOAD_DEDUPE,
            });
            await analytics.trackVersionRequest(ipHash);
          } catch (e) {
            console.error("Failed to track version request:", e);
          }
        }),
      );
    }

    return new Response(toml, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=600",
      },
    });
  } catch (error) {
    console.error("Error fetching versions from D1:", error);
    return new Response("Failed to fetch tool data", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
};
