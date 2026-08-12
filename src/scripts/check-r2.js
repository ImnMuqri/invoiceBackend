/**
 * Does R2 actually work with the credentials in the environment?
 *
 * Run: npm run check:r2
 *
 * Reading the five variables is not the same as being able to use them, and
 * every way this fails is quiet:
 *
 *   - an API token created Read-only writes nothing and says 403
 *   - a mistyped bucket name is a 404 that looks like a network problem
 *   - a wrong account id points the endpoint at a bucket that is not yours
 *   - PUBLIC ACCESS NOT ENABLED is the big one: the upload succeeds, the row
 *     stores a perfectly-formed url, and the image 404s for the client — which
 *     is invisible, because a broken <img> renders as nothing
 *   - a custom domain that has not propagated fails the same way
 *
 * So this does the whole round trip against the real bucket: writes a one-pixel
 * PNG, fetches it back over the PUBLIC url the way a client's browser would,
 * then deletes it. It cleans up after itself even when a step fails.
 */

require("dotenv").config();

const storage = require("../utils/storage");

/* A 1x1 transparent PNG. Small enough to be free, real enough that a
   content-type check means something. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AABAAB/wD/mZfMAAAAAElFTkSuQmCC",
  "base64",
);

const ok = (m) => console.log(`  [32mok[0m   ${m}`);
const bad = (m) => console.log(`  [31mFAIL[0m ${m}`);
const info = (m) => console.log(`       ${m}`);

async function main() {
  console.log("\nR2 configuration check\n");

  const need = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_URL",
  ];
  const missing = need.filter((v) => !process.env[v]);
  if (missing.length) {
    bad(`missing: ${missing.join(", ")}`);
    info("Set them in .env locally, or in Railway for the deployed service.");
    process.exit(1);
  }
  ok("all five variables are present");

  if (!storage.isConfigured()) {
    bad("the values are still placeholders");
    info("R2_ACCOUNT_ID starting 'your_' or a 'replace-me' public url is");
    info("treated as unconfigured on purpose, so a half-set service does not");
    info("think it has storage. Put the real values in.");
    process.exit(1);
  }
  ok("values look real (not the shipped placeholders)");

  const bucket = process.env.R2_BUCKET;
  const publicUrl = process.env.R2_PUBLIC_URL.replace(/\/$/, "");
  info(`bucket: ${bucket}`);
  info(`public: ${publicUrl}`);

  const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  /* Namespaced so it is obvious in the bucket what this was, if a cleanup ever
     fails and one is left behind. */
  const key = `logos/_healthcheck/${Date.now()}.png`;
  let uploaded = false;

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: PIXEL,
        ContentType: "image/png",
      }),
    );
    uploaded = true;
    ok("write succeeded — the token has Object Write on this bucket");
  } catch (err) {
    bad(`write failed: ${err.name} ${err.message}`);
    if (err.name === "AccessDenied" || err.$metadata?.httpStatusCode === 403) {
      info("The API token is probably Read-only. Recreate it in R2 >");
      info("Manage API Tokens with 'Object Read & Write'.");
    } else if (err.name === "NoSuchBucket") {
      info(`No bucket named "${bucket}" in this account. Check R2_BUCKET and`);
      info("that R2_ACCOUNT_ID is the account that owns it.");
    }
    process.exit(1);
  }

  /* The part that matters most, and the part reading variables cannot tell you.
     Fetched the way a client's browser will, over the public hostname. */
  const url = `${publicUrl}/${key}`;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (res.ok) {
      const type = res.headers.get("content-type") || "";
      if (type.includes("image")) {
        ok(`public read succeeded — ${res.status}, ${type}`);
      } else {
        bad(`public read returned ${res.status} but content-type is "${type}"`);
        info("Something is answering that is not the object — check the custom");
        info("domain is attached to THIS bucket and not proxied elsewhere.");
      }
    } else if (res.status === 401 || res.status === 403) {
      bad(`public read got ${res.status} — the bucket is not publicly readable`);
      info("This is the failure that is invisible in the product: uploads");
      info("succeed and logos 404 for your clients. Enable a Public");
      info("Development URL or attach a custom domain under the bucket's");
      info("Settings, and make sure R2_PUBLIC_URL is that hostname.");
    } else if (res.status === 404) {
      bad("public read got 404");
      info("The object was written but is not served at that hostname. Usually");
      info("R2_PUBLIC_URL points at a different bucket, or includes a path");
      info("segment it should not (origin only, no /logos).");
    } else {
      bad(`public read got ${res.status}`);
    }
  } catch (err) {
    bad(`public read could not connect: ${err.message}`);
    info("If this is a custom domain it may still be propagating, or the");
    info("hostname is wrong. Try again in a minute.");
  }

  if (uploaded) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      ok("cleaned up the test object");
    } catch (err) {
      bad(`could not delete the test object: ${err.message}`);
      info(`Remove it by hand if you like: ${key}`);
    }
  }

  console.log("\nDone. A row of ok's means logos will work in the PDF.\n");
}

main().catch((err) => {
  console.error("\nUnexpected error:", err);
  process.exit(1);
});
