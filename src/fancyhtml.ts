import type { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

/**
 * fancyhtml — v1: fill + push + link.  Dependency-free (no npm packages):
 *  - inline Mustache-subset renderer (verified byte-identical to mustache)
 *  - Vercel Blob upload via fetch() to the documented HTTP API
 *
 * Steps:
 *  1. Read an Inspiration Deck Slide Library row (Page A) -> its `HTML Template`
 *  2. Fill the {{slots}} with the content the agent passes in
 *  3. PUT the rendered HTML to Vercel Blob -> get a stored URL
 *  4. Append a link back onto the target page (Page B)
 *
 * Secret (set AFTER first deploy: `ntn workers env set BLOB_READ_WRITE_TOKEN=...`):
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob read/write token
 *
 * The `notion` client in execute() is auto-authed with the agent's permissions.
 */

// ---- tiny Mustache-subset renderer ------------------------------------------
type Ctx = unknown;
interface Node { type: "text" | "var" | "section" | "inverted"; v?: string; key?: string; children?: Node[]; }

function tokenize(t: string) {
  const re = /\{\{([#^/]?)\s*([\w.]+)\s*\}\}/g;
  const toks: { k: string; v?: string; key?: string }[] = [];
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m.index > last) toks.push({ k: "text", v: t.slice(last, m.index) });
    const sig = m[1];
    toks.push({ k: sig === "#" ? "open" : sig === "^" ? "inv" : sig === "/" ? "close" : "var", key: m[2] });
    last = re.lastIndex;
  }
  if (last < t.length) toks.push({ k: "text", v: t.slice(last) });
  return toks;
}
function parse(toks: { k: string; v?: string; key?: string }[], i: number): { nodes: Node[]; i: number } {
  const nodes: Node[] = [];
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.k === "close") return { nodes, i: i + 1 };
    if (tk.k === "open" || tk.k === "inv") {
      const sub = parse(toks, i + 1);
      nodes.push({ type: tk.k === "open" ? "section" : "inverted", key: tk.key, children: sub.nodes });
      i = sub.i;
    } else if (tk.k === "var") { nodes.push({ type: "var", key: tk.key }); i++; }
    else { nodes.push({ type: "text", v: tk.v }); i++; }
  }
  return { nodes, i };
}
function lookup(stack: Ctx[], key: string): unknown {
  if (key === ".") return stack[stack.length - 1];
  for (let i = stack.length - 1; i >= 0; i--) {
    const c = stack[i];
    if (c != null && typeof c === "object" && !Array.isArray(c) && key in (c as object)) {
      return (c as Record<string, unknown>)[key];
    }
  }
  return undefined;
}
function renderNodes(nodes: Node[], stack: Ctx[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += n.v ?? "";
    else if (n.type === "var") { const v = lookup(stack, n.key!); out += v == null ? "" : String(v); }
    else if (n.type === "section") {
      const v = lookup(stack, n.key!);
      if (Array.isArray(v)) for (const it of v) out += renderNodes(n.children!, stack.concat([it]));
      else if (v) out += renderNodes(n.children!, stack.concat([v]));
    } else if (n.type === "inverted") {
      const v = lookup(stack, n.key!);
      const empty = v == null || v === false || v === "" || (Array.isArray(v) && v.length === 0);
      if (empty) out += renderNodes(n.children!, stack);
    }
  }
  return out;
}
function render(tpl: string, data: unknown): string {
  return renderNodes(parse(tokenize(tpl), 0).nodes, [data]);
}

// ---- Vercel Blob upload via fetch (HTTP API, no SDK) -------------------------
type BlobAccess = "public" | "private";

function getBlobAccess(): BlobAccess {
  const access = process.env.BLOB_ACCESS ?? "public";
  if (access !== "public" && access !== "private") {
    throw new Error('BLOB_ACCESS must be either "private" or "public"');
  }
  return access;
}

async function uploadToBlob(pathname: string, html: string, token: string, access: BlobAccess): Promise<string> {
  const params = new URLSearchParams({ pathname });
  const uploadUrl = `https://vercel.com/api/blob/?${params.toString()}`;
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "x-api-version": "12",
      "x-vercel-blob-access": access,
      "x-add-random-suffix": "1",
      "x-content-type": "text/html",
    },
    body: html,
  });
  if (!res.ok) throw new Error(`Blob upload failed for pathname "${pathname}" via query API: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { url: string };
  return json.url;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---- page-id normalizer ------------------------------------------------------
// Accepts a bare UUID, a 32-char compact id, or a full/compressed Notion URL
// (e.g. https://www.notion.so/Title-<32hex>?pvs=...) and returns a hyphenated
// UUID. The last hex run in the string wins, because Notion URLs put the page id
// at the end of the slug. Throws a clear error if no id can be found.
function normalizePageId(value: string, field: string): string {
  const input = (value ?? "").trim();
  const matches = input.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/gi,
  );
  const id = matches?.at(-1);
  if (!id) {
    throw new Error(
      `Invalid ${field}: expected a Notion page ID or URL containing one, got "${value}". ` +
        `Pass the raw page ID (or a full notion.so URL), not a page mention/title.`,
    );
  }
  const compact = id.replace(/-/g, "").toLowerCase();
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

// ---- the tool ----------------------------------------------------------------
export function registerFancyHtml(worker: Worker) {
  worker.tool("fancyhtml", {
    title: "Generate slide preview (fancyhtml)",
    description:
      "Fill an Inspiration Deck template with content and publish a previewable HTML slide. " +
      "Use after choosing a template from the Inspiration Deck Slide Library and mapping the " +
      "Page B content into that template's Slots. Returns a preview URL and writes it back to the page.",
    schema: j.object({
      layoutPageId: j.string().describe("Inspiration Deck Slide Library row whose `HTML Template` to use. Raw page ID preferred; a full notion.so URL is also accepted. Do not pass a page mention/title."),
      targetPageId: j.string().describe("Page to append the preview link to (e.g. the Deck Outputs row). Raw page ID preferred; a full notion.so URL is also accepted. Do not pass a page mention/title."),
      dataJson: j.string().describe('JSON of slot values matching that template\'s `Slots` schema. e.g. {"title":"...","columns":[...]}'),
      filename: j.string().nullable().describe("Optional output name; defaults to decks/<layoutPageId>-<timestamp>.html"),
    }),
    outputSchema: j.object({
      url: j.string().describe("Preview URL for the generated HTML slide"),
      filename: j.string().describe("Pathname used for the generated HTML file"),
      slideTitle: j.string().describe("Title of the source slide template"),
      access: j.enum("public", "private").describe("Blob access mode used for the generated file"),
      appendSucceeded: j.boolean().describe("Whether the preview link was written back to the target page"),
      appendError: j.string().nullable().describe("Error from writing back to the target page, if any"),
    }),
    execute: async ({ layoutPageId, targetPageId, dataJson, filename }, { notion }) => {
      const token = process.env.BLOB_READ_WRITE_TOKEN;
      if (!token) throw new Error("Missing BLOB_READ_WRITE_TOKEN worker secret");
      const access = getBlobAccess();

      // 0. normalize whatever the agent passed (URL / mention / compact id) -> UUID
      const layoutId = normalizePageId(layoutPageId, "layoutPageId");
      const targetId = normalizePageId(targetPageId, "targetPageId");

      // 1. read the template HTML (rich_text can be chunked -> join the parts)
      const page = (await notion.pages.retrieve({ page_id: layoutId })) as any;
      const tplProp = page.properties?.["HTML Template"]?.rich_text ?? [];
      const template: string = tplProp.map((t: any) => t.plain_text).join("");
      if (!template) throw new Error(`No HTML Template on page ${layoutId}`);
      const slideTitle: string = page.properties?.["Slide"]?.title?.[0]?.plain_text ?? "Slide preview";

      // 2. fill the slots
      const html = render(template, JSON.parse(dataJson));

      // 3. push to Vercel Blob (random suffix => unguessable URL)
      const name = filename ?? `decks/${layoutId}-${Date.now()}.html`;
      const url = await uploadToBlob(name, html, token, access);

      // 4. write the preview link back onto the target page
      const children: any[] = [];
      if (access === "public") {
        children.push({ object: "block", type: "embed", embed: { url } });
      }
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { type: "text", text: { content: `Preview · ${slideTitle} · ${new Date().toISOString()}`, link: { url } } },
          ],
        },
      });

      let appendSucceeded = true;
      let appendError: string | null = null;
      try {
        await notion.blocks.children.append({
          block_id: targetId,
          children,
        } as any);
      } catch (error) {
        appendSucceeded = false;
        appendError = errorMessage(error);
      }

      return { url, filename: name, slideTitle, access, appendSucceeded, appendError };
    },
  });
}
