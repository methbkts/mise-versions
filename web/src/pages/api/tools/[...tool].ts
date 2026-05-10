import type { APIRoute } from "astro";
import { trackDownloadRequest } from "../track";

export const POST: APIRoute = async ({ request, params }) => {
  return trackDownloadRequest({
    request,
    tool: params.tool,
  });
};
