-- CreateTable
CREATE TABLE "Profile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT,
    "phoneNumber" TEXT,
    "companyName" TEXT,
    "companyEmail" TEXT,
    "companyPhone" TEXT,
    "address" TEXT,
    "invoiceIncludeName" BOOLEAN NOT NULL DEFAULT true,
    "invoiceIncludeEmail" BOOLEAN NOT NULL DEFAULT false,
    "invoiceIncludePersonalPhone" BOOLEAN NOT NULL DEFAULT false,
    "invoiceIncludeCompanyPhone" BOOLEAN NOT NULL DEFAULT true,
    "invoiceIncludeCompanyName" BOOLEAN NOT NULL DEFAULT true,
    "invoiceIncludeAddress" BOOLEAN NOT NULL DEFAULT true,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'MYR',
    "defaultTaxRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
    "globalAutoChaser" BOOLEAN NOT NULL DEFAULT true,
    "reminderInterval" INTEGER NOT NULL DEFAULT 0,
    "whatsappReminderInterval" INTEGER NOT NULL DEFAULT 0,
    "whatsappSendTemplate" TEXT DEFAULT '{{userName}} {{companyName}} via InvoKita

Hello {{clientName}}, here is your invoice {{invoiceNumber}} for {{totalAmount}} {{currency}}. Due on {{dueDate}}. View here: {{invoiceUrl}}',
    "whatsappReminderTemplate" TEXT DEFAULT '{{userName}} {{companyName}} via InvoKita

Friendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. Please ignore if already paid.',
    "whatsappMode" TEXT NOT NULL DEFAULT 'SYSTEM',
    "twilioSid" TEXT,
    "twilioAuthToken" TEXT,
    "twilioPhoneNumber" TEXT,
    "manualBankName" TEXT,
    "manualAccountNumber" TEXT,
    "manualAccountName" TEXT,
    "manualQrCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId");

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
