/**
 * Object storage for user uploads — Cloudflare R2.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Logos were written to `public/uploads` on the container filesystem, which is
 * EPHEMERAL on Railway. Every deploy wiped them while UserProfile.logoUrl still
 * pointed at the dead path, so a user's invoices quietly started going out with
 * no letterhead and nothing anywhere said so. A broken <img> renders as nothing,
 * which is exactly the kind of failure nobody reports — they just conclude the
 * product is shoddy.
 *
 * The blast radius is bigger than the settings page: logoUrl is drawn on the
 * invoice PDF, the builder preview, and the public quotation page.
 *
 * PUBLIC OBJECTS, NOT SIGNED URLS. All three of those surfaces render WITHOUT a
 * session — the PDF is produced by headless Chrome loading /invoices/:id/export,
 * and the payment and quotation pages are opened by the user's client. A signed
 * url would need a live round trip in each, and would expire inside a PDF that
 * is meant to be kept for years. A logo is not a secret; the url is unguessable
 * enough that nobody finds it without being given it.
 *
 * FALLS BACK TO DISK, LOUDLY. With no R2 configured this keeps working against
 * the local filesystem so a developer can run the app without cloud credentials
 * — but it says so at boot, because the same silence in production is the bug
 * described above.
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const LOCAL_DIR = path.join(__dirname, "../../public/uploads");

/** Every value R2 needs. All or nothing — a half-configured bucket is worse. */
function r2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  const publicUrl = process.env.R2_PUBLIC_URL;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) {
    return null;
  }

  /* The placeholders shipped in .env.example must not read as configured. A
     service that thinks it has storage and does not is harder to diagnose than
     one that knows it has none. */
  if (accountId.startsWith("your_") || publicUrl.includes("replace-me")) {
    return null;
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicUrl: publicUrl.replace(/\/$/, ""),
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

const isConfigured = () => r2Config() !== null;

/* The client is built once and only when it is actually needed, so a service
   with no R2 configured never constructs one and never pays for the import. */
let client = null;
function s3() {
  if (client) return client;
  const cfg = r2Config();
  if (!cfg) return null;

  const { S3Client } = require("@aws-sdk/client-s3");
  client = new S3Client({
    /* R2 ignores the region but the SDK insists on one. "auto" is what
       Cloudflare's own documentation uses. */
    region: "auto",
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
  return client;
}

/* Extensions we are willing to write, mapped from the mimetype rather than
   taken from the filename. The uploaded name is attacker-controlled and was
   being trusted for `path.extname` — deriving it from the validated mimetype
   instead means the stored object cannot be given an extension that disagrees
   with what it actually is. */
const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

const ALLOWED_MIME = Object.keys(EXT_BY_MIME);

/**
 * An object key for a user's logo.
 *
 * The random suffix is what makes replacement safe: overwriting a fixed key
 * would leave every cached copy — the client's browser, an email client, a PDF
 * already generated — showing the old image for as long as the cache holds it.
 * A new key per upload means the new logo appears immediately.
 */
function logoKey(userId, mimetype) {
  const ext = EXT_BY_MIME[mimetype] || ".png";
  const nonce = crypto.randomBytes(6).toString("hex");
  return `logos/${userId}/${Date.now()}-${nonce}${ext}`;
}

/**
 * Store a logo. Returns the URL to put in logoUrl.
 *
 * `file` is the stream from @fastify/multipart. Read fully into memory before
 * upload because R2 needs a known content length and the file is capped at 5MB
 * by the multipart limits — streaming would mean a multipart upload for
 * something smaller than a photograph.
 */
async function putLogo({ file, mimetype, userId }) {
  if (!ALLOWED_MIME.includes(mimetype)) {
    throw new Error(`Unsupported image type: ${mimetype}`);
  }

  const key = logoKey(userId, mimetype);
  const cfg = r2Config();

  if (!cfg) return putLogoLocal({ file, key });

  const chunks = [];
  for await (const chunk of file) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  await s3().send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: mimetype,
      /* A year, immutable. Safe precisely because the key is unique per
         upload — there is no version of this object that can ever differ. */
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  return { url: `${cfg.publicUrl}/${key}`, key, storage: "r2" };
}

/** The development fallback. Same key shape, so the two are comparable. */
async function putLogoLocal({ file, key }) {
  const dest = path.join(LOCAL_DIR, key);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(file, fs.createWriteStream(dest));
  return { url: `/public/uploads/${key}`, key, storage: "local" };
}

/**
 * Remove a previously stored logo, given the URL that was saved.
 *
 * Never throws. A logo that fails to delete is an orphaned object costing a
 * fraction of a cent; a delete that throws would fail the user's request to
 * remove their logo, which is the part they can see. The row is cleared either
 * way, so the product behaves as asked even when the bucket does not.
 */
async function deleteLogo(fastify, logoUrl) {
  if (!logoUrl) return;

  try {
    const cfg = r2Config();

    /* Local files, including ones written before R2 was configured. */
    if (logoUrl.startsWith("/public/uploads/")) {
      const rel = logoUrl.replace("/public/uploads/", "");
      const filePath = path.join(LOCAL_DIR, rel);
      /* Confined to the uploads directory. logoUrl comes out of the database
         and should always be ours, but a path built by string concatenation
         and handed to unlink deserves the check regardless. */
      if (filePath.startsWith(LOCAL_DIR) && fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
      return;
    }

    if (!cfg || !logoUrl.startsWith(cfg.publicUrl)) return;

    const key = logoUrl.slice(cfg.publicUrl.length + 1);
    if (!key) return;

    const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
    await s3().send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  } catch (err) {
    fastify?.log?.warn({ err, logoUrl }, "Old logo could not be deleted");
  }
}

/**
 * Said once at boot.
 *
 * On a developer's machine this is expected. In production it means uploads are
 * going to a filesystem that will be erased on the next deploy, taking every
 * user's letterhead with it — so it is an error there, not a note.
 */
function reportStorage(fastify) {
  if (isConfigured()) {
    fastify.log.info(
      { bucket: process.env.R2_BUCKET },
      "Logo storage: Cloudflare R2",
    );
    return;
  }

  const message =
    "Logo storage: LOCAL DISK (R2 not configured). Uploads will not survive a " +
    "redeploy — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, " +
    "R2_BUCKET and R2_PUBLIC_URL.";

  if (process.env.NODE_ENV === "production") fastify.log.error(message);
  else fastify.log.warn(message);
}

module.exports = {
  ALLOWED_MIME,
  EXT_BY_MIME,
  isConfigured,
  putLogo,
  deleteLogo,
  reportStorage,
  logoKey,
};
