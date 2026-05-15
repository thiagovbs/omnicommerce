import { PrismaClient, UserRole, SaleStatus, Currency } from "@prisma/client";
import { hash } from "bcryptjs";

// Na v6, inicializamos o PrismaClient de forma simples. 
// Ele lerá o DATABASE_URL automaticamente do seu arquivo .env
const prisma = new PrismaClient();

async function main() {
  const orgName = process.env.SEED_ORG_NAME ?? "Org Demo";
  const adminName = process.env.SEED_ADMIN_NAME ?? "Admin";
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@local.test";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "Admin123!";

  console.log("Iniciando seed...");

  // 1. Organização
  const organization =
    (await prisma.organization.findFirst({ where: { name: orgName } })) ??
    (await prisma.organization.create({ data: { name: orgName } }));

  // 2. Usuário Admin
  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (!existingAdmin) {
    // Certifique-se de ter instalado o pacote: npm install bcryptjs
    // e os tipos: npm install -D @types/bcryptjs
    const passwordHash = await hash(adminPassword, 10);
    await prisma.user.create({
      data: {
        organizationId: organization.id,
        name: adminName,
        email: adminEmail,
        passwordHash,
        role: UserRole.ADMIN,
      },
    });
    console.log(`Usuário admin criado: ${adminEmail}`);
  }

  // 3. Marketplaces
  const marketplaces = [
    { name: "Mercado Livre", code: "mercado_livre" },
    { name: "Shopee", code: "shopee" },
    { name: "Amazon", code: "amazon" },
  ];

  for (const mp of marketplaces) {
    await prisma.marketplace.upsert({
      where: {
        organizationId_code: {
          organizationId: organization.id,
          code: mp.code,
        },
      },
      update: { name: mp.name, active: true },
      create: { ...mp, organizationId: organization.id, active: true },
    });
  }
  console.log("Marketplaces sincronizados.");

  // 4. Criar Venda Fake
  const mlMarketplace = await prisma.marketplace.findFirst({
    where: { code: "mercado_livre", organizationId: organization.id }
  });

  if (mlMarketplace) {
    const unitPrice = 99.90;
    const quantity = 1;
    const shipping = 15.00;
    const gross = unitPrice * quantity;
    const net = gross - 5.00;

    await prisma.sale.create({
      data: {
        organizationId: organization.id,
        marketplaceId: mlMarketplace.id,
        externalOrderId: `ORDER-${Date.now()}`,
        status: SaleStatus.PAID,
        soldAt: new Date(),
        currency: Currency.BRL,
        gross: gross,
        shipping: shipping,
        net: net,
        customerName: "Cliente de Teste",
        customerEmail: "cliente@teste.com",
        items: {
          create: [
            {
              sku: "PROD-001",
              title: "Produto de Teste Seed",
              quantity: quantity,
              unitPrice: unitPrice,
              total: unitPrice * quantity,
            }
          ]
        }
      }
    });
    console.log("Venda fake criada com sucesso!");
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("Seed finalizado com sucesso.");
  })
  .catch(async (e) => {
    console.error("Erro durante o seed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });