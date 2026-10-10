import type { AddressInfo } from "node:net";
import { app } from "../src/app.js";

export type TestServer = {
  call: (method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
};

export async function startServer(): Promise<TestServer> {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    async call(method, path, opts = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      let body: any = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // non-JSON body (e.g. 204) — leave as text
      }
      return { status: res.status, body };
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
