const path = require("path");
const fs = require("fs");
const { pipeline } = require("stream/promises");

module.exports = async function (fastify, opts) {
  fastify.post(
    "/logo",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        return reply.badRequest("No file uploaded");
      }

      // Validate file type
      const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/svg+xml"];
      if (!allowedTypes.includes(data.mimetype)) {
        return reply.badRequest("Invalid file type. Only JPG, PNG, WEBP, and SVG are allowed.");
      }

      const userId = request.user.id;
      const extension = path.extname(data.filename) || ".png";
      const fileName = `logo_${userId}_${Date.now()}${extension}`;
      const uploadPath = path.join(__dirname, "../../../public/uploads", fileName);

      try {
        await pipeline(data.file, fs.createWriteStream(uploadPath));

        const logoUrl = `/public/uploads/${fileName}`;

        // Update user profile with the new logo URL
        await fastify.prisma.userProfile.update({
          where: { userId: userId },
          data: { logoUrl: logoUrl },
        });

        return {
          status: "success",
          message: "Logo uploaded successfully",
          logoUrl: logoUrl,
        };
      } catch (err) {
        fastify.log.error(err);
        return reply.internalServerError("Failed to save logo");
      }
    }
  );

  fastify.delete(
    "/logo",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;

      try {
        const profile = await fastify.prisma.userProfile.findUnique({
          where: { userId: userId },
          select: { logoUrl: true },
        });

        if (profile && profile.logoUrl) {
          const filePath = path.join(__dirname, "../../../", profile.logoUrl);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }

        await fastify.prisma.userProfile.update({
          where: { userId: userId },
          data: { logoUrl: null },
        });

        return {
          status: "success",
          message: "Logo removed successfully",
        };
      } catch (err) {
        fastify.log.error(err);
        return reply.internalServerError("Failed to remove logo");
      }
    }
  );
};
