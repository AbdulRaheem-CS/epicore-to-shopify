# Fixtures

Saved payloads used when `EPICOR_MODE=fixtures`. This lets the whole
pipeline be built, run and tested before Epicor provides API access.

## Resolution order

For each endpoint the client looks for, in order:

1. `fixtures/captured/<name>.<partId>.json` — your real captured payload, per part
2. `fixtures/captured/<name>.json` — your real captured payload, shared
3. `fixtures/<name>.<partId>.json` — sample data, per part
4. `fixtures/<name>.json` — sample data, shared

So dropping a real capture into `captured/` overrides the sample without
deleting anything.

## Capturing real payloads

DevTools → Network → filter `Fetch/XHR` → Preserve log. Click through
Category → Group → Part Type → Get parts → a part → Buyers Guide. For each
response, save the body as:

| Endpoint | Filename |
|---|---|
| Get parts | `captured/parts.json` |
| Part detail | `captured/part-detail.<partNumber>.json` |
| Assets / images | `captured/part-assets.<partNumber>.json` |
| Buyers Guide | `captured/part-fitment.<partNumber>.json` |

`captured/` is gitignored — it may contain licensed Epicor catalog content,
which should not go into version control.

## About the sample data

Brands (`Northline Filtration`, `Crossvale Auto`) and part numbers are
fictional. Vehicle applications use real makes and models so the fitment
shape is realistic, but the part-to-vehicle mappings are invented. They
prove the flow, not data accuracy. Do not demo these as catalog content.

Seven parts across two brands, so the pilot slice genuinely has to be
narrowed to five, and so the brand + part number key is exercised against
more than one manufacturer.
