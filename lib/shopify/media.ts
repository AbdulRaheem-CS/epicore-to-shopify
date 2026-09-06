import { assertNoUserErrors, shopifyGraphQL } from "./client";

const STAGED_UPLOADS = /* GraphQL */ `
  mutation StageUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CREATE_MEDIA = /* GraphQL */ `
  mutation AttachMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        ... on MediaImage {
          id
          status
        }
      }
      mediaUserErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_MEDIA_COUNT = /* GraphQL */ `
  query MediaCount($id: ID!) {
    product(id: $id) {
      media(first: 50) {
        nodes {
          id
        }
      }
    }
  }
`;

interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
}

export interface ImageToUpload {
  sourceUrl: string;
  altText?: string | null;
}

/**
 * Downloads the asset from Epicor, pushes it through a staged upload, then
 * attaches it to the product. Going via staged uploads rather than handing
 * Shopify the Epicor URL directly means auth-gated catalog assets still work.
 */
export async function uploadProductImage(
  productGid: string,
  image: ImageToUpload,
  epicorHeaders: Record<string, string> = {},
): Promise<string> {
  const res = await fetch(image.sourceUrl, { headers: epicorHeaders });
  if (!res.ok) {
    throw new Error(
      `Could not fetch image ${image.sourceUrl}: ${res.status}. If Epicor ` +
        `assets need auth, pass the header captured from the portal.`,
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") ?? guessMime(image.sourceUrl);
  const filename = filenameFor(image.sourceUrl);

  const staged = await shopifyGraphQL<{
    stagedUploadsCreate: {
      stagedTargets: StagedTarget[];
      userErrors: Array<{ field?: string[]; message: string }>;
    };
  }>(STAGED_UPLOADS, {
    input: [
      {
        filename,
        mimeType,
        resource: "IMAGE",
        httpMethod: "POST",
        fileSize: String(bytes.byteLength),
      },
    ],
  });
  assertNoUserErrors(staged.stagedUploadsCreate, "stagedUploadsCreate");

  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error("Shopify returned no staged upload target.");

  const form = new FormData();
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);

  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) {
    throw new Error(
      `Staged upload failed: ${upload.status} ${await upload
        .text()
        .catch(() => "")}`.slice(0, 300),
    );
  }

  const attached = await shopifyGraphQL<{
    productCreateMedia: {
      media: Array<{ id: string; status: string }>;
      mediaUserErrors: Array<{ field?: string[]; message: string }>;
    };
  }>(CREATE_MEDIA, {
    productId: productGid,
    media: [
      {
        originalSource: target.resourceUrl,
        alt: image.altText ?? "",
        mediaContentType: "IMAGE",
      },
    ],
  });

  if (attached.productCreateMedia.mediaUserErrors.length) {
    throw new Error(
      `productCreateMedia: ${attached.productCreateMedia.mediaUserErrors
        .map((e) => e.message)
        .join("; ")}`,
    );
  }

  const mediaId = attached.productCreateMedia.media[0]?.id;
  if (!mediaId) throw new Error("Shopify attached no media.");
  return mediaId;
}

export async function countProductMedia(productGid: string): Promise<number> {
  const data = await shopifyGraphQL<{
    product: { media: { nodes: Array<{ id: string }> } } | null;
  }>(PRODUCT_MEDIA_COUNT, { id: productGid });
  return data.product?.media.nodes.length ?? 0;
}

function filenameFor(url: string): string {
  const base = url.split("?")[0].split("/").pop() ?? "image";
  return /\.(jpe?g|png|webp|gif)$/i.test(base) ? base : `${base}.jpg`;
}

function guessMime(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}
