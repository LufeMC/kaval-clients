# Changelog

All packages in this repo version in lockstep (`scripts/bump.mjs`).

## 0.5.0 — 2026-07-20

### Breaking

- **Commerce clients removed.** Product Research (`/v1/product-research`), Offer Search
  (`/v1/search-offers`), and the Offer Search gate (`/v1/search-offers/gate`) no longer exist
  server-side (the routes return 404). Every client surface for them is deleted: the Node
  `researchProducts` / `streamProductResearch` / `searchOffers` / `streamOfferSearch` /
  `gateOfferSearch` methods and their types, the Python `research_products` / `search_offers` /
  `gate_offer_search` methods, the MCP `product_research` / `offer_search` / `offer_search_gate`
  tools, and all commerce fixtures and tests.
- **`verify` is now the conclusion-verification surface** (`POST /v1/verify`): an assertable
  `conclusion` plus 1–20 `evidence_refs` (plain `https` URL strings or strict
  `{ url, document_id }` objects) in; `status` (`valid | invalidated | could_not_verify`) plus a
  signed `receipt` (`proof_id`, `decision: ALLOW | BLOCK | REVIEW`, `reason`, `share_endpoint`,
  full `packet`) out. The legacy belief-freshness verify remains available under a clearly-legacy
  name — never as `verify`.

### Added / aligned

- Verification surface aligned to the server wire contracts: `audit` builds the full signed
  ProofPacket (the expensive path); `gate` applies it at act time with no search, parsing, or
  model call, returning a typed state — `current`, `not_yet_valid`, `expired`, `invalidated`,
  `dependency_changed`, `integrity_failed`, `policy_mismatch`, or `operational_failure` — while an
  unknown proof surfaces as a typed `proof_not_found` error, not a 200.
- Ed25519-signed receipts documented end to end: `signature.algorithm: "Ed25519"`, public JWKs at
  `GET /v1/proof-verification-keys/:kid`, offline verification via the open `@kaval/receipt-verifier`.

### Changed

- MCP tool surface realigned to the verification protocol (`verify`, `proof_audit`, `proof_gate`,
  plus the legacy currentness tools and `report_outcome`).
- README repositioned around verify / audit / gate; commerce workflows removed from all docs.
- Non-commerce legacy surfaces (`check`, `extract-and-check`, `scan-store`, `monitor`, `kaval`,
  `kaval-batch`, `report-outcome`, `health`) unchanged and still tested.
- All packages bumped 0.4.0 → 0.5.0 in lockstep.
