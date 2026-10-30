const REQUIRED_ENV = [
  "OPENOBSERVE_URL",
  "OPENOBSERVE_ORG",
  "OPENOBSERVE_USER",
  "OPENOBSERVE_PASSWORD",
] as const;

const INVALID_STREAM = /[\s"';]/;
const MAX_TEXT_LENGTH = 2000;

export interface StreamSummary {
  name: string;
  stream_type: string;
  stats: {
    doc_num: number | null;
    doc_time_min: number | null;
    doc_time_max: number | null;
  };
}

export interface SchemaField {
  name: string;
  type: string;
}

export interface SearchLogsInput {
  stream: string;
  sql?: string;
  minutes?: number;
  size?: number;
  all_history?: boolean;
}

export interface SearchResult {
  took: number | null;
  scan_size: number | null;
  total: number | null;
  hits: unknown;
}

interface OpenObserveConfig {
  url: string;
  org: string;
  user: string;
  password: string;
}

export function assertValidStream(stream: string): void {
  if (stream.length === 0 || INVALID_STREAM.test(stream)) {
    throw new Error(
      "Invalid stream name: must be non-empty and must not contain spaces, quotes, or semicolons",
    );
  }
}

export function trimText(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_TEXT_LENGTH ? value.slice(0, MAX_TEXT_LENGTH) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => trimText(item));
  }
  if (isRecord(value)) {
    const trimmed: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      trimmed[key] = trimText(child);
    }
    return trimmed;
  }
  return value;
}

export class OpenObserveClient {
  private readonly baseUrl: string;
  private readonly org: string;
  private readonly authorization: string;
  private readonly password: string;

  private constructor(config: OpenObserveConfig) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.org = config.org;
    this.password = config.password;
    this.authorization = `Basic ${Buffer.from(`${config.user}:${config.password}`, "utf8").toString("base64")}`;
  }

  static fromEnv(): OpenObserveClient {
    return new OpenObserveClient(loadConfig());
  }

  async listStreams(): Promise<StreamSummary[]> {
    const body = await this.request(
      "GET",
      `/api/${encodeURIComponent(this.org)}/streams?type=logs&fetchSchema=false`,
    );
    return shapeStreams(body);
  }

  async getStreamSchema(stream: string): Promise<SchemaField[]> {
    assertValidStream(stream);
    const body = await this.request(
      "GET",
      `/api/${encodeURIComponent(this.org)}/streams/${encodeURIComponent(stream)}/schema?type=logs`,
    );
    return shapeSchema(body);
  }

  async searchLogs(input: SearchLogsInput): Promise<SearchResult> {
    assertValidStream(input.stream);
    const size = boundedInt(input.size, {
      fallback: 50,
      min: 1,
      max: 200,
      name: "size",
    });
    const sql =
      input.sql !== undefined && input.sql.trim().length > 0
        ? input.sql
        : `SELECT * FROM "${input.stream}" ORDER BY _timestamp DESC`;
    const endTime = Date.now() * 1000;
    const startTime =
      input.all_history === true
        ? await this.historyStart(input.stream, endTime)
        : lookbackStart(endTime, resolveMinutes(input.minutes));

    const body = await this.request(
      "POST",
      `/api/${encodeURIComponent(this.org)}/_search`,
      {
        query: {
          sql,
          start_time: startTime,
          end_time: endTime,
          from: 0,
          size,
        },
      },
    );
    return shapeSearch(body);
  }

  private async historyStart(stream: string, endTime: number): Promise<number> {
    const streams = await this.listStreams();
    const match = streams.find((item) => item.name === stream);
    const min = match?.stats.doc_time_min;
    if (typeof min !== "number" || !Number.isFinite(min) || min <= 0) {
      return 0;
    }
    return Math.min(Math.trunc(min), endTime);
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: this.authorization,
      Accept: "application/json",
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: payload,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      throw new Error(this.redact(`OpenObserve request failed: ${message}`));
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(this.redact(formatApiError(response.status, text)));
    }
    if (text.length === 0) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        this.redact(`OpenObserve API error ${response.status}: response was not JSON`),
      );
    }
  }

  private redact(text: string): string {
    let redacted = text;
    if (this.password.length > 0) {
      redacted = redacted.split(this.password).join("[redacted]");
    }
    const token = this.authorization.slice("Basic ".length);
    if (token.length > 0) {
      redacted = redacted.split(token).join("[redacted]");
    }
    return redacted;
  }
}

