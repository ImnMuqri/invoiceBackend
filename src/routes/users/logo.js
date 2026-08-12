/**
 * The account's logo — upload and removal.
 *
 * Storage lives in utils/storage.js (Cloudflare R2, with a local-disk fallback
 * for development). This file is the request handling and the ownership rules.
 *
 * Two things this route did not do before, both of which cost something real:
 *
 *   1. It wrote to the container filesystem, which is ephemeral on Railway —
 *      so every deploy silently erased every user's letterhead while logoUrl
 *      still pointed at the file. Invoices then went out unbranded, and a
 *      broken <img> renders as nothing, so nobody reported it.
 *
 *   2. It never deleted the PREVIOUS logo on replacement. Change your logo ten
 *      times and ten files stayed on disk forever, only the last of them
 *      reachable. Now the old object is removed after the new one is safely
 *      stored.
 */

const {
  ALLOWED_MIME,
  putLogo,
  deleteLogo,
} = require("../../utils/storage");

module.exports = async function (fastify, opts) {
  fastify.post(
    "/logo",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        return reply.badRequest("No file uploaded");
      }

      if (!ALLOWED_MIME.includes(data.mimetype)) {
        return reply.badRequest(
          "Invalid file type. Only JPG, PNG, WEBP, and SVG are allowed.",
        );
      }

      const userId = request.user.id;

      /* Read BEFORE writing the new one, so the old object can be cleaned up
         afterwards. Read after, and the row already points at the replacement
         and the previous file is unreachable — orphaned rather than deleted. */
      const existing = await fastify.prisma.userProfile.findUnique({
        where: { userId },
        select: { logoUrl: true },
      });

      let stored;
      try {
        stored = await putLogo({
          file: data.file,
          mimetype: data.mimetype,
          userId,
        });
      } catch (err) {
        /* @fastify/multipart raises this once the 5MB limit is passed. Worth
           its own message: "failed to save" reads as our fault, and the user
           can act on a size limit. */
        if (err?.code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.badRequest("That image is over 5MB. Try a smaller one.");
        }
        fastify.log.error({ err, userId }, "Logo upload failed");
        return reply.internalServerError("Failed to save logo");
      }

      try {
        await fastify.prisma.userProfile.update({
          where: { userId },
          data: { logoUrl: stored.url },
        });
      } catch (err) {
        /* The object is stored but the row is not pointing at it. Remove the
           orphan rather than leaving a file nobody can reach or delete. */
        fastify.log.error({ err, userId }, "Logo stored but profile not updated");
        await deleteLogo(fastify, stored.url);
        return reply.internalServerError("Failed to save logo");
      }

      /* Only now — the new one is stored and pointed at, so losing the old one
         can no longer leave the account with no logo at all. */
      if (existing?.logoUrl && existing.logoUrl !== stored.url) {
        await deleteLogo(fastify, existing.logoUrl);
      }

      fastify.log.info({ userId, storage: stored.storage }, "Logo updated");

      return {
        status: "success",
        message: "Logo uploaded successfully",
        logoUrl: stored.url,
      };
    },
  );

  fastify.delete(
    "/logo",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;

      try {
        const profile = await fastify.prisma.userProfile.findUnique({
          where: { userId },
          select: { logoUrl: true },
        });

        /* The COLUMN is cleared first and the object deleted after. The user
           asked for their logo gone from their invoices; that is the row. A
           delete that fails at the bucket must not leave the logo still
           printing on documents. */
        await fastify.prisma.userProfile.update({
          where: { userId },
          data: { logoUrl: null },
        });

        await deleteLogo(fastify, profile?.logoUrl);

        return {
          status: "success",
          message: "Logo removed successfully",
        };
      } catch (err) {
        fastify.log.error({ err, userId }, "Logo removal failed");
        return reply.internalServerError("Failed to remove logo");
      }
    },
  );
};
