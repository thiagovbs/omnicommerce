INSERT INTO "Organization" ("id", "name", "updatedAt")
VALUES ('test-org', 'Migration test', '2026-01-01');
INSERT INTO "User" ("id", "organizationId", "name", "email", "updatedAt")
VALUES ('test-user', 'test-org', 'Operator', 'migration@example.invalid', '2026-01-01');
INSERT INTO "Marketplace" ("id", "organizationId", "name", "code", "updatedAt")
VALUES ('test-marketplace', 'test-org', 'Marketplace', 'test', '2026-01-01');
INSERT INTO "Sale" (
    "id", "organizationId", "marketplaceId", "externalOrderId", "status",
    "soldAt", "gross", "net", "updatedAt"
) VALUES
    ('test-paid', 'test-org', 'test-marketplace', 'order-paid', 'PAID', '2026-01-01', 10.10, 9.09, '2026-01-02'),
    ('test-delivered', 'test-org', 'test-marketplace', 'order-delivered', 'DELIVERED', '2026-01-01', 20.20, 18.18, '2026-01-03');
INSERT INTO "SaleItem" ("id", "saleId", "title", "quantity", "unitPrice", "total")
VALUES ('test-item', 'test-paid', 'Legacy item', 1, 10.10, 10.10);
