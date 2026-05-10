import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../src/analytics";
import { hashIP, getClientIP } from "../../lib/hash";
import { env } from "cloudflare:workers";
import { keyPart } from "../../lib/kv-cache";

const DOWNLOAD_DEDUPE_TTL_SECONDS = 2 * 24 * 60 * 60;

function downloadDedupeKey(
  tool: string,
  version: string,
  ipHash: string,
): string {
  const day = Math.floor(Date.now() / 86400000);
  return `download-dedupe:${day}:${keyPart(tool)}:${keyPart(version)}:${ipHash}`;
}

export const POST: APIRoute = async ({ request }) => {
  return trackDownloadRequest({ request });
};

export async function trackDownloadRequest({
  request,
  tool: pathTool,
}: {
  request: Parameters<APIRoute>[0]["request"];
  tool?: string;
}) {
  try {
    const body = (await request.json()) as {
      tool?: string;
      version: string;
      os?: string;
      arch?: string;
      full?: string;
    };

    const tool = pathTool || body.tool;

    if (!tool || !body.version) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: tool, version" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const clientIP = getClientIP(request);
    const ipHash = await hashIP(clientIP, env.API_SECRET);

    // Check if request is from CI environment
    const isCI = request.headers.get("x-mise-ci") === "true";

    // Skip database storage for CI requests (excludes from MAU calculations)
    if (isCI) {
      return new Response(
        JSON.stringify({
          success: true,
          deduplicated: false,
          ci: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db, {
      trackingCache: env.DOWNLOAD_DEDUPE,
    });
    const dedupeKey = downloadDedupeKey(tool, body.version, ipHash);

    const seen = await env.DOWNLOAD_DEDUPE.get(dedupeKey);
    if (seen) {
      return new Response(
        JSON.stringify({
          success: true,
          deduplicated: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    await env.DOWNLOAD_DEDUPE.put(dedupeKey, "1", {
      expirationTtl: DOWNLOAD_DEDUPE_TTL_SECONDS,
    });

    const result = await analytics.trackDownload(
      tool,
      body.version,
      ipHash,
      body.os || null,
      body.arch || null,
      body.full || null,
    );

    return new Response(
      JSON.stringify({
        success: true,
        deduplicated: result.deduplicated,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Track error:", error);
    return new Response(JSON.stringify({ error: "Failed to track download" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
