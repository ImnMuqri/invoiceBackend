/**
 * Utility for managing in-app notifications
 */
async function createNotification(prisma, userId, title, message, type) {
  try {
    const notification = await prisma.appNotification.create({
      data: {
        userId,
        title,
        message,
        type,
      },
    });
    return notification;
  } catch (error) {
    console.error("Error creating notification:", error);
    return null; // Return null so we don't break the main flow if notification fails
  }
}

module.exports = {
  createNotification,
};