function loadConfig(): OpenObserveConfig {
  const missing = REQUIRED_ENV.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable: ${missing.join(", ")}`);
  }

  const url = process.env.OPENOBSERVE_URL;
  const org = process.env.OPENOBSERVE_ORG;
  const user = process.env.OPENOBSERVE_USER;
  const password = process.env.OPENOBSERVE_PASSWORD;
  if (
    url === undefined ||
    org === undefined ||
    user === undefined ||
    password === undefined
  ) {
    throw new Error(`Missing required environment variable: ${REQUIRED_ENV.join(", ")}`);
  }

  return { url, org, user, password };
}

function resolveMinutes(value: number | undefined): number {
  const resolved = value ?? 60;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("minutes must be an integer greater than or equal to 1");
  }
  return resolved;
}

function lookbackStart(endTime: number, minutes: number): number {
  const windowMicros = minutes * 60 * 1_000_000;
  if (!Number.isSafeInteger(windowMicros) || windowMicros >= endTime) {
    return 0;
  }
  return endTime - windowMicros;
}

function boundedInt(
  value: number | undefined,
  bounds: { fallback: number; min: number; max: number; name: string },
): number {
  const resolved = value ?? bounds.fallback;
  if (!Number.isInteger(resolved) || resolved < bounds.min || resolved > bounds.max) {
    throw new Error(
      `${bounds.name} must be an integer between ${bounds.min} and ${bounds.max}`,
    );
  }
  return resolved;
}

function shapeStreams(body: unknown): StreamSummary[] {
  const list = extractList(body);
  return list.map((item) => {
    const record = isRecord(item) ? item : {};
    const stats = isRecord(record.stats) ? record.stats : {};
    return {
      name: typeof record.name === "string" ? record.name : "",
      stream_type: typeof record.stream_type === "string" ? record.stream_type : "logs",
      stats: {
        doc_num: typeof stats.doc_num === "number" ? stats.doc_num : null,
        doc_time_min: typeof stats.doc_time_min === "number" ? stats.doc_time_min : null,
        doc_time_max: typeof stats.doc_time_max === "number" ? stats.doc_time_max : null,
      },
    };
  });
}

function shapeSchema(body: unknown): SchemaField[] {
  const schema =
    isRecord(body) && Array.isArray(body.schema)
      ? body.schema
      : Array.isArray(body)
        ? body
        : null;
  if (schema === null) {
    throw new Error("OpenObserve API error: unexpected schema response");
  }

  const fields: SchemaField[] = [];
  for (const field of schema) {
    if (!isRecord(field) || typeof field.name !== "string" || typeof field.type !== "string") {
      continue;
    }
    fields.push({ name: field.name, type: field.type });
  }
  return fields;
}

function shapeSearch(body: unknown): SearchResult {
  if (!isRecord(body)) {
    throw new Error("OpenObserve API error: unexpected search response");
  }
  return {
    took: typeof body.took === "number" ? body.took : null,
    scan_size: typeof body.scan_size === "number" ? body.scan_size : null,
    total: typeof body.total === "number" ? body.total : null,
    hits: trimText(body.hits ?? []),
  };
}

function extractList(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (isRecord(body) && Array.isArray(body.list)) {
    return body.list;
  }
  throw new Error("OpenObserve API error: unexpected streams response");
}

function formatApiError(status: number, body: string): string {
  return `OpenObserve API error ${status}: ${extractMessage(body)}`;
}

function extractMessage(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return "empty response";
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      if (typeof parsed.message === "string" && parsed.message.length > 0) {
        return clip(parsed.message);
      }
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        return clip(parsed.error);
      }
    }
  } catch {
    // The body is not JSON; return the text itself.
  }
  return clip(trimmed);
}

function clip(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
