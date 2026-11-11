import serverless from "serverless-http";
import { createApp } from "../server/app.js";

const handle = serverless(createApp());
const FUNCTION_PREFIX = "/.netlify/functions/api";

function apiPath(event: { path?: string; rawUrl?: string }): string {
  const raw = event.rawUrl ? new URL(event.rawUrl).pathname : (event.path ?? "/");
  if (raw === FUNCTION_PREFIX || raw.startsWith(`${FUNCTION_PREFIX}/`)) {
    const rest = raw.slice(FUNCTION_PREFIX.length);
    return `/api${rest}` || "/api";
  }
  return raw;
}

export const handler = (
  event: { path?: string; rawUrl?: string },
  context: unknown,
) => handle({ ...event, path: apiPath(event) }, context);
