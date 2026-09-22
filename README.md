# KeepFlip market-research Function

Authenticated Appwrite Function for KeepFlip item valuation. Photo analysis
uses SerpApi's `google_ai_mode` engine with the temporary analysis image. The
private-sale band becomes KeepFlip's displayed low/median/high range; trade-in
and retail-refurbished bands remain supporting market signals. AI Mode output
is explicitly labeled as a visual market estimate, never as a confirmed sale.
When AI Mode returns separate quick-sale/local and curated-online ranges,
KeepFlip retains both and derives the displayed current-resale envelope from
those channels.
The SerpApi prompt asks for distinct exact-title, brand, model,
visible-condition, current-resale, and profitability-enhancement answers with
their available confidence values. A second server-side AI call converts
SerpApi's variable response into a strict KeepFlip JSON schema. The
deterministic parser remains available as a fallback.

Neither provider receives KeepFlip's existing identity or condition guess.
SerpApi receives the short-lived image URL. The normalizer receives only a
bounded text-and-reference projection of the SerpApi response, never the image
URL. The mobile app reads the signed-in reseller's owner-only profile and
sends its compact, versioned Buy Rules snapshot to this Function. The Function
validates that snapshot and applies it only after it has produced neutral
market evidence; it is never sent to SerpApi or the normalizer.

The existing folder and Function ID retain the `ebay-sold-comps` name so the
provider can be upgraded without breaking installed clients. SerpApi is used
only through its google_ai_mode engine for KeepFlip AI visual valuation and
follow-up guidance. Direct SerpApi eBay searches are removed. Current active
eBay supply and competitor context use the official Browse API with a
server-side application token.

References:

- <https://serpapi.com/google-ai-mode-api>
- <https://appwrite.io/docs/products/storage/file-tokens>
- <https://platform.openai.com/docs/guides/structured-outputs>
- <https://developer.ebay.com/develop/api/buy/browse_api>

## Appwrite configuration

- Entrypoint: `src/main.js`
- Build command: `npm install`
- Runtime: Node.js 20 or newer
- Execute access: authenticated users only
- Recommended timeout: 30 seconds
- Dynamic API-key scope: `tokens.write`

Add these Function variables in Appwrite and redeploy after changing them:

| Variable | Required | Purpose |
| --- | --- | --- |
| `SERPAPI_API_KEY` | Yes | Server-only SerpApi credential. Mark it secret. Never add it to an `EXPO_PUBLIC_` variable. |
| `OPENAI_API_KEY` | Recommended | Server-only credential for schema-constrained response normalization. If absent or temporarily unavailable, the Function uses its deterministic parser. |
| `OPENAI_MODEL` | No | Structured-Outputs-capable model. Defaults to `gpt-5-nano`. |
| `EBAY_CLIENT_ID` | Yes for active eBay context | Server-only eBay application client ID used to obtain a client-credentials token for Browse. Never add it to an `EXPO_PUBLIC_` variable. |
| `EBAY_CLIENT_SECRET` | Yes for active eBay context | Server-only eBay application secret used to obtain a client-credentials token for Browse. Mark it secret. |
| `EBAY_MARKETPLACE_ID` | No | Browse marketplace header. Defaults to `EBAY_US`. |
| `OPENAI_NORMALIZER_TIMEOUT_MS` | No | Normalizer timeout. Defaults to `14000`; accepted range is `1000`-`14000`. Keep the combined SerpApi and OpenAI budgets below Appwrite's 30-second synchronous limit. |
| SERPAPI_HTTP_TIMEOUT_MS | No | KeepFlip AI Mode request timeout. Defaults to 12000 and caps this value at 14000 so the following OpenAI call stays inside Appwrite's synchronous budget. |
| `SELLER_QUOTA_INTERNAL_SECRET` | Yes | Server-only shared secret used by subscription police to invoke this gateway-protected Function. |
| `KEEPFLIP_REQUIRE_QUOTA_GATEWAY` | No | Defaults to `true`. Set to `false` only for authenticated local or temporary testing when subscription police is unavailable. |

Appwrite supplies the project endpoint, project ID, caller JWT, and dynamic
Function key at runtime. For photo valuation the Function verifies that the
caller can read the requested file, creates a file-specific token that expires
after five minutes, passes that tokenized URL to SerpApi, and deletes the token
as soon as the synchronous search finishes. The mobile app deletes the
temporary image immediately afterward.

Do not use Appwrite Console `mode=admin` URLs in the app or Function.

## Provider migration

Deploy this source over the current KeepFlip market-research Function:

```dotenv
EXPO_PUBLIC_APPWRITE_MARKET_COMPS_FUNCTION_ID=your-existing-function-id
# Existing fallback clients may still use:
EXPO_PUBLIC_APPWRITE_EBAY_SOLD_COMPS_FUNCTION_ID=your-existing-function-id
```

Migration order:

