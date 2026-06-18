# fancyhtml — HTML Slide Renderer for Notion

**Generate on-brand HTML slide previews from Notion templates in seconds.**

A Notion Worker that reads slide templates from your Inspiration Deck Library, fills them with content, and publishes previews to Vercel Blob — all from within Notion.

## What it does

```
Notion Page A (Template)  +  Content data  →  fancyhtml  →  Vercel Blob  →  Preview link on Page B
```

1. **Read** a slide template from the Inspiration Deck Slide Library (Notion DB row)
2. **Fill** it with content using Mustache templating (`{{slots}}`)
3. **Upload** the rendered HTML to Vercel Blob (returns unguessable public URL)
4. **Link back** — append an embed + preview link onto your target Notion page

## Quick start

### Setup

```bash
# Install dependencies
npm install

# Deploy to Notion
ntn workers deploy

# Set your Vercel Blob token as a secret
ntn workers env set BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...

# Redeploy (secret is now live)
ntn workers deploy
```

### Use it

Attach `fancyhtml` as a tool to your **Custom Agent** (Notion UI → agent settings → Tools).

Then call it from your agent:

```javascript
{
  layoutPageId: "81e571cd77e144f1a823be2decbe2017",  // Library row ID
  targetPageId: "37450e7e74098179b60ad132dfe211be",  // Where to append preview
  dataJson: '{"title":"My Slide","items":[...]}',    // Slot values (JSON string)
  filename: null                                       // Auto-generated if null
}
```

**Returns:**
```javascript
{
  url: "https://blob.vercelusercontent.com/...",
  filename: "decks/81e571cd-123456789.html",
  slideTitle: "3-Column Funnel",
  access: "public",
  appendSucceeded: true,
  appendError: null
}
```

## How templates work

Templates live in your **Inspiration Deck Slide Library** (a Notion database). Each row has:

| Property | What it holds |
|----------|---------------|
| `HTML Template` | Parameterized HTML with Mustache `{{slots}}` |
| `Slots` | JSON schema describing what fields are needed |
| `Layout ID` | e.g., `three-col-funnel`, `timeline`, `maturity-curve` |
| `Renderer` | Engine name (e.g., `ThreePanel`) |
| `Active` | Checkbox — only checked rows are available |

### Example template

```html
<div class="slide">
  <h1>{{title}}</h1>
  <ul>
    {{#items}}
      <li>{{name}}: {{value}}</li>
    {{/items}}
  </ul>
</div>
```

### Example data

```json
{
  "title": "Revenue by Region",
  "items": [
    { "name": "APAC", "value": 2400000 },
    { "name": "EMEA", "value": 1800000 },
    { "name": "Americas", "value": 3200000 }
  ]
}
```

## Architecture

**Rendering:** Inline Mustache-subset parser (no dependencies, verified byte-identical to `mustache` npm)

**Upload:** Vercel Blob HTTP API (no SDK; uses Bearer token auth)

**Hosting:** Notion Workers (fully managed, zero server costs)

**Linking:** Notion blocks API (embeds + rich-text preview links)

## Development

```bash
# Typecheck
npm run check

# Deploy after code changes
ntn workers deploy

# Test locally
ntn workers exec fancyhtml -d '{"layoutPageId":"...","targetPageId":"...","dataJson":"{...}"}'

# View logs
ntn workers runs logs <run-id>
```

## Code structure

```
src/
  fancyhtml.ts        # Main tool: reads template, fills, uploads, links back
  index.ts            # Entry point: registers the tool on the worker
  
package.json          # Dependencies (@notionhq/workers only)
tsconfig.json         # TypeScript config
workers.json          # Deployment metadata (don't commit)
.gitignore            # Ignores node_modules, .env, workers.json
```

## Environment variables

Set these via `ntn workers env set`:

| Variable | Purpose | Required |
|----------|---------|----------|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob authentication token | ✅ Yes |
| `BLOB_ACCESS` | `public` (default) or `private` | ❌ No |

## Security notes

- **Blob URLs are unguessable** — random UUIDs, accessible without authentication (obscurity-based)
- **Templates are trusted content** — no HTML escaping (pre-encode entities in your data)
- **Never commit secrets** — use `ntn workers env set`, not hardcoded values

## Limitations

- **Rendering:** Only handles Mustache `{{var}}`, `{{#section}}...{{/section}}`, `{{^inverted}}...{{/inverted}}`
- **Blob URLs:** Unguessable by design (not cryptographically signed)
- **Worker limits:** Runs on Notion's infrastructure (execution time, memory limits apply)
- **Trusted templates:** No HTML escaping — entities must be pre-encoded in data

## Related projects

- **[Inspiration Deck Slide Library](https://notion.so/)** — the template repository (Notion database)
- **[deckformulator](https://notion.so/)** — Custom Agent that picks templates and maps content
- **[buildDeck](https://notion.so/)** — Worker that renders DeckSpec JSON to PPTX

## Resources

- [Notion Workers docs](https://developers.notion.com/workers)
- [Notion API reference](https://developers.notion.com/reference)

## License

MIT
