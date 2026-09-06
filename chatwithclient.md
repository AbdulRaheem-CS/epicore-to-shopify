Question:

Thanks, I’ve reviewed the Epicor Catalog API guide. The catalog/authentication side is clear. Before I finalize the integration approach, I’d like to confirm a few things:

1: Do you want to import the full CCL/catalog into Shopify, or only selected manufacturers/product lines?
2: Which Epicor data should map to Shopify title, SKU/part number, description, manufacturer, images, fitment data, price, and inventory?
3: Is inventory/pricing coming through EPN (/api/epn/inquiry) or from a separate Epicor ERP/inventory API?
4: Should inventory sync be scheduled, near real-time, or manually triggered?
5: Are products already present in Shopify, or will this be the initial catalog creation?
6: Can you provide Pilot API credentials/base URL and one sample product/part response for testing?

Answer:
Catalog scope:
1. The end goal is to import the full CCL/catalog that our Epicor account is licensed for, However, for development/testing, please start with one manufacturer/product line and a small batch of parts before scaling to the full CCL.
2. Epicor → Shopify mapping:
Please use approximately the following mapping:
Shopify Title → Manufacturer + Part Number + Epicor Part Description
SKU → Preferably Manufacturer/Line Code + Part Number so it is globally unique
Part Number → Epicor Part Number
Vendor/Manufacturer → Epicor Manufacturer Name
Description → Epicor Part Description + available extended part details
Images → Epicor Part Detail thumbnail/assets where available
Vehicle Fitment → Shopify metafield/structured fitment data, not product title/tags
Price → Epicor/EPN sell price when available
Inventory → Epicor/EPN availability/quantity when available

3. Pricing / inventory:
We have been told Pilot/demo may not show the inventory and pricing, so please design the integration so the pricing/inventory portion can be enabled once Live credentials/setup are provided.
Sync frequency:
Catalog/product information does not need to update constantly. I suggest:
New products/details/images/fitment: daily
Price and inventory: hourly initially

If Epicor/API limits make hourly inappropriate, make the interval configurable. We are planning to use SyncX to perform the Shopify-side scheduled synchronization but open to your suggestion

5. Shopify products:
Treat this as an initial catalog creation/import. No products currently exists on shopify
6. Pilot API/testing:
Yes, I can provide Pilot access privately.

Current Pilot host being tested:
https://pilot.epicor-auto-catalog.cloud
will provide the logins later



Question:
Thanks, that covers most of it. Three things I need to confirm before I finalize the approach.

1. Catalog size: roughly how many parts and manufacturers are in the CCL you are licensed for? This drives the whole architecture.

2. Fitment: store only in metafields, or do you also need customer-facing vehicle search on the storefront? These are very different scopes. And does Epicor deliver fitment as ACES data or through a specific EPN endpoint?

3. Shopify plan: which plan are you on, and is Plus an option? Behaviour changes significantly past roughly 50k products.

On approach, I would put a middleware layer between Epicor and Shopify rather than syncing direct. That gives us delta detection so we only push changed records, a retry queue for rate limits, and a clean switch to turn pricing and inventory on the day Live credentials arrive.

One note on SyncX: it handles flat feed imports well, but it will not manage Epicor authentication, structured fitment metafields, or delta logic at CCL scale. I would recommend we own the sync pipeline directly.

On frequency, daily for catalog is fine. Hourly for price and inventory works as a delta sync on changed parts only, not a full catalog pass, so I will build the interval as configurable.

Agreed on starting with one manufacturer and a small batch of parts before scaling to the full CCL. Once I have the Pilot logins I will start reviewing the actual API responses.

Also, can you confirm pilot.epicor-auto-catalog.cloud is your own environment rather than an Epicor-hosted one?

Best,
Taimoor



Answer:
1. Catalog size
Please treat this as something to determine from Pilot first.
The target is ultimately the full licensed CCL/catalog, not a manually selected subset.

2. Fitment
We definitely want customer-facing vehicle search on the Shopify storefront, not just storing fitment invisibly.

The intended experience is:
Customer should also be able to find based on
Year → Make → Model → Submodel/Engine → compatible products

Epicor’s API provides the vehicle hierarchy itself

We can store fitment data in custom metafields/metaobjects we can create them for the page.

3. Shopify plan
We are not planning around Shopify Plus at this stage. Please design for a normal Shopify plan and make the architecture capable of scaling.

Your proposed middleware approach makes sense. I agree with:

Epicor → Middleware → Shopify

My preference is whichever is simpler to maintain and more reliable.

Regarding Pilot: pilot.epicor-auto-catalog.cloud is an Epicor-hosted Pilot environment, not our own server/environment. Our portal access is also under Epicor’s epicor-auto-catalog.cloud infrastructure. Please treat the hostname as Epicor-managed. I’ll provide the exact Pilot credentials privately after the project is set up.

Id be happy to jump on a video call and screenshare the portal access to show you what the data/api looks like.
Lets schedule a google meet