1. Give the Function's dynamic key the `tokens.write` scope.
2. Add secret `SERPAPI_API_KEY` and, for structured normalization, secret
   `OPENAI_API_KEY` to the Function. Add server-only `EBAY_CLIENT_ID`,
   `EBAY_CLIENT_SECRET`, and optional `EBAY_MARKETPLACE_ID` for active-listing
   context.
3. Deploy this source with entrypoint `src/main.js`.
4. Run a new-item analysis and confirm the response contains
   `provider: "serpapi_ai_mode"` and, when Browse credentials are present, a
   `browseMarketAnalysis` object with active-listing context.
   The Browse request runs the identity-derived keyword search and image
   search independently; `browseSearches` reports each result and the
   identity count remains the primary exact-item saturation count.
5. Remove obsolete `SERPAPI_EBAY_DOMAIN` and any old direct-eBay-search
   variables. Remove unrelated `APIFY_*` variables and
   `MARKET_COMPS_JOB_SECRET` only if they are no longer used by your deployment.

## Photo-valuation request

```json
{
  "action": "start",
  "purpose": "image_valuation",
  "query": "Ignored for image_valuation; the Function applies its versioned reseller-intelligence query.",
  "bucketId": "item_images",
  "fileId": "durable-or-temporary-analysis-file-id",
  "refinementContext": "Optional owner answers to the returned valuation questions",
  "resellerBuyRules": {
    "version": 2,
    "minimumRoiPercent": 50,
    "minimumNetProfitCents": 2000,
    "maximumItemCostCents": 7500,
    "saleSpeed": "steady",
    "maximumTypicalDays": 90,
    "inventoryFocus": "fashion",
    "laborTolerance": "standard_prep",
    "storageCapacity": "dedicated_room",
    "includedCostTypes": ["marketplace_fees", "outbound_shipping"]
  }
}
```

For a multi-photo valuation, use the same Function conversation for each
captured view:

```json
{
  "photoSequence": {
    "photoNumber": 1,
    "photoCount": 2
  }
}
```

- `photoCount` may be 2, 3, or 4. A one-photo valuation omits
  `photoSequence` and completes through the ordinary single-image request.
- The first request includes `photoSequence.photoNumber: 1` and
  `continuable: true` is handled by the Function internally. Its response is
  `phase: "photo_context"` and includes an
  `aiModeConversation.subsequentRequestToken`.
- Each later request supplies the next image, the previous continuation token,
  `hasRefinementImage: true`, and the matching `photoSequence` number. The
  Function attaches that image to the same AI Mode conversation.
- The final request is the one with `photoNumber === photoCount`. It returns
  the complete normalized valuation and marks `photoSequence.status` as
  `"complete"`. Intermediate context responses are intentionally not priced
  or normalized.

The completed valuation's `aiModeConversation.subsequentRequestToken` can also
be passed to a `profitability_guidance` request. That keeps the action-specific
follow-up grounded in the same item evidence while allowing the Function to
return a fresh continuation token for the next action.

`resellerBuyRules` is optional. Invalid or old-version snapshots are ignored,
so market research still completes without personalized guidance. A valid
snapshot can only lower the evidence-led **Top Dollar to Pay** result. It
never changes the valuation range, market velocity, market decision, or the
provider query.

The synchronous response includes:

- a parsed private-sale valuation range;
- trade-in and retail-refurbished supporting ranges;
- the visual-identification narrative;
- distinct title, brand, and model confidence values when supplied;
- the extracted visible-condition assessment;
- normalized profitability actions and valuation-refinement questions;
- resale velocity (demand and supported estimated time-to-sell range);
- flip complexity (work, tools, skill level, and explicit safety warnings);
- a cautious flip verdict with assumptions and missing financial inputs;
- when a valid Buy Rules snapshot is supplied, a personalized acquisition
  ceiling plus its saved version, rule outcome, and clear pace/prep/storage
  caveats under `display.acquisitionGuidance.profileRules`;
- value factors and suggested missing details;
- cited web references and an explicit confidence warning.
- the normalization method (`openai_structured_outputs` or
  `deterministic_fallback`).

## Checks

```powershell
npm run check
npm test
```

Tests cover caller authentication, short-lived Appwrite file-token creation and
cleanup, Google AI Mode request parameters, OpenAI Structured Outputs,
multiple real AI Mode response shapes (including heading-scoped LaTeX price
bands), valuation-band parsing, official eBay Browse response normalization, direct
SerpApi eBay-search rejection, duplicate/outlier handling, currency isolation,
barcode lookup, and accessory-only rejection.

When OpenAI returns a structurally valid response with an invalid price band,
the Function logs a sanitized diagnostic containing the SerpApi search ID,
band name, returned values and types, and each failed validation rule. It never
logs the scoped image URL, file token, or provider API keys. A successful
deterministic fallback also logs the final private-sale low/median/high range.
