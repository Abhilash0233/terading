import fs from "node:fs";
import path from "node:path";
import { freshBook, normalizeBook } from "../src/lib/book.js";
import { freshOptionsBook, normalizeOptionsBook } from "../src/lib/options/book.js";
import type { Book } from "../src/lib/types";
import type { OptionsBook } from "../src/lib/options/types";

export type PaperBookId = "live" | "options";

const hosted = Boolean(process.env.VERCEL || process.env.NETLIFY);
const root = hosted ? path.join("/tmp", "terading") : path.resolve(process.cwd(), "data");

function remoteConfigured(): boolean {
  return Boolean(process.env.BOOK_URL && process.env.BOOK_SECRET);
}

function requireStore(): void {
  if (hosted && !remoteConfigured()) {
    throw new Error("Supabase book store is not configured.");
  }
}

function fileFor(id: PaperBookId): string {
  return path.join(root, id === "live" ? "book.json" : "options-book.json");
}

function remoteUrl(id: PaperBookId): string {
  const base = process.env.BOOK_URL!;
  const join = base.includes("?") ? "&" : "?";
  return `${base}${join}id=${id}`;
}

async function remoteReadRaw(id: PaperBookId): Promise<unknown | null> {
  const res = await fetch(remoteUrl(id), {
    headers: { "x-terading-secret": process.env.BOOK_SECRET! },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Book read failed (${res.status}).`);
  const body = (await res.json()) as { book?: unknown };
  return body.book ?? null;
}

async function remoteWriteRaw(id: PaperBookId, book: unknown): Promise<void> {
  const res = await fetch(remoteUrl(id), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-terading-secret": process.env.BOOK_SECRET!,
    },
    body: JSON.stringify(book),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Book write failed (${res.status}).`);
}

async function mirrorReadRaw(id: PaperBookId): Promise<unknown> {
  const route = id === "live" ? "book" : "options-book";
  const res = await fetch(`${process.env.BOOK_MIRROR_URL!.replace(/\/$/, "")}/api/${route}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Mirror read failed (${res.status}).`);
  return res.json();
}

async function readRaw(id: PaperBookId): Promise<unknown | null> {
  if (remoteConfigured()) return remoteReadRaw(id);
  if (process.env.BOOK_MIRROR_URL) return mirrorReadRaw(id);
  return readFileRaw(id);
}

function readFileRaw(id: PaperBookId): unknown | null {
  const file = fileFor(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fs.renameSync(file, `${file}.corrupt`);
    return null;
  }
}

function writeFileRaw(id: PaperBookId, book: unknown): void {
  const file = fileFor(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(book));
  fs.renameSync(tmp, file);
}

export async function readBook(): Promise<Book> {
  requireStore();
  const raw = await readRaw("live");
  if (raw == null) return freshBook();
  return normalizeBook(raw);
}

export async function writeBook(raw: unknown): Promise<Book> {
  requireStore();
  const book = normalizeBook(raw);
  if (remoteConfigured()) await remoteWriteRaw("live", book);
  else writeFileRaw("live", book);
  return book;
}

export async function readOptionsBook(): Promise<OptionsBook> {
  requireStore();
  const raw = await readRaw("options");
  if (raw == null) return freshOptionsBook();
  return normalizeOptionsBook(raw);
}

export async function writeOptionsBook(raw: unknown): Promise<OptionsBook> {
  requireStore();
  const book = normalizeOptionsBook(raw);
  if (remoteConfigured()) await remoteWriteRaw("options", book);
  else writeFileRaw("options", book);
  return book;
}

export function bookReadOnly(): boolean {
  return process.env.BOOK_READONLY === "1" || Boolean(process.env.BOOK_MIRROR_URL);
}

export function bookStoreName(): "supabase" | "mirror" | "file" {
  if (remoteConfigured()) return "supabase";
  return process.env.BOOK_MIRROR_URL ? "mirror" : "file";
}
