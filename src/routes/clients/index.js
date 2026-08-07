const taxIdentity = require("../../utils/taxIdentity");

async function clientRoutes(fastify, opts) {
  const { prisma } = fastify;

  // Apply authentication to all routes in this plugin
  fastify.addHook("onRequest", fastify.authenticate);

  // GET all clients
  fastify.get(
    "/",
    {
      schema: {
        description: "Get all clients",
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              /* A RESPONSE SCHEMA IS A FILTER, NOT JUST A CONTRACT.
                 fast-json-stringify emits only the properties declared here and
                 drops the rest — so a field missing from this list is a field
                 the API silently does not return, however well it is stored.

                 That had already cost real data. registrationNumber, tin and
                 isIndividual (spec 05) were never added here, so the clients
                 list returned them as absent; the edit form on the clients page
                 populates from that list, showed the boxes empty, and saving
                 anything at all wrote the blanks back — quietly erasing the
                 client's TIN and registration number. Anyone who opened a
                 client and pressed save lost them.

                 If you add a column to Client, add it here in the same commit. */
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
                /* Nullable since spec 08, and declared as such deliberately.
                   Left as a bare "string" the serializer coerces null to "",
                   which tells the page a client HAS an empty email rather than
                   no email — and the import preview has to be able to tell the
                   difference to flag who is unreachable. */
                email: { type: ["string", "null"] },
                phone: { type: ["string", "null"] },
                address: { type: ["string", "null"] },
                company: { type: ["string", "null"] },
                averageDelayDays: { type: "number" },
                totalRevenue: { type: "number" },
                profitMargin: { type: "number" },
                status: { type: "string" },
                autoChaser: { type: "boolean" },
                autoEmailChaser: { type: "boolean" },
                registrationNumber: { type: ["string", "null"] },
                tin: { type: ["string", "null"] },
                isIndividual: { type: "boolean" },
                notes: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      return prisma.client.findMany({
        where: { userId: request.user.id },
        orderBy: { updatedAt: "desc" },
      });
    },
  );

  // GET client by ID
  fastify.get("/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const client = await prisma.client.findUnique({
      where: { id, userId: request.user.id },
      include: { invoices: true },
    });
    if (!client) {
      return reply.notFound("Client not found");
    }
    return client;
  });

  // POST create client
  fastify.post(
    "/",
    {
      schema: {
        body: {
          type: "object",
          /* Name only, since spec 08.
             Email was required here, which contradicted the import the moment
             it shipped: the import can create a client you have a phone number
             for and nothing else — a phone contact list is full of them — and
             then this endpoint's own edit form could not save that client back
             without inventing an address for them. The real rule is that a
             client needs a phone number OR an email to be reachable, which is
             a rule about the pair and is checked in the handler. */
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
            email: { type: "string", format: "email" },
            phone: { type: "string" },
            address: { type: "string" },
            company: { type: "string" },
            autoChaser: { type: "boolean" },
            autoEmailChaser: { type: "boolean" },
            /* Spec 05. Free text, no format check — see utils/taxIdentity for
               why validating these against a pattern is the wrong trade. */
            registrationNumber: { type: "string" },
            tin: { type: "string" },
            isIndividual: { type: "boolean" },
            /* The user's own shorthand (spec 08). Never rendered on a
               document — a note to self, not a note to the client. */
            notes: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const data = request.body;

    /* Null, not "". An empty string is a VALUE, and the duplicate check below
       is an equality match — so storing "" would make every contactless client
       collide with every other one, and the second phone-only client anybody
       added would be refused as a duplicate of the first. */
    const email = data.email?.trim().toLowerCase() || null;
    const phone = data.phone?.trim() || null;

    /* The reachability rule, checked on the pair rather than either column. */
    if (!email && !phone) {
      return reply.badRequest(
        "Add an email address or a phone number, otherwise there is no way to send them anything.",
      );
    }

    // Check for existing client with same email for this user (case-insensitive)
    if (email) {
      const existingClient = await prisma.client.findFirst({
        where: {
          email: {
            equals: email,
            mode: "insensitive",
          },
          userId: request.user.id,
        },
      });

      if (existingClient) {
        return reply.badRequest("Client already exists with this email");
      }
    }

    const client = await prisma.client.create({
      data: {
        ...data,
        /* Overwrites the raw values spread above with the cleaned ones. */
        ...taxIdentity.clientFields(data),
        email,
        phone,
        userId: request.user.id,
      },
    });
    return { ...client, message: "Client added successfully" };
  });

  // DELETE client
  fastify.delete("/:id", async (request, reply) => {
    const id = Number(request.params.id);

    // Deliberately NOT filtered by kind. This asks "does anything still point at
    // this client", and a quotation points at one just as hard as an invoice —
    // the foreign key is required either way. Guarding it to invoices would let
    // you delete a client who only has quotes, and the database would then
    // refuse the delete on the FK, turning a clear message into a 500.
    const documentCount = await prisma.invoice.count({
      where: { clientId: id, userId: request.user.id },
    });

    if (documentCount > 0) {
      return reply.badRequest(
        `Cannot delete client. They have ${documentCount} associated invoices or quotations. Delete those first.`,
      );
    }

    try {
      await prisma.client.delete({
        where: { id, userId: request.user.id },
      });
      return { success: true, message: "Client deleted successfully" };
    } catch (err) {
      fastify.log.error("Error deleting client:", err);
      return reply.internalServerError("Failed to delete client");
    }
  });

  // PUT update client
  fastify.put(
    "/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "integer" },
          },
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string", format: "email" },
            phone: { type: "string" },
            address: { type: "string" },
            company: { type: "string" },
            autoChaser: { type: "boolean" },
            autoEmailChaser: { type: "boolean" },
            registrationNumber: { type: "string" },
            tin: { type: "string" },
            isIndividual: { type: "boolean" },
            /* The user's own shorthand (spec 08). Never rendered on a
               document — a note to self, not a note to the client. */
            notes: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const body = request.body;

    // Only allow these fields to be updated via this endpoint
    const allowedFields = [
      "name",
      "email",
      "phone",
      "address",
      "company",
      "autoChaser",
      "autoEmailChaser",
      "notes",
    ];
    const data = {};

    allowedFields.forEach((field) => {
      if (body[field] !== undefined) {
        data[field] = body[field];
      }
    });

    /* Cleaned separately from the allowlist above: `clientFields` returns only
       the keys actually present, so an edit that does not touch the
       identifiers leaves them alone, and one that clears a box clears the
       column rather than storing "". */
    Object.assign(data, taxIdentity.clientFields(body));

    /* Normalised to null rather than "", for the same reason as create: an
       empty string is a value that collides with every other empty string in
       the duplicate check, where null correctly means "not known". */
    if (data.email !== undefined) {
      data.email = data.email.trim().toLowerCase() || null;
    }
    if (data.phone !== undefined) {
      data.phone = data.phone.trim() || null;
    }

    if (data.name === "") {
      return reply.badRequest("A client needs a name.");
    }

    /* Reachability is a rule about the PAIR, so clearing one column is only a
       problem when the other is empty too — which means the record as it will
       be AFTER this edit has to be checked, not the patch in isolation. */
    if (data.email === null || data.phone === null) {
      const current = await prisma.client.findFirst({
        where: { id, userId: request.user.id },
        select: { email: true, phone: true },
      });
      if (!current) return reply.notFound("Client not found");

      const nextEmail = data.email !== undefined ? data.email : current.email;
      const nextPhone = data.phone !== undefined ? data.phone : current.phone;
      if (!nextEmail && !nextPhone) {
        return reply.badRequest(
          "Keep either an email address or a phone number, otherwise there is no way to send them anything.",
        );
      }
    }

    // If email is being changed, check for uniqueness
    if (data.email) {
      const existingWithEmail = await prisma.client.findFirst({
        where: {
          email: {
            equals: data.email,
            mode: "insensitive",
          },
          userId: request.user.id,
          id: { not: id }, // Exclude current client
        },
      });

      if (existingWithEmail) {
        return reply.badRequest("Another client already exists with this email");
      }
    }

    try {
      // Check if user is FREE before allowing chaser enablement
      if (data.autoChaser || data.autoEmailChaser) {
        const user = await prisma.user.findUnique({
          where: { id: request.user.id },
          select: { plan: true },
        });

        if (user.plan === "FREE") {
          return reply.forbidden("Upgrade to Pro to enable automated chasers");
        }
      }

      const client = await prisma.client.update({
        where: { id, userId: request.user.id },
        data,
      });
      return { ...client, message: "Client updated successfully" };
    } catch (err) {
      fastify.log.error("Error updating client:", err);
      return reply.internalServerError("Failed to update client");
    }
  });
}

module.exports = clientRoutes;
